/**
 * reaction-checks.ts — Reaction Notices (Idea b.n3k) against the test
 * workspace, with persona A in A-home. Not part of the testplan's Results
 * table (`row: null`); run them with `--only RN1,RN2,RN3,RN4,RN5,RN6`.
 *
 * - RN1: the human adds, then removes, ✅ on A's `reply` post: one notice
 *   each (`via="reaction"`, `reaction="added"`/`"removed"`, the human as
 *   `user_id`, the post's ts as `message_id`).
 * - RN2: the same in a thread: the notice carries the thread's `thread_ts`.
 * - RN3: ✅ on a file A posted with `reply`'s `files`: a notice.
 * - RN4: ✅ on A's permission prompt, once decided (its buttons gone, so only
 *   the Server Post Marker marks it): the marker reads back with
 *   `include_all_metadata`, the item is withdrawn (`reason=server-post`) and
 *   no notice arrives.
 * - RN5: `reaction_notices: false` for A (a confirmed edit): ✅ on A's post
 *   is dropped (`reason=notices-off`) and no notice arrives; the setting is
 *   removed again afterwards.
 * - RN6: fungible mode (`switchOnFilter`, a confirmed edit): ✅ added then
 *   removed on A's post in A-home, a real envelope's `is_ext_shared_channel`
 *   deciding; config.json is restored afterwards.
 *
 * Notices are read from A's transcript (the tag is typed there); the
 * server's `reaction-received` / `reaction-withdrawn` / `reaction-dropped`
 * lines are read from server.log. Config edits are confirmed without
 * comparing the preview (it is recorded as evidence).
 */

import { switchOnFilter } from '../lib/live-config.ts'
import { type SlackMessage } from '../lib/human-session.ts'
import { MINUTE, POLL_MS, RELOAD_TIMEOUT_MS, REPLY_TIMEOUT_MS, waitFor } from '../lib/wait.ts'
import { tagAttr } from './channel-checks.ts'
import type { CheckContext } from './context.ts'
import { Findings, type CheckDef } from './framework.ts'
import {
  askAndWait,
  bot,
  clickPrompt,
  commandMatches,
  guarded,
  hasWord,
  isPrompt,
  lines,
  mark,
  mention,
  needHuman,
  pause,
  q,
  sinceGrep,
  waitLog,
  waitPending,
} from './helpers.ts'

const LIVE: ['workspace', 'claude'] = ['workspace', 'claude']
const EMOJI = 'white_check_mark'
/** How long a notice may take to reach A's transcript (it waits for A to be idle). */
const NOTICE_TIMEOUT_MS = 4 * MINUTE
/** How long a notice that must not come is waited for. */
const ABSENT_WAIT_MS = 90 * 1000
const A_REF = '"persona_a" (key=persona_a)'

/** Every Reaction Notice tag in A's current transcript for the reacted message `ts`. */
export function noticeTagsScript(ts: string): string {
  return [
    't="$(ls -t ~/.claude/projects/*-cscb-live-a/*.jsonl 2>/dev/null | head -1)"',
    '[ -n "$t" ] || exit 0',
    `jq -r 'if .type == "user" then .message.content
       elif .type == "attachment" and .attachment.type? == "queued_command" then .attachment.prompt
       else empty end
       | if type == "string" then . else (.[]? | .text? // empty) end' "$t" \\`,
    `  | grep -oE '<channel source="slack[^"]*"[^>]*>' | grep -F ' via="reaction"' | grep -F -- ${q(` message_id="${ts}"`)}`,
  ].join('\n')
}

async function noticeTags(ctx: CheckContext, ts: string, change?: 'added' | 'removed'): Promise<string[]> {
  const found = await lines(ctx, noticeTagsScript(ts))
  return change === undefined ? found : found.filter((t) => tagAttr(t, 'reaction') === change)
}

/** Wait for a notice of `change` on `ts`, then read once more a poll later (a duplicate counts). */
async function waitNotice(ctx: CheckContext, ts: string, change: 'added' | 'removed'): Promise<string[]> {
  const first = await waitFor(async () => ((await noticeTags(ctx, ts, change)).length > 0 ? true : null), {
    timeoutMs: NOTICE_TIMEOUT_MS,
    intervalMs: POLL_MS,
    clock: ctx.clock,
  })
  if (first === null) return []
  await ctx.clock.sleep(POLL_MS)
  return noticeTags(ctx, ts, change)
}

/** The thread a post sits in, or undefined for a top-level post. */
function threadOf(m: SlackMessage): string | undefined {
  return m.thread_ts !== undefined && m.thread_ts !== m.ts ? m.thread_ts : undefined
}

/** One notice of `change` on A's post `post` in `channel`, its attributes as the PRD tags it. */
function expectNotice(f: Findings, ctx: CheckContext, found: string[], what: string, channel: string, post: SlackMessage, change: 'added' | 'removed'): void {
  f.add(`${what}: ${found.length} notice tag(s)${found[0] ? `: ${found[0]}` : ''}`)
  if (!f.expect(found.length === 1, `${what}: expected exactly one ${change} notice, found ${found.length}`)) return
  const tag = found[0] as string
  const want: Record<string, string | null> = {
    chat_id: channel,
    message_id: post.ts,
    user_id: ctx.ids.humanUserId,
    via: 'reaction',
    reaction: change,
    emoji: EMOJI,
    thread_ts: threadOf(post) ?? null,
  }
  for (const [k, v] of Object.entries(want)) f.expect(tagAttr(tag, k) === v, `${what}: ${k} is ${tagAttr(tag, k) ?? 'absent'}, not ${v ?? 'absent'}`)
  f.expect(tagAttr(tag, 'bot_id') === null, `${what}: the tag carries a bot_id`)
  f.expect(/^\d{9,11}\.\d{6}$/.test(tagAttr(tag, 'ts') ?? ''), `${what}: the tag has no reaction ts`)
  f.expect(/<channel [^>]*>$/.test(tag), `${what}: not an opening tag`)
}

/** A's `reaction-received` lines since `m` for `ts` and `change`. */
async function receivedLines(ctx: CheckContext, m: string, channel: string, ts: string, change: 'added' | 'removed'): Promise<string[]> {
  return (await sinceGrep(ctx, m, `[slack] reaction-received: persona=${A_REF} chat_id="${channel}" message_ts="${ts}" change=${change} `))
}

/** Every reaction drop/withdraw/unknown line for A since `m` (evidence for a failure). */
async function otherReactionLines(ctx: CheckContext, m: string): Promise<string[]> {
  return lines(ctx, `since ${q(m)} | grep -E -- ${q(`\\[slack\\] (reaction-dropped|reaction-withdrawn|reaction-message-unknown): persona=${A_REF.replace(/[()]/g, '\\$&')}`)}`)
}

/** Add then remove ✅ on `post`, expecting one notice each. */
async function addThenRemove(ctx: CheckContext, f: Findings, m: string, channel: string, post: SlackMessage, what: string): Promise<void> {
  const human = needHuman(ctx)
  await human.react(channel, post.ts, EMOJI)
  const added = await waitNotice(ctx, post.ts, 'added')
  expectNotice(f, ctx, added, `${what} added`, channel, post, 'added')
  await human.unreact(channel, post.ts, EMOJI)
  const removed = await waitNotice(ctx, post.ts, 'removed')
  expectNotice(f, ctx, removed, `${what} removed`, channel, post, 'removed')
  for (const change of ['added', 'removed'] as const) {
    const got = await receivedLines(ctx, m, channel, post.ts, change)
    f.add(`server.log: ${got[0] ?? `(no reaction-received line, change=${change})`}`)
    f.expect(got.length >= 1, `${what}: no reaction-received line for change=${change}`)
  }
  const other = await otherReactionLines(ctx, m)
  for (const l of other) f.add(`server.log: ${l}`)
}

/** Ask A in `channel` to answer with `word`; A's post, or null (a finding). */
async function aPost(ctx: CheckContext, f: Findings, channel: string, text: string, word: string): Promise<SlackMessage | null> {
  const x = await askAndWait(ctx, channel, text, 'a', word)
  f.add(`asked ${channel} ${x.ts}${x.reply ? `; A's post ${x.reply.ts}${threadOf(x.reply) ? ` in thread ${threadOf(x.reply)}` : ''}` : ''}`)
  return f.expect(x.reply !== null, `A did not answer with "${word}" in time`) ? x.reply : null
}

/**
 * A config edit (`script`, behind the guard) confirmed by the rename, without
 * comparing the preview (recorded as evidence); waits for `reload-applied` or
 * `reload-noop`.
 */
async function confirmLoose(ctx: CheckContext, f: Findings, what: string, script: string): Promise<boolean> {
  const m = await mark(ctx)
  const edit = await guarded(ctx, script)
  if (!f.expect(edit.ok && edit.code === 0, `${what}: the guarded config edit did not run`)) return false
  const pending = await waitPending(ctx)
  if (!f.expect(pending !== null, `${what}: config.json.pending did not appear`)) return false
  f.add(`${what} preview: ${pending!.preview.join(' / ').slice(0, 600)}`)
  const confirmed = await guarded(ctx, 'mv "$S/config.json.pending" "$S/config.json.apply"')
  if (!f.expect(confirmed.ok && confirmed.code === 0, `${what}: the confirming rename did not run`)) return false
  const applied = await waitFor(
    async () => {
      const got = await lines(ctx, `since ${q(m)} | grep -E -- ${q('\\[slack\\] reload-(applied|noop):')}`)
      return got.length > 0 ? got : null
    },
    { timeoutMs: RELOAD_TIMEOUT_MS, intervalMs: POLL_MS, clock: ctx.clock },
  )
  f.add(`${what}: ${applied?.[0]?.slice(0, 300) ?? '(no reload-applied line)'}`)
  return f.expect(applied !== null, `${what}: no reload-applied or reload-noop line`)
}

export const rn1: CheckDef<CheckContext> = {
  id: 'RN1',
  title: "RN1: ✅ added then removed on A's post: one Reaction Notice each",
  needs: LIVE,
  row: null,
  async run(ctx) {
    const f = new Findings()
    const m = await mark(ctx)
    const post = await aPost(ctx, f, ctx.ids.aHome, 'Reply here with the word ember.', 'ember')
    if (post) await addThenRemove(ctx, f, m, ctx.ids.aHome, post, 'RN1')
    return f.result()
  },
}

export const rn2: CheckDef<CheckContext> = {
  id: 'RN2',
  title: "RN2: ✅ on A's post in a thread: the notice carries thread_ts",
  needs: LIVE,
  row: null,
  async run(ctx) {
    const f = new Findings()
    const m = await mark(ctx)
    const human = needHuman(ctx)
    const top = await human.post(ctx.ids.aHome, 'Reply in the thread of this message (reply tool with thread_ts set to this message) with the word cobalt.')
    const reply = await human.waitForBotMessage(ctx.ids.aHome, bot(ctx, 'a'), top, (t, msg) => hasWord(t, 'cobalt') && threadOf(msg) === top, REPLY_TIMEOUT_MS)
    f.add(`asked ${ctx.ids.aHome} ${top}${reply ? `; A's threaded post ${reply.ts} in thread ${reply.thread_ts}` : ''}`)
    if (!f.expect(reply !== null, 'A did not answer with "cobalt" in the thread in time')) return f.result()
    await human.react(ctx.ids.aHome, reply!.ts, EMOJI)
    const added = await waitNotice(ctx, reply!.ts, 'added')
    expectNotice(f, ctx, added, 'RN2 added', ctx.ids.aHome, reply!, 'added')
    const got = await receivedLines(ctx, m, ctx.ids.aHome, reply!.ts, 'added')
    f.add(`server.log: ${got[0] ?? '(no reaction-received line)'}`)
    for (const l of await otherReactionLines(ctx, m)) f.add(`server.log: ${l}`)
    return f.result()
  },
}

/** The file RN3 asks A to post, in A's working directory. */
export const RN3_FILE = 'rn-file.txt'

export const rn3: CheckDef<CheckContext> = {
  id: 'RN3',
  title: 'RN3: ✅ on a file A posted with the reply tool: a notice',
  needs: LIVE,
  row: null,
  async run(ctx) {
    const f = new Findings()
    const m = await mark(ctx)
    const human = needHuman(ctx)
    const made = await guarded(ctx, `printf 'reaction notice file probe\\n' > ~/cscb-live/a/${RN3_FILE}`)
    if (!f.expect(made.ok && made.code === 0, `could not write ~/cscb-live/a/${RN3_FILE}`)) return f.result()
    const asked = await human.post(
      ctx.ids.aHome,
      `Use the reply tool to post the existing file ${RN3_FILE} from your working directory to this channel (files parameter, absolute path) with the text quartz. Do not create or change any file.`,
    )
    const filePost = await human.waitForBotMessage(ctx.ids.aHome, bot(ctx, 'a'), asked, (_t, msg) => (msg.files?.length ?? 0) > 0, REPLY_TIMEOUT_MS)
    f.add(`asked ${ctx.ids.aHome} ${asked}${filePost ? `; A's file post ${filePost.ts}${threadOf(filePost) ? ` in thread ${threadOf(filePost)}` : ''}` : ''}`)
    if (!f.expect(filePost !== null, "no file post from A in time")) return f.result()
    await human.react(ctx.ids.aHome, filePost!.ts, EMOJI)
    const added = await waitNotice(ctx, filePost!.ts, 'added')
    expectNotice(f, ctx, added, 'RN3 added', ctx.ids.aHome, filePost!, 'added')
    const got = await receivedLines(ctx, m, ctx.ids.aHome, filePost!.ts, 'added')
    f.add(`server.log: ${got[0] ?? '(no reaction-received line)'}`)
    for (const l of await otherReactionLines(ctx, m)) f.add(`server.log: ${l}`)
    return f.result()
  },
}

/** RN4's prompt, as declared to the prompt guard. */
export const RN4_PROMPT = /rn-prompt\.txt/

export const rn4: CheckDef<CheckContext> = {
  id: 'RN4',
  title: "RN4: ✅ on A's decided permission prompt (a fresh Server Post): no notice",
  needs: LIVE,
  row: null,
  async run(ctx) {
    const f = new Findings()
    const human = needHuman(ctx)
    ctx.promptGuard.expect({ persona: 'a', command: RN4_PROMPT })
    const asked = await human.post(ctx.ids.aHome, 'Run a shell command that writes the current date to a file named rn-prompt.txt in your working directory.')
    const prompt = await human.waitForBotMessage(ctx.ids.aHome, bot(ctx, 'a'), asked, (t, msg) => isPrompt(msg) && commandMatches(RN4_PROMPT, t), REPLY_TIMEOUT_MS)
    if (!f.expect(prompt !== null, 'no permission prompt from A in A-home')) return f.result()
    f.add(`prompt: ${ctx.ids.aHome} ${prompt!.ts}`)
    if (!(await clickPrompt(ctx, ctx.ids.aHome, prompt!.ts, 'Allow', f))) return f.result()
    const marker = await human.metadataEventType(ctx.ids.aHome, prompt!.ts)
    f.add(`metadata.event_type read back with include_all_metadata: ${marker ?? '(none)'}`)
    f.expect(marker === 'cscb_server_post', `the decided prompt's metadata.event_type is ${marker ?? 'absent'}, not cscb_server_post`)
    const decided = await human.message(ctx.ids.aHome, prompt!.ts)
    f.expect(decided !== null && !isPromptOpen(decided), 'the prompt still shows its buttons')
    const m = await mark(ctx)
    await human.react(ctx.ids.aHome, prompt!.ts, EMOJI)
    const withdrawn = await waitLog(ctx, m, `[slack] reaction-withdrawn: persona=${A_REF} chat_id="${ctx.ids.aHome}" message_ts="${prompt!.ts}" reason=server-post`, NOTICE_TIMEOUT_MS)
    f.add(`server.log: ${withdrawn?.[0] ?? '(no reaction-withdrawn line)'}`)
    f.expect(withdrawn !== null, 'no reaction-withdrawn reason=server-post line')
    const got = await receivedLines(ctx, m, ctx.ids.aHome, prompt!.ts, 'added')
    f.add(`server.log: ${got[0] ?? '(no reaction-received line)'}`)
    await pause(ctx, ABSENT_WAIT_MS)
    const tags = await noticeTags(ctx, prompt!.ts)
    f.add(`notice tags for the prompt after ${ABSENT_WAIT_MS / 1000} s: ${tags.length}`)
    f.expect(tags.length === 0, `a Reaction Notice arrived for the prompt: ${tags[0] ?? ''}`)
    for (const l of await otherReactionLines(ctx, m)) f.add(`server.log: ${l}`)
    return f.result()
  },
}

/** An open prompt still has Allow and Deny. */
function isPromptOpen(m: SlackMessage): boolean {
  return isPrompt(m) && JSON.stringify(m.blocks ?? []).includes('"actions"')
}

/** jq over `.personas`: A's `reaction_notices` set to `value`, or removed (`null`). */
function aReactionNoticesFilter(value: boolean | null): string {
  const set = value === null ? 'del(.reaction_notices)' : `.reaction_notices = ${value}`
  return `.personas |= map(if .name == "persona_a" then ${set} else . end)`
}

export const rn5: CheckDef<CheckContext> = {
  id: 'RN5',
  title: "RN5: reaction_notices false for A: ✅ on A's post brings no notice",
  needs: LIVE,
  row: null,
  async run(ctx) {
    const f = new Findings()
    const off = `jq ${q(aReactionNoticesFilter(false))} "$S/config.json" > "$S/config.json.tmp" && mv "$S/config.json.tmp" "$S/config.json"`
    try {
      if (!(await confirmLoose(ctx, f, 'reaction_notices off', off))) return f.result()
      const value = (await lines(ctx, `jq -c '.personas[] | select(.name == "persona_a") | .reaction_notices' "$S/config.json"`))[0]
      f.add(`config.json persona_a reaction_notices: ${value ?? '?'}`)
      const m = await mark(ctx)
      const post = await aPost(ctx, f, ctx.ids.aHome, 'Reply here with the word slate.', 'slate')
      if (!post) return f.result()
      await needHuman(ctx).react(ctx.ids.aHome, post.ts, EMOJI)
      const dropped = await waitLog(ctx, m, `[slack] reaction-dropped: persona=${A_REF} chat_id="${ctx.ids.aHome}" message_ts="${post.ts}" reason=notices-off`, NOTICE_TIMEOUT_MS)
      f.add(`server.log: ${dropped?.[0] ?? '(no reaction-dropped line)'}`)
      f.expect(dropped !== null, 'no reaction-dropped reason=notices-off line')
      await pause(ctx, ABSENT_WAIT_MS)
      const tags = await noticeTags(ctx, post.ts)
      f.add(`notice tags for A's post after ${ABSENT_WAIT_MS / 1000} s: ${tags.length}`)
      f.expect(tags.length === 0, `a Reaction Notice arrived with notices off: ${tags[0] ?? ''}`)
      const received = await receivedLines(ctx, m, ctx.ids.aHome, post.ts, 'added')
      f.expect(received.length === 0, 'a reaction-received line with notices off')
    } finally {
      const on = `jq ${q(aReactionNoticesFilter(null))} "$S/config.json" > "$S/config.json.tmp" && mv "$S/config.json.tmp" "$S/config.json"`
      await confirmLoose(ctx, f, 'reaction_notices restored (unset)', on)
    }
    return f.result()
  },
}

/** Where RN6 copies config.json before its switch-on edit. */
export const RN6_COPY = '~/cscb-live/config-before-rn6.json'

export const rn6: CheckDef<CheckContext> = {
  id: 'RN6',
  title: "RN6: fungible mode: ✅ added then removed on A's post: one notice each",
  needs: LIVE,
  row: null,
  async run(ctx) {
    const f = new Findings()
    const copied = await guarded(ctx, `cp "$S/config.json" ${RN6_COPY}`)
    if (!f.expect(copied.ok && copied.code === 0, 'could not copy config.json')) return f.result()
    try {
      const on = `jq ${q(switchOnFilter(ctx.ids))} "$S/config.json" > "$S/config.json.tmp" && mv "$S/config.json.tmp" "$S/config.json"`
      if (!(await confirmLoose(ctx, f, 'fungible on', on))) return f.result()
      const m = await mark(ctx)
      const post = await aPost(ctx, f, ctx.ids.aHome, `${mention(ctx, 'a')} reply here with the word fungible.`, 'fungible')
      if (post) await addThenRemove(ctx, f, m, ctx.ids.aHome, post, 'RN6')
    } finally {
      await confirmLoose(ctx, f, 'config.json restored', `cp ${RN6_COPY} "$S/config.json"`)
    }
    return f.result()
  },
}

export const REACTION_CHECKS: CheckDef<CheckContext>[] = [rn1, rn2, rn3, rn4, rn5, rn6]
