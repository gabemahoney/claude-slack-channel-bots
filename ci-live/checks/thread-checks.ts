/**
 * thread-checks.ts — thread following (Idea b.k49, `thread_hybrid`) and two
 * shared-list rules of Idea b.tad against the test workspace, in strict mode,
 * with persona A (coordination at `mentions`, A-home at `all`) and B
 * (coordination at `mentions`). Not part of the testplan's Results table
 * (`row: null`); run them with `--only TH1,TH2,TH3,TH4,TH5,TB1,TB2`.
 *
 * - TH1: A's coordination choice goes to `thread_hybrid` (a confirmed edit).
 *   The human starts a thread that mentions nobody; asked in A-home, A replies
 *   in it; the human's later unmentioned reply there reaches A as
 *   `via="thread"` and A answers it. The thread's channel message reaches
 *   neither A nor B, and the reply doesn't reach B.
 * - TH2: an @mention of A in a channel message arrives as `via="mention"`
 *   and A answers in its thread; an unmentioned reply there arrives as
 *   `via="thread"`; an @mention of A in that thread arrives once, as
 *   `via="mention"`; a channel message that mentions nobody doesn't arrive.
 * - TH3: B (at `mentions`) answers in the thread of a message that mentions
 *   it; an unmentioned reply in that thread reaches neither B nor A (a thread
 *   A never joined).
 * - TH4: after a guarded server restart, an unmentioned reply in TH1's
 *   thread still reaches A as `via="thread"`.
 * - TH5: A's choice goes to `mentions` and back to `thread_hybrid`: unmentioned
 *   replies in TH1's and TH2's threads then reach A no more; a new @mention
 *   in TH2's thread puts A back in it.
 * - TH-restore: config.json as TH1 found it (runs under `--only` whenever
 *   any TH check is selected).
 * - TB1: B's coordination choice `off`: an @mention of B doesn't reach it;
 *   B's choice is restored afterwards.
 * - TB2: in strict mode A's `set_channel_delivery` call is refused and A's
 *   saved choice is unchanged.
 *
 * What reached a persona is read from its transcript (`tags`) and server.log
 * (`message-received`). Config edits are confirmed without comparing the
 * preview (it is recorded as evidence); the applied choice is read back from
 * the last-applied record.
 */

import { randomUUID } from 'node:crypto'
import { isFrom } from '../lib/human-session.ts'
import { personaName, type PersonaLetter } from '../lib/personas.ts'
import { MINUTE, REPLY_TIMEOUT_MS, SECOND } from '../lib/wait.ts'
import { expectOneTag } from './channel-checks.ts'
import type { CheckContext } from './context.ts'
import { deliveryLines } from './delivery-evidence.ts'
import { Findings, notRun, pass, type CheckDef } from './framework.ts'
import { SET_CHANNEL_DELIVERY_TOOL } from './invited-checks.ts'
import { confirmLoose } from './reaction-checks.ts'
import {
  askAndWait,
  bot,
  guarded,
  guardedRestart,
  hasWord,
  lines,
  mark,
  mention,
  needHuman,
  pause,
  personaPostsAfter,
  q,
  tags,
  toolCalls,
  waitTags,
} from './helpers.ts'

const LIVE: ['workspace', 'claude'] = ['workspace', 'claude']
type Choice = 'off' | 'mentions' | 'all' | 'thread_hybrid'

/** How long a delivery may take to reach a persona's transcript (it waits for the persona to be idle). */
const TAG_WAIT_MS = 4 * MINUTE
/** How long a message that must not arrive is waited for. */
const ABSENT_WAIT_MS = 90 * SECOND

/** Where TH1 copies config.json before its first edit (TH-restore restores it). */
export const THREAD_CONFIG_COPY = '~/cscb-live/config-before-threads.json'

/** jq over config.json: persona `letter`'s `channel` entry set to `value`. */
export function choiceFilter(letter: PersonaLetter, channel: string, value: Choice): string {
  return `.personas |= map(if .name == ${JSON.stringify(personaName(letter))} then .channels |= map(if .id == ${JSON.stringify(channel)} then .delivery = ${JSON.stringify(value)} else . end) else . end)`
}

/** Persona `letter`'s applied choice for `channel` in `file`'s `.applied` (the last-applied record), or `.` (config.json). */
async function choiceIn(ctx: CheckContext, letter: PersonaLetter, channel: string, file: string, root: string): Promise<string | undefined> {
  const filter = `${root}.personas[] | select(.name == ${JSON.stringify(personaName(letter))}) | .channels[]? | select(.id == ${JSON.stringify(channel)}) | .delivery`
  return (await lines(ctx, `jq -r ${q(filter)} ${file}`))[0]
}

function appliedChoice(ctx: CheckContext, letter: PersonaLetter, channel: string): Promise<string | undefined> {
  return choiceIn(ctx, letter, channel, '"$S/config.json.last-applied"', '.applied | ')
}

/** A confirmed edit of persona `letter`'s choice for `channel`, read back from the last-applied record. */
async function setChoice(ctx: CheckContext, f: Findings, letter: PersonaLetter, channel: string, value: Choice): Promise<boolean> {
  const what = `${personaName(letter)} ${channel} ${value}`
  const script = `jq ${q(choiceFilter(letter, channel, value))} "$S/config.json" > "$S/config.json.tmp" && mv "$S/config.json.tmp" "$S/config.json"`
  if (!(await confirmLoose(ctx, f, what, script))) return false
  const applied = await appliedChoice(ctx, letter, channel)
  f.add(`${what}: applied choice ${applied ?? '(none)'}`)
  return f.expect(applied === value, `${what}: the applied choice is ${applied ?? 'absent'}, not ${value}`)
}

/** One tag for `ts` in `letter`'s transcript with these attributes, from the human, and its `message-received` line. */
async function expectHeard(ctx: CheckContext, f: Findings, m: string, letter: PersonaLetter, channel: string, ts: string, what: string, attrs: Record<string, string>): Promise<void> {
  const found = await waitTags(ctx, letter, ts, TAG_WAIT_MS)
  f.add(`${what}: ${found.length} tag(s)${found[0] ? `: ${found[0]}` : ''}`)
  expectOneTag(f, found, what, { chat_id: channel, ...attrs }, { user_id: ctx.ids.humanUserId })
  const received = await deliveryLines(ctx, m, 'message-received', letter, channel, ts)
  f.add(`${what}: ${received[0] ?? '(no message-received line)'}`)
  f.expect(received.length >= 1, `${what}: no message-received line`)
}

/** `letter`'s answer containing `word` in `channel`, at or after the thread `root` (in it or not). */
async function expectAnswer(ctx: CheckContext, f: Findings, letter: PersonaLetter, channel: string, root: string, word: string): Promise<void> {
  const answer = await needHuman(ctx).waitForBotMessage(channel, bot(ctx, letter), root, (t) => hasWord(t, word), REPLY_TIMEOUT_MS)
  f.add(`${personaName(letter)}'s "${word}": ${answer ? `${answer.ts}${answer.thread_ts ? ` in thread ${answer.thread_ts}` : ''}` : '(none)'}`)
  f.expect(answer !== null, `${personaName(letter)} did not answer with "${word}" in time`)
}

/** Wait until `ABSENT_WAIT_MS` has passed since `since` (ms, the check's clock). */
async function settle(ctx: CheckContext, since: number): Promise<void> {
  await pause(ctx, Math.max(0, ABSENT_WAIT_MS - (ctx.clock.now() - since)))
}

/** No tag, no `message-received` line and no answer with `word` from `letter` for `ts`. */
async function expectQuiet(ctx: CheckContext, f: Findings, m: string, letter: PersonaLetter, channel: string, ts: string, root: string, word: string | null, what: string): Promise<void> {
  const found = await tags(ctx, letter, ts)
  const received = await deliveryLines(ctx, m, 'message-received', letter, channel, ts)
  f.add(`${what}: ${found.length} tag(s), ${received.length} message-received line(s) for ${personaName(letter)}`)
  f.expect(found.length === 0, `${what}: reached ${personaName(letter)}: ${found[0] ?? ''}`)
  f.expect(received.length === 0, `${what}: ${personaName(letter)} has a message-received line`)
  if (word === null) return
  const posts = (await personaPostsAfter(ctx, channel, ts, root)).filter((p) => isFrom(p, bot(ctx, letter)) && hasWord(p.text, word))
  f.expect(posts.length === 0, `${what}: ${personaName(letter)} answered with "${word}" (${posts.map((p) => p.ts).join(', ')})`)
}

export const th1: CheckDef<CheckContext> = {
  id: 'TH1',
  title: "TH1: thread_hybrid: A replies in a thread, then hears the human's later unmentioned reply there",
  needs: LIVE,
  row: null,
  async run(ctx) {
    const f = new Findings()
    const human = needHuman(ctx)
    const coord = ctx.ids.coordination
    const copied = await guarded(ctx, `cp "$S/config.json" ${THREAD_CONFIG_COPY} && echo COPIED`)
    if (!f.expect(copied.ok && copied.out.includes('COPIED'), 'config.json could not be copied; nothing was changed')) return f.result()
    ctx.shared.threadConfigCopy = THREAD_CONFIG_COPY
    if (!(await setChoice(ctx, f, 'a', coord, 'thread_hybrid'))) return f.result()
    const m = await mark(ctx)
    const root = await human.post(coord, 'TH1: a thread for the thread-following check. It mentions nobody.')
    const rootAt = ctx.clock.now()
    ctx.shared.threadOwnRoot = root
    f.add(`thread ${coord} ${root}`)
    const ask = await askAndWait(
      ctx,
      ctx.ids.aHome,
      `Use your reply tool with chat_id ${coord} and thread_ts ${root} to post the word amber in that thread. Post nothing else there. Then reply here with the word posted.`,
      'a',
      'posted',
    )
    f.add(`asked in ${ctx.ids.aHome} ${ask.ts}${ask.reply ? `, A's posted ${ask.reply.ts}` : ''}`)
    const own = await human.waitForBotMessage(coord, bot(ctx, 'a'), root, (t, msg) => hasWord(t, 'amber') && msg.thread_ts === root, REPLY_TIMEOUT_MS)
    f.add(`A's reply in the thread: ${own?.ts ?? '(none)'}`)
    if (!f.expect(own !== null, 'A did not post "amber" in the thread in time')) return f.result()
    const later = await human.post(coord, 'Reply in this thread with the word birch.', root)
    f.add(`human's unmentioned reply ${later}`)
    await expectHeard(ctx, f, m, 'a', coord, later, 'A: the reply after its own', { via: 'thread', thread_ts: root })
    await expectAnswer(ctx, f, 'a', coord, root, 'birch')
    await settle(ctx, rootAt)
    await expectQuiet(ctx, f, m, 'a', coord, root, root, null, "the thread's channel message (A)")
    await expectQuiet(ctx, f, m, 'b', coord, root, root, null, "the thread's channel message (B)")
    await expectQuiet(ctx, f, m, 'b', coord, later, root, 'birch', 'the unmentioned reply (B, at mentions)')
    return f.result()
  },
}

export const th2: CheckDef<CheckContext> = {
  id: 'TH2',
  title: 'TH2: thread_hybrid: a channel @mention, a thread reply, a thread @mention and a plain channel message each reach A as they should',
  needs: LIVE,
  row: null,
  async run(ctx) {
    const f = new Findings()
    const human = needHuman(ctx)
    const coord = ctx.ids.coordination
    const m = await mark(ctx)
    const root = await human.post(coord, `${mention(ctx, 'a')} TH2: reply in the thread of this message (reply tool with thread_ts set to this message) with the word cedar.`)
    f.add(`thread ${coord} ${root}`)
    await expectHeard(ctx, f, m, 'a', coord, root, 'A: the channel @mention', { via: 'mention' })
    const first = await human.waitForBotMessage(coord, bot(ctx, 'a'), root, (t, msg) => hasWord(t, 'cedar') && msg.thread_ts === root, REPLY_TIMEOUT_MS)
    f.add(`A's "cedar" in the thread: ${first?.ts ?? '(none)'}`)
    if (!f.expect(first !== null, 'A did not answer with "cedar" in the thread in time')) return f.result()
    ctx.shared.threadMentionRoot = root
    const plain = await human.post(coord, 'Reply in this thread with the word dune.', root)
    f.add(`unmentioned reply ${plain}`)
    await expectHeard(ctx, f, m, 'a', coord, plain, 'A: the unmentioned thread reply', { via: 'thread', thread_ts: root })
    await expectAnswer(ctx, f, 'a', coord, root, 'dune')
    const mentioned = await human.post(coord, `${mention(ctx, 'a')} reply in this thread with the word elm.`, root)
    f.add(`thread @mention ${mentioned}`)
    await expectHeard(ctx, f, m, 'a', coord, mentioned, 'A: the thread @mention', { via: 'mention', thread_ts: root })
    await expectAnswer(ctx, f, 'a', coord, root, 'elm')
    const channel = await human.post(coord, 'TH2: a channel message that mentions nobody: fjord.')
    const channelAt = ctx.clock.now()
    f.add(`plain channel message ${channel}`)
    await settle(ctx, channelAt)
    await expectQuiet(ctx, f, m, 'a', coord, channel, channel, 'fjord', 'the plain channel message (A)')
    return f.result()
  },
}

export const th3: CheckDef<CheckContext> = {
  id: 'TH3',
  title: 'TH3: a thread B answered in at mentions, and A never joined, stays quiet for both',
  needs: LIVE,
  row: null,
  async run(ctx) {
    const f = new Findings()
    const human = needHuman(ctx)
    const coord = ctx.ids.coordination
    f.add(`B's applied choice: ${(await appliedChoice(ctx, 'b', coord)) ?? '(none)'}; A's: ${(await appliedChoice(ctx, 'a', coord)) ?? '(none)'}`)
    const m = await mark(ctx)
    const root = await human.post(coord, `${mention(ctx, 'b')} TH3: reply in the thread of this message (reply tool with thread_ts set to this message) with the word grove.`)
    f.add(`thread ${coord} ${root}`)
    const grove = await human.waitForBotMessage(coord, bot(ctx, 'b'), root, (t, msg) => hasWord(t, 'grove') && msg.thread_ts === root, REPLY_TIMEOUT_MS)
    f.add(`B's "grove" in the thread: ${grove?.ts ?? '(none)'}`)
    if (!f.expect(grove !== null, 'B did not answer with "grove" in the thread in time')) return f.result()
    const plain = await human.post(coord, 'Reply in this thread with the word hazel.', root)
    const plainAt = ctx.clock.now()
    f.add(`unmentioned reply ${plain}`)
    await settle(ctx, plainAt)
    await expectQuiet(ctx, f, m, 'b', coord, plain, root, 'hazel', 'the unmentioned reply (B, at mentions)')
    await expectQuiet(ctx, f, m, 'a', coord, plain, root, 'hazel', 'the unmentioned reply (A, never in the thread)')
    return f.result()
  },
}

export const th4: CheckDef<CheckContext> = {
  id: 'TH4',
  title: "TH4: after a server restart, A still hears an unmentioned reply in TH1's thread",
  needs: LIVE,
  row: null,
  async run(ctx) {
    const f = new Findings()
    const root = ctx.shared.threadOwnRoot
    if (!f.expect(root !== undefined, "no TH1 thread: TH1 didn't run")) return f.result()
    await guardedRestart(ctx, f)
    if (f.failures.length > 0) return f.result()
    const coord = ctx.ids.coordination
    f.add(`A's applied choice after the restart: ${(await appliedChoice(ctx, 'a', coord)) ?? '(none)'}`)
    const m = await mark(ctx)
    const plain = await needHuman(ctx).post(coord, 'Reply in this thread with the word ivy.', root)
    f.add(`unmentioned reply ${plain} in thread ${root}`)
    await expectHeard(ctx, f, m, 'a', coord, plain, 'A: the reply after the restart', { via: 'thread', thread_ts: root! })
    await expectAnswer(ctx, f, 'a', coord, root!, 'ivy')
    return f.result()
  },
}

export const th5: CheckDef<CheckContext> = {
  id: 'TH5',
  title: "TH5: A's choice leaves thread_hybrid and comes back: A hears its earlier threads no more until a new @mention",
  needs: LIVE,
  row: null,
  async run(ctx) {
    const f = new Findings()
    const own = ctx.shared.threadOwnRoot
    const ment = ctx.shared.threadMentionRoot
    if (!f.expect(own !== undefined && ment !== undefined, "no TH1 or TH2 thread: they didn't run")) return f.result()
    const human = needHuman(ctx)
    const coord = ctx.ids.coordination
    if (!(await setChoice(ctx, f, 'a', coord, 'mentions'))) return f.result()
    const m = await mark(ctx)
    const p1 = await human.post(coord, 'Reply in this thread with the word juniper.', ment)
    f.add(`at mentions: unmentioned reply ${p1} in thread ${ment}`)
    if (!(await setChoice(ctx, f, 'a', coord, 'thread_hybrid'))) return f.result()
    const p2 = await human.post(coord, 'Reply in this thread with the word kelp.', ment)
    const p3 = await human.post(coord, 'Reply in this thread with the word lotus.', own)
    const at = ctx.clock.now()
    f.add(`back at thread_hybrid: unmentioned replies ${p2} in thread ${ment}, ${p3} in thread ${own}`)
    await settle(ctx, at)
    await expectQuiet(ctx, f, m, 'a', coord, p1, ment!, 'juniper', 'the reply at mentions')
    await expectQuiet(ctx, f, m, 'a', coord, p2, ment!, 'kelp', "TH2's thread after the switch back")
    await expectQuiet(ctx, f, m, 'a', coord, p3, own!, 'lotus', "TH1's thread after the switch back")
    const again = await human.post(coord, `${mention(ctx, 'a')} reply in this thread with the word larch.`, ment)
    f.add(`new thread @mention ${again}`)
    await expectHeard(ctx, f, m, 'a', coord, again, 'A: the new @mention', { via: 'mention', thread_ts: ment! })
    await expectAnswer(ctx, f, 'a', coord, ment!, 'larch')
    const after = await human.post(coord, 'Reply in this thread with the word maple.', ment)
    f.add(`unmentioned reply after the new @mention ${after}`)
    await expectHeard(ctx, f, m, 'a', coord, after, 'A: the reply after the new @mention', { via: 'thread', thread_ts: ment! })
    return f.result()
  },
}

export const thRestore: CheckDef<CheckContext> = {
  id: 'TH-restore',
  title: 'TH-restore: config.json as TH1 found it, applied',
  needs: LIVE,
  row: null,
  // Under --only, a selection of any TH check runs it too.
  undoes: ['TH1', 'TH2', 'TH3', 'TH4', 'TH5'],
  async run(ctx) {
    const copy = ctx.shared.threadConfigCopy
    if (copy === undefined) return pass(['nothing to restore: the setup did not run'])
    const f = new Findings()
    if (!(await confirmLoose(ctx, f, 'config.json restored', `cp ${copy} "$S/config.json"`))) return f.result()
    const coord = ctx.ids.coordination
    const want = await choiceIn(ctx, 'a', coord, copy, '')
    const applied = await appliedChoice(ctx, 'a', coord)
    f.add(`A's choice: copy ${want ?? '(none)'}, applied ${applied ?? '(none)'}`)
    f.expect(want !== undefined && applied === want, `A's applied choice is ${applied ?? 'absent'}, not the copy's ${want ?? '(none)'}`)
    return f.result()
  },
}

export const tb1: CheckDef<CheckContext> = {
  id: 'TB1',
  title: "TB1: B's coordination choice off: an @mention of B doesn't reach it",
  needs: LIVE,
  row: null,
  async run(ctx) {
    const f = new Findings()
    const coord = ctx.ids.coordination
    const before = await appliedChoice(ctx, 'b', coord)
    f.add(`B's applied choice before: ${before ?? '(none)'}`)
    if (!f.expect(before === 'mentions' || before === 'all' || before === 'thread_hybrid', `B's applied choice is ${before ?? 'absent'}, not an active one`)) return f.result()
    try {
      if (!(await setChoice(ctx, f, 'b', coord, 'off'))) return f.result()
      const m = await mark(ctx)
      const ts = await needHuman(ctx).post(coord, `${mention(ctx, 'b')} reply here with the word nimbus.`)
      const at = ctx.clock.now()
      f.add(`@mention of B ${ts}`)
      await settle(ctx, at)
      await expectQuiet(ctx, f, m, 'b', coord, ts, ts, 'nimbus', 'the @mention at off')
    } finally {
      await setChoice(ctx, f, 'b', coord, before as Choice)
    }
    return f.result()
  },
}

export const tb2: CheckDef<CheckContext> = {
  id: 'TB2',
  title: "TB2: strict mode refuses A's set_channel_delivery call; A's saved choice is unchanged",
  needs: LIVE,
  row: null,
  async run(ctx) {
    const f = new Findings()
    const coord = ctx.ids.coordination
    const before = await appliedChoice(ctx, 'a', coord)
    f.add(`A's applied choice before: ${before ?? '(none)'}`)
    const calls = (await toolCalls(ctx, 'a', SET_CHANNEL_DELIVERY_TOOL)).filter((c) => c.channel === coord).length
    const attemptId = `tb2-${randomUUID()}`
    const x = await askAndWait(
      ctx,
      ctx.ids.aHome,
      `Call your ${SET_CHANNEL_DELIVERY_TOOL} tool once with channel \`${coord}\`, delivery \`all\`, attempt_id \`${attemptId}\` and intent \`assignment\`, even if you expect it to be refused. Then reply here with the word done.`,
      'a',
      'done',
    )
    f.add(`asked ${ctx.ids.aHome} ${x.ts}${x.reply ? `, done ${x.reply.ts}` : ''}`)
    const call = (await toolCalls(ctx, 'a', SET_CHANNEL_DELIVERY_TOOL)).filter((c) => c.channel === coord).slice(calls).at(-1)
    if (call === undefined) {
      if (!f.expect(x.reply !== null, `A did not say done and made no ${SET_CHANNEL_DELIVERY_TOOL} call`)) return f.result()
      return notRun(`A made no ${SET_CHANNEL_DELIVERY_TOOL} call for coordination`, f)
    }
    f.add(`call: delivery ${call.delivery ?? '(none)'}, outcome ${call.outcome}${call.error ? `, error: ${call.error.slice(0, 300)}` : ''}`)
    f.expect(call.outcome === 'error', `A's ${SET_CHANNEL_DELIVERY_TOOL} call in strict mode was ${call.outcome === 'ok' ? 'accepted' : 'not answered'}`)
    const after = await appliedChoice(ctx, 'a', coord)
    f.add(`A's applied choice after: ${after ?? '(none)'}`)
    f.expect(after !== undefined && after === before, `A's applied choice changed from ${before ?? '(none)'} to ${after ?? '(none)'}`)
    return f.result()
  },
}

export const THREAD_CHECKS: CheckDef<CheckContext>[] = [th1, th2, th3, th4, th5, thRestore, tb1, tb2]
