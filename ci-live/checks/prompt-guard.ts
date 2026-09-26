/**
 * prompt-guard.ts — the run's prompt guard: it denies the permission prompts
 * no check expects, so one model detour can't block a persona for the rest of
 * the run (run 6: A ran an unrequested `env` in Check 12, nobody answered its
 * prompt, and eleven checks failed behind it).
 *
 * Started once for the run. Every PROMPT_GUARD_INTERVAL_MS it reads the new
 * lines of the container's permission trail (`promptTrail`: the
 * `cscb.chat_post.attempted` posts, in `promptPosts`'s projection, and the
 * events that close a request) and groups the posts by `request_token`: the
 * latest copy wins, since a restart posts an open prompt again. A token is
 * resolved once it has a `cscb.ad_decide.attempted` that succeeded (its
 * `result_class` one of DECIDED_RESULT_CLASSES), a `cscb.chat_update.attempted`
 * that renders a verdict (any but NOT_A_VERDICT_TAG) or a `reconciled_closed`
 * row decision. A refused decide (`ErrRelayFallenBack` and the like) leaves it
 * open, so the guard still denies it.
 *
 * - A check declares the prompts it expects before it posts what raises them:
 *   `ctx.promptGuard.expect({ persona, command, leaveOpen? })`. A prompt first
 *   seen while the check runs that matches one (the persona's, its text
 *   matching `command`) is the check's: the guard stands down for it while
 *   the check runs, since the check is waiting to click it.
 * - Any other open prompt older than PROMPT_GUARD_GRACE_MS is denied: Deny
 *   clicked on its latest copy, or, when the click fails (or no copy reached
 *   Slack), a guarded `agent-director decide … --decision deny` in the
 *   container.
 * - When a check ends (`afterCheck`, or earlier from the check's own
 *   `finally` through `denyLeftovers`), every prompt first seen while it ran
 *   that is still open is denied, however young, except one its expectation
 *   leaves open (`leaveOpen`: Check 27's, which it later clicks to prove it
 *   inert). Such a prompt is never denied, for the rest of the run.
 *
 * Each denial is a run note naming the check, the persona and the command
 * (the command through the redactor), and an entry of the report results.json
 * and results.md show under `promptGuard`. A denial is never a FAIL. A prompt
 * is denied at most once: a denial that failed is noted, not retried.
 *
 * Reads, sweeps and denials run one at a time. Pure apart from the injected
 * dependencies (`PromptGuardDeps`); `containerPromptGuardDeps` builds the real
 * ones over the test container, the browser and the test human's session.
 */

import { describeError } from '../lib/errors.ts'
import { PERSONA_LETTERS, personaName, type PersonaLetter } from '../lib/personas.ts'
import { SECOND, type Clock } from '../lib/wait.ts'
import type { CheckContext } from './context.ts'
import { Findings } from './framework.ts'
import { clickPrompt, commandMatches, guarded, jsonLines, lines, PROMPT_POST_JQ, q, type InContainer, type PromptPost } from './helpers.ts'

/** How old an open prompt no running check expects must be before the guard denies it. */
export const PROMPT_GUARD_GRACE_MS = 15 * SECOND

/** How often the guard reads the permission trail. */
export const PROMPT_GUARD_INTERVAL_MS = 10 * SECOND

/** At most this many characters of a prompt's command go into a note or the report. */
export const PROMPT_GUARD_COMMAND_MAX = 200

/** What Claude is told when the fallback (`agent-director decide`) denies its request. */
export const PROMPT_GUARD_DENY_REASON =
  'The /ci-live test run did not expect this command and denied it. Carry on with what you were asked, without it.'

/** A prompt a check expects. */
export interface PromptExpectation {
  /** The persona that raises it. */
  persona: PersonaLetter
  /** Matched against the prompt's text: its tool and its command (or file path). */
  command: RegExp
  /** The check leaves it open on purpose: it is never denied, for the rest of the run. */
  leaveOpen?: boolean
}

/** The guard as a check sees it (`ctx.promptGuard`). */
export interface CheckPromptGuard {
  /** Declare a prompt the running check expects, before it posts what raises it. */
  expect(expectation: PromptExpectation): void
  /**
   * Deny now every prompt first seen while the running check runs that is
   * still open, except its `leaveOpen` ones (the end-of-check sweep, from the
   * check's own `finally`). Never throws; resolves with how many it denied.
   */
  denyLeftovers(): Promise<number>
}

/** The permission trail after a line: its line count now, the prompt posts, and the tokens of the events that close a request. */
export interface PromptTrailRead {
  lines: number
  posts: PromptPost[]
  closed: string[]
}

/** One prompt as the guard holds it: its latest copy. */
export interface GuardedPrompt {
  token: string
  instanceId: string
  persona: PersonaLetter | null
  /** The prompt's text (its tool and its command) as posted, raw: shown only through the redactor. */
  command: string
  /** The latest copy that reached Slack, if any. */
  channel: string | null
  slackTs: string | null
}

/** One way of denying: done, or why not. */
export type DenyAttempt = { ok: true } | { ok: false; why: string }

export type PromptDenialHow = 'Deny clicked' | 'agent-director decide' | 'not denied'
export type PromptDenialWhy = 'unexpected' | 'left open'

/** One denial (or failed denial), as the report and the note give it. */
export interface PromptGuardEntry {
  /** Where the prompt was first seen: `check <id>`, `between checks, after check <id>` or `before the first check`. */
  check: string
  /** `persona_a` …, or the instance ID of a prompt from no persona. */
  persona: string
  /** `<tool>: <command>` on one line, redacted, at most PROMPT_GUARD_COMMAND_MAX characters. */
  command: string
  why: PromptDenialWhy
  how: PromptDenialHow
}

/** What results.json and results.md show under `promptGuard`. */
export interface PromptGuardReport {
  /** Prompts seen in the trail (one per request). */
  seen: number
  denied: number
  notDenied: number
  entries: PromptGuardEntry[]
}

export interface PromptGuardDeps {
  clock: Clock
  /** The trail after line `from` (0: all of it). */
  readTrail(from: number): Promise<PromptTrailRead>
  /** Click Deny on the prompt's latest copy and wait for the message to show the denial. */
  click(prompt: GuardedPrompt): Promise<DenyAttempt>
  /** The fallback: a guarded `agent-director decide … --decision deny` in the container. */
  decide(prompt: GuardedPrompt): Promise<DenyAttempt>
  redact(text: string): string
  log(line: string): void
  /** A run note (the Results row's Notes). */
  note(line: string): void
}

// ---------------------------------------------------------------------------
// The trail
// ---------------------------------------------------------------------------

/**
 * The `result_class` of a `cscb.ad_decide.attempted` that leaves the request
 * decided: `ok`, or `ErrAlreadyDecided` (it was decided before; CSCB takes
 * that as success). Any other class is a refusal (`ErrRelayFallenBack`,
 * `ErrInvalidFlags`, `ErrAmbiguousRequest`, `other`, an outage) and leaves
 * the request open.
 */
export const DECIDED_RESULT_CLASSES = ['ok', 'ErrAlreadyDecided'] as const

/**
 * The `verdict_tag` of the one `cscb.chat_update.attempted` that is no
 * verdict: the click handler's rendering of an `ErrRelayFallenBack` refusal
 * (the prompt now waits at the session's tmux pane, still open).
 */
export const NOT_A_VERDICT_TAG = 'click_handler_relay_fallen_back'

/** The events that close a request: a decide that succeeded, a closing message update, a reconciled closure. */
const CLOSING_JQ =
  `((.event == "cscb.ad_decide.attempted" and (${DECIDED_RESULT_CLASSES.map((c) => `.result_class == ${JSON.stringify(c)}`).join(' or ')}))` +
  ` or (.event == "cscb.chat_update.attempted" and .verdict_tag != ${JSON.stringify(NOT_A_VERDICT_TAG)})` +
  ' or (.event == "cscb.poller.row_decision" and .action == "reconciled_closed"))'

/** One trail line as the guard reads it: `{post: …}` (`promptPosts`'s projection), `{closed: <token>}`, or nothing. A line that doesn't parse is skipped. */
export const PROMPT_TRAIL_JQ =
  `fromjson? | select(type == "object") | if .event == "cscb.chat_post.attempted" then {post: ${PROMPT_POST_JQ}} ` +
  `elif ${CLOSING_JQ} and (.request_token | type) == "string" then {closed: .request_token} else empty end`

/**
 * The trail's line count now (`LINES <n>`, 0 when there is none), then its
 * posts and closing events after line `from` up to that count: one cut, so a
 * line written meanwhile is read next time. Read-only.
 */
export function promptTrailScript(from: number): string {
  const start = Math.max(0, Math.floor(from)) + 1
  return [
    '[ -e "$TRAIL" ] || { echo "LINES 0"; exit 0; }',
    'n=$(wc -l < "$TRAIL")',
    'echo "LINES $n"',
    `head -n "$n" "$TRAIL" | tail -n +${start} | jq -cR ${q(PROMPT_TRAIL_JQ)}`,
  ].join('\n')
}

/** `promptTrailScript`'s output, or null without its line count. */
export function parsePromptTrail(out: readonly string[]): PromptTrailRead | null {
  const count = /^LINES\s+(\d+)$/.exec((out[0] ?? '').trim())
  if (!count) return null
  const posts: PromptPost[] = []
  const closed: string[] = []
  for (const item of jsonLines<{ post?: unknown; closed?: unknown }>(out.slice(1))) {
    if (item && typeof item === 'object' && item.post && typeof item.post === 'object') posts.push(item.post as PromptPost)
    else if (item && typeof item === 'object' && typeof item.closed === 'string') closed.push(item.closed)
  }
  return { lines: Number(count[1]), posts, closed }
}

/** Read the container's permission trail after line `from`. */
export async function promptTrail(ctx: InContainer, from: number): Promise<PromptTrailRead> {
  const read = parsePromptTrail(await lines(ctx, promptTrailScript(from)))
  if (!read) throw new Error('the permission trail read printed no line count')
  return read
}

/** The persona a `cscb_persona_<x>` instance is, or null. */
export function personaOfInstance(instanceId: string): PersonaLetter | null {
  return PERSONA_LETTERS.find((l) => instanceId === `cscb_${personaName(l)}`) ?? null
}

/**
 * A prompt's text as a note shows it: `<tool>: <command>` (from CSCB's
 * section block, `🤖🛠️ *<tool>*` then the command in backticks), through the
 * redactor, on one line, at most PROMPT_GUARD_COMMAND_MAX characters.
 */
export function showCommand(text: string, redact: (s: string) => string): string {
  const m = /\*([^*\n]+)\*\n`([\s\S]*)`\s*$/.exec(text)
  const plain = m ? `${m[1]}: ${m[2]}` : text
  const one = redact(plain).replace(/\s+/g, ' ').trim() || '(no command text)'
  return one.length > PROMPT_GUARD_COMMAND_MAX ? `${one.slice(0, PROMPT_GUARD_COMMAND_MAX - 1)}…` : one
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

interface Tracked extends GuardedPrompt {
  /** When it was first posted (the trail's `ts`), else when the guard first saw it; on the guard's clock. */
  since: number
  /** The check running when the guard first saw it. */
  check: string | null
  /** The last check that had ended then (for a prompt seen between checks). */
  after: string | null
  /** The running check's expectation it matched. */
  owner: PromptExpectation | null
  /** A denial was made (or failed): never another. */
  handled: boolean
}

export class PromptGuard implements CheckPromptGuard {
  private cursor = 0
  private readonly prompts = new Map<string, Tracked>()
  private readonly closed = new Set<string>()
  private current: string | null = null
  private last: string | null = null
  private expectations: PromptExpectation[] = []
  private readonly entries: PromptGuardEntry[] = []
  private chain: Promise<unknown> = Promise.resolve()
  private loop: Promise<void> | null = null
  private halted = false
  private wake: (() => void) | null = null
  private readFailing = false

  constructor(private readonly deps: PromptGuardDeps) {}

  expect(expectation: PromptExpectation): void {
    this.expectations.push(expectation)
  }

  /** A check starts: it is the running check, with no expectation yet. */
  beforeCheck(id: string): void {
    this.current = id
    this.expectations = []
  }

  /** A check ended: read the trail, deny what it left open (the end-of-check sweep), then no check runs. */
  async afterCheck(id: string): Promise<void> {
    await this.exclusive(async () => {
      await this.read()
      await this.sweep(id)
    })
    if (this.current === id) {
      this.current = null
      this.expectations = []
    }
    this.last = id
  }

  denyLeftovers(): Promise<number> {
    const id = this.current
    if (id === null) return Promise.resolve(0)
    return this.exclusive(async () => {
      await this.read()
      return this.sweep(id)
    }).catch((err: unknown) => {
      this.deps.log(`prompt guard: the sweep for check ${id} failed: ${describeError(err)}`)
      return 0
    })
  }

  /** Read the trail once, then deny every open prompt no running check owns that is past the grace. */
  tick(): Promise<void> {
    return this.exclusive(async () => {
      await this.read()
      await this.denyStale()
    })
  }

  /** Tick every PROMPT_GUARD_INTERVAL_MS until halted. */
  start(): void {
    if (this.loop !== null) return
    this.halted = false
    this.loop = (async () => {
      while (!this.halted) {
        await new Promise<void>((resolve) => {
          this.wake = resolve
          void this.deps.clock.sleep(PROMPT_GUARD_INTERVAL_MS).then(() => resolve())
        })
        this.wake = null
        if (this.halted) break
        try {
          await this.tick()
        } catch (err) {
          this.deps.log(`prompt guard: a read failed: ${describeError(err)}`)
        }
      }
    })()
  }

  /** Stop ticking, without waiting for a tick in flight (a run being stopped). */
  halt(): void {
    this.halted = true
    this.wake?.()
  }

  /** Stop ticking, and wait for a tick in flight to end. */
  async stop(): Promise<void> {
    this.halt()
    await this.loop
    this.loop = null
  }

  report(): PromptGuardReport {
    const denied = this.entries.filter((e) => e.how !== 'not denied').length
    return { seen: this.prompts.size, denied, notDenied: this.entries.length - denied, entries: this.entries.map((e) => ({ ...e })) }
  }

  /** Run `work` after every earlier read, sweep and denial. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.chain.then(work)
    this.chain = turn.then(
      () => undefined,
      () => undefined,
    )
    return turn
  }

  private async read(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let r: PromptTrailRead
      try {
        r = await this.deps.readTrail(this.cursor)
      } catch (err) {
        if (!this.readFailing) this.deps.log(`prompt guard: reading the permission trail failed: ${describeError(err)} (logged once until a read works)`)
        this.readFailing = true
        return
      }
      if (this.readFailing) this.deps.log('prompt guard: reading the permission trail works again')
      this.readFailing = false
      if (r.lines < this.cursor) {
        // Shorter than what was read: the trail was replaced. Read it whole; the prompts seen stay as they are.
        this.cursor = 0
        continue
      }
      this.cursor = r.lines
      for (const post of r.posts) this.see(post)
      for (const token of r.closed) this.closed.add(token)
      return
    }
  }

  private see(post: PromptPost): void {
    const token = post.request_token
    if (typeof token !== 'string' || token === '') return
    const text = typeof post.command === 'string' ? post.command : ''
    let p = this.prompts.get(token)
    if (!p) {
      const instanceId = typeof post.claude_instance_id === 'string' ? post.claude_instance_id : ''
      const persona = personaOfInstance(instanceId)
      const posted = typeof post.ts === 'string' ? Date.parse(post.ts) : NaN
      const owner = this.current === null ? null : (this.expectations.find((e) => e.persona === persona && commandMatches(e.command, text)) ?? null)
      p = {
        token,
        instanceId,
        persona,
        command: text,
        channel: null,
        slackTs: null,
        since: Number.isFinite(posted) ? posted : this.deps.clock.now(),
        check: this.current,
        after: this.last,
        owner,
        handled: false,
      }
      this.prompts.set(token, p)
    }
    // The latest copy wins.
    if (text !== '') p.command = text
    if (post.ok === true && typeof post.channel === 'string' && post.channel !== '' && typeof post.slack_ts === 'string' && post.slack_ts !== '') {
      p.channel = post.channel
      p.slackTs = post.slack_ts
    }
  }

  /** Not resolved, not already denied, and not left open on purpose. */
  private isOpen(p: Tracked): boolean {
    return !this.closed.has(p.token) && !p.handled && p.owner?.leaveOpen !== true
  }

  private async denyStale(): Promise<void> {
    const now = this.deps.clock.now()
    for (const p of [...this.prompts.values()]) {
      if (!this.isOpen(p)) continue
      // Its check is still running and waiting to click it.
      if (p.owner !== null && p.check !== null && p.check === this.current) continue
      if (now - p.since < PROMPT_GUARD_GRACE_MS) continue
      await this.deny(p)
    }
  }

  /** Deny every open prompt first seen while check `id` ran; how many were denied. */
  private async sweep(id: string): Promise<number> {
    let denied = 0
    for (const p of [...this.prompts.values()]) {
      if (p.check !== id || !this.isOpen(p)) continue
      if (await this.deny(p)) denied++
    }
    return denied
  }

  /** Deny one prompt: Deny clicked on its latest copy, else agent-director decide. A note and a report entry either way. */
  private async deny(p: Tracked): Promise<boolean> {
    p.handled = true
    const failures: string[] = []
    let how: PromptDenialHow = 'not denied'
    if (p.channel !== null && p.slackTs !== null) {
      const click = await this.attempt(() => this.deps.click(p))
      if (click.ok) how = 'Deny clicked'
      else failures.push(`the Deny click failed (${click.why})`)
    } else {
      failures.push('no copy of it reached Slack')
    }
    if (how === 'not denied') {
      const decide = await this.attempt(() => this.deps.decide(p))
      if (decide.ok) how = 'agent-director decide'
      else failures.push(`agent-director decide failed (${decide.why})`)
    }
    const entry: PromptGuardEntry = {
      check: p.check !== null ? `check ${p.check}` : p.after !== null ? `between checks, after check ${p.after}` : 'before the first check',
      persona: p.persona !== null ? personaName(p.persona) : p.instanceId || 'an unknown instance',
      command: showCommand(p.command, this.deps.redact),
      why: p.owner !== null ? 'left open' : 'unexpected',
      how,
    }
    this.entries.push(entry)
    const line = this.deps.redact(noteFor(entry, failures))
    this.deps.note(line)
    this.deps.log(line)
    return how !== 'not denied'
  }

  private async attempt(work: () => Promise<DenyAttempt>): Promise<DenyAttempt> {
    try {
      return await work()
    } catch (err) {
      return { ok: false, why: describeError(err) }
    }
  }
}

/** A denial's run note. */
export function noteFor(entry: PromptGuardEntry, failures: readonly string[]): string {
  const what = entry.why === 'unexpected' ? `${entry.persona}'s unexpected prompt (${entry.check})` : `${entry.persona}'s prompt that ${entry.check} left open`
  switch (entry.how) {
    case 'Deny clicked':
      return `prompt guard: denied ${what}: ${entry.command}; Deny clicked`
    case 'agent-director decide':
      return `prompt guard: denied ${what}: ${entry.command}; ${failures.join('; ')}, so denied with agent-director decide`
    default:
      return `prompt guard: could not deny ${what}: ${entry.command}; ${failures.join('; ')}`
  }
}

// ---------------------------------------------------------------------------
// The real dependencies
// ---------------------------------------------------------------------------

/** What the real guard needs of a check's context: the container, the clock, the IDs, the browser and the test human. */
export type PromptGuardTarget = Pick<CheckContext, 'container' | 'clock' | 'ids' | 'browser' | 'human'>

/** The fallback's command (run behind the plan's guard): deny the request by its instance and token. */
export function denyScript(p: Pick<GuardedPrompt, 'instanceId' | 'token'>): string {
  return `agent-director decide --claude-instance-id ${q(p.instanceId)} --decision deny --request-token ${q(p.token)} --reason ${q(PROMPT_GUARD_DENY_REASON)}`
}

/** agent-director's error name in its output, when it printed one (an identifier only). */
function agentDirectorErrName(out: string): string | null {
  return /"err_name"\s*:\s*"([A-Za-z][A-Za-z0-9]*)"/.exec(out)?.[1] ?? null
}

/**
 * The guard's dependencies over the test container (the trail read and the
 * fallback, through `ctx.container` only, the fallback behind the plan's
 * `guard`), the browser and the test human's session (the click, as the
 * checks click: `clickPrompt`).
 */
export function containerPromptGuardDeps(target: PromptGuardTarget, io: Pick<PromptGuardDeps, 'redact' | 'log' | 'note'>): PromptGuardDeps {
  return {
    clock: target.clock,
    readTrail: (from) => promptTrail(target, from),
    click: async (p) => {
      if (p.channel === null || p.slackTs === null) return { ok: false, why: 'no copy of it reached Slack' }
      const shown = await clickPrompt(target, p.channel, p.slackTs, 'Deny', new Findings())
      return shown ? { ok: true } : { ok: false, why: 'the message did not show the denial' }
    },
    decide: async (p) => {
      const r = await guarded(target, denyScript(p))
      if (!r.ok) return { ok: false, why: 'the guard refused' }
      if (r.code === 0) return { ok: true }
      const name = agentDirectorErrName(`${r.out}\n${r.err}`)
      return { ok: false, why: `exit ${r.code}${name ? `, ${name}` : ''}` }
    },
    redact: io.redact,
    log: io.log,
    note: io.note,
  }
}
