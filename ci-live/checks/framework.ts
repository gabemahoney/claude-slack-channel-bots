/**
 * framework.ts — the check list's shape and the runner that walks it.
 *
 * A check is an object in the plan's run order: `{id, title, needs, run}`
 * plus flags. The runner decides, per check, whether it runs:
 * - a fixed `skip` reason (manual-only or optional checks) → SKIPPED;
 * - a failed `blocking` check earlier → SKIPPED (blocked by <id>), except
 *   for `always` checks (the host check);
 * - `--only` given and the check neither selected, a `prerequisite` nor
 *   `always` → SKIPPED (not selected);
 * - a need the run lacks → SKIPPED with the need's reason (a dry run has no
 *   workspace; a run with no second account skips Checks 14, 16 and 20), or
 *   the reason the runner gives for it (a second account that needs a
 *   sign-in code).
 * A check that throws is a FAIL with the error's description. Evidence is
 * message timestamps, conversation IDs and redacted log lines, never a token.
 *
 * Pure apart from the injected clock and log.
 */

import { describeError } from '../lib/errors.ts'

export type CheckStatus = 'PASS' | 'FAIL' | 'SKIPPED'
export type Need = 'workspace' | 'claude' | 'second-user'

export interface CheckResult {
  status: CheckStatus
  reason?: string
  evidence: string[]
  notes?: string[]
}

export interface CheckDef<Ctx> {
  id: string
  title: string
  needs: Need[]
  /** The testplan Results-table column this check fills; `null` for a gesture that is not a check row. */
  row: string | null
  /** A fixed reason to skip (manual-only or optional). */
  skip?: string
  /** A FAIL skips every later check (except `always` ones). */
  blocking?: boolean
  /** Runs even when an earlier blocking check failed, and under `--only`. */
  always?: boolean
  /** Runs under `--only` even when not selected (a later check needs its state). */
  prerequisite?: boolean
  run(ctx: Ctx): Promise<CheckResult>
}

export interface RecordedResult extends CheckResult {
  id: string
  title: string
  row: string | null
  durationMs: number
}

export const NEED_SKIP_REASONS: Record<Need, string> = {
  workspace: 'no workspace secrets',
  claude: 'no Claude credentials',
  'second-user': 'no second account',
}

export interface RunChecksOptions {
  available: ReadonlySet<Need>
  only: readonly string[]
  now: () => number
  log: { info(message: string): void }
  /** Called after each result is recorded (the runner keeps the results so far for an interrupted run). */
  onResult?: (result: RecordedResult) => void
  /**
   * A skip reason for a missing need in place of `NEED_SKIP_REASONS` (the
   * second account is configured but needs a sign-in code).
   */
  needReasons?: Partial<Record<Need, string>>
}

export function pass(evidence: string[], notes?: string[]): CheckResult {
  return { status: 'PASS', evidence, notes }
}

export function fail(reason: string, evidence: string[], notes?: string[]): CheckResult {
  return { status: 'FAIL', reason, evidence, notes }
}

export function skipped(reason: string, evidence: string[] = []): CheckResult {
  return { status: 'SKIPPED', reason, evidence }
}

/** Why a check is skipped before it runs, or `null` when it runs. */
export function skipReason<Ctx>(
  check: CheckDef<Ctx>,
  state: { blockedBy: string | null },
  options: Pick<RunChecksOptions, 'available' | 'only' | 'needReasons'>,
): string | null {
  if (check.skip) return check.skip
  if (state.blockedBy !== null && !check.always) return `blocked by ${state.blockedBy}`
  if (options.only.length > 0 && !options.only.includes(check.id) && !check.prerequisite && !check.always) {
    return 'not selected'
  }
  const missing = check.needs.find((need) => !options.available.has(need))
  return missing ? (options.needReasons?.[missing] ?? NEED_SKIP_REASONS[missing]) : null
}

export async function runChecks<Ctx>(
  checks: readonly CheckDef<Ctx>[],
  ctx: Ctx,
  options: RunChecksOptions,
): Promise<RecordedResult[]> {
  const results: RecordedResult[] = []
  const state = { blockedBy: null as string | null }
  for (const check of checks) {
    const started = options.now()
    let result: CheckResult
    const reason = skipReason(check, state, options)
    if (reason !== null) {
      result = skipped(reason)
    } else {
      options.log.info(`check ${check.id}: ${check.title}`)
      try {
        result = await check.run(ctx)
      } catch (err) {
        result = fail(`threw ${describeError(err)}`, [])
      }
      if (result.status === 'FAIL' && check.blocking) state.blockedBy = check.id
    }
    const recorded: RecordedResult = {
      id: check.id,
      title: check.title,
      row: check.row,
      durationMs: options.now() - started,
      ...result,
    }
    options.log.info(`check ${check.id}: ${recorded.status}${recorded.reason ? ` (${recorded.reason})` : ''}`)
    results.push(recorded)
    options.onResult?.(recorded)
  }
  return results
}

/** `PASS` iff every result is PASS or SKIPPED; else `FAIL: <check>: <reason>` for the first FAIL. */
export function verdictOf(results: readonly Pick<RecordedResult, 'id' | 'status' | 'reason'>[]): string {
  const failed = results.find((r) => r.status === 'FAIL')
  if (!failed) return 'PASS'
  return `FAIL: ${failed.id}: ${(failed.reason ?? 'failed').replace(/\s*\n\s*/g, ' ')}`
}

/**
 * Collects a check's findings: `expect` records a failed expectation (the
 * first one becomes the reason), `evidence` and `note` add lines.
 */
export class Findings {
  readonly evidence: string[] = []
  readonly notes: string[] = []
  readonly failures: string[] = []

  expect(ok: boolean, failure: string): boolean {
    if (!ok) this.failures.push(failure)
    return ok
  }

  add(line: string): void {
    this.evidence.push(line)
  }

  note(line: string): void {
    this.notes.push(line)
  }

  result(): CheckResult {
    return this.failures.length === 0
      ? pass(this.evidence, this.notes)
      : fail(this.failures.join('; '), this.evidence, this.notes)
  }
}
