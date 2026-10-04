/**
 * dm-checks.ts — testplans/b.yko Parts 6–7: open access (14), DMs and DM
 * prompts (15–23), and the "Turn A's DMs on" gesture between 16 and 17.
 *
 * Checks 14, 16 and 20 need a second workspace user (live.json
 * `second_user`); without one they are SKIPPED (no second account).
 *
 * Checks 16 and 20 ask A for one outbound reply-tool call. When A says done
 * but made no call, they ask once more (the plan's Check 16 rule). A that
 * never says done is a FAIL; a call still missing after the second ask is
 * Check 16's "not run" (SKIPPED, not a pass) and a FAIL in Check 20, whose
 * plan has no "not run" branch.
 */

import { isFrom, messageText, type SlackMessage } from '../lib/human-session.ts'
import { MINUTE, REPLY_TIMEOUT_MS, SECOND } from '../lib/wait.ts'
import type { CheckContext } from './context.ts'
import { expectOneTag, tagAttr } from './channel-checks.ts'
import { Findings, skipped, type CheckDef } from './framework.ts'
import {
  askAndWait,
  bot,
  clickPrompt,
  confirmedEdit,
  type Exchange,
  fileExists,
  guarded,
  guardedRestart,
  isPrompt,
  lines,
  mark,
  mention,
  needHuman,
  pause,
  personaPostsAfter,
  previewHeader,
  promptPosts,
  type PromptPost,
  promptState,
  q,
  recorded,
  replies,
  run,
  S,
  serverPid,
  sinceGrep,
  sinceGrepE,
  tags,
  tagstext,
  tmark,
  waitFile,
  waitPromptPost,
} from './helpers.ts'

const LIVE: ['workspace', 'claude'] = ['workspace', 'claude']
const LIVE2: ['workspace', 'claude', 'second-user'] = ['workspace', 'claude', 'second-user']

function need2(ctx: CheckContext) {
  if (!ctx.second) throw new Error('no second user')
  return ctx.second
}

/** The human's DM with a persona, opened once and remembered. */
async function dmWith(ctx: CheckContext, letter: 'a' | 'b' | 'c'): Promise<string> {
  const key = `${letter}Dm` as const
  const known = ctx.shared[key]
  if (known) return known
  const id = await needHuman(ctx).openDm(ctx.ids.bots[letter].userId)
  ctx.shared[key] = id
  return id
}

// ---------------------------------------------------------------------------
// Checks 16 and 20: an outbound reply-tool call A is asked to make
// ---------------------------------------------------------------------------

/** How many times Checks 16 and 20 ask A for the call (the plan's "Ask once more"). */
export const OUTBOUND_ASKS = 2

/**
 * A persona's reply-tool calls to `target` among `replies` lines (the plan's
 * `replies a | grep -F 'chat_id=<ID>'`, matched on the whole ID at the start
 * of the line).
 */
export function callsTo(replyLines: readonly string[], target: string): string[] {
  return replyLines.filter((l) => l.startsWith(`chat_id=${target} `))
}

/**
 * The newest call to `target` made since `before` of them were counted, or
 * '' when there is no new one (an earlier check's call is not this ask's).
 */
export function newCallTo(before: number, replyLines: readonly string[], target: string): string {
  const calls = callsTo(replyLines, target)
  return calls.length > before ? (calls.at(-1) ?? '') : ''
}

/**
 * What follows an ask, given how many asks were made, whether A said done
 * to the latest one and whether a new call exists:
 * - `evaluate`: a call was made; check it;
 * - `silent`: no call and no "done" (A did not answer): a FAIL;
 * - `ask-again`: A said done but made no call, and an ask is left;
 * - `no-call`: A said done but made no call, even after the last ask.
 */
export type OutboundNext = 'evaluate' | 'silent' | 'ask-again' | 'no-call'

export function outboundNext(asked: number, answered: boolean, called: boolean): OutboundNext {
  if (called) return 'evaluate'
  if (!answered) return 'silent'
  return asked < OUTBOUND_ASKS ? 'ask-again' : 'no-call'
}

interface OutboundOutcome {
  next: Exclude<OutboundNext, 'ask-again'>
  asks: Exchange[]
  /** The new `replies a` line for the call ('' when none). */
  call: string
}

/**
 * Post `text` in A-home and wait for A's done; ask once more when A said
 * done but made no reply-tool call to `target`.
 */
async function askForOutboundCall(ctx: CheckContext, target: string, text: string): Promise<OutboundOutcome> {
  const before = callsTo(await replies(ctx, 'a'), target).length
  const asks: Exchange[] = []
  for (;;) {
    const x = await askAndWait(ctx, ctx.ids.aHome, text, 'a', 'done')
    asks.push(x)
    const call = newCallTo(before, await replies(ctx, 'a'), target)
    const next = outboundNext(asks.length, x.reply !== null, call !== '')
    if (next !== 'ask-again') return { next, asks, call }
  }
}

/** Evidence lines for the asks: each post's ts and A's done (or its absence). */
function askEvidence(f: Findings, asks: readonly Exchange[]): void {
  asks.forEach((x, i) => f.add(`ask ${i + 1}: TS ${x.ts}, ${x.reply ? `done ${x.reply.ts}` : 'no done from A'}`))
}

/** The FAIL reason for an A that said nothing to the ask that decided the outcome. */
function silentReason(asks: readonly Exchange[], target: string): string {
  return `A did not say done${asks.length > 1 ? ' to the second ask' : ''} and made no reply-tool call to ${target}`
}

// ---------------------------------------------------------------------------
// Part 6
// ---------------------------------------------------------------------------

export const check14: CheckDef<CheckContext> = {
  id: '14',
  title: 'Check 14: a first-time user reaches a persona in a channel and by DM, with no approval step (AC 17)',
  needs: LIVE2,
  row: '14',
  async run(ctx) {
    const f = new Findings()
    const second = need2(ctx)
    const ids = ctx.ids
    for (const l of ['a', 'b', 'c'] as const) {
      if ((await second.human.usedDm(ids.bots[l].userId)) !== null) {
        return skipped('not verified: the second account already has a DM with a persona (a rerun; it is no longer a first-time user)')
      }
    }
    const post = await run(
      ctx,
      [
        'guard || exit 90',
        'ls -l "$S/access.json" >/dev/null 2>&1 && echo ACCESS=present || echo ACCESS=absent',
        '[ -L ~/.claude/skills/debug-slack-channel-bots ] && echo LINK=symlink || echo LINK=not-a-link',
        'L=$(readlink -f ~/.claude/skills/debug-slack-channel-bots); P=$(readlink -f "$PKG/skills/debug-slack-channel-bots")',
        '[ -n "$L" ] && [ "$L" = "$P" ] && echo SKILL_LINK_OK || echo SKILL_LINK_MISMATCH',
        '[ -e ~/.claude/skills/debug-slack-channel-bots/SKILL.md ] && echo SKILLMD=yes || echo SKILLMD=no',
        '[ -e ~/.claude/skills/claude-slack-channels-config ] && echo RETIRED=present || echo RETIRED=absent',
      ].join('\n'),
    )
    f.expect(post.code !== 90, 'guard refused')
    f.expect(post.out.includes('ACCESS=absent'), 'postinstall left an access.json')
    f.expect(post.out.includes('LINK=symlink') && post.out.includes('SKILL_LINK_OK') && post.out.includes('SKILLMD=yes'), 'the debug-slack-channel-bots link is missing or points elsewhere')
    f.expect(post.out.includes('RETIRED=absent'), 'the retired claude-slack-channels-config link exists')

    const stale = await guarded(
      ctx,
      `CREATED=0; if [ ! -e "$S/access.json" ]; then printf '{"dmPolicy":"disabled","allowFrom":[],"channels":{},"pending":{}}\\n' > "$S/access.json"; CREATED=1; fi; echo "CREATED=$CREATED $(sha256sum "$S/access.json" | cut -d' ' -f1)"`,
    )
    const staleSum = /CREATED=(\d) ([0-9a-f]{64})/.exec(stale.out)
    if (!f.expect(staleSum !== null, 'could not leave the stale access.json')) return f.result()
    const created = staleSum![1] === '1'
    await guardedRestart(ctx, f)

    const m = await mark(ctx)
    // The plan's setup: the human invites the first-time user to A-home (already a member is fine).
    await needHuman(ctx).invite(ids.aHome, second.userId)
    const tsCh = await second.human.post(ids.aHome, 'Reply with the word open-channel.')
    const bNewDm = await second.human.openDm(ids.bots.b.userId)
    const tsDm = await second.human.post(bNewDm, 'Reply with the word open-dm.')
    f.add(`TS_CH ${tsCh}, TS_DM ${tsDm}, B_NEW_DM_ID ${bNewDm}`)
    const aAns = await second.human.waitForBotMessage(ids.aHome, bot(ctx, 'a'), tsCh, (t) => t.toLowerCase().includes('open-channel'), REPLY_TIMEOUT_MS)
    const bAns = await second.human.waitForBotMessage(bNewDm, bot(ctx, 'b'), tsDm, (t) => t.toLowerCase().includes('open-dm'), REPLY_TIMEOUT_MS)
    f.expect(aAns !== null, 'A did not answer open-channel')
    f.expect(bAns !== null, 'B did not answer open-dm')
    expectOneTag(f, await tags(ctx, 'a', tsCh), 'tags a TS_CH', { chat_id: ids.aHome, via: 'receive_all', user_id: second.userId })
    expectOneTag(f, await tags(ctx, 'b', tsDm), 'tags b TS_DM', { chat_id: bNewDm, via: 'dm', user_id: second.userId })
    const ra = (await lines(ctx, 'replies a | tail -n 1'))[0] ?? ''
    const rb = (await lines(ctx, 'replies b | tail -n 1'))[0] ?? ''
    f.expect(ra.startsWith(`chat_id=${ids.aHome} error=false`) && ra.includes('Sent'), "A's last reply call is not a successful one to A-home")
    f.expect(rb.startsWith(`chat_id=${bNewDm} error=false`) && rb.includes('Sent'), "B's last reply call is not a successful one to the new DM")
    const access = await lines(ctx, `since ${q(m)} | grep -iE 'pairing|allowlist|allowFrom|access\\.json|dmPolicy|persona-dm-dropped'`)
    f.expect(access.length === 0, `access-control lines appeared: ${access.length}`)
    const sum = (await lines(ctx, 'sha256sum "$S/access.json" | cut -d" " -f1'))[0]
    f.expect(sum === staleSum![2], 'the stale access.json changed')
    const corrupt = (await lines(ctx, 'ls "$S"/access.json.corrupt.* 2>/dev/null | wc -l'))[0]
    f.expect(corrupt === '0', `${corrupt} access.json.corrupt files`)
    const dmOthers = (await second.human.everythingAfter(bNewDm, tsDm)).filter((x) => !isFrom(x, bot(ctx, 'b')) && x.user !== second.userId)
    f.expect(dmOthers.length === 0, 'the first-time user got another message in the DM')
    if (created) await guarded(ctx, 'rm "$S/access.json"')
    else f.note('Check 14: an access.json was already present and was left in place')
    return f.result()
  },
}

// ---------------------------------------------------------------------------
// Part 7
// ---------------------------------------------------------------------------

export const check15: CheckDef<CheckContext> = {
  id: '15',
  title: 'Check 15: a DM to a persona with DMs off is dropped with a log line (AC 35)',
  needs: LIVE,
  row: '15',
  async run(ctx) {
    const f = new Findings()
    const human = needHuman(ctx)
    const m = await mark(ctx)
    const aDm = await dmWith(ctx, 'a')
    const ts = await human.post(aDm, 'Reply with the word dm-off.')
    f.add(`A_DM_ID ${aDm}, TS ${ts}`)
    await pause(ctx, 2 * MINUTE)
    const dropped = (await sinceGrep(ctx, m, 'persona-dm-dropped:')).filter((l) => l.includes(`ts=${ts}`))
    const want = `[slack] persona-dm-dropped: personas[0] "persona_a" (key=persona_a): direct message in conversation ${aDm} ts=${ts} dropped: dm.enabled is off for this persona`
    f.expect(dropped.length === 1 && dropped[0]!.includes(want), `expected one persona-dm-dropped line naming persona_a, found ${dropped.length}`)
    f.expect((await sinceGrep(ctx, m, 'Dispatching to persona "persona_a"')).filter((l) => l.includes(`chat_id=${aDm}`)).length === 0, 'A was dispatched the DM')
    f.expect((await tags(ctx, 'a', ts)).length === 0, 'A received the DM')
    f.expect((await sinceGrepE(ctx, m, 'persona=persona_(b|c):')).filter((l) => l.includes(ts)).length === 0, "B's or C's connection saw the DM")
    const after = await human.everythingAfter(aDm, ts)
    f.expect(after.filter((x) => isFrom(x, bot(ctx, 'a'))).length === 0, 'A replied in the DM')
    const msg = await human.message(aDm, ts)
    f.expect(!(msg?.reactions ?? []).some((r) => (r.users ?? []).includes(ctx.ids.bots.a.userId)), 'A reacted to the DM')
    return f.result()
  },
}

export const check16: CheckDef<CheckContext> = {
  id: '16',
  title: 'Check 16: a persona with DMs off refuses to message a user (AC 36, outbound leg)',
  needs: LIVE2,
  row: '16',
  async run(ctx) {
    const f = new Findings()
    const second = need2(ctx)
    if ((await second.human.usedDm(ctx.ids.bots.a.userId)) !== null) {
      return skipped('not verified: the second account already has a DM with A (a rerun)')
    }
    const m = await mark(ctx)
    const o = await askForOutboundCall(
      ctx,
      second.userId,
      `Call your reply tool once with chat_id \`${second.userId}\` and the text \`DMs-off outbound check\`. Call it even if you expect it to fail. Then reply here with the word done.`,
    )
    askEvidence(f, o.asks)
    if (o.next === 'silent') {
      f.expect(false, silentReason(o.asks, second.userId))
      return f.result()
    }
    if (o.next === 'no-call') {
      return skipped(`not run: A made no reply-tool call to ${second.userId} (asked ${o.asks.length} times; the plan records this as "not run", not a pass)`, f.evidence)
    }
    const call = o.call
    f.expect(o.asks.at(-1)!.reply !== null, 'A did not say done')
    f.expect(call.startsWith(`chat_id=${second.userId} error=true`), 'the call was not refused')
    f.expect(call.includes(`Persona "persona_a" (key=persona_a) may not target "${second.userId}": DMs are off for this persona (dm.enabled is false).`), 'the refusal text is not the expected one')
    const open = (await sinceGrep(ctx, m, 'could not open a DM')).filter((l) => l.includes('persona_a') && l.includes(second.userId))
    f.expect(open.length === 0, 'a failed DM open was logged')
    f.expect((await second.human.usedDm(ctx.ids.bots.a.userId)) === null, 'the second user has a DM with A')
    return f.result()
  },
}

export const aDmsOn: CheckDef<CheckContext> = {
  id: 'A-DMs-on',
  title: "Turn A's DMs on (confirmed config edit, applied in place)",
  needs: LIVE,
  row: null,
  async run(ctx) {
    const f = new Findings()
    const g = await guarded(ctx, 'true')
    if (!f.expect(g.ok, 'guard refused')) return f.result()
    const m = await mark(ctx)
    const pid = await serverPid(ctx)
    const preview = [previewHeader({ in_place: 1 }), 'persona "persona_a" (key=persona_a): dm.enabled changed: applied in place immediately, instance kept.']
    await confirmedEdit(ctx, f, m, '(.personas[] | select(.name == "persona_a")).dm = {"enabled": true}', preview)
    const dm = (await lines(ctx, `jq -c '.personas[] | select(.name == "persona_a") | .dm' "$S/config.json"`))[0]
    f.expect(dm === '{"enabled":true}', "A's dm is not {\"enabled\":true}")
    const logPreview = await sinceGrep(ctx, m, '[slack] reload-preview: ')
    f.expect(logPreview.length === 2 && (logPreview[0] ?? '').endsWith(` (preview in "${S}/config.json.pending")`), 'the reload-preview log lines are not the two expected ones')
    const applied = await sinceGrepE(ctx, m, 'reload-(applied|noop|stale-confirmation|invalid):|updated in place|persona-start:|persona teardown|Session disconnected|spawnForPersona')
    f.expect(applied.length === 2, `step 5 printed ${applied.length} lines, not 2`)
    f.expect(applied.some((l) => l.includes('[slack] persona "persona_a" (key=persona_a): updated in place (dm.enabled); its instance, Slack connection and MCP session are kept; its cached DM conversation is forgotten')), 'no "updated in place (dm.enabled)" line')
    f.expect(await recorded(ctx), 'the record differs from config.json')
    f.expect(!(await fileExists(ctx, '"$S/config.json.pending"')) && !(await fileExists(ctx, '"$S/config.json.apply"')), 'a pending or apply file remains')
    f.expect((await serverPid(ctx)) === pid, 'the server PID changed')
    return f.result()
  },
}

export const check17: CheckDef<CheckContext> = {
  id: '17',
  title: 'Check 17: each DM is answered by the persona whose app received it (AC 15, AC 37, AC 17)',
  needs: LIVE,
  row: '17',
  async run(ctx) {
    const f = new Findings()
    const human = needHuman(ctx)
    const m = await mark(ctx)
    const aDm = await dmWith(ctx, 'a')
    const bDm = await dmWith(ctx, 'b')
    const a = await askAndWait(ctx, aDm, 'Reply with the word dm-a.', 'a', 'dm-a')
    const b = await askAndWait(ctx, bDm, 'Reply with the word dm-b.', 'b', 'dm-b')
    f.add(`TS_A ${a.ts} in ${aDm}; TS_B ${b.ts} in ${bDm}`)
    f.expect(a.reply !== null, 'A did not answer dm-a')
    f.expect(b.reply !== null, 'B did not answer dm-b')
    expectOneTag(f, await tags(ctx, 'a', a.ts), 'tags a TS_A', { chat_id: aDm, via: 'dm', user_id: ctx.ids.humanUserId })
    expectOneTag(f, await tags(ctx, 'b', b.ts), 'tags b TS_B', { chat_id: bDm, via: 'dm', user_id: ctx.ids.humanUserId })
    for (const [l, ts] of [['b', a.ts], ['c', a.ts], ['a', b.ts], ['c', b.ts]] as const) {
      f.expect((await tags(ctx, l, ts)).length === 0, `persona ${l} received ${ts}`)
    }
    f.expect((await sinceGrepE(ctx, m, 'persona=persona_(b|c):')).filter((l) => l.includes(a.ts)).length === 0, "B's or C's connection saw A's DM")
    f.expect((await sinceGrepE(ctx, m, 'persona=persona_(a|c):')).filter((l) => l.includes(b.ts)).length === 0, "A's or C's connection saw B's DM")
    const ra = (await replies(ctx, 'a')).at(-1) ?? ''
    const rb = (await replies(ctx, 'b')).at(-1) ?? ''
    f.expect(ra.startsWith(`chat_id=${aDm} error=false`) && ra.includes('Sent'), "A's last reply call is not a successful one to its DM")
    f.expect(rb.startsWith(`chat_id=${bDm} error=false`) && rb.includes('Sent'), "B's last reply call is not a successful one to its DM")
    for (const [dm, ts, l] of [[aDm, a.ts, 'a'], [bDm, b.ts, 'b']] as const) {
      const others = (await human.everythingAfter(dm, ts)).filter((x) => !isFrom(x, bot(ctx, l)) && x.user !== ctx.ids.humanUserId)
      f.expect(others.length === 0, `the DM with ${l.toUpperCase()} got a message from someone else`)
    }
    return f.result()
  },
}

/** The prompts Checks 18, 22 and 23 raise, as declared to the prompt guard (each names its file). */
export const CHECK18_PROMPT = /dm-prompt-c\.txt/
export const CHECK22_PROMPT = /dm-prompt-b\.txt/
export const CHECK23_PROMPT_A = /prompt-a\.txt/
export const CHECK23_PROMPT_B = /prompt-b\.txt/
/** B's further prompts for Check 23's task, whatever they run: the check denies them itself. */
export const CHECK23_B_EXTRA = /[\s\S]*/

export const check18: CheckDef<CheckContext> = {
  id: '18',
  title: "Check 18: C's first prompt opens the DM with its contact (AC 44)",
  needs: LIVE,
  row: '18',
  async run(ctx) {
    const f = new Findings()
    const human = needHuman(ctx)
    const existing = await human.existingDm(ctx.ids.bots.c.userId)
    const before = ctx.shared.cDmBeforeRun
    let kind: 'first run' | 'rerun' | 'not verified'
    if (existing === null) kind = 'first run'
    else if (before === true) kind = 'rerun'
    else kind = 'not verified'
    f.note(`Check 18: ${kind}`)
    ctx.promptGuard.expect({ persona: 'c', command: CHECK18_PROMPT })
    const m = await mark(ctx)
    const tm = await tmark(ctx)
    const typed = await guarded(
      ctx,
      `tmux send-keys -t slack_bot_persona_c -l ${q('Run a shell command that writes the current date to a file named dm-prompt-c.txt in your working directory. Do not post anything to Slack.')} && sleep 1 && tmux send-keys -t slack_bot_persona_c Enter`,
    )
    if (!f.expect(typed.ok && typed.code === 0, "could not type into C's session")) return f.result()
    const posts = await waitPromptPost(ctx, tm, 'c', 3 * MINUTE, 1, CHECK18_PROMPT)
    if (!f.expect(posts !== null, 'C posted no permission prompt')) return f.result()
    const post = posts![0]!
    f.add(`C prompt post: channel ${post.channel} ts ${post.slack_ts ?? '?'}`)
    f.expect(posts!.length === 1, `C posted ${posts!.length} prompts`)
    f.expect(post.ok === true && /^D[A-Z0-9]+$/.test(post.channel), 'the prompt post is not ok in a DM')
    if (existing !== null) f.expect(post.channel === existing, 'the prompt went to another DM than the existing one')
    ctx.shared.cDm = post.channel
    f.expect((await sinceGrep(ctx, m, 'persona-destination-failed:')).length === 0, 'a persona-destination-failed line appeared')
    const ts = post.slack_ts ?? ''
    if (kind === 'first run') {
      const all = await human.history(post.channel, '0')
      f.expect(all.length >= 1 && all[0]!.ts === ts, 'the prompt is not the first message of the new DM')
    }
    for (const ch of [ctx.ids.aHome, ctx.ids.coordination]) {
      const inCh = (await personaPostsAfter(ctx, ch, String(Math.floor(ctx.clock.now() / 1000) - 600) + '.000000')).filter((x) => isFrom(x, bot(ctx, 'c')))
      f.expect(inCh.length === 0, `C posted in ${ch}`)
    }
    if (ts) await clickPrompt(ctx, post.channel, ts, 'Allow', f)
    f.expect(await waitFile(ctx, '~/cscb-live/c/dm-prompt-c.txt', REPLY_TIMEOUT_MS), 'dm-prompt-c.txt does not exist')
    if (kind === 'not verified') return skipped('not verified (AC 44): a DM with C existed before its first prompt in this run', f.evidence)
    return f.result()
  },
}

export const check19: CheckDef<CheckContext> = {
  id: '19',
  title: 'Check 19: a DM-only persona starts, connects and answers DMs (AC 40, AC 41)',
  needs: LIVE,
  row: '19',
  async run(ctx) {
    const f = new Findings()
    const startMark = (await lines(ctx, `echo "$(stat -c %i "$LOG"):$(( $(grep -n 'Loaded persona config:' "$LOG" | tail -n 1 | cut -d: -f1) - 1 ))"`))[0] ?? ''
    f.add(`START_MARK ${startMark}`)
    if (startMark.endsWith(':-1')) f.note('Check 19: the start line rotated into server.log.1')
    const cLines = await sinceGrep(ctx, startMark, '"persona_c" (key=persona_c)')
    f.expect(cLines.some((l) => l.includes('[slack] persona-start: personas[2] "persona_c" (key=persona_c): bring-up starting')), 'no persona-start line for C since the last start')
    f.expect(cLines.some((l) => l.includes('[slack] Session connected: persona "persona_c" (key=persona_c)')), 'no Session connected line for C')
    f.expect(!cLines.some((l) => l.includes('[slack] persona "persona_c" (key=persona_c) not brought up:')), 'C was not brought up')
    f.expect((await sinceGrepE(ctx, startMark, 'persona-(credentials|directory)-|persona-slack-unreachable')).filter((l) => l.includes('(key=persona_c)')).length === 0, 'a failure line for C')
    f.expect((await lines(ctx, 'rows')).some((l) => l.startsWith('cscb_persona_c ')), 'no cscb_persona_c row')
    const cDm = ctx.shared.cDm ?? (await needHuman(ctx).openDm(ctx.ids.bots.c.userId))
    const x = await askAndWait(ctx, cDm, 'Reply with the word dm-c.', 'c', 'dm-c')
    f.add(`C_DM_ID ${cDm}, TS ${x.ts}`)
    f.expect(x.reply !== null, 'C did not answer dm-c')
    expectOneTag(f, await tags(ctx, 'c', x.ts), 'tags c TS', { chat_id: cDm, via: 'dm', user_id: ctx.ids.humanUserId })
    const rc = await replies(ctx, 'c')
    f.expect(rc.length > 0 && rc.every((l) => /^chat_id=D/.test(l)), 'C has a reply call to a non-DM target')
    const idsSeen = await lines(ctx, `since ${q(startMark)} | grep -F '(key=persona_c)' | grep -oE 'chat_id=[A-Z0-9]+|channel=[A-Z0-9]+|in (channel|conversation) [A-Z0-9]+' | sort -u`)
    f.expect(idsSeen.includes(`chat_id=${cDm}`), "C's lines do not show its DM")
    f.expect(idsSeen.every((l) => /(=| )D[A-Z0-9]+$/.test(l)), `C's lines name a non-DM conversation: ${idsSeen.filter((l) => !/(=| )D/.test(l)).join(', ')}`)
    f.expect((await sinceGrep(ctx, startMark, 'unclaimed-channel: personas[2] "persona_c"')).length === 0, 'an unclaimed-channel line for C')
    const memberOf = await needHuman(ctx).conversationsOf(ctx.ids.bots.c.userId)
    f.expect(memberOf.length === 0, `C is a member of ${memberOf.length} channel(s)`)
    return f.result()
  },
}

export const check20: CheckDef<CheckContext> = {
  id: '20',
  title: 'Check 20: a persona with DMs on opens a DM with a user and posts as itself (AC 38)',
  needs: LIVE2,
  row: '20',
  async run(ctx) {
    const f = new Findings()
    const second = need2(ctx)
    if ((await second.human.usedDm(ctx.ids.bots.a.userId)) !== null) {
      return skipped('not verified: the second account already has a DM with A (a rerun)')
    }
    const m = await mark(ctx)
    const o = await askForOutboundCall(
      ctx,
      second.userId,
      `Call your reply tool once with chat_id \`${second.userId}\` and the text \`DMs-on outbound check\`. Then reply here with the word done.`,
    )
    askEvidence(f, o.asks)
    if (o.next === 'silent') {
      f.expect(false, silentReason(o.asks, second.userId))
      return f.result()
    }
    if (o.next === 'no-call') {
      // The plan's Check 20 has no "not run" branch: the call is what it verifies.
      f.expect(false, `A made no reply-tool call to ${second.userId} (asked ${o.asks.length} times)`)
      return f.result()
    }
    const call = o.call
    f.expect(o.asks.at(-1)!.reply !== null, 'A did not say done')
    f.expect(call.startsWith(`chat_id=${second.userId} error=false`), 'the call to the second user failed')
    f.expect(/Sent 1 message\(s\) to D[A-Z0-9]+/.test(call) && call.includes(` (the DM with ${second.userId})`), 'the result does not name the new DM')
    f.expect((await sinceGrep(ctx, m, 'could not open a DM')).length === 0, 'a failed DM open was logged')
    const dm = await second.human.existingDm(ctx.ids.bots.a.userId)
    if (f.expect(dm !== null, 'the second user has no DM with A')) {
      const msgs = await second.human.history(dm!, '0')
      f.expect(msgs.some((mm) => isFrom(mm, bot(ctx, 'a')) && mm.text.includes('DMs-on outbound check')), 'the DM does not hold A\'s message')
    }
    return f.result()
  },
}

export const check21: CheckDef<CheckContext> = {
  id: '21',
  title: 'Check 21: an edit that adds a mention wakes the persona once',
  needs: LIVE,
  row: '21',
  async run(ctx) {
    const f = new Findings()
    const human = needHuman(ctx)
    const m = await mark(ctx)
    const ts = await human.post(ctx.ids.coordination, 'edit check, no reply needed yet')
    f.add(`TS ${ts}`)
    await pause(ctx, MINUTE)
    f.expect((await tagstext(ctx, 'a', 'edit check')).length === 0, 'A received the unaddressed message')
    await human.update(ctx.ids.coordination, ts, `${mention(ctx, 'a')} edit check: reply with the word edited.`)
    const started = ctx.clock.now()
    const reply = await human.waitForBotMessage(ctx.ids.coordination, bot(ctx, 'a'), ts, (t) => /\bedited\b/i.test(t), 2 * MINUTE)
    await pause(ctx, Math.max(0, 2 * MINUTE - (ctx.clock.now() - started)))
    f.expect(reply !== null, 'A did not reply "edited"')
    const tagA = await tagstext(ctx, 'a', 'edit check')
    expectOneTag(f, tagA, "tagstext a 'edit check'", { via: 'mention', user_id: ctx.ids.humanUserId })
    f.expect((await tagstext(ctx, 'b', 'edit check')).length === 0, 'B received the edit')
    const disp = (await sinceGrep(ctx, m, 'Dispatching to persona "persona_a"')).filter((l) => l.includes('edit check'))
    f.expect(disp.length === 1, `${disp.length} Dispatching lines for the edit, not 1`)
    const edited = (await personaPostsAfter(ctx, ctx.ids.coordination, ts)).filter((x) => isFrom(x, bot(ctx, 'a')) && /\bedited\b/i.test(messageText(x)))
    f.expect(edited.length === 1, `A replied "edited" ${edited.length} times`)
    const byTs = await tags(ctx, 'a', ts)
    f.note(`Check 21: tags a <TS> printed ${byTs.length === 1 ? 'the same tag' : `nothing (the tag's ts is ${tagA[0] ? tagAttr(tagA[0], 'ts') : '?'})`}`)
    // Step 4, observation only.
    await human.update(ctx.ids.coordination, ts, `${mention(ctx, 'a')} edit check: reply with the word edited!`)
    await pause(ctx, 2 * MINUTE)
    const after = await tagstext(ctx, 'a', 'edit check')
    const again = (await personaPostsAfter(ctx, ctx.ids.coordination, ts)).filter((x) => isFrom(x, bot(ctx, 'a')) && /\bedited\b/i.test(messageText(x)))
    f.note(`Check 21 step 4: ${after.length} tag(s) after the typo edit; A replied ${again.length > edited.length ? 'again' : 'not again'}`)
    return f.result()
  },
}

/** Wait for a persona's prompt message in `channel` (from the trail's slack_ts, else by content). */
async function promptMessage(ctx: CheckContext, channel: string, ts: string | undefined): Promise<SlackMessage | null> {
  if (!ts) return null
  return needHuman(ctx).message(channel, ts)
}

export const check22: CheckDef<CheckContext> = {
  id: '22',
  title: "Check 22: B's prompt arrives by DM and its button resolves it (AC 29)",
  needs: LIVE,
  row: '22',
  async run(ctx) {
    const f = new Findings()
    const bDm = await dmWith(ctx, 'b')
    ctx.promptGuard.expect({ persona: 'b', command: CHECK22_PROMPT })
    const m = await mark(ctx)
    const tm = await tmark(ctx)
    const t = await needHuman(ctx).post(
      ctx.ids.coordination,
      `${mention(ctx, 'b')} run a shell command that writes the current date to a file named dm-prompt-b.txt in your working directory.`,
    )
    const posts = await waitPromptPost(ctx, tm, 'b', 2 * MINUTE, 1, CHECK22_PROMPT)
    if (!f.expect(posts !== null, 'B posted no permission prompt')) return f.result()
    const post = posts![0]!
    f.add(`B prompt: ${post.channel} ${post.slack_ts ?? '?'}`)
    f.expect(posts!.length === 1 && post.ok === true && post.channel === bDm, 'the prompt post is not one ok post in the DM with B')
    f.expect((await sinceGrep(ctx, m, 'persona-destination-failed:')).length === 0, 'a persona-destination-failed line appeared')
    const msg = await promptMessage(ctx, bDm, post.slack_ts)
    f.expect(msg !== null && isFrom(msg, bot(ctx, 'b')) && promptState(msg) === 'open', 'the DM does not hold an open prompt from B')
    for (const ch of [ctx.ids.coordination, ctx.ids.aHome]) {
      f.expect((await personaPostsAfter(ctx, ch, t)).filter(isPrompt).length === 0, `a prompt was posted in ${ch}`)
    }
    if (post.slack_ts) await clickPrompt(ctx, bDm, post.slack_ts, 'Allow', f)
    f.expect(await waitFile(ctx, '~/cscb-live/b/dm-prompt-b.txt', REPLY_TIMEOUT_MS), 'dm-prompt-b.txt does not exist')
    return f.result()
  },
}

export const check23: CheckDef<CheckContext> = {
  id: '23',
  title: "Check 23: A's channel prompt and B's DM prompt each go to their own persona's destination (AC 34)",
  needs: LIVE,
  row: '23',
  async run(ctx) {
    const f = new Findings()
    try {
      await check23Steps(ctx, f)
    } finally {
      // A prompt it raised and left open (an early return, a throw) would block its persona for the rest of the run (run 6: B's).
      const denied = await ctx.promptGuard.denyLeftovers()
      if (denied > 0) f.note(`Check 23: ${denied} prompt(s) it raised were still open at its end; denied (the prompt guard's notes name them)`)
    }
    return f.result()
  },
}

/** A prompt post's request (its token; a restart posts it again), or its message when the trail has no token. */
function promptKey(p: PromptPost): string {
  return p.request_token ?? `${p.channel} ${p.slack_ts ?? ''}`
}

/** Check 23's steps, which return early when a prompt did not appear; the check's `finally` denies what they left open. */
async function check23Steps(ctx: CheckContext, f: Findings): Promise<void> {
  const ids = ctx.ids
  const bDm = await dmWith(ctx, 'b')
  ctx.promptGuard.expect({ persona: 'a', command: CHECK23_PROMPT_A })
  ctx.promptGuard.expect({ persona: 'b', command: CHECK23_PROMPT_B })
  ctx.promptGuard.expect({ persona: 'b', command: CHECK23_B_EXTRA })
  const tm = await tmark(ctx)
  await needHuman(ctx).post(
    ids.coordination,
    `${mention(ctx, 'a')} ${mention(ctx, 'b')} each of you, run a shell command that writes the current date to a file in your working directory: A names it prompt-a.txt, B names it prompt-b.txt.`,
  )
  const a = await waitPromptPost(ctx, tm, 'a', 3 * MINUTE, 1, CHECK23_PROMPT_A)
  const b = await waitPromptPost(ctx, tm, 'b', 3 * MINUTE, 1, CHECK23_PROMPT_B)
  if (!f.expect(a !== null && b !== null, 'both prompts did not appear')) return
  const pa = a![0]!
  const pb = b![0]!
  f.add(`A prompt ${pa.channel} ${pa.slack_ts ?? '?'}; B prompt ${pb.channel} ${pb.slack_ts ?? '?'}`)
  f.expect(pa.channel === ids.aHome && pa.ok === true, "A's first prompt post is not ok in A-home")
  f.expect(pb.channel === bDm && pb.ok === true, "B's first prompt post is not ok in the DM with B")
  const aMsg = await promptMessage(ctx, ids.aHome, pa.slack_ts)
  const bMsg = await promptMessage(ctx, bDm, pb.slack_ts)
  f.expect(aMsg !== null && isFrom(aMsg, bot(ctx, 'a')), "A's prompt is not A's message in A-home")
  f.expect(bMsg !== null && isFrom(bMsg, bot(ctx, 'b')), "B's prompt is not B's message in the DM")
  const since0 = String(Math.floor(ctx.clock.now() / 1000) - 300) + '.000000'
  f.expect((await personaPostsAfter(ctx, ids.aHome, since0)).filter((x) => isFrom(x, bot(ctx, 'b')) && isPrompt(x)).length === 0, 'A-home holds a prompt from B')
  f.expect((await personaPostsAfter(ctx, bDm, since0)).filter((x) => isFrom(x, bot(ctx, 'a'))).length === 0, 'the DM with B holds a message from A')
  f.expect((await personaPostsAfter(ctx, ids.coordination, since0)).filter(isPrompt).length === 0, 'a prompt was posted in coordination')
  if (pb.slack_ts) await clickPrompt(ctx, bDm, pb.slack_ts, 'Deny', f)
  const aStill = await promptMessage(ctx, ids.aHome, pa.slack_ts)
  f.expect(aStill !== null && promptState(aStill) === 'open', "A's prompt changed when B's was denied")
  // Deny any further prompt B raises for this task (up to a minute), each request once (a restart posts one again).
  const done = new Set<string>([promptKey(pb)])
  const deadline = ctx.clock.now() + MINUTE
  while (ctx.clock.now() < deadline) {
    await pause(ctx, 10 * SECOND)
    for (const extra of (await promptPosts(ctx, tm)).filter((p) => p.claude_instance_id === 'cscb_persona_b' && p.ok === true)) {
      const key = promptKey(extra)
      if (done.has(key) || !extra.slack_ts) continue
      done.add(key)
      await clickPrompt(ctx, extra.channel, extra.slack_ts, 'Deny', f)
      f.note('Check 23: B raised another prompt; denied')
    }
  }
  if (pa.slack_ts) await clickPrompt(ctx, ids.aHome, pa.slack_ts, 'Allow', f)
  const bStill = await promptMessage(ctx, bDm, pb.slack_ts)
  f.expect(bStill !== null && promptState(bStill) === 'denied', "B's prompt is no longer Denied by operator")
  f.expect(await waitFile(ctx, '~/cscb-live/a/prompt-a.txt', REPLY_TIMEOUT_MS), 'prompt-a.txt does not exist')
  f.expect(!(await fileExists(ctx, '~/cscb-live/b/prompt-b.txt')), 'prompt-b.txt exists')
}

export const DM_CHECKS = [check14, check15, check16, aDmsOn, check17, check18, check19, check20, check21, check22, check23]
