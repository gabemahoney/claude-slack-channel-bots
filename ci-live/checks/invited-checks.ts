/**
 * invited-checks.ts — testplans/b.yko Part 11: invited channels against the
 * test workspace (b.deo SRI-1501 to SRI-1506, b.deo AC 46). They run after
 * Check 28 and before the closing checks (29a, then the optional 29b), so
 * 29a scans every log and file they write.
 *
 * The operator's flow, with persona C (in no channel by provisioning, DMs on,
 * the test human its contact) and a public channel the test human creates
 * for the run:
 * - Check 30: the switch goes on (`switchOnFilter`, a confirmed edit), the
 *   human creates the channel, mentions C there, invites C's app and mentions
 *   it again: C answers, and one `persona-invited-channel` line names it;
 * - Check 31: asked in the channel, C stores `all` there with
 *   `set_channel_delivery`, then answers a message that does not mention it;
 * - Check 32: the switch goes off; a mention gets no reply, and one
 *   `unclaimed-channel` line (the declarative cause) names the channel;
 * - Check 33: the switch goes on again, the human kicks C's app; asked by
 *   DM, C's `reply` and `fetch_messages` on the channel are refused with
 *   Slack's code, and the outcomes of `react`, `edit_message` and
 *   `fetch_messages` with `thread_ts` are recorded as notes (SRI-603, RN-2);
 * - Check 34: whatever 30–33 found, it restores the config.json bytes Check
 *   30 copied, kicks C's app if it is still in the channel, archives the
 *   channel, and passes only when C is in no channel, archived ones included.
 *   Under `--only`, it runs whenever any of 30–33 is selected.
 *
 * Checks 31 and 33 follow Check 16's ask rule: at most two asks, a second
 * only when C said done but made no call; C never answering is a FAIL, and
 * no call after two asks is "not run". The live container allows the
 * server's MCP tools as a group (docker/live/entrypoint.sh), so C's calls
 * raise no permission prompt and no check here declares one to the prompt
 * guard.
 *
 * Every container command that changes something runs behind the plan's
 * guard. Evidence is IDs, timestamps and the server's own tool errors and log
 * lines, never a token or a message's content.
 *
 * The runner loads no src/ module but the two import-free text modules, so
 * every text these checks expect is a copy held once below, in "Copied
 * texts", each naming the src/ builder it copies and each pinned against it
 * in tests/ci-live-checks.test.ts.
 */

import { describeError } from '../lib/errors.ts'
import { INVITED_KEY, SWITCH_KEY, SWITCH_VALUE_JQ, switchFilter, switchOnFilter } from '../lib/live-config.ts'
import { personaName, PERSONA_LETTERS } from '../lib/personas.ts'
import { REPLY_TIMEOUT_MS, RELOAD_TIMEOUT_MS, SECOND } from '../lib/wait.ts'
import type { CheckContext } from './context.ts'
import { outboundNext } from './dm-checks.ts'
import { Findings, pass, type CheckDef, type CheckResult } from './framework.ts'
import {
  appliedLine,
  askAndWait,
  bot,
  checkPreview,
  confirmedEdit,
  countsText,
  type Exchange,
  fileExists,
  guarded,
  jsonLines,
  lines,
  mark,
  mention,
  needHuman,
  pause,
  pendingFingerprint,
  previewHeader,
  q,
  recorded,
  run,
  S,
  sinceGrep,
  tags,
  type ToolCall,
  toolCalls,
  waitLog,
  waitPending,
} from './helpers.ts'

const LIVE: ['workspace', 'claude'] = ['workspace', 'claude']

// ---------------------------------------------------------------------------
// Copied texts (each pinned against its src/ builder or constant)
// ---------------------------------------------------------------------------

/** src/persona-diagnostics.ts `PERSONA_INVITED_CHANNEL`. */
export const INVITED_CHANNEL_CLASS = 'persona-invited-channel'
/** src/persona-diagnostics.ts `PERSONA_CHANNEL_DELIVERY_SET`. */
export const CHANNEL_DELIVERY_SET_CLASS = 'persona-channel-delivery-set'
/** src/persona-diagnostics.ts `UNCLAIMED_CHANNEL`. */
export const UNCLAIMED_CHANNEL_CLASS = 'unclaimed-channel'
/** src/reload.ts `RELOAD_NOTHING_PENDING`. */
export const NOTHING_PENDING_CLASS = 'reload-nothing-pending'

/** src/channel-delivery.ts `SET_CHANNEL_DELIVERY_TOOL`. */
export const SET_CHANNEL_DELIVERY_TOOL = 'set_channel_delivery'
/** The session tools Check 33 asks C to call (src/registry.ts's tool list). */
export const REPLY_TOOL = 'reply'
export const REACT_TOOL = 'react'
export const EDIT_MESSAGE_TOOL = 'edit_message'
export const FETCH_MESSAGES_TOOL = 'fetch_messages'

/** `"<name>" (key=<key>)` for a test persona, whose key is its name (src/persona-identity.ts `renderPersonaRef`). */
function ref(name: string): string {
  return `"${name}" (key=${name})`
}

/**
 * A persona line with no path, as src/persona-diagnostics.ts
 * `formatPersonaDiagnostic` writes it: `[slack] <class>: personas[<i>]
 * "<name>" (key=<key>): <cause>`.
 */
export function personaLine(cls: string, index: number, name: string, cause: string): string {
  return `[slack] ${cls}: personas[${index}] ${ref(name)}: ${cause}`
}

/** src/persona-diagnostics.ts `invitedChannelCause`. */
export function invitedChannelCause(channel: string, channelType: 'public' | 'private', delivery: 'mentions' | 'all'): string {
  return `hears ${channelType} channel ${channel} in fungible mode, at channel delivery ${delivery}`
}

/** src/persona-diagnostics.ts `channelDeliverySetCause` (no stored choice before the call reads `none`, `NO_STORED_CHOICE`). */
export function channelDeliverySetCause(
  channel: string,
  before: 'mentions' | 'all' | undefined,
  after: 'mentions' | 'all',
  delivery: 'mentions' | 'all',
): string {
  return `stored choice for channel ${channel} set from ${before ?? 'none'} to ${after}, at channel delivery ${delivery} after the loop guard`
}

/** src/persona-diagnostics.ts `unclaimedChannelCause` (the declarative cause, as 0.11.1 writes it). */
export function unclaimedChannelCause(channel: string): string {
  return `message in channel ${channel} not delivered: no applied persona lists this channel`
}

/** src/registry.ts `slackRefusalToolErrorText` with a Slack code: a failed call on a channel target in fungible mode. */
export function slackRefusalText(tool: string, name: string, channel: string, code: string): string {
  return `Tool ${JSON.stringify(tool)} failed for persona ${ref(name)} on channel ${JSON.stringify(channel)}: Slack refused the call (${code}).`
}

/**
 * A Slack code as the server quotes one: src/persona-connection-errors.ts
 * `SAFE_IDENTIFIER_RE`'s short identifier (`slackPlatformReason` passes no
 * other), without its anchors.
 */
export const SLACK_CODE_PATTERN = '[A-Za-z_$][A-Za-z0-9_$]{0,63}'

/** `text` as a literal in a regular expression. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The Slack code in `text` when it contains `slackRefusalText(tool, name,
 * channel, <code>)` for some code, else null. Read as Check 16 reads a
 * refused call: the server's text may sit inside a wrapper the client adds.
 */
export function slackRefusalCode(tool: string, name: string, channel: string, text: string | null): string | null {
  if (text === null) return null
  const [head, tail] = slackRefusalText(tool, name, channel, '\u0000').split('\u0000') as [string, string]
  return new RegExp(`${literal(head)}(${SLACK_CODE_PATTERN})${literal(tail)}`).exec(text)?.[1] ?? null
}

/** src/reload-plan.ts `modeSwitchLine`: the switch's preview line, for the personas present in both configurations. */
export function modeSwitchPreviewLine(mode: 'fungible' | 'declarative', names: readonly string[]): string {
  const head = `server-wide setting ${SWITCH_KEY} changed: turns ${mode} mode on, applied in place at once, from the next event, tool call, prompt and notice`
  return names.length === 0 ? `${head}; no persona is affected.` : `${head}, for ${names.map(ref).join(', ')}.`
}

/** A persona's preview line when its `invited.permission_prompts` changed in place (src/reload-plan.ts's rendering of an in-place change). */
export function invitedInPlaceLine(name: string): string {
  return `persona ${ref(name)}: invited.permission_prompts changed: applied in place immediately, instance kept.`
}

/** src/reload-plan.ts `recordedLine` for a changed `invited` section while the candidate is in declarative mode. */
export function invitedRecordedLine(name: string): string {
  return `persona ${ref(name)}: ${INVITED_KEY} changed in the fungible section: recorded, with no effect until ${SWITCH_KEY} selects fungible mode.`
}

/** src/reload-plan.ts's preview of a change with no effect (`PENDING_PREVIEW_TITLE`, `NO_EFFECTIVE_CHANGE`). */
export const NO_EFFECTIVE_CHANGE_PREVIEW =
  'A configuration change is pending; nothing has been applied. no effective change: applying it would change no persona and no server-wide setting.'

/** src/reload-apply.ts `renderNoopLogLine` for the container's record. */
export function noopLine(): string {
  return (
    '[slack] reload-noop: the confirmed configuration has no effective change, so no persona and no server-wide setting ' +
    `changed; the last-applied record "${S}/config.json.last-applied" was rewritten with it`
  )
}

// ---------------------------------------------------------------------------
// Expected previews
// ---------------------------------------------------------------------------

/** The personas Check 30's edit gives an `invited` section: A to D, those present (in file order). */
export function invitedPersonas(names: readonly string[]): string[] {
  const known = new Set(PERSONA_LETTERS.map(personaName))
  return names.filter((n) => known.has(n))
}

/** Check 30's preview and applied counts for config.json naming `names` (b.deo SRI-802, SRI-803). Pure. */
export function switchOnPreview(names: readonly string[]): { preview: string[]; counts: { in_place: number; settings: number } } {
  const touched = invitedPersonas(names)
  const counts = { in_place: touched.length, settings: 1 }
  return { preview: [previewHeader(counts), ...touched.map(invitedInPlaceLine), modeSwitchPreviewLine('fungible', names)], counts }
}

/** The preview of an edit of the switch alone (Checks 32 and 33), for config.json naming `names`. Pure. */
export function switchOnlyPreview(on: boolean, names: readonly string[]): string[] {
  return [previewHeader({ settings: 1 }), modeSwitchPreviewLine(on ? 'fungible' : 'declarative', names)]
}

/** A configuration file as Check 34 compares two: the switch, and each persona's name and `invited` section (as JSON). */
export interface ConfigView {
  on: boolean
  personas: { name: string; invited: string }[]
}

/**
 * Check 34's restore of `copy` over the applied `record` (b.deo SRI-802 to
 * SRI-804): the preview the server writes and the line its confirmation
 * logs, worked out from the state Checks 30–33 left. The personas present in
 * both whose `invited` section differs are recorded (the copy, in
 * declarative mode, has none). With the switch changed, the header counts
 * one server-wide setting, then the recorded lines and the switch's line,
 * and the apply logs `reload-applied`; with the switch already as the copy
 * has it, the no-effective-change preview with the recorded lines, confirmed
 * as `reload-noop`. Pure.
 */
export function restorePreview(copy: ConfigView, record: ConfigView): { preview: string[]; outcome: string } {
  const applied = new Map(record.personas.map((p) => [p.name, p.invited]))
  const both = copy.personas.filter((p) => applied.has(p.name))
  const recordedLines = both.filter((p) => applied.get(p.name) !== p.invited).map((p) => invitedRecordedLine(p.name))
  if (copy.on === record.on) return { preview: [NO_EFFECTIVE_CHANGE_PREVIEW, ...recordedLines], outcome: noopLine() }
  return {
    preview: [previewHeader({ settings: 1 }), ...recordedLines, modeSwitchPreviewLine(copy.on ? 'fungible' : 'declarative', both.map((p) => p.name))],
    outcome: appliedLine({ settings: 1 }),
  }
}

// ---------------------------------------------------------------------------
// Container reads
// ---------------------------------------------------------------------------

/** Where Check 30 copies config.json in the container (Check 34 restores it). */
export const CONFIG_COPY = '~/cscb-live/config-before-invited.json'

/** The run channel's name: it carries the run id. */
export function runChannelName(runId: string): string {
  return `cscb-live-invited-${runId}`
}

/** The persona names in config.json, in order. */
async function configNames(ctx: CheckContext): Promise<string[]> {
  return lines(ctx, `jq -r '.personas[].name' "$S/config.json"`)
}

/** `file`'s switch and personas (`ConfigView`), or null when it cannot be read. */
async function configView(ctx: CheckContext, file: string): Promise<ConfigView | null> {
  const out = await lines(ctx, `jq -c ${q(`{on: ${SWITCH_VALUE_JQ}, personas: [.personas[] | {name, invited: (.${INVITED_KEY} | tojson)}]}`)} ${file}`)
  const v = jsonLines<ConfigView>(out)[0]
  return v && typeof v.on === 'boolean' && Array.isArray(v.personas) ? v : null
}

/** Whether the switch is on in the last-applied record. */
async function switchOnInRecord(ctx: CheckContext): Promise<boolean> {
  return (await lines(ctx, `jq -c ${q(SWITCH_VALUE_JQ)} "$S/config.json.last-applied"`))[0] === 'true'
}

/** C's line of `cls` with `cause`, at C's index in config.json (`names`). */
function cLine(names: readonly string[], cls: string, cause: string): string {
  return personaLine(cls, names.indexOf(personaName('c')), personaName('c'), cause)
}

/** The lines since `m` of class `cls` that name C and `channel`. */
async function cLinesOf(ctx: CheckContext, m: string, cls: string, channel: string): Promise<string[]> {
  return (await sinceGrep(ctx, m, `] ${cls}: `)).filter((l) => l.includes(ref(personaName('c'))) && l.includes(channel))
}

/** The run channel, or the FAIL a check gives without it. */
function runChannel(ctx: CheckContext): { id: string; name: string } | CheckResult {
  return ctx.shared.invitedChannel ?? { status: 'FAIL', reason: 'no run channel: Check 30 did not create one', evidence: [] }
}

/** An applied-line expectation for a confirmed edit. */
function expectApplied(f: Findings, appliedLines: readonly string[], counts: Parameters<typeof appliedLine>[0]): void {
  f.expect(appliedLines.some((l) => l.includes(appliedLine(counts))), `the reload-applied line does not count ${countsText(counts)}`)
}

/** C's DM with the human, opened when the run has none yet. */
async function cDm(ctx: CheckContext): Promise<string> {
  if (ctx.shared.cDm) return ctx.shared.cDm
  const id = await needHuman(ctx).openDm(ctx.ids.bots.c.userId)
  ctx.shared.cDm = id
  return id
}

// ---------------------------------------------------------------------------
// The ask rule (Check 16's): at most two asks
// ---------------------------------------------------------------------------

interface AskOutcome {
  next: 'evaluate' | 'silent' | 'no-call'
  asks: Exchange[]
}

/**
 * Post `text` in `channel` and wait for C's done; ask once more when C said
 * done but `called()` is still false (Check 16's rule, `outboundNext`).
 */
async function askC(ctx: CheckContext, channel: string, text: string, called: () => Promise<boolean>): Promise<AskOutcome> {
  const asks: Exchange[] = []
  for (;;) {
    const x = await askAndWait(ctx, channel, text, 'c', 'done')
    asks.push(x)
    const next = outboundNext(asks.length, x.reply !== null, await called())
    if (next !== 'ask-again') return { next, asks }
  }
}

/** Evidence lines for the asks: each post's ts and C's done (or its absence). */
function askEvidence(f: Findings, label: string, asks: readonly Exchange[]): void {
  asks.forEach((x, i) => f.add(`${label} ask ${i + 1}: TS ${x.ts}, ${x.reply ? `done ${x.reply.ts}` : 'no done from C'}`))
}

/** The calls of `tool` on `channel` made after the first `before` of them. */
function newCalls(calls: readonly ToolCall[], channel: string, before: number, threadTs?: boolean): ToolCall[] {
  return calls.filter((c) => c.channel === channel && (threadTs === undefined || c.threadTs === threadTs)).slice(before)
}

/** How many calls of `tool` on `channel` C's transcript holds now. */
async function callCount(ctx: CheckContext, tool: string, channel: string, threadTs?: boolean): Promise<number> {
  return newCalls(await toolCalls(ctx, 'c', tool), channel, 0, threadTs).length
}

/** C's newest call of `tool` on `channel` after `before` of them, if any. */
async function newestCall(ctx: CheckContext, tool: string, channel: string, before: number, threadTs?: boolean): Promise<ToolCall | undefined> {
  return newCalls(await toolCalls(ctx, 'c', tool), channel, before, threadTs).at(-1)
}

/** A SKIPPED "not run" result that keeps the evidence and notes. */
function notRun(reason: string, f: Findings): CheckResult {
  return { status: 'SKIPPED', reason: `not run: ${reason} (the plan records this as "not run", not a pass)`, evidence: f.evidence, notes: f.notes }
}

// ---------------------------------------------------------------------------
// Check 30
// ---------------------------------------------------------------------------

export const check30: CheckDef<CheckContext> = {
  id: '30',
  title: 'Check 30: an invite is enough: with the switch on, C answers a mention in a channel its app was invited to (b.deo AC 46)',
  needs: LIVE,
  row: '30',
  async run(ctx) {
    const f = new Findings()
    const ids = ctx.ids
    const human = needHuman(ctx)
    const ready = await run(ctx, 'guard && cmp -s "$S/config.json" "$S/config.json.last-applied" && [ ! -e "$S/config.json.pending" ] && kill -0 "$(cat "$S/server.pid")" && echo READY')
    if (!f.expect(ready.out.includes('READY'), 'not in the applied, nothing-pending, running state; nothing was changed')) return f.result()
    const copied = await guarded(ctx, `cp "$S/config.json" ${CONFIG_COPY} && echo COPIED`)
    if (!f.expect(copied.ok && copied.out.includes('COPIED'), 'config.json could not be copied; nothing was changed')) return f.result()
    ctx.shared.invitedConfigCopy = CONFIG_COPY
    f.add(`config.json copied to ${CONFIG_COPY}`)

    const names = await configNames(ctx)
    const expected = switchOnPreview(names)
    const m = await mark(ctx)
    const out = await confirmedEdit(ctx, f, m, switchOnFilter(ids), expected.preview)
    expectApplied(f, out.appliedLines, expected.counts)
    if (f.failures.length > 0) return f.result()

    const name = runChannelName(ctx.runId)
    const channel = await human.createChannel(name)
    ctx.shared.invitedChannel = { id: channel, name }
    f.add(`run channel #${name} ${channel}`)
    const m2 = await mark(ctx)
    const early = await human.post(channel, `${mention(ctx, 'c')} invite check: this mention comes before your app is invited.`)
    await human.invite(channel, ids.bots.c.userId)
    const x = await askAndWait(ctx, channel, `${mention(ctx, 'c')} reply here with the word invited.`, 'c', 'invited')
    f.add(`TS_BEFORE ${early}, TS ${x.ts}`)
    if (f.expect(x.reply !== null, 'C did not answer the mention in the run channel after the invite')) {
      ctx.shared.invitedCAnswerTs = x.reply!.ts
      f.add(`C answered ${x.reply!.ts}`)
    }
    const before = await tags(ctx, 'c', early)
    f.note(`Check 30: the mention before the invite was ${before.length > 0 ? '' : 'not '}delivered to C`)
    const heard = await cLinesOf(ctx, m2, INVITED_CHANNEL_CLASS, channel)
    const want = cLine(names, INVITED_CHANNEL_CLASS, invitedChannelCause(channel, 'public', 'mentions'))
    f.expect(heard.length === 1 && heard[0]!.includes(want), `expected one ${INVITED_CHANNEL_CLASS} line naming C and the run channel (public, mentions), found ${heard.length}`)
    return f.result()
  },
}

// ---------------------------------------------------------------------------
// Check 31
// ---------------------------------------------------------------------------

export const check31: CheckDef<CheckContext> = {
  id: '31',
  title: 'Check 31: asked in the channel, C switches it to all with set_channel_delivery, then answers a message that does not mention it (b.deo AC 46)',
  needs: LIVE,
  row: '31',
  async run(ctx) {
    const ch = runChannel(ctx)
    if ('status' in ch) return ch
    const f = new Findings()
    const names = await configNames(ctx)
    const m = await mark(ctx)
    const before = await callCount(ctx, SET_CHANNEL_DELIVERY_TOOL, ch.id)
    const o = await askC(
      ctx,
      ch.id,
      `${mention(ctx, 'c')} please listen to every message in this channel from now on: call your ${SET_CHANNEL_DELIVERY_TOOL} tool once with channel \`${ch.id}\` and delivery \`all\`. Then reply here with the word done.`,
      async () => (await newestCall(ctx, SET_CHANNEL_DELIVERY_TOOL, ch.id, before)) !== undefined,
    )
    askEvidence(f, 'set_channel_delivery', o.asks)
    if (o.next === 'silent') {
      f.expect(false, `C did not say done${o.asks.length > 1 ? ' to the second ask' : ''} and made no ${SET_CHANNEL_DELIVERY_TOOL} call for the run channel`)
      return f.result()
    }
    if (o.next === 'no-call') return notRun(`C made no ${SET_CHANNEL_DELIVERY_TOOL} call for the run channel (asked ${o.asks.length} times)`, f)
    const call = (await newestCall(ctx, SET_CHANNEL_DELIVERY_TOOL, ch.id, before))!
    f.expect(o.asks.at(-1)!.reply !== null, 'C did not say done')
    f.expect(call.delivery === 'all', `C's call asked for delivery ${call.delivery ?? '(none)'}, not all`)
    if (!f.expect(call.outcome === 'ok', `C's ${SET_CHANNEL_DELIVERY_TOOL} call was ${call.outcome === 'none' ? 'not answered' : 'refused'}`) && call.error) {
      f.add(`refusal: ${call.error.slice(0, 300)}`)
    }
    const set = await cLinesOf(ctx, m, CHANNEL_DELIVERY_SET_CLASS, ch.id)
    const want = cLine(names, CHANNEL_DELIVERY_SET_CLASS, channelDeliverySetCause(ch.id, undefined, 'all', 'all'))
    f.expect(set.length === 1 && set[0]!.includes(want), `expected one ${CHANNEL_DELIVERY_SET_CLASS} line naming C and the run channel (none to all, at all), found ${set.length}`)
    const plain = await askAndWait(ctx, ch.id, 'Whoever is listening in this channel: reply here with the word heard-all.', 'c', 'heard-all')
    f.add(`TS_PLAIN ${plain.ts}`)
    f.expect(plain.reply !== null, 'C did not answer the message that does not mention it')
    return f.result()
  },
}

// ---------------------------------------------------------------------------
// Check 32
// ---------------------------------------------------------------------------

export const check32: CheckDef<CheckContext> = {
  id: '32',
  title: "Check 32: with the switch off and C's app still in the channel, a mention is not delivered, and one unclaimed-channel line says so (b.deo AC 46)",
  needs: LIVE,
  row: '32',
  async run(ctx) {
    const ch = runChannel(ctx)
    if ('status' in ch) return ch
    const f = new Findings()
    const human = needHuman(ctx)
    if (!f.expect(await switchOnInRecord(ctx), 'the switch is not on in the last-applied record, so there is nothing to switch off')) return f.result()
    const names = await configNames(ctx)
    const m = await mark(ctx)
    const out = await confirmedEdit(ctx, f, m, switchFilter(false), switchOnlyPreview(false, names))
    expectApplied(f, out.appliedLines, { settings: 1 })
    const m2 = await mark(ctx)
    const ts = await human.post(ch.id, `${mention(ctx, 'c')} the switch is off: reply here with the word off-check.`)
    f.add(`TS ${ts}`)
    const reply = await human.waitForBotMessage(ch.id, bot(ctx, 'c'), ts, () => true, REPLY_TIMEOUT_MS)
    f.expect(reply === null, 'C answered in the run channel with the switch off')
    const unclaimed = await cLinesOf(ctx, m2, UNCLAIMED_CHANNEL_CLASS, ch.id)
    const want = cLine(names, UNCLAIMED_CHANNEL_CLASS, unclaimedChannelCause(ch.id))
    f.expect(
      unclaimed.length === 1 && unclaimed[0]!.includes(want),
      `expected one ${UNCLAIMED_CHANNEL_CLASS} line with the declarative cause naming C and the run channel, found ${unclaimed.length}`,
    )
    return f.result()
  },
}

// ---------------------------------------------------------------------------
// Check 33
// ---------------------------------------------------------------------------

/** The three calls whose outcome after the kick Check 33 records, never judges (b.deo SRI-603, RN-2). */
export const CHECK33_RECORDED_CALLS = ['react', 'edit_message on C\'s earlier post', 'fetch_messages with thread_ts'] as const
export type Check33RecordedCall = (typeof CHECK33_RECORDED_CALLS)[number]

/** How a recorded call ended. */
export type RecordedOutcome =
  | { kind: 'accepted' }
  | { kind: 'refused'; code: string | null }
  | { kind: 'unanswered' }
  | { kind: 'not-made' }

/** A recorded call's outcome, from C's call (or its absence). */
export function recordedOutcome(tool: string, channel: string, call: ToolCall | undefined): RecordedOutcome {
  if (call === undefined) return { kind: 'not-made' }
  if (call.outcome === 'ok') return { kind: 'accepted' }
  if (call.outcome === 'none') return { kind: 'unanswered' }
  return { kind: 'refused', code: slackRefusalCode(tool, personaName('c'), channel, call.error) }
}

/**
 * The note line for a recorded call, in the fixed form the run's report and
 * T23's residual step read from results.md:
 * `Check 33 residual: <call> after the kick: accepted | refused by Slack (<code>) | refused with no Slack code | made, with no result | not made`.
 */
export function residualNote(call: Check33RecordedCall, outcome: RecordedOutcome): string {
  const what =
    outcome.kind === 'accepted'
      ? 'accepted'
      : outcome.kind === 'refused'
        ? outcome.code === null
          ? 'refused with no Slack code'
          : `refused by Slack (${outcome.code})`
        : outcome.kind === 'unanswered'
          ? 'made, with no result'
          : 'not made'
  return `Check 33 residual: ${call} after the kick: ${what}`
}

export const check33: CheckDef<CheckContext> = {
  id: '33',
  title: "Check 33: after C's app is kicked, reply and fetch_messages on the channel are refused with Slack's code; react, edit_message and threaded fetch_messages are recorded (b.deo AC 46)",
  needs: LIVE,
  row: '33',
  async run(ctx) {
    const ch = runChannel(ctx)
    if ('status' in ch) return ch
    const f = new Findings()
    const human = needHuman(ctx)
    const c = personaName('c')
    if (await switchOnInRecord(ctx)) {
      f.note('Check 33: the switch was already on in the last-applied record (Check 32 did not turn it off); no edit was made')
    } else {
      const names = await configNames(ctx)
      const m = await mark(ctx)
      const out = await confirmedEdit(ctx, f, m, switchFilter(true), switchOnlyPreview(true, names))
      expectApplied(f, out.appliedLines, { settings: 1 })
    }
    await human.kick(ch.id, ctx.ids.bots.c.userId)
    f.add(`C's app kicked from ${ch.id}`)
    const dm = await cDm(ctx)

    // The two calls Slack must refuse.
    const replyBefore = await callCount(ctx, REPLY_TOOL, ch.id)
    const fetchBefore = await callCount(ctx, FETCH_MESSAGES_TOOL, ch.id, false)
    const refusedCalls = async () => ({
      reply: await newestCall(ctx, REPLY_TOOL, ch.id, replyBefore),
      fetch: await newestCall(ctx, FETCH_MESSAGES_TOOL, ch.id, fetchBefore, false),
    })
    const a = await askC(
      ctx,
      dm,
      `Call your ${REPLY_TOOL} tool once with chat_id \`${ch.id}\` and the text \`after-kick check\`, and your ${FETCH_MESSAGES_TOOL} tool once with channel \`${ch.id}\` and no thread_ts. Call each even if you expect it to fail. Then reply here with the word done.`,
      async () => {
        const calls = await refusedCalls()
        return calls.reply !== undefined && calls.fetch !== undefined
      },
    )
    askEvidence(f, 'reply and fetch_messages', a.asks)
    if (a.next === 'silent') {
      f.expect(false, `C did not say done${a.asks.length > 1 ? ' to the second ask' : ''} and made no ${REPLY_TOOL} and ${FETCH_MESSAGES_TOOL} call on the run channel`)
      return f.result()
    }
    // Each call C made is judged, even when the other is missing; a missing call alone is "not run".
    f.expect(a.asks.at(-1)!.reply !== null, 'C did not say done')
    const calls = await refusedCalls()
    const missing: string[] = []
    for (const [tool, call] of [[REPLY_TOOL, calls.reply], [FETCH_MESSAGES_TOOL, calls.fetch]] as const) {
      if (call === undefined) {
        missing.push(tool)
        continue
      }
      const code = call.outcome === 'error' ? slackRefusalCode(tool, c, ch.id, call.error) : null
      if (f.expect(code !== null, `C's ${tool} call on the run channel was not refused with the tool error naming C, the channel and Slack's code`)) {
        const line = `${tool}${tool === FETCH_MESSAGES_TOOL ? ' without thread_ts' : ''}: refused by Slack (${code})`
        f.add(line)
        f.note(line)
      }
    }
    const skippedReason = missing.length === 0 ? null : `C made no ${missing.join(' and ')} call on the run channel (asked ${a.asks.length} times)`

    // The three calls whose outcome is recorded, never judged.
    const target = ctx.shared.invitedCAnswerTs
    const spec: [Check33RecordedCall, string, boolean | undefined][] = [
      ['react', REACT_TOOL, undefined],
      ["edit_message on C's earlier post", EDIT_MESSAGE_TOOL, undefined],
      ['fetch_messages with thread_ts', FETCH_MESSAGES_TOOL, true],
    ]
    const outcomes = new Map<Check33RecordedCall, RecordedOutcome>(spec.map(([call]) => [call, { kind: 'not-made' }]))
    if (target === undefined) {
      f.note("Check 33: C made no earlier post in the run channel (Check 30 got no answer), so react, edit_message and threaded fetch_messages were not asked for")
    } else {
      const baselines = await Promise.all(spec.map(([, tool, threadTs]) => callCount(ctx, tool, ch.id, threadTs)))
      const recordedCalls = async () => Promise.all(spec.map(([, tool, threadTs], i) => newestCall(ctx, tool, ch.id, baselines[i]!, threadTs)))
      const b = await askC(
        ctx,
        dm,
        `Now call your ${REACT_TOOL} tool once with chat_id \`${ch.id}\`, message_id \`${target}\` and emoji \`eyes\`; your ${EDIT_MESSAGE_TOOL} tool once with chat_id \`${ch.id}\`, message_id \`${target}\` and the text \`edited after the kick\`; and your ${FETCH_MESSAGES_TOOL} tool once with channel \`${ch.id}\` and thread_ts \`${target}\`. Call each even if you expect it to fail. Then reply here with the word done.`,
        async () => (await recordedCalls()).every((x) => x !== undefined),
      )
      askEvidence(f, 'react, edit_message and threaded fetch_messages', b.asks)
      if (b.next === 'silent') f.expect(false, 'C did not say done to the ask for react, edit_message and threaded fetch_messages')
      const made = await recordedCalls()
      spec.forEach(([call, tool], i) => outcomes.set(call, recordedOutcome(tool, ch.id, made[i])))
    }
    for (const [call, outcome] of outcomes) f.note(residualNote(call, outcome))
    if (skippedReason !== null && f.failures.length === 0) return notRun(skippedReason, f)
    return f.result()
  },
}

// ---------------------------------------------------------------------------
// Check 34
// ---------------------------------------------------------------------------

/** Check 34's config half: restore the copy, confirm the change it makes, remove the copy. */
async function restoreConfig(ctx: CheckContext, f: Findings, copy: string): Promise<void> {
  const g = await guarded(ctx, 'true')
  if (!f.expect(g.ok, 'config: the guard refused')) return
  const copyView = await configView(ctx, copy)
  const recordView = await configView(ctx, '"$S/config.json.last-applied"')
  if (!f.expect(copyView !== null && recordView !== null, 'config: the copy or the last-applied record could not be read')) return
  const neverConfirmed = (await run(ctx, `cmp -s ${copy} "$S/config.json.last-applied"`)).code === 0
  const pendingBefore = await fileExists(ctx, '"$S/config.json.pending"')
  // A pending file already there is an earlier edit's: its fingerprint is noted so the
  // restore's own file (a new fingerprint) is the one read and confirmed. With config.json
  // already the copy, the restore changes nothing and that file is already the restore's.
  const stale =
    pendingBefore && !neverConfirmed && (await run(ctx, `cmp -s ${copy} "$S/config.json"`)).code !== 0 ? await pendingFingerprint(ctx) : undefined
  const m = await mark(ctx)
  const restored = await guarded(ctx, `cp ${copy} "$S/config.json"`)
  if (!f.expect(restored.ok && restored.code === 0, 'config: the guarded restore of config.json did not run')) return
  f.add(`config.json restored from ${copy}`)
  if (neverConfirmed) {
    f.note("Check 34: Check 30's edit was never confirmed (the record still held the copy), so the restore leaves nothing pending")
    await pause(ctx, 30 * SECOND)
    const nothing = await sinceGrep(ctx, m, `] ${NOTHING_PENDING_CLASS}: `)
    f.expect(nothing.length === (pendingBefore ? 1 : 0), `config: ${nothing.length} ${NOTHING_PENDING_CLASS} line(s), not ${pendingBefore ? 1 : 0}`)
  } else {
    const expected = restorePreview(copyView!, recordView!)
    const pending = await waitPending(ctx, RELOAD_TIMEOUT_MS, stale)
    const missing = stale === undefined ? 'did not appear' : 'was not rewritten for the restore (it kept the earlier fingerprint)'
    if (f.expect(pending !== null, `config: config.json.pending ${missing} (or held token-shaped text)`)) checkPreview(f, pending!, expected.preview)
    // An earlier edit's file is never confirmed: with no file for the restore, nothing is renamed.
    if (pending !== null || stale === undefined) {
      const confirmed = await guarded(ctx, 'mv "$S/config.json.pending" "$S/config.json.apply"')
      f.expect(confirmed.ok && confirmed.code === 0, 'config: the confirming rename did not run')
      const cls = expected.outcome.slice(0, expected.outcome.indexOf(':') + 1)
      const outcome = (await waitLog(ctx, m, cls, RELOAD_TIMEOUT_MS)) ?? []
      f.expect(outcome.length === 1 && outcome[0]!.includes(expected.outcome), `config: expected one line "${expected.outcome}", found ${outcome.length} ${cls} line(s)`)
    }
  }
  const same = (await run(ctx, `cmp -s ${copy} "$S/config.json"`)).code === 0
  f.expect(same, 'config: config.json is not the copy')
  f.expect(await recorded(ctx), 'config: config.json and the last-applied record differ')
  f.expect(!(await fileExists(ctx, '"$S/config.json.pending"')), 'config: config.json.pending exists')
  if (same) {
    const removed = await guarded(ctx, `rm -f ${copy}`)
    if (f.expect(removed.ok && removed.code === 0, 'config: the copy could not be removed')) ctx.shared.invitedConfigCopy = undefined
  }
}

/** Check 34's channel half: kick C's app if it is still a member, then archive the channel. */
async function restoreChannel(ctx: CheckContext, f: Findings, channel: { id: string; name: string }): Promise<void> {
  const human = needHuman(ctx)
  const cUser = ctx.ids.bots.c.userId
  if ((await human.conversationsOf(cUser)).includes(channel.id)) {
    await human.kick(channel.id, cUser)
    f.add(`C's app kicked from ${channel.id}`)
  }
  await human.archive(channel.id)
  f.add(`#${channel.name} ${channel.id} archived`)
}

export const check34: CheckDef<CheckContext> = {
  id: '34',
  title: 'Check 34: the cast is restored: config.json as Check 30 found it, nothing pending, the run channel archived, C in no channel (b.deo AC 46)',
  needs: LIVE,
  row: '34',
  // Under --only, a selection of any of 30 to 33 runs it too (b.deo SRI-1506).
  undoes: ['30', '31', '32', '33'],
  async run(ctx) {
    const copy = ctx.shared.invitedConfigCopy
    const channel = ctx.shared.invitedChannel
    if (copy === undefined && channel === undefined) return pass(['nothing to restore: the setup did not run'])
    const f = new Findings()
    // Each half undoes only its own state, and a throw in one still lets the other run.
    if (copy !== undefined) {
      try {
        await restoreConfig(ctx, f, copy)
      } catch (err) {
        f.expect(false, `config: threw ${describeError(err)}`)
      }
    }
    if (channel !== undefined) {
      try {
        await restoreChannel(ctx, f, channel)
      } catch (err) {
        f.expect(false, `channel: threw ${describeError(err)}`)
      }
    }
    const still = await needHuman(ctx).conversationsOf(ctx.ids.bots.c.userId)
    f.add(`C is in ${still.length} channel(s), archived ones included`)
    f.expect(still.length === 0, `C is still in ${still.length} channel(s), archived ones included: ${still.join(', ')}`)
    return f.result()
  },
}

/** Part 11, in run order. */
export const INVITED_CHECKS = [check30, check31, check32, check33, check34]
