/**
 * cron-dispatch.ts — Fire/delivery path for matched cron schedules
 * (Task 2 on b.he5; decisions 1/7, D-Q4, D-Q5 on b.grx; group delivery is the
 * owner's gate-answer-3 optimization on t2.he5.eu.4q).
 *
 * `createCronDispatcher({ port, cronLog, cronTablePath })` returns a handle
 * with two delivery methods:
 *   fire(schedule)       — deliver ONE already-parsed CronSchedule.
 *   fireGroup(schedules) — deliver a set of schedules that matched the SAME
 *                          minute; when several target the same channel their
 *                          prompts are concatenated into ONE /interject POST
 *                          (owner: "Cat in the order they are listed in the
 *                          crontable"). fire(s) is exactly fireGroup([s]).
 * Both record every outcome via the injected cron-log handle. The dispatcher is
 * INERT: it imports nothing from server.ts, starts no listener, holds no timer,
 * reads no crontable, and never fires on its own — Task 3's tick loop is the
 * only intended caller. Delivery is a localhost HTTP POST to the server's own
 * `/interject` endpoint AS-IS (decision 7), which gives us the 32KB cap and 503
 * semantics for free.
 *
 * Delivery has a fixed internal shape (PM review — this is E4's seam):
 *   per-schedule resolve-targets → (all-bots marker → fanout-deferred branch) +
 *   fresh prompt read → per-CHANNEL delivery that is AGNOSTIC to where the
 *   targets came from. E4 (all-bots fan-out) must later change ONLY the resolve
 *   step plus one constructor dependency; the delivery path below never
 *   special-cases all-bots and never fuses resolution into itself. Do not
 *   collapse these stages.
 *
 * Grouping REDUCES worst-case POSTs per tick: one POST per DISTINCT target
 * channel instead of one per (schedule, channel) pair. The multi-target stall
 * invariant (`targets × DEFAULT_DELIVER_TIMEOUT_MS` well under the 60 s tick)
 * therefore only improves under grouping; DEFAULT_DELIVER_TIMEOUT_MS is
 * unchanged. Task 3 awaits fireGroup once per tick.
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

/** The dispatcher handle. Two async delivery methods; neither ever throws. */
export interface CronDispatcher {
  /**
   * Deliver one matched schedule, recording every outcome. Exactly
   * `fireGroup([schedule])` — kept as its own name for the single-schedule
   * callers and existing tests. Never throws.
   */
  fire(schedule: CronSchedule): Promise<void>
  /**
   * Deliver a group of schedules that matched the SAME minute. Schedules
   * targeting the same channel have their (freshly read) prompts concatenated
   * into ONE /interject POST in input (crontable line) order; schedules for
   * different channels stay separate deliveries. Each contributing (schedule,
   * channel) pair gets its own outcome line and each schedule gets exactly one
   * summary line counting ITS own targets. Never throws.
   */
  fireGroup(schedules: CronSchedule[]): Promise<void>
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
   */
  function resolveTargets(schedule: CronSchedule): string[] {
    return schedule.channels.kind === 'explicit' ? schedule.channels.channelIds : []
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

  /**
   * Serialize ONE /interject body. sender = schedule identity (D-Q4): without
   * it /interject defaults senderLabel to 'interject' and a cron fire is
   * indistinguishable from peer-bot traffic. This is the single place a body is
   * built, so "the measured string IS the sent string" holds by construction.
   */
  function buildBody(channel: string, message: string, sender: string): string {
    return JSON.stringify({ channel, message, sender })
  }

  /** UTF-8 byte length of the exact serialized body (the cap predicate input). */
  function bodyBytes(body: string): number {
    return new TextEncoder().encode(body).byteLength
  }

  /**
   * Build the sender for a grouped (concatenated) POST. Naming only the first
   * contributor's identity would misattribute the other prompts' content to the
   * reading agent, so the grouped sender lists EVERY contributor in group
   * order: the first schedule's full identity (`cscb-cron:<basename1>`) followed
   * by `+<basename>` for each subsequent contributor — the shared `cscb-cron:`
   * namespace prefix stripped from the tail entries but retained on the head, so
   * the whole label keeps the cscb-cron: property that distinguishes cron fires
   * from humans/peers while staying truthful about all contributors. The prefix
   * is derived from the head identity (everything through its first ':') rather
   * than hardcoded, so it tracks crontable.ts's IDENTITY_PREFIX. Only ever
   * called with 2+ contributors (the single-contributor path uses the plain
   * identity unchanged).
   */
  function groupSender(contributors: Contributor[]): string {
    const head = contributors[0]!.identity
    const colon = head.indexOf(':')
    const prefix = colon === -1 ? '' : head.slice(0, colon + 1)
    const tail = contributors
      .slice(1)
      .map((c) => (prefix !== '' && c.identity.startsWith(prefix) ? c.identity.slice(prefix.length) : c.identity))
    return tail.length === 0 ? head : `${head}+${tail.join('+')}`
  }

  /**
   * A schedule that passed its per-fire pre-checks (all-bots deferral and
   * prompt read already resolved) and therefore contributes real prompt content
   * to one or more channels. `delivered`/`failed` accumulate across this
   * schedule's OWN channels so it can emit exactly one summary at the end.
   */
  interface Contributor {
    schedule: CronSchedule
    identity: string
    resolvedPath: string
    content: string
    delivered: number
    failed: number
  }

  /**
   * Deliver one measured body to a single channel and write the SAME resulting
   * outcome line for each contributing schedule (grouped POST → shared status →
   * one attributable line per contributor). Increments each contributor's own
   * delivered/failed counter.
   *
   * `grouped=<n>` is added to the detail free text ONLY when n >= 2, i.e. when
   * it actually carries information (this POST was a concatenation). A single-
   * contributor delivery (the fire([s]) path) omits it entirely so its log
   * lines stay byte-identical to Task 2's original fire().
   */
  async function deliverToChannel(
    timestamp: string,
    channel: string,
    body: string,
    contributors: Contributor[],
  ): Promise<void> {
    const { outcome, detail } = await deliver(body)
    const groupedNote = contributors.length >= 2 ? `grouped=${contributors.length}` : undefined
    for (const c of contributors) {
      if (outcome === 'delivered') c.delivered++
      else c.failed++
      const text =
        groupedNote === undefined
          ? detail.text
          : detail.text === undefined
            ? groupedNote
            : `${detail.text} ${groupedNote}`
      cronLog.outcome({
        timestamp,
        identity: c.identity,
        channel,
        outcome,
        detail: {
          promptPath: c.resolvedPath,
          ...detail,
          text,
        },
      })
    }
  }

  /**
   * Deliver ONE schedule's prompt to one channel individually (no
   * concatenation), applying its own cap check. Used both by the single-
   * contributor channel path and by the oversize-group fallback. An
   * individually-oversize body logs prompt-oversize naming its promptPath,
   * exactly as the original fire() did, and increments `failed`.
   */
  async function deliverOne(
    timestamp: string,
    channel: string,
    contributor: Contributor,
  ): Promise<void> {
    const body = buildBody(channel, contributor.content, contributor.identity)
    const byteLength = bodyBytes(body)
    if (byteLength > INTERJECT_BODY_CAP_BYTES) {
      contributor.failed++
      cronLog.outcome({
        timestamp,
        identity: contributor.identity,
        channel,
        outcome: 'prompt-oversize',
        detail: {
          promptPath: contributor.resolvedPath,
          text: `size=${byteLength} cap=${INTERJECT_BODY_CAP_BYTES}`,
        },
      })
      return
    }
    await deliverToChannel(timestamp, channel, body, [contributor])
  }

  /**
   * Deliver a group of schedules that matched the SAME minute. fire() is
   * exactly `fireGroup([schedule])`; the single-schedule shape falls out of the
   * general path (one contributor per channel → one POST per target → identical
   * outcome + summary lines, plus the harmless `grouped=1` note).
   */
  async function fireGroup(schedules: CronSchedule[]): Promise<void> {
    const timestamp = new Date().toISOString()

    // --- per-schedule resolve + fresh read (E4 seam preserved) ------------
    // All-bots and prompt pre-check failures are handled here, per schedule,
    // exactly as the original fire() did — such a schedule contributes to no
    // channel and its summary is emitted immediately.
    const contributors: Contributor[] = []
    // Distinct target channels in first-seen (input/line) order, each mapping
    // to its ordered contributor list.
    const channelOrder: string[] = []
    const byChannel = new Map<string, Contributor[]>()

    for (const schedule of schedules) {
      const { identity } = schedule

      // All-bots marker: no read, no POST. Fan-out is not yet enabled (E4), so
      // the target set is undefined; log one fanout-deferred line + a 0/0
      // summary (pinned-convention note in the module header) and move on.
      if (schedule.channels.kind === 'all-bots') {
        cronLog.outcome({
          timestamp,
          identity,
          channel: NO_CHANNEL,
          outcome: 'fanout-deferred',
          detail: { text: 'all-bots fan-out not yet enabled' },
        })
        cronLog.summary(timestamp, identity, 0, 0)
        continue
      }

      const targets = resolveTargets(schedule)
      const resolvedPath = resolvePromptPath(schedule.promptPath, cronTablePath)
      const read = readPromptFresh(resolvedPath)
      if (!read.ok) {
        // Missing/unreadable → one pre-fan-out outcome line (no channel) then a
        // summary counting every intended target as failed; no POST. This
        // schedule is excluded from every channel's concatenation; siblings
        // still deliver.
        cronLog.outcome({
          timestamp,
          identity,
          channel: NO_CHANNEL,
          outcome: read.outcome,
          detail: { promptPath: resolvedPath, errno: read.errno },
        })
        cronLog.summary(timestamp, identity, 0, targets.length)
        continue
      }

      const contributor: Contributor = {
        schedule,
        identity,
        resolvedPath,
        content: read.content,
        delivered: 0,
        failed: 0,
      }
      contributors.push(contributor)
      for (const channel of targets) {
        let list = byChannel.get(channel)
        if (list === undefined) {
          list = []
          byChannel.set(channel, list)
          channelOrder.push(channel)
        }
        list.push(contributor)
      }
    }

    // --- per-channel delivery (sequential; every channel attempted) -------
    for (const channel of channelOrder) {
      const group = byChannel.get(channel)!

      if (group.length === 1) {
        // Single contributor: the concatenated body IS that one prompt, so the
        // general path and the individual path coincide — take the individual
        // path so fire([s]) reproduces the original per-target logging exactly.
        await deliverOne(timestamp, channel, group[0]!)
        continue
      }

      // Concatenate the contributing prompts in input (crontable line) order.
      // Separator is one blank line ("\n\n"): a markdown-natural paragraph
      // break. Prompt files routinely end WITHOUT a trailing newline, so an
      // explicit blank line keeps two prompts from fusing into one paragraph.
      // No framing header is added — prompt authors own their own content.
      const message = group.map((c) => c.content).join('\n\n')
      // Grouped sender names every contributor (see groupSender) so no prompt's
      // content is misattributed to the head schedule alone.
      const body = buildBody(channel, message, groupSender(group))
      const byteLength = bodyBytes(body)

      if (byteLength > INTERJECT_BODY_CAP_BYTES) {
        // Concatenation is an OPTIMIZATION only. An oversize group must not be
        // dropped with one opaque line: fall back to delivering each
        // contributing schedule to this channel individually, in line order,
        // each subject to its own cap check. One info line records the split so
        // the operator can see the group was broken up.
        cronLog.info(
          timestamp,
          `grouped body oversize (size=${byteLength} cap=${INTERJECT_BODY_CAP_BYTES}) — ` +
            `delivering ${group.length} schedules individually`,
          NO_CHANNEL,
          channel,
        )
        for (const contributor of group) {
          await deliverOne(timestamp, channel, contributor)
        }
        continue
      }

      // Under the cap → one grouped POST for this channel (measured == sent).
      await deliverToChannel(timestamp, channel, body, group)
    }

    // --- one summary per contributing schedule ----------------------------
    // (All-bots and prompt-failure schedules already summarized above.)
    for (const c of contributors) {
      cronLog.summary(timestamp, c.identity, c.delivered, c.failed)
    }
  }

  async function fire(schedule: CronSchedule): Promise<void> {
    await fireGroup([schedule])
  }

  return { fire, fireGroup }
}
