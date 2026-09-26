/**
 * lifecycle-checks.ts — testplans/b.yko Parts 8–11: the lost message (24,
 * with its setup and teardown), runtime add and remove (25–27), the reboot
 * (28, a `docker restart` of the container with the start-at-boot marker
 * set) and the closing secrecy check (29a), plus the optional 26 and 29b.
 */

import { isFrom, messageText } from '../lib/human-session.ts'
import { CONTAINER_HOME } from '../lib/docker.ts'
import { describeError } from '../lib/errors.ts'
import { personaEntryFor } from '../lib/live-config.ts'
import { ROTATED_APP_TOKEN_NAME } from '../lib/personas.ts'
import { describeScan } from '../lib/secrecy-scan.ts'
import { waitFor, MINUTE, POLL_MS, SECOND } from '../lib/wait.ts'
import type { CheckContext } from './context.ts'
import { Findings, pass, type CheckDef } from './framework.ts'
import {
  appliedLine,
  askAndWait,
  bot,
  checkPreview,
  checkStartLines,
  confirmedEdit,
  countsText,
  editConfig,
  fileExists,
  guarded,
  guardedRestart,
  lines,
  mark,
  mention,
  needHuman,
  pause,
  personaPostsAfter,
  previewHeader,
  promptState,
  q,
  recorded,
  rows,
  run,
  S,
  serverPid,
  serverTokenEnvCount,
  since,
  sinceGrep,
  sinceGrepE,
  tags,
  tmark,
  waitBringUp,
  waitLog,
  waitPending,
  waitPromptPost,
} from './helpers.ts'

const LIVE: ['workspace', 'claude'] = ['workspace', 'claude']

const SETTINGS_PREVIEW = [
  previewHeader({ settings: 1 }),
  'server-wide setting session_restart_delay changed: once applied, it is recorded and takes effect at the next server start after that.',
]

/** No persona post about a pending change in any of `channels` after `after`. */
async function noReloadTalk(ctx: CheckContext, f: Findings, channels: string[], after: string): Promise<void> {
  for (const ch of channels) {
    const talk = (await personaPostsAfter(ctx, ch, after)).filter((m) => /pending|preview|DESTRUCTIVE|configuration change|config\.json/i.test(messageText(m)))
    f.expect(talk.length === 0, `a post about the pending change appeared in ${ch}`)
  }
}

/** A Slack ts for "now" (for "posts made since" windows). */
function nowTs(ctx: CheckContext): string {
  return `${Math.floor(ctx.clock.now() / 1000)}.000000`
}

// ---------------------------------------------------------------------------
// Part 8
// ---------------------------------------------------------------------------

export const check24Setup: CheckDef<CheckContext> = {
  id: '24-setup',
  title: 'Check 24 setup: auto-restart off (session_restart_delay 0, confirmed, guarded restart)',
  needs: LIVE,
  row: null,
  async run(ctx) {
    const f = new Findings()
    const g = await guarded(ctx, 'true')
    if (!f.expect(g.ok, 'guard refused')) return f.result()
    const m = await mark(ctx)
    ctx.shared.origDelay = (await lines(ctx, `jq -c '.session_restart_delay' "$S/config.json"`))[0] ?? 'null'
    f.add(`ORIG_DELAY=${ctx.shared.origDelay}`)
    const ack = (await lines(ctx, `jq -r '.ack_reaction' "$S/config.json.last-applied"`))[0]
    f.expect(ack === 'eyes', 'ack_reaction in the record is not eyes')
    const out = await confirmedEdit(ctx, f, m, '.session_restart_delay = 0', SETTINGS_PREVIEW)
    f.expect((out.appliedLines[0] ?? '').includes('server-wide settings: 1 changed)'), 'the reload-applied line does not end with "server-wide settings: 1 changed)"')
    await guardedRestart(ctx, f)
    return f.result()
  },
}

export const check24: CheckDef<CheckContext> = {
  id: '24',
  title: 'Check 24: a message to a downed persona is reported at its destination, not in the channel (AC 26)',
  needs: LIVE,
  row: '24',
  async run(ctx) {
    const f = new Findings()
    const ids = ctx.ids
    const human = needHuman(ctx)
    f.expect((await rows(ctx)).some((r) => r.id === 'cscb_persona_a'), 'no cscb_persona_a row')
    const m = await mark(ctx)
    const kill = await guarded(ctx, 'tmux kill-session -t slack_bot_persona_a')
    if (!f.expect(kill.ok && kill.code === 0, 'the guarded kill did not run')) return f.result()
    const down = await waitFor(
      async () => {
        const found = await sinceGrepE(ctx, m, 'Session disconnected.*"persona_a" \\(key=persona_a\\)|Auto-restart disabled \\(delay=0\\) — skipping restart for persona=persona_a')
        return found.some((l) => l.includes('Session disconnected')) && found.some((l) => l.includes('Auto-restart disabled')) ? found : null
      },
      { timeoutMs: MINUTE, intervalMs: POLL_MS, clock: ctx.clock },
    )
    f.expect(down !== null, 'no Session disconnected + Auto-restart disabled lines for A within a minute')
    const m2 = await mark(ctx)
    const ts = await human.post(ids.coordination, `${mention(ctx, 'a')} lost-message check lost-marker-7Q3Z, reply with the word back.`)
    f.add(`TS ${ts}`)
    await pause(ctx, 2 * MINUTE)
    const noLive = await sinceGrep(ctx, m2, 'No live session for persona "persona_a" (key=persona_a)')
    const drop = await sinceGrep(ctx, m2, 'DROP: no _GET_stream for persona "persona_a"')
    const disp = await sinceGrep(ctx, m2, 'Dispatching to persona "persona_a"')
    if (noLive.length > 0) {
      f.note('Check 24: the "No live session" path')
      f.expect(noLive.length === 1 && noLive[0]!.includes(`[slack] No live session for persona "persona_a" (key=persona_a) chat_id=${ids.coordination} — dropping message`), 'the No live session line is not the expected single line')
      f.expect(disp.length === 0, 'a Dispatching line appeared on the No live session path')
    } else {
      f.note('Check 24: the "DROP: no _GET_stream" path')
      f.expect(drop.length >= 1, 'neither a No live session nor a DROP line appeared')
      f.expect(disp.length === 1 && disp[0]!.includes('hasGetStream=false'), 'the DROP path has no single Dispatching line with hasGetStream=false')
    }
    f.expect((await sinceGrep(ctx, m2, 'persona-destination-failed:')).length === 0, 'a persona-destination-failed line appeared')
    f.expect((await sinceGrep(ctx, m2, 'Scheduling restart for persona=persona_a')).length === 0, 'a restart was scheduled')
    f.expect((await tags(ctx, 'a', ts)).length === 0, 'the message was delivered to A')
    const inHome = (await human.everythingAfter(ids.aHome, ts))
    const notices = inHome.filter((x) => isFrom(x, bot(ctx, 'a')) && messageText(x).includes('Message lost'))
    f.expect(inHome.length === 1 && notices.length === 1, `A-home got ${inHome.length} message(s), ${notices.length} lost-message notice(s); expected exactly one notice`)
    if (notices[0]) {
      const text = messageText(notices[0])
      f.add(`notice ${notices[0].ts}`)
      f.expect(text.includes('Persona "persona_a" (key=persona_a)') && text.includes('auto-restart disabled'), 'the notice does not name persona_a and "auto-restart disabled"')
      f.expect(!text.includes('lost-marker-7Q3Z') && !text.includes('lost-message check'), 'the notice carries the message text')
      f.expect(!text.includes(`<@${ids.humanUserId}>`), 'the notice @-mentions the sender')
      const names = [...(await human.userNames(ids.humanUserId)), ids.humanUserId]
      f.expect(names.some((n) => text.includes(`a message from ${n} was not delivered`)), "the notice does not name the human (display name, full name or user ID)")
    }
    const inCoord = await personaPostsAfter(ctx, ids.coordination, ts)
    f.expect(inCoord.length === 0, `${inCoord.length} post(s) in coordination after the message`)
    const msg = await human.message(ids.coordination, ts)
    f.expect(!(msg?.reactions ?? []).some((r) => r.name === 'eyes' && (r.users ?? []).includes(ids.bots.a.userId)), 'the message got A\'s ack_reaction')
    return f.result()
  },
}

export const check24Teardown: CheckDef<CheckContext> = {
  id: '24-teardown',
  title: 'Check 24 teardown: restore the delay, guarded restart, A answers again',
  needs: LIVE,
  row: null,
  async run(ctx) {
    const f = new Findings()
    const orig = ctx.shared.origDelay
    if (orig === undefined) return pass(['nothing to restore: the setup did not run'])
    const m = await mark(ctx)
    const filter = orig === 'null' ? 'del(.session_restart_delay)' : `.session_restart_delay = ${orig}`
    const out = await confirmedEdit(ctx, f, m, filter, SETTINGS_PREVIEW)
    f.expect((out.appliedLines[0] ?? '').includes('server-wide settings: 1 changed)'), 'the reload-applied line does not end with "server-wide settings: 1 changed)"')
    const now = (await lines(ctx, `jq -c '.session_restart_delay' "$S/config.json"`))[0]
    f.expect(now === orig, `session_restart_delay is ${now}, not ${orig}`)
    await guardedRestart(ctx, f)
    const back = await askAndWait(ctx, ctx.ids.aHome, 'Reply with the word back.', 'a', 'back')
    f.expect(back.reply !== null, 'A did not answer after the teardown (later parts need all three personas)')
    return f.result()
  },
}

// ---------------------------------------------------------------------------
// Part 9
// ---------------------------------------------------------------------------

export const check25: CheckDef<CheckContext> = {
  id: '25',
  title: 'Check 25: a persona added on the running server comes up after the confirmation, with no restart (AC 19, AC 22)',
  needs: LIVE,
  row: '25',
  async run(ctx) {
    const f = new Findings()
    const ids = ctx.ids
    f.note('Check 25: D was added by a config.json edit and a credentials file moved into place by the runner, not by the wizard')
    const setup = await run(ctx, 'guard && mkdir -p ~/cscb-live/d && cmp -s "$S/config.json" "$S/config.json.last-applied" && [ ! -e "$S/config.json.pending" ] && kill -0 "$(cat "$S/server.pid")" && echo READY')
    if (!f.expect(setup.out.includes('READY'), 'not in the applied, nothing-pending, running state')) return f.result()
    const m = await mark(ctx)
    const pid = await serverPid(ctx)
    f.expect((await serverTokenEnvCount(ctx, pid)) === '0', 'the server environment holds a token variable')
    const before = await rows(ctx)
    ctx.shared.rowsAtCheck25 = before.map((r) => r.id).sort()
    f.add(`rows before: ${ctx.shared.rowsAtCheck25.join(', ')}`)
    f.expect(before.length === 3, 'not three rows before the addition')
    const noted = await askAndWait(ctx, ids.aHome, 'Remember the word quillfeather for later. Reply with the word noted.', 'a', 'noted')
    f.expect(noted.reply !== null, 'A did not note the word')

    // The wizard's two effects: D's credentials file appears, then D's entry is declared.
    ctx.creds.moveDIntoMount()
    const mode = (await lines(ctx, 'ls -lL ~/.config/cscb/persona_d-credentials.json'))[0] ?? ''
    f.expect(mode.startsWith('-rw-------'), "D's credentials file is not -rw------- in the container")
    const editAt = nowTs(ctx)
    const entry = JSON.stringify(personaEntryFor('d', ids))
    if (!f.expect(await editConfig(ctx, `.personas += [${entry}]`), 'the guarded edit adding D did not run')) return f.result()
    const pending = await waitPending(ctx)
    if (f.expect(pending !== null, 'no config.json.pending for the addition')) {
      checkPreview(f, pending!, [previewHeader({ added: 1 }), 'persona "persona_d" (key=persona_d) is added: it will be brought up and launched.'])
    }
    f.expect(!(await fileExists(ctx, '"$S/config.json.apply"')), 'config.json.apply exists before the rename')
    const pl = await sinceGrepE(ctx, m, 'reload-(preview|invalid):')
    f.expect(pl.length === 2 && (pl[0] ?? '').endsWith(` (preview in "${S}/config.json.pending")`), 'the reload-preview lines are not the two expected ones')
    f.expect((await lines(ctx, `since ${q(m)} | grep -F '(key=persona_d)' | grep -vF 'reload-preview:'`)).length === 0, 'D was named outside the preview before the confirmation')
    f.expect((await lines(ctx, 'tokcount "$S/config.json" "$S/config.json.pending"'))[0] === '0', 'token-shaped text in config.json or the pending file')
    f.expect((await lines(ctx, `since ${q(m)} | grep -cE 'xox[a-z]-[0-9]|xapp-[0-9]'`))[0] === '0', 'token-shaped text in the log')
    await noReloadTalk(ctx, f, [ids.aHome, ids.coordination, ids.dHome, ...[ctx.shared.aDm, ctx.shared.bDm, ctx.shared.cDm].filter((x): x is string => !!x)], editAt)

    const confirm = await guarded(ctx, 'mv "$S/config.json.pending" "$S/config.json.apply"')
    f.expect(confirm.ok && confirm.code === 0, 'the confirming rename did not run')
    const up = await waitLog(ctx, m, 'Session connected: persona "persona_d" (key=persona_d)', 3 * MINUTE)
    f.expect(up !== null, 'D did not connect within three minutes')
    if (up !== null) ctx.shared.broughtUp = [...(ctx.shared.broughtUp ?? []).filter((l) => l !== 'd'), 'd']
    const step7 = await sinceGrepE(
      ctx,
      m,
      'reload-(applied|noop|stale-confirmation|invalid):|persona-start:|at apply|spawnForPersona|Session (connected|disconnected)|persona teardown|updated in place|\\) not brought up:|persona-(credentials|directory)-|persona-slack-unreachable',
    )
    const count = (s: string) => step7.filter((l) => l.includes(s)).length
    f.expect(count(appliedLine({ added: 1 })) === 1, 'not exactly one reload-applied line for one added persona')
    f.expect(count('[slack] persona-start: personas[3] "persona_d" (key=persona_d): bring-up starting') === 1, 'not one persona-start line for D')
    f.expect(count('[slack] persona "persona_d" (key=persona_d): up at apply — launching') === 1, 'not one "up at apply — launching" line for D')
    f.expect(count('[slack] spawnForPersona: spawned "persona_d" (key=persona_d) instanceId=cscb_persona_d') === 1, 'not one spawnForPersona line for D')
    f.expect(step7.every((l) => !/persona_[abc]\b/.test(l)), 'a lifecycle line names persona_a, _b or _c')
    f.expect(step7.every((l) => !/launch at apply failed|not brought up|persona-(credentials|directory)-|persona-slack-unreachable/.test(l)), 'a failure line appeared')
    f.expect(await recorded(ctx), 'config.json and the record differ')
    f.expect(!(await fileExists(ctx, '"$S/config.json.pending"')) && !(await fileExists(ctx, '"$S/config.json.apply"')), 'a pending or apply file remains')
    f.expect((await serverPid(ctx)) === pid, 'the server PID changed')
    f.expect((await serverTokenEnvCount(ctx, pid)) === '0', 'the server environment holds a token variable')
    const after = await rows(ctx)
    f.add(`rows after: ${after.map((r) => `${r.id}(${r.persona})`).join(', ')}`)
    f.expect(after.length === 4 && after.filter((r) => r.id === 'cscb_persona_d' && r.persona === 'persona_d').length === 1, 'not four rows with one cscb_persona_d')
    f.expect(before.every((b) => after.some((a) => a.id === b.id)), "A's, B's or C's row changed")
    const arrived = await askAndWait(ctx, ids.dHome, `${mention(ctx, 'd')} reply with the word arrived.`, 'd', 'arrived')
    f.expect(arrived.reply !== null, 'D did not answer in D-home')
    const recall = await askAndWait(ctx, ids.aHome, 'What word did I ask you to remember? Reply with just that word.', 'a', 'quillfeather')
    f.expect(recall.reply !== null, 'A did not recall quillfeather')
    return f.result()
  },
}

export const check26: CheckDef<CheckContext> = {
  id: '26',
  title: 'Check 26 (optional): a revoked bot token marks the persona credentials-broken',
  needs: LIVE,
  row: '26 (optional)',
  skip: 'optional',
  run: async () => pass([]),
}

export const check27: CheckDef<CheckContext> = {
  id: '27',
  title: 'Check 27: a confirmed removal tears down only that persona (AC 57)',
  needs: LIVE,
  row: '27',
  async run(ctx) {
    const f = new Findings()
    const ids = ctx.ids
    const human = needHuman(ctx)
    const g = await guarded(ctx, 'true')
    if (!f.expect(g.ok, 'guard refused')) return f.result()
    const m = await mark(ctx)
    const pid = await serverPid(ctx)
    const before = await rows(ctx)
    f.add(`rows before: ${before.map((r) => r.id).join(', ')}`)
    // Step 2 (optional, run): D raises a prompt that is left unanswered.
    const tm = await tmark(ctx)
    await human.post(ids.dHome, `${mention(ctx, 'd')} run a shell command that writes the current date to a file named removal-prompt.txt in your working directory.`)
    const dPrompt = await waitPromptPost(ctx, tm, 'd', 2 * MINUTE)
    const promptTs = dPrompt?.[0]?.slack_ts
    f.note(`Check 27 step 2: ${promptTs ? `ran (prompt ${promptTs} in D-home)` : 'ran, but D raised no prompt in time'}`)

    const preview = [
      previewHeader({ removed: 1 }),
      'DESTRUCTIVE: persona "persona_d" (key=persona_d) is removed: its live session will be destroyed (its instance is torn down).',
    ]
    await confirmedEdit(ctx, f, m, 'del(.personas[] | select(.name == "persona_d"))', preview)
    const names = await lines(ctx, `jq -r '.personas[].name' "$S/config.json"`)
    f.expect(JSON.stringify(names) === JSON.stringify(['persona_a', 'persona_b', 'persona_c']), 'config.json does not name exactly A, B and C')
    const pl = await sinceGrep(ctx, m, '[slack] reload-preview: ')
    f.expect(pl.length === 2, 'the reload-preview lines are not the two expected ones')
    await waitLog(ctx, m, '[slack] persona teardown of "persona_d" (key=persona_d): complete', 30 * SECOND)
    const step6 = await sinceGrepE(ctx, m, 'reload-(applied|noop|stale-confirmation|invalid):|persona-start:|at apply|spawnForPersona|Session (connected|disconnected)|persona teardown|updated in place')
    f.expect(step6.some((l) => l.includes('[slack] persona teardown of "persona_d" (key=persona_d): starting')), 'no teardown starting line for D')
    f.expect(step6.some((l) => l.trimEnd().endsWith('[slack] persona teardown of "persona_d" (key=persona_d): complete')), 'no clean teardown complete line for D')
    f.expect(step6.filter((l) => l.includes(appliedLine({ removed: 1 }))).length === 1, 'not one reload-applied line for one removal')
    f.expect(step6.every((l) => !/persona_[abc]\b/.test(l) && !l.includes('persona-start:')), 'a line names A, B or C, or a persona-start line appeared')
    if (step6.some((l) => l.includes('Session disconnected'))) f.note('Check 27: a Session disconnected line for D appeared')
    f.expect(await recorded(ctx), 'config.json and the record differ')
    f.expect(!(await fileExists(ctx, '"$S/config.json.pending"')) && !(await fileExists(ctx, '"$S/config.json.apply"')), 'a pending or apply file remains')
    f.expect((await serverPid(ctx)) === pid, 'the server PID changed')
    const after = (await rows(ctx)).map((r) => r.id).sort()
    f.expect(JSON.stringify(after) === JSON.stringify(ctx.shared.rowsAtCheck25 ?? ['cscb_persona_a', 'cscb_persona_b', 'cscb_persona_c']), `rows after the removal: ${after.join(', ')}`)

    const m2 = await mark(ctx)
    const t1 = await human.post(ids.dHome, `${mention(ctx, 'd')} reply with the word gone.`)
    const dDm = await human.openDm(ids.bots.d.userId)
    const t2 = await human.post(dDm, 'Reply with the word gone.')
    await pause(ctx, 2 * MINUTE)
    f.expect((await sinceGrepE(ctx, m2, 'persona=persona_d:|Dispatching to persona "persona_d"|persona-dm-dropped: .*"persona_d"')).length === 0, "D's connection still delivered events")
    f.expect((await personaPostsAfter(ctx, ids.dHome, t1)).filter((x) => isFrom(x, bot(ctx, 'd'))).length === 0, 'D posted in D-home')
    f.expect((await personaPostsAfter(ctx, dDm, t2)).filter((x) => isFrom(x, bot(ctx, 'd'))).length === 0, 'D posted in its DM')
    if (promptTs && ctx.browser) {
      await ctx.browser.clickMessageButton(ids.teamId, ids.dHome, promptTs, 'Allow').catch(() => undefined)
      await pause(ctx, MINUTE)
      const msg = await human.message(ids.dHome, promptTs)
      f.expect(msg !== null && promptState(msg) === 'open', 'the inert prompt changed after the click')
      f.expect(!(await fileExists(ctx, '~/cscb-live/d/removal-prompt.txt')), 'removal-prompt.txt exists')
    }
    const recall = await askAndWait(ctx, ids.aHome, 'What word did I ask you to remember? Reply with just that word.', 'a', 'quillfeather')
    f.expect(recall.reply !== null, 'A did not recall quillfeather')
    return f.result()
  },
}

// ---------------------------------------------------------------------------
// Part 10
// ---------------------------------------------------------------------------

export const check28: CheckDef<CheckContext> = {
  id: '28',
  title: 'Check 28: after a reboot every applied persona comes back, an unconfirmed edit stays pending, a pending credentials change is applied (AC 13, AC 70, AC 72)',
  needs: LIVE,
  row: '28 (reboot)',
  async run(ctx) {
    const f = new Findings()
    const ids = ctx.ids
    const human = needHuman(ctx)
    if (!ctx.browser) throw new Error('no browser')
    // Prerequisite: the boot mechanism (the analogue of the plan's @reboot line).
    const boot = await guarded(ctx, 'touch ~/cscb-live/.start-at-boot && echo BOOT')
    if (!f.expect(boot.out.includes('BOOT'), 'could not set the start-at-boot marker')) return f.result()
    f.note('Check 28: boot mechanism = the container entrypoint starts the server when ~/cscb-live/.start-at-boot exists (no token variable, no SLACK_STATE_DIR); reboot = docker restart; stop --stop-bots did not run before it')

    // Step 1.
    f.expect(await recorded(ctx), 'step 1: config.json and the record differ')
    f.expect(!(await fileExists(ctx, '"$S/config.json.pending"')), 'step 1: a change is pending')
    const rows1 = (await rows(ctx)).map((r) => r.id).sort()
    f.add(`rows before: ${rows1.join(', ')}`)
    f.expect(JSON.stringify(rows1) === JSON.stringify(['cscb_persona_a', 'cscb_persona_b', 'cscb_persona_c']), 'step 1: not the three rows')

    // Step 2: a pending credentials change for B.
    const oldName = ctx.creds.bAppTokenName()
    const newName = `${ROTATED_APP_TOKEN_NAME}-${ctx.runId}`
    const newToken = await ctx.browser.generateAppToken(ids.bots.b.appId, newName)
    const m1 = await mark(ctx)
    await ctx.creds.rewriteBAppToken(newToken)
    ctx.creds.setBAppTokenName(newName)
    f.note(`Check 28: B's new app-level token is named ${newName} (the run id keeps reruns from colliding); the older one (${oldName}) is revoked in step 7`)
    const credsLine = `persona "persona_b" (key=persona_b): credentials file "${CONTAINER_HOME}/.config/cscb/persona_b-credentials.json" changed: a new connection opens, then the old one closes, instance kept.`
    const p2 = await waitPending(ctx)
    if (f.expect(p2 !== null, 'step 2: no pending file for the credentials change')) {
      checkPreview(f, p2!, [previewHeader({ credentials: 1 }), credsLine])
    }
    f.expect((await sinceGrep(ctx, m1, '[slack] reload-preview: ')).length === 2, 'step 2: not two reload-preview lines')
    f.expect((await sinceGrepE(ctx, m1, 'persona-start:|Session disconnected|persona teardown|reload-applied')).length === 0, 'step 2: something was applied')
    f.expect((await lines(ctx, 'tokcount "$S/config.json.pending"'))[0] === '0', 'step 2: token-shaped text in the pending file')
    const still = await askAndWait(ctx, ids.coordination, `${mention(ctx, 'b')} reply with the word still-here.`, 'b', 'still-here')
    f.expect(still.reply !== null, 'step 2: B did not answer still-here')

    // Step 3: an unconfirmed destructive edit.
    await run(ctx, 'cp "$S/config.json" ~/cscb-live/config-before-reboot.json')
    const talkFrom = nowTs(ctx)
    const m3 = await mark(ctx)
    f.expect(await editConfig(ctx, 'del(.personas[] | select(.name == "persona_c"))'), 'step 3: the guarded edit did not run')
    await pause(ctx, 30 * SECOND)
    const p3 = await waitPending(ctx)
    const destructiveC = 'DESTRUCTIVE: persona "persona_c" (key=persona_c) is removed: its live session will be destroyed (its instance is torn down).'
    if (f.expect(p3 !== null, 'step 3: no pending file')) {
      f.expect(p3!.preview.filter((l) => l.startsWith('DESTRUCTIVE:')).length === 1 && p3!.preview.includes(destructiveC), "step 3: not exactly C's DESTRUCTIVE line")
      f.expect((p3!.preview[0] ?? '').includes(countsText({ removed: 1, credentials: 1 })), 'step 3: the counts are not 1 removed, 1 with changed credentials')
      f.expect(p3!.preview.indexOf(credsLine) > p3!.preview.indexOf(destructiveC), "step 3: B's credentials line is not after C's line")
    }
    f.expect((await sinceGrep(ctx, m3, '[slack] reload-preview: DESTRUCTIVE:')).length === 1, 'step 3: the DESTRUCTIVE preview line was not logged exactly once')
    f.expect((await sinceGrepE(ctx, m3, 'persona-start:|Session disconnected')).length === 0, 'step 3: something was applied')
    f.expect((await rows(ctx)).length === 3, 'step 3: the rows changed')

    // Step 4: the reboot.
    await run(ctx, 'guard && mark > ~/cscb-live/reboot-log-mark && { wc -l < "$S/startup-errors.log" 2>/dev/null || echo 0; } > ~/cscb-live/reboot-errors-mark')
    const bmark = (await lines(ctx, 'cat ~/cscb-live/reboot-log-mark'))[0] ?? ''
    await ctx.restartContainer()

    // Step 5: no manual action; the boot mechanism starts the server.
    const complete = await waitLog(ctx, bmark, '[slack] startupSessionManager: complete', 10 * MINUTE)
    f.expect(complete !== null, 'step 5: no start summary within 10 minutes of the reboot')
    const running = await run(ctx, 'kill -0 "$(cat "$S/server.pid")" && echo running')
    f.expect(running.out.includes('running'), 'step 5: the server is not running')
    // Each persona's Session connected line, not only B's: a persona parked on a `working` row (b.f2b)
    // connects after the summary (about 60 s after, when the row is stale).
    await waitBringUp(ctx, bmark, ['a', 'b', 'c'])
    const l5 = await since(ctx, bmark)
    f.expect(l5.some((l) => l.includes('[slack] Loaded persona config: 3 persona(s)')), 'step 5: no "Loaded persona config: 3 persona(s)" line')
    await checkStartLines(ctx, f, bmark, ['a', 'b', 'c'], true)
    if (complete?.[0]) f.note(`Check 28 summary: ${complete[0].replace(/^.*complete — /, '')}`)
    const rows5 = await rows(ctx)
    f.expect(rows5.length === 3 && new Set(rows5.map((r) => r.persona)).size === 3, 'step 5: not one row per persona')

    // Step 6: what is still pending.
    await pause(ctx, 30 * SECOND)
    const p6 = await waitPending(ctx)
    if (f.expect(p6 !== null, 'step 6: config.json.pending is missing after the reboot')) {
      f.expect((p6!.preview[0] ?? '').includes(countsText({ removed: 1 })), "step 6: the counts are not 1 removed (B's change still pending?)")
      f.expect(p6!.preview.includes(destructiveC), "step 6: C's DESTRUCTIVE line is missing")
    }
    f.expect((await lines(ctx, 'grep -c persona_b "$S/config.json.pending"'))[0] === '0', 'step 6: the pending file names persona_b')
    f.expect((await sinceGrep(ctx, bmark, '[slack] reload-preview: DESTRUCTIVE:')).length === 1, 'step 6: the DESTRUCTIVE preview was not logged exactly once since the reboot')
    f.expect(!(await recorded(ctx)), 'step 6: config.json matches the record')
    const recNames = await lines(ctx, `jq -r '.personas[].name' "$S/config.json.last-applied"`)
    f.expect(JSON.stringify(recNames) === JSON.stringify(['persona_a', 'persona_b', 'persona_c']), 'step 6: the record does not name A, B and C')

    // Step 7: each persona answers; B runs on the new token.
    f.expect((await askAndWait(ctx, ids.aHome, 'Reply with the word rebooted.', 'a', 'rebooted')).reply !== null, 'step 7: A did not answer rebooted')
    f.expect((await askAndWait(ctx, ids.coordination, `${mention(ctx, 'b')} reply with the word rebooted.`, 'b', 'rebooted')).reply !== null, 'step 7: B did not answer rebooted')
    const cDm = ctx.shared.cDm ?? (await human.openDm(ids.bots.c.userId))
    f.expect((await askAndWait(ctx, cDm, 'Reply with the word rebooted.', 'c', 'rebooted')).reply !== null, 'step 7: C did not answer rebooted')
    const m7 = await mark(ctx)
    // A failed revocation, whatever threw (a flow step, a Playwright timeout, a closed page, a failed navigation), is a finding,
    // not a throw: the rest of step 7 and step 8's revert (which clears the pending file) still run. Described, never raw.
    let revoked = false
    try {
      await ctx.browser.revokeAppToken(ids.bots.b.appId, oldName)
      revoked = true
    } catch (err) {
      f.expect(false, `step 7: revoke failed: ${describeError(err)}`)
      f.note(`Check 28: B's older app-level token (${oldName}) may still be valid: revoke it on B's Basic Information page`)
    }
    if (revoked) {
      await pause(ctx, 2 * MINUTE)
      f.expect((await askAndWait(ctx, ids.coordination, `${mention(ctx, 'b')} reply with the word rotated.`, 'b', 'rotated')).reply !== null, 'step 7: B did not answer after the older token was revoked')
      f.expect((await sinceGrepE(ctx, m7, 'persona-(connection-lost|credentials-refused|slack-unreachable)')).filter((l) => l.includes('(key=persona_b)')).length === 0, "step 7: B's connection was lost or refused")
    }
    await noReloadTalk(ctx, f, [ids.aHome, ids.coordination, cDm, ...[ctx.shared.aDm, ctx.shared.bDm].filter((x): x is string => !!x)], talkFrom)
    f.expect((await lines(ctx, 'tokcount "$S/config.json.pending"'))[0] === '0', 'step 7: token-shaped text in the pending file')
    f.expect((await lines(ctx, 'tokcount "$S"/server.log*'))[0] === '0', 'step 7: token-shaped text in server.log')
    f.expect((await lines(ctx, `tail -n +"$(($(cat ~/cscb-live/reboot-errors-mark) + 1))" "$S/startup-errors.log" 2>/dev/null | grep -c 'reload'`))[0] === '0', 'step 7: a reload line in startup-errors.log')

    // Step 8: revert the removal of C.
    const m8 = await mark(ctx)
    await guarded(ctx, 'cp ~/cscb-live/config-before-reboot.json "$S/config.json"')
    f.expect(await recorded(ctx), 'step 8: config.json does not match the record after the revert')
    await pause(ctx, 30 * SECOND)
    f.expect(!(await fileExists(ctx, '"$S/config.json.pending"')), 'step 8: config.json.pending still exists')
    f.expect((await sinceGrep(ctx, m8, '[slack] reload-nothing-pending: the configuration file and the credentials files it references match what is applied; no change is pending')).length === 1, 'step 8: not one reload-nothing-pending line')
    f.expect((await sinceGrepE(ctx, m8, 'persona-start:|Session disconnected|spawnForPersona')).length === 0, 'step 8: the revert brought something up or down')
    await run(ctx, 'rm -f ~/cscb-live/config-before-reboot.json ~/cscb-live/reboot-log-mark ~/cscb-live/reboot-errors-mark')
    return f.result()
  },
}

// ---------------------------------------------------------------------------
// Part 11
// ---------------------------------------------------------------------------

/** The per-file counts `leakcount` prints: `tokens checked: N`, then `<file>: <n|absent>`. */
export function parseLeakcount(out: string[]): { checked: number; files: Record<string, string> } {
  let checked = -1
  const files: Record<string, string> = {}
  for (const l of out) {
    const c = /^tokens checked: (\d+)$/.exec(l)
    if (c) {
      checked = Number(c[1])
      continue
    }
    const i = l.lastIndexOf(': ')
    if (i > 0) files[l.slice(0, i)] = l.slice(i + 2)
  }
  return { checked, files }
}

/**
 * A count the scan printed (`wc -l`, `grep -c`): a whole number, or NaN (a
 * parse failure, never 0) when the value is empty or anything else.
 */
export function parseCount(value: string): number {
  const m = /^\s*(\d+)\s*$/.exec(value)
  return m ? Number(m[1]) : NaN
}

export interface PersonaCounts {
  transcripts: number
  delivered: number
}

/**
 * `PERSONA_<l>=<transcripts> <delivered>` from Check 29a's script: a
 * persona's transcript and Dispatching counts. Unless the value is exactly
 * two whole numbers, both are NaN (a parse failure, never 0).
 */
export function parsePersonaCounts(value: string): PersonaCounts {
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(value)
  return m ? { transcripts: Number(m[1]), delivered: Number(m[2]) } : { transcripts: NaN, delivered: NaN }
}

/** Why a persona's `PERSONA_<l>` line can't be read, for Check 29a's FAIL reason. */
export function personaCountsProblem(letter: string, value: string | undefined): string {
  const what = `PERSONA_${letter}`
  if (value === undefined) return `persona ${letter}: no transcript count`
  if (value.trim() === '') return `persona ${letter}: empty transcript count (${what} is empty, not "<transcripts> <dispatched>")`
  return `persona ${letter}: malformed transcript count (${what} is not "<transcripts> <dispatched>")`
}

export const check29a: CheckDef<CheckContext> = {
  id: '29a',
  title: 'Check 29a: no credential in any file the run wrote (AC 20), plus the host-side scan of the results',
  needs: [],
  row: '29a',
  // A leak matters however far the run got.
  always: true,
  async run(ctx) {
    const f = new Findings()
    const files = '"$S/config.json" "$S/config.json.last-applied" "$S/config.json.pending" "$S"/server.log* "$S/startup-errors.log" "$S/permission-trail.jsonl" ~/cscb-live/boot-start.log'
    const script = [
      `F=(${files})`,
      "mapfile -d '' T < <(find ~/.claude/projects/ -path '*-cscb-live-[abcd]/*' -name '*.jsonl' -print0 2>/dev/null)",
      'echo "TRANSCRIPTS=${#T[@]}"',
      // Per persona: its transcripts, and how many messages the server dispatched to it (all of server.log*).
      'for l in a b c d; do',
      '  n=$(find ~/.claude/projects/ -path "*-cscb-live-$l/*" -name \'*.jsonl\' 2>/dev/null | wc -l)',
      '  d=$(cat "$S"/server.log* 2>/dev/null | grep -cF "Dispatching to persona \\"persona_$l\\" (key=persona_$l)")',
      '  echo "PERSONA_$l=$n $d"',
      'done',
      '[ -e "$S/config.json.pending" ] && echo PENDING=present || echo PENDING=absent',
      'echo "TOKF=$(tokcount "${F[@]}")"',
      'echo "TOKT=$( [ ${#T[@]} -gt 0 ] && tokcount "${T[@]}" || echo 0 )"',
      'echo "TOKH=$(tokcount "${HISTFILE:-$HOME/.bash_history}" ~/.claude/projects/*-cscb-live-wizard/*.jsonl)"',
      'echo "WSS=$(cat "$S"/server.log* 2>/dev/null | grep -cE \'wss://|ticket=\')"',
      'echo "MSG=$(cat "$S"/server.log* 2>/dev/null | grep -oE \'message="[^"]*"\' | grep -cE \'xox[a-z]-[0-9]|xapp-[0-9]\')"',
      'echo "RURL=$(cat "$S"/server.log* 2>/dev/null | grep -cF \'<redacted-url>\')"',
      'echo "RTOK=$(cat "$S"/server.log* 2>/dev/null | grep -cF \'<redacted-token>\')"',
      'echo LEAK-F; leakcount "${F[@]}"',
      'echo LEAK-T; [ ${#T[@]} -gt 0 ] && leakcount "${T[@]}"',
      'echo LEAK-H; leakcount "${HISTFILE:-$HOME/.bash_history}"',
    ].join('\n')
    const out = (await ctx.container.sh(script, { timeoutMs: 300_000 })).stdout.split('\n').filter(Boolean)
    const rawField = (name: string) => out.find((l) => l.startsWith(`${name}=`))?.slice(name.length + 1)
    const field = (name: string) => rawField(name) ?? '?'
    // An empty or malformed count is a parse failure (NaN), never 0: 0 would skip the transcripts' leak scan.
    const transcripts = parseCount(field('TRANSCRIPTS'))
    f.add(`persona transcripts: ${transcripts}`)
    f.expect(Number.isFinite(transcripts), `persona transcripts: ${transcripts} (the scan printed no count)`)
    // Each persona this run brought up and dispatched a message to has a transcript for leakcount to read.
    for (const l of ctx.shared.broughtUp ?? []) {
      const value = rawField(`PERSONA_${l}`)
      const c = parsePersonaCounts(value ?? '')
      if (Number.isNaN(c.transcripts)) {
        f.expect(false, personaCountsProblem(l, value))
        continue
      }
      f.add(`persona ${l}: ${c.transcripts} transcript(s), ${c.delivered} dispatched message(s)`)
      if (c.delivered > 0) f.expect(c.transcripts >= 1, `persona ${l} was brought up and sent ${c.delivered} message(s), but has no transcript`)
      else f.note(`Check 29a: persona ${l} was brought up but no message was dispatched to it, so no transcript is required`)
    }
    f.expect(field('PENDING') === 'absent', 'config.json.pending exists')
    for (const [name, what] of [['TOKF', 'the state files'], ['TOKT', 'the persona transcripts'], ['TOKH', 'the shell history and wizard transcripts'], ['WSS', 'wss:// or ticket= in server.log'], ['MSG', 'message="…" fields']] as const) {
      f.expect(field(name) === '0', `${what}: count ${field(name)}`)
    }
    f.note(`Check 29a placeholders: <redacted-url> ${field('RURL')}, <redacted-token> ${field('RTOK')}`)
    const split = (tag: string, next: string | null) => {
      const i = out.indexOf(tag)
      const j = next ? out.indexOf(next) : out.length
      return i === -1 ? [] : out.slice(i + 1, j === -1 ? out.length : j)
    }
    const expected = ctx.creds.mountedCount() * 2
    for (const [tag, next] of [['LEAK-F', 'LEAK-T'], ['LEAK-T', 'LEAK-H'], ['LEAK-H', null]] as const) {
      const lc = parseLeakcount(split(tag, next))
      if (tag === 'LEAK-T' && transcripts === 0) continue
      f.expect(lc.checked === expected, `${tag}: tokens checked ${lc.checked}, not ${expected}`)
      const bad = Object.entries(lc.files).filter(([, v]) => v !== '0' && v !== 'absent')
      f.expect(bad.length === 0, `${tag}: ${bad.length} file(s) hold a credential`)
    }
    f.add(`tokens checked: ${expected}`)
    const scan = ctx.hostScan()
    for (const line of describeScan(scan)) f.add(`host: ${line}`)
    f.expect(scan.total === 0, `the host-side scan of the results found ${scan.total} token-shaped or secret string(s)`)
    return f.result()
  },
}

export const check29b: CheckDef<CheckContext> = {
  id: '29b',
  title: 'Check 29b (optional): a real handshake failure logs no ticket URL',
  needs: LIVE,
  row: '29b (optional)',
  skip: 'optional: needs host sudo/iptables',
  run: async () => pass([]),
}

export const LIFECYCLE_CHECKS = [check24Setup, check24, check24Teardown, check25, check26, check27, check28, check29a, check29b]
