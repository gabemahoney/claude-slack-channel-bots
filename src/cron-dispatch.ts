/**
 * cron-dispatch.ts — Fire/delivery path for one matched cron schedule
 * (Task 2 on b.he5; decisions 1/7, D-Q4, D-Q5 on b.grx).
 *
 * `createCronDispatcher({ port, cronLog, cronTablePath })` returns a handle
 * whose single method `fire(schedule)` delivers ONE already-parsed
 * `CronSchedule` and records every outcome via the injected cron-log handle.
 * The dispatcher is INERT: it imports nothing from server.ts, starts no
 * listener, holds no timer, reads no crontable, and never fires on its own —
 * Task 3's tick loop is the only intended caller. Delivery is a localhost HTTP
 * POST to the server's own `/interject` endpoint AS-IS (decision 7), which
 * gives us the 32KB cap and 503 semantics for free.
 *
 * Same-minute delivery is PLAIN CRON: N schedules matching one minute produce
 * N independent fire()s, one per line in crontable order, each its own
 * /interject POST(s). There is no grouping / prompt concatenation — the owner
 * reversed that optimization (b.qby); the scheduler calls fire() per schedule.
 *
 * fire() has a fixed internal shape (PM review — this is E4's seam):
 *   resolve-targets → (all-bots marker → fanout-deferred branch) → per-target
 *   loop that is AGNOSTIC to where the targets came from.
 * E4 (all-bots fan-out) must later change ONLY the resolve step plus one
 * constructor dependency; the loop below never special-cases all-bots and
 * never fuses resolution into itself. Do not collapse these stages.
 *
 * Summary convention (pinned — apply everywhere): `failed` counts targets
 * whose intended delivery did not happen. A no-match minute logs nothing at
 * all, so a logged `delivered=0 failed=0` cannot be misread as quiet success —
 * it only appears on the all-bots deferral, where the target set is undefined
 * until E4 and nothing failed because delivery was deliberately not attempted.
 *
 * Known limitation (recorded, NOT solved — do not add loopback detection): if
 * the server's `bind` config is a single non-loopback interface, there is no
 * loopback listener, so every fire's POST to 127.0.0.1 fails
 * connection-refused → `http-error`. This is log-visible and accepted.
 *
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

import { expandTilde } from './config.ts'
import type { CronSchedule } from './crontable.ts'
import type { CronLog, CronLogDetail, CronOutcome } from './cron-log.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * UTF-8 byte ceiling for the serialized /interject body. Byte-identical to the
 * /interject handler's own check at src/server.ts (`new TextEncoder().encode(
 * bodyText).byteLength > 32768`). Pinned here so the two cannot drift: because
 * we measure the EXACT string we POST and refuse to send anything over this
 * cap, a 413 from the handler is structurally impossible.
 */
const INTERJECT_BODY_CAP_BYTES = 32768

/**
 * Per-request deadline (ms) for the /interject POST in deliver(), applied as
 * `AbortSignal.timeout(...)`. This bounds ONE pathological case the other
 * outcome branches cannot catch: a peer that ACCEPTS the TCP connection but
 * never responds (wedged event loop). A closed port already rejects instantly
 * with connection-refused → http-error; only accepting-but-silent hangs fetch
 * forever, so without this deadline that fire writes neither an outcome line
 * nor a summary line, breaking the module's every-fire-is-logged contract. On
 * expiry the abort throws a TimeoutError, caught below and mapped to http-error
 * (no new outcome class) — verified against Bun's AbortSignal.timeout.
 *
 * Value = 3000 ms. These are localhost POSTs to the machine's own /interject;
 * healthy responses are sub-millisecond, so 3 s is ~3000× the real latency —
 * it never trips a merely-slow-but-alive peer, only a true hang.
 *
 * MULTI-TARGET INVARIANT (Task 3, t2.he5.eu.4q, must preserve): Task 3 awaits
 * fire() serially from a once-per-minute (60 s) tick, and fire() POSTs to EVERY
 * target sequentially even after failures. The worst case is thus every target
 * wedged: total stall = targets × DEFAULT_DELIVER_TIMEOUT_MS. This must stay
 * comfortably under the 60 s tick so a wedged peer cannot overlap ticks:
 *   3 s × 15 targets = 45 s  < 60 s   (generous fan-out, all wedged)
 * 3 s therefore leaves headroom up to ~19 fully-wedged targets before the
 * budget approaches the tick period. This is a PER-REQUEST deadline only — it
 * does NOT bound a fan-out wide enough to blow the tick on its own; if a future
 * target set can exceed ~19 wedged peers, Task 3 (which owns the tick) must add
 * a cross-target budget. Do not silently raise this constant to "fix" that: the
 * arithmetic above is the invariant Task 3's author must not break.
 */
const DEFAULT_DELIVER_TIMEOUT_MS = 3000

/** Sentinel for a log field with no channel (pre-per-target failures). */
const NO_CHANNEL = '-'

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

/** Constructor dependencies for the dispatcher. */
export interface CronDispatcherDeps {
  /** The /interject port — Task 3 passes Bun.serve's actual bound port. */
  port: number
  /** The cron-log writer handle (Task 1) — sole owner of log appends. */
  cronLog: CronLog
  /**
   * Path to the CRONTABLE file. Relative prompt paths resolve against THIS
   * file's directory (see `resolvePromptPath`), so the dispatcher needs it.
   */
  cronTablePath: string
  /**
   * Optional override for the per-request /interject deadline (ms). Defaults to
   * DEFAULT_DELIVER_TIMEOUT_MS. Exists ONLY so a test can exercise the
   * accepting-but-silent hang path with a short timeout instead of waiting the
   * production 3 s. Not a config-file key and not an env var by design — the
   * production value is pinned as a constant and this seam is test-only.
   */
  deliverTimeoutMs?: number
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
 * stay stable regardless of who runs the server or from where. E6's crontable
 * format reference must carry this rationale forward.
 */
function resolvePromptPath(promptPath: string, cronTablePath: string): string {
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

// ---------------------------------------------------------------------------
// HTTP status → outcome mapping
// ---------------------------------------------------------------------------

/**
 * Map an /interject HTTP status to its outcome class. Verified against the
 * handler at src/server.ts /interject:
 *   200 → delivered        (session got the notification)
 *   503 → no-session       (no live/connected session — decision 1: no retry,
 *                           no queue, no scheduleRestart interaction)
 *   404 → unknown-channel  (channel absent from routing config)
 *   any other status → http-error (belt-and-braces; e.g. 400/403/405/500).
 * A 413 is unreachable here — we never POST over the cap.
 */
function outcomeForStatus(status: number): CronOutcome {
  if (status === 200) return 'delivered'
  if (status === 503) return 'no-session'
  if (status === 404) return 'unknown-channel'
  return 'http-error'
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a cron dispatcher bound to a port, cron-log handle, and crontable
 * path. The returned `fire` delivers one schedule; it never throws — every
 * failure path becomes a logged outcome plus the per-fire summary.
 */
export function createCronDispatcher(deps: CronDispatcherDeps): CronDispatcher {
  const { port, cronLog, cronTablePath } = deps
  const deliverTimeoutMs = deps.deliverTimeoutMs ?? DEFAULT_DELIVER_TIMEOUT_MS
  const interjectUrl = `http://127.0.0.1:${port}/interject`

  /**
   * Resolve the concrete target channel list for a schedule. E4's seam: for
   * an all-bots schedule this is where fan-out expansion will slot in; today
   * only explicit lists produce targets (all-bots is handled by its own
   * deferral branch in fire(), never reaching the loop).
   *
   * Duplicate channel IDs within one schedule's explicit list (e.g. `C1,C1`,
   * an operator typo) are deduped here, preserving first-seen order — one line
   * targets a channel at most once, so a self-duplicated ID does not POST the
   * same prompt to the same channel twice within one fire.
   */
  function resolveTargets(schedule: CronSchedule): string[] {
    return schedule.channels.kind === 'explicit'
      ? [...new Set(schedule.channels.channelIds)]
      : []
  }

  /**
   * POST one measured body to /interject and map the result to an outcome +
   * log detail. The MEASURED string IS the POSTed string (measured == sent),
   * so a 413 cannot occur. A network/fetch failure — including a deadline abort
   * (see DEFAULT_DELIVER_TIMEOUT_MS) — maps to `http-error` with the error
   * cause/errno in the detail text.
   */
  async function deliver(body: string): Promise<{ outcome: CronOutcome; detail: CronLogDetail }> {
    try {
      const res = await fetch(interjectUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        // Bound an accepting-but-silent peer: on expiry fetch rejects with a
        // TimeoutError, handled in the catch below as http-error.
        signal: AbortSignal.timeout(deliverTimeoutMs),
      })
      const outcome = outcomeForStatus(res.status)
      // We branch on status alone and never read the body; cancel it so the
      // connection/stream is released rather than left dangling.
      await res.body?.cancel().catch(() => {
        /* body already consumed/closed — nothing to release */
      })
      const detail: CronLogDetail = { status: res.status }
      return { outcome, detail }
    } catch (err) {
      // A deadline abort throws a DOMException named 'TimeoutError' whose
      // legacy numeric `code` (23) is opaque in an errno field; prefer the
      // name so the log line reads `errno=TimeoutError`, mirroring the readable
      // `errno=ConnectionRefused` a dead port produces. Other fetch failures
      // keep their `code` (e.g. ConnectionRefused).
      const errno =
        err instanceof DOMException && err.name === 'TimeoutError'
          ? err.name
          : err instanceof Error && 'code' in err
            ? String(err.code)
            : undefined
      const cause = err instanceof Error ? err.message : String(err)
      return { outcome: 'http-error', detail: { errno, text: cause } }
    }
  }

  async function fire(schedule: CronSchedule): Promise<void> {
    const timestamp = new Date().toISOString()
    const { identity } = schedule

    // --- resolve-targets --------------------------------------------------
    // All-bots marker: no read, no POST. Fan-out is not yet enabled (E4), so
    // the target set is undefined; log one fanout-deferred line + a 0/0
    // summary (see the pinned-convention note in the module header) and stop.
    if (schedule.channels.kind === 'all-bots') {
      cronLog.outcome({
        timestamp,
        identity,
        channel: NO_CHANNEL,
        outcome: 'fanout-deferred',
        detail: { text: 'all-bots fan-out not yet enabled' },
      })
      cronLog.summary(timestamp, identity, 0, 0)
      return
    }

    const targets = resolveTargets(schedule)

    // --- fire-time path resolution + fresh prompt read --------------------
    const resolvedPath = resolvePromptPath(schedule.promptPath, cronTablePath)
    const read = readPromptFresh(resolvedPath)
    if (!read.ok) {
      // Missing/unreadable → one pre-fan-out outcome line (no channel) then a
      // summary counting every intended target as failed; no POST.
      cronLog.outcome({
        timestamp,
        identity,
        channel: NO_CHANNEL,
        outcome: read.outcome,
        detail: { promptPath: resolvedPath, errno: read.errno },
      })
      cronLog.summary(timestamp, identity, 0, targets.length)
      return
    }

    const content = read.content

    // --- per-target loop (agnostic to target origin) ----------------------
    // Sequential; EVERY target is attempted even after an earlier failure.
    let delivered = 0
    let failed = 0
    for (const channel of targets) {
      // Build the exact serialized body. sender = schedule identity (D-Q4):
      // without it /interject defaults senderLabel to 'interject' and a cron
      // fire is indistinguishable from peer-bot traffic.
      const body = JSON.stringify({ channel, message: content, sender: identity })

      // Oversize predicate on the EXACT serialized string, byte-identical to
      // the /interject handler's own check (see INTERJECT_BODY_CAP_BYTES).
      // Over the cap → log + continue; never truncate, never POST oversize.
      const byteLength = new TextEncoder().encode(body).byteLength
      if (byteLength > INTERJECT_BODY_CAP_BYTES) {
        failed++
        cronLog.outcome({
          timestamp,
          identity,
          channel,
          outcome: 'prompt-oversize',
          detail: {
            promptPath: resolvedPath,
            text: `size=${byteLength} cap=${INTERJECT_BODY_CAP_BYTES}`,
          },
        })
        continue
      }

      // Under the cap → POST the measured string (measured == sent).
      const { outcome, detail } = await deliver(body)
      if (outcome === 'delivered') delivered++
      else failed++
      cronLog.outcome({
        timestamp,
        identity,
        channel,
        outcome,
        detail: { promptPath: resolvedPath, ...detail },
      })
    }

    // Exactly one summary per fire.
    cronLog.summary(timestamp, identity, delivered, failed)
  }

  return { fire }
}
