/**
 * helpers.ts — the testplan's commands as functions a check calls.
 *
 * Container side: every call runs the plan's helper (`mark`, `since`,
 * `tags`, `replies`, `posts` …) in the test container through
 * `ContainerExec.sh`, and every command that starts, stops or changes
 * something runs behind the plan's `guard`. Slack side: the human session
 * posts and waits for a persona's answer with a deadline.
 *
 * Also the plan's Part 2 procedures: a confirmed config edit (2.2) and the
 * guarded restart (2.3), each returning findings to assert on.
 */

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

/** Run a helper-loaded script; stdout lines (empty lines dropped). Exit status is ignored. */
export async function lines(ctx: CheckContext, script: string, timeoutMs?: number): Promise<string[]> {
  const r = await ctx.container.sh(script, { timeoutMs })
  return r.stdout.split('\n').filter((l) => l.trim() !== '')
}

/** Run a helper-loaded script; its exit code and output. */
export async function run(ctx: CheckContext, script: string, timeoutMs?: number): Promise<{ code: number; out: string; err: string }> {
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

export interface PromptPost {
  claude_instance_id: string
  channel: string
  ok: boolean
  error: unknown
  slack_ts?: string
}

/** Permission-prompt posts after trail line `tm` (the plan's `posts`, plus the message ts). */
export async function promptPosts(ctx: CheckContext, tm: number): Promise<PromptPost[]> {
  const out = await lines(
    ctx,
    `[ -e "$TRAIL" ] && tail -n +"$((${tm} + 1))" "$TRAIL" | jq -c 'select(.event == "cscb.chat_post.attempted") | {claude_instance_id, channel, ok, error, slack_ts}'`,
  )
  return out.flatMap((l) => {
    try {
      return [JSON.parse(l) as PromptPost]
    } catch {
      return []
    }
  })
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

/** Run `script` behind the plan's guard; false (and nothing run) when the guard refuses. */
export async function guarded(ctx: CheckContext, script: string, timeoutMs?: number): Promise<{ ok: boolean; out: string; err: string; code: number }> {
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

export function needHuman(ctx: CheckContext): HumanSession {
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
  ctx: CheckContext,
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

/** Wait for the persona's next permission-prompt post after trail line `tm`. */
export async function waitPromptPost(ctx: CheckContext, tm: number, letter: PersonaLetter, timeoutMs: number, nth = 1): Promise<PromptPost[] | null> {
  const id = `cscb_${personaName(letter)}`
  return waitFor(
    async () => {
      const posts = (await promptPosts(ctx, tm)).filter((p) => p.claude_instance_id === id)
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
 * How a clean start's `startupSessionManager: complete` line ends: no launch
 * failed, every persona was brought up, and none was left running but not
 * reconnected (the last bucket, added by b.f2b). Only this current ending is
 * accepted: the start under test is always this package's.
 */
export const START_SUMMARY_END = '0 failed, 0 not brought up, 0 not reconnected'

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

/** Assert the plan's Part 2.3 expected items on a start's lines since `m`. */
export async function checkStartLines(ctx: CheckContext, f: Findings, m: string, letters: readonly PersonaLetter[], fromRecord: boolean): Promise<void> {
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
  if (complete[0]) {
    f.add(complete[0])
    // The leading space keeps "10 failed, …" from passing as "0 failed, …".
    f.expect(complete[0].trimEnd().endsWith(` ${START_SUMMARY_END}`), `the start summary does not end "${START_SUMMARY_END}"`)
  }
  const failures = all.filter((l) => new RegExp(START_FAILURE_RE).test(l))
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
