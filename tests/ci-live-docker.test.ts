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
 * - the container is capped: `--memory` and `--memory-swap` 8g (equal, so no
 *   swap on top) and `--pids-limit` 2048; the guard refuses a missing,
 *   repeated, unlimited (-1, 0) or unparseable cap, swap unequal to memory,
 *   docker's `-m` alias beside `--memory`, and `--oom-kill-disable`;
 *   `docker stats` for the memory watchdog parses strictly;
 * - a run's container is `cscb-live-<run id>-<owner PID>`, and the runner
 *   removes it (or, kept on a memory watchdog stop, stops it with
 *   `docker stop`) only when `docker inspect` (its ID and labels, never its
 *   env) shows this runner's PID as owner, by that ID; a stopped run's note
 *   says what became of it (`describeContainerEnd`);
 * - the container's Claude key comes from the host's `CI_ANTHROPIC_*`, never
 *   the host's own `ANTHROPIC_*`;
 * - a child process gets only an allowlisted environment: no `SLACK_*`,
 *   `ANTHROPIC_*`, `CI_ANTHROPIC_*` or `CSCB_LIVE_*` value;
 * - one run per mode holds the lock; a stale lock is removed with a WARNING
 *   naming its path and why it is stale (every command that takes the lock
 *   passes a sink for it), then replaced, and a leftover container whose
 *   runner is alive is never removed;
 * - the image's agent-director binary is the one given with
 *   `--agent-director-binary`, checked by reading only the given path and its
 *   real path (it must resolve to a regular file with the execute bit) and
 *   staged by its real path; a given path that does not qualify is refused
 *   with a reason naming the option, never replaced by a host binary. With
 *   none given it is the host's own, found as its client finds it
 *   (`~/.agent-director/bin` first, then PATH in order), by real path, and
 *   only a regular executable file (`lib/agent-director-binary.ts`). The
 *   runner only reads it and copies it into a fresh temp dir under the OS
 *   temp dir, the build's named context, removed in a finally: it never runs
 *   it on the host;
 * - a failed live image build is told apart by `Dockerfile.live`'s own ERROR
 *   lines (`liveBuildErrorLines`, `liveBuildFailureMessage`), never by docker's
 *   lines that quote the RUN text; no failure text, the runner's or
 *   `Dockerfile.live`'s, advises upgrading or installing the host's
 *   agent-director or names the install-agent-director skill;
 * - the runner waits for the boot it caused and accepts only that boot
 *   number with status `ok` (`lib/container-boot.ts`);
 * - every command that changes CSCB, tmux or agent-director runs through
 *   `docker exec` in a `cscb-live-` container; the host runs only the
 *   HOST check's read-only probes, npm pack, git and docker;
 * - SIGINT, SIGTERM and SIGHUP all clean up (Playwright's own handlers off),
 *   and the memory watchdog's abort takes the same stop path, closing Chrome
 *   alongside the container's removal rather than after it;
 * - the container's own logs are copied into the results before every
 *   removal or stop of the container (a memory watchdog stop waiting for
 *   them only briefly), once, and sealed before the closing scan, which
 *   covers them;
 * - the browser is bounded (one Chrome, at most two contexts and two pages,
 *   idle on about:blank between flows and after a sign-in), and its flows run
 *   one at a time (the prompt guard clicks while a check may);
 * - the prompt guard runs from the first plan check to the last (its hooks
 *   around each, stopped before Teardown, halted by a stop's cleanup, its
 *   report in the results), reaches the container only through the checks'
 *   helpers, and its one agent-director command, the fallback deny, runs
 *   behind the plan's `guard`;
 * - the /ci images name one base tag, `BASE_IMAGE`: the `FROM` lines of
 *   `docker/Dockerfile.test` and `docker/Dockerfile.live` and the `/ci` and
 *   `/ci-live` skills; the base (`docker/Dockerfile.test.base`) reads one
 *   file from the repo context, the client-under-test check
 *   (`RC_CLIENT_CHECK_SOURCE`, never `package.json`), and installs nothing
 *   but its global agent-director client, from the release candidate's
 *   client tarball (no registry); it takes the release candidate and
 *   `install.sh` only from their named build contexts, checks them
 *   (SHA256SUMS, the pinned version and commit, the pinned SHA-256) before
 *   installing them, puts the release candidate's binary in a directory of
 *   its own first on PATH (never /usr/local/bin) and the 0.10.0 binary,
 *   fetched for its pinned release, off PATH, installs `sqlite3` and `file`
 *   and writes the marker /etc/cscb-ci-image; `Dockerfile.live` and the three
 *   `docker/live` scripts' PATH lines use the base's release-candidate
 *   directory;
 * - the client under test (`ci-live/lib/rc-client.ts`): the base copies the
 *   check to `RC_CLIENT_CHECK` and installs its global client from the path
 *   in the release record, then runs `--client` on it; `Dockerfile.live`
 *   copies no `package.json`, installs no agent-director (its one package
 *   install is Claude Code's) and runs `--client` on that global client after
 *   staging its binary, stopping the build on failure; test-1 runs
 *   `--package` on the package it installed into /test-repo right after the
 *   install, failing the test on failure, then, before its other steps, runs
 *   the Phase 1 class-check fixture (`fixtures/phase1-client-check.ts`) with
 *   bun on that package, failing the test with the fixture's first FAIL line.
 *   The check's path is imported, never typed;
 * - `Dockerfile.live` pins Claude Code: one `ARG CLAUDE_CODE_VERSION=`
 *   declaration, assigned nowhere else, a plain major.minor.patch release at
 *   or above `MIN_CLAUDE_CODE_VERSION` (imported from
 *   `test-helpers/agent-director-versions.ts`) by numeric order, part by
 *   part, never string order, and its one Claude Code install is
 *   `npm install -g` at that build-arg (no unpinned or "latest" install); a
 *   pin one patch below the minimum, a missing, repeated or unparseable
 *   declaration and an unpinned install are each refused, never skipped.
 *   `buildImageArgs` passes no Claude Code build-arg, so the pin is what is
 *   built. No Claude Code version is written in this file.
 *
 * Nothing here runs docker: spawns go to a recording fake. The wiring that
 * lives in `ci-live/runtime/` and `ci-live/main.ts` (which load
 * playwright-core, so no test imports them) and the /ci images' Dockerfiles,
 * skills and scripts are pinned by source audits.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path'

import { hostAgentDirectorBinary, selectAgentDirectorBinary, type BinaryProbe } from '../ci-live/lib/agent-director-binary.ts'
import { AGENT_DIRECTOR_BINARY_OPTION } from '../ci-live/lib/args.ts'
import { BOOT_DONE_FILE, bootProblem, bootReached, parseBootDone, type BootRecord } from '../ci-live/lib/container-boot.ts'
import { HELPERS_PATH, TestContainer } from '../ci-live/lib/container.ts'
import { CONTAINER_LOGS_URGENT_WAIT_MS, CONTAINER_LOGS_WAIT_MS } from '../ci-live/lib/container-logs.ts'
import {
  assertSafeRunArgs,
  BASE_IMAGE,
  buildExecArgs,
  buildImageArgs,
  buildRunArgs,
  claudeChildEnv,
  claudeEnvProblem,
  CONTAINER_OWNER_LABEL_KEY,
  CONTAINER_STATS_FORMAT,
  containerName,
  describeContainerEnd,
  DockerCli,
  INSPECT_OWNER_FORMAT,
  isLiveContainerName,
  liveBuildErrorLines,
  liveBuildFailureMessage,
  parseContainerOwnership,
  parseContainerStats,
  parseMemorySize,
  type ContainerEnd,
  type RunSpec,
} from '../ci-live/lib/docker.ts'
import { CHILD_ENV_ALLOWLIST, minimalChildEnv, type ProcResult, type SpawnOptions } from '../ci-live/lib/proc.ts'
import { isLiveRunnerPid, lockHolder, lockPid, nodeLockDeps, RunLock, type LockDeps } from '../ci-live/lib/run-lock.ts'
import { RC_CLIENT_CHECK, RC_CLIENT_CHECK_SOURCE } from '../ci-live/lib/rc-client.ts'
import { NotRunnableError } from '../ci-live/lib/secrets.ts'
import { MIN_CLAUDE_CODE_VERSION } from './test-helpers/agent-director-versions.ts'
import { balancedAfter, callArguments, callsOf, indicesOf, objectProperties, onlyCallArguments, splitTopLevel, stripComments } from './test-helpers/source-audit.ts'
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
  test('the run argv: detached with init, named, labelled with its owner, capped at 8g of memory with no swap on top and 2048 processes, read-only bind mounts, secrets by name only, the image last; the guard accepts it', () => {
    const args = buildRunArgs(runSpec())
    expect(args).toEqual([
      'run', '-d', '--init', '--name', NAME, '--hostname', NAME, '--label', 'cscb-live=1', '--label', 'cscb-live-owner=4242',
      '--memory', '8g', '--memory-swap', '8g', '--pids-limit', '2048',
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

  // The caps every run must set: with them in `base`, each refusal below is for its own rule, not a missing cap.
  const CAPS = ['--memory', '8g', '--memory-swap', '8g', '--pids-limit', '2048']
  const base = ['run', '-d', '--name', NAME, ...CAPS]
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

  // The resource caps: each of the three once, each a positive bounded value, and no swap on top of the memory cap.
  const MISSING = 'docker run must cap the container with --memory, --memory-swap and --pids-limit (missing: '
  const MEMORY_SIZE = 'docker run --memory needs a positive size such as 8g (not -1 or 0, which mean no limit)'
  const SWAP_SIZE = 'docker run --memory-swap needs a positive size such as 8g (not -1 or 0, which mean no limit)'
  const PIDS = 'docker run --pids-limit needs a positive number of processes (not -1 or 0, which mean no limit)'
  const SWAP_EQUAL = 'docker run --memory-swap must equal --memory (no swap on top of the memory cap)'
  const swapPids = ['--memory-swap', '8g', '--pids-limit', '2048']
  const memPids = ['--memory', '8g', '--pids-limit', '2048']
  const memSwap = ['--memory', '8g', '--memory-swap', '8g']
  test.each([
    ['no cap at all', [], `${MISSING}--memory, --memory-swap, --pids-limit)`],
    ['no --memory', swapPids, `${MISSING}--memory)`],
    ['no --memory-swap', memPids, `${MISSING}--memory-swap)`],
    ['no --pids-limit', memSwap, `${MISSING}--pids-limit)`],
    // docker lets the last of two win, so a second one could lift the cap.
    ['--memory twice', ['--memory', '8g', '--memory=64g', ...swapPids], 'docker run sets --memory more than once'],
    ['--memory-swap twice', ['--memory-swap=8g', ...memSwap, '--pids-limit', '2048'], 'docker run sets --memory-swap more than once'],
    ['--pids-limit twice, the second unlimited', [...memSwap, '--pids-limit', '2048', '--pids-limit=-1'], 'docker run sets --pids-limit more than once'],
    // -m is docker's alias for --memory: a second, larger cap under another spelling; --oom-kill-disable lets the container hang at its cap.
    ["-m 64g alongside --memory (docker's alias for it)", [...CAPS, '-m', '64g'], 'docker run flag -m is not one the runner uses'],
    ['-m64g (attached) alongside --memory', ['-m64g', ...CAPS], 'docker run flag -m is not one the runner uses'],
    ['--oom-kill-disable', [...CAPS, '--oom-kill-disable'], 'docker run flag --oom-kill-disable is not one the runner uses'],
    ['--memory -1 (no limit)', ['--memory', '-1', ...swapPids], MEMORY_SIZE],
    ['--memory=0 (no limit)', ['--memory=0', ...swapPids], MEMORY_SIZE],
    ['--memory-swap -1 (unlimited swap)', [...memPids, '--memory-swap', '-1'], SWAP_SIZE],
    ['--memory-swap=0', [...memPids, '--memory-swap=0'], SWAP_SIZE],
    ['--pids-limit -1 (no limit)', [...memSwap, '--pids-limit', '-1'], PIDS],
    ['--pids-limit=0', [...memSwap, '--pids-limit=0'], PIDS],
    ['--pids-limit 2048.5', [...memSwap, '--pids-limit', '2048.5'], PIDS],
    ['--pids-limit past 7 digits', [...memSwap, '--pids-limit', '12345678'], PIDS],
    ['a memory size with a two-letter unit', ['--memory', '8gb', ...swapPids], MEMORY_SIZE],
    ['a fractional memory size', ['--memory', '1.5g', ...swapPids], MEMORY_SIZE],
    ['a memory size docker would read in terabytes', ['--memory', '1t', ...swapPids], MEMORY_SIZE],
    ['an empty --memory=', ['--memory=', ...swapPids], MEMORY_SIZE],
    ['a memory size past a safe integer of bytes', ['--memory', '9999999999999g', ...swapPids], MEMORY_SIZE],
    ['a memory size that is no number', ['--memory', 'lots', ...swapPids], MEMORY_SIZE],
    ['swap above the memory cap', ['--memory', '8g', '--memory-swap', '16g', '--pids-limit', '2048'], SWAP_EQUAL],
    ['swap below the memory cap', ['--memory', '8g', '--memory-swap', '4g', '--pids-limit', '2048'], SWAP_EQUAL],
  ])('the guard refuses %s', (_what, caps, reason) => {
    let err: unknown
    try {
      assertSafeRunArgs(['run', '-d', '--name', NAME, ...caps, 'img'], HOME, lexical)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe(reason)
    assertNoLeak(err)
  })

  test.each([
    ['joined, with swap equal in bytes (8192m = 8g)', ['--memory=8192m', '--memory-swap=8g', '--pids-limit=2048']],
    ['bytes and an upper-case unit, and the smallest process cap', ['--memory', '8G', '--memory-swap', '8589934592', '--pids-limit', '1']],
  ])('the guard accepts the caps %s', (_what, caps) => {
    expect(() => assertSafeRunArgs(['run', '-d', '--name', NAME, ...caps, 'img'], HOME, lexical)).not.toThrow()
  })

  test.each([
    ['8g', 8 * 1024 ** 3],
    ['8192m', 8 * 1024 ** 3],
    ['8589934592', 8 * 1024 ** 3],
    ['512K', 512 * 1024],
    ['100b', 100],
    ['0', null],
    ['-1', null],
    ['08g', null],
    ['8gb', null],
    ['1.5g', null],
    ['9999999999999g', null],
  ])('parseMemorySize(%p) is %p', (value, bytes) => {
    expect(parseMemorySize(value)).toBe(bytes)
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

describe('parseContainerStats (docker stats, for the memory watchdog)', () => {
  test('the format reads memory use and limit, then the PID count, and nothing else', () => {
    expect(CONTAINER_STATS_FORMAT).toBe('{{.MemUsage}} {{.PIDs}}')
  })

  test.each([
    ['binary units, with the trailing newline', '1.5GiB / 8GiB 42\n', { memUsage: '1.5GiB / 8GiB', memBytes: 1.5 * 1024 ** 3, limitBytes: 8 * 1024 ** 3, pids: 42 }],
    ['a fractional MiB, rounded to bytes', '812.4MiB / 8GiB 7', { memUsage: '812.4MiB / 8GiB', memBytes: Math.round(812.4 * 1024 ** 2), limitBytes: 8 * 1024 ** 3, pids: 7 }],
    ["an older docker's decimal units", '512MB / 8GB 3', { memUsage: '512MB / 8GB', memBytes: 512e6, limitBytes: 8e9, pids: 3 }],
    ['a stopped container', '0B / 0B 0', { memUsage: '0B / 0B', memBytes: 0, limitBytes: 0, pids: 0 }],
    ['no reading (docker prints dashes)', '-- / -- --', null],
    ['an unknown unit', '1.5XiB / 8GiB 4', null],
    ['no PID count', '1.5GiB / 8GiB', null],
    ['two lines', '1.5GiB / 8GiB 4\n2GiB / 8GiB 5', null],
    ['nothing', '', null],
  ])('%s', (_what, stdout, expected) => {
    expect(parseContainerStats(stdout)).toEqual(expected)
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

describe("describeContainerEnd (the container's part of a stopped run's note)", () => {
  // What the cleanup actually did, with the fix for any container it left: never "removed" when it was not.
  test.each([
    [null, `the test container ${NAME} may still exist (the cleanup did not finish)`],
    ['none-started', 'no test container had been started'],
    ['removed', 'the test container was removed (or was already gone)'],
    ['not-removed', `the test container ${NAME} could not be removed (see run.log): remove it with docker rm -f ${NAME}`],
    ['kept-running', `the test container ${NAME} was kept running (--keep-container)`],
    ['kept-stopped', `the test container ${NAME} was stopped with docker stop (its memory freed) and kept for inspection (--keep-container)`],
    ['stop-failed', `the test container ${NAME} was kept (--keep-container) but could not be stopped (see run.log): it may still be running; stop it with docker stop ${NAME}`],
  ] as Array<[ContainerEnd | null, string]>)('%p', (end, note) => {
    expect(describeContainerEnd(end, NAME)).toBe(note)
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

  test('a lock a live runner holds is not runnable, naming its PID and the path, and is left alone with no warning', () => {
    const { deps, state } = lockDeps({ [LOCK]: '777\n' }, [777], { isAlive: () => true })
    const warnings: string[] = []
    const err = (() => {
      try {
        RunLock.acquire(LOCK, '/ci-live dry run', deps, (w) => warnings.push(w))
      } catch (e) {
        return e as Error
      }
      throw new Error('expected a refusal')
    })()
    expect(err).toBeInstanceOf(NotRunnableError)
    expect(err.message).toBe(`another /ci-live dry run (PID 777) is in progress and holds ${LOCK}: wait for it to finish`)
    expect([state.get(LOCK), warnings]).toEqual(['777\n', []])
  })

  test.each([
    ['a dead PID', '777\n', { isAlive: () => false }, 'its PID 777 is not running'],
    ['a PID reused by another program, as after a VM reboot', '888\n', { isAlive: () => true }, 'its PID 888 is running but is no /ci-live runner (the PID was reused, as after a VM reboot)'],
    ['a PID whose liveness the deps cannot tell', '999\n', {}, 'its PID 999 is no live /ci-live runner'],
    ["this process's own PID", `${ME}\n`, { isAlive: () => true }, `it holds this process's own PID ${ME}`],
    ['text that is no PID', 'garbage', {}, 'it holds no PID'],
    ['an empty file', '', {}, 'it holds no PID'],
  ] as Array<[string, string, Partial<LockDeps>, string]>)('a stale lock (%s) is removed with a WARNING naming the path and why, then replaced', (_what, content, extra, why) => {
    const { deps, state } = lockDeps({ [LOCK]: content }, [], extra)
    const warnings: string[] = []
    RunLock.acquire(LOCK, 'run', deps, (w) => warnings.push(w))
    expect(state.get(LOCK)).toBe(`${ME}\n`)
    expect(warnings).toEqual([`WARNING: removed the stale run lock ${LOCK}: ${why}`])
  })

  test('a lock that keeps reappearing is not runnable, telling the operator to remove it if no run is in progress; one gone before it was read gets no warning', () => {
    const { deps } = lockDeps({}, [], { createExclusive: () => false, read: () => null })
    const warnings: string[] = []
    expect(() => RunLock.acquire(LOCK, 'run', deps, (w) => warnings.push(w))).toThrow(`could not take the run lock ${LOCK}: remove it if no /ci-live run is in progress`)
    expect(warnings).toEqual([])
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

    test("isAlive: this process and PID 1 (another user's when not root: EPERM still means alive) are alive; a PID past Linux's PID_MAX_LIMIT is not", () => {
      expect([nodeLockDeps.isAlive!(process.pid), nodeLockDeps.isAlive!(1), nodeLockDeps.isAlive!(4_194_305)]).toEqual([true, true, false])
    })
  })
})

// ---------------------------------------------------------------------------
// The agent-director binary the image is built with: the given one, else the host's (the image's build context)
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

  describe(`selectAgentDirectorBinary: the binary given with ${AGENT_DIRECTOR_BINARY_OPTION}, else the host search`, () => {
    const OPTION = AGENT_DIRECTOR_BINARY_OPTION
    const GIVEN = '/rc/agent-director'
    /** A home install and a PATH binary, both executable: a fallback to the search would find them. */
    const SEARCHABLE: Record<string, Entry> = { [HOME_BIN]: 'exec', '/opt/a/agent-director': 'exec', '/opt/dir': 'dir' }
    /** Every path the probe read, once each. */
    const touched = (calls: string[]) => [...new Set(calls.map((c) => c.slice(c.indexOf(' ') + 1)))]

    test('a given binary is returned by its real path, and the given path and its real path are all the probe reads: no home install or PATH candidate', () => {
      const real = '/rc/store/agent-director-0.11.0-rc.1'
      const p = fakeProbe({ ...SEARCHABLE, [GIVEN]: `-> ${real}`, [real]: 'exec' })
      expect(selectAgentDirectorBinary(GIVEN, HOME, onPath('/opt/a'), p.probe)).toEqual({ source: 'given', path: real })
      expect(p.calls).toEqual([`realpath ${GIVEN}`, `isFile ${real}`, `access ${real}`])
    })

    // The fake's realpath answers a missing path with itself, so the exact reason for a missing path and a dangling
    // symlink is pinned on the real file system below; here every kind shows the refusal and that nothing else is read.
    test.each<[string, Entry | undefined, string]>([
      ['missing', undefined, expect.stringContaining(` given with ${OPTION} `)],
      ['a dangling symlink', '-> /gone/agent-director', expect.stringContaining(` given with ${OPTION} `)],
      ['not executable', 'noexec', `the file given with ${OPTION} is not executable (no execute bit for this user)`],
      ['a directory', 'dir', `the path given with ${OPTION} is not a regular file`],
      ['a symlink to a directory', '-> /opt/dir', `the path given with ${OPTION} is not a regular file`],
      ['a symlink loop (its realpath fails)', 'realpath-fails', `the path given with ${OPTION} does not exist (a missing file or a dangling symlink)`],
      ['unreadable (its stat fails)', 'stat-fails', `the path given with ${OPTION} cannot be read (its stat failed)`],
    ])('a given path that is %s is refused with a reason naming the option, never replaced by the search', (_what, entry, reason) => {
      const entries: Record<string, Entry> = { ...SEARCHABLE }
      if (entry !== undefined) entries[GIVEN] = entry
      const p = fakeProbe(entries)
      expect(selectAgentDirectorBinary(GIVEN, HOME, onPath('/opt/a'), p.probe)).toEqual({ source: 'given', path: null, reason })
      const real = entry?.startsWith('-> ') ? entry.slice(3) : GIVEN
      expect(p.calls.length).toBeGreaterThan(0)
      expect(touched(p.calls).filter((path) => path !== GIVEN && path !== real)).toEqual([])
    })

    test.each<[string, Record<string, Entry>, string | undefined]>([
      ['the home install', { [HOME_BIN]: 'exec', '/opt/a/agent-director': 'exec' }, onPath('/opt/a')],
      ['the first PATH match', { '/opt/b/agent-director': 'exec', '/opt/c/agent-director': 'exec' }, onPath('/opt/a', '/opt/b', '/opt/c')],
      ['a PATH symlink, by real path', { '/usr/local/bin/agent-director': '-> /opt/ad/2.0/agent-director', '/opt/ad/2.0/agent-director': 'exec' }, onPath('/usr/local/bin')],
      ['nothing (null)', { '/opt/a/agent-director': 'noexec' }, onPath('/opt/a', '/bin')],
      ['an undefined PATH (the home install only)', { '/usr/bin/agent-director': 'exec' }, undefined],
    ])("with none given, the host search answers, reading what it reads: %s", (_what, entries, path) => {
      const host = fakeProbe(entries)
      const selected = fakeProbe(entries)
      expect(selectAgentDirectorBinary(undefined, HOME, path, selected.probe)).toEqual({ source: 'found', path: hostAgentDirectorBinary(HOME, path, host.probe) })
      expect(selected.calls).toEqual(host.calls)
      expect(accessed(selected.calls)[0]).toBe(HOME_BIN)
    })
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

    /** A temp home install and a temp PATH directory (passed as an argument, never on the process PATH), each holding an executable agent-director. */
    function searchable(): { home: string; path: string } {
      file('home/.agent-director/bin/agent-director', 0o755)
      file('path/agent-director', 0o755)
      return { home: join(root, 'home'), path: onPath(join(root, 'path')) }
    }

    test(`a file given with ${AGENT_DIRECTOR_BINARY_OPTION} behind a symlink is selected by its real path, over the home install and PATH binaries`, () => {
      const { home, path } = searchable()
      const real = file('rc/agent-director-0.11.0-rc.1', 0o755)
      mkdirSync(join(root, 'given'))
      symlinkSync(real, join(root, 'given', 'agent-director'))
      expect(selectAgentDirectorBinary(join(root, 'given', 'agent-director'), home, path)).toEqual({ source: 'given', path: real })
    })

    test.each<[string, () => string, string]>([
      ['missing', () => join(root, 'absent'), `the path given with ${AGENT_DIRECTOR_BINARY_OPTION} does not exist (a missing file or a dangling symlink)`],
      [
        'a dangling symlink',
        () => {
          symlinkSync(join(root, 'gone'), join(root, 'dangling'))
          return join(root, 'dangling')
        },
        `the path given with ${AGENT_DIRECTOR_BINARY_OPTION} does not exist (a missing file or a dangling symlink)`,
      ],
      [
        'a directory',
        () => {
          mkdirSync(join(root, 'dir'))
          return join(root, 'dir')
        },
        `the path given with ${AGENT_DIRECTOR_BINARY_OPTION} is not a regular file`,
      ],
      ['a file with no execute bit', () => file('noexec/agent-director', 0o644), `the file given with ${AGENT_DIRECTOR_BINARY_OPTION} is not executable (no execute bit for this user)`],
    ])('a given path that is %s is refused with its reason; the home install and PATH binaries are not used', (_what, given, reason) => {
      const { home, path } = searchable()
      expect(selectAgentDirectorBinary(given(), home, path)).toEqual({ source: 'given', path: null, reason })
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

/** Every part is in `text`, in this order (by first occurrence). */
function expectInOrder(text: string, parts: string[]): void {
  const at = parts.map((s) => text.indexOf(s))
  expect(parts.filter((_, i) => at[i]! < 0)).toEqual([])
  expect([...at].sort((a, b) => a - b)).toEqual(at)
}

/** A string or template literal (a template without a nested backtick). */
const SCRIPT_LITERAL = /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g

/** A shell command word naming tmux or agent-director: the bare name or an absolute path ending in it. */
const TMUX_OR_AD_WORD = /^(?:\/\S*\/)?(?:tmux|agent-director)$/

/**
 * The tmux and agent-director commands in the `bash -c` scripts of `text`
 * (comment-stripped), which the argv scan's `['tmux', …]` literal never sees.
 * A `-c` argv element (any quote) is followed by its script: a literal, an
 * array of literals and `...` spreads that is `.join`ed, or a `const` in the
 * same file holding either (spreads resolved the same way). Each command of
 * the script (split at newlines, `;`, `&&`, `||`, `|`, `$(` and a backtick,
 * leading `if`, `then`, `do` and the like dropped) whose first word is tmux or
 * agent-director is collected. A script that is none of these is returned in
 * `unresolved`, so an indirection cannot pass silently.
 */
function shellScriptCommands(text: string): { commands: string[]; unresolved: string[] } {
  const resolving = new Set<string>()
  const constLiterals = (name: string): string[] | null => {
    const decl = new RegExp(`\\bconst ${name.replace(/\$/g, '\\$')}\\s*(?::[^=]+)?=\\s*`).exec(text)
    if (decl === null || resolving.has(name)) return null
    resolving.add(name)
    const literals = literalsAt(decl.index + decl[0].length, false)
    resolving.delete(name)
    return literals
  }
  const literalsAt = (at: number, mustJoin: boolean): string[] | null => {
    const rest = text.slice(at)
    if (/^['"`]/.test(rest)) {
      const literal = new RegExp(SCRIPT_LITERAL.source, 'y').exec(rest)?.[0]
      return literal !== undefined && /^\s*(?:[,\])\n;]|$)/.test(rest.slice(literal.length)) ? [literal] : null
    }
    if (rest.startsWith('[')) {
      const [from, to] = balancedAfter(text, at, '[', ']')
      if (mustJoin && !text.startsWith('.join(', to + 1)) return null
      const body = text.slice(from, to)
      const spreads = [...body.replace(SCRIPT_LITERAL, '""').matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)].map((m) => constLiterals(m[1]!))
      if (body.replace(SCRIPT_LITERAL, '').replace(/\.\.\.[A-Za-z_$][\w$]*/g, '').replace(/[\s,]/g, '') !== '') return null
      if (spreads.some((s) => s === null)) return null
      return [...(body.match(SCRIPT_LITERAL) ?? []), ...spreads.flatMap((s) => s ?? [])]
    }
    const name = /^([A-Za-z_$][\w$]*)\s*(?=[,\]\n]|$)/.exec(rest)?.[1]
    return name === undefined ? null : constLiterals(name)
  }
  /** The script element at `at`, as written: a name or member path, with its call's `(…)` or an array's `[…]`. */
  const elementAt = (at: number): string => {
    const head = /^[\w$.]*/.exec(text.slice(at))![0]
    const open = text[at + head.length]
    if (open !== '(' && open !== '[') return head
    const [, to] = balancedAfter(text, at + head.length, open, open === '(' ? ')' : ']')
    return text.slice(at, to + 1)
  }
  const commands: string[] = []
  const unresolved: string[] = []
  for (const m of text.matchAll(/(['"`])-c\1\s*,\s*/g)) {
    const at = m.index! + m[0].length
    const literals = literalsAt(at, true)
    if (literals === null) {
      unresolved.push(elementAt(at))
      continue
    }
    for (const literal of literals) {
      for (const part of literal.slice(1, -1).split(/\\n|\n|;|&&|\|\||\||\$\(|`/)) {
        const command = part.trim().replace(/^(?:(?:if|then|do|else|elif|while|until|!|\{|\()\s+)*/, '')
        const word = (command.split(/\s+/)[0] ?? '').replace(/^[\\'"]+|[\\'"]+$/g, '')
        if (TMUX_OR_AD_WORD.test(word)) commands.push(command)
      }
    }
  }
  return { commands, unresolved }
}

describe('shellScriptCommands (the runner-wiring audit\'s bash -c collector)', () => {
  test('collects a tmux or agent-director command from an inline -c script in any quote style', () => {
    expect(shellScriptCommands(`run(['bash', '-c', 'tmux ls', 'sessions'])`).commands).toEqual(['tmux ls'])
    expect(shellScriptCommands(`run(["bash", "-c", "tmux kill-server"])`).commands).toEqual(['tmux kill-server'])
    expect(shellScriptCommands('run([`bash`, `-c`, `agent-director list --label ${label}`])').commands).toEqual(['agent-director list --label ${label}'])
  })

  test('resolves a script held in a const: a string, or an array of lines joined, its spreads resolved too', () => {
    expect(shellScriptCommands(`const S = 'tmux ls -F x'\nconst a = ['bash', '-c', S, 'list']`).commands).toEqual(['tmux ls -F x'])
    const joined = `const TAIL = ['tail -c "$n" "$f"', 'tmux has-session -t "$s"']\nexport const S: string = [\n  'set -e',\n  ...TAIL,\n].join('\\n')\nrun(['bash', '-c', S])`
    expect(shellScriptCommands(joined).commands).toEqual(['tmux has-session -t "$s"'])
    expect(shellScriptCommands(`run(['bash', '-c', ['set -e', 'agent-director stop x'].join('\\n'), 'seed'])`).commands).toEqual(['agent-director stop x'])
  })

  test('collects a command after a separator or a shell keyword, and one named by an absolute path', () => {
    const script = `run(['bash', '-c', 'for i in $(seq 1 5); do if /usr/bin/tmux capture-pane -p; then exit 0; fi; done && x | tmux ls || exit 1'])`
    expect(shellScriptCommands(script).commands).toEqual(['/usr/bin/tmux capture-pane -p', 'tmux ls'])
  })

  test('collects nothing from a script that runs neither, nor from log text outside a -c script', () => {
    expect(shellScriptCommands(`run(['bash', '-c', 'printf "%s" "$1"; echo tmux', 'prompt'])\nconst why = 'tmux ls exit 1'`)).toEqual({ commands: [], unresolved: [] })
  })

  test('reports a script it cannot read (a call, an import, an array not joined) as unresolved', () => {
    const text = `run(['bash', '-c', helperScript(script)])\nrun(['bash', '-c', IMPORTED, 'x'])\nrun(['bash', '-c', ['tmux ls'], 'x'])`
    expect(shellScriptCommands(text)).toEqual({ commands: [], unresolved: ['helperScript(script)', 'IMPORTED', "['tmux ls']"] })
  })
})

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
    expect(text).toContain('new ContainerRun(bunSpawn, env.log, env.runId, REPO_ROOT, env.options.agentDirectorBinary)')
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
    expect([...new Set(dockerFirst)].sort()).toEqual(['args', 'buildImageArgs', 'image', 'info', 'inspect', 'logs', 'ps', 'restart', 'rm', 'stats', 'stop'])
    // The watchdog's one reading: this run's container only, one sample (never a stream), in the fixed format.
    expect([...text.matchAll(/\[\s*'stats'[^\]]*\]/g)].map((m) => m[0])).toEqual(["['stats', '--no-stream', '--format', CONTAINER_STATS_FORMAT, this.name]"])
    // The one docker stop (a kept container on a memory watchdog stop): by the inspected ID, with a 10 s grace before docker kills it.
    expect([...text.matchAll(/\[\s*'stop'[^\]]*\]/g)].map((m) => m[0])).toEqual(["['stop', '-t', String(KEPT_STOP_GRACE_S), owner.id]"])
    expect(text).toContain('const KEPT_STOP_GRACE_S = 10\n')
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

  test("the run's own container is removed (or, kept on a memory watchdog stop, stopped) only when docker inspect shows this runner's PID as its owner, by the inspected ID; stopAndRemove goes through remove or the kept container's stop", () => {
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
    inOrder(stop, ['this.stopping = true', 'if (this.pendingStart) await this.pendingStart', 'if (!this.runAttempted) return', 'if (keep) {', 'if (stopKept) return this.stopKeptContainer()', 'await this.remove()'])
    expect(stop).not.toContain('this.docker')
    // A kept container is stopped (a memory watchdog stop) only when it is ours, by the inspected ID, as a removal is.
    inOrder(bodyOf('private async stopOwn('), ['const owner = await this.ownership()', "if (owner.kind !== 'ours') return owner.kind", "this.docker.run(['stop', '-t', String(KEPT_STOP_GRACE_S), owner.id]"])
    inOrder(bodyOf('private async stopKeptContainer('), ['const outcome = await this.stopOwn()', "return 'kept-stopped'", "if (outcome === 'absent') return 'removed'", "return 'stop-failed'"])
    // Every container inspect names its format: the owner's ID and labels, or the ID alone (a bare inspect prints the env).
    const inspects = runnerSources().flatMap((p) => [...stripComments(readFileSync(p, 'utf-8')).matchAll(/\[\s*'inspect'[^\]]*\]/g)].map((m) => `${relative(CI_LIVE, p)}: ${m[0]}`))
    expect(inspects).toEqual([
      `${join('runtime', 'container-run.ts')}: ['inspect', '--type', 'container', '--format', INSPECT_OWNER_FORMAT, this.name]`,
      `${join('runtime', 'container-run.ts')}: ['inspect', '--type', 'container', '--format', '{{.Id}}', owner.id]`,
    ])
  })

  test("no host command starts, stops or kills CSCB, tmux or agent-director: those appear only in the checks, which reach the container only; the HOST check's two read-only probes are the only host-side agent-director and tmux argv (b.jg5 SRJ-1301's one exception)", () => {
    const failures: string[] = []
    const argvLiterals: string[] = []
    const shellCommands: string[] = []
    const unresolvedScripts: string[] = []
    let checkFiles = 0
    let dryRunSeed = ''
    let pinnedTakenOut = false
    /** The one exception: the dry run's fixture session, one `tmux new-session -d` in the test container, in main.ts's seedDryRunSessions. */
    const DRY_RUN_NEW_SESSION = "'tmux new-session -d -s \"$5\" -x \"$6\" -y 24 bash -c \\'cat -- \"$1\"; exec sleep infinity\\' pane-fixture \"$7\"'"
    for (const path of runnerSources()) {
      let text = stripComments(readFileSync(path, 'utf-8'))
      const rel = relative(CI_LIVE, path)
      if (rel.startsWith(`checks${join('/')}`)) {
        checkFiles += /kill-session/.test(text) ? 1 : 0
        if (/\bspawn\b|\bSpawnFn\b|\bDockerCli\b|\bBun\.|lib\/proc\.ts|\.docker\b/.test(text)) failures.push(`${rel}: a check reaches a process other than through ctx.container`)
        continue
      }
      // Only that one string is taken out, and only from inside seedDryRunSessions: every scan below still covers the rest of the
      // function, so a second tmux command there (or that string anywhere else) fails the audit.
      if (rel === 'main.ts') {
        const [from, to] = balancedAfter(text, text.indexOf('async function seedDryRunSessions('), '{', '}')
        dryRunSeed = text.slice(from, to)
        const at = dryRunSeed.indexOf(DRY_RUN_NEW_SESSION)
        if (at >= 0) {
          text = text.slice(0, from + at) + text.slice(from + at + DRY_RUN_NEW_SESSION.length)
          pinnedTakenOut = true
        }
      }
      if (/kill-session|send-keys|new-session|kill-server/.test(text)) failures.push(`${rel}: builds a tmux command that changes sessions`)
      if (/claude-slack-channel-bots['",\s]+(start|stop|restart)\b/.test(text)) failures.push(`${rel}: builds a CSCB start or stop`)
      for (const m of text.matchAll(/\[\s*'(agent-director|tmux)'[^\]]*\]/g)) argvLiterals.push(`${rel}: ${m[0]}`)
      const shell = shellScriptCommands(text)
      shellCommands.push(...shell.commands.map((c) => `${rel}: ${c}`))
      unresolvedScripts.push(...shell.unresolved.map((s) => `${rel}: ${s}`))
      if (/\.sh\(/.test(text)) failures.push(`${rel}: runs a script through the container's sh outside the checks`)
    }
    expect(failures).toEqual([])
    // The bash -c scripts' tmux commands, which the argv literal scan above does not see: each read-only and run in the test
    // container, never on the host. container-logs.ts's three copy a persona's pane (listSessionsArgv, capturePaneArgv) and
    // reach a process only through its one o.container.exec (docker exec, lib/container.ts); main.ts's waits for the dry
    // run's fixture pane in seedDryRunSessions' tc.exec (pinned below). Exact equality, so a new one fails until reviewed.
    expect(shellCommands.sort()).toEqual([
      `${join('lib', 'container-logs.ts')}: tmux capture-pane -p -J -S "-$h" -t "$s" > "$f" 2>/dev/null`,
      `${join('lib', 'container-logs.ts')}: tmux has-session -t "$s" 2>/dev/null`,
      `${join('lib', 'container-logs.ts')}: tmux ls -F "#{session_name}"`,
      'main.ts: tmux capture-pane -p -t "$5"',
    ])
    const containerLogs = code(join('lib', 'container-logs.ts'))
    expect(indicesOf(/\bo\.container\.exec\(/g, containerLogs).length).toBe(1)
    expect(containerLogs).not.toMatch(/\bbunSpawn\b|\bSpawnFn\b|\bBun\.|\bspawn\b|\.docker\b|\bDockerCli\b/)
    // The closed list of bash -c scripts the collector cannot read: TestContainer.sh's, the checks' own scripts (scanned with
    // the checks above, in the container only); no runner file outside the checks calls sh (failures above).
    expect(unresolvedScripts).toEqual([`${join('lib', 'container.ts')}: helperScript(script)`])
    // The checks do kill tmux sessions (Checks 7, 12, 24), in the container; on the host only the HOST check's two read-only probes run.
    // b.jg5 SRJ-1301: these two argv are the one exception to "no host-side agent-director or tmux"; exact equality, so a third fails.
    expect(checkFiles).toBeGreaterThan(0)
    expect(argvLiterals).toEqual([
      `${join('lib', 'host-state.ts')}: ['agent-director', '--store-path', hostStorePath(home), 'list', '--label', 'service=cscb']`,
      `${join('lib', 'host-state.ts')}: ['tmux', 'ls', '-F', '#{session_name}']`,
    ])
    // The dry run's fixture session: one `tmux new-session -d`, in the one exec script of the container it plants in (tc.exec, never the host), and
    // nothing that kills a session or sends keys. It runs only in a dry run: seedDryRunContainerLogs, its one caller, is called only `dry ? …` (pinned below).
    expect(pinnedTakenOut).toBe(true)
    expect(indicesOf(/new-session/g, code('main.ts')).length).toBe(1)
    expect(dryRunSeed).not.toMatch(/kill-session|send-keys|kill-server|\bspawn\b|\bBun\.|\.docker\b|container\.|bunSpawn/)
    const sessionExec = indicesOf(/\btc\.exec\(\[/g, dryRunSeed)
    expect(sessionExec.length).toBe(2)
    expect(callArguments(dryRunSeed, sessionExec[1] ?? -1)).toContain(DRY_RUN_NEW_SESSION)
    const main = code('main.ts')
    expect(callsOf(main, 'seedDryRunSessions').length).toBe(2)
    expect(main).toContain('return { secret, unterminated, wrapped, transcript: await seedDryRunSessions(tc, secret, tokenShaped, wrapped) }')
    // The symlinked decoy transcript proves something only when its target is newer than the transcript to copy (bash's -nt follows
    // a symlink): the seed touches its own fixture target (never a credentials file, mounted read-only) and checks it.
    const seedScript = callArguments(dryRunSeed, sessionExec[1] ?? -1)
    expect(seedScript).toContain("'touch -d \"10 minutes ago\" -- \"$1\"; touch -d \"1 hour ago\" -- \"$2\"; touch -- \"$3\"'")
    expect(seedScript).toContain("'[ \"$4\" -nt \"$1\" ] || exit 3'")
    expect(seedScript).not.toContain('CONTAINER_CREDENTIALS_DIR')
    expect(dryRunSeed).toContain('const linkTarget = `${CONTAINER_CSCB_LIVE_DIR}/dry-run-symlinked-transcript.jsonl`')
    expect(callsOf(main, 'seedDryRunContainerLogs').map((at) => main.slice(main.lastIndexOf('\n', at) + 1, main.indexOf('\n', at)).trim())).toEqual([
      'async function seedDryRunContainerLogs(tc: ContainerExec, redactor: Redactor): Promise<ContainerLogsSeed> {',
      "const logsSeed = dry ? await seedDryRunContainerLogs(tc, env.redactor).catch((err: unknown) => `planting the container's logs failed: ${describeError(err)}`) : null",
    ])
  })

  test("signals: Playwright's own handlers are off; SIGINT, SIGTERM and SIGHUP, and the memory watchdog's abort, all go through the one stopRun(cause), which cleans up, writes the results with the cause's FAIL row, releases the lock and exits 1, once", () => {
    const driver = code(join('browser', 'driver.ts'))
    expect(indicesOf(/\bchromium\.launch\(/g, driver).length).toBe(1)
    const launch = callArguments(driver, driver.indexOf('chromium.launch('))
    for (const flag of ['handleSIGINT: false', 'handleSIGTERM: false', 'handleSIGHUP: false']) expect(launch).toContain(flag)
    // Only the run (main.ts) and the maintenance commands handle signals.
    expect(runnerSources().filter((p) => /\bprocess\.(on|once)\(/.test(stripComments(readFileSync(p, 'utf-8')))).map((p) => relative(CI_LIVE, p)).sort()).toEqual(['main.ts', 'maintenance.ts'])
    const main = code('main.ts')
    expect(main).toContain("const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const")
    expect(main).toContain('for (const signal of STOP_SIGNALS) process.on(signal, handler)')
    expect(main).toContain('const handler = (signal: NodeJS.Signals): void => stopRun(signalStop(signal))')
    expect(main).toContain('abort: stopRun,')
    expect(main).toContain('onAbort: (reason) => signals.abort(watchdogStop(reason)),')
    const stopRun = main.slice(...balancedAfter(main, main.indexOf('const stopRun = (cause: StopCause): void =>'), '{', '}'))
    expectInOrder(stopRun, [
      'if (stopping) {',
      'stopping = true',
      'current?.interrupted?.(cause)',
      // The cause reaches the cleanup: a memory watchdog stop closes Chrome at once and stops a kept container.
      'if (current) await withDeadline(current.cleanup(cause), SIGNAL_CLEANUP_MS)',
      'current?.finishInterrupted?.(cause)',
      'if (!hasVerdict(env)) writeVerdict(env, `FAIL: ${cause.rowId}: ${cause.reason}`)',
      'lock?.release()',
      'process.exit(EXIT_FAIL)',
    ])
    // The verdicts: `FAIL: runner: interrupted by <signal>`, and `FAIL: memory watchdog: <what crossed, its value and the limit>`; only the watchdog's is a memory stop.
    const cause = (fn: string) => objectProperties(main.slice(main.indexOf('return', main.indexOf(`function ${fn}(`))))
    expect(['signalStop', 'watchdogStop'].map((fn) => [cause(fn).get('rowId'), cause(fn).get('reason'), cause(fn).get('memory')])).toEqual([
      ["'runner'", '`interrupted by ${signal}`', 'false'],
      ["'memory watchdog'", 'reason', 'true'],
    ])
    // The maintenance commands: a signal closes the browser, releases the lock and exits 1, but waits for a rotated pair being saved.
    const maintenance = code('maintenance.ts')
    expect(maintenance).toContain("const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const")
    expectInOrder(maintenance, ['for (const signal of STOP_SIGNALS) process.on(signal, handler)', 'for (const signal of STOP_SIGNALS) process.off(signal, handler)'])
    expectInOrder(maintenance.slice(...balancedAfter(maintenance, maintenance.indexOf('const stop = async (signal: string): Promise<void> =>'), '{', '}')), [
      'await ws?.close()',
      'lock?.release()',
      'process.exit(EXIT_FAIL)',
    ])
    expectInOrder(maintenance.slice(...balancedAfter(maintenance, maintenance.indexOf('const handler = (signal: NodeJS.Signals): void =>'), '{', '}')), [
      'if (stopping) return',
      'stopping = true',
      'if (saving) err(',
      'else void stop(signal)',
    ])
    expectInOrder(maintenance.slice(maintenance.indexOf("if (options.command === 'config-token') {")), ['saving = true', 'await ws.configTokens.rotateNow()', 'finally {', 'saving = false'])
  })

  test("the memory watchdog reads the host cgroup, the run's container, the runner's Chrome tree and its own RSS; it runs through a run and --provision-only, stops first in their cleanup, and its peaks go into the results", () => {
    const main = code('main.ts')
    const sources = objectProperties(main.slice(main.indexOf('sources: {', main.indexOf('new MemoryWatchdog('))))
    expect([...sources]).toEqual([
      ['host', '() => readHostCgroup()'],
      ['container', 'sources.container'],
      ['chrome', '() => ({ ...chromeTreePss(process.pid), browser: sources.browserStats() })'],
      ['runnerRssBytes', '() => process.memoryUsage().rss'],
    ])
    const starts = callsOf(main, 'startWatchdog').map((at) => callArguments(main, at).replace(/\s+/g, ' ').trim())
    expect(starts.slice(1)).toEqual([
      'env, signals, { container: async () => null, browserStats: () => ws.browserStats() }',
      'env, signals, { container: () => container.stats(), browserStats: () => ws.browserStats() }',
    ])
    // --provision-only: a stop closes the browser (Chrome first, in ws.close) alongside the watchdog's stop; its end stops the watchdog before its peaks.
    const provisionOnly = main.slice(...balancedAfter(main, main.indexOf('async function runProvisionOnly('), '{', '}'))
    const active = objectProperties(provisionOnly.slice(provisionOnly.indexOf('{', provisionOnly.indexOf('signals.setActive('))))
    expect([...active.keys()]).toEqual(['cleanup'])
    expect(active.get('cleanup')!.replace(/\s+/g, ' ')).toBe('async () => { await Promise.all([watchdog.stop(), ws.close()]) }')
    expectInOrder(provisionOnly.slice(provisionOnly.indexOf('finally {')), ['signals.setActive(null)', 'await watchdog.stop()', 'stopWatchdog(env, watchdog)', 'await ws.close()'])
    // A run's one cleanup: the watchdog stopped first and awaited last (no line after the results); on a memory stop Chrome closes alongside the container, never after it.
    // The container's own logs are copied before its removal or stop (a memory stop waits for them only briefly, Chrome already closing).
    expect(main).toContain('const closeChrome = async (): Promise<void> => {\n    await ws.closeBrowser()\n    ended.browserClosed = true\n  }')
    const cleanup = main.slice(...balancedAfter(main, main.indexOf('const cleanup = (cause?: StopCause): Promise<void> =>'), '{', '}'))
    expectInOrder(cleanup, [
      'const watchdogStopped = watchdog.stop()',
      'const chromeClosed = cause?.memory === true ? closeChrome() : Promise.resolve()',
      'await collectLogs(cause?.memory === true)',
      'ended.container = await container.stopAndRemove(env.options.keepContainer, cause?.memory === true)',
      'await chromeClosed',
      'await ws.close()',
      'finally {',
      'await watchdogStopped',
    ])
    // Its end: a last sample, the watchdog stopped (its line in), then the results with the peaks.
    const runFull = main.slice(...balancedAfter(main, main.indexOf('async function runFull('), '{', '}'))
    expectInOrder(runFull.slice(runFull.lastIndexOf('await watchdog.sample()')), ['await watchdog.sample()', 'await watchdog.stop()', 'return finish(env, ws, state)'])
    expectInOrder(main.slice(main.indexOf('function finish(')), ['const memory = state.watchdog ? stopWatchdog(env, state.watchdog) : undefined', 'memory,', 'writeResults(summary'])
    // The workspace's close closes Chrome first, then waits for the drivers (a sign-in in progress then fails at once).
    const workspace = code(join('runtime', 'workspace.ts'))
    expectInOrder(workspace.slice(...balancedAfter(workspace, workspace.indexOf('async close()'), '{', '}')), ['await closeBrowser()', 'for (const p of [human, second])', 'await d?.close()'])
    expectInOrder(workspace.slice(workspace.indexOf('const closeBrowser = async (): Promise<void> =>')), ['const h = host ? await host.catch(() => null) : null', 'launched = null', 'await h?.close()'])
  })

  test("the container's own logs are copied, once, before every removal or stop of the container (Teardown, --keep-container, a failed start, a run's end, a signal, a memory watchdog stop), and sealed before the closing scan, which covers them", () => {
    const main = code('main.ts')
    const runFull = main.slice(...balancedAfter(main, main.indexOf('async function runFull('), '{', '}'))
    // The one copy per run: its sink in the results dir, the stub's tokens registered first, and its waits (a memory watchdog stop's short one).
    const collector = objectProperties(runFull.slice(runFull.indexOf('{', runFull.indexOf('const containerLogs = new ContainerLogCollector('))))
    expect([...collector]).toEqual([
      ['redactor', 'env.redactor'],
      ['sink', 'containerLogsSink(env.resultsDir)'],
      ['log', 'env.log'],
      // The real cap; only a dry run, whose self-test plants a log over its cap, uses the smaller one.
      ['maxBytes', 'dry ? DRY_RUN_CONTAINER_LOG_MAX_BYTES : CONTAINER_LOG_MAX_BYTES'],
    ])
    expect(runFull).toContain('state.containerLogs = containerLogs')
    expectInOrder(runFull.slice(...balancedAfter(runFull, runFull.indexOf('const collectLogs = (urgent = false): Promise<void> =>'), '{', '}')), [
      'registerStubTokens(env, ws)',
      'return containerLogs.collect(container.container, urgent ? CONTAINER_LOGS_URGENT_WAIT_MS : CONTAINER_LOGS_WAIT_MS)',
    ])
    // The two waits are container-logs.ts's, imported and never redeclared here: 60 s, and 15 s on a memory watchdog stop.
    expect([CONTAINER_LOGS_WAIT_MS, CONTAINER_LOGS_URGENT_WAIT_MS]).toEqual([60_000, 15_000])
    const logsImport = (/^import \{([^}]*)\} from '\.\/lib\/container-logs\.ts'$/m.exec(main)?.[1] ?? '').split(',').map((s) => s.trim())
    expect(logsImport).toEqual(expect.arrayContaining(['CONTAINER_LOGS_URGENT_WAIT_MS', 'CONTAINER_LOGS_WAIT_MS']))
    expect(main).not.toMatch(/\b(const|let|var)\s+CONTAINER_LOGS_(URGENT_)?WAIT_MS\b/)
    // A signal's deadline leaves the removal its 200 s on top of the copy's wait.
    expect(main).toContain('const SIGNAL_CLEANUP_MS = 200_000 + CONTAINER_LOGS_WAIT_MS\n')
    expect(main).toContain('if (current) await withDeadline(current.cleanup(cause), SIGNAL_CLEANUP_MS)')
    // Only main.ts holds a ContainerRun, and every removal or stop of its container awaits the copy first, in the same block.
    expect(runnerSources().filter((p) => /\bnew ContainerRun\(/.test(stripComments(readFileSync(p, 'utf-8')))).map((p) => relative(CI_LIVE, p))).toEqual(['main.ts'])
    const blockStart = (at: number): number => {
      let depth = 0
      for (let i = at - 1; i >= 0; i--) {
        if (main[i] === '}') depth++
        else if (main[i] === '{' && depth-- === 0) return i + 1
      }
      throw new Error('no enclosing block')
    }
    const removals = indicesOf(/\bcontainer\.(stopAndRemove|remove)\(/g, main)
    expect(removals.length).toBe(3)
    for (const at of removals) {
      const site = main.slice(at, main.indexOf('\n', at)).trim()
      expect([site, main.slice(blockStart(at), at).includes('await collectLogs(')]).toEqual([site, true])
    }
    // The failed start: the docker logs, the copy, then the removal.
    expectInOrder(runFull, [
      "record(runnerRow('container', 'The live image and the test container',",
      "state.containerLog = await container.logs().catch(() => '')",
      'await collectLogs()',
      'await container.stopAndRemove(env.options.keepContainer).catch(() => undefined)',
    ])
    // Teardown: copied whether the container is kept (--keep-container) or removed.
    const removeContainer = runFull.slice(...balancedAfter(runFull, runFull.indexOf('removeContainer: async () =>'), '{', '}'))
    expectInOrder(removeContainer, ["state.containerLog = await container.logs().catch(() => '')", 'await collectLogs()', 'if (env.options.keepContainer) {', 'return true', 'return container.remove()'])
    // The run's end: anything not copied yet is copied before the results (a no-op after Teardown's copy).
    expectInOrder(runFull.slice(runFull.lastIndexOf('await collectLogs()')), ['await collectLogs()', 'await watchdog.sample()', 'await watchdog.stop()', 'return finish(env, ws, state)'])
    // The dry run plants its fixture logs after the plan's checks (S2 and 29a read the state dir), checks Teardown's copy after it.
    expectInOrder(runFull, [
      'await runChecks(PLAN_CHECKS, ctx,',
      'const logsSeed = dry ? await seedDryRunContainerLogs(tc, env.redactor)',
      'await runChecks(FINAL_CHECKS, ctx,',
      'if (logsSeed !== null) record(dryRunContainerLogsCheck(env, logsSeed, containerLogs, t0Logs))',
    ])
    // The results: sealed first (no copy lands after the scan), the stub's tokens registered, then the scan over the whole results dir.
    const finish = main.slice(...balancedAfter(main, main.indexOf('function finish('), '{', '}'))
    expectInOrder(finish, [
      'state.finished = true',
      'state.containerLogs?.seal()',
      'registerStubTokens(env, ws)',
      'writeResults(summary, writer, env.redactor)',
      "const scan = scanOutputs([env.resultsDir], [{ source: 'docker logs', text: state.containerLog }], env.redactor.knownSecrets())",
      'container logs scanned: ${scan.counts.filter((c) => isInside(c.source, logsDir)).length} file(s) in ${CONTAINER_LOGS_DIR}/',
    ])
    expect(finish).toContain('const logsDir = join(env.resultsDir, CONTAINER_LOGS_DIR)')
  })

  test("the prompt guard runs from the first plan check to the last: its hooks around each, stopped before Teardown, halted by a stop's cleanup, its report in the results; a real run's clicks go through the test human's own browser and session", () => {
    const main = code('main.ts')
    const runFull = main.slice(...balancedAfter(main, main.indexOf('async function runFull('), '{', '}'))
    expectInOrder(runFull, [
      'const promptGuard = new PromptGuard(',
      'containerPromptGuardDeps(guardTarget, { redact: (text) => env.redactor.redact(text), log: (line) => env.log.info(line), note: (line) => state.runNotes.push(line) })',
      'state.promptGuard = promptGuard',
      'promptGuard,',
      'const guardHooks = { beforeCheck: (c: CheckRef) => promptGuard.beforeCheck(c.id), afterCheck: (c: CheckRef) => promptGuard.afterCheck(c.id) }',
      'promptGuard.start()',
      'await runChecks(PLAN_CHECKS, ctx, { ...options, ...guardHooks, only: env.options.only })',
      'if (dry) record(await dryRunPromptGuardSelfTest(env, ws, tc, ids, promptGuard, state.runNotes))',
      'await promptGuard.stop()',
      'const logsSeed = dry ? await seedDryRunContainerLogs(tc, env.redactor)',
      'await runChecks(FINAL_CHECKS, ctx, { ...options, only: [] })',
    ])
    expect(indicesOf(/\bpromptGuard\.start\(\)/g, main).length).toBe(1)
    expect(indicesOf(/\bnew PromptGuard\(/g, main).length).toBe(1)
    // Only a dry run's target is the stub's browser; a real run's is the test human's.
    expect(runFull).toContain(
      'const guardTarget: PromptGuardTarget = dry\n        ? await dryRunGuardTarget(env, ws, tc, ids)\n        : { container: tc, clock: realClock, ids, browser: sessions?.browser ?? null, human: sessions?.human ?? null }',
    )
    // A stop's cleanup halts it without waiting (the container and the browser are going), after the watchdog's stop.
    const cleanup = main.slice(...balancedAfter(main, main.indexOf('const cleanup = (cause?: StopCause): Promise<void> =>'), '{', '}'))
    expectInOrder(cleanup, ['const watchdogStopped = watchdog.stop()', 'state.promptGuard?.halt()', 'await collectLogs(cause?.memory === true)'])
    expectInOrder(main.slice(main.indexOf('function finish(')), ['promptGuard: state.promptGuard?.report(),', 'memory,', 'writeResults(summary'])
    // Its one agent-director command is the fallback deny, behind the plan's guard, through the checks' helpers (ctx.container).
    const guard = code(join('checks', 'prompt-guard.ts'))
    expect(indicesOf(/agent-director decide --/g, guard).length).toBe(1)
    expect(guard).toContain('return `agent-director decide --claude-instance-id ${q(p.instanceId)} --decision deny --request-token ${q(p.token)} --reason ${q(PROMPT_GUARD_DENY_REASON)}`')
    expect(guard).toContain('const r = await guarded(target, denyScript(p))')
    expect(guard).not.toMatch(/\bspawn\b|\bBun\.|\.docker\b|tmux|\.container\.(sh|exec|writeFile)\(/)
  })

  test('the stopped run\'s note words the container\'s end through describeContainerEnd', () => {
    const main = code('main.ts')
    expect(main).toContain('return `${cause.noteHead}; ${describeContainerEnd(ended.container, containerName)}; ${browser}; the results so far written`')
    expect(main).toContain('state.runNotes.push(stopNote(cause, ended, container.name))')
  })

  test("the browser is bounded: one Chrome with its flags capping memory and renderers, at most two contexts and two pages, a site's own pages closed, every flow's page back on about:blank, a crashed page replaced", () => {
    const driver = code(join('browser', 'driver.ts'))
    expect(driver).toContain('export const MAX_CONTEXTS = 2')
    expect(driver).toContain('export const MAX_PAGES = 2')
    const args = driver.slice(...balancedAfter(driver, driver.indexOf('= [', driver.indexOf('export const CHROME_ARGS')), '[', ']'))
    for (const flag of ["'--disable-dev-shm-usage'", "'--js-flags=--max-old-space-size=1024'", "'--renderer-process-limit=2'"]) expect(args).toContain(flag)
    expect(callArguments(driver, driver.indexOf('chromium.launch('))).toContain('args: [...CHROME_ARGS]')
    // A context (and its page) only below both limits.
    const open = driver.slice(...balancedAfter(driver, driver.indexOf('async openDriver('), '{', '}'))
    expectInOrder(open, ['if (open.contexts >= MAX_CONTEXTS || open.pages >= MAX_PAGES) {', 'throw new Error(', 'this.browser.newContext('])
    // newPage: the driver's one page, and a crashed one's replacement after it is closed.
    expect(indicesOf(/\.newPage\(/g, driver).length).toBe(2)
    expectInOrder(driver.slice(driver.indexOf('private async usablePage(')), ['if (!this.crashed) return this.page', 'await this.page.close()', 'this.page = await this.context.newPage()'])
    expectInOrder(driver, ["context.on('page', (opened) => {", 'if (opened === this.page || this.opening) return', 'void opened.close()'])
    expectInOrder(driver.slice(driver.indexOf('private async flow<T>(')), ['return await work(await this.usablePage())', 'finally {', 'await this.idle()'])
    // Flows run one at a time, in call order: each waits for the one before, and lets the next go only after its page is idle, even on a throw.
    const flow = driver.slice(...balancedAfter(driver, driver.indexOf('private async flow<T>('), '{', '}'))
    expectInOrder(flow, ['const previous = this.flowing', 'this.flowing = new Promise<void>(', 'await previous', 'return await work(await this.usablePage())', 'await this.idle()', 'done()'])
    expect(flow).toMatch(/await this\.idle\(\)\s*\}\s*finally\s*\{\s*done\(\)/)
    expect(driver).toContain('private flowing: Promise<void> = Promise.resolve()')
    // The sign-in idles its page too, signed in or failed; only a code prompt stays open, for the code.
    expectInOrder(driver.slice(...balancedAfter(driver, driver.indexOf('async ensureSignedIn('), '{', '}')), [
      "let outcome: SignInOutcome = 'signed-in'",
      'try {',
      'outcome = await signInWithPassword(',
      'finally {',
      "if (outcome !== 'needs-code') await this.idle()",
    ])
    for (const method of ['installApp(', 'generateAppToken(', 'revokeAppToken(', 'clickMessageButton(', 'listApps(']) {
      const body = driver.slice(...balancedAfter(driver, driver.indexOf(`\n  ${method}`), '{', '}'))
      expect([method, body.trim().startsWith('return this.flow(')]).toEqual([method, true])
    }
    // The workspace launches that one Chrome once, and each account's driver is a context in it.
    const workspace = code(join('runtime', 'workspace.ts'))
    expect(workspace).toContain("(host ??= import('../browser/driver.ts')")
    expect(workspace).toContain('const driver = await (await chrome()).openDriver(')
    expect(indicesOf(/\blaunchDriver\b/g, workspace).length).toBe(0)
  })

  test("every RunLock.acquire (main.ts's and maintenance.ts's only) passes a warning sink, so a stale lock's removal is never silent; the maintenance commands take the real lock in the resolved config dir", () => {
    const acquires = runnerSources().flatMap((p) => {
      const text = stripComments(readFileSync(p, 'utf-8'))
      return indicesOf(/\bRunLock\.acquire\(/g, text).map((at) => `${relative(CI_LIVE, p)}: ${splitTopLevel(callArguments(text, at)).join(', ')}`)
    })
    expect(acquires.sort()).toEqual([
      "main.ts: dryRunLockFile(tmpdir(), uid), '/ci-live dry run', nodeLockDeps, warn",
      'main.ts: realRunLockFile(configDir), REAL_LOCK_WHAT, nodeLockDeps, warn',
      'maintenance.ts: realRunLockFile(configDir), REAL_LOCK_WHAT, nodeLockDeps, err',
    ])
    const main = code('main.ts')
    expect(main).toContain('const warn = (warning: string): void => env.log.info(warning)')
    const maintenance = code('maintenance.ts')
    expect(maintenance).toContain('const err = (line: string): void => {\n    process.stderr.write(`${redactor.redact(line)}\\n`)\n  }')
    expectInOrder(maintenance, ['const configDir = resolveConfigDir(process.env, homedir())', 'lock = RunLock.acquire(realRunLockFile(configDir),', "ws = openWorkspace({ repoRoot, runId: String(Math.floor(Date.now() / 1000)), redactor, log }, 'real')"])
    // apps --list|--delete-strays: apps.json is checked before Chrome is launched, and read again after the list, before any delete.
    expectInOrder(maintenance.slice(...balancedAfter(maintenance, maintenance.indexOf('async function appsCommand('), '{', '}')), [
      "const readState = (): AppsState => (action === 'delete-strays' ? appsStateForStrayDeletion(ws.appsFile) : ws.appsFile.load())",
      'readState()',
      'const browser = await ws.browser()',
      'const listed = await browser.listApps()',
      'const state = readState()',
      'await deleteStrayApps({ callManifest: ws.callManifest, appsFile: ws.appsFile, log }, classified)',
    ])
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
    // The binary: only through selectAgentDirectorBinary, given the option's path, the host home and the child PATH, once in the runner.
    const selections = runnerSources().flatMap((p) => {
      const t = stripComments(readFileSync(p, 'utf-8'))
      return ['selectAgentDirectorBinary', 'checkGivenAgentDirectorBinary', 'hostAgentDirectorBinary'].flatMap((fn) => callsOf(t, fn).map((at) => `${relative(CI_LIVE, p)}: ${fn}(${callArguments(t, at)})`))
    })
    expect(selections.filter((s) => !s.startsWith(`${join('lib', 'agent-director-binary.ts')}: `))).toEqual([
      `${join('runtime', 'container-run.ts')}: selectAgentDirectorBinary(this.givenAgentDirectorBinary, homedir(), minimalChildEnv(process.env).PATH)`,
    ])
    // No second copy of the parsing or the search: no boot-record regex, no direct file-system probe.
    expect([/\(\\d\+\) \(\[a-z-\]\+\)/.test(text), /\b(accessSync|realpathSync|statSync)\b/.test(text)]).toEqual([false, false])
  })

  test("the selected binary's path is only read and copied into a fresh temp dir under tmpdir(), the build's named context, removed through removeStage in a finally; it reaches no spawn, host argv or docker argv", () => {
    const text = code(join('runtime', 'container-run.ts'))
    // The option's path is set by parseArgs and reaches only ContainerRun's constructor, which keeps it for the selection.
    /** Every line of the runner's sources holding a match of `re`, as `<file>: <line>`. */
    const linesIn = (re: RegExp) =>
      runnerSources()
        .flatMap((p) => {
          const t = stripComments(readFileSync(p, 'utf-8'))
          return indicesOf(re, t).map((at) => `${relative(CI_LIVE, p)}: ${t.slice(t.lastIndexOf('\n', at) + 1, t.indexOf('\n', at)).trim()}`)
        })
        .sort()
    expect(linesIn(/\boptions\.agentDirectorBinary\b/g)).toEqual([
      `${join('lib', 'args.ts')}: options.agentDirectorBinary = value`,
      'main.ts: const container = new ContainerRun(bunSpawn, env.log, env.runId, REPO_ROOT, env.options.agentDirectorBinary)',
    ])
    expect([...text.matchAll(/\bgivenAgentDirectorBinary\b[^\n]*/g)].map((m) => m[0])).toEqual([
      'givenAgentDirectorBinary?: string,',
      'givenAgentDirectorBinary, homedir(), minimalChildEnv(process.env).PATH)',
    ])
    // The selection runs twice: main.ts's precondition (its answer dropped) and buildImage's, which stages it.
    expect(linesIn(/\.agentDirectorBinary\(\)/g)).toEqual(['main.ts: container.agentDirectorBinary()', `${join('runtime', 'container-run.ts')}: const binary = this.agentDirectorBinary()`])
    // buildImage: select, a fresh temp dir under the OS temp dir (kept for removeStage), the copy and its mode, the build, and the dir's removal in the finally.
    const build = text.slice(...balancedAfter(text, text.indexOf('async buildImage('), '{', '}'))
    expectInOrder(build, [
      'const binary = this.agentDirectorBinary()',
      'const staged = mkdtempSync(join(tmpdir(), `cscb-ci-live-ad-${this.runId}-`))',
      'this.stageDir = staged',
      'try {',
      "copyFileSync(binary.path, join(staged, 'agent-director'))",
      "chmodSync(join(staged, 'agent-director'), 0o755)",
      'buildImageArgs({ repoRoot: this.repoRoot, uid, gid, agentDirectorDir: staged })',
      'finally {',
    ])
    expect(build.slice(...balancedAfter(build, build.indexOf('finally {'), '{', '}')).trim()).toBe('this.removeStage()')
    // Every line naming the binary or the staged dir: the path is read by the copy and logged, nothing else.
    const linesWith = (re: RegExp) => build.split('\n').filter((l) => re.test(l)).map((l) => l.trim())
    expect(linesWith(/\bbinary\b/)).toEqual([
      'const binary = this.agentDirectorBinary()',
      "copyFileSync(binary.path, join(staged, 'agent-director'))",
      "const how = binary.source === 'given' ? `given with ${AGENT_DIRECTOR_BINARY_OPTION}` : `found on this host (none was given with ${AGENT_DIRECTOR_BINARY_OPTION})`",
      'this.log.info(`container: building the live image with the agent-director binary ${binary.path}, ${how}`)',
    ])
    expect(linesWith(/\bstaged\b/)).toEqual([
      'const staged = mkdtempSync(join(tmpdir(), `cscb-ci-live-ad-${this.runId}-`))',
      'this.stageDir = staged',
      "copyFileSync(binary.path, join(staged, 'agent-director'))",
      "chmodSync(join(staged, 'agent-director'), 0o755)",
      'const r = await this.docker.run(buildImageArgs({ repoRoot: this.repoRoot, uid, gid, agentDirectorDir: staged }), { timeoutMs: 600_000, cwd: this.repoRoot })',
    ])
    // The file system: these four calls only, and the two temp dirs (the pack's, the binary's) are fresh ones under tmpdir().
    expect(text).toMatch(/^import \{ chmodSync, copyFileSync, mkdtempSync, rmSync \} from 'node:fs'$/m)
    expect(indicesOf(/from 'node:fs|from 'fs/g, text).length).toBe(1)
    expect(callsOf(text, 'mkdtempSync').map((at) => callArguments(text, at))).toEqual(['join(tmpdir(), `cscb-ci-live-pack-${this.runId}-`)', 'join(tmpdir(), `cscb-ci-live-ad-${this.runId}-`)'])
    expect([callsOf(text, 'copyFileSync').length, callsOf(text, 'chmodSync').length]).toEqual([1, 1])
    // No spawn, host argv or docker argv names the binary; the staged dir only as buildImageArgs' named context.
    const spawned = indicesOf(/\bthis\.(host|spawn|docker\.run)\(/g, text).map((at) => callArguments(text, at).replace(/\s+/g, ' ').trim())
    expect(spawned.filter((args) => /\bbinary\b|AgentDirectorBinary|\bselected\b/.test(args))).toEqual([])
    expect(spawned.filter((args) => /\bstaged\b/.test(args))).toEqual(['buildImageArgs({ repoRoot: this.repoRoot, uid, gid, agentDirectorDir: staged }), { timeoutMs: 600_000, cwd: this.repoRoot }'])
  })

  test("the staged binary's temp dir is removed only by removeStage, once: buildImage's finally and the run's one cleanup (a signal's or the memory watchdog's stop mid-build) call it", () => {
    const text = code(join('runtime', 'container-run.ts'))
    // The field: null until buildImage's mkdtempSync, set on the very next line (before the try), and cleared only by removeStage.
    const build = text.slice(...balancedAfter(text, text.indexOf('async buildImage('), '{', '}'))
    expect(build).toMatch(/^\s*const staged = mkdtempSync\(join\(tmpdir\(\), `cscb-ci-live-ad-\$\{this\.runId\}-`\)\)\n\s*this\.stageDir = staged\n\s*try \{$/m)
    expect([...text.matchAll(/^.*\bstageDir\b.*$/gm)].map((m) => m[0].trim())).toEqual([
      'private stageDir: string | null = null',
      'this.stageDir = staged',
      'if (this.stageDir === null) return',
      'rmSync(this.stageDir, { recursive: true, force: true })',
      'this.stageDir = null',
    ])
    // removeStage: nothing once the dir is gone (or was never made); else the dir removed, then forgotten, so a second call does nothing.
    const remove = text.slice(...balancedAfter(text, text.indexOf('removeStage(): void {'), '{', '}'))
    expect(remove.split('\n').map((l) => l.trim()).filter(Boolean)).toEqual([
      'if (this.stageDir === null) return',
      'rmSync(this.stageDir, { recursive: true, force: true })',
      'this.stageDir = null',
    ])
    // The file's removals: the failed pack's dir and the staged dir, nothing else.
    expect(callsOf(text, 'rmSync').map((at) => callArguments(text, at))).toEqual(['dir, { recursive: true, force: true }', 'this.stageDir, { recursive: true, force: true }'])
    // Its callers: buildImage's finally and runFull's cleanup, once each.
    const callers = runnerSources()
      .flatMap((p) => {
        const t = stripComments(readFileSync(p, 'utf-8'))
        return indicesOf(/\bremoveStage\(/g, t).map((at) => `${relative(CI_LIVE, p)}: ${t.slice(t.lastIndexOf('\n', at) + 1, t.indexOf('\n', at)).trim()}`)
      })
      .sort()
    expect(callers).toEqual(['main.ts: container.removeStage()', `${join('runtime', 'container-run.ts')}: removeStage(): void {`, `${join('runtime', 'container-run.ts')}: this.removeStage()`])
    // runFull's cleanup: in its try, on the line after the packed dir's removal.
    const main = code('main.ts')
    const runFull = main.slice(...balancedAfter(main, main.indexOf('async function runFull('), '{', '}'))
    const cleanup = runFull.slice(...balancedAfter(runFull, runFull.indexOf('const cleanup = (cause?: StopCause): Promise<void> =>'), '{', '}'))
    const cleanupTry = cleanup.slice(...balancedAfter(cleanup, cleanup.indexOf('try {'), '{', '}'))
    expect(cleanupTry).toMatch(/\n\s*if \(state\.packed\) rmSync\(state\.packed\.dir, \{ recursive: true, force: true \}\)\n\s*container\.removeStage\(\)\n/)
    // That cleanup is the run's only one, the one setActive hands the stop path (a signal's stopRun and the memory watchdog's abort run it).
    expect(indicesOf(/\bconst cleanup = /g, runFull).length).toBe(1)
    expect(objectProperties(runFull.slice(runFull.indexOf('{', runFull.indexOf('signals.setActive(')))).get('cleanup')).toBe('cleanup')
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
      `${join('browser', 'apps-list.flow.ts')} <- ./common.ts`,
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

// ---------------------------------------------------------------------------
// The /ci images (source audit of docker/ and the /ci and /ci-live skills)
// ---------------------------------------------------------------------------

const REPO = join(import.meta.dir, '..')
const BASE_DOCKERFILE = join('docker', 'Dockerfile.test.base')

function repoFile(rel: string): string {
  return readFileSync(join(REPO, rel), 'utf-8')
}

/** A Dockerfile's instructions: comment and blank lines dropped, continuation lines joined. */
function dockerInstructions(rel: string): string[] {
  return instructionsOf(repoFile(rel))
}

/** The instructions of a Dockerfile's (or script's) text, as {@link dockerInstructions} reads them. */
function instructionsOf(text: string): string[] {
  const out: string[] = []
  let current = ''
  for (const line of text.split('\n')) {
    const body = line.trim()
    if (body.startsWith('#') || body === '') continue
    if (body.endsWith('\\')) {
      current += `${body.slice(0, -1)} `
      continue
    }
    out.push(`${current}${body}`)
    current = ''
  }
  return out
}

/** The one RUN instruction holding `fragment`. */
function runWith(instructions: string[], fragment: string): string {
  const runs = instructions.filter((i) => i.startsWith('RUN ') && i.includes(fragment))
  expect(runs.length).toBe(1)
  return runs[0]!
}

function expand(value: string, vars: Map<string, string>): string {
  return value.replace(/\$\{(\w+)\}/g, (all, name: string) => vars.get(name) ?? all)
}

/** A RUN's plain assignments (`NAME=value;`, `NAME="value";`), each expanded over the ARG defaults and the assignments before it. */
function shellVars(run: string, args: Record<string, string>): Map<string, string> {
  const vars = new Map(Object.entries(args))
  for (const statement of run.split(';')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)=(?:"((?:[^"$]|\$\{\w+\})*)"|([\w./:-]+))\s*$/.exec(statement)
    if (m) vars.set(m[1]!, expand(m[2] ?? m[3]!, vars))
  }
  return vars
}

/** Where a RUN's `install -m <mode> <src>/<file> <target>` statement puts `file` (expanded), and where the statement is. */
function installTarget(run: string, file: string, vars: Map<string, string>): { at: number, target: string } {
  const m = new RegExp(`(?:^|;)\\s*install\\s+-m\\s+\\d+\\s+"?[^\\s";]*/${file.replace(/\./g, '\\.')}"?\\s+"?([^\\s";]+)"?\\s*(?:;|$)`).exec(run)
  expect(m).not.toBeNull()
  return { at: m!.index, target: expand(m![1]!, vars) }
}

/** `docker/Dockerfile.test.base`: its instructions, ARG defaults, bind mounts (context → target) and default PATH, whose first directory is the release candidate's binary directory. */
function baseImage() {
  const instructions = dockerInstructions(BASE_DOCKERFILE)
  const args = Object.fromEntries(instructions.flatMap((i) => {
    const m = /^ARG (\w+)=(\S+)$/.exec(i)
    return m ? [[m[1]!, m[2]!]] : []
  }))
  const mounts = new Map([...instructions.join('\n').matchAll(/--mount=type=bind,from=([\w-]+),target=(\S+)/g)].map((m) => [m[1]!, m[2]!]))
  const env = instructions.filter((i) => i.startsWith('ENV PATH='))
  expect(env.length).toBe(1)
  const path = env[0]!.slice('ENV PATH='.length).split(':')
  return { instructions, args, mounts, path, rcBinDir: path[0]! }
}

/**
 * The shell statements of `lines` (RUN instructions, or a script's joined
 * lines), split at `;`, `&&`, `||` and `|`, with every `echo "…"` string
 * emptied (an ERROR line naming a command does not run it) and redirections
 * dropped.
 */
function shellStatements(lines: string[]): string[] {
  return lines.flatMap((line) => line
    .replace(/\becho\s+"(?:[^"\\]|\\.)*"/g, 'echo ""')
    .split(/;|&&|\|\|?/)
    .map((s) => s.replace(/\s\d*>&?\s*[^\s;]+/g, '').trim())
    .filter((s) => s !== ''))
}

/** The statements of the `if` at `statements[at]` up to its own `fi`, each with its nesting depth (0: the if's own body). */
function ifBody(statements: string[], at: number): { depth: number, text: string }[] {
  const body: { depth: number, text: string }[] = []
  let depth = 0
  for (const statement of statements.slice(at + 1)) {
    if (statement === 'fi') {
      if (depth === 0) return body
      depth--
      continue
    }
    const text = statement.replace(/^(then|else)\s+/, '')
    if (/^if\s/.test(text)) depth++
    body.push({ depth, text })
  }
  throw new Error(`no fi closes ${statements[at]}`)
}

describe('the /ci images (source audit)', () => {
  const baseRepo = BASE_IMAGE.slice(0, BASE_IMAGE.indexOf(':'))

  test.each([
    join('docker', 'Dockerfile.test'),
    join('docker', 'Dockerfile.live'),
    BASE_DOCKERFILE,
    join('.claude', 'skills', 'ci', 'SKILL.md'),
    join('.claude', 'skills', 'ci-live', 'SKILL.md'),
  ])('every base-image tag %s names is BASE_IMAGE', (rel) => {
    const tags = [...repoFile(rel).matchAll(new RegExp(`${baseRepo}:[\\w-]+(?:\\.[\\w-]+)*`, 'g'))].map((m) => m[0])
    expect(tags.length).toBeGreaterThan(0)
    expect(tags.filter((tag) => tag !== BASE_IMAGE)).toEqual([])
  })

  test.each([join('docker', 'Dockerfile.test'), join('docker', 'Dockerfile.live')])('%s is built FROM BASE_IMAGE and nothing else', (rel) => {
    expect(dockerInstructions(rel).filter((i) => /^FROM\s/i.test(i))).toEqual([`FROM ${BASE_IMAGE}`])
  })

  test("the /ci skill's BASE_TAG is BASE_IMAGE, and it builds docker/Dockerfile.test.base under that tag", () => {
    const skill = repoFile(join('.claude', 'skills', 'ci', 'SKILL.md'))
    expect([...skill.matchAll(/^\s*BASE_TAG=(\S+)/gm)].map((m) => m[1])).toEqual([BASE_IMAGE])
    expect(skill).toContain('-f docker/Dockerfile.test.base -t "${BASE_TAG}" .')
  })

  test("the base reads one file from the repo context, the client-under-test check (no other COPY or ADD, so no package.json), and its one install is the global client from the release candidate's tarball (none from the registry); the 0.10.0 legs are packed at exact versions", () => {
    const { instructions, args } = baseImage()
    expect(instructions.filter((i) => /^(COPY|ADD)\s/i.test(i))).toEqual([`COPY --chmod=0755 ${RC_CLIENT_CHECK_SOURCE} ${RC_CLIENT_CHECK}`])
    expect(shellStatements(instructions).filter((s) => /\bnpm\s+(i|install|add)\b|\bbun\s+(add|install)\b|\s(-g|--global)\b/.test(s))).toEqual([
      'bun add -g --ignore-scripts "${RC_CLIENT_TGZ}"',
    ])
    expect([args.AD_PREV_VERSION, args.CSCB_PREV_VERSION].map((v) => /^\d+\.\d+\.\d+$/.test(v ?? ''))).toEqual([true, true])
    const pack = runWith(instructions, 'npm pack')
    expect([pack.includes('"agent-director@${AD_PREV_VERSION}"'), pack.includes('"claude-slack-channel-bots@${CSCB_PREV_VERSION}"')]).toEqual([true, true])
  })

  test('the base binds only the agent-director-rc and agent-director-install contexts, each with a fallback stage of its name', () => {
    const { instructions, mounts } = baseImage()
    expect([...mounts.keys()]).toEqual(['agent-director-rc', 'agent-director-install'])
    expect(instructions.filter((i) => /^FROM\s+\S+\s+AS\s+agent-director-(rc|install)$/i.test(i)).length).toBe(2)
  })

  test("the release candidate is read from its context and checked against SHA256SUMS and the pinned version and commit before its binary is installed, first on PATH in a directory of its own (not /usr/local/bin), which the build checks", () => {
    const { instructions, args, mounts, path, rcBinDir } = baseImage()
    const rc = runWith(instructions, 'from=agent-director-rc,')
    const vars = shellVars(rc, args)
    expect(vars.get('RC_CTX')).toBe(mounts.get('agent-director-rc')!)
    expect(rc).toContain('"${RC_CTX}/SHA256SUMS"')
    expect(args.AD_RC_VERSION).toMatch(/^\d+\.\d+\.\d+-rc\.\d+$/)
    expect(args.AD_RC_COMMIT).toMatch(/^[0-9a-f]{40}$/)
    const binary = installTarget(rc, 'agent-director-linux-amd64', vars)
    const checks = [rc.indexOf('sha256sum -c'), rc.indexOf('!= "${AD_RC_VERSION}"'), rc.indexOf('!= "${AD_RC_COMMIT}"')]
    expect(checks.map((at) => at >= 0 && at < binary.at)).toEqual([true, true, true])
    expect([rcBinDir === '/usr/local/bin', path.includes('/usr/local/bin')]).toEqual([false, true])
    expect(binary.target).toBe(join(rcBinDir, 'agent-director'))
    expect(instructions.filter((i) => i.includes('/usr/local/bin/agent-director'))).toEqual([])
    expect(rc.indexOf('command -v agent-director')).toBeGreaterThan(binary.at)
  })

  test('install.sh is read from its context and checked against the pinned SHA-256 before it is installed off PATH', () => {
    const { instructions, args, mounts, path } = baseImage()
    expect(args.AD_INSTALL_SH_SHA256).toMatch(/^[0-9a-f]{64}$/)
    const run = runWith(instructions, 'from=agent-director-install,')
    const vars = shellVars(run, args)
    expect(vars.get('INSTALL_CTX')).toBe(mounts.get('agent-director-install')!)
    expect(run).toContain('"${INSTALL_CTX}/install.sh"')
    const script = installTarget(run, 'install.sh', vars)
    const check = run.indexOf('!= "${AD_INSTALL_SH_SHA256}"')
    expect(check >= 0 && check < script.at).toBe(true)
    expect([script.target.startsWith('/'), path.includes(dirname(script.target))]).toEqual([true, false])
  })

  test("the /ci skill extracts install.sh at the commit it reads from the base's ARG AD_INSTALL_SH_COMMIT, and types no commit of its own", () => {
    const skill = repoFile(join('.claude', 'skills', 'ci', 'SKILL.md'))
    const { args } = baseImage()
    expect(args.AD_INSTALL_SH_COMMIT).toMatch(/^[0-9a-f]{40}$/)
    // What the skill's `sed -n 's/^ARG AD_INSTALL_SH_COMMIT=//p'` prints: that ARG's default, once.
    const sedOutput = repoFile(BASE_DOCKERFILE).split('\n').flatMap((l) => l.startsWith('ARG AD_INSTALL_SH_COMMIT=') ? [l.slice('ARG AD_INSTALL_SH_COMMIT='.length)] : [])
    expect(sedOutput).toEqual([args.AD_INSTALL_SH_COMMIT!])
    expect([...skill.matchAll(/^\s*AD_INSTALL_SH_COMMIT=(.*)$/gm)].map((m) => m[1])).toEqual([
      `"$(sed -n 's/^ARG AD_INSTALL_SH_COMMIT=//p' ${BASE_DOCKERFILE})"`,
    ])
    expect([...skill.matchAll(/\bgit -C "\$\{CSCB_AD_SRC_DIR\}" show "([^"]*)"/g)].map((m) => m[1])).toEqual([
      '${AD_INSTALL_SH_COMMIT}:skills/install-agent-director/install.sh',
    ])
    expect(skill.match(/\b[0-9a-f]{40}\b/g) ?? []).toEqual([])
  })

  test('the 0.10.0 binary is fetched for its pinned release into a directory off PATH', () => {
    const { instructions, args, path } = baseImage()
    const run = runWith(instructions, 'id=gh_token')
    const vars = shellVars(run, args)
    expect(vars.get('AD_TAG')).toBe(`v${args.AD_PREV_VERSION}`)
    expect(run).toContain('/releases/tags/${AD_TAG}"')
    const target = expand(/\s-o\s+"?([^\s";]+)"?/.exec(run)![1]!, vars)
    expect(target).toMatch(/^\/[^$]*\/agent-director$/)
    expect(path).not.toContain(dirname(target))
  })

  test('the base installs sqlite3 and file with apt and writes the marker /etc/cscb-ci-image', () => {
    const { instructions } = baseImage()
    const packages = instructions.flatMap((i) => [...i.matchAll(/apt-get install -y((?:\s+[a-z0-9][\w.+-]*)+)/g)].flatMap((m) => m[1]!.trim().split(/\s+/)))
    expect(['sqlite3', 'file'].filter((p) => !packages.includes(p))).toEqual([])
    expect(instructions.filter((i) => /^RUN\s.*>\s*\/etc\/cscb-ci-image(\s|$)/.test(i)).length).toBe(1)
  })

  test("Dockerfile.live copies the staged binary over the base's release-candidate binary and checks that it is the first agent-director on PATH", () => {
    const bin = join(baseImage().rcBinDir, 'agent-director')
    const live = dockerInstructions(join('docker', 'Dockerfile.live'))
    expect(live.filter((i) => i.startsWith('COPY --from=agent-director-bin '))).toEqual([`COPY --from=agent-director-bin agent-director ${bin}`])
    expect(runWith(live, 'command -v agent-director')).toContain(`if [ "$(command -v agent-director)" != ${bin} ]`)
    expect(live.filter((i) => i.includes('/usr/local/bin/agent-director'))).toEqual([])
  })

  test.each(['cscb-live-helpers.sh', 'cscb-live-preflight.sh', 'entrypoint.sh'])("docker/live/%s's PATH lines start with the base's release-candidate directory", (file) => {
    const { rcBinDir } = baseImage()
    const firsts = [...repoFile(join('docker', 'live', file)).matchAll(/^\s*export PATH="([^"]*)"/gm)].map((m) => m[1]!.split(':')[0])
    expect(firsts.length).toBeGreaterThan(0)
    expect(firsts.filter((dir) => dir !== rcBinDir)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The client under test (source audit of the base, Dockerfile.live and test-1)
// ---------------------------------------------------------------------------

const LIVE_DOCKERFILE = join('docker', 'Dockerfile.live')
const TEST_1 = join('tests', 'integration', 'test-1-install-startup.sh')

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The base's RUN that installs and checks its global client: the RUN, its position, its plain assignments and its statements. */
function baseGlobalClientRun() {
  const { instructions, args } = baseImage()
  const run = runWith(instructions, ' --client ')
  return { instructions, args, run, at: instructions.indexOf(run), vars: shellVars(run, args), statements: shellStatements([run]) }
}

describe('the client under test (source audit)', () => {
  test("the base copies the check from RC_CLIENT_CHECK_SOURCE to RC_CLIENT_CHECK, then installs its global client from the tarball path the release record holds and runs the check's --client on it", () => {
    const { instructions, args, run, at, vars, statements } = baseGlobalClientRun()
    const copy = instructions.indexOf(`COPY --chmod=0755 ${RC_CLIENT_CHECK_SOURCE} ${RC_CLIENT_CHECK}`)
    expect([copy >= 0, copy < at]).toEqual([true, true])
    expect(statSync(join(REPO, RC_CLIENT_CHECK_SOURCE)).isFile()).toBe(true)

    // The release record the release candidate's RUN writes holds the client tarball's fixed path.
    const rc = runWith(instructions, 'from=agent-director-rc,')
    const rcVars = shellVars(rc, args)
    const record = expand(/>\s*"?([^\s";]*\/release\.json)"?/.exec(rc)![1]!, rcVars)
    expect(rc).toContain('--arg client_tarball "${RC_CLIENT_TGZ}"')
    expect(rcVars.get('RC_CLIENT_TGZ')).toMatch(/^\/[^$]*\.tgz$/)
    expect(instructions.indexOf(rc)).toBeLessThan(at)

    // The global client: read from that record, installed from that path, then checked under set -e.
    expect(run).toMatch(/^RUN set -[a-z]*e[a-z]*;/)
    expect(/(?:^|;)\s*RC_CLIENT_TGZ=\$\(jq -er '\.client_tarball \| strings' (\S+)\)/.exec(run)?.[1]).toBe(record)
    expect(vars.get('RC_CHECK')).toBe(RC_CLIENT_CHECK)
    expect(vars.get('GLOBAL_CLIENT')).toBe('/root/.bun/install/global/node_modules/agent-director')
    const install = statements.indexOf('bun add -g --ignore-scripts "${RC_CLIENT_TGZ}"')
    const check = statements.indexOf('"${RC_CHECK}" --client "${GLOBAL_CLIENT}"')
    expect([install >= 0, check > install]).toEqual([true, true])
  })

  test("Dockerfile.live copies no package.json, installs no agent-director (its one package install is Claude Code's), and after staging its binary runs RC_CLIENT_CHECK --client on the base's global client, stopping the build when it fails", () => {
    const live = dockerInstructions(LIVE_DOCKERFILE)
    expect(live.filter((i) => i.includes('package.json'))).toEqual([])
    expect(shellStatements(live).filter((s) => /\b(npm|npx|bunx?|pnpm|yarn)\s/.test(s) || s.includes('agent-director@'))).toEqual([
      'npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"',
    ])

    const run = runWith(live, 'command -v agent-director')
    expect(live.indexOf(run)).toBeGreaterThan(live.findIndex((i) => i.startsWith('COPY --from=agent-director-bin ')))
    const statements = shellStatements([run])
    const checkRe = new RegExp(`^if ! "?${escapeRegExp(RC_CLIENT_CHECK)}"? --client "?([^\\s"]+)"?$`)
    const checks = statements.flatMap((s, i) => checkRe.test(s) ? [i] : [])
    expect(checks.length).toBe(1)
    expect(checkRe.exec(statements[checks[0]!]!)![1]).toBe(baseGlobalClientRun().vars.get('GLOBAL_CLIENT')!)
    expect(checks[0]!).toBeGreaterThan(statements.findIndex((s) => s.includes('command -v agent-director')))
    expect(ifBody(statements, checks[0]!).filter((s) => s.depth === 0).at(-1)?.text).toBe('exit 1')
  })

  test("Dockerfile.live's failed-check line names --agent-director-binary only for the check's step 3 (binary), routing each ERROR line the check can print", () => {
    const run = runWith(dockerInstructions(LIVE_DOCKERFILE), 'command -v agent-director')
    const echoed = '"((?:[^"\\\\]|\\\\.)*)"'
    const routes = [...run.matchAll(new RegExp(`\\b(?:if|elif)\\s+grep\\s+-qE\\s+'([^']*)'\\s+\\S+;\\s*then\\s+echo\\s+${echoed}`, 'g'))].map((m) => ({ re: new RegExp(m[1]!), text: m[2]! }))
    const fallback = new RegExp(`\\belse\\s+echo\\s+${echoed}`).exec(run)?.[1]
    expect(routes.length).toBeGreaterThan(0)
    expect(fallback).toBeDefined()
    const lineFor = (error: string) => routes.find((r) => r.re.test(error))?.text ?? fallback!

    // Every step the check fails at, in the check's own ERROR shape, plus its usage and refusal lines.
    const script = repoFile(RC_CLIENT_CHECK_SOURCE).split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')
    const steps = [...new Set([...script.matchAll(/\bfail (?:'([^']+)'|(\w+))\s/g)].map((m) => m[1] ?? m[2]!))]
    expect(steps).toContain('3 (binary)')
    expect(steps).toContain('4 (floor)')
    const errors = [
      ...steps.map((step) => `ERROR: rc-client check ${step}: what differs`),
      'ERROR: rc-client-check.sh: /etc/cscb-ci-image is absent: this check runs only in a cscb-ci image (it runs agent-director); refusing to run',
      'ERROR: rc-client-check.sh: unknown mode --x (usage: rc-client-check.sh --package <dir> | --client <dir>)',
    ]
    expect(errors.filter((e) => lineFor(e).includes('--agent-director-binary'))).toEqual(['ERROR: rc-client check 3 (binary): what differs'])
  })

  test("test-1 runs RC_CLIENT_CHECK --package on the package it installed into /test-repo, directly after the install, and fails the test when the check fails", () => {
    const lines = dockerInstructions(TEST_1)
    const install = lines.findIndex((l) => /^bun install \/tmp\/package\.tgz\s/.test(l))
    expect(install).toBeGreaterThan(0)
    const repoDir = lines.slice(0, install).flatMap((l) => /^cd (\/\S+)$/.exec(l)?.[1] ?? []).at(-1)
    expect(repoDir).toBe('/test-repo')

    // Directly after: plain assignments only, then the check.
    const vars = new Map<string, string>()
    let at = install + 1
    for (let m; (m = /^([A-Z_][A-Z0-9_]*)=([^\s$"'`;()]+)$/.exec(lines[at] ?? '')); at++) vars.set(m[1]!, m[2]!)
    const call = /^if ! (?:\w+=\$\()?"?([^\s"]+)"? --package "?([^\s")]+)"?[\s)]/.exec(lines[at]!)
    expect(call).not.toBeNull()
    expect(expand(call![1]!, vars)).toBe(RC_CLIENT_CHECK)
    const pkgName = JSON.parse(repoFile('package.json')).name as string
    expect(expand(call![2]!, vars)).toBe(join(repoDir!, 'node_modules', pkgName))
    expect(lines[at]).toMatch(/; then$/)

    // A failed check fails the test.
    const fi = lines.indexOf('fi', at)
    expect(lines.slice(at + 1, fi).filter((l) => /^fail\s/.test(l)).length).toBe(1)
  })

  test("test-1 runs the Phase 1 class-check fixture with bun on the same installed package directly after the RC_CLIENT_CHECK --package check and before its other steps, and fails the test with the fixture's first FAIL line when it fails", () => {
    const lines = dockerInstructions(TEST_1)
    const helper = lines.findIndex((l) => /^if ! /.test(l) && l.includes(' --package '))
    expect(helper).toBeGreaterThan(0)
    const helperFi = lines.indexOf('fi', helper)
    const helperPkg = /\s--package "?([^\s")]+)"?/.exec(lines[helper]!)![1]!

    // Exactly one run of the fixture, on the package the check swapped the client into.
    const runRe = /^if ! (?:\w+=\$\()?CSCB_PKG_DIR="?([^\s"]+)"? bun "?([^\s")]+)"? 2>(\S+)\); then$/
    const runs = lines.flatMap((l, i) => runRe.test(l) ? [i] : [])
    expect(runs.length).toBe(1)
    const at = runs[0]!
    const [, pkgDir, fixture, errFile] = runRe.exec(lines[at]!)!
    expect(pkgDir).toBe(helperPkg)

    // The fixture path resolves, beside test-1, to the fixture file.
    expect(lines).toContain('FIXTURES="$(realpath "$(dirname "$0")")/fixtures"')
    const vars = new Map([['FIXTURES', join(REPO, dirname(TEST_1), 'fixtures')]])
    for (const line of lines.slice(0, at)) {
      const m = /^([A-Z_][A-Z0-9_]*)="?((?:[^"$`()\\]|\$\{\w+\})*)"?$/.exec(line)
      if (m && m[1] !== 'FIXTURES') vars.set(m[1]!, expand(m[2]!, vars))
    }
    const fixturePath = join(REPO, 'tests', 'integration', 'fixtures', 'phase1-client-check.ts')
    expect(expand(fixture!, vars)).toBe(fixturePath)
    expect(statSync(fixturePath).isFile()).toBe(true)

    // Order: the check, then only its output, the fixture's path and its existence check, then the fixture, then test-1's other steps.
    expect(at).toBeGreaterThan(helperFi)
    expect(lines.slice(helperFi + 1, at).filter((l) => !/^(echo\s|[A-Z_][A-Z0-9_]*=|test -f\s)/.test(l))).toEqual([])
    expect(at).toBeLessThan(lines.findIndex((l) => l.includes('"${CLI}"')))

    // A failed fixture fails the test, its reason the fixture's first FAIL line, read from the file its stderr goes to.
    const fi = lines.indexOf('fi', at)
    const body = lines.slice(at + 1, fi)
    expect(body.filter((l) => /^fail\s/.test(l)).length).toBe(1)
    expect(body.filter((l) => l.includes(`grep -m 1 '^FAIL: ' ${errFile}`)).length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Dockerfile.live's Claude Code pin (against MIN_CLAUDE_CODE_VERSION)
// ---------------------------------------------------------------------------

/** The build-arg that pins Dockerfile.live's Claude Code. */
const CLAUDE_CODE_ARG = 'CLAUDE_CODE_VERSION'

/** The one Claude Code install Dockerfile.live may run: the pinned build-arg's version. */
const PINNED_CLAUDE_CODE_INSTALL = `npm install -g "@anthropic-ai/claude-code@\${${CLAUDE_CODE_ARG}}"`

/** A plain major.minor.patch release's parts as numbers, or null. */
function releaseParts(version: string): [number, number, number] | null {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** Whether plain release `version` is at or above plain release `min`, part by part as numbers (never as strings). */
function releaseAtLeast(version: string, min: string): boolean {
  const [v, floor] = [releaseParts(version), releaseParts(min)]
  if (v === null || floor === null) throw new Error(`not a plain major.minor.patch release: ${JSON.stringify(v === null ? version : min)}`)
  for (let i = 0; i < 3; i++) if (v[i] !== floor[i]) return v[i]! > floor[i]!
  return true
}

/**
 * What is wrong with a Dockerfile text's Claude Code pin against `min`: empty
 * when it declares `ARG CLAUDE_CODE_VERSION=<release>` once (and assigns the
 * build-arg nowhere else), the release is plain major.minor.patch and at or
 * above `min`, and its only Claude Code install is {@link PINNED_CLAUDE_CODE_INSTALL}.
 */
function claudeCodePinProblems(text: string, min: string): string[] {
  const problems: string[] = []
  const instructions = instructionsOf(text)
  const isDeclaration = (i: string): boolean => new RegExp(`^ARG\\s+${CLAUDE_CODE_ARG}(?:[=\\s]|$)`).test(i)
  const declarations = instructions.filter(isDeclaration)
  const overrides = instructions.filter((i) => !isDeclaration(i) && new RegExp(`\\b${CLAUDE_CODE_ARG}=`).test(i))
  if (declarations.length !== 1) problems.push(`${declarations.length} ARG ${CLAUDE_CODE_ARG} declarations, not one`)
  else if (overrides.length > 0) problems.push(`${CLAUDE_CODE_ARG} is assigned outside its ARG: ${JSON.stringify(overrides.map((i) => i.slice(0, 80)))}`)
  else {
    const value = new RegExp(`^ARG\\s+${CLAUDE_CODE_ARG}=(\\S+)$`).exec(declarations[0]!)?.[1]
    if (value === undefined || releaseParts(value) === null) problems.push(`${declarations[0]} declares no plain major.minor.patch release`)
    else if (!releaseAtLeast(value, min)) problems.push(`${CLAUDE_CODE_ARG} ${value} is below ${min}`)
  }
  const installs = shellStatements(instructions.filter((i) => i.startsWith('RUN ')))
    .filter((s) => /claude-code|claude\.ai\/install|\bclaude\s+(?:install|update)\b/.test(s))
  if (installs.length !== 1 || installs[0] !== PINNED_CLAUDE_CODE_INSTALL) problems.push(`Claude Code installs ${JSON.stringify(installs)}, not only ${PINNED_CLAUDE_CODE_INSTALL}`)
  return problems
}

/** `version` one patch below, derived from it. */
function onePatchBelow(version: string): string {
  const parts = releaseParts(version)
  if (parts === null || parts[2] === 0) throw new Error(`${JSON.stringify(version)} has no release one patch below it`)
  return `${parts[0]}.${parts[1]}.${parts[2] - 1}`
}

describe("Dockerfile.live's Claude Code pin", () => {
  const MIN = MIN_CLAUDE_CODE_VERSION
  const live = (): string => repoFile(LIVE_DOCKERFILE)
  /** The value of Dockerfile.live's one ARG CLAUDE_CODE_VERSION declaration. */
  const pinnedValue = (): string => {
    const values = [...live().matchAll(new RegExp(`^ARG ${CLAUDE_CODE_ARG}=(\\S+)$`, 'gm'))].map((m) => m[1]!)
    expect(values.length).toBe(1)
    return values[0]!
  }
  /** Dockerfile.live's text with its declaration's value replaced by `value`. */
  const withPin = (value: string): string => live().replace(`ARG ${CLAUDE_CODE_ARG}=${pinnedValue()}`, `ARG ${CLAUDE_CODE_ARG}=${value}`)

  test('Dockerfile.live declares CLAUDE_CODE_VERSION once, a plain release at or above MIN_CLAUDE_CODE_VERSION, and installs Claude Code only at it; a pin one patch below MIN_CLAUDE_CODE_VERSION is refused', () => {
    expect(releaseParts(MIN)).not.toBeNull()
    expect(claudeCodePinProblems(live(), MIN)).toEqual([])

    // Negative control: one patch below the constant, derived from it, is refused, by the comparison and as Dockerfile.live's pin.
    const below = onePatchBelow(MIN)
    expect(releaseAtLeast(below, MIN)).toBe(false)
    expect(claudeCodePinProblems(withPin(below), MIN)).toEqual([`${CLAUDE_CODE_ARG} ${below} is below ${MIN}`])
  })

  test('the comparison is numeric, part by part, never string order', () => {
    const [major, minor, patch] = releaseParts(MIN)!
    // A patch with more digits: above MIN as numbers, below it as strings.
    const longerPatch = `${major}.${minor}.${10 ** String(patch).length}`
    expect(longerPatch < MIN).toBe(true)
    expect(releaseAtLeast(longerPatch, MIN)).toBe(true)
    expect(claudeCodePinProblems(withPin(longerPatch), MIN)).toEqual([])
    expect(releaseAtLeast(MIN, longerPatch)).toBe(false)
    expect(releaseAtLeast(MIN, MIN)).toBe(true)
    expect(releaseAtLeast(`${major}.${minor + 1}.0`, MIN)).toBe(true)
    expect(releaseAtLeast(`${major + 1}.0.0`, MIN)).toBe(true)
    expect(releaseAtLeast(`${major - 1}.${minor + 1}.${patch + 1}`, MIN)).toBe(false)
  })

  test.each([
    ['no declaration', (text: string) => text.replace(new RegExp(`^ARG ${CLAUDE_CODE_ARG}=\\S+\\n`, 'm'), ''), '0 ARG CLAUDE_CODE_VERSION declarations, not one'],
    ['a declaration with no value', (text: string) => text.replace(new RegExp(`^ARG ${CLAUDE_CODE_ARG}=\\S+$`, 'm'), `ARG ${CLAUDE_CODE_ARG}`), `ARG ${CLAUDE_CODE_ARG} declares no plain major.minor.patch release`],
    ['"latest"', (text: string) => text.replace(new RegExp(`^ARG ${CLAUDE_CODE_ARG}=\\S+$`, 'm'), `ARG ${CLAUDE_CODE_ARG}=latest`), `ARG ${CLAUDE_CODE_ARG}=latest declares no plain major.minor.patch release`],
    ['a pre-release value', (text: string) => text.replace(new RegExp(`^(ARG ${CLAUDE_CODE_ARG}=\\S+)$`, 'm'), '$1-beta.1'), 'declares no plain major.minor.patch release'],
    ['two declarations', (text: string) => text.replace(new RegExp(`^(ARG ${CLAUDE_CODE_ARG}=\\S+)$`, 'm'), '$1\n$1'), '2 ARG CLAUDE_CODE_VERSION declarations, not one'],
    ['an override inside the RUN', (text: string) => text.replace(PINNED_CLAUDE_CODE_INSTALL, `${CLAUDE_CODE_ARG}=latest; ${PINNED_CLAUDE_CODE_INSTALL}`), 'CLAUDE_CODE_VERSION is assigned outside its ARG'],
    ['an unpinned install', (text: string) => text.replace(PINNED_CLAUDE_CODE_INSTALL, 'npm install -g @anthropic-ai/claude-code'), 'Claude Code installs ["npm install -g @anthropic-ai/claude-code"]'],
    ['a "latest" install', (text: string) => text.replace(PINNED_CLAUDE_CODE_INSTALL, 'npm install -g "@anthropic-ai/claude-code@latest"'), 'Claude Code installs ["npm install -g \\"@anthropic-ai/claude-code@latest\\""]'],
    ['a second, unpinned install', (text: string) => text.replace(PINNED_CLAUDE_CODE_INSTALL, `${PINNED_CLAUDE_CODE_INSTALL}; claude update`), 'Claude Code installs ['],
    ['no install', (text: string) => text.replace(`${PINNED_CLAUDE_CODE_INSTALL}; \\`, '\\'), 'Claude Code installs [], not only'],
  ])('a pin with %s is refused, never skipped', (_name, mutate, problem) => {
    const mutated = mutate(live())
    expect(mutated).not.toBe(live())
    const problems = claudeCodePinProblems(mutated, MIN)
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain(problem)
  })
})

// ---------------------------------------------------------------------------
// The staged binary's failure texts: the live image build's message, and no host-upgrade advice
// ---------------------------------------------------------------------------

/** Dockerfile.live's RUN that stages and checks the binary. */
const liveCheckRun = (): string => runWith(dockerInstructions(LIVE_DOCKERFILE), 'command -v agent-director')

/** Every `echo "…"` text in `run`, as written. */
const echoedTexts = (run: string): string[] => [...run.matchAll(/\becho\s+"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!)

/** The ERROR lines Dockerfile.live's RUN prints, each as the shell prints it (`$(command -v agent-director)` filled in). */
function liveErrorLines(): string[] {
  return echoedTexts(liveCheckRun())
    .filter((t) => t.startsWith('ERROR: '))
    .map((t) => t.replace(/\$\(command -v agent-director\)/g, '/usr/local/bin/agent-director'))
}

/**
 * A failed `docker build`'s stderr as BuildKit's plain progress prints it: the
 * RUN step's own output lines (`#9 <time> …`), then docker's own lines, which
 * quote the RUN's whole text (every routed ERROR text in it), the Dockerfile
 * excerpt and the final `failed to solve` line (`final`: the older form, or
 * DOCKER_29_FINAL, the form docker 29 prints).
 */
function failedBuildStderr(own: string[], final = 'ERROR: failed to solve: '): string {
  const run = liveCheckRun()
  const quoted = `/bin/sh -c ${run.slice('RUN '.length)}`.replace(/"/g, '\\"')
  return [
    `#9 [4/4] ${run}`,
    '#9 0.051 + chmod 0755 /opt/agent-director-rc/bin/agent-director',
    ...own.map((line, i) => `#9 0.${120 + i} ${line}`),
    `#9 ERROR: process "${quoted}" did not complete successfully: exit code: 1`,
    '------',
    ...own.map((line) => ` > 0.120 ${line}`),
    '------',
    ...repoFile(LIVE_DOCKERFILE).split('\n').map((line, i) => `  ${i + 1} | >>> ${line}`),
    `${final}process "${quoted}" did not complete successfully: exit code: 1`,
  ].join('\n')
}

/** The start of docker 29's own final line for a failed build (docker 29.7.2's plain progress). */
const DOCKER_29_FINAL = 'ERROR: failed to build: failed to solve: '

/** Why `text` advises upgrading or installing the host's agent-director, or null. */
function upgradeAdvice(text: string): string | null {
  if (/upgrad/i.test(text)) return 'an upgrade'
  if (/install-agent-director/i.test(text)) return 'the install-agent-director skill'
  if (/agent-director/i.test(text) && /\binstall|\bnpm\b|\bupdat/i.test(text)) return 'an install or update of agent-director'
  return null
}

describe("the staged binary's failure texts", () => {
  const OPTION = AGENT_DIRECTOR_BINARY_OPTION
  const NO_ADVICE = /\bnpm\b|host agent-director|install|upgrad/i

  // Each row: a fragment of one ERROR line Dockerfile.live echoes, the rc-client check line printed before it (if any), and the runner's message.
  const ROUTES: [string, string[], string][] = [
    [
      'is not the release candidate',
      ['ERROR: rc-client check 3 (binary): the binary reports 0.10.0, not 0.11.0-rc.1'],
      `the staged agent-director binary is not the release candidate this image's agent-director client is checked against: give the release candidate's binary with ${OPTION} <path>`,
    ],
    [
      'do not pair',
      ['ERROR: rc-client check 4 (floor): the binary is below the client floor'],
      "the release candidate's agent-director binary and client do not pair: the release candidate pinned in docker/Dockerfile.test.base is not usable as is",
    ],
    [
      'predates this tree',
      ['ERROR: rc-client-check.sh: /etc/cscb-ci-image is absent: this check runs only in a cscb-ci image (it runs agent-director); refusing to run'],
      `the base image ${BASE_IMAGE} predates this tree's docker/Dockerfile.test.base or docker/rc-client-check.sh: bump the base image version (docker/README.md)`,
    ],
    ['agent-director on PATH is', [], "the staged agent-director binary is not the first agent-director on the image's PATH"],
  ]

  test('every ERROR line Dockerfile.live echoes has exactly one route', () => {
    const lines = liveErrorLines()
    expect(lines.length).toBe(ROUTES.length)
    expect(lines.map((line) => ROUTES.filter(([fragment]) => line.includes(fragment)).length)).toEqual(lines.map(() => 1))
  })

  test.each(ROUTES)("Dockerfile.live's line holding %p is the build's reason, read from its own ERROR lines only", (fragment, checkLines, message) => {
    const routed = liveErrorLines().filter((line) => line.includes(fragment))
    expect(routed.length).toBe(1)
    const stderr = failedBuildStderr([...checkLines, routed[0]!])
    expect(liveBuildErrorLines(stderr)).toEqual([...checkLines, routed[0]!])
    expect(liveBuildFailureMessage(1, stderr)).toBe(`docker build of the live image failed (exit 1): ${message} (see run.log)`)
    expect(message).not.toMatch(NO_ADVICE)
  })

  test("a build that fails elsewhere gets no reason, though docker's own lines and the Dockerfile excerpt quote every routed ERROR text", () => {
    const stderr = failedBuildStderr([])
    for (const [fragment] of ROUTES) expect([fragment, stderr.split(fragment).length - 1 >= 3]).toEqual([fragment, true])
    expect(liveBuildErrorLines(stderr)).toEqual([])
    expect(liveBuildFailureMessage(17, stderr)).toBe('docker build of the live image failed (exit 17)')
    // An rc-client check line alone, with no Dockerfile.live line after it, names no reason either.
    expect(liveBuildFailureMessage(1, failedBuildStderr(['ERROR: rc-client check 3 (binary): the binary reports 0.10.0']))).toBe('docker build of the live image failed (exit 1)')
  })

  test("docker 29's final `ERROR: failed to build: failed to solve:` line is docker's own, never one of the build's ERROR lines", () => {
    const [fragment, checkLines, message] = ROUTES[0]!
    const routed = liveErrorLines().filter((line) => line.includes(fragment))
    const failed = failedBuildStderr([...checkLines, routed[0]!], DOCKER_29_FINAL)
    expect(liveBuildErrorLines(failed)).toEqual([...checkLines, routed[0]!])
    expect(liveBuildFailureMessage(1, failed)).toBe(`docker build of the live image failed (exit 1): ${message} (see run.log)`)
    const elsewhere = failedBuildStderr([], DOCKER_29_FINAL)
    expect(liveBuildErrorLines(elsewhere)).toEqual([])
    expect(liveBuildFailureMessage(17, elsewhere)).toBe('docker build of the live image failed (exit 17)')
  })

  test("no failure text in the runner (container-run.ts, main.ts, ci-live/lib/) or Dockerfile.live's ERROR lines advises upgrading or installing the host's agent-director, or names the install-agent-director skill", () => {
    const LITERAL = /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g
    const files = [join('runtime', 'container-run.ts'), 'main.ts', ...readdirSync(join(CI_LIVE, 'lib')).filter((f) => f.endsWith('.ts')).map((f) => join('lib', f))]
    const findings: string[] = []
    for (const rel of files) {
      const text = code(rel)
      // Each string or template literal, and each error's whole argument (a message built from several literals).
      const units = [...text.matchAll(LITERAL)].map((m) => m[0]).concat(indicesOf(/\bnew \w*Error\(/g, text).map((at) => callArguments(text, at)))
      for (const unit of units) {
        const why = upgradeAdvice(unit)
        if (why) findings.push(`${rel}: ${why}: ${unit.slice(0, 120)}`)
      }
    }
    const errorLines = echoedTexts(liveCheckRun()).filter((t) => t.startsWith('ERROR: '))
    expect(errorLines.length).toBe(ROUTES.length)
    for (const line of errorLines) {
      const why = upgradeAdvice(line)
      if (why) findings.push(`${LIVE_DOCKERFILE}: ${why}: ${line.slice(0, 120)}`)
    }
    expect(findings).toEqual([])
  })
})
