/** Direct durable acceptance for each cron fire target. */
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

import { expandTilde } from './config.ts'
import type { CronSchedule } from './crontable.ts'
import type { CronLog, CronOutcome } from './cron-log.ts'
import { INTERJECT_BODY_CAP_BYTES } from './interject.ts'
import type { QueueAccept } from './delivery-queue.ts'

/** Sentinel for a log field with no target (pre-per-target failures). */
const NO_TARGET = '-'

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

/**
 * Maps a persona target as written in the crontable (a name or key) to that
 * persona's key, or undefined when no applied persona matches. Called at fire
 * time; production wires it over the server's current applied persona config.
 */
export type CronTargetResolver = (target: string) => string | undefined

/** One delivery a fire makes, in order. */
export interface CronDeliveryTarget {
  /** Resolved persona key, or the written text for an unresolved target. */
  persona: string
  /** The target as first written in the crontable — the log's target field. */
  written: string
}

/**
 * The resolve-targets stage of fire ( seam): resolve each written
 * target to its persona key, THEN dedupe, keeping first-seen order. Two
 * written targets that resolve to the same key (a persona named by name and by
 * key, or named twice) make one delivery, logged under the first-written text.
 * An unresolved target is kept once per distinct written text.
 * Deduping on the resolved value covers both rules. The all-bots
 * marker yields no targets (fire() handles it in its fanout-deferred branch
 * before calling this). Pure: no I/O, no config read — `resolveTarget` is the
 * only input beyond the schedule.
 */
export function resolveDeliveryTargets(
  schedule: CronSchedule,
  resolveTarget: CronTargetResolver,
): CronDeliveryTarget[] {
  if (schedule.targets.kind !== 'explicit') return []
  const byPersona = new Map<string, CronDeliveryTarget>()
  for (const written of schedule.targets.targets) {
    const persona = resolveTarget(written) ?? written
    if (!byPersona.has(persona)) byPersona.set(persona, { persona, written })
  }
  return [...byPersona.values()]
}

/** Constructor dependencies for the dispatcher. */
export interface CronDispatcherDeps {
  /** Shared durable intake, independent of HTTP/session availability. */
  accept: QueueAccept
  /** One clock read per fire, shared by item and cron log. */
  now?: () => number
  /** The cron-log writer handle (section 1) — sole owner of log appends. */
  cronLog: CronLog
  /**
   * Path to the CRONTABLE file. Relative prompt paths resolve against THIS
   * file's directory (see `resolvePromptPath`), so the dispatcher needs it.
   */
  cronTablePath: string
  /**
   * Maps a written target to its persona key (see `CronTargetResolver`).
   * Called on every fire, never cached, so the dispatcher itself reads no
   * config.
   */
  resolveTarget: CronTargetResolver

}

/** The dispatcher handle. Minimal surface: one async delivery method. */
export interface CronDispatcher {
  /** Deliver one matched schedule, recording every outcome. Never throws. */
  fire(schedule: CronSchedule): Promise<void>
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a verbatim crontable prompt path to an absolute path AT FIRE TIME.
 *   leading `~`  → expandTilde (config.ts — do not hand-roll)
 *   absolute     → as-is
 *   relative     → resolved against the CRONTABLE file's directory.
 *
 * The relative case is a deliberate, conscious divergence from system cron's
 * $HOME convention: relative prompts resolve against the crontable's own
 * directory (dirname of cronTablePath), NOT process CWD and NOT $HOME. This is
 * chosen so a prompt can colocate with its crontable as `prompts/foo.md` and
 * stay stable regardless of who runs the server or from where. crontable
 * format reference must carry this rationale forward.
 *
 * The base is the directory of `cronTablePath` as given, never of its real
 * path.
 */
export function resolvePromptPath(promptPath: string, cronTablePath: string): string {
  const expanded = expandTilde(promptPath)
  if (isAbsolute(expanded)) return expanded
  // `~` already handled above; anything still relative anchors to the
  // crontable's directory (the recorded $HOME divergence).
  return resolve(dirname(cronTablePath), expanded)
}

// ---------------------------------------------------------------------------
// Prompt read (fresh every fire — never cached)
// ---------------------------------------------------------------------------

/** Outcome of a fire-time prompt read. */
type PromptRead =
  | { ok: true; content: string }
  | { ok: false; outcome: 'prompt-missing' | 'prompt-unreadable'; errno?: string }

/**
 * Read the resolved prompt file fresh. Content is NEVER cached across fires —
 * an edited prompt takes effect on the next fire. A missing file (ENOENT) maps
 * to `prompt-missing`; any other read failure maps to `prompt-unreadable`,
 * carrying the errno for triage.
 */
function readPromptFresh(resolvedPath: string): PromptRead {
  try {
    return { ok: true, content: readFileSync(resolvedPath, 'utf-8') }
  } catch (err) {
    const errno = err instanceof Error && 'code' in err ? String(err.code) : undefined
    if (errno === 'ENOENT') return { ok: false, outcome: 'prompt-missing', errno }
    return { ok: false, outcome: 'prompt-unreadable', errno }
  }
}

export function createCronDispatcher(deps: CronDispatcherDeps): CronDispatcher {
  const { accept, cronLog, cronTablePath, resolveTarget } = deps
  async function fire(schedule: CronSchedule): Promise<void> {
    const fireTime = (deps.now ?? Date.now)()
    const timestamp = new Date(fireTime).toISOString()
    const { identity } = schedule

    // --- resolve-targets --------------------------------------------------
    // All-bots marker: no read or acceptance. Fan-out is not yet enabled , so
    // the target set is undefined; log one fanout-deferred line + a 0/0
    // summary (see the pinned-convention note in the module header) and stop.
    if (schedule.targets.kind === 'all-bots') {
      cronLog.outcome({
        timestamp,
        identity,
        target: NO_TARGET,
        outcome: 'fanout-deferred',
        detail: { text: 'all-bots fan-out not yet enabled' },
      })
      cronLog.summary(timestamp, identity, 0, 0)
      return
    }

    // Resolve at fire time ( seam): a changed persona set takes effect
    // at the next fire. Resolution happens before the prompt read so a
    // missing prompt counts every intended delivery as failed.
    const resolvedTargets = new Map<string, string | undefined>()
    const targets = resolveDeliveryTargets(schedule, written => {
      const key = resolveTarget(written)
      resolvedTargets.set(written, key)
      return key
    })

    // --- fire-time path resolution + fresh prompt read --------------------
    const resolvedPath = resolvePromptPath(schedule.promptPath, cronTablePath)
    const read = readPromptFresh(resolvedPath)
    if (!read.ok) {
      // Missing/unreadable → one pre-fan-out outcome line (no target) then a
      // summary counting every intended target as failed.
      cronLog.outcome({
        timestamp,
        identity,
        target: NO_TARGET,
        outcome: read.outcome,
        detail: { promptPath: resolvedPath, errno: read.errno },
      })
      cronLog.summary(timestamp, identity, 0, targets.length)
      return
    }

    const content = read.content

    // --- per-target loop (agnostic to target origin) ----------------------
    // Sequential; EVERY target is attempted even after an earlier failure.
    let queued = 0
    let failed = 0
    for (const { persona, written } of targets) {
      // Preserve the historical JSON body byte measure, including escaping and sender.
      const body = JSON.stringify({ persona, message: content, sender: identity })

      // Oversize predicate on the EXACT serialized string, byte-identical to
      // the /interject handler's own check (see INTERJECT_BODY_CAP_BYTES).
      // Over the cap: log and continue without truncating or storing.
      const byteLength = new TextEncoder().encode(body).byteLength
      if (byteLength > INTERJECT_BODY_CAP_BYTES) {
        failed++
        cronLog.outcome({
          timestamp,
          identity,
          target: written,
          outcome: 'prompt-oversize',
          detail: {
            promptPath: resolvedPath,
            text: `size=${byteLength} cap=${INTERJECT_BODY_CAP_BYTES}`,
          },
        })
        continue
      }

      let outcome: CronOutcome
      if (resolvedTargets.get(written) === undefined) outcome = 'unknown-persona'
      else {
        try {
          const result = await accept(persona, { source: 'cron', sender: identity, text: content, received_at: fireTime })
          outcome = result.status === 'failed' ? 'queue-failed' : 'queued'
        } catch { outcome = 'queue-failed' }
      }
      if (outcome === 'queued') queued++
      else failed++
      cronLog.outcome({
        timestamp,
        identity,
        target: written,
        outcome,
        detail: { promptPath: resolvedPath },
      })
    }

    // Exactly one summary per fire.
    cronLog.summary(timestamp, identity, queued, failed)
  }

  return { fire }
}
