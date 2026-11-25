import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseAdPins, checkLatestAd, compareBaseAdRecord, formatAdCheckError, adCredentialFailureReason, type AdCredentialProvider, type AdFetch, type AdLatestClock, type AdCheckError, type AdBaseRecordRead } from './lib/ad-latest.ts'
import { lookUpBaseBuildToken, type SpawnFn, type ChildEnvironmentSource } from './ci-run.ts'
export type { AdBaseRecordRead } from './lib/ad-latest.ts'
export interface AdLatestCliDeps {
  readonly worktreeRoot: string
  readonly fetchAd: AdFetch
  readonly clock: AdLatestClock
  /** Tests may supply a provider directly or exercise the host lookup with spawn/env. */
  readonly getGitHubCredential?: AdCredentialProvider
  readonly spawn?: SpawnFn
  readonly env?: ChildEnvironmentSource
  readText(path: string): string
  readBaseRecord(image: string): Promise<AdBaseRecordRead>
  writeStdout(text: string): void
  writeStderr(text: string): void
}
export const AD_LATEST_CHECK_EXIT = 16
export const AD_LATEST_CHECK_SR = 'SR-2.8 (latest agent-director)'
export function adLatestFailureLine(error: AdCheckError): string {
  const recovery = adCredentialFailureReason(error.code) ?? 'update and commit pins or restore lookup access, rebuild the base when appropriate, and rerun the entire /ci/prepare path'
  return `${AD_LATEST_CHECK_SR}: ${formatAdCheckError(error)}; ${recovery}`
}
export async function runAdLatestCheck(deps: AdLatestCliDeps): Promise<0 | 16> {
  const fail = (error: AdCheckError): 16 => { deps.writeStderr(adLatestFailureLine(error) + '\n'); return AD_LATEST_CHECK_EXIT }
  let sources
  try { sources = { dockerfile: deps.readText(join(deps.worktreeRoot, 'docker/Dockerfile.test.base')), packageJson: deps.readText(join(deps.worktreeRoot, 'package.json')), lockfile: deps.readText(join(deps.worktreeRoot, 'bun.lock')) } }
  catch { return fail({ code: 'PINS_UNREADABLE', source: 'pins' }) }
  const pins = parseAdPins(sources)
  if (!pins.ok) return fail(pins.error)
  const { spawn, env } = deps
  const getGitHubCredential = deps.getGitHubCredential ?? (spawn && env
    ? (remainingMs: number) => lookUpBaseBuildToken(spawn, env, deps.worktreeRoot, { timeoutMs: remainingMs, clock: deps.clock })
    : undefined)
  const latest = await checkLatestAd(pins.value, { fetchAd: deps.fetchAd, clock: deps.clock, getGitHubCredential })
  if (!latest.ok) return fail(latest.error)
  try {
    const image = /^FROM\s+(cscb-ci-base:v[0-9]+)\s*$/m.exec(deps.readText(join(deps.worktreeRoot, 'docker/Dockerfile.test')))?.[1]
    if (!image) return fail({ code: 'BASE_RECORD_READ_FAILED', source: 'base' })
    const read = await deps.readBaseRecord(image)
    if (!read.ok) return fail(read.error)
    const compared = compareBaseAdRecord(pins.value, read.bytes)
    if (!compared.ok) return fail(compared.error)
  } catch { return fail({ code: 'BASE_RECORD_READ_FAILED', source: 'base' }) }
  deps.writeStdout('Latest released agent-director and base identity verified\n')
  return 0
}
if (import.meta.main) {
  const { createRealRunnerDeps, inspectImage, childEnvironment } = await import('./ci-run.ts')
  const real = createRealRunnerDeps()
  process.exit(await runAdLatestCheck({ ...real,
    worktreeRoot: resolve(import.meta.dir, '..'),
    readText: path => readFileSync(path, 'utf8'),
    readBaseRecord: async image => {
      const found = await inspectImage({ spawn: real.spawn, env: childEnvironment(real.env), cwd: real.worktreeRoot }, image)
      return found.ok && found.value ? real.readAdBaseRecord(found.value.id) : { ok: false, error: { code: 'BASE_RECORD_READ_FAILED', source: 'base' } }
    },
    writeStdout: text => process.stdout.write(text),
  }))
}
