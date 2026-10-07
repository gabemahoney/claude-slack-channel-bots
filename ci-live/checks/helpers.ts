/**
 * helpers.ts — the testplan's commands as functions a check calls.
 *
 * Container side: every call runs the plan's helper (`mark`, `since`,
 * `tags`, `replies`, `posts` …) in the test container through
 * `ContainerExec.sh`, and every command that starts, stops or changes
 * something runs behind the plan's `guard`. `toolCalls` reads any session
 * tool's calls from a persona's transcript (a runner-side script, so the
 * plan's `replies` stays as it is). Slack side: the human session
 * posts and waits for a persona's answer with a deadline.
 *
 * Also the plan's Part 2 procedures: a confirmed config edit (2.2) and the
 * guarded restart (2.3), each returning findings to assert on.
 */

// The two src/ modules below import nothing, so the runner loads no Slack SDK
// or agent-director client on the host; no other src/ module is imported here.
import { DESTRUCTIVE_PREFIX, REMOVED_RETIRED_CLAUSE } from '../../src/reload-preview-clauses.ts'
import { startupSummaryEnding, type StartupSummaryEndingCounts } from '../../src/startup-summary-ending.ts'
import { CONTAINER_STATE_DIR } from '../lib/live-config.ts'
import { isFrom, messageText, type HumanSession, type SlackMessage } from '../lib/human-session.ts'
import { personaName, type PersonaLetter } from '../lib/personas.ts'
import { waitFor, BRINGUP_TIMEOUT_MS, POLL_MS, RELOAD_TIMEOUT_MS, REPLY_TIMEOUT_MS, SECOND } from '../lib/wait.ts'
import type { CheckContext } from './context.ts'
import { Findings } from './framework.ts'

export const S = CONTAINER_STATE_DIR

// ---------------------------------------------------------------------------
// Container commands
// ---------------------------------------------------------------------------

/** What the container commands need of a check's context (the prompt guard has only this much). */
export type InContainer = Pick<CheckContext, 'container'>

/** Run a helper-loaded script; stdout lines (empty lines dropped). Exit status is ignored. */
export async function lines(ctx: InContainer, script: string, timeoutMs?: number): Promise<string[]> {
  const r = await ctx.container.sh(script, { timeoutMs })
  return r.stdout.split('\n').filter((l) => l.trim() !== '')
}

/** Run a helper-loaded script; its exit code and output. */
export async function run(ctx: InContainer, script: string, timeoutMs?: number): Promise<{ code: number; out: string; err: string }> {
  const r = await ctx.container.sh(script, { timeoutMs })
  return { code: r.code, out: r.stdout, err: r.stderr }
}

/** Shell-quote a value for a script (single quotes). */
export function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export async function mark(ctx: CheckContext): Promise<string> {
  const out = (await lines(ctx, 'mark'))[0] ?? ''
  if (!/^\d+:\d+$/.test(out)) throw new Error('mark: server.log has no mark (does it exist?)')
  return out
}

export async function tmark(ctx: CheckContext): Promise<number> {
  return Number((await lines(ctx, 'tmark'))[0] ?? '0')
}

export async function since(ctx: CheckContext, m: string): Promise<string[]> {
  return lines(ctx, `since ${q(m)}`)
}

/** `since MARK | grep -F TEXT`. */
export async function sinceGrep(ctx: CheckContext, m: string, fixed: string): Promise<string[]> {
  return lines(ctx, `since ${q(m)} | grep -F -- ${q(fixed)}`)
}

/** `since MARK | grep -E RE`. */
export async function sinceGrepE(ctx: CheckContext, m: string, re: string): Promise<string[]> {
  return lines(ctx, `since ${q(m)} | grep -E -- ${q(re)}`)
}

export async function tags(ctx: CheckContext, letter: PersonaLetter, ts: string): Promise<string[]> {
  return lines(ctx, `tags ${letter} ${q(ts)}`)
}

/** How long a delivery may take to show in the persona's transcript. */
export const TAG_TIMEOUT_MS = 60 * SECOND

/**
 * `tags LETTER TS`, polled until it prints (or the deadline passes), then
 * read once more a poll later, so a late duplicate delivery is counted too.
 */
export async function waitTags(ctx: CheckContext, letter: PersonaLetter, ts: string, timeoutMs = TAG_TIMEOUT_MS): Promise<string[]> {
  const first = await waitFor(async () => ((await tags(ctx, letter, ts)).length > 0 ? true : null), { timeoutMs, intervalMs: POLL_MS, clock: ctx.clock })
  if (first === null) return []
  await ctx.clock.sleep(POLL_MS)
  return tags(ctx, letter, ts)
}

export async function tagstext(ctx: CheckContext, letter: PersonaLetter, text: string): Promise<string[]> {
  return lines(ctx, `tagstext ${letter} ${q(text)}`)
}

export async function replies(ctx: CheckContext, letter: PersonaLetter): Promise<string[]> {
  return lines(ctx, `replies ${letter}`)
}

/**
 * One call of a session tool in a persona's transcript, as `toolCalls`
 * projects it: the inputs a check reads and how the call ended. An accepted
 * call's result (message text Slack returned, a stored-choice summary) is
 * never read.
 */
export interface ToolCall {
  /** The conversation the call named: its `chat_id` input, or `channel` (fetch_messages, set_channel_delivery); '' when neither. */
  channel: string
  /** Its `message_id` input (react, edit_message), or null. */
  ts: string | null
  /** Whether a non-empty `thread_ts` input was given. */
  threadTs: boolean
  /** Its `delivery` input (set_channel_delivery), or null. */
  delivery: string | null
  /** `ok` (the server returned no error), `error`, or `none` (no result in the transcript yet). */
  outcome: 'ok' | 'error' | 'none'
  /** A refused call's tool error text, or null (an accepted call's content is never carried). */
  error: string | null
}

/** The CSCB MCP server's name (src/config.ts's `MCP_SERVER_NAME`): a session tool is `mcp__<server>__<tool>` in a transcript. */
export const CSCB_MCP_SERVER_NAME = 'slack-channel-router'

/**
 * The script `toolCalls` hands the container (b.deo SRI-1505): every call of
 * the CSCB session tool `tool` (named `mcp__<server>__<tool>`; another
 * server's tool of the same name is not one) in persona `letter`'s current
 * transcript, one compact JSON line each, in call order: the projection
 * `ToolCall` describes, with the result matched by its `tool_use_id`. Reads
 * only.
 */
export function toolCallsScript(letter: PersonaLetter, tool: string): string {
  const filter = [
    '[ .[] | select(.type == "assistant") | .message.content | arrays | .[]',
    '  | select(.type? == "tool_use" and .name == ("mcp__" + $server + "__" + $tool)) ] as $calls',
    '| [ .[] | select(.type == "user") | .message.content | arrays | .[] | select(.type? == "tool_result") ] as $results',
    '| $calls[] | . as $c | ($c.input // {}) as $in',
    '| ([ $results[] | select(.tool_use_id == $c.id) ] | first) as $r',
    '| (if $r == null then "none" elif ($r.is_error // false) then "error" else "ok" end) as $outcome',
    '| { channel: (($in.chat_id // $in.channel // "") | tostring),',
    '    ts: (if $in.message_id == null then null else ($in.message_id | tostring) end),',
    '    threadTs: ((($in.thread_ts // "") | tostring) != ""),',
    '    delivery: (if $in.delivery == null then null else ($in.delivery | tostring) end),',
    '    outcome: $outcome,',
    '    error: (if $outcome == "error" then ($r.content | if type == "string" then . elif type == "array" then ([ .[] | .text? // empty ] | join(" ")) else "" end) else null end) }',
  ].join('\n')
  return [
    `t="$(ls -t ~/.claude/projects/*-cscb-live-${letter}/*.jsonl 2>/dev/null | head -1)"`,
    '[ -n "$t" ] || exit 0',
    `jq -cs --arg server ${q(CSCB_MCP_SERVER_NAME)} --arg tool ${q(tool)} ${q(filter)} "$t"`,
  ].join('\n')
}

/** One `toolCalls` line as a `ToolCall`, or null when it is not one. */
function asToolCall(value: unknown): ToolCall | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const outcome = v.outcome === 'ok' || v.outcome === 'error' || v.outcome === 'none' ? v.outcome : null
  if (outcome === null || typeof v.channel !== 'string') return null
  return {
    channel: v.channel,
    ts: typeof v.ts === 'string' ? v.ts : null,
    threadTs: v.threadTs === true,
    delivery: typeof v.delivery === 'string' ? v.delivery : null,
    outcome,
    error: outcome === 'error' && typeof v.error === 'string' ? v.error : null,
  }
}

/** Persona `letter`'s calls of the session tool `tool`, from its current transcript (`toolCallsScript`). */
export async function toolCalls(ctx: InContainer, letter: PersonaLetter, tool: string): Promise<ToolCall[]> {
  return jsonLines<unknown>(await lines(ctx, toolCallsScript(letter, tool))).flatMap((v) => {
    const call = asToolCall(v)
    return call === null ? [] : [call]
  })
}

export interface PromptPost {
  claude_instance_id: string
  channel: string
  ok: boolean
  error: unknown
  slack_ts?: string
  /** The request the prompt is for (one per request; a restart posts an open one again). */
  request_token?: string
  /** When the trail recorded the post (RFC 3339). */
  ts?: string
  /** The prompt's text as posted: its section block (the tool and the command), else its `text`. */
  command?: string | null
}

/**
 * The jq projection of one `cscb.chat_post.attempted` line: the plan's `posts`
 * fields, the message ts, the request token, when it was posted and the
 * command text (the prompt guard reads the same projection).
 */
export const PROMPT_POST_JQ =
  '{claude_instance_id, channel, ok, error, slack_ts, request_token, ts, command: (([.blocks[]? | select(.type? == "section") | .text.text? // empty] | first) // .text)}'

/** Parse jq's compact output lines, skipping any that don't parse. */
export function jsonLines<T>(out: readonly string[]): T[] {
  return out.flatMap((l) => {
    try {
      return [JSON.parse(l) as T]
    } catch {
      return []
    }
  })
}

/** Permission-prompt posts after trail line `tm` (the plan's `posts`, plus the message ts, token, time and command). */
export async function promptPosts(ctx: InContainer, tm: number): Promise<PromptPost[]> {
  const out = await lines(
    ctx,
    `[ -e "$TRAIL" ] && tail -n +"$((${tm} + 1))" "$TRAIL" | jq -cR ${q(`fromjson? | select(type == "object" and .event == "cscb.chat_post.attempted") | ${PROMPT_POST_JQ}`)}`,
  )
  return jsonLines<PromptPost>(out)
}

export interface Row {
  id: string
  persona: string
  state: string
}

export async function rows(ctx: CheckContext): Promise<Row[]> {
  return (await lines(ctx, 'rows')).map((l) => {
    const [id = '', persona = '', state = ''] = l.split(' ')
    return { id, persona, state }
  })
}

/**
 * The row states of a finished row: its agent process is gone. A copy of
 * src/liveness-reading.ts's `AGENT_DIRECTOR_DEAD_STATES` (the checks import
 * no src/ module that loads the agent-director client), pinned by
 * tests/ci-live-checks.test.ts. Every other state is live.
 */
export const NOT_LIVE_ROW_STATES: readonly string[] = ['ended', 'missing']

/** True when a row's state is not live (`NOT_LIVE_ROW_STATES`). */
export function isNotLiveRow(row: Row): boolean {
  return NOT_LIVE_ROW_STATES.includes(row.state)
}

/** A persona's row: its instance id (`cscb_<key>`) and the persona label it carries. */
export function personaRowId(letter: PersonaLetter): string {
  return `cscb_${personaName(letter)}`
}

/**
 * What is wrong with `rows`, judged against one row per persona in `live`,
 * live, and one per persona in `kept`, kept and not live (a removed persona's
 * row: a teardown kills the row and keeps it, b.jg5 SRJ-715, AC 77). Each row
 * has its persona's instance id and persona label; no other row is there.
 * Pure; empty when the rows are as expected.
 */
export function keptRowSetProblems(rows: readonly Row[], live: readonly PersonaLetter[], kept: readonly PersonaLetter[]): string[] {
  const problems: string[] = []
  const expected = [...live.map((l) => ({ l, live: true })), ...kept.map((l) => ({ l, live: false }))]
  for (const { l, live: wantLive } of expected) {
    const id = personaRowId(l)
    const found = rows.filter((r) => r.id === id)
    if (found.length !== 1) {
      problems.push(`${found.length} ${id} row(s), not one`)
      continue
    }
    const row = found[0] as Row
    if (row.persona !== personaName(l)) problems.push(`${id}'s persona label is ${row.persona}, not ${personaName(l)}`)
    if (wantLive && isNotLiveRow(row)) problems.push(`${id} is ${row.state}, not live`)
    if (!wantLive && !isNotLiveRow(row)) problems.push(`${id} is ${row.state}: kept but live, not ${NOT_LIVE_ROW_STATES.join(' or ')}`)
  }
  const ids = new Set(expected.map(({ l }) => personaRowId(l)))
  for (const r of rows.filter((x) => !ids.has(x.id))) problems.push(`an unexpected row ${r.id}`)
  return problems
}

/**
 * True when `line` is a persona teardown's line for a kill of the persona's
 * row that succeeded, the row kept (src/persona-lifecycle.ts, b.jg5 SRJ-715):
 * `[slack] persona teardown of "<name>" (key=<key>): agent-director kill of
 * cscb_<key>: <outcome> after <n> kill(s); the row is kept (b.jg5 SRJ-715)`.
 * A failed kill's line (`… kill of cscb_<key> failed: …`) is not one.
 */
export function isTeardownKeptRowLine(line: string, letter: PersonaLetter): boolean {
  const n = personaName(letter)
  const start = `[slack] persona teardown of "${n}" (key=${n}): agent-director kill of ${personaRowId(letter)}: `
  const at = line.indexOf(start)
  if (at < 0) return false
  return / after \d+ kill\(s\); the row is kept \(b\.jg5 SRJ-715\)$/.test(line.slice(at + start.length).trimEnd())
}

/**
 * Check 27's row judgement after a confirmed removal of `removed` (b.jg5
 * SRJ-715, AC 77: the teardown kills the row and keeps it). `before` is the
 * rows before the removal. The removed persona's row is kept and not live;
 * every other row of `before` is unchanged (its instance id and persona
 * label, still live); no row is added or deleted. Pure; empty when the rows
 * are as expected.
 */
export function removalRowProblems(before: readonly Row[], after: readonly Row[], removed: PersonaLetter): string[] {
  const removedId = personaRowId(removed)
  const problems: string[] = []
  if (!before.some((r) => r.id === removedId)) problems.push(`no ${removedId} row before the removal`)
  const others = before.filter((r) => r.id !== removedId)
  for (const b of others) {
    const found = after.filter((r) => r.id === b.id)
    if (found.length !== 1) {
      problems.push(`${found.length} ${b.id} row(s) after the removal, not one`)
      continue
    }
    const a = found[0] as Row
    if (a.persona !== b.persona) problems.push(`${b.id}'s persona label changed from ${b.persona} to ${a.persona}`)
    if (isNotLiveRow(a)) problems.push(`${b.id} is ${a.state}, not live`)
  }
  const keptRows = after.filter((r) => r.id === removedId)
  if (keptRows.length !== 1) problems.push(`${keptRows.length} ${removedId} row(s) after the removal, not one kept row`)
  else {
    const k = keptRows[0] as Row
    if (k.persona !== personaName(removed)) problems.push(`${removedId}'s persona label is ${k.persona}, not ${personaName(removed)}`)
    if (!isNotLiveRow(k)) problems.push(`${removedId} is ${k.state}: kept but live, not ${NOT_LIVE_ROW_STATES.join(' or ')}`)
  }
  const known = new Set([...others.map((r) => r.id), removedId])
  for (const r of after.filter((x) => !known.has(x.id))) problems.push(`a new row ${r.id} after the removal`)
  return problems
}

/** Run `script` behind the plan's guard; false (and nothing run) when the guard refuses. */
export async function guarded(ctx: InContainer, script: string, timeoutMs?: number): Promise<{ ok: boolean; out: string; err: string; code: number }> {
  const r = await run(ctx, `guard || exit 90\n${script}`, timeoutMs)
  return { ok: r.code !== 90, out: r.out, err: r.err, code: r.code }
}

/** `jq FILTER config.json > tmp && mv tmp config.json`, behind the guard. */
export async function editConfig(ctx: CheckContext, filter: string): Promise<boolean> {
  const r = await guarded(ctx, `jq ${q(filter)} "$S/config.json" > "$S/config.json.tmp" && mv "$S/config.json.tmp" "$S/config.json"`)
  return r.ok && r.code === 0
}

/** Wait until `since MARK | grep -F TEXT` has at least `count` lines. */
export async function waitLog(ctx: CheckContext, m: string, fixed: string, timeoutMs: number, count = 1): Promise<string[] | null> {
  return waitFor(
    async () => {
      const found = await sinceGrep(ctx, m, fixed)
      return found.length >= count ? found : null
    },
    { timeoutMs, intervalMs: POLL_MS, clock: ctx.clock },
  )
}

export async function fileExists(ctx: CheckContext, path: string): Promise<boolean> {
  return (await run(ctx, `[ -e ${path} ]`)).code === 0
}

export async function waitFile(ctx: CheckContext, path: string, timeoutMs: number): Promise<boolean> {
  return (await waitFor(async () => fileExists(ctx, path), { timeoutMs, intervalMs: POLL_MS, clock: ctx.clock })) === true
}

export async function recorded(ctx: CheckContext): Promise<boolean> {
  return (await run(ctx, 'cmp -s "$S/config.json" "$S/config.json.last-applied"')).code === 0
}

export async function serverPid(ctx: CheckContext): Promise<string> {
  return ((await lines(ctx, 'cat "$S/server.pid" 2>/dev/null'))[0] ?? '').trim()
}

/** The count of SLACK_(BOT|APP)_TOKEN names in the server process's environment. */
export async function serverTokenEnvCount(ctx: CheckContext, pid: string): Promise<string> {
  return (await lines(ctx, `tr '\\0' '\\n' < /proc/${Number(pid)}/environ | cut -d= -f1 | grep -cE '^SLACK_(BOT|APP)_TOKEN$'`))[0] ?? '?'
}

/** Pause for a fixed time the plan asks for ("wait two minutes"). */
export async function pause(ctx: CheckContext, ms: number): Promise<void> {
  await ctx.clock.sleep(ms)
}

// ---------------------------------------------------------------------------
// Slack side
// ---------------------------------------------------------------------------

export function needHuman(ctx: Pick<CheckContext, 'human'>): HumanSession {
  if (!ctx.human) throw new Error('no human session (workspace not available)')
  return ctx.human
}

export function bot(ctx: CheckContext, letter: PersonaLetter): { userId: string; botId: string } {
  return { userId: ctx.ids.bots[letter].userId, botId: ctx.ids.bots[letter].botId }
}

/** `<@U…>` for a persona's bot user. */
export function mention(ctx: CheckContext, letter: PersonaLetter): string {
  return `<@${ctx.ids.bots[letter].userId}>`
}

/** Word match, case-insensitive, on word boundaries (hyphenated words included). */
export function hasWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9-])${escaped}([^A-Za-z0-9-]|$)`, 'i').test(text)
}

export interface Exchange {
  ts: string
  reply: SlackMessage | null
}

/** Post as the human, then wait for `letter`'s message containing `word` in the same conversation. */
export async function askAndWait(
  ctx: CheckContext,
  channel: string,
  text: string,
  letter: PersonaLetter,
  word: string,
  timeoutMs = REPLY_TIMEOUT_MS,
): Promise<Exchange> {
  const human = needHuman(ctx)
  const ts = await human.post(channel, text)
  const reply = await human.waitForBotMessage(channel, bot(ctx, letter), ts, (t) => hasWord(t, word), timeoutMs)
  return { ts, reply }
}

/**
 * Every message from any persona bot in `channel` after `after` (threads
 * included: replies in a thread whose parent is at or after `parentsSince`,
 * default `after`).
 */
export async function personaPostsAfter(ctx: CheckContext, channel: string, after: string, parentsSince?: string): Promise<SlackMessage[]> {
  const all = await needHuman(ctx).everythingAfter(channel, after, parentsSince)
  const letters: PersonaLetter[] = ['a', 'b', 'c', 'd']
  return all.filter((m) => letters.some((l) => isFrom(m, bot(ctx, l))))
}

/** True when a message is a CSCB permission prompt (its Allow/Deny blocks). */
export function isPrompt(message: SlackMessage): boolean {
  const text = messageText(message)
  return /permission request/i.test(text) || (/\bAllow\b/.test(text) && /\bDeny\b/.test(text))
}

/** The prompt's resolved state from its text. */
export function promptState(message: SlackMessage): 'allowed' | 'denied' | 'open' | 'other' {
  const text = messageText(message)
  if (text.includes('*Permission* — Allowed')) return 'allowed'
  if (text.includes('*Permission* — Denied by operator')) return 'denied'
  if (/\bAllow\b/.test(text) && /\bDeny\b/.test(text)) return 'open'
  return 'other'
}

/** Click a prompt's button in the web client, then wait for the message to show the decision. */
export async function clickPrompt(
  ctx: Pick<CheckContext, 'browser' | 'ids' | 'human'>,
  channel: string,
  ts: string,
  button: 'Allow' | 'Deny',
  f: Findings,
): Promise<boolean> {
  if (!ctx.browser) throw new Error('no browser (workspace not available)')
  await ctx.browser.clickMessageButton(ctx.ids.teamId, channel, ts, button)
  const want = button === 'Allow' ? 'allowed' : 'denied'
  const updated = await needHuman(ctx).waitForMessageState(channel, ts, (_t, m) => promptState(m) === want, 60 * SECOND)
  return f.expect(updated !== null, `the prompt ${ts} did not update to ${button === 'Allow' ? '*Permission* — Allowed' : '*Permission* — Denied by operator'}`)
}

/** True when a prompt's command text (a trail post's, or a Slack message's) matches `command`. */
export function commandMatches(command: RegExp, text: string | null | undefined): boolean {
  command.lastIndex = 0
  return typeof text === 'string' && command.test(text)
}

/**
 * Wait for the persona's next permission-prompt post after trail line `tm`;
 * with `command`, only its posts whose command text matches it (the prompt
 * the check declared to the prompt guard, not a detour the guard denies).
 */
export async function waitPromptPost(
  ctx: CheckContext,
  tm: number,
  letter: PersonaLetter,
  timeoutMs: number,
  nth = 1,
  command?: RegExp,
): Promise<PromptPost[] | null> {
  const id = `cscb_${personaName(letter)}`
  return waitFor(
    async () => {
      const posts = (await promptPosts(ctx, tm)).filter((p) => p.claude_instance_id === id && (command === undefined || commandMatches(command, p.command)))
      return posts.length >= nth ? posts : null
    },
    { timeoutMs, intervalMs: POLL_MS, clock: ctx.clock },
  )
}

// ---------------------------------------------------------------------------
// Part 2.2: a confirmed config edit
// ---------------------------------------------------------------------------

/** `config.json.pending` split into its header lines and the preview lines. */
export interface Pending {
  header: string
  fingerprint: string
  preview: string[]
}

export const PENDING_HEADER = 'claude-slack-channel-bots: pending configuration change (written by the server)'

export function parsePending(text: string): Pending | null {
  const all = text.split('\n')
  if (all.length < 4 || all[2] !== '') return null
  return { header: all[0] ?? '', fingerprint: all[1] ?? '', preview: all.slice(3).filter((l) => l !== '') }
}

/** Wait for `config.json.pending` and read it through `showpending` (only shown when it holds no token-shaped text). */
export async function waitPending(ctx: CheckContext, timeoutMs = RELOAD_TIMEOUT_MS): Promise<Pending | null> {
  const text = await waitFor(
    async () => {
      const r = await run(ctx, 'showpending')
      return r.code === 0 ? r.out : null
    },
    { timeoutMs, intervalMs: POLL_MS, clock: ctx.clock },
  )
  return text === null ? null : parsePending(text)
}

/** The counts field of a preview header / applied line. */
export function countsText(c: Partial<Record<'added' | 'removed' | 'destructive' | 'in_place' | 'credentials' | 'settings', number>>): string {
  return (
    `personas: ${c.added ?? 0} added, ${c.removed ?? 0} removed, ${c.destructive ?? 0} destructively modified, ` +
    `${c.in_place ?? 0} modified in place, ${c.credentials ?? 0} with changed credentials; ` +
    `server-wide settings: ${c.settings ?? 0} changed`
  )
}

export function previewHeader(counts: Parameters<typeof countsText>[0]): string {
  return `A configuration change is pending; nothing has been applied. ${countsText(counts)}.`
}

/**
 * A persona's removal line in the reload preview, as src/reload-plan.ts's
 * `removedLine` renders it (b.jg5 SRJ-1510): `DESTRUCTIVE: persona "<name>"
 * (key=<key>) is removed: the persona will be retired: its session stopped
 * and never resumed.`. The prefix and the retired clause are src/'s own
 * (`src/reload-preview-clauses.ts`); the persona reference is the checks'
 * name-and-key form.
 */
export function removedPreviewLine(letter: PersonaLetter): string {
  const n = personaName(letter)
  return `${DESTRUCTIVE_PREFIX} persona "${n}" (key=${n}) is removed: ${REMOVED_RETIRED_CLAUSE}.`
}

export function appliedLine(counts: Parameters<typeof countsText>[0]): string {
  return (
    `[slack] reload-applied: applied the confirmed configuration change without a restart (${countsText(counts)}); ` +
    `the last-applied record "${S}/config.json.last-applied" now holds it`
  )
}

export interface EditOutcome {
  pending: Pending | null
  appliedLines: string[]
}

/**
 * Part 2.2: apply a `jq` edit to config.json, read the preview, compare it
 * with `expectPreview`, confirm by the rename, and wait for the
 * `reload-applied` line. Findings record every mismatch.
 */
export async function confirmedEdit(
  ctx: CheckContext,
  f: Findings,
  m: string,
  filter: string,
  expectPreview: string[],
): Promise<EditOutcome> {
  if (!f.expect(await editConfig(ctx, filter), 'the guarded config edit did not run')) return { pending: null, appliedLines: [] }
  const pending = await waitPending(ctx)
  if (!f.expect(pending !== null, 'config.json.pending did not appear (or held token-shaped text)')) return { pending, appliedLines: [] }
  checkPreview(f, pending as Pending, expectPreview)
  const confirmed = await guarded(ctx, 'mv "$S/config.json.pending" "$S/config.json.apply"')
  f.expect(confirmed.ok && confirmed.code === 0, 'the confirming rename did not run')
  const applied = (await waitLog(ctx, m, '[slack] reload-applied:', RELOAD_TIMEOUT_MS)) ?? []
  f.expect(applied.length === 1, `expected one reload-applied line, found ${applied.length}`)
  return { pending, appliedLines: applied }
}

export function checkPreview(f: Findings, pending: Pending, expect: string[]): void {
  f.expect(pending.header === PENDING_HEADER, 'config.json.pending has another first line')
  f.expect(/^fingerprint: sha256:[0-9a-f]{64}$/.test(pending.fingerprint), 'config.json.pending has no sha256 fingerprint line')
  f.expect(
    JSON.stringify(pending.preview) === JSON.stringify(expect),
    `the preview is not as expected (got ${pending.preview.length} line(s): ${pending.preview.join(' / ').slice(0, 400)})`,
  )
}

// ---------------------------------------------------------------------------
// Part 2.3: the guarded restart
// ---------------------------------------------------------------------------

export const START_FAILURE_RE = '\\) not brought up:|persona-(credentials|directory)-|persona-slack-unreachable'

/**
 * A start's `startupSessionManager: complete` line's ending, from the failed
 * count on, as src/'s builder writes it (`startupSummaryEnding`,
 * `src/startup-summary-ending.ts`; b.f2b, b.jg5 SRJ-1015): every count 0
 * except the ones given.
 */
export function startSummaryEnding(counts: Partial<StartupSummaryEndingCounts> = {}): string {
  return startupSummaryEnding({
    failed: 0,
    notBroughtUp: 0,
    notReconnected: 0,
    latched: 0,
    retrying: 0,
    sequenceWaiting: 0,
    held: 0,
    freshRetired: 0,
    ...counts,
  })
}

/**
 * How a clean start's `startupSessionManager: complete` line ends: no launch
 * failed, every persona was brought up, none was left running but not
 * reconnected (b.f2b), and none was latched, left retrying, waiting on a
 * live-row sequence, held on invalid flags or brought up fresh as a retired
 * key (SRJ-1015's five counts). Built by src/'s builder with every count 0
 * (`startSummaryEnding`). Only this current ending is accepted: the start
 * under test is always this package's.
 */
export const START_SUMMARY_END = startSummaryEnding()

/**
 * Wait for the start's summary line and a Session connected line per persona,
 * since `m`. The summary alone is not enough: a persona whose launch waits on
 * a `working` row is parked (b.f2b), left out of the summary's counts, and
 * connects after it (about 60 s after, when the row is stale).
 */
export async function waitBringUp(ctx: CheckContext, m: string, letters: readonly PersonaLetter[], timeoutMs = BRINGUP_TIMEOUT_MS): Promise<boolean> {
  const ok = await waitFor(
    async () => {
      const found = await sinceGrepE(ctx, m, 'startupSessionManager: complete|Session connected: persona')
      const complete = found.some((l) => l.includes('startupSessionManager: complete'))
      const connected = letters.every((l) => found.some((x) => x.includes(`Session connected: persona "${personaName(l)}" (key=${personaName(l)})`)))
      return complete && connected
    },
    { timeoutMs, intervalMs: POLL_MS, clock: ctx.clock },
  )
  return ok === true
}

/**
 * A persona the start did not bring up that came up through its bring-up
 * retry: it logged `[slack] persona "<name>" (key=<key>): up after its
 * bring-up retry (<via>) — launching` (src/persona-bringup-controller.ts)
 * and, after that, its Session connected line.
 */
export interface RetriedBringUp {
  letter: PersonaLetter
  /** What the retry waited on: `Slack` or `directory`. */
  via: string
  /** Where the up-after-retry line is in the start's lines. */
  upAt: number
}

/** The personas among `letters` that came up after their bring-up retry and then connected, in `log` (a start's lines, in order). */
export function retriedBringUps(log: readonly string[], letters: readonly PersonaLetter[]): RetriedBringUp[] {
  return letters.flatMap((letter) => {
    const n = personaName(letter)
    const up = `[slack] persona "${n}" (key=${n}): up after its bring-up retry (`
    const upAt = log.findIndex((l) => l.includes(up) && l.trimEnd().endsWith(') — launching'))
    if (upAt < 0) return []
    const via = /up after its bring-up retry \(([^)]*)\) — launching/.exec(log[upAt] ?? '')?.[1] ?? ''
    const connected = log.slice(upAt + 1).some((l) => l.includes(`[slack] Session connected: persona "${n}" (key=${n})`))
    return connected ? [{ letter, via, upAt }] : []
  })
}

/**
 * The failure-line class a retry of `via` clears, for the ones accepted as a
 * transient: Slack unreachable for a `Slack` retry (run 6's reboot). None for
 * another retry (a working directory missing after a reboot is no transient),
 * and never a credentials class.
 */
export function retryFailureClass(via: string): RegExp | null {
  return via === 'Slack' ? /\] persona-slack-unreachable: / : null
}

/** Options of `checkStartLines`. */
export interface StartLineOptions {
  /**
   * Accept a persona the start did not bring up when it then came up through
   * its bring-up retry and connected (`retriedBringUps`; Check 28's reboot,
   * where Slack can be unreachable for a moment): the summary may count each
   * in `not brought up`, and that persona's failure lines of its retry's
   * class, up to its up-after-retry line, are no finding. Each is a note that
   * starts with this label.
   */
  acceptRetried?: string
}

/** Assert the plan's Part 2.3 expected items on a start's lines since `m`. */
export async function checkStartLines(
  ctx: CheckContext,
  f: Findings,
  m: string,
  letters: readonly PersonaLetter[],
  fromRecord: boolean,
  options: StartLineOptions = {},
): Promise<void> {
  const all = await since(ctx, m)
  const has = (s: string) => all.filter((l) => l.includes(s))
  if (fromRecord) {
    f.expect(has(`[slack] Starting from the last-applied record "${S}/config.json.last-applied"`).length === 1, 'no single "Starting from the last-applied record" line')
    f.expect(has('[slack] No last-applied record').length === 0, 'a "No last-applied record" line appeared')
  }
  letters.forEach((l, i) => {
    const n = personaName(l)
    f.expect(has(`[slack] persona-start: personas[${i}] "${n}" (key=${n}): bring-up starting`).length === 1, `no single persona-start line for ${n}`)
    f.expect(has(`[slack] Session connected: persona "${n}" (key=${n})`).length >= 1, `no Session connected line for ${n}`)
  })
  const complete = has(`[slack] startupSessionManager: complete — ${letters.length} persona(s):`)
  f.expect(complete.length === 1, `expected one startupSessionManager complete line for ${letters.length} personas, found ${complete.length}`)
  const summary = complete[0]?.trimEnd()
  // The leading space keeps "10 failed, …" from passing as "0 failed, …".
  const endsWith = (ending: string) => summary !== undefined && summary.endsWith(` ${ending}`)
  // A retried persona is accepted only when the summary counts exactly the retried ones as not brought up.
  const retried = options.acceptRetried === undefined ? [] : retriedBringUps(all, letters).filter((r) => retryFailureClass(r.via) !== null)
  const acceptRetried = retried.length > 0 && endsWith(startSummaryEnding({ notBroughtUp: retried.length }))
  // Then their own failure lines of their retry's class, up to the retry, are the transient it recovered from.
  const accepted = new Set<number>()
  if (acceptRetried) {
    for (const r of retried) {
      const n = personaName(r.letter)
      const cls = retryFailureClass(r.via) as RegExp
      all.forEach((l, i) => {
        if (i < r.upAt && cls.test(l) && l.includes(` "${n}" (key=${n})`)) accepted.add(i)
      })
      const cause = all.find((l, i) => accepted.has(i) && l.includes(` "${n}" (key=${n})`) && !l.includes(': cleared: '))
      const why = cause ? ` (${cause.replace(/^.*?\] (persona-[a-z-]+): .*?: /, '$1: ')})` : ''
      f.note(`${options.acceptRetried}: ${n} was not brought up at the start${why}, then was up after its bring-up retry (${r.via}) and connected: a transient the server recovered from, accepted`)
    }
  }
  if (summary !== undefined) {
    f.add(complete[0] as string)
    f.expect(acceptRetried || endsWith(START_SUMMARY_END), `the start summary does not end "${START_SUMMARY_END}"`)
  }
  const failures = all.filter((l, i) => new RegExp(START_FAILURE_RE).test(l) && !accepted.has(i))
  f.expect(failures.length === 0, `start failure lines: ${failures.slice(0, 3).join(' / ')}`)
}

/** Part 2.3: stop, start, wait for bring-up, check the start and the record. */
export async function guardedRestart(ctx: CheckContext, f: Findings, letters: readonly PersonaLetter[] = ['a', 'b', 'c']): Promise<string | null> {
  const stop = await guarded(ctx, 'claude-slack-channel-bots stop', 120_000)
  if (!f.expect(stop.ok, 'guarded restart: the guard refused the stop')) return null
  const m = await mark(ctx)
  const start = await guarded(ctx, 'claude-slack-channel-bots start', 180_000)
  f.expect(start.ok && start.code === 0, `guarded restart: start exited ${start.code}`)
  const up = await waitBringUp(ctx, m, letters)
  f.expect(up, 'guarded restart: the start summary or a Session connected line did not appear in time')
  await checkStartLines(ctx, f, m, letters, true)
  f.expect(await recorded(ctx), 'guarded restart: config.json and the record differ')
  await pause(ctx, 10 * SECOND)
  f.expect(!(await fileExists(ctx, '"$S/config.json.pending"')), 'guarded restart: config.json.pending exists after the start')
  return m
}
