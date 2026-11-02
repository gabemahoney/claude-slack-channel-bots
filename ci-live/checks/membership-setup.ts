/**
 * membership-setup.ts — C's current-app setup readiness for membership
 * events (SRD t1.tad.5i SR-3.4): the evidence rules, the client of the
 * server's local `/membership-readiness` route, and two runner checks
 * (`row: null`; the hand-run plan has no such step).
 *
 * The evidence comes from the runner, never from the server's runtime
 * credentials (which can't inspect Slack app settings): this run's
 * provisioning outcomes, apps.json's `needs_reinstall` and one
 * `apps.manifest.export` with the configuration token (`ctx.setup`). Live
 * joins and leaves, scans and silence are never setup evidence, and the
 * inventory state is reported apart from the verdict.
 *
 * - `membershipSetupCheck` (after Check 1 brings C up, before Check 24's
 *   restart): reads C's readiness, checks the server's authenticated
 *   installation is the provisioned app, records the derived evidence for
 *   it, proves a record for another app's installation is refused, and reads
 *   the record back with C's saved choices unchanged;
 * - `membershipSetupRestartCheck` (after Check 28's reboot, before Part
 *   11): the record still holds for the same installation, with no further
 *   reinstall, under another server process (a different PID owning
 *   `server.port`); the same process is SKIPPED as not run, never PASS.
 *
 * Setup that can't be inspected (no usable configuration token, a tokenless
 * reuse, no provisioning report) is SKIPPED as not run with its limit, never
 * PASS. The route follows skills/debug-slack-channel-bots/SKILL.md's
 * "Membership setup record and readback": `server.port` must belong to the
 * running PID, then `curl` on the loopback listener; the record runs behind
 * the plan's guard. Nothing reads or sends a token, and the route's answer
 * is passed through `showsafe` and projected to the fields below.
 *
 * The runner loads no src/ module but the two import-free text modules, so
 * every server text and constant used here is a copy held once below, in
 * "Copied texts", each naming its src/ source and each pinned against it in
 * tests/ci-live-checks.test.ts.
 */

import { manifestDrift, type JsonObject } from '../lib/manifest.ts'
import { personaName, type PersonaLetter } from '../lib/personas.ts'
import type { CheckContext, LiveIds, ManifestExport, ProvisionedApp } from './context.ts'
import { Findings, notRun, type CheckDef } from './framework.ts'
import { guarded, jsonLines, lines, mark, q, run, S, sinceGrep } from './helpers.ts'

// ---------------------------------------------------------------------------
// Copied texts (each pinned against its src/channel-membership-readiness.ts source)
// ---------------------------------------------------------------------------

/** src/channel-membership-readiness.ts `MEMBERSHIP_READINESS_ROUTE`. */
export const MEMBERSHIP_READINESS_ROUTE = '/membership-readiness'
/** src/channel-membership-readiness.ts `MEMBERSHIP_REQUIRED_SUBSCRIPTIONS`. */
export const MEMBERSHIP_REQUIRED_SUBSCRIPTIONS = ['member_joined_channel', 'channel_left'] as const
/** src/channel-membership-readiness.ts `MEMBERSHIP_SETUP_UNKNOWN`. */
export const MEMBERSHIP_SETUP_UNKNOWN = 'channel-membership-setup-unknown'
/** src/channel-membership-readiness.ts `MEMBERSHIP_SUBSCRIPTIONS_MISSING`. */
export const MEMBERSHIP_SUBSCRIPTIONS_MISSING = 'channel-membership-subscriptions-missing'
/** src/channel-membership-readiness.ts `MEMBERSHIP_REINSTALL_INCOMPLETE`. */
export const MEMBERSHIP_REINSTALL_INCOMPLETE = 'channel-membership-reinstall-incomplete'
/** src/channel-membership-readiness.ts `MEMBERSHIP_SETUP_VERIFIED`. */
export const MEMBERSHIP_SETUP_VERIFIED = 'channel-membership-setup-verified'
/** src/channel-membership-readiness.ts `MEMBERSHIP_SETUP_RECORDED`. */
export const MEMBERSHIP_SETUP_RECORDED = 'channel-membership-setup-recorded'

export type RequiredSubscription = (typeof MEMBERSHIP_REQUIRED_SUBSCRIPTIONS)[number]
export type SubscriptionEvidence = 'verified' | 'missing' | 'unknown'
export type ReinstallEvidence = 'complete' | 'incomplete' | 'unknown'
export type SetupState = 'verified' | 'missing-subscriptions' | 'incomplete-reinstall' | 'unknown'
export type SubscriptionsEvidence = Record<RequiredSubscription, SubscriptionEvidence>

/** src/channel-membership-readiness.ts `membershipSetupRecordedDiagnostic`. */
export function membershipSetupRecordedDiagnostic(key: string): string {
  return `[slack] ${MEMBERSHIP_SETUP_RECORDED} persona=${key}: saved manual evidence for the authenticated current installation; inventory and saved choices are unchanged.`
}

/** The class src/channel-membership-readiness.ts `membershipReadinessDiagnostic` gives a state. */
export function setupStateClass(state: SetupState): string {
  return state === 'verified'
    ? MEMBERSHIP_SETUP_VERIFIED
    : state === 'missing-subscriptions'
      ? MEMBERSHIP_SUBSCRIPTIONS_MISSING
      : state === 'incomplete-reinstall'
        ? MEMBERSHIP_REINSTALL_INCOMPLETE
        : MEMBERSHIP_SETUP_UNKNOWN
}

/** The head of src/channel-membership-readiness.ts `membershipReadinessDiagnostic`: `[slack] <code> persona=<key>: `. */
export function readinessDiagnosticHead(code: string, key: string): string {
  return `[slack] ${code} persona=${key}: `
}

/** The details of src/channel-membership-readiness.ts `membershipReadinessDiagnostic`: `missing=… unknown=… reinstall=…`. */
export function readinessDiagnosticDetails(missing: readonly string[], unknown: readonly string[], reinstall: ReinstallEvidence): string {
  return `missing=${missing.join(',') || 'none'} unknown=${unknown.join(',') || 'none'} reinstall=${reinstall}`
}

// ---------------------------------------------------------------------------
// Fixed limit sentences
// ---------------------------------------------------------------------------

/** SR-3.2's downtime clause, which the live run doesn't exercise. */
export const DOWNTIME_LEAVE_LIMIT =
  'limit: a leave and rejoin wholly while the server is stopped, with no authoritative absence or observed leave, is not reconstructed (SR-3.2), and the live run does not exercise it'

/** The subscriptions could not be read: the export was unavailable (`why` is a safe code or kind). */
export function subscriptionsUninspectableLimit(why: string): string {
  return `limit: the app's event subscriptions could not be read (apps.manifest.export with the configuration token: ${why}), so member_joined_channel and channel_left are unverified`
}

/** No provisioning outcome for the app this run. */
export const NO_PROVISIONING_LIMIT =
  "limit: this run's provisioning reported no apps-stage or install-stage outcome for the app (a --stage run, a failed stage or no report), so its reinstall could not be confirmed"

/** The apps stage reused the recorded app without its export. */
export const TOKENLESS_REUSE_LIMIT =
  'limit: the apps stage reused the recorded app with no usable configuration token (no export, drift check or update), so its reinstall could not be confirmed'

/** The export at check time was unavailable, so the installed manifest could not be compared. */
export const EXPORT_UNAVAILABLE_REINSTALL_LIMIT =
  "limit: the app's manifest could not be exported at check time, so whether the installed app carries the shipped manifest could not be confirmed"

/** The export at check time differs from the shipped manifest. */
export const DRIFT_AT_CHECK_LIMIT =
  "limit: the app's exported manifest differs from the shipped manifest at check time, so its reinstall could not be confirmed"

/** An updated app the install stage did not report reinstalling. */
export const UPDATED_NOT_REINSTALLED_LIMIT =
  "limit: the apps stage updated the app's manifest but the install stage did not report reinstalling it, so its reinstall could not be confirmed"

/** This run's provisioning outcome names another app than the one judged. */
export const OTHER_APP_PROVISIONED_LIMIT =
  "limit: this run's provisioning reported its outcome for another app than the one judged, so its reinstall could not be confirmed"

/** The restart check found the same server process that the record was made under (or no earlier record). */
export const NO_RESTART_LIMIT = 'limit: no restart between record and readback in this run'

// ---------------------------------------------------------------------------
// Evidence from the runner (pure)
// ---------------------------------------------------------------------------

export interface SetupEvidenceInput {
  /** The app ID apps.json records for the persona. */
  appId: string
  provisioned: ProvisionedApp
  needsReinstall: boolean
  /** The export at check time. */
  exported: ManifestExport
  /** The manifest generated from the shipped `slack-app-manifest.yml`. */
  wanted: JsonObject
}

export interface SetupEvidence {
  subscriptions: SubscriptionsEvidence
  reinstall: ReinstallEvidence
  /** One fixed sentence per unknown cause. */
  limits: string[]
  /** IDs, event names, action words and manifest paths only. */
  facts: string[]
}

/** The exported manifest's `settings.event_subscriptions.bot_events`, strings only. */
function botEvents(manifest: JsonObject): string[] {
  const settings = manifest.settings
  const subs = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings.event_subscriptions : undefined
  const events = subs && typeof subs === 'object' && !Array.isArray(subs) ? subs.bot_events : undefined
  return Array.isArray(events) ? events.filter((e): e is string => typeof e === 'string') : []
}

/** Whether the apps stage updated the app's manifest: `updated`, or an `adopted` app that drifted (provision/apps.ts). */
function manifestUpdated(p: ProvisionedApp): boolean {
  return p.apps === 'updated' || (p.apps === 'adopted' && (p.drift ?? []).length > 0)
}

/** The setup evidence the runner can give for one persona's current app. Inventory state is not an input. */
export function setupEvidence(input: SetupEvidenceInput): SetupEvidence {
  const { provisioned: p, exported } = input
  const limits: string[] = []
  const facts: string[] = [
    `app ${input.appId}`,
    `apps stage: ${p.apps ?? 'not reported'}${p.unchecked === true ? ' (unchecked: no usable configuration token)' : ''}`,
    `install stage: ${p.install ?? 'not reported'}`,
    `needs_reinstall: ${input.needsReinstall}`,
  ]
  if (p.appId !== undefined && p.appId !== input.appId) facts.push(`apps-stage app: ${p.appId} (not the judged app)`)
  if (p.drift !== undefined && p.drift.length > 0) facts.push(`apps-stage drift: ${p.drift.join(', ')}`)

  let subscriptions: SubscriptionsEvidence
  let drift: string[] | null = null
  if (exported.kind === 'exported') {
    const events = new Set(botEvents(exported.manifest))
    subscriptions = {
      member_joined_channel: events.has('member_joined_channel') ? 'verified' : 'missing',
      channel_left: events.has('channel_left') ? 'verified' : 'missing',
    }
    facts.push(`exported bot_events (required): ${MEMBERSHIP_REQUIRED_SUBSCRIPTIONS.filter((e) => events.has(e)).join(',') || 'none'}`)
    drift = manifestDrift(input.wanted, exported.manifest)
    facts.push(`drift at check time: ${drift.join(', ') || 'none'}`)
  } else {
    subscriptions = { member_joined_channel: 'unknown', channel_left: 'unknown' }
    facts.push(`manifest export: unavailable (${exported.why})`)
    limits.push(subscriptionsUninspectableLimit(exported.why))
  }

  let reinstall: ReinstallEvidence
  if (input.needsReinstall) {
    reinstall = 'incomplete'
  } else {
    const causes: string[] = []
    if (p.apps === undefined || p.install === undefined || p.unchecked === undefined) causes.push(NO_PROVISIONING_LIMIT)
    else if (p.appId !== input.appId) causes.push(OTHER_APP_PROVISIONED_LIMIT)
    else if (p.unchecked) causes.push(TOKENLESS_REUSE_LIMIT)
    else if (manifestUpdated(p) && p.install !== 'reinstalled') causes.push(UPDATED_NOT_REINSTALLED_LIMIT)
    if (drift === null) causes.push(EXPORT_UNAVAILABLE_REINSTALL_LIMIT)
    else if (drift.length > 0) causes.push(DRIFT_AT_CHECK_LIMIT)
    reinstall = causes.length === 0 ? 'complete' : 'unknown'
    limits.push(...causes)
  }
  return { subscriptions, reinstall, limits, facts }
}

/**
 * The one-time reinstall rule (AC-J11): an updated app (or an adopted one
 * that drifted) is reinstalled, a new app is installed (not reinstalled), and
 * an undrifted reused app is not reinstalled again. Nothing when a stage is
 * unreported.
 */
export function reinstallConsistency(p: ProvisionedApp): string[] {
  if (p.apps === undefined || p.install === undefined) return []
  const out: string[] = []
  if (manifestUpdated(p) && p.install !== 'reinstalled') out.push(`the apps stage updated the app's manifest, but the install stage ${p.install} it instead of reinstalling it`)
  if (p.apps === 'created' && p.install === 'reinstalled') out.push('the apps stage created the app, but the install stage reinstalled it rather than installing it')
  if (p.apps === 'reused' && (p.drift ?? []).length === 0 && p.install === 'reinstalled') out.push('the apps stage reused the app with no drift, but the install stage reinstalled it (a redundant reinstall)')
  return out
}

/** The setup state the server derives from a record (src/channel-membership-readiness.ts's ordering). */
export function expectedSetupState(subscriptions: SubscriptionsEvidence, reinstall: ReinstallEvidence): SetupState {
  const values = MEMBERSHIP_REQUIRED_SUBSCRIPTIONS.map((e) => subscriptions[e])
  if (values.includes('missing')) return 'missing-subscriptions'
  if (reinstall === 'incomplete') return 'incomplete-reinstall'
  if (values.includes('unknown') || reinstall === 'unknown') return 'unknown'
  return 'verified'
}

// ---------------------------------------------------------------------------
// The route client
// ---------------------------------------------------------------------------

/** The four IDs of an installation (src/persona-slack-validation.ts `SlackInstallationIdentity`, enterprise dropped). */
export interface InstallationIds {
  teamId: string
  appId: string
  botUserId: string
  botId: string
}

/** The fields of the route's answer a check reads; every other field is dropped. */
export interface ReadinessProjection {
  /** A record's result kind (`recorded`, `installation-mismatch` …); absent on a read. */
  kind?: string
  view?: {
    setup: {
      state: SetupState
      reason?: string
      installation?: InstallationIds
      missingSubscriptions: string[]
      unknownSubscriptions: string[]
      reinstall: ReinstallEvidence
      record?: { subscriptions: SubscriptionsEvidence; reinstall: ReinstallEvidence; recordedAt: number; order: number }
    }
    inventory: { state: string; pages?: number }
  }
}

export type ReadinessAnswer =
  /** `pid`: the running server's PID, which owns `server.port`. */
  | { kind: 'answer'; status: number; body: ReadinessProjection; pid: number }
  | { kind: 'failed'; why: 'guard-refused' | 'no-server' | 'no-answer' | 'token-shaped' | 'unparsable' }

const SETUP_STATES: readonly string[] = ['verified', 'missing-subscriptions', 'incomplete-reinstall', 'unknown']
const SUBSCRIPTION_VALUES: readonly string[] = ['verified', 'missing', 'unknown']
const REINSTALL_VALUES: readonly string[] = ['complete', 'incomplete', 'unknown']
const RESULT_KINDS: readonly string[] = ['recorded', 'invalid', 'unknown-persona', 'installation-unverified', 'installation-mismatch', 'storage', 'superseded']
const INVENTORY_STATES: readonly string[] = ['unverified', 'scanning', 'incomplete', 'complete']
const SAFE_REASON_RE = /^[a-z-]{1,64}$/
const ID_RE = /^[A-Z][A-Z0-9]{1,31}$/

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function installationOf(v: unknown): InstallationIds | undefined | null {
  if (v === undefined) return undefined
  const o = obj(v)
  if (!o) return null
  const ids = [o.teamId, o.appId, o.botUserId, o.botId]
  if (!ids.every((id) => typeof id === 'string' && ID_RE.test(id))) return null
  return { teamId: o.teamId as string, appId: o.appId as string, botUserId: o.botUserId as string, botId: o.botId as string }
}

function subscriptionsOf(v: unknown): SubscriptionsEvidence | null {
  const o = obj(v)
  if (!o || !MEMBERSHIP_REQUIRED_SUBSCRIPTIONS.every((e) => SUBSCRIPTION_VALUES.includes(o[e] as string))) return null
  return { member_joined_channel: o.member_joined_channel as SubscriptionEvidence, channel_left: o.channel_left as SubscriptionEvidence }
}

function eventList(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((e) => (MEMBERSHIP_REQUIRED_SUBSCRIPTIONS as readonly string[]).includes(e as string)) ? (v as string[]) : null
}

/** The validated projection of the route's answer, or null when it is not one. Pure. */
export function projectReadiness(value: unknown): ReadinessProjection | null {
  const body = obj(value)
  if (!body) return null
  const out: ReadinessProjection = {}
  if (body.kind !== undefined) {
    if (!RESULT_KINDS.includes(body.kind as string)) return null
    out.kind = body.kind as string
  }
  if (body.view === undefined) return out
  const view = obj(body.view)
  const setup = obj(view?.setup)
  const inventory = obj(view?.inventory)
  if (!setup || !inventory || !SETUP_STATES.includes(setup.state as string) || !REINSTALL_VALUES.includes(setup.reinstall as string)) return null
  if (!INVENTORY_STATES.includes(inventory.state as string)) return null
  const installation = installationOf(setup.installation)
  const missing = eventList(setup.missingSubscriptions)
  const unknown = eventList(setup.unknownSubscriptions)
  if (installation === null || missing === null || unknown === null) return null
  if (setup.reason !== undefined && !(typeof setup.reason === 'string' && SAFE_REASON_RE.test(setup.reason))) return null
  let record: NonNullable<ReadinessProjection['view']>['setup']['record']
  if (setup.record !== undefined) {
    const r = obj(setup.record)
    const subscriptions = subscriptionsOf(r?.subscriptions)
    if (!r || !subscriptions || !REINSTALL_VALUES.includes(r.reinstall as string) || !Number.isSafeInteger(r.recordedAt) || !Number.isSafeInteger(r.order)) return null
    record = { subscriptions, reinstall: r.reinstall as ReinstallEvidence, recordedAt: r.recordedAt as number, order: r.order as number }
  }
  out.view = {
    setup: {
      state: setup.state as SetupState,
      ...(setup.reason !== undefined ? { reason: setup.reason as string } : {}),
      ...(installation !== undefined ? { installation } : {}),
      missingSubscriptions: missing,
      unknownSubscriptions: unknown,
      reinstall: setup.reinstall as ReinstallEvidence,
      ...(record !== undefined ? { record } : {}),
    },
    inventory: { state: inventory.state as string, ...(Number.isSafeInteger(inventory.pages) ? { pages: inventory.pages as number } : {}) },
  }
  return out
}

/** Exit codes of the route script. */
const NO_SERVER_EXIT = 3
const NO_ANSWER_EXIT = 4
const TOKEN_SHAPED_EXIT = 5

/**
 * The route script: `server.port` must belong to the running PID, then one
 * loopback POST of `request`; prints `PID=<pid>`, then the answer through
 * `showsafe`, then `HTTP=<status>`.
 */
export function readinessScript(request: Record<string, unknown>): string {
  return [
    `CSCB_PID=$(cat "$S/server.pid" 2>/dev/null) && kill -0 "$CSCB_PID" 2>/dev/null && CSCB_PORT=$(jq -er --argjson pid "$CSCB_PID" 'select(.pid == $pid) | .port | select(type == "number" and floor == . and . >= 1 and . <= 65535)' "$S/server.port" 2>/dev/null) || { echo 'no running server owns server.port' >&2; exit ${NO_SERVER_EXIT}; }`,
    'echo "PID=$CSCB_PID"',
    `body=$(curl --silent --show-error --max-time 30 -w '\\nHTTP=%{http_code}' "http://127.0.0.1:$CSCB_PORT${MEMBERSHIP_READINESS_ROUTE}" -H 'Content-Type: application/json' --data-binary ${q(JSON.stringify(request))}) || exit ${NO_ANSWER_EXIT}`,
    `printf '%s\\n' "$body" | showsafe || exit ${TOKEN_SHAPED_EXIT}`,
  ].join('\n')
}

/** A route script's result as a `ReadinessAnswer`. Pure. */
export function readinessAnswerOf(r: { code: number; out: string }): ReadinessAnswer {
  if (r.code === NO_SERVER_EXIT) return { kind: 'failed', why: 'no-server' }
  if (r.code === NO_ANSWER_EXIT) return { kind: 'failed', why: 'no-answer' }
  if (r.code === TOKEN_SHAPED_EXIT) return { kind: 'failed', why: 'token-shaped' }
  const outLines = r.out.split('\n').filter((l) => l.trim() !== '')
  const pid = /^PID=([1-9]\d{0,9})$/.exec(outLines[0] ?? '')
  const status = /^HTTP=(\d{3})$/.exec(outLines.at(-1) ?? '')
  if (r.code !== 0 || !pid || !status || outLines.length < 3) return { kind: 'failed', why: 'unparsable' }
  let parsed: unknown
  try {
    parsed = JSON.parse(outLines.slice(1, -1).join('\n'))
  } catch {
    return { kind: 'failed', why: 'unparsable' }
  }
  const body = projectReadiness(parsed)
  return body === null ? { kind: 'failed', why: 'unparsable' } : { kind: 'answer', status: Number(status[1]), body, pid: Number(pid[1]) }
}

/** Read `persona`'s readiness (read only). */
export async function readinessRead(ctx: Pick<CheckContext, 'container'>, persona: string): Promise<ReadinessAnswer> {
  return readinessAnswerOf(await run(ctx, readinessScript({ action: 'read', persona }), 60_000))
}

/** Record evidence for `persona`'s `installation`, behind the plan's guard. */
export async function readinessRecord(
  ctx: Pick<CheckContext, 'container'>,
  persona: string,
  installation: InstallationIds,
  evidence: Pick<SetupEvidence, 'subscriptions' | 'reinstall'>,
): Promise<ReadinessAnswer> {
  const request = {
    action: 'record',
    persona,
    installation: { teamId: installation.teamId, appId: installation.appId, botUserId: installation.botUserId, botId: installation.botId },
    subscriptions: { member_joined_channel: evidence.subscriptions.member_joined_channel, channel_left: evidence.subscriptions.channel_left },
    reinstall: evidence.reinstall,
  }
  const r = await guarded(ctx, readinessScript(request), 60_000)
  if (!r.ok) return { kind: 'failed', why: 'guard-refused' }
  return readinessAnswerOf(r)
}

/** True only when all four IDs of the view's installation are persona `letter`'s provisioned ones. Pure. */
export function installationMatches(view: ReadinessProjection['view'], ids: LiveIds, letter: PersonaLetter): boolean {
  const i = view?.setup.installation
  const b = ids.bots[letter]
  return i !== undefined && i.teamId === ids.teamId && i.appId === b.appId && i.botUserId === b.userId && i.botId === b.botId
}

/** An installation's key, as src/persona-slack-validation.ts `slackInstallationKey` writes it. */
export function installationKey(i: InstallationIds): string {
  return JSON.stringify([i.teamId, i.appId, i.botUserId, i.botId])
}

/** The persona's applied `channels` (`{id, delivery}`) in the last-applied record, compact JSON; null when unreadable. */
export async function savedChoices(ctx: Pick<CheckContext, 'container'>, key: string): Promise<string | null> {
  const filter = `[.applied.personas[] | select(.name == ${JSON.stringify(key)}) | [.channels[]? | {id, delivery}]] | if length == 1 then .[0] else error("no single persona") end`
  const out = await lines(ctx, `jq -c ${q(filter)} "$S/config.json.last-applied"`)
  return jsonLines<unknown>(out).length === 1 ? out[0]! : null
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

const C: PersonaLetter = 'c'

/** Why an answer is not a usable one, or null when it is. */
function answerFailure(a: ReadinessAnswer, what: string): string | null {
  return a.kind === 'failed' ? `${what}: ${a.why}` : null
}

/** A view's description for evidence: IDs and states only. */
function describeSetup(view: NonNullable<ReadinessProjection['view']>): string {
  const s = view.setup
  const r = s.record
  return (
    `setup ${s.state}${s.reason ? ` (reason ${s.reason})` : ''}: missing=${s.missingSubscriptions.join(',') || 'none'} unknown=${s.unknownSubscriptions.join(',') || 'none'} reinstall=${s.reinstall}` +
    (r ? `; record order ${r.order}, recordedAt ${r.recordedAt}` : '; no record')
  )
}

/** Step 1 of both checks: C's view, with the server's authenticated installation the provisioned one; null after a failure. */
async function readCurrent(
  ctx: CheckContext,
  f: Findings,
): Promise<{ view: NonNullable<ReadinessProjection['view']>; installation: InstallationIds; pid: number } | null> {
  const a = await readinessRead(ctx, personaName(C))
  if (!f.expect(answerFailure(a, 'read') === null, `the readiness read failed (${answerFailure(a, 'read')})`) || a.kind !== 'answer') return null
  if (!f.expect(a.status === 200 && a.body.view !== undefined, `the readiness read answered HTTP ${a.status}`)) return null
  const view = a.body.view!
  if (!f.expect(view.setup.installation !== undefined, `the server reports no authenticated installation for C (reason ${view.setup.reason ?? 'none'}); nothing was recorded`)) return null
  f.add(`installation ${installationKey(view.setup.installation!)}`)
  if (!f.expect(installationMatches(view, ctx.ids, C), "the server's authenticated installation for C is not apps.json's app; nothing was recorded")) return null
  return { view, installation: view.setup.installation!, pid: a.pid }
}

/** The inventory, as evidence apart from the verdict. */
function addInventory(f: Findings, view: NonNullable<ReadinessProjection['view']>): void {
  f.add(`inventory (reported separately, not part of this verdict): ${view.inventory.state}${view.inventory.pages !== undefined ? `, ${view.inventory.pages} page(s)` : ''}`)
}

interface Recorded {
  view: NonNullable<ReadinessProjection['view']>
  expected: SetupState
  evidence: SetupEvidence
}

/** What `deriveAndRecord` leaves for the readback. */
interface Saved {
  evidence: SetupEvidence
  expected: SetupState
  /** C's saved choices before the record. */
  choicesBefore: string
  /** The log mark taken before the record. */
  mark: string
  /** The view the record's answer carried. */
  recordedView: ReadinessProjection['view']
}

/** Steps 2–4: derive the evidence, snapshot C's saved choices, take a mark and record for `installation`; null after a failure. */
async function deriveAndRecord(ctx: CheckContext, f: Findings, installation: InstallationIds): Promise<Saved | null> {
  const key = personaName(C)
  const evidence = setupEvidence({
    appId: ctx.ids.bots.c.appId,
    provisioned: ctx.setup.provisioned(C),
    needsReinstall: ctx.setup.needsReinstall(C),
    exported: await ctx.setup.exportManifest(ctx.ids.bots.c.appId),
    wanted: ctx.setup.wantedManifest(C),
  })
  for (const fact of evidence.facts) f.add(fact)
  f.add(`evidence: member_joined_channel=${evidence.subscriptions.member_joined_channel} channel_left=${evidence.subscriptions.channel_left} reinstall=${evidence.reinstall}`)
  for (const limit of evidence.limits) f.note(limit)
  for (const problem of reinstallConsistency(ctx.setup.provisioned(C))) f.expect(false, problem)
  const expected = expectedSetupState(evidence.subscriptions, evidence.reinstall)

  const choicesBefore = await savedChoices(ctx, key)
  if (!f.expect(choicesBefore !== null, "C's saved choices could not be read from the last-applied record; nothing was recorded")) return null
  const m = await mark(ctx)

  const rec = await readinessRecord(ctx, key, installation, evidence)
  if (!f.expect(answerFailure(rec, 'record') === null, `the readiness record failed (${answerFailure(rec, 'record')})`) || rec.kind !== 'answer') return null
  if (!f.expect(rec.status === 200 && rec.body.kind === 'recorded', `the readiness record answered HTTP ${rec.status} (${rec.body.kind ?? 'no kind'})`)) return null
  const recordedView = rec.body.view
  f.add(`recorded: order ${recordedView?.setup.record?.order ?? '?'}, recordedAt ${recordedView?.setup.record?.recordedAt ?? '?'}`)
  return { evidence, expected, choicesBefore: choicesBefore!, mark: m, recordedView }
}

/** Step 5: a record for C with another persona's app, bot user and bot on this team must be refused. */
async function probeMismatch(ctx: CheckContext, f: Findings, evidence: SetupEvidence): Promise<void> {
  const a = ctx.ids.bots.a
  const probe = await readinessRecord(ctx, personaName(C), { teamId: ctx.ids.teamId, appId: a.appId, botUserId: a.userId, botId: a.botId }, evidence)
  if (f.expect(probe.kind === 'answer', `the mismatched-installation record failed (${answerFailure(probe, 'probe')})`) && probe.kind === 'answer') {
    f.expect(probe.status === 409 && probe.body.kind === 'installation-mismatch', `the mismatched-installation record answered HTTP ${probe.status} (${probe.body.kind ?? 'no kind'}), not 409 installation-mismatch`)
    f.add(`mismatched installation (persona A's app): HTTP ${probe.status} ${probe.body.kind ?? ''}`.trim())
  }
}

/**
 * Step 6's log judgement: since the mark, one recorded line for C and one
 * state line matching the readback (at most one when `before` already held a
 * record with the same evidence: the server reports a reading once per
 * process); a `missing-subscriptions` or `incomplete-reinstall` state fails
 * with its diagnostic.
 */
async function judgeDiagnostics(
  ctx: CheckContext,
  f: Findings,
  saved: Saved,
  view: NonNullable<ReadinessProjection['view']>,
  before: NonNullable<ReadinessProjection['view']>,
): Promise<void> {
  const key = personaName(C)
  const { evidence, expected } = saved
  const diag = (await sinceGrep(ctx, saved.mark, '[slack] channel-membership-')).filter((l) => l.includes(` persona=${key}: `))
  const recordedLines = diag.filter((l) => l.includes(membershipSetupRecordedDiagnostic(key)))
  f.expect(recordedLines.length === 1, `expected one ${MEMBERSHIP_SETUP_RECORDED} line for C, found ${recordedLines.length}`)
  const stateHeads = (['verified', 'missing-subscriptions', 'incomplete-reinstall', 'unknown'] as const).map((s) => readinessDiagnosticHead(setupStateClass(s), key))
  const stateLines = diag.filter((l) => stateHeads.some((h) => l.includes(h)))
  const want = readinessDiagnosticHead(setupStateClass(expected), key) + readinessDiagnosticDetails(view.setup.missingSubscriptions, view.setup.unknownSubscriptions, view.setup.reinstall)
  const prior = before.setup.record
  const sameAsPrior =
    prior !== undefined &&
    prior.subscriptions.member_joined_channel === evidence.subscriptions.member_joined_channel &&
    prior.subscriptions.channel_left === evidence.subscriptions.channel_left &&
    prior.reinstall === evidence.reinstall
  const wantCount = sameAsPrior ? stateLines.length <= 1 : stateLines.length === 1
  f.expect(wantCount && stateLines.every((l) => l.includes(want)), `expected ${sameAsPrior ? 'at most one' : 'one'} state line "${want}…" for C, found ${stateLines.length} state line(s)`)
  if (expected !== 'verified' && expected !== 'unknown') f.expect(false, `C's setup is ${expected}: ${want}`)
}

/**
 * Steps 2–7: derive and record the evidence for `installation`, probe a
 * mismatched installation, read back and judge. `before` is the view read
 * first.
 */
async function recordAndReadBack(
  ctx: CheckContext,
  f: Findings,
  installation: InstallationIds,
  before: NonNullable<ReadinessProjection['view']>,
): Promise<Recorded | null> {
  const key = personaName(C)
  const saved = await deriveAndRecord(ctx, f, installation)
  if (saved === null) return null
  const { evidence, expected, recordedView } = saved
  await probeMismatch(ctx, f, evidence)

  const back = await readinessRead(ctx, key)
  if (!f.expect(back.kind === 'answer' && back.status === 200 && back.body.view !== undefined, `the readback failed (${answerFailure(back, 'readback') ?? `HTTP ${back.kind === 'answer' ? back.status : '?'}`})`)) return null
  const view = (back as Extract<ReadinessAnswer, { kind: 'answer' }>).body.view!
  const record = view.setup.record
  f.add(`readback: ${describeSetup(view)}`)
  f.expect(view.setup.installation !== undefined && installationKey(view.setup.installation) === installationKey(installation), 'the readback names another installation')
  f.expect(view.setup.state === expected, `the server reports setup ${view.setup.state}, not ${expected}`)
  if (f.expect(record !== undefined, 'the readback holds no record')) {
    f.expect(
      record!.subscriptions.member_joined_channel === evidence.subscriptions.member_joined_channel &&
        record!.subscriptions.channel_left === evidence.subscriptions.channel_left &&
        record!.reinstall === evidence.reinstall,
      'the record holds other evidence than was sent',
    )
    const sent = recordedView?.setup.record
    f.expect(sent !== undefined && record!.order === sent.order && record!.recordedAt === sent.recordedAt, 'the record changed after it was saved (the mismatched-installation probe, or another write)')
  }
  f.expect((await savedChoices(ctx, key)) === saved.choicesBefore, "C's saved choices changed")
  await judgeDiagnostics(ctx, f, saved, view, before)
  addInventory(f, view)
  return { view, expected, evidence }
}

export const membershipSetupCheck: CheckDef<CheckContext> = {
  // `--only` takes ids of at most 16 characters (lib/args.ts).
  id: 'setup-ready',
  title: "C's current app is ready for membership events: both subscriptions and its reinstall, recorded for the authenticated installation",
  needs: ['workspace'],
  row: null,
  async run(ctx) {
    const f = new Findings()
    const current = await readCurrent(ctx, f)
    if (current === null) return f.result()
    const done = await recordAndReadBack(ctx, f, current.installation, current.view)
    if (done === null) return f.result()
    if (f.failures.length > 0) return f.result()
    // Shared only when this check found nothing wrong: the restart check builds on it.
    const record = done.view.setup.record
    if (record !== undefined) {
      ctx.shared.membershipSetup = {
        installation: installationKey(current.installation),
        order: record.order,
        recordedAt: record.recordedAt,
        state: done.view.setup.state,
        pid: current.pid,
      }
    }
    f.add(`server PID ${current.pid}`)
    if (done.view.setup.state === 'unknown') return notRun(done.evidence.limits.join('; ') || 'limit: the setup could not be inspected', f)
    return f.result()
  },
}

export const membershipSetupRestartCheck: CheckDef<CheckContext> = {
  id: 'setup-restart',
  title: "after ordinary restarts, C's readiness record still holds for the same installation, with no further reinstall",
  needs: ['workspace'],
  row: null,
  async run(ctx) {
    const f = new Findings()
    f.note(DOWNTIME_LEAVE_LIMIT)
    const current = await readCurrent(ctx, f)
    if (current === null) return f.result()
    const earlier = ctx.shared.membershipSetup
    if (earlier === undefined) {
      f.note(NO_RESTART_LIMIT)
      await recordAndReadBack(ctx, f, current.installation, current.view)
      if (f.failures.length > 0) return f.result()
      return notRun(NO_RESTART_LIMIT, f)
    }
    const view = current.view
    const record = view.setup.record
    f.add(`readback: ${describeSetup(view)}`)
    f.add(`recorded before the restarts: order ${earlier.order}, recordedAt ${earlier.recordedAt}, ${earlier.state}`)
    // A restart shows as another running server process owning server.port.
    const restarted = current.pid !== earlier.pid
    f.add(`server PID at the record ${earlier.pid}, at this readback ${current.pid}${restarted ? '' : ' (the same process: no restart)'}`)
    if (!restarted) f.note(NO_RESTART_LIMIT)
    f.expect(installationKey(current.installation) === earlier.installation, 'the installation changed since the record')
    if (f.expect(record !== undefined, 'the record from before the restarts is gone')) {
      f.expect(record!.order === earlier.order && record!.recordedAt === earlier.recordedAt, 'the record changed since it was saved before the restarts')
    }
    f.expect(view.setup.state === earlier.state, `the setup is ${view.setup.state}, not ${earlier.state} as recorded before the restarts`)
    f.expect(!ctx.setup.needsReinstall(C), 'apps.json marks C for a further reinstall')
    if (view.setup.state === 'missing-subscriptions' || view.setup.state === 'incomplete-reinstall') f.expect(false, `C's setup is ${view.setup.state}`)
    addInventory(f, view)
    if (f.failures.length > 0) return f.result()
    if (!restarted) return notRun(NO_RESTART_LIMIT, f)
    if (view.setup.state === 'unknown') return notRun('limit: the setup recorded before the restarts is unknown (uninspectable), not verified', f)
    return f.result()
  },
}
