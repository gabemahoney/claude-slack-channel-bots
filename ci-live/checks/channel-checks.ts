/**
 * channel-checks.ts — testplans/b.yko Parts 3–5: the first start and the
 * channel checks (1–7), bot-to-bot, broadcasts and the persona-post event
 * shape (8–12), and A receive-all in both channels (13).
 *
 * Each check follows its Expected list in the plan. The human posts through
 * the session API; what reached a persona is read from its transcript with
 * the plan's `tags` / `replies` helpers in the container; server.log is read
 * from a mark with `since`.
 */

import { CONTAINER_HOME } from '../lib/docker.ts'
import { isFrom, messageText, notYetOnTransient, tsAfter } from '../lib/human-session.ts'
import { personaName } from '../lib/personas.ts'
import { waitFor, BRINGUP_TIMEOUT_MS, MINUTE, POLL_MS, REPLY_TIMEOUT_MS, SECOND } from '../lib/wait.ts'
import type { CheckContext } from './context.ts'
import { Findings, type CheckDef } from './framework.ts'
import {
  askAndWait,
  bot,
  clickPrompt,
  confirmedEdit,
  fileExists,
  guarded,
  isPrompt,
  lines,
  mark,
  mention,
  needHuman,
  pause,
  personaPostsAfter,
  previewHeader,
  promptPosts,
  q,
  recorded,
  rows,
  run,
  S,
  serverPid,
  since,
  sinceGrep,
  sinceGrepE,
  tags,
  tmark,
  waitBringUp,
  waitFile,
  waitLog,
  waitTags,
} from './helpers.ts'

const LIVE: ['workspace', 'claude'] = ['workspace', 'claude']

/** A tag line's attribute value. */
export function tagAttr(tag: string, name: string): string | null {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null
}

/** Expect exactly one tag with these attributes (an `alt` pair allows user_id OR bot_id). */
export function expectOneTag(
  f: Findings,
  found: string[],
  what: string,
  attrs: Record<string, string>,
  author?: { user_id: string; bot_id?: string },
): void {
  if (!f.expect(found.length === 1, `${what}: expected exactly one tag, found ${found.length}`)) return
  const tag = found[0] as string
  for (const [k, v] of Object.entries(attrs)) f.expect(tagAttr(tag, k) === v, `${what}: ${k} is ${tagAttr(tag, k) ?? 'absent'}, not ${v}`)
  if (author) {
    const ok = tagAttr(tag, 'user_id') === author.user_id || (author.bot_id !== undefined && tagAttr(tag, 'bot_id') === author.bot_id)
    f.expect(ok, `${what}: the tag's author is not ${author.user_id}${author.bot_id ? ` / ${author.bot_id}` : ''}`)
  }
}

function replyOk(f: Findings, what: string, reply: { ts: string; reply: unknown }): boolean {
  f.add(`${what}: human ts ${reply.ts}${reply.reply ? `, reply ts ${(reply.reply as { ts: string }).ts}` : ''}`)
  return f.expect(reply.reply !== null, `${what}: no answer in time`)
}

// ---------------------------------------------------------------------------
// Part 3
// ---------------------------------------------------------------------------

const COMPLETE_FIRST_START =
  '[slack] startupSessionManager: complete — 3 persona(s): 0 resumed, 3 fresh-spawned, 0 fresh-after-amnesia, 0 fresh-after-inconclusive-amnesia, 0 reconnected, 0 no-op, 0 failed, 0 not brought up'

export const check1: CheckDef<CheckContext> = {
  id: '1',
  title: 'Check 1: the first start applies config.json as it stands, with no token variables (AC 71, AC 47)',
  needs: LIVE,
  row: '1',
  blocking: true,
  prerequisite: true,
  async run(ctx) {
    const f = new Findings()
    const pre = await run(ctx, 'bash ~/cscb-live-preflight.sh check1')
    if (!f.expect(pre.out.includes('pre-flight passed (check1)'), `pre-flight check1 failed: ${pre.err.trim().split('\n')[0] ?? ''}`)) return f.result()
    const start = await guarded(ctx, 'claude-slack-channel-bots start', 180_000)
    f.expect(start.ok && start.code === 0, `start exited ${start.code}`)
    f.expect(/\[slack\] Server starting in background \(PID \d+\)/.test(start.out + start.err), 'start did not print "Server starting in background (PID …)"')
    const m0 = '0'
    const logM = `${((await lines(ctx, 'stat -c %i "$LOG"'))[0] ?? '0').trim()}:${m0}`
    const up = await waitBringUp(ctx, logM, ['a', 'b', 'c'], BRINGUP_TIMEOUT_MS)
    f.expect(up, 'the start summary or a Session connected line did not appear within 6 minutes')
    const log = await since(ctx, logM)
    const has = (s: string) => log.filter((l) => l.includes(s))
    f.expect(has(`[slack] No last-applied record: recorded the configuration file "${S}/config.json" as "${S}/config.json.last-applied"`).length === 1, 'no "No last-applied record: recorded …" line')
    f.expect(has('[slack] Loaded persona config: 3 persona(s)').length >= 1, 'no "Loaded persona config: 3 persona(s)" line')
    f.expect(has('[slack] startupSessionManager: 3 persona(s), concurrency=3').length >= 1, 'no "startupSessionManager: 3 persona(s), concurrency=3" line')
    ctx.shared.broughtUp = []
    ;(['a', 'b', 'c'] as const).forEach((l, i) => {
      const n = personaName(l)
      f.expect(has(`[slack] persona-start: personas[${i}] "${n}" (key=${n}): bring-up starting`).length === 1, `no persona-start line for ${n}`)
      f.expect(has(`[slack] spawnForPersona: spawned "${n}" (key=${n}) instanceId=cscb_${n}`).length === 1, `no spawnForPersona line for ${n}`)
      const connected = has(`[slack] Session connected: persona "${n}" (key=${n}) cwd="${CONTAINER_HOME}/cscb-live/${l}"`).length >= 1
      f.expect(connected, `no Session connected line with the cwd for ${n}`)
      if (connected) ctx.shared.broughtUp?.push(l)
    })
    f.expect(has(COMPLETE_FIRST_START).length === 1, 'the complete line is not "0 resumed, 3 fresh-spawned, … 0 failed, 0 not brought up"')
    f.expect(log.filter((l) => /\) not brought up:/.test(l)).length === 0, 'a persona was not brought up')
    f.expect(!(await fileExists(ctx, '"$S/config.json.pending"')) && !(await fileExists(ctx, '"$S/config.json.apply"')), 'config.json.pending or .apply exists')
    f.expect(await recorded(ctx), 'config.json and the record differ')
    const r = await rows(ctx)
    f.add(`rows: ${r.map((x) => x.id).join(', ')}`)
    f.expect(JSON.stringify(r.map((x) => x.id).sort()) === JSON.stringify(['cscb_persona_a', 'cscb_persona_b', 'cscb_persona_c']), 'the rows are not exactly cscb_persona_a, _b and _c')
    return f.result()
  },
}

export const check2: CheckDef<CheckContext> = {
  id: '2',
  title: 'Check 2: each persona replies as itself',
  needs: LIVE,
  row: '2',
  async run(ctx) {
    const f = new Findings()
    replyOk(f, 'A in A-home', await askAndWait(ctx, ctx.ids.aHome, 'Reply with the word ready.', 'a', 'ready'))
    replyOk(f, 'B in coordination', await askAndWait(ctx, ctx.ids.coordination, `${mention(ctx, 'b')} reply with the word ready.`, 'b', 'ready'))
    f.note('names and avatars: identity checked by bot user / bot ID only')
    return f.result()
  },
}

export const check3: CheckDef<CheckContext> = {
  id: '3',
  title: 'Check 3: a mention reaches only the persona mentioned (AC 1)',
  needs: LIVE,
  row: '3',
  async run(ctx) {
    const f = new Findings()
    const started = ctx.clock.now()
    const x = await askAndWait(ctx, ctx.ids.coordination, `${mention(ctx, 'a')} reply with the word here.`, 'a', 'here')
    replyOk(f, 'A in coordination', x)
    await pause(ctx, Math.max(0, 2 * MINUTE - (ctx.clock.now() - started)))
    const fromB = (await personaPostsAfter(ctx, ctx.ids.coordination, x.ts)).filter((m) => isFrom(m, bot(ctx, 'b')))
    f.expect(fromB.length === 0, `B posted ${fromB.length} message(s) in coordination`)
    return f.result()
  },
}

export const check4: CheckDef<CheckContext> = {
  id: '4',
  title: 'Check 4: one instance hears both of A\'s channels and replies in each (AC 2)',
  needs: LIVE,
  row: '4',
  async run(ctx) {
    const f = new Findings()
    const home = await askAndWait(ctx, ctx.ids.aHome, 'Remember the word lantern. Reply here with the word noted.', 'a', 'noted')
    if (!replyOk(f, 'noted in A-home', home)) return f.result()
    const coord = await askAndWait(ctx, ctx.ids.coordination, `${mention(ctx, 'a')} what word did I ask you to remember?`, 'a', 'lantern')
    replyOk(f, 'lantern in coordination', coord)
    expectOneTag(f, await tags(ctx, 'a', home.ts), 'tags a TS_HOME', { chat_id: ctx.ids.aHome, via: 'receive_all' })
    expectOneTag(f, await tags(ctx, 'a', coord.ts), 'tags a TS_COORD', { chat_id: ctx.ids.coordination, via: 'mention' })
    const last2 = (await lines(ctx, 'replies a | tail -n 2'))
    for (const ch of [ctx.ids.aHome, ctx.ids.coordination]) {
      const line = last2.find((l) => l.startsWith(`chat_id=${ch} `)) ?? ''
      f.expect(line.includes('error=false') && line.includes('Sent'), `no successful reply call to ${ch} among the last two`)
    }
    const r = await rows(ctx)
    f.expect(r.filter((x) => x.persona === 'persona_a').length === 1, 'A does not have exactly one row')
    return f.result()
  },
}

export const check5: CheckDef<CheckContext> = {
  id: '5',
  title: "Check 5: permission prompts go to A's destination (AC 28, AC 31)",
  needs: LIVE,
  row: '5',
  async run(ctx) {
    const f = new Findings()
    const human = needHuman(ctx)
    const tm = await tmark(ctx)
    const t1 = await human.post(ctx.ids.aHome, 'Run a shell command that writes the current date to a file named permission-check.txt in your working directory.')
    const p1 = await human.waitForBotMessage(ctx.ids.aHome, bot(ctx, 'a'), t1, (_t, m) => isPrompt(m), REPLY_TIMEOUT_MS)
    if (!f.expect(p1 !== null, 'no permission prompt from A in A-home')) return f.result()
    f.add(`prompt 1: ${ctx.ids.aHome} ${p1!.ts}`)
    await clickPrompt(ctx, ctx.ids.aHome, p1!.ts, 'Allow', f)
    const t2 = await human.post(
      ctx.ids.coordination,
      `${mention(ctx, 'a')} run a shell command that writes the current date to a file named permission-check-2.txt in your working directory.`,
    )
    const p2 = await human.waitForBotMessage(ctx.ids.aHome, bot(ctx, 'a'), t2, (_t, m) => isPrompt(m), REPLY_TIMEOUT_MS)
    if (f.expect(p2 !== null, 'no permission prompt from A in A-home for the coordination request')) {
      f.add(`prompt 2: ${ctx.ids.aHome} ${p2!.ts}`)
      await clickPrompt(ctx, ctx.ids.aHome, p2!.ts, 'Allow', f)
    }
    const inCoord = (await personaPostsAfter(ctx, ctx.ids.coordination, t2)).filter(isPrompt)
    f.expect(inCoord.length === 0, 'a prompt was posted in coordination')
    const files = await waitFile(ctx, '~/cscb-live/a/permission-check.txt', REPLY_TIMEOUT_MS)
    const files2 = await waitFile(ctx, '~/cscb-live/a/permission-check-2.txt', REPLY_TIMEOUT_MS)
    f.expect(files && files2, 'permission-check.txt or permission-check-2.txt is missing')
    const posts = (await promptPosts(ctx, tm)).filter((p) => p.claude_instance_id === 'cscb_persona_a')
    f.expect(posts.length >= 2, `posts shows ${posts.length} prompt post(s) for A, not 2`)
    f.expect(posts.every((p) => p.channel === ctx.ids.aHome && p.ok === true), 'a prompt post for A is not ok in A-home')
    if (posts.length > 2) f.note(`Check 5: A raised ${posts.length} prompts, all in A-home`)
    return f.result()
  },
}

export const check6: CheckDef<CheckContext> = {
  id: '6',
  title: 'Check 6: one agent-director row per persona (AC 4)',
  needs: LIVE,
  row: '6',
  async run(ctx) {
    const f = new Findings()
    const r = await rows(ctx)
    f.add(`rows: ${r.map((x) => `${x.id}(${x.persona})`).join(', ')}`)
    f.expect(r.length === 3, `${r.length} rows, not 3`)
    for (const l of ['a', 'b', 'c'] as const) {
      f.expect(r.some((x) => x.id === `cscb_persona_${l}` && x.persona === `persona_${l}`), `no row cscb_persona_${l} with persona label persona_${l}`)
    }
    return f.result()
  },
}

export const check7: CheckDef<CheckContext> = {
  id: '7',
  title: 'Check 7: crash and recover (AC 4)',
  needs: LIVE,
  row: '7',
  async run(ctx) {
    const f = new Findings()
    const m = await mark(ctx)
    const kill = await guarded(ctx, 'tmux kill-session -t slack_bot_persona_a')
    if (!f.expect(kill.ok && kill.code === 0, 'the guarded tmux kill-session did not run')) return f.result()
    const back = await waitLog(ctx, m, 'Session connected: persona "persona_a" (key=persona_a)', 5 * MINUTE)
    f.expect(back !== null, 'A did not reconnect within five minutes')
    const log = await since(ctx, m)
    f.expect(log.some((l) => l.includes('[slack] Session disconnected') && l.includes('"persona_a" (key=persona_a)')), 'no Session disconnected line for persona_a')
    const sched = log.find((l) => l.includes('[slack] Scheduling restart for persona=persona_a in'))
    f.expect(sched !== undefined, 'no "Scheduling restart for persona=persona_a" line')
    f.expect(log.some((l) => l.includes('[slack] Relaunching session for persona=persona_a cwd=')), 'no Relaunching session line for persona_a')
    if (sched) f.add(sched)
    const r = await rows(ctx)
    f.expect(r.length === 3 && new Set(r.map((x) => x.persona)).size === 3, 'not exactly one row per persona after the cycle')
    replyOk(f, 'A back in A-home', await askAndWait(ctx, ctx.ids.aHome, 'Reply with the word back.', 'a', 'back'))
    return f.result()
  },
}

// ---------------------------------------------------------------------------
// Part 4
// ---------------------------------------------------------------------------

/** Ask A (in A-home) to post `text` in coordination; return A's coordination post. */
async function aPostsInCoordination(ctx: CheckContext, f: Findings, text: string, marker: string) {
  const human = needHuman(ctx)
  const ask = await askAndWait(
    ctx,
    ctx.ids.aHome,
    `Post this exact text in coordination, chat_id \`${ctx.ids.coordination}\`, with no formatting and no files: \`${text}\`. Then reply here with the word posted.`,
    'a',
    'posted',
  )
  if (!replyOk(f, 'A said posted', ask)) return null
  const post = await human.waitForBotMessage(ctx.ids.coordination, bot(ctx, 'a'), ask.ts, (t) => t.includes(marker), 30 * SECOND)
  f.expect(post !== null, `A's coordination post with "${marker}" was not found`)
  if (post) f.add(`A's coordination post: ${post.ts}`)
  return post
}

/** The fields the plan records from a RAW line (IDs only). */
export function rawShape(line: string): Record<string, string> {
  const pick = (key: string) => new RegExp(`"${key}":"([^"]*)"`).exec(line)?.[1]
  const out: Record<string, string> = {}
  for (const key of ['user', 'bot_id', 'subtype', 'app_id']) out[key] = pick(key) ?? 'absent'
  out.bot_profile = line.includes('"bot_profile"') ? 'present' : 'absent'
  return out
}

export const check8: CheckDef<CheckContext> = {
  id: '8',
  title: 'Check 8: persona-post event shape (SR-4.2, the event-shape capture)',
  needs: LIVE,
  row: '8',
  async run(ctx) {
    const f = new Findings()
    const m = await mark(ctx)
    const post = await aPostsInCoordination(ctx, f, `${mention(ctx, 'b')} shape check, no reply needed`, 'shape check')
    if (!post) return f.result()
    const raw = (await sinceGrep(ctx, m, 'RAW message event persona=persona_b:')).filter((l) => l.includes(post.ts))
    const rawAny = raw.length > 0 ? raw : (await sinceGrep(ctx, m, 'RAW message event persona=persona_b:')).filter((l) => l.includes('shape check'))
    if (raw.length === 0 && rawAny.length > 0) f.note('Check 8: the ts fell outside the RAW prefix; matched by text')
    if (f.expect(rawAny.length >= 1, "no RAW message event line on B's connection for A's post")) {
      const shape = rawShape(rawAny[0] as string)
      f.note(`Check 8 RAW shape: user=${shape.user} bot_id=${shape.bot_id} subtype=${shape.subtype} app_id=${shape.app_id} bot_profile=${shape.bot_profile}`)
      // The plan: when user or bot_id can't be read (cut off by the 300-character prefix), file a bug instead of passing.
      if (shape.user === 'absent' || shape.bot_id === 'absent') {
        f.expect(false, `file a bug: RAW prefix lacks user/bot_id (user=${shape.user}, bot_id=${shape.bot_id})`)
      } else {
        f.expect(shape.user === ctx.ids.bots.a.userId || shape.bot_id === ctx.ids.bots.a.botId, "the event carries neither A's bot user ID nor A's bot ID")
      }
      f.expect(shape.subtype === 'absent' || shape.subtype === 'bot_message', `subtype is ${shape.subtype}`)
    }
    const drops = (await sinceGrep(ctx, m, `[slack] persona "persona_a" (key=persona_a) dropped message from channel=${ctx.ids.coordination} `)).filter((l) =>
      l.endsWith(`user=${ctx.ids.bots.a.userId}: own`) || l.endsWith(`bot_id=${ctx.ids.bots.a.botId}: own`),
    )
    f.expect(drops.length >= 1, "no own-drop line for A's post in coordination")
    const toB = await waitTags(ctx, 'b', post.ts)
    f.expect((await tags(ctx, 'a', post.ts)).length === 0, 'A received its own post')
    expectOneTag(f, toB, 'tags b TS', { via: 'mention' }, { user_id: ctx.ids.bots.a.userId, bot_id: ctx.ids.bots.a.botId })
    return f.result()
  },
}

export const check9: CheckDef<CheckContext> = {
  id: '9',
  title: 'Check 9: one mention is delivered once (SR-4.1)',
  needs: LIVE,
  row: '9',
  async run(ctx) {
    const f = new Findings()
    const m = await mark(ctx)
    const text = 'reply with the word once.'
    const x = await askAndWait(ctx, ctx.ids.coordination, `${mention(ctx, 'a')} ${text}`, 'a', 'once')
    replyOk(f, 'A once', x)
    const rawLines = await sinceGrep(ctx, m, 'persona=persona_a:')
    const count = (lines: string[]) => ({
      msg: lines.filter((l) => l.includes('RAW message event')).length,
      app: lines.filter((l) => l.includes('RAW app_mention event')).length,
    })
    const byTs = count(rawLines.filter((l) => l.includes(x.ts)))
    if (byTs.msg === 1 && byTs.app === 1) {
      f.add('RAW lines matched by ts: one message, one app_mention')
    } else {
      // The ts may fall outside a line's 300-character prefix: match the message's own text instead.
      const byText = count(rawLines.filter((l) => l.includes(text)))
      f.note(`Check 9: RAW lines matched by ts: message=${byTs.msg} app_mention=${byTs.app}; by the message text: message=${byText.msg} app_mention=${byText.app}`)
      f.expect(byText.msg === 1 && byText.app === 1, `RAW lines for the message: message=${byText.msg} app_mention=${byText.app}, not one each`)
    }
    expectOneTag(f, await tags(ctx, 'a', x.ts), 'tags a TS', { via: 'mention', user_id: ctx.ids.humanUserId })
    const disp = (await sinceGrep(ctx, m, `Dispatching to persona "persona_a" (key=persona_a) chat_id=${ctx.ids.coordination}`)).filter((l) => l.includes('reply with the word once'))
    f.expect(disp.length === 1, `${disp.length} Dispatching lines for the message, not 1`)
    await pause(ctx, 30 * SECOND)
    const onces = (await personaPostsAfter(ctx, ctx.ids.coordination, x.ts)).filter((p) => isFrom(p, bot(ctx, 'a')) && /\bonce\b/i.test(messageText(p)))
    f.expect(onces.length === 1, `A replied "once" ${onces.length} times`)
    return f.result()
  },
}

export const check10: CheckDef<CheckContext> = {
  id: '10',
  title: 'Check 10: @here and @channel wake the mention-only personas (AC 7)',
  needs: LIVE,
  row: '10',
  async run(ctx) {
    const f = new Findings()
    const human = needHuman(ctx)
    for (const [token, word] of [['<!here>', 'here-check'], ['<!channel>', 'channel-check']] as const) {
      const m = await mark(ctx)
      const ts = await human.post(ctx.ids.coordination, `${token} reply with the word ${word}.`)
      f.add(`${token}: ${ts}`)
      for (const l of ['a', 'b'] as const) {
        const reply = await human.waitForBotMessage(ctx.ids.coordination, bot(ctx, l), ts, (t) => t.toLowerCase().includes(word), REPLY_TIMEOUT_MS)
        f.expect(reply !== null, `${l.toUpperCase()} did not answer ${token}`)
        expectOneTag(f, await tags(ctx, l, ts), `tags ${l} ${token}`, { via: 'broadcast', user_id: ctx.ids.humanUserId })
      }
      f.expect((await tags(ctx, 'c', ts)).length === 0, `C received ${token}`)
      f.expect((await sinceGrep(ctx, m, 'persona=persona_c:')).filter((l) => l.includes(ts)).length === 0, `C's connection logged ${token}`)
    }
    return f.result()
  },
}

export const check11: CheckDef<CheckContext> = {
  id: '11',
  title: "Check 11: a persona's own @here does not wake it (AC 8)",
  needs: LIVE,
  row: '11',
  async run(ctx) {
    const f = new Findings()
    const m = await mark(ctx)
    const post = await aPostsInCoordination(ctx, f, '<!here> own broadcast check, no reply needed', 'own broadcast check')
    if (!post) return f.result()
    const toB = await waitTags(ctx, 'b', post.ts)
    f.expect((await tags(ctx, 'a', post.ts)).length === 0, 'A received its own broadcast')
    const drops = (await sinceGrep(ctx, m, `[slack] persona "persona_a" (key=persona_a) dropped message from channel=${ctx.ids.coordination} `)).filter((l) => l.endsWith(': own'))
    f.expect(drops.length >= 1, "no own-drop line for A's broadcast")
    expectOneTag(f, toB, 'tags b TS', { via: 'broadcast' }, { user_id: ctx.ids.bots.a.userId, bot_id: ctx.ids.bots.a.botId })
    return f.result()
  },
}

/** Log lines that carry a message's text (a RAW event prefix, a Dispatching line's `text=`): the step 5 search skips them. */
const MESSAGE_TEXT_LINE_RE = /\[slack\] RAW [a-z_]+ event persona=|\[slack\] Dispatching to persona /

/**
 * The known Slack rate-limit lines: the Web API library's retry and
 * rejection messages, and Slack's own `ratelimited` code. Not about
 * delivery: noted, not failed.
 */
const SLACK_RATE_LIMIT_LINE_RES = [
  /API Call failed due to rate limiting\. Will retry in \d+ seconds\./,
  /A rate limit was exceeded \(url: [^,)]*, retry-after: \d+\)/,
  /\bratelimited\b/,
]

/**
 * The step 5 search (`since MARK | grep -inE 'limit|throttl|loop|too many'`):
 * lines that carry message text are skipped (the personas' own arithmetic
 * talk can say "limit"), a known Slack rate-limit line is a note, and every
 * other match fails the check.
 */
export function judgeLimitLines(found: string[]): { failures: string[]; notes: string[] } {
  const failures: string[] = []
  const notes: string[] = []
  for (const line of found) {
    if (MESSAGE_TEXT_LINE_RE.test(line)) continue
    if (SLACK_RATE_LIMIT_LINE_RES.some((re) => re.test(line))) notes.push(line)
    else failures.push(line)
  }
  return { failures, notes }
}

export const check12: CheckDef<CheckContext> = {
  id: '12',
  title: 'Check 12: two personas converse with no limit (AC 11, AC 18, SR-4.2)',
  needs: LIVE,
  row: '12',
  async run(ctx) {
    const f = new Findings()
    const human = needHuman(ctx)
    const ids = ctx.ids
    const m = await mark(ctx)
    const start = await human.post(
      ids.aHome,
      `In coordination, chat_id \`${ids.coordination}\`, post a message that mentions \`<@${ids.bots.b.userId}>\` and asks B what 7 times 6 is. ` +
        `Tell B to mention you as \`<@${ids.bots.a.userId}>\` in every answer. Each time B answers, reply to B in coordination, mentioning it, ` +
        'with one more short arithmetic question. Keep going until I tell you to stop.',
    )
    const mentionsB = (t: string) => t.includes(`<@${ids.bots.b.userId}>`)
    const mentionsA = (t: string) => t.includes(`<@${ids.bots.a.userId}>`)
    const a1 = await human.waitForBotMessage(ids.coordination, bot(ctx, 'a'), start, mentionsB, REPLY_TIMEOUT_MS)
    if (!f.expect(a1 !== null, "A's first coordination post mentioning B did not appear")) return f.result()
    const b1 = await human.waitForBotMessage(ids.coordination, bot(ctx, 'b'), a1!.ts, mentionsA, REPLY_TIMEOUT_MS)
    f.add(`A's first post ${a1!.ts}; B's reply ${b1?.ts ?? 'none'}`)
    expectOneTag(f, await tags(ctx, 'b', a1!.ts), "tags b <A's post>", { via: 'mention' }, { user_id: ids.bots.a.userId, bot_id: ids.bots.a.botId })
    if (!f.expect(b1 !== null, 'B did not answer mentioning A')) return f.result()
    // Let the exchange run: at least two more posts each after B's first reply
    // (threads read back to A's first post, where the exchange may continue).
    const more = await waitFor(
      async () => {
        const posts = await notYetOnTransient(() => personaPostsAfter(ctx, ids.coordination, b1!.ts, a1!.ts))
        if (posts === null) return null
        const aPosts = posts.filter((p) => isFrom(p, bot(ctx, 'a')) && mentionsB(p.text))
        const bPosts = posts.filter((p) => isFrom(p, bot(ctx, 'b')) && mentionsA(p.text))
        return aPosts.length >= 2 && bPosts.length >= 2 ? { aPosts, bPosts } : null
      },
      { timeoutMs: 10 * MINUTE, intervalMs: POLL_MS * 2, clock: ctx.clock },
    )
    // tags on B's first reply now, after A had time to receive it.
    expectOneTag(f, await tags(ctx, 'a', b1!.ts), "tags a <B's reply>", { via: 'mention' }, { user_id: ids.bots.b.userId, bot_id: ids.bots.b.botId })
    if (f.expect(more !== null, 'the exchange did not reach two more posts each within 10 minutes')) {
      const laterA = more!.aPosts[more!.aPosts.length - 1]!
      const laterB = more!.bPosts[more!.bPosts.length - 1]!
      await pause(ctx, 30 * SECOND)
      expectOneTag(f, await tags(ctx, 'b', laterA.ts), "tags b <A's later post>", { via: 'mention' })
      expectOneTag(f, await tags(ctx, 'a', laterB.ts), "tags a <B's later post>", { via: 'mention' })
      for (const [letter, post] of [['b', laterA], ['a', laterB]] as const) {
        const disp = (await sinceGrep(ctx, m, `Dispatching to persona "${personaName(letter)}" (key=${personaName(letter)}) chat_id=${ids.coordination}`)).length
        f.expect(disp >= 1, `no Dispatching line to ${personaName(letter)} (post ${post.ts})`)
      }
    }
    // Stop the exchange.
    const stop = await human.post(ids.coordination, `${mention(ctx, 'a')} ${mention(ctx, 'b')} stop the exchange now. Do not post in this channel again.`)
    await pause(ctx, 2 * MINUTE)
    // Posts in coordination after `after`, threads of the whole exchange included; null on a transient Slack failure.
    const exchangeStart = a1!.ts
    const quietSince = async (after: string) => {
      const posts = await notYetOnTransient(() => personaPostsAfter(ctx, ids.coordination, after, exchangeStart))
      return posts === null ? null : posts.length
    }
    const lastAfterStop = await personaPostsAfter(ctx, ids.coordination, stop, exchangeStart)
    const recentCut = String(Math.floor(ctx.clock.now() / 1000) - 120) + '.000000'
    if (lastAfterStop.some((p) => tsAfter(p.ts, recentCut))) {
      f.note('Check 12: the personas kept posting after the stop message; stopped in their terminals (Escape + message)')
      for (const l of ['a', 'b'] as const) {
        await guarded(ctx, `tmux send-keys -t slack_bot_persona_${l} Escape; sleep 1; tmux send-keys -t slack_bot_persona_${l} -l ${q('Stop the arithmetic exchange. Do not post in coordination again.')}; sleep 1; tmux send-keys -t slack_bot_persona_${l} Enter`)
      }
    }
    const quiet = await waitFor(
      async () => {
        const cut = String(Math.floor(ctx.clock.now() / 1000) - 120) + '.000000'
        return (await quietSince(cut)) === 0
      },
      { timeoutMs: 8 * MINUTE, intervalMs: 20 * SECOND, clock: ctx.clock },
    )
    f.expect(quiet === true, 'coordination did not go quiet for two minutes after the stop')
    const found = await lines(ctx, `since ${q(m)} | grep -inE 'limit|throttl|loop|too many'`)
    const judged = judgeLimitLines(found)
    for (const n of judged.notes.slice(0, 5)) f.note(`Check 12 search (Slack rate limit): ${n.slice(0, 200)}`)
    f.expect(
      judged.failures.length === 0,
      `${judged.failures.length} limit/throttle/loop line(s): ${judged.failures.slice(0, 2).map((l) => l.slice(0, 200)).join(' / ')}`,
    )
    return f.result()
  },
}

// ---------------------------------------------------------------------------
// Part 5
// ---------------------------------------------------------------------------

export const check13: CheckDef<CheckContext> = {
  id: '13',
  title: 'Check 13: a persona receive-all in two channels hears both in one instance (AC 12)',
  needs: LIVE,
  row: '13',
  async run(ctx) {
    const f = new Findings()
    const ids = ctx.ids
    const human = needHuman(ctx)
    const g = await guarded(ctx, 'true')
    if (!f.expect(g.ok, 'guard refused')) return f.result()
    const m = await mark(ctx)
    const pidBefore = await serverPid(ctx)
    const paneBefore = (await lines(ctx, "tmux list-panes -t slack_bot_persona_a -F '#{pane_pid}'"))[0] ?? ''
    const rowsBefore = await rows(ctx)
    f.add(`server ${pidBefore}, A pane ${paneBefore}, rows ${rowsBefore.map((r) => r.id).join(',')}`)
    replyOk(f, 'driftwood noted', await askAndWait(ctx, ids.aHome, 'Remember the word driftwood. Reply with the word noted.', 'a', 'noted'))

    const setDelivery = (d: string) =>
      `(.personas[] | select(.name == "persona_a") | .channels[] | select(.id == "${ids.coordination}") | .delivery) = "${d}"`
    const inPlace = { in_place: 1 }
    const previewLines = [previewHeader(inPlace), 'persona "persona_a" (key=persona_a): delivery changed: applied in place immediately, instance kept.']
    await confirmedEdit(ctx, f, m, setDelivery('all'), previewLines)
    const chans = (await lines(ctx, `jq -c '.personas[] | select(.name == "persona_a") | .channels' "$S/config.json"`))[0] ?? ''
    f.expect(chans.includes(`{"id":"${ids.coordination}","delivery":"all"}`), "A's coordination delivery is not all")
    const step5 = await sinceGrepE(ctx, m, 'reload-(preview|applied|noop|stale-confirmation|invalid):|updated in place|persona-start:|persona teardown|Session disconnected|spawnForPersona')
    f.expect(step5.filter((l) => l.includes('[slack] reload-preview: ')).length === 2, 'step 5: not exactly the two reload-preview lines')
    f.expect(step5.some((l) => l.includes('[slack] persona "persona_a" (key=persona_a): updated in place (delivery); its instance, Slack connection and MCP session are kept')), 'step 5: no "updated in place (delivery)" line')
    f.expect(step5.filter((l) => /persona-start:|persona teardown|Session disconnected|spawnForPersona/.test(l)).length === 0, 'step 5: a lifecycle line appeared')
    f.expect(step5.length === 4, `step 5: ${step5.length} lines, not 4`)
    f.expect(await recorded(ctx), 'step 5: the record differs from config.json')

    const m2 = await mark(ctx)
    const w1 = await human.post(ids.aHome, 'Window check one. Reply here with the word home-seen.')
    const w2 = await human.post(ids.coordination, 'Window check two. Reply here with the word coord-seen.')
    f.add(`TS_W1 ${w1}, TS_W2 ${w2}`)
    const r1 = await human.waitForBotMessage(ids.aHome, bot(ctx, 'a'), w1, (t) => t.toLowerCase().includes('home-seen'), REPLY_TIMEOUT_MS)
    const r2 = await human.waitForBotMessage(ids.coordination, bot(ctx, 'a'), w2, (t) => t.toLowerCase().includes('coord-seen'), REPLY_TIMEOUT_MS)
    f.expect(r1 !== null && r2 !== null, 'A did not answer both window checks')
    expectOneTag(f, await tags(ctx, 'a', w1), 'tags a TS_W1', { chat_id: ids.aHome, via: 'receive_all' })
    expectOneTag(f, await tags(ctx, 'a', w2), 'tags a TS_W2', { chat_id: ids.coordination, via: 'receive_all' })
    f.expect((await tags(ctx, 'b', w2)).length === 0, 'B received the unaddressed coordination message')
    const bDrops = await sinceGrep(ctx, m2, `persona "persona_b" (key=persona_b) dropped message from channel=${ids.coordination}`)
    f.expect(bDrops.some((l) => l.endsWith(`user=${ids.humanUserId}: not-mentioned`)), "no not-mentioned drop line for B")
    const disp = await sinceGrep(ctx, m2, 'Dispatching to persona "persona_a"')
    f.expect(disp.length === 2, `${disp.length} Dispatching lines for A, not 2`)
    const paneNow = (await lines(ctx, "tmux list-panes -t slack_bot_persona_a -F '#{pane_pid}'"))[0] ?? ''
    f.expect(paneNow === paneBefore, 'A\'s pane process changed')
    f.expect((await rows(ctx)).filter((r) => r.persona === 'persona_a').length === 1, 'A does not have exactly one row')

    const m3 = await mark(ctx)
    await confirmedEdit(ctx, f, m3, setDelivery('mentions'), previewLines)
    const step9 = await sinceGrepE(ctx, m3, 'reload-(applied|noop|stale-confirmation|invalid):|updated in place|persona-start:|persona teardown|spawnForPersona')
    f.expect(step9.length === 2 && step9.some((l) => l.includes('updated in place (delivery)')) && step9.some((l) => l.includes('reload-applied:')), 'step 9: not exactly the updated-in-place and reload-applied lines')
    const rec = (await lines(ctx, `jq -c '.personas[] | select(.name == "persona_a") | .channels' "$S/config.json.last-applied"`))[0] ?? ''
    f.expect(rec.includes(`{"id":"${ids.coordination}","delivery":"mentions"}`), 'the record does not show coordination back at mentions')
    f.expect((await serverPid(ctx)) === pidBefore, 'the server PID changed')
    f.expect(((await lines(ctx, "tmux list-panes -t slack_bot_persona_a -F '#{pane_pid}'"))[0] ?? '') === paneBefore, "A's pane process changed")
    const w3 = await human.post(ids.coordination, 'Window closed check, no reply needed.')
    await pause(ctx, MINUTE)
    f.expect((await tags(ctx, 'a', w3)).length === 0, 'A received an unaddressed coordination message after the restore')
    replyOk(f, 'driftwood recalled', await askAndWait(ctx, ids.aHome, 'What word did I ask you to remember? Reply with just that word.', 'a', 'driftwood'))
    return f.result()
  },
}

export const CHANNEL_CHECKS = [check1, check2, check3, check4, check5, check6, check7, check8, check9, check10, check11, check12, check13]
