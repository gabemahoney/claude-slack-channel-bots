/**
 * ci-live-checks.test.ts — Tests for the /ci-live runner's check framework
 * and the checks a dry run runs for real (bug b.1cx): `ci-live/checks/
 * framework.ts` (skips, blocking, the verdict), `checks/list.ts` (the plan
 * order, the HOST and Teardown checks), `lib/host-state.ts` (the read-only
 * snapshot of the production side of the host), Part 1.4's install and
 * Checks S2, S3 and 29a (`checks/setup-checks.ts`,
 * `checks/lifecycle-checks.ts`) and Check 28's
 * failed revocation against a fake container, Part 11's invited-channel
 * checks 30 to 34 (`checks/invited-checks.ts`) against a scripted workspace
 * and server, with Check 30's switch-on edit (`lib/live-config.ts`) and the
 * test human's channel gestures (`lib/human-session.ts`), and the pure
 * helpers the live checks build on (`checks/helpers.ts`,
 * `checks/channel-checks.ts`, `checks/context.ts`).
 *
 * The rules under test:
 * - a failed blocking check skips every later check except the `always`
 *   ones (29a, Teardown, HOST); a check that throws is a FAIL; the verdict is
 *   PASS only when nothing failed; a missing need is skipped with the
 *   runner's reason when it gives one (a second account needing a code);
 * - a dry run (no workspace) runs exactly the pre-flight, install, setup,
 *   S2, S3, 29a, Teardown and HOST checks;
 * - Part 1.4's install runs the image's client-under-test check
 *   (`AD_CLIENT_CHECK --package "$PKG"`, behind the guard) once, after the
 *   install and its trust step and before the state check, the package
 *   checksums and the skill link, and records its summary line; the check is
 *   check-only: no other step touches the client the package resolves; a
 *   check that exits non-zero, prints no summary or is refused by the guard
 *   is a blocking FAIL whose reason is `AD_CLIENT_CHECK_FAILED` and the
 *   check's own `ERROR:` line (or the exit or the refusal), advising no
 *   upgrade, and nothing after it runs; a failed install never reaches the
 *   check;
 * - no live check passes against a silent workspace (nothing answers);
 * - HOST fails on any change to the host's service=cscb rows, CSCB tmux
 *   sessions, port-3100 listener or config.json hash, and on a probe that
 *   failed (even the same way twice); its probes only read, on CSCB's own
 *   agent-director store;
 * - 29a fails on any token-shaped or credential count, on a host-side scan
 *   finding, on missing output, and on a persona this run brought up and
 *   dispatched a message to that has no transcript; an empty or malformed
 *   count is a parse failure (NaN), never 0, so it never skips a scan or a
 *   persona's transcript;
 * - Checks 16 and 20 ask A for the outbound call at most twice: a second ask
 *   only when A said done but made no new call; A that never says done is a
 *   FAIL; no call after two asks is Check 16's "not run" (SKIPPED) and a FAIL
 *   in Check 20; only a call made after the check's baseline is evaluated;
 * - Checks 14, 16 and 20 rerun with the same second account: an earlier
 *   run's DM is no skip. Check 14 is SKIPPED "not verified" only when this
 *   run's server log or a persona tag names the second user's whole ID before
 *   it posts (no Slack call and no container step but its two searches before
 *   that decision), and otherwise reaches A and B (in the earlier run's DM)
 *   with no approval step, judged on this run's answers only; Check 16 fails
 *   on any message in the DM with A newer than its first ask (top-level or in
 *   a thread, from anyone), never on an older one; Check 20 passes only on
 *   A's message newer than the first ask, in the DM its call result names;
 *   16 and 20 make no second-account Slack call before the first ask; 14 and
 *   20 note whether their DM held a message older than their own post or
 *   first ask (`heldBefore`: an earlier run's DM, reused) or not;
 * - Check 8 asks for a bug when the RAW prefix lacks user/bot_id; Check 9
 *   falls back to the message text and needs one RAW line of each kind;
 *   `waitTags` polls to a deadline; Check 12's limit search fails on any
 *   line but the known Slack rate-limit ones;
 * - Check 12's stop bans nothing, and once coordination is quiet (and after
 *   the limit search) the stop is lifted in coordination, and in both
 *   terminals with no Escape when the stop was typed there; the lift runs
 *   even when a step after the stop throws, and a lift Slack refuses is a
 *   note; the plan gives the same texts;
 * - `tags` and `tagstext` (the container's helpers and the plan's copy, run
 *   by bash over a fixture transcript) read a delivery from a user entry or,
 *   when it arrived mid-turn, a `queued_command` attachment (a string prompt
 *   or content blocks), once, never from the queue entries;
 * - Check 28: a failed revocation of B's older app-level token, whatever
 *   threw (a FlowError or any other error, such as Playwright's timeout), is
 *   the finding "step 7: revoke failed: <the error described>", with a note
 *   that the token may still be valid; B is not asked for "rotated", and the
 *   rest of step 7 and step 8's revert still run;
 * - the texts the checks expect match what the package writes (the pending
 *   file header, the preview counts, the reload-applied line, the S3 error,
 *   the retired removal line of Checks 27 and 28, the start summary's ending
 *   and Check 1's line, the not-live row states and a teardown's kept-row
 *   line), each built by or pinned against `src/`'s own builder, never a
 *   literal (b.jg5 SRJ-1111, SRJ-1510, SRJ-1015, SRJ-715);
 * - a start's summary line must end with the current ending, src/'s builder's
 *   with every count 0 (b.f2b's not-reconnected bucket, then SRJ-1015's five
 *   counts): an ending that stops before them, any non-zero count in it and
 *   `10 failed` are findings, and the plan quotes the same ending, Check 1's
 *   line and both checks' retired removal lines;
 * - a removed persona's row is kept and not live (b.jg5 SRJ-715, AC 77):
 *   Check 27 runs a guarded `agent-director find-missing` before it judges
 *   the rows, expects D's row kept and not live and A, B and C's unchanged,
 *   and exactly one teardown line for D's kill that succeeded with its row
 *   kept, and records whether D's row was there before the removal
 *   (`dRowKept`); Check 28 expects one live row per persona, plus D's kept
 *   row when Check 27 found it (whether or not D connected in Check 25);
 * - the guarded restart and Check 28's start after the reboot wait for each
 *   persona's Session connected line, not only the summary: a persona that
 *   connects after the summary (parked on a `working` row, b.f2b) is no
 *   finding, and one that never connects is;
 * - the test human's `createChannel` (a public channel; only its `C…` ID is
 *   returned), `kick` (`not_in_channel` is done), `archive`
 *   (`already_archived` is done) and `conversationsOf` (archived channels
 *   included: no `exclude_archived`) send exactly their Slack method and
 *   parameters, and any other refusal is a `HumanCallError` naming only the
 *   method and a safe code (b.deo SRI-1205);
 * - Part 11's invited-channel checks run 30 to 34 after every Check 28 entry
 *   and before 29a and 29b; `--only 30,31,32,33,34` runs them with the
 *   pre-flight, install, setup, Check 1, 29a, Teardown and HOST, and
 *   `--only` naming any of 30 to 33 runs Check 34 too (`undoes`); 29a hands
 *   the stored-choice file to both scans with the other state files, and an
 *   absent one is no finding (b.deo SRI-1501, SRI-1506);
 * - Check 30's switch-on edit, from the state setup and Check 1 leave and
 *   from Part 9's (with and without D), loads in fungible mode and keeps
 *   every persona's destination, changing only the switch and the `invited`
 *   sections; nothing the runner writes before Check 30 names the switch
 *   (b.deo SRI-1501, SRI-1507);
 * - against a scripted workspace and a scripted server that writes the
 *   package's own previews and apply lines: Check 30 starts only from the
 *   applied, nothing-pending, running state and records its config copy and
 *   the run channel as soon as each exists; Check 31 follows Check 16's ask
 *   rule and fails on a refused or wrong call, a missing or doubled line, or
 *   no answer to the plain message; Check 32 never passes on silence alone;
 *   Check 33 asserts the two refused calls with Slack's code (found inside
 *   any wrapper, as Check 16 reads a refusal; each in Notes), judges a call
 *   C made even when the other is missing, and records the outcome of react,
 *   edit_message and threaded fetch_messages as one note each, none deciding
 *   the result; Check 34 restores the copy with the preview and outcome the
 *   state Checks 30–33 left calls for (waiting past an earlier edit's pending
 *   file for its own), kicks C's app before it archives the channel, still
 *   undoes the channel when the config half throws, and FAILs while C is in
 *   any channel, archived ones included; Checks 31–33 never pass without
 *   Check 30's channel; none of 30–34 declares a prompt (b.deo SRI-1502 to
 *   SRI-1506);
 * - the tool-call reader, run by bash over a fixture transcript, prints
 *   exactly its projection of each CSCB session tool call (refused, accepted
 *   or with no result yet) and nothing of an accepted call's content;
 * - Checks 30 to 34 declare no prompt to the prompt guard: the live
 *   container's first boot allows the server's MCP tools as a group with no
 *   bypass mode (docker/live/entrypoint.sh, read as text);
 * - Part 11's copied texts, setting names and tool names each match src/'s
 *   builder or constant (b.deo SRI-1501);
 * - the plan agrees with the runner: its Results header is the one results.md
 *   renders from `RESULTS_COLUMNS` (every row with as many cells), Check
 *   29a's `F=(…)` list is `CHECK29A_STATE_FILES` in order, Part 2.1's
 *   `toolcalls` runs the runner's jq filter, and each text, command and
 *   placeholder Part 11 quotes is the runner's, rendered with the plan's
 *   placeholders (b.deo SRI-1111).
 *
 * No docker, network or real host state: the container, the host probes, the
 * test human's session and the clock are fakes. The real teardown lines (and
 * the real removal preview) come from the reload harness's real lifecycle
 * over its agent-director stub, under its own temp root. The bash and jq
 * children (the `q` quoting check, the transcript helpers, the tool-call
 * reader and the scripted server's config edits and reads) get their
 * environment from `hostSafeChildEnv`: a temp HOME the test removes and a
 * PATH of the tools they run.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PHASE1_FLOOR_VERSION } from '../src/ad-version-gate.ts'
import { channelModeOf, DM_DESTINATION, MCP_SERVER_NAME, parsePersonaConfigBytes, PERSONA_ENTRY_KEYS, PERSONA_INVITED_KEYS, PERSONA_TOP_LEVEL_KEYS } from '../src/config.ts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { SET_CHANNEL_DELIVERY_TOOL } from '../src/channel-delivery.ts'
import { checkPersonaTarget, createSessionServer, slackRefusalToolErrorText, type SessionEntry, type SessionToolDeps } from '../src/registry.ts'
import { personaDestinationOf } from '../src/persona-destination.ts'
import { RELOAD_APPLIED, RELOAD_NOOP, renderAppliedLogLine, renderNoopLogLine } from '../src/reload-apply.ts'
import { RELOAD_NOTHING_PENDING } from '../src/reload.ts'
import { PENDING_FILE_HEADER } from '../src/reload-fingerprint.ts'
import {
  channelDeliverySetCause as srcChannelDeliverySetCause,
  formatPersonaDiagnostic,
  invitedChannelCause as srcInvitedChannelCause,
  NO_STORED_CHOICE,
  PERSONA_CHANNEL_DELIVERY_SET,
  PERSONA_INVITED_CHANNEL,
  type PersonaDiagnosticClass,
  UNCLAIMED_CHANNEL,
  unclaimedChannelCause as srcUnclaimedChannelCause,
} from '../src/persona-diagnostics.ts'
import { KILL_RETRY_SPACING_MS, KILL_RETRY_TRIES } from '../src/kill-retry.ts'
import { isSafeIdentifier } from '../src/persona-connection-errors.ts'
import { AGENT_DIRECTOR_DEAD_STATES } from '../src/liveness-reading.ts'
import {
  DESTRUCTIVE_PREFIX,
  DESTRUCTIVE_RETIRED_CLAUSE,
  PENDING_PREVIEW_TITLE,
  REMOVED_RETIRED_CLAUSE,
  buildChangePlan,
  MODE_SWITCH_SETTING,
  modeSwitchLine,
  NO_EFFECTIVE_CHANGE,
  recordedLine,
  removedLine,
  renderChangePlanCounts,
  renderPreviewLines,
  type ChangePlanCounts,
  type ValidChangePlan,
} from '../src/reload-plan.ts'
import * as previewClauses from '../src/reload-preview-clauses.ts'
import * as summaryEndingModule from '../src/startup-summary-ending.ts'
import { startupSummaryEnding, startupSummaryLine, type StartupSummaryCounts } from '../src/session-manager.ts'
import {
  CHECK12_LIFT,
  CHECK12_PANE_STOP,
  CHECK12_STOP,
  check12,
  check12Start,
  CHECK5_PROMPT_1,
  CHECK5_PROMPT_2,
  check8,
  check9,
  COMPLETE_FIRST_START,
  expectOneTag,
  judgeLimitLines,
  rawShape,
  tagAttr,
  typeIntoPane,
} from '../ci-live/checks/channel-checks.ts'
import { DRY_RUN_IDS, liveIdsFrom, type CheckContext } from '../ci-live/checks/context.ts'
import type { CheckPromptGuard, PromptExpectation } from '../ci-live/checks/prompt-guard.ts'
import {
  callsTo,
  check14,
  check16,
  check20,
  check23,
  CHECK18_PROMPT,
  CHECK22_PROMPT,
  CHECK23_B_EXTRA,
  CHECK23_PROMPT_A,
  CHECK23_PROMPT_B,
  heldBefore,
  namesSlackId,
  newCallTo,
  OUTBOUND_ASKS,
  outboundNext,
  postsAfter,
  priorContact,
  sentDmId,
} from '../ci-live/checks/dm-checks.ts'
import { Findings, NEED_SKIP_REASONS, runChecks, skipReason, verdictOf, type CheckDef, type CheckResult, type Need } from '../ci-live/checks/framework.ts'
import {
  appliedLine,
  checkPreview,
  checkStartLines,
  commandMatches,
  countsText,
  CSCB_MCP_SERVER_NAME,
  guardedRestart,
  hasWord,
  isNotLiveRow,
  isPrompt,
  isTeardownKeptRowLine,
  keptRowSetProblems,
  NOT_LIVE_ROW_STATES,
  parsePending,
  PENDING_HEADER,
  personaRowId,
  previewHeader,
  promptState,
  q,
  removalRowProblems,
  removedPreviewLine,
  retriedBringUps,
  retryFailureClass,
  S,
  START_SUMMARY_END,
  startSummaryEnding,
  TAG_TIMEOUT_MS,
  type ToolCall,
  toolCalls,
  toolCallsScript,
  waitTags,
  type Row,
} from '../ci-live/checks/helpers.ts'
import {
  check27,
  check28,
  CHECK27_PROMPT,
  check29a,
  CHECK29A_STATE_FILES,
  parseCount,
  parseLeakcount,
  parsePersonaCounts,
  personaCountsProblem,
  rebootKeptRows,
  rowKeptByRemoval,
} from '../ci-live/checks/lifecycle-checks.ts'
import {
  CHANNEL_DELIVERY_SET_CLASS,
  channelDeliverySetCause as runnerChannelDeliverySetCause,
  check30,
  check31,
  check32,
  check33,
  check34,
  CHECK33_RECORDED_CALLS,
  CONFIG_COPY,
  EDIT_MESSAGE_TOOL,
  FETCH_MESSAGES_TOOL,
  INVITED_CHANNEL_CLASS,
  INVITED_CHECKS,
  invitedChannelCause as runnerInvitedChannelCause,
  invitedInPlaceLine,
  invitedRecordedLine,
  modeSwitchPreviewLine,
  NO_EFFECTIVE_CHANGE_PREVIEW,
  noopLine,
  NOTHING_PENDING_CLASS,
  personaLine,
  REACT_TOOL,
  type RecordedOutcome,
  REPLY_TOOL,
  residualNote,
  restorePreview,
  runChannelName,
  SET_CHANNEL_DELIVERY_TOOL as RUNNER_SET_CHANNEL_DELIVERY_TOOL,
  SLACK_CODE_PATTERN,
  slackRefusalCode,
  slackRefusalText,
  switchOnlyPreview,
  switchOnPreview,
  UNCLAIMED_CHANNEL_CLASS,
  unclaimedChannelCause as runnerUnclaimedChannelCause,
} from '../ci-live/checks/invited-checks.ts'
import { FINAL_CHECKS, hostCheck, PLAN_CHECKS, teardownCheck } from '../ci-live/checks/list.ts'
import { AD_CLIENT_CHECK_FAILED, installCheck, s2Check, s3Check } from '../ci-live/checks/setup-checks.ts'
import { AD_CLIENT_CHECK, AD_CLIENT_CHECK_PASSED } from '../ci-live/lib/ad-client-check.ts'
import { FlowError, type BrowserDriver, type HumanApi } from '../ci-live/lib/browser-types.ts'
import type { ContainerExec } from '../ci-live/lib/container.ts'
import {
  compareSnapshots,
  describeSnapshot,
  hostStorePath,
  parseAdRows,
  parseListenInodes,
  parseTmuxSessions,
  probeFailures,
  snapshotHost,
  type HostSnapshot,
} from '../ci-live/lib/host-state.ts'
import { HumanCallError, HumanSession, type SlackMessage } from '../ci-live/lib/human-session.ts'
import {
  buildLiveConfig,
  DM_DESTINATION as RUNNER_DM_DESTINATION,
  INVITED_KEY,
  INVITED_PERMISSION_PROMPTS_KEY,
  personaEntryFor,
  renderConfig,
  SWITCH_KEY,
  SWITCH_VALUE_JQ,
  switchFilter,
  switchOnFilter,
} from '../ci-live/lib/live-config.ts'
import type { ProcResult } from '../ci-live/lib/proc.ts'
import { RESULTS_COLUMNS, renderResultsMarkdown, type RunSummary } from '../ci-live/lib/results.ts'
import { personaName, type PersonaLetter } from '../ci-live/lib/personas.ts'
import { MINUTE, SECOND } from '../ci-live/lib/wait.ts'
import { emptyAppsState } from '../ci-live/lib/apps-state.ts'
import { cannedErr, errTmuxKillFailed, type StubClientOptions } from './test-helpers/agent-director-stub.ts'
import { virtualClock } from './test-helpers/ci-live.ts'
import { APP_TOKEN_PREFIX, assertNoLeak, BOT_TOKEN_PREFIX, fakeToken, LEAK_SENTINEL } from './test-helpers/credentials.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import { type HeadingMatch, requiredSection } from './test-helpers/markdown.ts'
import { stripComments } from './test-helpers/source-audit.ts'
import { makeReloadHarness } from './test-helpers/reload-harness.ts'
import { BELOW_CLIENT_MIN_VERSION, CLIENT_MIN_VERSION, OLD_AD_VERSION } from './test-helpers/agent-director-versions.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A container's answer: its stdout, a partial result, or either computed per call from the script. */
type Reply = Partial<ProcResult> | string | ((script: string) => string | Partial<ProcResult>)

/** A container whose `sh` answers by the first key its script contains; every script is recorded. */
function fakeContainer(answers: ReadonlyArray<readonly [string, Reply]>) {
  const scripts: string[] = []
  const done = (reply: Reply, script = ''): ProcResult => {
    const r = typeof reply === 'function' ? reply(script) : reply
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...(typeof r === 'string' ? { stdout: r } : r) }
  }
  const container: ContainerExec = {
    name: 'cscb-live-1700000000',
    exec: async () => done(''),
    sh: async (script) => {
      scripts.push(script)
      return done(answers.find(([key]) => script.includes(key))?.[1] ?? '', script)
    },
    writeFile: async () => {},
  }
  return { container, scripts }
}

const SNAPSHOT: HostSnapshot = { adRows: ['cscb_prod_a'], tmuxSessions: ['slack_bot_prod_a'], port3100: '4242', configSha256: 'a'.repeat(64) }

/** A prompt guard that records what a check declares and how often it asks for its leftovers to be denied; it denies `leftovers` of them. */
function recordingGuard(leftovers = 0): CheckPromptGuard & { expected: PromptExpectation[]; sweeps: number } {
  const guard = {
    expected: [] as PromptExpectation[],
    sweeps: 0,
    expect: (e: PromptExpectation) => {
      guard.expected.push(e)
    },
    denyLeftovers: async () => {
      guard.sweeps++
      return leftovers
    },
  }
  return guard
}

function makeCtx(overrides: Partial<CheckContext> = {}): CheckContext {
  const info: string[] = []
  return {
    mode: 'dry-run',
    runId: '1700000000',
    container: fakeContainer([]).container,
    hostName: 'cscb-live-1700000000',
    clock: virtualClock(),
    log: { info: (m) => info.push(m), detail: (m) => info.push(m) },
    runNotes: [],
    ids: DRY_RUN_IDS,
    human: null,
    second: null,
    browser: null,
    creds: {
      moveDIntoMount: () => {},
      rewriteBAppToken: async () => {},
      mountedCount: () => 3,
      bAppTokenName: () => 'cscb-live',
      setBAppTokenName: () => {},
    },
    shared: {},
    promptGuard: recordingGuard(),
    restartContainer: async () => {},
    hostScan: () => ({ counts: [], total: 0 }),
    hostBefore: SNAPSHOT,
    hostNow: async () => ({ ...SNAPSHOT }),
    removeContainer: async () => true,
    ...overrides,
  }
}

interface CannedMessage {
  ts: string
  text: string
  user: string
}

/** A channel of the scripted workspace: its members, and whether it is archived (archiving keeps the members). */
interface ScriptedChannel {
  id: string
  name: string
  archived: boolean
  members: Set<string>
}

/**
 * The test human's session over a scripted workspace: each post gets the
 * next `1700000100.00000N` ts; history lists the channel's posts and its
 * canned messages from `oldest` on (as Slack does); threads are empty.
 * Channels (`channels`, seeded with `seed`): creating one gives the next
 * `C0RUNCH00N` ID with the human as its member; an invite adds a member and
 * a kick removes one (`not_in_channel` when the user is not there; an
 * archived channel refuses the kick, `is_archived`); archiving marks the
 * channel archived and keeps its members (`already_archived` the second
 * time); `users.conversations` lists the channels a user is in, archived
 * ones included unless `exclude_archived` is true (Slack's default is
 * false). Every other Slack-side action
 * succeeds, and no persona answers. `calls` is every method called, with the
 * channel when there is one, in order.
 */
function scriptedHuman(clock: CheckContext['clock'], canned: Record<string, CannedMessage[]> = {}, seed: ScriptedChannel[] = []) {
  let n = 0
  let created = 0
  const posts: { channel: string; text: string; ts: string }[] = []
  const channels = new Map(seed.map((c) => [c.id, c]))
  const calls: string[] = []
  const api: HumanApi = {
    call: async (method, params = {}) => {
      const channel = String(params.channel ?? '')
      calls.push(channel === '' ? method : `${method} ${channel}`)
      if (method === 'chat.postMessage') {
        const ts = `1700000100.${String(++n).padStart(6, '0')}`
        posts.push({ channel, text: String(params.text), ts })
        return { ok: true, ts }
      }
      if (method === 'conversations.history') {
        const all = [...posts.filter((p) => p.channel === channel).map((p) => ({ ...p, user: DRY_RUN_IDS.humanUserId })), ...(canned[channel] ?? [])]
        return { ok: true, messages: all.filter((m) => m.ts >= String(params.oldest ?? '0')) }
      }
      if (method === 'conversations.open') return { ok: true, channel: { id: 'D0DRYDM001' } }
      if (method === 'conversations.create') {
        const id = `C0RUNCH${String(++created).padStart(3, '0')}`
        channels.set(id, { id, name: String(params.name), archived: false, members: new Set([DRY_RUN_IDS.humanUserId]) })
        return { ok: true, channel: { id, name: String(params.name) } }
      }
      const known = channels.get(channel)
      if (method === 'conversations.invite' && known) known.members.add(String(params.users))
      if (method === 'conversations.kick' && known) {
        if (known.archived) return { ok: false, error: 'is_archived' }
        if (!known.members.delete(String(params.user))) return { ok: false, error: 'not_in_channel' }
      }
      if (method === 'conversations.archive' && known) {
        if (known.archived) return { ok: false, error: 'already_archived' }
        known.archived = true
      }
      if (method === 'users.conversations') {
        const user = String(params.user)
        const listed = [...channels.values()].filter((c) => c.members.has(user) && !(params.exclude_archived === true && c.archived))
        return { ok: true, channels: listed.map((c) => ({ id: c.id, name: c.name, is_archived: c.archived })) }
      }
      return { ok: true, messages: [] }
    },
  }
  return { human: new HumanSession(api, clock), posts, api, channels, calls }
}

/** `api`, recording each call in `calls` as `<who> <method>`, in order. */
function recordingApi(api: HumanApi, who: string, calls: string[]): HumanApi {
  return {
    call: (method, params) => {
      calls.push(`${who} ${method}`)
      return api.call(method, params)
    },
  }
}

/** A browser that does nothing (its generated token is a sentinel-bearing fake). */
function idleBrowser(): BrowserDriver {
  return {
    ensureSignedIn: async () => 'signed-in',
    submitSignInCode: async () => 'signed-in',
    humanApi: async () => ({ call: async () => ({ ok: true }) }),
    installApp: async () => fakeToken(BOT_TOKEN_PREFIX, 'idle'),
    generateAppToken: async () => fakeToken(APP_TOKEN_PREFIX, 'idle'),
    revokeAppToken: async () => {},
    clickMessageButton: async () => {},
    saveState: async () => {},
    close: async () => {},
  }
}

function check(id: string, extra: Partial<CheckDef<null>> & { outcome?: CheckResult | Error } = {}): CheckDef<null> {
  const { outcome = { status: 'PASS', evidence: [] }, ...rest } = extra
  return {
    id,
    title: `check ${id}`,
    needs: [],
    row: id,
    run: async () => {
      if (outcome instanceof Error) throw outcome
      return outcome
    },
    ...rest,
  }
}

const FAILED: CheckResult = { status: 'FAIL', reason: 'broke', evidence: [] }

/**
 * `since '<mark>'`, alone or piped to one `grep -F -- '<text>'` or
 * `grep -E -- '<re>'` (as the check helpers write them), over `log`; null for
 * any other script.
 */
function sinceOver(script: string, log: readonly string[]): string | null {
  const m = /^since '[^']*'(?: \| grep -([FE]) -- '((?:[^']|'\\'')*)')?$/.exec(script)
  if (!m) return null
  const pattern = (m[2] ?? '').replace(/'\\''/g, "'")
  const kept = m[1] === undefined ? log : log.filter((l) => (m[1] === 'F' ? l.includes(pattern) : new RegExp(pattern).test(l)))
  return kept.join('\n')
}

/** A start's summary line for three personas, two resumed and one parked, with `ending` after the no-op count. */
function startSummary(ending: string): string {
  return (
    '[slack] startupSessionManager: complete — 3 persona(s): 2 resumed, 0 fresh-spawned, 0 fresh-after-amnesia, ' +
    `0 fresh-after-inconclusive-amnesia, 0 reconnected, 0 no-op, ${ending}`
  )
}

/**
 * A start from the record, each line with the seconds after the start at which
 * it is logged. A and B connect before the summary. C's launch waits on a
 * `working` row (b.f2b), so the summary leaves it out and C connects `cAt` s
 * after the start (never, when null).
 */
function startLog(cAt: number | null, ending = START_SUMMARY_END): [number, string][] {
  const connected = (l: PersonaLetter) => `[slack] Session connected: persona "persona_${l}" (key=persona_${l}) cwd="/home/cscb/cscb-live/${l}"`
  return [
    [20, `[slack] Starting from the last-applied record "${S}/config.json.last-applied"`],
    [20, '[slack] Loaded persona config: 3 persona(s)'],
    ...(['a', 'b', 'c'] as const).map((l, i): [number, string] => [25, `[slack] persona-start: personas[${i}] "persona_${l}" (key=persona_${l}): bring-up starting`]),
    [80, connected('a')],
    [90, connected('b')],
    [100, startSummary(ending)],
    [100, '[slack] startupSessionManager: 1 persona(s) still waiting in the background for a working row to settle — not counted above; each logs its outcome when it settles (b.f2b)'],
    ...(cAt === null ? [] : [[cAt, connected('c')] as [number, string]]),
  ]
}

/**
 * server.log holding `log`'s lines, each shown once the virtual clock is its
 * seconds past `begin()` (the start, or the reboot); nothing before.
 * `since(script)` answers a `since` script as `sinceOver` does.
 */
function timedLog(clock: CheckContext['clock'], log: readonly (readonly [number, string])[]) {
  let at: number | null = null
  const shown = () => (at === null ? [] : log.filter(([s]) => clock.now() >= at! + s * SECOND).map(([, l]) => l))
  return {
    begin: () => {
      at = clock.now()
    },
    since: (script: string) => sinceOver(script, shown()),
  }
}

// ---------------------------------------------------------------------------
// The framework
// ---------------------------------------------------------------------------

describe('skipReason', () => {
  const all = new Set<Need>(['workspace', 'claude', 'second-user'])
  test.each([
    ['a fixed skip, even for an always check', check('x', { skip: 'manual only', always: true }), 'a', [], all, 'manual only'],
    ['a block', check('x'), 'a', [], all, 'blocked by a'],
    ['an always check under a block', check('x', { always: true }), 'a', [], all, null],
    ['a prerequisite under a block', check('x', { prerequisite: true }), 'a', [], all, 'blocked by a'],
    ['a block before --only', check('x'), 'a', ['y'], all, 'blocked by a'],
    ['a check --only leaves out', check('x'), null, ['y'], all, 'not selected'],
    ['a prerequisite --only leaves out', check('x', { prerequisite: true }), null, ['y'], all, null],
    ['an always check --only leaves out', check('x', { always: true }), null, ['y'], all, null],
    ['an undo check when --only selects a check it undoes', check('x', { undoes: ['y', 'z'] }), null, ['z'], all, null],
    ['an undo check when --only selects none it undoes', check('x', { undoes: ['y'] }), null, ['z'], all, 'not selected'],
    ['an undo check under a block, with a check it undoes selected', check('x', { undoes: ['y'] }), 'a', ['y'], all, 'blocked by a'],
    ['--only before a missing need', check('x', { needs: ['workspace'] }), null, ['y'], new Set<Need>(), 'not selected'],
    ['a missing workspace', check('x', { needs: ['workspace', 'claude'] }), null, [], new Set<Need>(), NEED_SKIP_REASONS.workspace],
    ['a missing second user', check('x', { needs: ['workspace', 'second-user'] }), null, [], new Set<Need>(['workspace']), 'no second account'],
    ['everything available', check('x', { needs: ['workspace'] }), null, ['x'], all, null],
  ] as const)('%s', (_what, def, blockedBy, only, available, expected) => {
    expect(skipReason(def, { blockedBy }, { available, only })).toBe(expected)
  })

  test("the runner's reason for a missing need replaces the default one (a second account that needs a sign-in code), in runChecks too", async () => {
    const needReasons = {
      'second-user': 'second account needs a sign-in code the test mailbox (mailbox.json) did not give: check its mail is forwarded there, or run login --second',
    }
    const needsSecond = check('14', { needs: ['workspace', 'second-user'] })
    const workspaceOnly = new Set<Need>(['workspace'])
    expect(skipReason(needsSecond, { blockedBy: null }, { available: workspaceOnly, only: [], needReasons })).toBe(needReasons['second-user'])
    expect(skipReason(check('2', { needs: ['workspace'] }), { blockedBy: null }, { available: new Set(), only: [], needReasons })).toBe(NEED_SKIP_REASONS.workspace)
    const [r] = await runChecks([needsSecond], null, { available: workspaceOnly, only: [], now: () => 0, log: { info: () => {} }, needReasons })
    expect([r!.status, r!.reason]).toEqual(['SKIPPED', needReasons['second-user']])
  })
})

describe('runChecks', () => {
  test('a failed blocking check skips the rest, except always checks; fixed skips stay as they are', async () => {
    const log: string[] = []
    const seen: string[] = []
    let t = 0
    const results = await runChecks(
      [check('a', { blocking: true, outcome: FAILED }), check('b'), check('c', { always: true }), check('d', { skip: 'manual only' }), check('e', { needs: ['workspace'] })],
      null,
      { available: new Set(), only: [], now: () => (t += 5), log: { info: (m) => log.push(m) }, onResult: (r) => seen.push(r.id) },
    )
    expect(results.map((r) => [r.id, r.status, r.reason ?? null])).toEqual([
      ['a', 'FAIL', 'broke'],
      ['b', 'SKIPPED', 'blocked by a'],
      ['c', 'PASS', null],
      ['d', 'SKIPPED', 'manual only'],
      ['e', 'SKIPPED', 'blocked by a'],
    ])
    expect(seen).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(results.map((r) => r.durationMs)).toEqual([5, 5, 5, 5, 5])
    expect(log).toEqual([
      'check a: check a',
      'check a: FAIL (broke)',
      'check b: SKIPPED (blocked by a)',
      'check c: check c',
      'check c: PASS',
      'check d: SKIPPED (manual only)',
      'check e: SKIPPED (blocked by a)',
    ])
  })

  test('a check that throws is a FAIL with a described error; a failure that is not blocking blocks nothing', async () => {
    const results = await runChecks(
      [check('a', { outcome: new TypeError(`bad https://x.invalid/cb?code=${LEAK_SENTINEL}\nstack`) }), check('b', { outcome: FAILED }), check('c')],
      null,
      { available: new Set(), only: [], now: () => 0, log: { info: () => {} } },
    )
    expect(results.map((r) => [r.id, r.status, r.reason ?? null])).toEqual([
      ['a', 'FAIL', 'threw TypeError: bad https://x.invalid/cb?<query>'],
      ['b', 'FAIL', 'broke'],
      ['c', 'PASS', null],
    ])
    assertNoLeak(results)
  })

  test('the hooks run around each check that runs, never a skipped one; afterCheck gets the result (a throw\'s FAIL too) before it is recorded; a hook that throws is logged and changes no result', async () => {
    const events: string[] = []
    const log: string[] = []
    const ran = (id: string, extra: Partial<CheckDef<null>> & { outcome?: CheckResult | Error } = {}): CheckDef<null> => {
      const def = check(id, extra)
      return {
        ...def,
        run: async (ctx) => {
          events.push(`run ${id}`)
          return def.run(ctx)
        },
      }
    }
    const results = await runChecks(
      [ran('a'), ran('b', { skip: 'manual only' }), ran('c', { outcome: new Error('boom') }), ran('d'), ran('e', { outcome: FAILED })],
      null,
      {
        available: new Set(),
        only: [],
        now: () => 0,
        log: { info: (m) => log.push(m) },
        onResult: (r) => events.push(`recorded ${r.id}`),
        beforeCheck: (c) => {
          events.push(`before ${c.id} (${c.title})`)
          if (c.id === 'd') throw new Error('before broke')
        },
        afterCheck: async (c, r) => {
          events.push(`after ${c.id} ${r.status}`)
          if (c.id === 'e') throw new Error('after broke')
        },
      },
    )
    expect(events).toEqual([
      'before a (check a)',
      'run a',
      'after a PASS',
      'recorded a',
      'recorded b',
      'before c (check c)',
      'run c',
      'after c FAIL',
      'recorded c',
      'before d (check d)',
      'run d',
      'after d PASS',
      'recorded d',
      'before e (check e)',
      'run e',
      'after e FAIL',
      'recorded e',
    ])
    expect(results.map((r) => [r.id, r.status, r.reason ?? null])).toEqual([
      ['a', 'PASS', null],
      ['b', 'SKIPPED', 'manual only'],
      ['c', 'FAIL', 'threw Error: boom'],
      ['d', 'PASS', null],
      ['e', 'FAIL', 'broke'],
    ])
    expect(log.filter((l) => l.includes('hook failed'))).toEqual(['check d: the beforeCheck hook failed: Error: before broke', 'check e: the afterCheck hook failed: Error: after broke'])
  })
})

describe('verdictOf and Findings', () => {
  test.each([
    [[], 'PASS'],
    [[{ id: '1', status: 'PASS' }, { id: '2', status: 'SKIPPED', reason: 'x' }], 'PASS'],
    [[{ id: '1', status: 'PASS' }, { id: '5', status: 'FAIL', reason: 'no reply\n in time' }, { id: '6', status: 'FAIL', reason: 'y' }], 'FAIL: 5: no reply in time'],
    [[{ id: '7', status: 'FAIL' }], 'FAIL: 7: failed'],
  ] as const)('verdictOf(%j) is %p', (results, verdict) => {
    expect(verdictOf(results)).toBe(verdict)
  })

  test('Findings: every failed expectation joins the reason; evidence and notes are kept either way', () => {
    const ok = new Findings()
    expect(ok.expect(true, 'never')).toBe(true)
    ok.add('ts 1.2')
    ok.note('n')
    expect(ok.result()).toEqual({ status: 'PASS', evidence: ['ts 1.2'], notes: ['n'] })
    const bad = new Findings()
    expect(bad.expect(false, 'first')).toBe(false)
    bad.expect(false, 'second')
    bad.add('ts 3.4')
    expect(bad.result()).toEqual({ status: 'FAIL', reason: 'first; second', evidence: ['ts 3.4'], notes: [] })
  })
})

// ---------------------------------------------------------------------------
// The check list
// ---------------------------------------------------------------------------

describe('the check list', () => {
  const every = [...PLAN_CHECKS, ...FINAL_CHECKS]
  const runs = (available: Need[], only: string[] = []) =>
    every.filter((c) => skipReason(c, { blockedBy: null }, { available: new Set(available), only }) === null).map((c) => c.id)

  test('ids are unique and every Results-table column is filled by exactly one check', () => {
    expect(new Set(every.map((c) => c.id)).size).toBe(every.length)
    const rows = PLAN_CHECKS.map((c) => c.row).filter((r) => r !== null)
    expect([...rows].sort()).toEqual([...RESULTS_COLUMNS].sort())
  })

  test('a dry run (no workspace, no Claude) runs only the container-side checks, Teardown and HOST', () => {
    expect(runs([])).toEqual(['preflight', 'install', 'setup', 'S2', 'S3', '29a', 'teardown', 'HOST'])
  })

  test('without a second account, 14, 16 and 20 are skipped, and S1, 26 and 29b always are', () => {
    const skipped = every.filter((c) => !runs(['workspace', 'claude']).includes(c.id)).map((c) => c.id)
    expect(skipped).toEqual(['S1', '14', '16', '20', '26', '29b'])
  })

  test('--only runs the selection plus the prerequisites and the always checks', () => {
    expect(runs(['workspace', 'claude'], ['S2'])).toEqual(['preflight', 'install', 'setup', 'S2', '1', '29a', 'teardown', 'HOST'])
  })

  test('the setup checks and Check 1 are blocking', () => {
    expect(PLAN_CHECKS.filter((c) => c.blocking).map((c) => c.id)).toEqual(['preflight', 'install', 'setup', '1'])
  })

  test("Part 11's invited-channel checks run 30 to 34 in order, after every Check 28 entry and before the closing 29a and 29b (b.deo SRI-1501)", () => {
    const ids = PLAN_CHECKS.map((c) => c.id)
    const at = (id: string) => ids.indexOf(id)
    expect(INVITED_CHECKS.map((c) => c.id)).toEqual(['30', '31', '32', '33', '34'])
    expect(ids.slice(at('30'), at('34') + 1)).toEqual(['30', '31', '32', '33', '34'])
    const lastOf28 = Math.max(...ids.map((id, i) => (id.startsWith('28') ? i : -1)))
    expect(lastOf28).toBeGreaterThan(-1)
    expect(at('30')).toBeGreaterThan(lastOf28)
    expect(ids.slice(at('34') + 1)).toEqual(['29a', '29b'])
    expect(INVITED_CHECKS.map((c) => [c.row, c.needs, c.blocking ?? false, c.prerequisite ?? false, c.always ?? false, c.skip ?? null, c.undoes ?? []])).toEqual(
      ['30', '31', '32', '33', '34'].map((row) => [row, ['workspace', 'claude'], false, false, false, null, row === '34' ? ['30', '31', '32', '33'] : []]),
    )
  })

  test('--only 30,31,32,33,34 runs the pre-flight, install, setup, Check 1, Checks 30 to 34, 29a, Teardown and HOST', () => {
    expect(runs(['workspace', 'claude'], ['30', '31', '32', '33', '34'])).toEqual(['preflight', 'install', 'setup', '1', '30', '31', '32', '33', '34', '29a', 'teardown', 'HOST'])
  })

  test.each([['30,31'], ['30'], ['31'], ['32'], ['33'], ['34']])('--only %s runs Check 34 too, which undoes what Checks 30 to 33 leave (b.deo SRI-1506)', (only) => {
    const selected = only.split(',')
    expect(runs(['workspace', 'claude'], selected)).toEqual(['preflight', 'install', 'setup', '1', ...selected.filter((id) => id !== '34'), '34', '29a', 'teardown', 'HOST'])
  })
})

describe('HOST and Teardown', () => {
  test('HOST passes when the host is unchanged, with both snapshots as evidence', async () => {
    const r = await hostCheck.run(makeCtx())
    expect(r.status).toBe('PASS')
    expect(r.evidence).toEqual([`before: ${describeSnapshot(SNAPSHOT)}`, `after: ${describeSnapshot(SNAPSHOT)}`])
  })

  test('HOST fails naming every change', async () => {
    const after: HostSnapshot = { adRows: ['cscb_persona_a', 'cscb_prod_a'], tmuxSessions: ['slack_bot_prod_a'], port3100: 'none', configSha256: 'b'.repeat(64) }
    const r = await hostCheck.run(makeCtx({ hostNow: async () => after }))
    expect(r.status).toBe('FAIL')
    expect(r.reason).toBe(
      'agent-director service=cscb rows [cscb_prod_a] → [cscb_persona_a, cscb_prod_a]; port 3100 listener 4242 → none; host config.json sha256 changed',
    )
  })

  test('HOST fails when a probe failed, even the same way before and after (never a vacuous pass)', async () => {
    const failed: HostSnapshot = { ...SNAPSHOT, adRows: 'agent-director list exit 2', tmuxSessions: 'tmux ls exit 1' }
    const r = await hostCheck.run(makeCtx({ hostBefore: failed, hostNow: async () => ({ ...failed }) }))
    expect([r.status, r.reason]).toEqual([
      'FAIL',
      'probe failed before the run: agent-director list exit 2; probe failed before the run: tmux ls exit 1; ' +
        'probe failed after the run: agent-director list exit 2; probe failed after the run: tmux ls exit 1',
    ])
    const afterOnly = await hostCheck.run(makeCtx({ hostNow: async () => ({ ...SNAPSHOT, adRows: 'agent-director list: unparsable output' }) }))
    expect(afterOnly.reason).toStartWith('probe failed after the run: agent-director list: unparsable output; agent-director service=cscb rows')
    expect([probeFailures(SNAPSHOT), probeFailures(failed)]).toEqual([[], ['agent-director list exit 2', 'tmux ls exit 1']])
  })

  test('Teardown fails when the container could not be removed', async () => {
    expect((await teardownCheck.run(makeCtx())).status).toBe('PASS')
    expect(await teardownCheck.run(makeCtx({ removeContainer: async () => false }))).toMatchObject({ status: 'FAIL', reason: 'the test container could not be removed' })
  })
})

// ---------------------------------------------------------------------------
// Host state
// ---------------------------------------------------------------------------

describe('host-state', () => {
  test('parseListenInodes finds the sockets listening on the port, IPv4 and IPv6', () => {
    const tcp = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:0C1C 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11111 1 0 100 0 0 10 0',
      '   1: 0100007F:0C1C 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 22222 1 0 20 4 30 10 -1',
      '   2: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 33333 1 0 100 0 0 10 0',
      '   3: 00000000000000000000000000000000:0C1C 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 44444 1 0',
    ].join('\n')
    expect(parseListenInodes(tcp, 3100)).toEqual(['11111', '44444'])
    expect(parseListenInodes(tcp, 443)).toEqual([])
  })

  test.each([
    ['{"spawns":[{"claude_instance_id":"cscb_b"},{"claude_instance_id":"cscb_a"},{}]}', ['?', 'cscb_a', 'cscb_b']],
    ['{"spawns":[]}', []],
    ['{}', null],
    ['not json', null],
  ])('parseAdRows(%p)', (stdout, expected) => {
    expect(parseAdRows(stdout)).toEqual(expected)
  })

  test("parseTmuxSessions keeps only the host's CSCB sessions", () => {
    expect(parseTmuxSessions('slack_bot_b\nmain\ncscb_x\n  \nmy_slack_bot_y\nslack_bot_a\n')).toEqual(['cscb_x', 'slack_bot_a', 'slack_bot_b'])
  })

  function probe(ad: Partial<ProcResult>, tmux: Partial<ProcResult>, config: Buffer | null) {
    const argv: string[][] = []
    const read: string[] = []
    const ports: number[] = []
    const res = (r: Partial<ProcResult>): ProcResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...r })
    return {
      argv,
      read,
      ports,
      deps: {
        run: async (a: readonly string[]) => (argv.push([...a]), res(a[0] === 'tmux' ? tmux : ad)),
        readFile: (p: string) => (read.push(p), config),
        listener: (port: number) => (ports.push(port), '4242'),
      },
    }
  }

  test("snapshotHost only reads: agent-director list on CSCB's own store, tmux ls, the port-3100 listener and a hash of the config file", async () => {
    const config = Buffer.from('{"personas":[]}')
    const p = probe({ stdout: '{"spawns":[{"claude_instance_id":"cscb_prod_a"}]}' }, { stdout: 'slack_bot_prod_a\nwork\n' }, config)
    const snap = await snapshotHost(p.deps, '/home/tester')
    expect(hostStorePath('/home/tester')).toBe('/home/tester/.agent-director/state.db')
    // b.jg5 SRJ-1301: the HOST check's probes are exactly these two whole argvs, in order; a changed or extra probe fails.
    expect(p.argv).toEqual([
      ['agent-director', '--store-path', hostStorePath('/home/tester'), 'list', '--label', 'service=cscb'],
      ['tmux', 'ls', '-F', '#{session_name}'],
    ])
    expect([p.read, p.ports]).toEqual([['/home/tester/.claude/channels/slack/config.json'], [3100]])
    expect(snap).toEqual({
      adRows: ['cscb_prod_a'],
      tmuxSessions: ['slack_bot_prod_a'],
      port3100: '4242',
      configSha256: createHash('sha256').update(config).digest('hex'),
    })
  })

  test.each([
    ['no tmux server is no session', { code: 1, stderr: 'no server running on /tmp/tmux-1000/default' }, []],
    ['no tmux socket is no session', { code: 1, stderr: 'error connecting to /run/user/1000/tmux-1000/default (No such file or directory)' }, []],
    ['another tmux failure is recorded as such', { code: 1, stderr: 'error connecting to /tmp/tmux-1000/default (Permission denied)' }, 'tmux ls exit 1'],
  ])('snapshotHost: %s', async (_what, tmux, expected) => {
    const snap = await snapshotHost(probe({ code: 2 }, tmux, null).deps, '/h')
    expect([snap.tmuxSessions, snap.adRows, snap.configSha256]).toEqual([expected, 'agent-director list exit 2', 'absent'])
  })

  test('compareSnapshots names each difference, and hashes only by "changed"', () => {
    expect(compareSnapshots(SNAPSHOT, { ...SNAPSHOT })).toEqual([])
    expect(compareSnapshots(SNAPSHOT, { ...SNAPSHOT, tmuxSessions: 'tmux ls exit 1', configSha256: 'c'.repeat(64) })).toEqual([
      'tmux sessions [slack_bot_prod_a] → tmux ls exit 1',
      'host config.json sha256 changed',
    ])
  })
})

// ---------------------------------------------------------------------------
// Part 1.4's install, Checks S2, S3 and 29a against a fake container
// ---------------------------------------------------------------------------

describe('Part 1.4 install', () => {
  // The client the package resolves, and the helper's own success line for it (docker/ad-client-check.sh).
  const CLIENT = '/home/testuser/.bun/install/global/node_modules/agent-director'
  // Versions come from src/ and the shared helper; the hash and commit are placeholders (installCheck only passes these lines through).
  const RELEASE = PHASE1_FLOOR_VERSION
  const TGZ = `/opt/agent-director/client/agent-director-${RELEASE}.tgz`
  const TGZ_SHA256 = 'a'.repeat(64)
  const COMMIT = 'c'.repeat(40)
  const SUMMARY = `${AD_CLIENT_CHECK_PASSED}${CLIENT} is agent-director ${RELEASE} from npm (tarball sha256 ${TGZ_SHA256}); agent-director ${RELEASE} (${COMMIT}) at /opt/agent-director/bin/agent-director; client floor ${CLIENT_MIN_VERSION}`
  const PASSING: ReadonlyArray<readonly [string, Reply]> = [
    ['env | cut', '0'],
    ["echo 'test host'", 'test host'],
    ['bun install -g', ''],
    ['echo "PKG=$PKG"', 'PKG=/home/testuser/pkg\n/home/testuser/pkg\n1.2.3'],
    [AD_CLIENT_CHECK, SUMMARY],
    ['ls -A "$S"', 'config.json'],
    ['jq -c . "$S/config.json"', '{"personas":[]}'],
    ['pkg-before.sha256', '42'],
  ]
  /** installCheck over the passing container, with `changes` answered first; the result and every script it ran. */
  const run = async (changes: ReadonlyArray<readonly [string, Reply]> = []) => {
    const { container, scripts } = fakeContainer([...changes, ...PASSING])
    return { r: await installCheck.run(makeCtx({ container })), scripts }
  }
  const at = (scripts: readonly string[], key: string) => scripts.findIndex((s) => s.includes(key))

  test("passes when the client-under-test check passes, its summary line recorded as a finding; the check is run once, behind the guard, on the package", async () => {
    const { r, scripts } = await run()
    expect([r.status, r.reason]).toEqual(['PASS', undefined])
    expect(r.evidence).toContain(SUMMARY)
    expect(scripts.filter((s) => s.includes(AD_CLIENT_CHECK))).toEqual([`guard || exit 90\n${AD_CLIENT_CHECK} --package "$PKG"`])
  })

  test('the client-under-test check runs after the install and its trust step, and before the state check, the checksums and the skill link', async () => {
    const { scripts } = await run()
    const check = at(scripts, AD_CLIENT_CHECK)
    const order = [at(scripts, 'bun pm -g trust'), at(scripts, '$PKG/README.md'), check, at(scripts, 'ls -A "$S"'), at(scripts, 'pkg-before.sha256'), at(scripts, 'ln -s "$PKG/skills')]
    expect(order.every((i) => i >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  test("the client is checked as installed: every script is one of the install steps, and none but the check names the package's client or the image's agent-director files", async () => {
    const { scripts } = await run()
    const steps = ['env | cut', "echo 'test host'", 'bun install -g', 'echo "PKG=$PKG"', '$PKG/README.md', AD_CLIENT_CHECK, 'ls -A "$S"', 'jq -c . "$S/config.json"', 'pkg-before.sha256', 'ln -s "$PKG/skills']
    expect(scripts.map((s) => steps.filter((k) => s.includes(k)))).toEqual(steps.map((k) => [k]))
    const others = scripts.filter((s) => !s.includes(AD_CLIENT_CHECK))
    for (const touch of ['node_modules/agent-director', '/opt/agent-director', '--client']) {
      expect(others.filter((s) => s.includes(touch))).toEqual([])
    }
  })

  // The ERROR lines in docker/ad-client-check.sh's own shapes, for the client the package resolves.
  const TARBALL = `ERROR: ad-client check 1 (tarball): ${TGZ} has SHA-256 ${'0'.repeat(64)}, not the pinned ${TGZ_SHA256}`
  const VERSION = `ERROR: ad-client check 2 (version): the client at ${CLIENT} is agent-director ${OLD_AD_VERSION}, not the release's ${RELEASE}`
  const CONTENT = `ERROR: ad-client check 3 (content): the client at ${CLIENT} is not the npm client tarball's contents: 1 difference(s) from ${TGZ}, first: Files <tarball>/dist/index.js and ${CLIENT}/dist/index.js differ`
  const BINARY = `ERROR: ad-client check 5 (binary): the first agent-director binary on PATH, /opt/agent-director/bin/agent-director, reports version ${OLD_AD_VERSION} (${'0'.repeat(40)}), not the release's ${RELEASE} (${COMMIT}) that the client ${RELEASE} pairs with`
  const CREATE = `ERROR: ad-client check 7 (client-create): Client.create() from ${CLIENT}/dist/index.js failed: ErrSystemInstallTooOld: agent-director ${BELOW_CLIENT_MIN_VERSION} is below ${CLIENT_MIN_VERSION}`
  const REFUSAL = 'ERROR: ad-client-check.sh: /etc/cscb-ci-image is absent: this check runs only in a cscb-ci image (it runs agent-director); refusing to run'
  const USAGE = 'ERROR: ad-client-check.sh: /home/testuser/pkg holds no package.json (usage: ad-client-check.sh --package <dir> | --client <dir>)'
  const failures: ReadonlyArray<readonly [string, Partial<ProcResult>, string]> = [
    ['a client tarball off its pinned SHA-256', { code: 1, stderr: TARBALL }, TARBALL],
    ['a client that is not the release', { code: 1, stderr: VERSION }, VERSION],
    ['a content mismatch, after other stderr', { code: 1, stderr: `tar: Ignoring unknown extended header keyword\n${CONTENT}` }, CONTENT],
    ['the wrong binary on PATH', { code: 1, stderr: BINARY }, BINARY],
    ['Client.create() failing', { code: 1, stderr: CREATE }, CREATE],
    ["the check's refusal", { code: 3, stderr: REFUSAL }, REFUSAL],
    ["the check's usage error", { code: 2, stderr: USAGE }, USAGE],
    ['a non-zero exit with no ERROR line', { code: 139, stderr: 'Segmentation fault' }, 'exit 139'],
    ['exit 0 with no summary line', { code: 0, stdout: '' }, 'exit 0'],
    ['the guard refusing the shell', { code: 90 }, 'the guard refused the container shell'],
  ]

  test.each(failures)('a blocking FAIL on %s, with its own reason, advising no upgrade, and nothing after the check runs', async (_what, reply, detail) => {
    const { r, scripts } = await run([[AD_CLIENT_CHECK, reply]])
    expect([installCheck.blocking, r.status, r.reason]).toEqual([true, 'FAIL', `${AD_CLIENT_CHECK_FAILED}: ${detail}`])
    expect(r.reason).not.toMatch(/upgrad|reinstall|install-agent-director|@latest/i)
    expect(scripts.at(-1)).toContain(AD_CLIENT_CHECK)
  })

  test('a failed install stops before the client-under-test check', async () => {
    const { r, scripts } = await run([['bun install -g', { code: 1 }]])
    expect([r.status, r.reason]).toEqual(['FAIL', 'the install failed (exit 1; see ~/cscb-live/install.log in the container)'])
    expect(at(scripts, AD_CLIENT_CHECK)).toBe(-1)
  })
})

describe('Check S2', () => {
  const PASSING: Record<string, string> = {
    'sha256sum -c': 'package unchanged',
    '-type f -print | wc -l': '42\n42',
    'ls -A ~/.config/cscb/': 'persona_a-credentials.json\npersona_b-credentials.json\npersona_c-credentials.json',
    'ls -A "$S"': 'system-prompt.md\nconfig.json',
    tokcount: '0',
    'env | cut': '0',
  }
  const run = (changes: Record<string, string> = {}) => s2Check.run(makeCtx({ container: fakeContainer(Object.entries({ ...PASSING, ...changes })).container }))

  test('passes on the plan layout', async () => {
    expect((await run()).status).toBe('PASS')
  })

  test.each([
    ['an extra state file', { 'ls -A "$S"': 'config.json\nsystem-prompt.md\nserver.pid' }, 'the state dir holds more than config.json and system-prompt.md'],
    ['a changed package file', { 'sha256sum -c': '' }, 'a file of the installed package changed'],
    ['a file added to the package', { '-type f -print | wc -l': '43\n42' }, 'the package gained or lost files'],
    ["D's credentials file already mounted", { 'ls -A ~/.config/cscb/': 'persona_a-credentials.json\npersona_b-credentials.json\npersona_c-credentials.json\npersona_d-credentials.json' }, '~/.config/cscb/ holds'],
    ['a token-shaped line in config.json', { tokcount: '1' }, 'token-shaped lines in config.json: 1'],
    ['a token variable in the shell', { 'env | cut': '1' }, 'token variables set: 1'],
  ])('fails on %s', async (_what, changes, reason) => {
    const r = await run(changes)
    expect(r.status).toBe('FAIL')
    expect(r.reason).toContain(reason)
  })
})

describe('Check S3', () => {
  // The refusal as the package under test words it, for the S3 config (B given A's working directory).
  const loaderError = (() => {
    const config = buildLiveConfig(DRY_RUN_IDS)
    config.personas[1]!.working_directory = config.personas[0]!.working_directory
    try {
      parsePersonaConfigBytes(renderConfig(config), `${S}/config.json`, S, { home: '/home/testuser' })
    } catch (err) {
      return (err as Error).message
    }
    throw new Error('the S3 config loaded')
  })()
  const scr = '/home/testuser/cscb-live/scratch-state.Ab12Cd'
  const fields: Record<string, string> = {
    SCR: scr,
    WDS: '~/cscb-live/a ~/cscb-live/a ~/cscb-live/c ',
    exit: '1',
    SCRLS: 'server.log ',
    PGREP: '0',
    ROWS: '0',
    STATELS: 'config.json system-prompt.md ',
  }
  const output = (changes: Record<string, string> = {}, extra = '') =>
    [
      ...Object.entries({ ...fields, ...changes }).map(([k, v]) => `${k}=${v}`),
      `[slack] Server failed to start (exit code 1). From ${scr}/server.log:`,
      `[slack] Fatal: configuration error — ${loaderError}`,
      extra,
    ].join('\n')
  const run = (out: string) =>
    s3Check.run(makeCtx({ container: fakeContainer([['preflight.sh check1', 'pre-flight passed (check1)'], ['SLACK_STATE_DIR="$SCR"', out]]).container }))

  test("passes on the package's own refusal of the duplicate working directory", async () => {
    const r = await run(output())
    expect([r.status, r.reason]).toEqual(['PASS', undefined])
  })

  test.each([
    ['a start that exited 0', { exit: '0' }, '', 'start exited 0, not 1'],
    ['a server process left', { PGREP: '1' }, '', 'a server process remains'],
    ['an agent-director row left', { ROWS: '1' }, '', 'agent-director lists a service=cscb row'],
    ['a record in the scratch dir', { SCRLS: 'config.json.last-applied server.log' }, '', 'the scratch dir holds a record or a server.pid'],
    ['a changed state dir', { STATELS: 'config.json server.log system-prompt.md' }, '', 'the state dir changed'],
    ['a scratch server that started', {}, 'SCRATCH SERVER STARTED - stopping it', 'SCRATCH SERVER STARTED'],
  ])('fails on %s', async (_what, changes, extra, reason) => {
    const r = await run(output(changes, extra))
    expect(r.status).toBe('FAIL')
    expect(r.reason).toContain(reason)
  })

  test('fails when the refusal names another problem', async () => {
    const r = await run(output().replace(loaderError, 'loadPersonaConfig: invalid persona config: something else'))
    expect(r.status).toBe('FAIL')
  })
})

describe('Check 29a', () => {
  // The script's output; a field set to undefined is left out.
  const lines = (over: Record<string, string | undefined> = {}, leak: { f?: string[]; t?: string[]; h?: string[] } = {}) =>
    [
      ...Object.entries({ TRANSCRIPTS: '0', PENDING: 'absent', TOKF: '0', TOKT: '0', TOKH: '0', WSS: '0', MSG: '0', RURL: '2', RTOK: '1', ...over })
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${v}`),
      'LEAK-F',
      ...(leak.f ?? ['tokens checked: 6', `${S}/config.json: 0`, `${S}/server.log: 0`, `${S}/config.json.pending: absent`]),
      'LEAK-T',
      ...(leak.t ?? []),
      'LEAK-H',
      ...(leak.h ?? ['tokens checked: 6', '/home/testuser/.bash_history: absent']),
    ].join('\n')
  const run = (out: string, overrides: Partial<CheckContext> = {}) => check29a.run(makeCtx({ container: fakeContainer([['leakcount', out]]).container, ...overrides }))

  test('passes when every count is zero, the tokens checked match the mounted files, and the host scan is clean', async () => {
    const r = await run(lines())
    expect([r.status, r.reason]).toEqual(['PASS', undefined])
    expect(r.notes).toEqual(['Check 29a placeholders: <redacted-url> 2, <redacted-token> 1'])
    assertNoLeak(r)
  })

  test.each([
    ['a token-shaped line in a state file', lines({ TOKF: '1' }), 'the state files: count 1'],
    ['a pending file left', lines({ PENDING: 'present' }), 'config.json.pending exists'],
    ['a ticket URL in server.log', lines({ WSS: '2' }), 'wss:// or ticket= in server.log: count 2'],
    ['a token in a logged message', lines({ MSG: '1' }), 'message="…" fields: count 1'],
    ['a credential in a state file', lines({}, { f: ['tokens checked: 6', `${S}/server.log: 1`] }), 'LEAK-F: 1 file(s) hold a credential'],
    ['fewer tokens checked than the mounted files hold', lines({}, { h: ['tokens checked: 4'] }), 'LEAK-H: tokens checked 4, not 6'],
    ['no output at all', '', 'persona transcripts: NaN'],
  ])('fails on %s', async (_what, out, reason) => {
    const r = await run(out)
    expect(r.status).toBe('FAIL')
    expect(r.reason).toContain(reason)
  })

  test("an empty TRANSCRIPTS count fails as NaN, never 0, and the transcripts' leak scan still runs", async () => {
    const r = await run(lines({ TRANSCRIPTS: '' }, { t: ['tokens checked: 6', '/home/testuser/.claude/projects/-home-testuser-cscb-live-a/x.jsonl: 1'] }))
    expect([r.status, r.reason]).toEqual(['FAIL', 'persona transcripts: NaN (the scan printed no count); LEAK-T: 1 file(s) hold a credential'])
    expect(r.evidence).toContain('persona transcripts: NaN')
  })

  test.each([
    ['empty', '', NaN],
    ['blank', ' \n', NaN],
    ['zero', '0', 0],
    ['surrounding whitespace and a newline', ' 42\n', 42],
    ['a decimal', '1.5', NaN],
    ['a negative number', '-1', NaN],
    ['two numbers', '1 2', NaN],
    ['the missing-field marker', '?', NaN],
  ])('parseCount(%s) is a whole number or NaN, never 0 for a bad value', (_what, value, expected) => {
    expect(parseCount(value)).toEqual(expected)
  })

  describe('a transcript for each persona this run brought up and dispatched a message to', () => {
    const counts = { PERSONA_a: '1 3', PERSONA_b: '2 1', PERSONA_c: '1 1', PERSONA_d: '0 0' }
    const real = (over: Record<string, string | undefined>, broughtUp: CheckContext['shared']['broughtUp'], t = ['tokens checked: 6']) =>
      run(lines({ TRANSCRIPTS: '4', ...counts, ...over }, { t }), { mode: 'real', shared: { broughtUp } })

    test('passes with one per dispatched persona; a persona brought up but never dispatched to needs none, and is noted', async () => {
      const r = await real({}, ['a', 'b', 'c', 'd'])
      expect([r.status, r.reason]).toEqual(['PASS', undefined])
      expect(r.evidence).toContain('persona d: 0 transcript(s), 0 dispatched message(s)')
      expect(r.notes).toContain('Check 29a: persona d was brought up but no message was dispatched to it, so no transcript is required')
    })

    test.each([
      ['a dispatched persona with no transcript', { PERSONA_b: '0 2' }, ['a', 'b', 'c'], 'persona b was brought up and sent 2 message(s), but has no transcript'],
      ['D brought up by Check 25 with no transcript', { PERSONA_d: '0 1' }, ['a', 'b', 'c', 'd'], 'persona d was brought up and sent 1 message(s), but has no transcript'],
      ['no count printed for a persona brought up', { PERSONA_c: undefined }, ['c'], 'persona c: no transcript count'],
      ['an empty count', { PERSONA_a: '' }, ['a'], 'persona a: empty transcript count (PERSONA_a is empty, not "<transcripts> <dispatched>")'],
      ['a malformed count (one number)', { PERSONA_c: '3' }, ['c'], 'persona c: malformed transcript count (PERSONA_c is not "<transcripts> <dispatched>")'],
    ] as const)('fails on %s', async (_what, over, broughtUp, reason) => {
      const r = await real(over, [...broughtUp])
      expect([r.status, r.reason]).toEqual(['FAIL', reason])
    })

    test('an empty count is not read as "0 0" (no transcript required): no evidence line and no note for that persona', async () => {
      const r = await real({ PERSONA_b: '' }, ['a', 'b'])
      expect([r.status, r.reason]).toEqual(['FAIL', 'persona b: empty transcript count (PERSONA_b is empty, not "<transcripts> <dispatched>")'])
      expect(r.evidence.filter((l) => /^persona [a-d]:/.test(l))).toEqual(['persona a: 1 transcript(s), 3 dispatched message(s)'])
      expect((r.notes ?? []).filter((n) => n.includes('persona b'))).toEqual([])
    })

    test('under --only, a persona not brought up this run needs no transcript', async () => {
      const r = await real({ TRANSCRIPTS: '0', PERSONA_a: '0 0', PERSONA_b: '0 5', PERSONA_c: '0 5', PERSONA_d: '0 5' }, [], [])
      expect([r.status, r.reason]).toEqual(['PASS', undefined])
    })

    test("the transcripts' own leak count still fails it", async () => {
      const r = await real({}, ['a', 'b', 'c'], ['tokens checked: 6', '/home/testuser/.claude/projects/-home-testuser-cscb-live-a/x.jsonl: 2'])
      expect([r.status, r.reason]).toEqual(['FAIL', 'LEAK-T: 1 file(s) hold a credential'])
    })

    test.each([
      ['two numbers', '2 5', { transcripts: 2, delivered: 5 }],
      ['whitespace and a trailing newline', ' 0 0\n', { transcripts: 0, delivered: 0 }],
      ['empty', '', { transcripts: NaN, delivered: NaN }],
      ['blank', '  \n', { transcripts: NaN, delivered: NaN }],
      ['one number', '3', { transcripts: NaN, delivered: NaN }],
      ['three numbers', '1 2 3', { transcripts: NaN, delivered: NaN }],
      ['a decimal', '1.5 2', { transcripts: NaN, delivered: NaN }],
      ['a negative count', '1 -2', { transcripts: NaN, delivered: NaN }],
    ])('parsePersonaCounts(%s): exactly two whole numbers, else both NaN (never 0)', (_what, value, expected) => {
      expect(parsePersonaCounts(value)).toEqual(expected)
    })

    test.each([
      ['no line at all', undefined, 'persona a: no transcript count'],
      ['an empty value', '', 'persona a: empty transcript count (PERSONA_a is empty, not "<transcripts> <dispatched>")'],
      ['a blank value', ' \t', 'persona a: empty transcript count (PERSONA_a is empty, not "<transcripts> <dispatched>")'],
      ['anything else', '3', 'persona a: malformed transcript count (PERSONA_a is not "<transcripts> <dispatched>")'],
    ])('personaCountsProblem: %s', (_what, value, reason) => {
      expect(personaCountsProblem('a', value)).toBe(reason)
    })
  })

  test('the stored-choice file goes to both scans with the other state files (b.deo SRI-1501, SRI-401); absent, it is accepted, and a credential in it fails the check', async () => {
    expect(CHECK29A_STATE_FILES).toEqual([
      '"$S/config.json"',
      '"$S/config.json.last-applied"',
      '"$S/config.json.pending"',
      '"$S/channel-delivery.json"',
      '"$S"/server.log*',
      '"$S/startup-errors.log"',
      '"$S/permission-trail.jsonl"',
      '~/cscb-live/boot-start.log',
    ])
    const leakF = (stored: string) => ['tokens checked: 6', `${S}/config.json: 0`, `${S}/config.json.pending: absent`, `${S}/channel-delivery.json: ${stored}`, `${S}/server.log: 0`]
    const { container, scripts } = fakeContainer([['leakcount', lines({}, { f: leakF('absent') })]])
    const r = await check29a.run(makeCtx({ container }))
    expect([r.status, r.reason]).toEqual(['PASS', undefined])
    const script = scripts.find((s) => s.includes('leakcount'))!.split('\n')
    // One array holds every state file; the token-shape count and the leak count both read the whole of it.
    expect(script[0]).toBe(`F=(${CHECK29A_STATE_FILES.join(' ')})`)
    expect(script.filter((l) => l.includes('"${F[@]}"'))).toEqual(['echo "TOKF=$(tokcount "${F[@]}")"', 'echo LEAK-F; leakcount "${F[@]}"'])
    const leaked = await check29a.run(makeCtx({ container: fakeContainer([['leakcount', lines({}, { f: leakF('1') })]]).container }))
    expect([leaked.status, leaked.reason]).toEqual(['FAIL', 'LEAK-F: 1 file(s) hold a credential'])
  })

  test('fails on a host-side scan finding, reporting counts only', async () => {
    const r = await run(lines(), { hostScan: () => ({ counts: [{ source: '/results/run.log', tokenShaped: 1, knownSecrets: 0 }], total: 1 }) })
    expect(r.status).toBe('FAIL')
    expect(r.reason).toBe('the host-side scan of the results found 1 token-shaped or secret string(s)')
    expect(r.evidence).toContain('host: /results/run.log: 1 token-shaped, 0 known-secret')
  })

  test('parseLeakcount reads the count and each file (a path with ": " in it included)', () => {
    expect(parseLeakcount(['tokens checked: 6', '/a: 0', '/b: absent', '/odd: name: 3', 'noise'])).toEqual({
      checked: 6,
      files: { '/a': '0', '/b': 'absent', '/odd: name': '3' },
    })
    expect(parseLeakcount([]).checked).toBe(-1)
  })
})

// ---------------------------------------------------------------------------
// Live checks against a scripted workspace and container
// ---------------------------------------------------------------------------

const A = DRY_RUN_IDS.bots.a
const COORD = DRY_RUN_IDS.coordination

/** A live-run context: the human session over `canned` bot messages, the container answering `answers`. */
function liveCtx(canned: Record<string, CannedMessage[]>, answers: ReadonlyArray<readonly [string, Reply]>): CheckContext {
  const clock = virtualClock()
  return makeCtx({ mode: 'real', clock, human: scriptedHuman(clock, canned).human, container: fakeContainer(answers).container })
}

describe('Check 8: the persona-post event shape', () => {
  // A says "posted" in A-home, and its post in coordination is 1700000200.000002.
  const POST_TS = '1700000200.000002'
  const canned = {
    [DRY_RUN_IDS.aHome]: [{ ts: '1700000200.000001', text: 'posted', user: A.userId }],
    [COORD]: [{ ts: POST_TS, text: `<@${DRY_RUN_IDS.bots.b.userId}> shape check, no reply needed`, user: A.userId }],
  }
  const run = (raw: string) =>
    check8.run(
      liveCtx(canned, [
        [`tags b '${POST_TS}'`, `<channel source="slack" chat_id="${COORD}" user_id="${A.userId}" via="mention">`],
        [`tags a '${POST_TS}'`, ''],
        ['RAW message event persona=persona_b:', raw],
        ['dropped message from channel=', `[slack] persona "persona_a" (key=persona_a) dropped message from channel=${COORD} user=${A.userId}: own`],
        ['mark', '1:0'],
      ]),
    )

  test("passes when B's RAW line shows A's bot user or bot ID, A dropped its own post and B got one mention tag", async () => {
    const r = await run(`[slack] RAW message event persona=persona_b: {"user":"${A.userId}","bot_id":"${A.botId}","text":"shape check","ts":"${POST_TS}"}`)
    expect([r.status, r.reason]).toEqual(['PASS', undefined])
    expect(r.notes).toContain(`Check 8 RAW shape: user=${A.userId} bot_id=${A.botId} subtype=absent app_id=absent bot_profile=absent`)
  })

  test('fails, asking for a bug to be filed, when the RAW prefix was cut before user or bot_id', async () => {
    const r = await run(`[slack] RAW message event persona=persona_b: {"type":"message","ts":"${POST_TS}","text":"shape check`)
    expect([r.status, r.reason]).toEqual(['FAIL', 'file a bug: RAW prefix lacks user/bot_id (user=absent, bot_id=absent)'])
  })
})

describe('Check 9: one mention is delivered once', () => {
  const TEXT = 'reply with the word once.'
  // The human's post is the first post (1700000100.000001); A answers "once" after it.
  const HUMAN_TS = '1700000100.000001'
  const raw = (kind: 'message' | 'app_mention', withTs: boolean) =>
    `[slack] RAW ${kind} event persona=persona_a: {"user":"${DRY_RUN_IDS.humanUserId}","text":"<@${A.userId}> ${TEXT}"${withTs ? `,"ts":"${HUMAN_TS}"` : ''}`
  const run = (rawLines: string[]) =>
    check9.run(
      liveCtx({ [COORD]: [{ ts: '1700000200.000001', text: 'once', user: A.userId }] }, [
        ['Dispatching to persona', `[slack] Dispatching to persona "persona_a" (key=persona_a) chat_id=${COORD} text=<@${A.userId}> ${TEXT}`],
        ['persona=persona_a:', rawLines.join('\n')],
        [`tags a '${HUMAN_TS}'`, `<channel source="slack" chat_id="${COORD}" user_id="${DRY_RUN_IDS.humanUserId}" via="mention">`],
        ['mark', '1:0'],
      ]),
    )

  test('passes on one message and one app_mention RAW line matched by the ts', async () => {
    const r = await run([raw('message', true), raw('app_mention', true)])
    expect([r.status, r.reason]).toEqual(['PASS', undefined])
    expect(r.evidence).toContain('RAW lines matched by ts: one message, one app_mention')
  })

  test("with the ts cut off the RAW prefix, falls back to the message's text and still needs exactly one of each", async () => {
    const byText = await run([raw('message', false), raw('app_mention', false)])
    expect([byText.status, byText.reason]).toEqual(['PASS', undefined])
    expect(byText.notes).toContain('Check 9: RAW lines matched by ts: message=0 app_mention=0; by the message text: message=1 app_mention=1')
    const twice = await run([raw('message', false), raw('message', false), raw('app_mention', false)])
    expect([twice.status, twice.reason]).toEqual(['FAIL', 'RAW lines for the message: message=2 app_mention=1, not one each'])
  })
})

describe('Checks 16 and 20: the outbound reply-tool call helpers', () => {
  test('A is asked at most twice (the plan\'s "ask once more")', () => {
    expect(OUTBOUND_ASKS).toBe(2)
  })

  test.each([
    [1, true, true, 'evaluate'],
    [1, false, true, 'evaluate'],
    [1, false, false, 'silent'],
    [1, true, false, 'ask-again'],
    [2, true, true, 'evaluate'],
    [2, false, true, 'evaluate'],
    [2, false, false, 'silent'],
    [2, true, false, 'no-call'],
  ] as const)('outboundNext(asked %p, answered %p, called %p) is %p', (asked, answered, called, next) => {
    expect(outboundNext(asked, answered, called)).toBe(next)
  })

  test('callsTo matches the whole ID at the start of a replies line only (U1 is not U12)', () => {
    const replyLines = [
      'chat_id=U12 error=false result=Sent 1 message(s) to D012 (the DM with U12)',
      'chat_id=U1 error=true result=refused',
      'chat_id=C0DRYAHOME error=false result=asked about chat_id=U1 here',
      ' chat_id=U1 error=false result=indented',
      'chat_id=U1error=false result=glued',
      'chat_id=U1 error=false result=Sent 1 message(s) to D01 (the DM with U1)',
    ]
    expect(callsTo(replyLines, 'U1')).toEqual([replyLines[1], replyLines[5]])
    expect(callsTo(replyLines, 'U12')).toEqual([replyLines[0]])
    expect(callsTo(replyLines, 'U')).toEqual([])
    expect(callsTo([], 'U1')).toEqual([])
  })

  test.each([
    ['no call at all', 0, [], ''],
    ['calls to other targets only', 0, ['chat_id=U12 error=false result=a', 'chat_id=C1 error=false result=b'], ''],
    ["only the call the baseline counted (an earlier check's)", 1, ['chat_id=U1 error=true result=old'], ''],
    ['a new call after the baseline', 1, ['chat_id=U1 error=true result=old', 'chat_id=C1 error=false result=b', 'chat_id=U1 error=false result=new'], 'chat_id=U1 error=false result=new'],
    ['the newest of several new calls', 0, ['chat_id=U1 error=true result=first', 'chat_id=U12 error=false result=other', 'chat_id=U1 error=false result=second'], 'chat_id=U1 error=false result=second'],
    ['a new call to U12 is no new call to U1', 1, ['chat_id=U1 error=true result=old', 'chat_id=U12 error=false result=new'], ''],
  ])('newCallTo: %s', (_what, before, replyLines, expected) => {
    expect(newCallTo(before, replyLines, 'U1')).toBe(expected)
  })
})

describe('Checks 14, 16 and 20 on a rerun: the run-scoped decisions', () => {
  const ID = 'U0DRYSECND'

  test.each([
    ['the ID alone', ID, ID, true],
    ['the ID after "=" in a log line', `[slack] dropped message user=${ID} channel=C0DRYAHOME`, ID, true],
    ['the ID in quotes in a tag', `<channel source="slack" user_id="${ID}" via="dm">`, ID, true],
    ['a longer ID that starts with it', `user=${ID}9`, ID, false],
    ['a longer ID that ends with it', `user=X${ID}`, ID, false],
    ['a longer ID, then the ID itself', `user=${ID}9 then user=${ID}`, ID, true],
    ['another user only', 'user=U0DRYOTHER', ID, false],
    ['an empty ID', `user=${ID}`, '', false],
  ])('namesSlackId: %s is %p', (_what, line, id, named) => {
    expect(namesSlackId(line, id)).toBe(named)
  })

  const seen = (what: string) => `this run's server has already seen the second account (${what} name its user ID before the check posted); it is no longer a first-time user`

  test.each([
    ['nothing names the user: a first-time user', [], [], ID, null],
    ['only a longer ID and another user (lines grep -F also prints)', [`user=${ID}9`, 'user=U0DRYOTHER'], [`<channel user_id="X${ID}">`], ID, null],
    ['one log line', [`user=${ID}`, `user=${ID}9`], [], ID, seen('1 server log line(s)')],
    ['one persona tag', [], [`<channel user_id="${ID}">`], ID, seen('1 persona tag(s)')],
    ['log lines and a tag, each counted', [`user=${ID}`, `chat_id=${ID}`], [`<channel user_id="${ID}">`], ID, seen('2 server log line(s) and 1 persona tag(s)')],
    ['an unknown (empty) user ID, with nothing logged', [], [], '', "the second account's user ID is unknown"],
  ])('priorContact: %s', (_what, log, tagLines, id, reason) => {
    expect(priorContact(log, tagLines, id)).toBe(reason)
  })

  test("postsAfter keeps only messages newer than the ts (not one at it, not an earlier run's), from the bot and with the text when given", () => {
    const after = '1700000100.000005'
    const messages: SlackMessage[] = [
      { ts: '1690000000.000100', text: 'DMs-on outbound check', user: A.userId },
      { ts: after, text: 'DMs-on outbound check', user: A.userId },
      { ts: '1700000100.000006', text: 'DMs-on outbound check', bot_id: A.botId },
      { ts: '1700000100.000007', text: 'something else', user: A.userId },
      { ts: '1700000100.000008', text: 'DMs-on outbound check', user: 'U0DRYOTHER' },
    ]
    const tss = (found: SlackMessage[]) => found.map((m) => m.ts)
    expect(tss(postsAfter(messages, after))).toEqual(['1700000100.000006', '1700000100.000007', '1700000100.000008'])
    expect(tss(postsAfter(messages, after, A))).toEqual(['1700000100.000006', '1700000100.000007'])
    expect(tss(postsAfter(messages, after, A, 'DMs-on outbound check'))).toEqual(['1700000100.000006'])
    expect(postsAfter(messages, '1700000100.000008')).toEqual([])
  })

  const TS = '1700000100.000005'
  test.each<[string, string[], boolean]>([
    ['a message older than the ts (an earlier run\'s, in a lower second)', ['1699999999.999999', '1700000100.000006'], true],
    ['a message older than the ts by its microseconds', ['1700000100.000004'], true],
    ['only messages newer than the ts', ['1700000100.000006', '1700000101.000001'], false],
    ['only a message at the ts (the check\'s own post)', [TS], false],
    ['no message', [], false],
  ])('heldBefore: %s is %p', (_what, tss, held) => {
    expect(heldBefore(tss.map((ts) => ({ ts, text: 'x', user: A.userId })), TS)).toBe(held)
  })

  test.each([
    ['a sent result', `chat_id=${ID} error=false result=Sent 1 message(s) to D0DRYSECDM (the DM with ${ID}) [ts: 1700000300.000001]`, 'D0DRYSECDM'],
    ['a refusal', `chat_id=${ID} error=true result=Persona "persona_a" (key=persona_a) may not target "${ID}"`, null],
    ['a message sent to a channel, not a DM', 'chat_id=C0DRYAHOME error=false result=Sent 1 message(s) to C0DRYAHOME', null],
    ['no call', '', null],
  ])('sentDmId: %s gives %p', (_what, call, dm) => {
    expect(sentDmId(call)).toBe(dm)
  })
})

/** A message in a scripted conversation; `thread` puts it in the thread under that ts. */
interface ScriptedMessage extends CannedMessage {
  channel: string
  thread?: string
}

/**
 * Slack as a test account's session reads it, over `messages`: history lists
 * a conversation's top-level messages after `oldest` (from it when
 * `inclusive`), each thread parent with its reply count and newest reply;
 * replies list a thread's parent and its replies; `conversations.list` lists
 * `dms()`; `conversations.open` gives `openDm`. A post is stored under the
 * next ts (`nextTs`) as `poster`'s, then `onPost` plays what follows it.
 */
function scriptedSlack(opts: {
  messages: ScriptedMessage[]
  nextTs: () => string
  poster: string
  onPost: (channel: string, text: string, ts: string) => void
  dms?: () => { id: string; user: string }[]
  openDm?: string
}): HumanApi {
  const { messages, nextTs, poster, onPost, dms = () => [], openDm = 'D0DRYDM001' } = opts
  const asSlack = (m: ScriptedMessage) => ({ ts: m.ts, text: m.text, user: m.user, ...(m.thread === undefined ? {} : { thread_ts: m.thread }) })
  return {
    call: async (method, params = {}) => {
      const channel = String(params.channel ?? '')
      const inChannel = messages.filter((m) => m.channel === channel)
      if (method === 'chat.postMessage') {
        const ts = nextTs()
        messages.push({ channel, ts, text: String(params.text), user: poster })
        onPost(channel, String(params.text), ts)
        return { ok: true, ts }
      }
      if (method === 'conversations.history') {
        const oldest = String(params.oldest ?? '0')
        const listed = inChannel.filter((m) => m.thread === undefined && (params.inclusive === true ? m.ts >= oldest : m.ts > oldest))
        return {
          ok: true,
          messages: listed.map((m) => {
            const replies = inChannel.filter((r) => r.thread === m.ts).map((r) => r.ts).sort()
            return replies.length === 0 ? asSlack(m) : { ...asSlack(m), reply_count: replies.length, latest_reply: replies.at(-1) }
          }),
        }
      }
      if (method === 'conversations.replies') {
        const ts = String(params.ts)
        return { ok: true, messages: inChannel.filter((m) => m.ts === ts || m.thread === ts).map(asSlack) }
      }
      if (method === 'conversations.list') return { ok: true, channels: dms() }
      if (method === 'conversations.open') return { ok: true, channel: { id: openDm } }
      return { ok: true }
    },
  }
}

describe('Checks 16 and 20 against a scripted A', () => {
  const SECOND_ID = 'U0DRYSECND'
  const NEW_DM = 'D0DRYSECDM'
  // Check 16's call as `replies a` prints it, with the package's own refusal for A (DMs off) and the second user.
  const REFUSED = (() => {
    const config = parsePersonaConfigBytes(renderConfig(buildLiveConfig(DRY_RUN_IDS)), `${S}/config.json`, S, { home: '/home/testuser' })
    const scope = checkPersonaTarget(config.personas[0]!, SECOND_ID, 'post')
    if (scope.allowed) throw new Error('A may message the second user')
    return `chat_id=${SECOND_ID} error=true result=${scope.message}`
  })()
  // Check 20's call: the DM opened, one message sent.
  const SENT = `chat_id=${SECOND_ID} error=false result=Sent 1 message(s) to ${NEW_DM} (the DM with ${SECOND_ID}) [ts: 1700000300.000001]`
  /** A's message in the second user's DM with A from an earlier run, before this run's asks. */
  const EARLIER_TS = '1690000000.000100'

  /** What A does on one ask: says done or not, and the `replies a` line of the call it makes, if any. */
  interface AskStep {
    done: boolean
    call?: string
    /** With a successful call: false when A's message never reaches the DM (default true). */
    delivered?: boolean
    /** A message from `user` that reaches the second user's DM with A after the ask: top-level, or in the thread under the earlier run's message. */
    dmPost?: { user: string; inThread: boolean }
  }

  /**
   * The second user's DM with A before the check: none listed, listed but
   * empty (as Slack lists one from the day an account joins), or an earlier
   * run's, holding A's old `DMs-on outbound check` message with the second
   * user's old reply in its thread.
   */
  type DmBefore = 'none' | 'empty' | 'earlier'

  /**
   * A-home, `replies a` and the second user's DMs, scripted per ask: each
   * human post in A-home is one ask and plays the next step (A's call lands
   * in `replies a`, then A says done). A successful call opens the DM with
   * the second user and posts A's message there. `earlier` is what
   * `replies a` printed before the check (an earlier check's call). Every
   * message gets the next ts, so A's done belongs to the ask it follows.
   * `calls` records each Slack call, as `human <method>` or `second <method>`.
   */
  function scriptedA(steps: AskStep[], earlier: string[] = [], dmBefore: DmBefore = 'none') {
    const clock = virtualClock()
    let seq = 0
    const nextTs = () => `1700000100.${String(++seq).padStart(6, '0')}`
    const messages: ScriptedMessage[] =
      dmBefore === 'earlier'
        ? [
            { channel: NEW_DM, ts: EARLIER_TS, text: 'DMs-on outbound check', user: A.userId },
            { channel: NEW_DM, ts: '1690000000.000200', text: 'got it', user: SECOND_ID, thread: EARLIER_TS },
          ]
        : []
    const replyLines = [...earlier]
    const asks: { text: string; ts: string; done: string | null }[] = []
    let dmOpen = dmBefore !== 'none'
    const onPost = (channel: string, text: string, ts: string) => {
      if (channel !== DRY_RUN_IDS.aHome) return
      const step = steps[asks.length] ?? { done: false }
      if (step.call !== undefined) {
        replyLines.push(step.call)
        if (step.call.startsWith(`chat_id=${SECOND_ID} error=false`)) {
          dmOpen = true
          if (step.delivered !== false) messages.push({ channel: NEW_DM, ts: nextTs(), text: 'DMs-on outbound check', user: A.userId })
        }
      }
      if (step.dmPost) {
        dmOpen = true
        messages.push({ channel: NEW_DM, ts: nextTs(), text: 'hello', user: step.dmPost.user, ...(step.dmPost.inThread ? { thread: EARLIER_TS } : {}) })
      }
      const done = step.done ? nextTs() : null
      if (done) messages.push({ channel, ts: done, text: 'done', user: A.userId })
      asks.push({ text, ts, done })
    }
    const api = scriptedSlack({ messages, nextTs, poster: DRY_RUN_IDS.humanUserId, onPost, dms: () => (dmOpen ? [{ id: NEW_DM, user: A.userId }] : []) })
    const { container } = fakeContainer([['', (script) => (script === 'mark' ? '1:0' : script === 'replies a' ? replyLines.join('\n') : '')]])
    const calls: string[] = []
    const ctx = makeCtx({
      mode: 'real',
      clock,
      human: new HumanSession(recordingApi(api, 'human', calls), clock),
      second: { human: new HumanSession(recordingApi(api, 'second', calls), clock), userId: SECOND_ID },
      container,
    })
    /** The evidence line each ask should leave. */
    const askEvidence = () => asks.map((a, i) => `ask ${i + 1}: TS ${a.ts}, ${a.done ? `done ${a.done}` : 'no done from A'}`)
    return { ctx, asks, askEvidence, calls }
  }

  async function runWith(check: CheckDef<CheckContext>, steps: AskStep[], earlier: string[] = [], dmBefore: DmBefore = 'none') {
    const a = scriptedA(steps, earlier, dmBefore)
    const r = await check.run(a.ctx)
    assertNoLeak(r)
    return { r, ...a }
  }

  const BOTH = [
    ['16', check16, REFUSED],
    ['20', check20, SENT],
  ] as const

  test.each(BOTH)('Check %s: A silent on the first ask is one post, then a FAIL', async (_id, check) => {
    const { r, asks, askEvidence } = await runWith(check, [{ done: false }])
    expect([r.status, r.reason]).toEqual(['FAIL', `A did not say done and made no reply-tool call to ${SECOND_ID}`])
    expect(asks.length).toBe(1)
    expect(r.evidence).toEqual(askEvidence())
    expect(r.evidence[0]).toEndWith('no done from A')
  })

  test.each(BOTH)('Check %s: done on the first ask but silent on the second is a FAIL naming the second ask', async (_id, check) => {
    const { r, asks, askEvidence } = await runWith(check, [{ done: true }, { done: false }])
    expect([r.status, r.reason]).toEqual(['FAIL', `A did not say done to the second ask and made no reply-tool call to ${SECOND_ID}`])
    expect(asks.length).toBe(2)
    expect(r.evidence).toEqual(askEvidence())
  })

  test.each(BOTH)('Check %s: no call on the first ask, the call on the second: the same ask is posted again and the call is evaluated', async (_id, check, call) => {
    const { r, asks, askEvidence } = await runWith(check, [{ done: true }, { done: true, call }])
    expect([r.status, r.reason]).toEqual(['PASS', undefined])
    expect(asks.length).toBe(2)
    expect(asks[1]!.text).toBe(asks[0]!.text)
    expect(r.evidence).toEqual(askEvidence())
  })

  test.each(BOTH)('Check %s: a call on the first ask is evaluated at once, with no second ask', async (_id, check, call) => {
    const { r, asks } = await runWith(check, [{ done: true, call }])
    expect([r.status, r.reason]).toEqual(['PASS', undefined])
    expect(asks.length).toBe(1)
  })

  test.each(BOTH)('Check %s: a call without a done is evaluated, not asked for again, and fails on the missing done', async (_id, check, call) => {
    const { r, asks } = await runWith(check, [{ done: false, call }])
    expect([r.status, r.reason]).toEqual(['FAIL', 'A did not say done'])
    expect(asks.length).toBe(1)
  })

  test('no call after two asks: exactly two posts; Check 16 is SKIPPED "not run" (not a pass) with the ask evidence, Check 20 FAILs', async () => {
    const c16 = await runWith(check16, [{ done: true }, { done: true }])
    expect([c16.r.status, c16.r.reason]).toEqual(['SKIPPED', `not run: A made no reply-tool call to ${SECOND_ID} (asked 2 times; the plan records this as "not run", not a pass)`])
    expect(c16.asks.length).toBe(2)
    expect(c16.r.evidence).toEqual(c16.askEvidence())
    expect(c16.r.evidence.length).toBe(2)
    const c20 = await runWith(check20, [{ done: true }, { done: true }])
    expect([c20.r.status, c20.r.reason]).toEqual(['FAIL', `A made no reply-tool call to ${SECOND_ID} (asked 2 times)`])
    expect(c20.asks.length).toBe(2)
    expect(c20.r.evidence).toEqual(c20.askEvidence())
  })

  test("Check 20 ignores Check 16's earlier refused call: with no new call it asks twice and FAILs; a new call is the one evaluated", async () => {
    const none = await runWith(check20, [{ done: true }, { done: true }], [REFUSED])
    expect([none.r.status, none.r.reason]).toEqual(['FAIL', `A made no reply-tool call to ${SECOND_ID} (asked 2 times)`])
    expect(none.asks.length).toBe(2)
    const fresh = await runWith(check20, [{ done: true, call: SENT }], [REFUSED])
    expect([fresh.r.status, fresh.r.reason]).toEqual(['PASS', undefined])
    expect(fresh.asks.length).toBe(1)
  })

  test.each(BOTH)('Check %s: an empty DM with A listed before the check: the check runs and passes', async (_id, check, call) => {
    const { r, asks } = await runWith(check, [{ done: true, call }], [], 'empty')
    expect([r.status, r.reason]).toEqual(['PASS', undefined])
    expect(asks.length).toBe(1)
  })

  test.each(BOTH)("Check %s on a rerun: an earlier run's DM with A, holding A's old message and an old thread reply, is no skip: the check runs and passes", async (_id, check, call) => {
    const { r, asks } = await runWith(check, [{ done: true, call }], [], 'earlier')
    expect([r.status, r.reason]).toEqual(['PASS', undefined])
    expect(asks.length).toBe(1)
  })

  test.each(BOTH)("Check %s on a rerun makes no Slack call as the second user before A is first asked, and reads the DM after it", async (_id, check, call) => {
    const { calls } = await runWith(check, [{ done: true, call }], [], 'earlier')
    const ask = calls.indexOf('human chat.postMessage')
    expect(ask).toBeGreaterThan(-1)
    expect(calls.slice(0, ask).filter((c) => c.startsWith('second '))).toEqual([])
    expect(calls.slice(ask).filter((c) => c.startsWith('second ')).length).toBeGreaterThan(0)
  })

  const REUSED_20 = "Check 20: the DM with A already held messages older than the first ask (an earlier run's DM, reused)"
  const NEW_20 = 'Check 20: the DM with A held no message older than the first ask (a new DM, or one no earlier run posted in)'

  test.each<[string, DmBefore, string]>([
    ["an earlier run's DM, holding A's old message", 'earlier', REUSED_20],
    ['no DM before the check (A opens it)', 'none', NEW_20],
    ['an empty DM listed before the check', 'empty', NEW_20],
  ])('Check 20 passes and notes whether the DM was reused: %s', async (_what, dmBefore, note) => {
    const { r } = await runWith(check20, [{ done: true, call: SENT }], [], dmBefore)
    expect([r.status, r.reason]).toEqual(['PASS', undefined])
    expect((r.notes ?? []).filter((n) => n.startsWith('Check 20: the DM with A'))).toEqual([note])
  })

  test.each([
    ['top-level, from A', [{ done: true, call: REFUSED, dmPost: { user: A.userId, inThread: false } }]],
    ["in the thread under the earlier run's message, from A", [{ done: true, call: REFUSED, dmPost: { user: A.userId, inThread: true } }]],
    ['top-level, from another user', [{ done: true, call: REFUSED, dmPost: { user: 'U0DRYOTHER', inThread: false } }]],
    ['after the first ask, before the second ask that got the refusal', [{ done: true, dmPost: { user: A.userId, inThread: false } }, { done: true, call: REFUSED }]],
  ])("Check 16 on a rerun: a message reaching the earlier run's DM with A after the first ask fails it, the refusal notwithstanding (%s)", async (_what, steps) => {
    const { r } = await runWith(check16, steps, [], 'earlier')
    expect([r.status, r.reason]).toEqual(['FAIL', "the second user's DM with A got a message during this check"])
  })

  test("Check 20 on a rerun: only the earlier run's message from A in the DM (the call names the DM, nothing new arrives) is a FAIL", async () => {
    const { r } = await runWith(check20, [{ done: true, call: SENT, delivered: false }], [], 'earlier')
    expect([r.status, r.reason]).toEqual(['FAIL', "the DM does not hold A's message from this check"])
  })

  test("Check 20: a result naming a DM other than the second user's DM with A is a FAIL, though A's new message is in the DM with A", async () => {
    const { r } = await runWith(check20, [{ done: true, call: SENT.replace(NEW_DM, 'D0DRYOTHER') }], [], 'earlier')
    expect([r.status, r.reason]).toEqual(['FAIL', "the result names another DM than the second user's DM with A"])
  })

  test("the call evaluated must be the check's own: Check 16 fails a sent message, Check 20 fails a refusal", async () => {
    const c16 = await runWith(check16, [{ done: true, call: SENT }])
    expect([c16.r.status, c16.r.reason]).toEqual(['FAIL', "the call was not refused; the refusal text is not the expected one; the second user's DM with A got a message during this check"])
    const c20 = await runWith(check20, [{ done: true, call: REFUSED }])
    expect([c20.r.status, c20.r.reason]).toEqual(['FAIL', 'the call to the second user failed; the result does not name the DM; the second user has no DM with A'])
  })
})

describe("Check 14: a first-time user to this run's server, with the same second account on every run", () => {
  const SECOND_ID = 'U0DRYSECND'
  const B = DRY_RUN_IDS.bots.b
  /** The second user's DM with B from an earlier run: `conversations.open` gives it again. */
  const B_DM = 'D0DRYSECDB'
  const SHA = 'c'.repeat(64)
  /** The earlier run's exchange in that DM: the ask and B's open-dm answer. */
  const EARLIER: ScriptedMessage[] = [
    { channel: B_DM, ts: '1690000000.000100', text: 'Reply with the word open-dm.', user: SECOND_ID },
    { channel: B_DM, ts: '1690000000.000200', text: 'open-dm', user: B.userId },
  ]

  /**
   * Check 14 on a live context. The container's server log and persona tags
   * print `log` and `tagLines` for the check's search for the second user;
   * the install and the stale access.json are as the plan expects, the
   * guarded restart comes up, and the access-control search prints
   * `accessLines`. On the second account's session A answers open-channel in
   * A-home and, when `bAnswers`, B answers open-dm in the DM with B, which
   * holds the earlier run's exchange (unless `earlier` is false: a new DM).
   * `slackCalls` records each Slack call, as `human <method>` or
   * `second <method>`.
   */
  function check14Run(opts: { log?: string[]; tagLines?: string[]; bAnswers?: boolean; accessLines?: string[]; earlier?: boolean } = {}) {
    const { log = [], tagLines = [], bAnswers = true, accessLines = [], earlier = true } = opts
    const clock = virtualClock()
    const start = timedLog(clock, startLog(155))
    let seq = 0
    const nextTs = () => `1700000100.${String(++seq).padStart(6, '0')}`
    const messages: ScriptedMessage[] = earlier ? [...EARLIER] : []
    const answer = (channel: string, user: string, text: string) => messages.push({ channel, ts: nextTs(), text, user })
    const api = scriptedSlack({
      messages,
      nextTs,
      poster: SECOND_ID,
      openDm: B_DM,
      onPost: (channel, text) => {
        if (channel === DRY_RUN_IDS.aHome && text.includes('open-channel')) answer(channel, A.userId, 'open-channel')
        if (channel === B_DM && text.includes('open-dm') && bAnswers) answer(channel, B.userId, 'open-dm')
      },
    })
    const { container, scripts } = fakeContainer([
      ['server.log*', log.join('\n')],
      ['.jsonl', tagLines.join('\n')],
      ['ACCESS=present', 'ACCESS=absent\nLINK=symlink\nSKILL_LINK_OK\nSKILLMD=yes\nRETIRED=absent'],
      ['CREATED=0', `CREATED=1 ${SHA}`],
      [
        'claude-slack-channel-bots start',
        () => {
          start.begin()
          return ''
        },
      ],
      ['[ -e "$S/config.json.pending" ]', { code: 1 }],
      ["grep -iE 'pairing", accessLines.join('\n')],
      ['tags a ', `<channel source="slack" chat_id="${DRY_RUN_IDS.aHome}" user_id="${SECOND_ID}" via="receive_all">`],
      ['tags b ', `<channel source="slack" chat_id="${B_DM}" user_id="${SECOND_ID}" via="dm">`],
      ['replies a | tail', `chat_id=${DRY_RUN_IDS.aHome} error=false result=Sent 1 message(s) to ${DRY_RUN_IDS.aHome}`],
      ['replies b | tail', `chat_id=${B_DM} error=false result=Sent 1 message(s) to ${B_DM}`],
      ['sha256sum "$S/access.json" | cut -d" "', SHA],
      ['access.json.corrupt', '0'],
      ['', (script) => (script === 'mark' ? '1:0' : (start.since(script) ?? ''))],
    ])
    const slackCalls: string[] = []
    const ctx = makeCtx({
      mode: 'real',
      clock,
      human: new HumanSession(recordingApi(scriptedHuman(clock).api, 'human', slackCalls), clock),
      second: { human: new HumanSession(recordingApi(api, 'second', slackCalls), clock), userId: SECOND_ID },
      container,
    })
    /** What the second account posted in this run. */
    const posted = () => messages.filter((m) => m.user === SECOND_ID && !EARLIER.includes(m))
    return { ctx, scripts, posted, slackCalls }
  }

  test("an earlier run's DM with B, and a log line naming only a longer ID: the check runs in that DM, A and B answer with no approval step, a PASS", async () => {
    const run = check14Run({ log: [`[slack] dropped message user=${SECOND_ID}9 channel=C0DRYOTHER`] })
    const r = await check14.run(run.ctx)
    expect([r.status, r.reason]).toEqual(['PASS', undefined])
    expect(r.evidence).toContain(`TS_CH 1700000100.000001, TS_DM 1700000100.000003, B_NEW_DM_ID ${B_DM}`)
    // Its first Slack call is the human's invite, after the search for the second user.
    expect(run.slackCalls[0]).toBe('human conversations.invite')
  })

  test.each<[string, boolean, string]>([
    ["an earlier run's DM with B, holding that run's exchange", true, "Check 14: the DM with B already held messages older than TS_DM (an earlier run's DM, reused)"],
    ['a new DM with B', false, 'Check 14: the DM with B held no message older than TS_DM (a new DM, or one no earlier run posted in)'],
  ])('Check 14 passes and notes whether the DM was reused: %s', async (_what, earlier, note) => {
    const r = await check14.run(check14Run({ earlier }).ctx)
    expect([r.status, r.reason]).toEqual(['PASS', undefined])
    expect((r.notes ?? []).filter((n) => n.startsWith('Check 14: the DM with B'))).toEqual([note])
  })

  test.each([
    ["B silent this run: the earlier run's open-dm answer in the DM does not count", { bAnswers: false }, 'B did not answer open-dm'],
    ['an approval step (a pairing line after the mark)', { accessLines: [`[slack] pairing code sent to ${SECOND_ID}`] }, 'access-control lines appeared: 1'],
  ])('%s: a FAIL', async (_what, opts, reason) => {
    const r = await check14.run(check14Run(opts).ctx)
    expect([r.status, r.reason]).toEqual(['FAIL', reason])
  })

  test.each([
    ['a server log line', { log: [`[slack] Dispatching to persona "persona_a" (key=persona_a) chat_id=C0DRYAHOME user=${SECOND_ID}`] }, '1 server log line(s)'],
    ['a persona tag', { tagLines: [`<channel source="slack" chat_id="C0DRYAHOME" user_id="${SECOND_ID}" via="receive_all">`] }, '1 persona tag(s)'],
  ])("this run's server already saw the second user (%s): SKIPPED \"not verified\" before any setup, post, invite or Slack read", async (_what, opts, what) => {
    const run = check14Run(opts)
    const r = await check14.run(run.ctx)
    expect([r.status, r.reason]).toEqual([
      'SKIPPED',
      `not verified: this run's server has already seen the second account (${what} name its user ID before the check posted); it is no longer a first-time user`,
    ])
    expect(run.scripts.length).toBe(2)
    expect(run.scripts.every((s) => s.includes(`'${SECOND_ID}'`))).toBe(true)
    expect(run.posted()).toEqual([])
    expect(run.slackCalls).toEqual([])
  })
})

describe("Check 12: the stop bans nothing, and is lifted once coordination is quiet", () => {
  const B = DRY_RUN_IDS.bots.b
  const MENTIONS = `<@${A.userId}> <@${B.userId}>`
  const BAN_RE = /do not post|don't post|never post|not post .*again/i
  /** A delivered mention tag, as `tags` prints it. */
  const tagFrom = (author: typeof A) => `<channel source="slack" chat_id="${COORD}" user_id="${author.userId}" via="mention">`

  /**
   * A and B over a workspace whose timestamps follow the virtual clock. The
   * human's post in A-home sets off the exchange in coordination: A asks, B
   * answers, three posts each. With `keepPosting`, A posts again at every
   * read of coordination after the stop until the stop is typed into the
   * personas' terminals. The container answers `mark`, `tags` (the mention
   * tag from the other persona) and the Dispatching grep; `fail` names a
   * script that throws. `events` is every human post and container script,
   * in order; `refuseLift` has Slack refuse the lift's post.
   */
  function exchange(opts: { keepPosting?: boolean; refuseLift?: boolean; fail?: string } = {}) {
    const clock = virtualClock()
    let seq = 0
    const nextTs = () => `${Math.floor(clock.now() / 1000)}.${String(++seq).padStart(6, '0')}`
    const messages: (CannedMessage & { channel: string })[] = []
    const events: string[] = []
    const posts: { channel: string; text: string; ts: string; at: number }[] = []
    let stopped = false
    let paneStopped = false
    const say = (author: typeof A, text: string) => messages.push({ channel: COORD, ts: nextTs(), text, user: author.userId })
    const api: HumanApi = {
      call: async (method, params = {}) => {
        const channel = String(params.channel ?? '')
        if (method === 'chat.postMessage') {
          const text = String(params.text)
          if (opts.refuseLift && text.includes(CHECK12_LIFT)) return { ok: false, error: 'channel_not_found' }
          const ts = nextTs()
          messages.push({ channel, ts, text, user: DRY_RUN_IDS.humanUserId })
          posts.push({ channel, text, ts, at: clock.now() })
          events.push(`post ${channel} ${text}`)
          if (channel === DRY_RUN_IDS.aHome) {
            for (let i = 1; i <= 3; i++) {
              say(A, `<@${B.userId}> question ${i}`)
              say(B, `<@${A.userId}> answer ${i}`)
            }
          }
          if (channel === COORD && text.includes(CHECK12_STOP)) stopped = true
          return { ok: true, ts }
        }
        if (method === 'conversations.history') {
          if (channel === COORD && opts.keepPosting && stopped && !paneStopped) say(A, `<@${B.userId}> one more question`)
          return { ok: true, messages: messages.filter((m) => m.channel === channel && m.ts >= String(params.oldest ?? '0')) }
        }
        return { ok: true, messages: [] }
      },
    }
    const { container } = fakeContainer([
      [
        '',
        (script) => {
          events.push(`sh ${script}`)
          if (opts.fail !== undefined && script.includes(opts.fail)) throw new Error(`container: ${opts.fail} failed`)
          if (script.includes(CHECK12_PANE_STOP)) paneStopped = true
          if (script === 'mark') return '1:0'
          if (script.startsWith('tags b ')) return tagFrom(A)
          if (script.startsWith('tags a ')) return tagFrom(B)
          if (script.includes('Dispatching to persona')) return `[slack] Dispatching to persona "persona_b" (key=persona_b) chat_id=${COORD} text=…`
          return ''
        },
      ],
    ])
    const ctx = makeCtx({ mode: 'real', clock, human: new HumanSession(api, clock), container })
    return { ctx, events, posts }
  }

  const liftPost = `post ${COORD} ${MENTIONS} ${CHECK12_LIFT}`
  const paneScript = (l: 'a' | 'b', text: string, interrupt: boolean) => `sh guard || exit 90\n${typeIntoPane(l, text, interrupt)}`
  const LIMIT_SEARCH = "sh since '1:0' | grep -inE 'limit|throttl|loop|too many'"

  test('the stop and the lift ban nothing; the lift says A and B may post in coordination again', () => {
    for (const text of [CHECK12_STOP, CHECK12_PANE_STOP, CHECK12_LIFT]) expect(text).not.toMatch(BAN_RE)
    expect(CHECK12_LIFT).toContain('You may post in coordination again')
  })

  test('personas that obey the stop: the stop in coordination, then, once quiet for two minutes and after the limit search, the lift in coordination only', async () => {
    const { ctx, events, posts } = exchange()
    const r = await check12.run(ctx)
    expect([r.status, r.reason]).toEqual(['PASS', undefined])
    const [start, stop, lift] = posts
    expect(posts.length).toBe(3)
    expect([start!.channel, stop!.channel, lift!.channel]).toEqual([DRY_RUN_IDS.aHome, COORD, COORD])
    expect(stop!.text).toBe(`${MENTIONS} ${CHECK12_STOP}`)
    expect(lift!.text).toBe(`${MENTIONS} ${CHECK12_LIFT}`)
    for (const p of posts) expect(p.text).not.toMatch(BAN_RE)
    expect(lift!.at - stop!.at).toBeGreaterThanOrEqual(2 * MINUTE)
    expect(events.indexOf(LIMIT_SEARCH)).toBeGreaterThan(events.indexOf(`post ${COORD} ${stop!.text}`))
    expect(events.indexOf(liftPost)).toBeGreaterThan(events.indexOf(LIMIT_SEARCH))
    expect(events.filter((e) => e.includes('tmux send-keys'))).toEqual([])
    expect(r.evidence).toContain(`the stop lifted in coordination: ${lift!.ts}`)
    assertNoLeak(r)
  })

  test('personas that keep posting: stopped in both terminals (Escape first), then the lift in coordination and typed into both terminals with no Escape', async () => {
    const { ctx, events } = exchange({ keepPosting: true })
    const r = await check12.run(ctx)
    expect([r.status, r.reason]).toEqual(['PASS', undefined])
    expect(r.notes).toContain('Check 12: the personas kept posting after the stop message; stopped in their terminals (Escape + message)')
    const panes = events.filter((e) => e.includes('tmux send-keys'))
    expect(panes).toEqual([
      paneScript('a', CHECK12_PANE_STOP, true),
      paneScript('b', CHECK12_PANE_STOP, true),
      paneScript('a', CHECK12_LIFT, false),
      paneScript('b', CHECK12_LIFT, false),
    ])
    expect(panes.slice(2).some((e) => e.includes('Escape'))).toBe(false)
    // The lift follows the terminal stop, the quiet wait and the limit search, and is posted before it is typed.
    const liftAt = events.indexOf(liftPost)
    expect(liftAt).toBeGreaterThan(events.indexOf(panes[1]!))
    expect(liftAt).toBeGreaterThan(events.indexOf(LIMIT_SEARCH))
    expect(events.indexOf(panes[2]!)).toBeGreaterThan(liftAt)
  })

  test('a step that throws after the stop still lifts it before the error ends the check', async () => {
    const { ctx, events } = exchange({ fail: 'grep -inE' })
    await expect(check12.run(ctx)).rejects.toThrow('container: grep -inE failed')
    expect(events.at(-1)).toBe(liftPost)
  })

  test("a lift Slack refuses is a note, not a failure or a throw; the check's result stands", async () => {
    const { ctx, posts } = exchange({ refuseLift: true })
    const r = await check12.run(ctx)
    expect([r.status, r.reason]).toEqual(['PASS', undefined])
    expect(posts.some((p) => p.text.includes(CHECK12_LIFT))).toBe(false)
    expect(r.notes).toContain(
      'Check 12: the lift could not be posted in coordination (HumanCallError: chat.postMessage failed: channel_not_found); a later check may find A or B unwilling to post there',
    )
  })

  test("the plan's Check 12 gives the runner's stop, terminal stop and lift texts", () => {
    const plan = readFileSync(join(import.meta.dir, '..', 'testplans', 'b.yko', 'b.yko.md'), 'utf-8')
    const section = plan.slice(plan.indexOf('### Check 12:'), plan.indexOf('## Part 5:')).replace(/\s+/g, ' ')
    expect(section).toContain(`"@CSCB Test A @CSCB Test B ${CHECK12_STOP}"`)
    expect(section).toContain(`type "${CHECK12_PANE_STOP}"`)
    expect(section).toContain(`"@CSCB Test A @CSCB Test B ${CHECK12_LIFT}"`)
  })

  test("the start message first tells A who it and B are (persona name and key, bot user IDs), so it doesn't look itself up; the plan's step 1 gives the same text", async () => {
    const { ctx, posts } = exchange()
    await check12.run(ctx)
    const start = posts[0]!
    expect(start.channel).toBe(DRY_RUN_IDS.aHome)
    expect(start.text).toBe(check12Start({ coordination: COORD, aUserId: A.userId, bUserId: B.userId }))
    expect(start.text).toStartWith(
      `You are persona_a (key=persona_a), bot user ID \`${A.userId}\`. B is persona_b (key=persona_b), bot user ID \`${B.userId}\`. ` +
        "That is all you need to know about who you are, so don't look it up. In coordination, ",
    )
    expect(start.text).toContain(`mentions \`<@${B.userId}>\``)
    expect(start.text).toContain(`mention you as \`<@${A.userId}>\``)
    const plan = readFileSync(join(import.meta.dir, '..', 'testplans', 'b.yko', 'b.yko.md'), 'utf-8')
    const section = plan.slice(plan.indexOf('### Check 12:'), plan.indexOf('## Part 5:')).replace(/\s+/g, ' ')
    expect(section).toContain(`post: "${check12Start({ coordination: '<COORDINATION_CHANNEL_ID>', aUserId: '<A_BOT_USER_ID>', bUserId: '<B_BOT_USER_ID>' })}"`)
  })

  test('typeIntoPane: Escape first only when interrupting; the text is one literal word', () => {
    expect(typeIntoPane('b', "it's over", false)).toBe(`tmux send-keys -t slack_bot_persona_b -l 'it'\\''s over'; sleep 1; tmux send-keys -t slack_bot_persona_b Enter`)
    expect(typeIntoPane('a', 'stop', true)).toBe(
      `tmux send-keys -t slack_bot_persona_a Escape; sleep 1; tmux send-keys -t slack_bot_persona_a -l 'stop'; sleep 1; tmux send-keys -t slack_bot_persona_a Enter`,
    )
  })
})

/** Playwright's own timeout error, as a locator or a navigation in a flow throws it. */
class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

describe("Check 28: a failed revocation of B's older app-level token (step 7)", () => {
  const B = DRY_RUN_IDS.bots.b
  const ROTATED_ASK = 'reply with the word rotated.'
  const MAY_BE_VALID = "Check 28: B's older app-level token (cscb-live) may still be valid: revoke it on B's Basic Information page"
  /** Step 8's revert (behind the guard) and the clean-up that ends the check. */
  const REVERT = 'guard || exit 90\ncp ~/cscb-live/config-before-reboot.json "$S/config.json"'
  const CLEANUP = 'rm -f ~/cscb-live/config-before-reboot.json ~/cscb-live/reboot-log-mark ~/cscb-live/reboot-errors-mark'

  /**
   * A live context that gets through step 8: the container sets the
   * start-at-boot marker (`echo BOOT`) and gives a `mark`; every other
   * command succeeds and prints nothing, and nothing answers in Slack, so the
   * other steps record their own findings; time is virtual. The browser's
   * revokeAppToken runs `revoke`, and records how many container scripts had
   * run by then.
   */
  function rebootRun(revoke: () => Promise<void>) {
    const clock = virtualClock()
    const session = scriptedHuman(clock)
    const { container, scripts } = fakeContainer([
      ['echo BOOT', 'BOOT'],
      ['', (script) => (script === 'mark' ? '1:0' : '')],
    ])
    const revoked: { appId: string; name: string; scriptsBefore: number }[] = []
    const browser: BrowserDriver = {
      ...idleBrowser(),
      revokeAppToken: async (appId, name) => {
        revoked.push({ appId, name, scriptsBefore: scripts.length })
        await revoke()
      },
    }
    return { ctx: makeCtx({ mode: 'real', clock, human: session.human, browser, container }), posts: session.posts, scripts, revoked }
  }

  test.each([
    [
      "a FlowError (the flow's own: Slack refused)",
      () => new FlowError(`revoke: confirm: Slack answered that it can't revoke "cscb-live"`),
      `FlowError: revoke: confirm: Slack answered that it can't revoke "cscb-live"`,
    ],
    [
      "any other error (Playwright's TimeoutError: its URL query and call log left out)",
      () =>
        new TimeoutError(
          `page.goto: Timeout 30000ms exceeded navigating to https://api.slack.com/apps/${B.appId}/general?t=${LEAK_SENTINEL}\nCall log:\n  - token ${fakeToken(APP_TOKEN_PREFIX, 'old')}`,
        ),
      `TimeoutError: page.goto: Timeout 30000ms exceeded navigating to https://api.slack.com/apps/${B.appId}/general?<query>`,
    ],
  ])('%s is a finding, not a throw: the token may still be valid, B is not asked for "rotated", and the rest of step 7 and step 8 still run', async (_what, error, described) => {
    const run = rebootRun(async () => {
      throw error()
    })
    const r = await check28.run(run.ctx)
    expect(run.revoked.map(({ appId, name }) => [appId, name])).toEqual([[B.appId, 'cscb-live']])
    expect(r.status).toBe('FAIL')
    expect((r.reason ?? '').split('; ')).toContain(`step 7: revoke failed: ${described}`)
    expect(r.notes).toContain(MAY_BE_VALID)
    expect(run.posts.filter((p) => p.text.includes(ROTATED_ASK))).toEqual([])
    // After the revocation: the rest of step 7's checks, then step 8's revert, and its clean-up last.
    const after = run.scripts.slice(run.revoked[0]!.scriptsBefore)
    expect(after).toContain('tokcount "$S"/server.log*')
    expect(after).toContain(REVERT)
    expect(after.at(-1)).toBe(CLEANUP)
    assertNoLeak(r)
  })

  test('the control: a revocation that succeeds is followed by the "rotated" ask, with no revoke finding or note', async () => {
    const run = rebootRun(async () => {})
    const r = await check28.run(run.ctx)
    expect(run.revoked.length).toBe(1)
    expect(r.reason).not.toContain('revoke failed')
    expect(r.notes).not.toContain(MAY_BE_VALID)
    expect(run.posts.filter((p) => p.text.includes(ROTATED_ASK)).map((p) => [p.channel, p.text])).toEqual([[COORD, `<@${B.userId}> ${ROTATED_ASK}`]])
    // B is silent here: that is step 7's own finding.
    expect((r.reason ?? '').split('; ')).toContain('step 7: B did not answer after the older token was revoked')
    expect(run.scripts.at(-1)).toBe(CLEANUP)
  })
})

// ---------------------------------------------------------------------------
// A start's lines: the summary's ending and the wait for every persona
// ---------------------------------------------------------------------------

describe("the start's lines: the summary's ending (Part 2.3's Expected items)", () => {
  /** checkStartLines' findings on a start logged in full: C connected, the summary ending `ending`. */
  async function findingsFor(ending: string): Promise<string[]> {
    const clock = virtualClock()
    const log = timedLog(clock, startLog(155, ending))
    log.begin()
    await clock.sleep(155 * SECOND)
    const f = new Findings()
    await checkStartLines(makeCtx({ clock, container: fakeContainer([['', (script) => log.since(script) ?? '']]).container }), f, '1:0', ['a', 'b', 'c'], true)
    return f.failures
  }

  test(`a summary ending "${START_SUMMARY_END}" is no finding, and the line is evidence`, async () => {
    expect(await findingsFor(START_SUMMARY_END)).toEqual([])
  })

  /** The clean ending's first `n` segments: an older package's ending, which stops there. */
  const endingUpTo = (n: number) => START_SUMMARY_END.split(', ').slice(0, n).join(', ')

  test.each([
    ['the ending before b.f2b, with no not-reconnected bucket', endingUpTo(2)],
    ["the ending before b.jg5 SRJ-1015, without its five counts (stopping at not reconnected)", endingUpTo(3)],
    ['a persona left running but not reconnected', startSummaryEnding({ notReconnected: 1 })],
    ['a persona not brought up', startSummaryEnding({ notBroughtUp: 1 })],
    ['a failed launch', startSummaryEnding({ failed: 1 })],
    ['ten failed launches (the ending matches whole counts only)', startSummaryEnding({ failed: 10 })],
    ['a latched persona', startSummaryEnding({ latched: 1 })],
    ['a persona left retrying', startSummaryEnding({ retrying: 1 })],
    ['a persona waiting on a live-row sequence', startSummaryEnding({ sequenceWaiting: 1 })],
    ['a persona held on invalid flags', startSummaryEnding({ held: 1 })],
    ['a persona brought up fresh as a retired key', startSummaryEnding({ freshRetired: 1 })],
  ])('%s is a finding', async (_what, ending) => {
    expect(ending).not.toBe(START_SUMMARY_END)
    expect(await findingsFor(ending)).toEqual([`the start summary does not end "${START_SUMMARY_END}"`])
  })
})

describe('the guarded restart waits for every persona to connect, not only for the summary (Part 2.3 step 3)', () => {
  /** A stop, then a start logged as `startLog(cAt)`; the record matches and nothing is pending; time is virtual. */
  function restartRun(cAt: number | null) {
    const clock = virtualClock()
    const log = timedLog(clock, startLog(cAt))
    const { container } = fakeContainer([
      [
        'claude-slack-channel-bots start',
        () => {
          log.begin()
          return ''
        },
      ],
      ['[ -e "$S/config.json.pending" ]', { code: 1 }],
      ['', (script) => (script === 'mark' ? '1:0' : (log.since(script) ?? ''))],
    ])
    return { ctx: makeCtx({ mode: 'real', clock, container }), clock }
  }

  test('a persona that connects 55 s after the summary (parked on a working row, b.f2b) is waited for: no finding', async () => {
    const run = restartRun(155)
    const at = run.clock.now()
    const f = new Findings()
    expect(await guardedRestart(run.ctx, f)).toBe('1:0')
    expect(f.failures).toEqual([])
    expect(f.evidence).toEqual([startSummary(START_SUMMARY_END)])
    expect(run.clock.now() - at).toBeGreaterThanOrEqual(155 * SECOND)
  })

  test('the control: a persona that never connects is a finding once the bring-up wait runs out', async () => {
    const f = new Findings()
    await guardedRestart(restartRun(null).ctx, f)
    expect(f.failures).toEqual(['guarded restart: the start summary or a Session connected line did not appear in time', 'no Session connected line for persona_c'])
  })
})

/** `rows`' line for a persona's row: its instance id, persona label and state. */
function rowLine(letter: PersonaLetter, state = 'idle'): string {
  return `${personaRowId(letter)} ${personaName(letter)} ${state}`
}

/** A, B and C's rows, live. */
const ROWS = (['a', 'b', 'c'] as const).map((l) => rowLine(l)).join('\n')

/**
 * A live context for Check 28 whose reboot (`restartContainer`) starts the
 * server: its lines are `startLog(cAt)`, timed from the reboot. The container
 * sets the start-at-boot marker, gives a mark (also as the saved reboot mark),
 * the rows (`rows(n)` for the n-th read, from 0: steps 1, 3 and 5; A, B and
 * C live by default) and a running server; nothing answers in Slack, so the
 * other steps record their own findings; time is virtual. `broughtUp` is the
 * personas this run brought up (`ctx.shared.broughtUp`) and `dRowKept`
 * whether Check 27 found D's row before removing D (`ctx.shared.dRowKept`);
 * each unset by default.
 */
function rebootedRun(
  cAt: number | null,
  lines: readonly (readonly [number, string])[] = startLog(cAt),
  opts: { rows?: (n: number) => string; broughtUp?: PersonaLetter[]; dRowKept?: boolean } = {},
) {
  const clock = virtualClock()
  const log = timedLog(clock, lines)
  let reads = 0
  const rowsAt = opts.rows ?? (() => ROWS)
  const { container } = fakeContainer([
    ['echo BOOT', 'BOOT'],
    ['kill -0', 'running'],
    ['', (script) => (script === 'mark' || script === 'cat ~/cscb-live/reboot-log-mark' ? '1:0' : script === 'rows' ? rowsAt(reads++) : (log.since(script) ?? ''))],
  ])
  const shared = {
    ...(opts.broughtUp === undefined ? {} : { broughtUp: opts.broughtUp }),
    ...(opts.dRowKept === undefined ? {} : { dRowKept: opts.dRowKept }),
  }
  return makeCtx({ mode: 'real', clock, human: scriptedHuman(clock).human, browser: idleBrowser(), container, shared, restartContainer: async () => log.begin() })
}

describe('Check 28 step 5: the start after the reboot waits for every persona to connect, not only for B', () => {
  /** The findings that step 5's start lines give. */
  const START_FINDING = /^step 5|Session connected line|persona-start line|last-applied record|startupSessionManager complete|start summary|start failure/

  test('C, parked on a working row (b.f2b), connects 55 s after the summary: step 5 waits for it, so its start lines give no finding', async () => {
    const r = await check28.run(rebootedRun(155))
    expect((r.reason ?? '').split('; ').filter((x) => START_FINDING.test(x))).toEqual([])
    expect(r.evidence).toContain(startSummary(START_SUMMARY_END))
    expect(r.notes).toContain(`Check 28 summary: 3 persona(s): 2 resumed, 0 fresh-spawned, 0 fresh-after-amnesia, 0 fresh-after-inconclusive-amnesia, 0 reconnected, 0 no-op, ${START_SUMMARY_END}`)
  })

  test('the control: C never connects, which is a finding', async () => {
    const r = await check28.run(rebootedRun(null))
    expect((r.reason ?? '').split('; ').filter((x) => START_FINDING.test(x))).toEqual(['no Session connected line for persona_c'])
  })

  test("A, Slack unreachable for a moment at the start (run 6), up after its bring-up retry and connected in the wait: no start finding, a note", async () => {
    const r = await check28.run(rebootedRun(null, retriedStartLog()))
    expect((r.reason ?? '').split('; ').filter((x) => START_FINDING.test(x))).toEqual([])
    expect(r.notes).toContain(RETRIED_NOTE)
    expect(r.notes).toContain(`Check 28 summary: 3 persona(s): 2 resumed, 0 fresh-spawned, 0 fresh-after-amnesia, 0 fresh-after-inconclusive-amnesia, 0 reconnected, 0 no-op, ${startSummaryEnding({ notBroughtUp: 1 })}`)
  })

  test('the control: A never comes back, which fails as before (the summary, the failure line, no Session connected line)', async () => {
    const r = await check28.run(rebootedRun(null, retriedStartLog({ up: false })))
    const findings = (r.reason ?? '').split('; ').filter((x) => START_FINDING.test(x))
    expect(findings.map((x) => x.replace(/: \[.*$/, ''))).toEqual(['no Session connected line for persona_a', `the start summary does not end "${START_SUMMARY_END}"`, 'start failure lines'])
    expect(r.notes).not.toContain(RETRIED_NOTE)
  })
})

/** Run 6's cause line, as the plan's note quotes it: the class, then the cause. */
const RETRIED_NOTE =
  'Check 28: persona_a was not brought up at the start (persona-slack-unreachable: Slack unreachable checking app_token via the Socket Mode open: WebSocket phase timed out after 10 s), ' +
  'then was up after its bring-up retry (Slack) and connected: a transient the server recovered from, accepted'

/**
 * A start from the record as in run 6: Slack is unreachable for A at the
 * start (its line timestamped, as server.log has it), so the summary counts
 * it not brought up; B and C connect before the summary. With `up`, A's
 * cause clears, A is up after its bring-up retry (Slack) and connects after
 * it (`connected`); `notBroughtUp` is the summary's count; `extra` lines are
 * added.
 */
function retriedStartLog(opts: { up?: boolean; connected?: boolean; notBroughtUp?: number; extra?: [number, string][] } = {}): [number, string][] {
  const { up = true, connected = true, notBroughtUp = 1, extra = [] } = opts
  const ref = '"persona_a" (key=persona_a)'
  const path = 'path="/home/testuser/.config/cscb/persona_a-credentials.json"'
  const session = (l: PersonaLetter) => `[slack] Session connected: persona "persona_${l}" (key=persona_${l}) cwd="/home/cscb/cscb-live/${l}"`
  const lines: [number, string][] = [
    [20, `[slack] Starting from the last-applied record "${S}/config.json.last-applied"`],
    [20, '[slack] Loaded persona config: 3 persona(s)'],
    ...(['a', 'b', 'c'] as const).map((l, i): [number, string] => [25, `[slack] persona-start: personas[${i}] "persona_${l}" (key=persona_${l}): bring-up starting`]),
    [35, `[2026-09-26T19:51:41.070Z] [slack] persona-slack-unreachable: personas[0] ${ref} ${path}: Slack unreachable checking app_token via the Socket Mode open: WebSocket phase timed out after 10 s`],
    [80, session('b')],
    [90, session('c')],
    [100, startSummary(startSummaryEnding({ notBroughtUp }))],
  ]
  if (up) {
    lines.push([105, `[2026-09-26T19:51:46.284Z] [slack] persona-slack-unreachable: personas[0] ${ref} ${path}: cleared: Slack answered after being unreachable checking app_token via the Socket Mode open`])
    lines.push([105, `[slack] persona ${ref}: up after its bring-up retry (Slack) — launching`])
    if (connected) lines.push([106, session('a')])
  }
  return [...lines, ...extra].sort((x, y) => x[0] - y[0])
}

describe("the start's lines: a persona not brought up that came up after its bring-up retry (Check 28's acceptRetried)", () => {
  /** checkStartLines' findings and notes on `lines`, 200 s after the start, with or without Check 28's acceptance. */
  async function startFindings(lines: [number, string][], accept = true): Promise<{ failures: string[]; notes: string[] }> {
    const clock = virtualClock()
    const log = timedLog(clock, lines)
    log.begin()
    await clock.sleep(200 * SECOND)
    const f = new Findings()
    const ctx = makeCtx({ clock, container: fakeContainer([['', (script) => log.since(script) ?? '']]).container })
    await checkStartLines(ctx, f, '1:0', ['a', 'b', 'c'], true, accept ? { acceptRetried: 'Check 28' } : {})
    return { failures: f.failures, notes: f.notes }
  }

  /** A failure without the log lines it quotes. */
  const short = (r: { failures: string[]; notes: string[] }) => ({ ...r, failures: r.failures.map((x) => x.replace(/: \[.*$/, '')) })

  test('accepted: the summary counts it not brought up, its Slack-unreachable lines up to the retry are the transient; a note says so', async () => {
    expect(await startFindings(retriedStartLog())).toEqual({ failures: [], notes: [RETRIED_NOTE] })
  })

  test('retriedBringUps finds the persona only with its up-after-retry line and a Session connected line after it', () => {
    const lines = (o: Parameters<typeof retriedStartLog>[0]) => retriedStartLog(o).map(([, l]) => l)
    expect(retriedBringUps(lines({}), ['a', 'b', 'c']).map((r) => [r.letter, r.via])).toEqual([['a', 'Slack']])
    expect(retriedBringUps(lines({ connected: false }), ['a', 'b', 'c'])).toEqual([])
    expect(retriedBringUps(lines({ up: false }), ['a', 'b', 'c'])).toEqual([])
    // Only a Slack retry is a transient: a directory retry after a reboot is not accepted.
    expect([retryFailureClass('Slack')?.source, retryFailureClass('directory'), retryFailureClass('credentials')]).toEqual(['\\] persona-slack-unreachable: ', null, null])
  })

  const START = [`the start summary does not end "${START_SUMMARY_END}"`, 'start failure lines']

  test.each([
    ['without the acceptance (a guarded restart)', retriedStartLog(), false, START],
    ['it never came back', retriedStartLog({ up: false }), true, ['no Session connected line for persona_a', ...START]],
    ['up after its retry, but never connected', retriedStartLog({ connected: false }), true, ['no Session connected line for persona_a', ...START]],
    ['the summary counts two not brought up, only one came back', retriedStartLog({ notBroughtUp: 2 }), true, START],
    [
      'up after a directory retry (not a transient)',
      retriedStartLog().map(([t, l]): [number, string] => [t, l.replace('bring-up retry (Slack)', 'bring-up retry (directory)')]),
      true,
      START,
    ],
  ] as const)('%s: fails as before', async (_what, lines, accept, failures) => {
    expect(short(await startFindings([...lines], accept))).toEqual({ failures: [...failures], notes: [] })
  })

  test.each([
    ['a credentials line for it', `[slack] persona-credentials-refused: personas[0] "persona_a" (key=persona_a) path="/x": Slack refused the app token`, 30],
    ['a Slack-unreachable line for it after the retry', `[slack] persona-slack-unreachable: personas[0] "persona_a" (key=persona_a) path="/x": Slack unreachable checking bot_token via auth.test: no answer within 10 s`, 150],
    ["another persona's Slack-unreachable line", `[slack] persona-slack-unreachable: personas[1] "persona_b" (key=persona_b) path="/x": Slack unreachable checking bot_token via auth.test: no answer within 10 s`, 30],
  ])('accepted, but %s is still a finding (and the note stays)', async (_what, line, at) => {
    const r = await startFindings(retriedStartLog({ extra: [[at, line]] }))
    expect(r).toEqual({ failures: [`start failure lines: ${line}`], notes: [RETRIED_NOTE] })
  })
})

// ---------------------------------------------------------------------------
// A removed persona's row: killed and kept, not live (b.jg5 SRJ-715, AC 77)
// ---------------------------------------------------------------------------

/** A row as `rows` reads it. */
function row(letter: PersonaLetter, state = 'idle'): Row {
  return { id: personaRowId(letter), persona: personaName(letter), state }
}

/**
 * src's own removal of persona D, with C kept, through the reload harness's
 * real lifecycle and launch path over its agent-director stub (`agentDirector`
 * scripts its kill): the pending preview the reload controller wrote, and the
 * server log lines from the edit on. A kill that fails waits between its
 * tries on the run's clock, which is moved until the apply settles. The run's
 * captured artifacts are leak-checked (b.av2 SR-13.2).
 */
async function realRemovalOfD(agentDirector: StubClientOptions = {}): Promise<{ preview: string[]; logs: string[] }> {
  const h = makeReloadHarness()
  try {
    const c = h.persona(personaName('c'))
    const d = h.persona(personaName('d'))
    h.materialize(c, d)
    h.writeRecord({ personas: [c, d] })
    h.writeConfig({ personas: [c, d] })
    const run = await h.startDetecting({ realLaunch: true, agentDirector })
    await run.ticks.tick()
    const cp = run.checkpoint()
    h.writeConfig({ personas: [c] })
    await run.ticks.tick()
    const preview = h.pendingLines() ?? []
    h.confirm()
    let applied = false
    const applying = run.ticks.tick().then(() => {
      applied = true
    })
    for (let i = 0; i < 10 * KILL_RETRY_TRIES && !applied; i++) await run.clock.advance(KILL_RETRY_SPACING_MS)
    await applying
    assertNoLeak(run.captured())
    return { preview, logs: run.since(cp).logs }
  } finally {
    await h.cleanup()
  }
}

/** A teardown kill that fails at every try (ErrTmuxKillFailed): the row stays live. */
const failingKill = (): StubClientOptions => ({ killQueue: Array.from({ length: KILL_RETRY_TRIES }, () => cannedErr(errTmuxKillFailed())) })

describe("a teardown's kept-row line: isTeardownKeptRowLine against src's real teardown of D", () => {
  test("a kill that succeeded: src's line is D's kept-row line (with or without a timestamp), and not C's; the preview is the one Check 27 expects", async () => {
    const { preview, logs } = await realRemovalOfD()
    const kept = logs.filter((l) => isTeardownKeptRowLine(l, 'd'))
    expect(kept.length).toBe(1)
    expect(kept[0]!.startsWith(`[slack] persona teardown of "${personaName('d')}" (key=${personaName('d')}): agent-director kill of ${personaRowId('d')}: `)).toBe(true)
    expect(isTeardownKeptRowLine(`[2026-09-26T19:51:41.070Z] ${kept[0]}`, 'd')).toBe(true)
    expect(logs.filter((l) => isTeardownKeptRowLine(l, 'c'))).toEqual([])
    expect(preview).toEqual([previewHeader({ removed: 1 }), removedPreviewLine('d')])
  })

  test("the control: a kill that failed after its tries logs src's failed-kill line, which is not one", async () => {
    const { logs } = await realRemovalOfD(failingKill())
    expect(logs.filter((l) => l.includes(`agent-director kill of ${personaRowId('d')} failed: `)).length).toBe(1)
    expect(logs.filter((l) => isTeardownKeptRowLine(l, 'd'))).toEqual([])
  })
})

describe("the row helpers: one live row per persona, a removed persona's row kept and not live", () => {
  const LIVE = (['a', 'b', 'c'] as const).map((l) => row(l))

  test('personaRowId and isNotLiveRow: the not-live states are the dead ones, every other state is live', () => {
    expect(personaRowId('d')).toBe(`cscb_${personaName('d')}`)
    for (const state of NOT_LIVE_ROW_STATES) expect(isNotLiveRow(row('d', state))).toBe(true)
    for (const state of ['idle', 'working', 'waiting', 'pending', '']) expect(isNotLiveRow(row('d', state))).toBe(false)
  })

  test.each(NOT_LIVE_ROW_STATES.map((state) => [state]))("keptRowSetProblems accepts A, B and C live and D kept %s; without a kept persona, A, B and C live", (state) => {
    expect(keptRowSetProblems([...LIVE, row('d', state)], ['a', 'b', 'c'], ['d'])).toEqual([])
    expect(keptRowSetProblems(LIVE, ['a', 'b', 'c'], [])).toEqual([])
  })

  test.each<[string, Row[], PersonaLetter[], string[]]>([
    ["D's kept row live", [...LIVE, row('d')], ['d'], ['cscb_persona_d is idle: kept but live, not ended or missing']],
    ["D's kept row missing", LIVE, ['d'], ['0 cscb_persona_d row(s), not one']],
    ['a second row for D', [...LIVE, row('d', 'ended'), row('d', 'ended')], ['d'], ['2 cscb_persona_d row(s), not one']],
    ["D's row when no persona is kept", [...LIVE, row('d', 'ended')], [], ['an unexpected row cscb_persona_d']],
    ['A not live', [row('a', 'ended'), row('b'), row('c')], [], ['cscb_persona_a is ended, not live']],
    ["A's row carrying another persona label", [{ ...row('a'), persona: personaName('b') }, row('b'), row('c')], [], ['cscb_persona_a\'s persona label is persona_b, not persona_a']],
    ['B missing', [row('a'), row('c')], [], ['0 cscb_persona_b row(s), not one']],
  ])('keptRowSetProblems rejects %s', (_what, rows, kept, problems) => {
    expect(keptRowSetProblems(rows, ['a', 'b', 'c'], kept)).toEqual(problems)
  })

  const BEFORE = [...LIVE, row('d')]

  test.each(NOT_LIVE_ROW_STATES.map((state) => [state]))("removalRowProblems accepts D's row kept %s and A, B and C unchanged, in any order", (state) => {
    expect(removalRowProblems(BEFORE, [row('d', state), ...LIVE].reverse(), 'd')).toEqual([])
  })

  test.each<[string, Row[], Row[], string[]]>([
    ["D's row still live", BEFORE, [...LIVE, row('d')], ['cscb_persona_d is idle: kept but live, not ended or missing']],
    ["D's row deleted (the expectation before SRJ-715)", BEFORE, LIVE, ['0 cscb_persona_d row(s) after the removal, not one kept row']],
    ["D's kept row carrying another persona label", BEFORE, [...LIVE, { ...row('d', 'ended'), persona: personaName('c') }], ["cscb_persona_d's persona label is persona_c, not persona_d"]],
    ['A not live after the removal', BEFORE, [row('a', 'missing'), row('b'), row('c'), row('d', 'ended')], ['cscb_persona_a is missing, not live']],
    ["B's persona label changed", BEFORE, [row('a'), { ...row('b'), persona: personaName('a') }, row('c'), row('d', 'ended')], ["cscb_persona_b's persona label changed from persona_b to persona_a"]],
    ["C's row deleted", BEFORE, [row('a'), row('b'), row('d', 'ended')], ['0 cscb_persona_c row(s) after the removal, not one']],
    ['a new row', BEFORE, [...LIVE, row('d', 'ended'), { id: 'cscb_x', persona: 'x', state: 'idle' }], ['a new row cscb_x after the removal']],
    ['no row for D before the removal', LIVE, [...LIVE, row('d', 'ended')], ['no cscb_persona_d row before the removal']],
  ])('removalRowProblems rejects %s', (_what, before, after, problems) => {
    expect(removalRowProblems(before, after, 'd')).toEqual(problems)
  })

  test.each<[string, Row[], PersonaLetter, boolean]>([
    ["D's row live among the rows before", BEFORE, 'd', true],
    ["D's row there but not live (D never connected in Check 25)", [...LIVE, row('d', 'ended')], 'd', true],
    ['no row for D', LIVE, 'd', false],
    ["another id carrying D's persona label", [...LIVE, { id: 'cscb_x', persona: personaName('d'), state: 'idle' }], 'd', false],
    ["C's removal, judged on C's row", LIVE, 'c', true],
  ])('rowKeptByRemoval: %s is %p', (_what, before, removed, kept) => {
    expect(rowKeptByRemoval(before, removed)).toBe(kept)
  })

  test.each<[boolean | undefined, PersonaLetter[]]>([
    [true, ['d']],
    [false, []],
    [undefined, []],
  ])("rebootKeptRows(%p) (Check 27's finding; unset when it never ran) is %p", (dRowKept, kept) => {
    expect(rebootKeptRows(dRowKept)).toEqual(kept)
  })
})

describe("Check 27: D's row is killed and kept, judged after a guarded find-missing", () => {
  const FIND_MISSING = 'guard || exit 90\nagent-director find-missing'
  const COMPLETE_D = `since '1:0' | grep -F -- '[slack] persona teardown of "${personaName('d')}" (key=${personaName('d')}): complete'`

  /**
   * A live context for Check 27 over `real` (src's removal of D,
   * `realRemovalOfD`): the pending file holds its preview, and server.log
   * its lines (its reload-applied line written for the container's state
   * directory). Rows: A, B, C and D live; D's row is `missing` once
   * find-missing has run (its agent process is gone), or no longer there
   * with `deleted`; never there with `withoutD`. `findMissing` is the
   * guarded find-missing's answer.
   * The first mark is the log's start (`1:0`), every later one its end, so
   * nothing is logged after them. Nothing answers in Slack; time is virtual.
   */
  function removalRun(real: { preview: string[]; logs: string[] }, opts: { findMissing?: Partial<ProcResult>; deleted?: boolean; withoutD?: boolean } = {}) {
    const clock = virtualClock()
    const { findMissing = { stdout: `${personaRowId('d')}: missing` }, deleted = false, withoutD = false } = opts
    let marked = false
    let marks = 0
    const log = [...real.logs.filter((l) => !l.startsWith('[slack] reload-applied:')), appliedLine({ removed: 1 })]
    const pending = [PENDING_FILE_HEADER, `fingerprint: sha256:${'0'.repeat(64)}`, '', ...real.preview].join('\n')
    const dRow = () => (withoutD || (marked && deleted) ? [] : [rowLine('d', marked ? 'missing' : 'idle')])
    const rowsNow = () => [...(['a', 'b', 'c'] as const).map((l) => rowLine(l)), ...dRow()].join('\n')
    const { container, scripts } = fakeContainer([
      [
        'agent-director find-missing',
        () => {
          marked = (findMissing.code ?? 0) === 0
          return findMissing
        },
      ],
      ['showpending', pending],
      ['[ -e "$S/config.json.', { code: 1 }],
      [
        '',
        (script) => {
          if (script === 'mark') return `1:${marks++ === 0 ? 0 : log.length}`
          if (script === 'rows') return rowsNow()
          if (script.startsWith('cat "$S/server.pid"')) return '4242'
          if (script.startsWith("jq -r '.personas[].name'")) return (['a', 'b', 'c'] as const).map(personaName).join('\n')
          return sinceOver(script, log.slice(Number(/^since '1:(\d+)'/.exec(script)?.[1] ?? 0))) ?? ''
        },
      ],
    ])
    const ctx = makeCtx({ mode: 'real', clock, human: scriptedHuman(clock).human, browser: idleBrowser(), container })
    return { ctx, scripts }
  }

  /** The findings that are not Slack's silence (A's recall is the only Slack finding a silent workspace gives here). */
  const findingsOf = (r: CheckResult) => (r.reason ?? '').split('; ').filter((x) => x !== '' && x !== 'A did not recall quillfeather')

  test("D's kept row, not live once find-missing ran, and src's kill line: no finding; find-missing runs behind the guard after the teardown and before the rows are read", async () => {
    const run = removalRun(await realRemovalOfD())
    const r = await check27.run(run.ctx)
    expect(findingsOf(r)).toEqual([])
    expect(run.scripts.filter((s) => s.includes('find-missing'))).toEqual([FIND_MISSING])
    const at = run.scripts.indexOf(FIND_MISSING)
    expect(run.scripts.indexOf(COMPLETE_D)).toBeGreaterThan(-1)
    expect(run.scripts.indexOf(COMPLETE_D)).toBeLessThan(at)
    expect(run.scripts.lastIndexOf('rows')).toBeGreaterThan(at)
    expect(r.evidence).toContain(`rows after: ${[...(['a', 'b', 'c'] as const).map((l) => `${personaRowId(l)}(idle)`), `${personaRowId('d')}(missing)`].join(', ')}`)
    // D's row was there before the removal: Check 28 expects it kept.
    expect(run.ctx.shared.dRowKept).toBe(true)
  })

  test("no row for D before the removal: a finding, and Check 28 is told to expect no row for D", async () => {
    const run = removalRun(await realRemovalOfD(), { withoutD: true })
    const r = await check27.run(run.ctx)
    expect(findingsOf(r)).toContain('rows after the removal: no cscb_persona_d row before the removal')
    expect(run.ctx.shared.dRowKept).toBe(false)
  })

  test("the control: find-missing refused by the guard leaves D's row live, which is a finding", async () => {
    const r = await check27.run(removalRun(await realRemovalOfD(), { findMissing: { code: 90 } }).ctx)
    expect(findingsOf(r)).toEqual(['agent-director find-missing did not run (exit 90)', 'rows after the removal: cscb_persona_d is idle: kept but live, not ended or missing'])
  })

  test("the control: D's row deleted (the expectation before SRJ-715) is a finding", async () => {
    const r = await check27.run(removalRun(await realRemovalOfD(), { deleted: true }).ctx)
    expect(findingsOf(r)).toEqual([
      'rows after the removal: cscb_persona_a, cscb_persona_b, cscb_persona_c',
      'rows after the removal: 0 cscb_persona_d row(s) after the removal, not one kept row',
    ])
  })

  test("the control: src's lines for a kill that failed after its tries give no kept-row line, which is a finding", async () => {
    const r = await check27.run(removalRun(await realRemovalOfD(failingKill())).ctx)
    expect(findingsOf(r)).toEqual(['no clean teardown complete line for D', "not one teardown line for D's kill that succeeded, its row kept (b.jg5 SRJ-715)"])
  })
})

describe("Check 28: one live row per persona at steps 1, 3 and 5, plus D's kept row when Check 27 found D's row", () => {
  /** Check 28's row findings (steps 1, 3 and 5). */
  const ROW_FINDING = /^step [135]: (not one|the rows changed)/
  const rowFindings = (r: CheckResult) => (r.reason ?? '').split('; ').filter((x) => ROW_FINDING.test(x))
  const withD = (state: string) => `${ROWS}\n${rowLine('d', state)}`

  test.each(NOT_LIVE_ROW_STATES.map((state) => [state]))("D's row kept %s at every step, Check 27 having found it: no row finding", async (state) => {
    const r = await check28.run(rebootedRun(155, undefined, { rows: () => withD(state), dRowKept: true }))
    expect(rowFindings(r)).toEqual([])
    expect(r.evidence).toContain(`rows before: ${[...(['a', 'b', 'c'] as const).map((l) => `${personaRowId(l)}(idle)`), `${personaRowId('d')}(${state})`].join(', ')}`)
  })

  test("D's row kept, Check 27 having found it, though D never connected in Check 25 (not among the personas brought up): no row finding", async () => {
    const r = await check28.run(rebootedRun(155, undefined, { rows: () => withD('ended'), broughtUp: ['a', 'b', 'c'], dRowKept: true }))
    expect(rowFindings(r)).toEqual([])
  })

  test("the control: D's kept row live is a finding at each step", async () => {
    const r = await check28.run(rebootedRun(155, undefined, { rows: () => withD('idle'), dRowKept: true }))
    const live = 'cscb_persona_d is idle: kept but live, not ended or missing'
    expect(rowFindings(r)).toEqual([
      `step 1: not one live row per persona plus D's kept row: ${live}`,
      `step 3: the rows changed: ${live}`,
      `step 5: not one row per persona plus D's kept row: ${live}`,
    ])
  })

  test.each<[string, boolean | undefined]>([
    ['Check 27 found no row for D', false],
    ['Check 27 never ran (unset)', undefined],
  ])('the control: a row for D when %s is a finding at each step', async (_what, dRowKept) => {
    const r = await check28.run(rebootedRun(155, undefined, { rows: () => withD('ended'), ...(dRowKept === undefined ? {} : { dRowKept }) }))
    expect(rowFindings(r)).toEqual([
      'step 1: not one live row per persona: an unexpected row cscb_persona_d',
      'step 3: the rows changed: an unexpected row cscb_persona_d',
      'step 5: not one row per persona: an unexpected row cscb_persona_d',
    ])
  })

  test("the control: D's kept row gone at step 3 (before the reboot) is a finding there, and again at step 5", async () => {
    const r = await check28.run(rebootedRun(155, undefined, { rows: (n) => (n === 0 ? withD('ended') : ROWS), dRowKept: true }))
    expect(rowFindings(r)).toEqual([
      'step 3: the rows changed: cscb_persona_a, cscb_persona_b, cscb_persona_c',
      'step 3: the rows changed: 0 cscb_persona_d row(s), not one',
      "step 5: not one row per persona plus D's kept row: 0 cscb_persona_d row(s), not one",
    ])
  })
})

describe('no live check passes against a silent workspace', () => {
  // A gesture that only undoes its setup passes when the setup never ran: nothing to restore.
  // Check 34 undoes what Check 30 did (b.deo SRI-1506).
  const UNDO_GESTURES = ['24-teardown', '34']
  const live = PLAN_CHECKS.filter((c) => c.needs.includes('workspace') && !c.skip && !UNDO_GESTURES.includes(c.id))

  /**
   * Posts get a ts; history and replies are empty; every container command
   * succeeds and prints nothing, except `mark`, so a check gets past its
   * starting mark; time is virtual.
   */
  function silentCtx(): CheckContext {
    const clock = virtualClock()
    return makeCtx({
      mode: 'real',
      clock,
      human: scriptedHuman(clock).human,
      second: { human: scriptedHuman(clock).human, userId: 'U0DRYSECND' },
      browser: idleBrowser(),
      container: fakeContainer([['', (script) => (script === 'mark' ? '1:0' : '')]]).container,
    })
  }

  test.each(live.map((c) => [c.id, c] as const))('Check %s does not PASS (a throw counts as a FAIL)', async (_id, c) => {
    const all = new Set<Need>(['workspace', 'claude', 'second-user'])
    const [r] = await runChecks([c], silentCtx(), { available: all, only: [], now: () => 0, log: { info: () => {} } })
    expect(r!.status).not.toBe('PASS')
    assertNoLeak(r)
  })

  test.each(['16', '20'])('Check %s FAILs outright: A never says done, so it is asked once and not again', async (id) => {
    const r = await PLAN_CHECKS.find((c) => c.id === id)!.run(silentCtx())
    expect([r.status, r.reason]).toEqual(['FAIL', 'A did not say done and made no reply-tool call to U0DRYSECND'])
  })

  test('the undo gestures left out pass only with nothing to restore', async () => {
    for (const id of UNDO_GESTURES) {
      const r = await PLAN_CHECKS.find((c) => c.id === id)!.run(silentCtx())
      expect([id, r.status, r.evidence]).toEqual([id, 'PASS', ['nothing to restore: the setup did not run']])
    }
  })
})

// ---------------------------------------------------------------------------
// Check 30's switch-on edit, and the switch absent before it (b.deo SRI-1501, SRI-1507)
// ---------------------------------------------------------------------------

/** `config` edited by the jq `filter`, as `editConfig` runs it in the container: jq over the file, its output the new file. */
function jqEdit(home: string, config: unknown, filter: string): string {
  const file = join(home, 'config.json')
  writeFileSync(file, renderConfig(config))
  const r = Bun.spawnSync([Bun.which('jq')!, filter, file], { env: hostSafeChildEnv(home, { tools: ['jq'] }) })
  expect(r.stderr.toString()).toBe('')
  expect(r.exitCode).toBe(0)
  return r.stdout.toString()
}

/** A configuration as the package loads it from the container's state directory. */
function loadLive(text: string) {
  return parsePersonaConfigBytes(text, `${S}/config.json`, S, { home: '/home/testuser' })
}

/** config.json after setup and Check 1 (where `--only 30,31,32,33,34` starts). */
const SETUP_STATE = () => buildLiveConfig(DRY_RUN_IDS)

/** config.json after Part 9 and Check 28: A's DMs on from Part 7, with no dm.contact; D's entry only when its removal did not happen. */
function part9State(withD: boolean) {
  const config = buildLiveConfig(DRY_RUN_IDS)
  config.personas[0]!.dm = { enabled: true }
  if (withD) config.personas.push(personaEntryFor('d', DRY_RUN_IDS))
  return config
}

const STARTING_STATES = [
  ['setup and Check 1 (the targeted run)', SETUP_STATE],
  ['Part 9, A, B and C', () => part9State(false)],
  ["Part 9, with D's entry still declared", () => part9State(true)],
] as const

describe("Check 30's switch-on edit (switchOnFilter), from each starting state", () => {
  let home = ''
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ci-live-switch-on-'))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  test.each(STARTING_STATES)('from %s: loads in fungible mode, every persona has invited.permission_prompts, each destination is unchanged, and nothing else changed', (_what, state) => {
    const input = state()
    const edited = jqEdit(home, input, switchOnFilter(DRY_RUN_IDS))
    const before = loadLive(renderConfig(input))
    const after = loadLive(edited)
    expect([channelModeOf(before), channelModeOf(after)]).toEqual(['declarative', 'fungible'])
    const json = JSON.parse(edited) as Record<string, unknown> & { personas: Record<string, unknown>[] }
    expect(json.personas.map((p) => typeof (p[INVITED_KEY] as Record<string, unknown> | undefined)?.[INVITED_PERMISSION_PROMPTS_KEY])).toEqual(input.personas.map(() => 'string'))
    // T1's one destination rule, from the configuration in effect before and after.
    expect(after.personas.map((p) => [p.key, personaDestinationOf(after, p)])).toEqual(before.personas.map((p) => [p.key, personaDestinationOf(before, p)]))
    // The only differences: the switch and the invited sections.
    const { [SWITCH_KEY]: switchValue, ...rest } = json
    expect(switchValue).toBe(true)
    expect({ ...rest, personas: json.personas.map(({ [INVITED_KEY]: _invited, ...p }) => p) }).toEqual(JSON.parse(renderConfig(input)))
  })

  test("the positive control: in Part 9's state, A with \"dm\" (DMs on, no dm.contact) is refused by the same load", () => {
    const filter = `${switchOnFilter(DRY_RUN_IDS)} | (.personas[] | select(.name == ${JSON.stringify(personaName('a'))})).${INVITED_KEY}.${INVITED_PERMISSION_PROMPTS_KEY} = ${JSON.stringify(DM_DESTINATION)}`
    const refused = new RegExp(`${INVITED_KEY}\\.${INVITED_PERMISSION_PROMPTS_KEY}`)
    const edited = jqEdit(home, part9State(false), filter)
    expect(() => loadLive(edited)).toThrow(refused)
    // The same edit from the setup state (A's DMs off) is refused too: "dm" is valid for neither.
    expect(() => loadLive(jqEdit(home, SETUP_STATE(), filter))).toThrow(refused)
  })

  test('the switch-only edits of Checks 32 and 33 change the switch alone', () => {
    const on = jqEdit(home, part9State(false), switchOnFilter(DRY_RUN_IDS))
    const off = jqEdit(home, JSON.parse(on), switchFilter(false))
    expect(JSON.parse(off)).toEqual({ ...JSON.parse(on), [SWITCH_KEY]: false })
    expect(channelModeOf(loadLive(off))).toBe('declarative')
    expect(JSON.parse(jqEdit(home, JSON.parse(off), switchFilter(true)))).toEqual(JSON.parse(on))
  })
})

describe('the switch is absent before Check 30 (b.deo SRI-1507)', () => {
  test('the configuration setup writes, and D\'s entry, carry no switch and no invited section', () => {
    const config = buildLiveConfig(DRY_RUN_IDS) as unknown as Record<string, unknown>
    expect(Object.keys(config)).not.toContain(SWITCH_KEY)
    for (const p of [...buildLiveConfig(DRY_RUN_IDS).personas, personaEntryFor('d', DRY_RUN_IDS)]) expect(Object.keys(p)).not.toContain(INVITED_KEY)
  })

  test("source audit: the switch's key is spelled only in live-config.ts's constant, and only invited-checks.ts uses the switch's names", () => {
    const root = join(import.meta.dir, '..', 'ci-live')
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts') && !f.split('/').includes('node_modules'))
    expect(files.length).toBeGreaterThan(20)
    const code = new Map(files.map((f) => [f, stripComments(readFileSync(join(root, f), 'utf-8'))]))
    const spelled = [...code].filter(([, c]) => c.includes(SWITCH_KEY))
    expect(spelled.map(([f]) => f)).toEqual(['lib/live-config.ts'])
    expect(spelled[0]![1].split(SWITCH_KEY).length - 1).toBe(1)
    const names = /\b(SWITCH_KEY|SWITCH_VALUE_JQ|switchOnFilter|switchFilter)\b/
    expect([...code].filter(([, c]) => names.test(c)).map(([f]) => f).sort()).toEqual(['checks/invited-checks.ts', 'lib/live-config.ts'])
  })
})

// ---------------------------------------------------------------------------
// The test human's channel gestures (b.deo SRI-1502, SRI-1505, SRI-1506)
// ---------------------------------------------------------------------------

describe("the test human's createChannel, kick and archive", () => {
  /** A session whose Slack answers every call with `answer`; `sent` records each call's method and parameters. */
  function answering(answer: Record<string, unknown>) {
    const sent: [string, Record<string, unknown>][] = []
    const api: HumanApi = {
      call: async (method, params = {}) => {
        sent.push([method, { ...params }])
        return { ok: true, ...answer } as never
      },
    }
    return { human: new HumanSession(api, virtualClock()), sent }
  }

  /** Each gesture: how it is called, the Slack method and parameters it sends, what it returns, and the code it accepts as done. */
  const GESTURES = [
    ['createChannel', (h: HumanSession) => h.createChannel('cscb-live-invited-1700000000'), 'conversations.create', { name: 'cscb-live-invited-1700000000', is_private: false }, 'C0RUNCH001', null],
    ['kick', (h: HumanSession) => h.kick('C0RUNCH001', 'U0DRYBOTC0'), 'conversations.kick', { channel: 'C0RUNCH001', user: 'U0DRYBOTC0' }, undefined, 'not_in_channel'],
    ['archive', (h: HumanSession) => h.archive('C0RUNCH001'), 'conversations.archive', { channel: 'C0RUNCH001' }, undefined, 'already_archived'],
    // No exclude_archived: Slack's default (false) lists archived channels too, as Check 34 and provisioning need.
    [
      'conversationsOf',
      (h: HumanSession) => h.conversationsOf('U0DRYBOTC0'),
      'users.conversations',
      { user: 'U0DRYBOTC0', types: 'public_channel,private_channel', limit: 200 },
      ['C0RUNCH001', 'C0OLDRUN01'],
      null,
    ],
  ] as const

  test.each(GESTURES)('%s sends exactly its Slack method and parameters, and returns only what it should', async (_name, call, method, params, result) => {
    const { human, sent } = answering({
      channel: { id: 'C0RUNCH001', name: 'cscb-live-invited-1700000000', created: 1700000000, creator: 'U0DRYHUMAN' },
      channels: [{ id: 'C0RUNCH001', name: 'cscb-live-invited-1700000000' }, { id: 'C0OLDRUN01', is_archived: true }, { name: 'no id' }],
    })
    expect<unknown>(await call(human)).toEqual(result)
    expect(sent).toEqual([[method, params]])
  })

  test.each(GESTURES)('%s: a refusal is a HumanCallError naming only the method and a safe code, never the token in the answer', async (_name, call, method) => {
    for (const [error, code] of [['restricted_action', 'restricted_action'], [fakeToken(BOT_TOKEN_PREFIX, 'refusal'), 'unknown_error']] as const) {
      const { human } = answering({ ok: false, error, detail: fakeToken(BOT_TOKEN_PREFIX, 'detail') })
      const err = await call(human).then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(HumanCallError)
      expect([(err as HumanCallError).method, (err as HumanCallError).code, (err as Error).message]).toEqual([method, code, `${method} failed: ${code}`])
      assertNoLeak(err)
    }
  })

  test.each(GESTURES.filter(([, , , , , harmless]) => harmless !== null))('%s accepts its one harmless code as already done, and throws every other code', async (_name, call, method, _params, _result, harmless) => {
    expect(await call(answering({ ok: false, error: harmless }).human)).toBeUndefined()
    for (const code of ['channel_not_found', 'is_archived', 'cant_kick_self', 'not_in_channel', 'already_archived'].filter((c) => c !== harmless)) {
      await expect(call(answering({ ok: false, error: code }).human)).rejects.toThrow(`${method} failed: ${code}`)
    }
  })

  test.each([
    ['no channel', {}],
    ['a channel with no ID', { channel: { name: 'cscb-live-invited-1700000000' } }],
    ['a private channel (G…) ID', { channel: { id: 'G0RUNCH001' } }],
    ['a DM ID', { channel: { id: 'D0RUNCH001' } }],
    ['a lowercase ID', { channel: { id: 'c0runch001' } }],
  ])('createChannel refuses an answer with %s (no_channel_id)', async (_what, answer) => {
    await expect(answering(answer).human.createChannel('cscb-live-invited-1700000000')).rejects.toThrow('conversations.create failed: no_channel_id')
  })

})

// ---------------------------------------------------------------------------
// Part 11 against a scripted container: the server's reload files and log
// ---------------------------------------------------------------------------

/** The package's change plan from `record` to `config` (both config.json texts), as the server builds it in the container. */
function srcPlan(record: string, config: string) {
  const plan = buildChangePlan(loadLive(record), { kind: 'valid', config: loadLive(config) }, { realPath: (p) => p, home: '/home/testuser', dryRun: true })
  if (!plan.valid) throw new Error('the scripted config is invalid')
  return plan
}

/**
 * The container's reload files, kept by a scripted server that writes
 * config.json.pending with the package's own preview whenever config.json
 * differs from the record (logging `reload-nothing-pending` when a pending
 * file goes because they match again), and applies a confirmation as the
 * package does, logging the package's `reload-applied` or `reload-noop` line.
 * `copy` is Check 30's copy of config.json (null once removed).
 */
interface ReloadWorld {
  config: string
  record: string
  copy: string | null
  pending: boolean
  log: string[]
}

/**
 * A container over `world`: the guard passes; `mark` is the log's end;
 * `since`, `showpending`, the `cmp` and existence tests, the guarded copy,
 * rename and removal act on `world`; a jq read, and the guarded jq edit of
 * config.json (`editConfig`), run for real, by bash with jq, over `world`'s
 * files written into `home` (the container's layout). `answers` are answered
 * first. `scripts` is every script run.
 */
function reloadContainer(home: string, world: ReloadWorld, answers: ReadonlyArray<readonly [string, Reply]> = []) {
  const state = join(home, '.claude', 'channels', 'slack')
  const copyFile = join(home, CONFIG_COPY.replace(/^~\//, ''))
  const files: Record<string, () => string | null> = {
    [CONFIG_COPY]: () => world.copy,
    '"$S/config.json.last-applied"': () => world.record,
    '"$S/config.json"': () => world.config,
  }
  const same = (a: string | null, b: string | null) => a !== null && a === b
  const settle = () => {
    if (world.config !== world.record) {
      world.pending = true
      return
    }
    if (world.pending) world.log.push(`[slack] ${RELOAD_NOTHING_PENDING}: no change is pending`)
    world.pending = false
  }
  const realJq = (script: string): ProcResult => {
    mkdirSync(state, { recursive: true })
    mkdirSync(join(home, 'cscb-live'), { recursive: true })
    writeFileSync(join(state, 'config.json'), world.config)
    writeFileSync(join(state, 'config.json.last-applied'), world.record)
    if (world.copy !== null) writeFileSync(copyFile, world.copy)
    else rmSync(copyFile, { force: true })
    const r = Bun.spawnSync([Bun.which('bash')!, '-c', `S=${q(state)}\n${script}`], { env: hostSafeChildEnv(home, { tools: ['bash', 'jq', 'mv'] }) })
    world.config = readFileSync(join(state, 'config.json'), 'utf-8')
    return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString(), timedOut: false }
  }
  return fakeContainer([
    ...answers,
    [
      '',
      (script): Partial<ProcResult> | string => {
        if (script === 'mark') return `1:${world.log.length}`
        const since = /^since '1:(\d+)'/.exec(script)
        if (since) return sinceOver(script, world.log.slice(Number(since[1]))) ?? ''
        if (script === 'guard || exit 90\ntrue') return ''
        if (script.startsWith('jq ')) return realJq(script)
        if (script.startsWith('guard || exit 90\njq ')) {
          const r = realJq(script.slice('guard || exit 90\n'.length))
          settle()
          return r
        }
        if (script === 'showpending') {
          if (!world.pending) return { code: 1, stdout: 'config.json.pending does not exist' }
          return [PENDING_FILE_HEADER, `fingerprint: sha256:${'0'.repeat(64)}`, '', ...renderPreviewLines(srcPlan(world.record, world.config)), ''].join('\n')
        }
        const cmp = /^cmp -s (\S+|"[^"]*") (\S+|"[^"]*")$/.exec(script)
        if (cmp) return { code: same(files[cmp[1]!]?.() ?? null, files[cmp[2]!]?.() ?? null) ? 0 : 1 }
        if (script === '[ -e "$S/config.json.pending" ]') return { code: world.pending ? 0 : 1 }
        if (script === `guard || exit 90\ncp ${CONFIG_COPY} "$S/config.json"`) {
          if (world.copy === null) return { code: 1 }
          world.config = world.copy
          settle()
          return ''
        }
        if (script === 'guard || exit 90\nmv "$S/config.json.pending" "$S/config.json.apply"') {
          if (!world.pending) return { code: 1 }
          const plan = srcPlan(world.record, world.config)
          const recordPath = `${S}/config.json.last-applied`
          world.log.push(plan.noEffectiveChange ? renderNoopLogLine(recordPath) : renderAppliedLogLine(plan, recordPath))
          world.record = world.config
          world.pending = false
          return ''
        }
        if (script === `guard || exit 90\nrm -f ${CONFIG_COPY}`) {
          world.copy = null
          return ''
        }
        throw new Error(`unscripted container command: ${script}`)
      },
    ],
  ])
}

/** The container commands in `scripts` that copy, move or remove a file without running behind the guard first. */
function unguardedChanges(scripts: readonly string[]): string[] {
  return scripts.filter((x) => /\b(cp|mv|rm)\b/.test(x) && !/^guard (\|\||&&) /.test(x))
}

/** C's bot user, and the run channel Check 30 created. */
const C_USER = DRY_RUN_IDS.bots.c.userId
/** C's name and key, as src/'s builders take a persona. */
const C_PERSONA = { name: personaName('c'), key: personaName('c') }
const RUN_CHANNEL = { id: 'C0RUNCH001', name: runChannelName('1700000000') }

/** Part 11's checks raise no permission prompt: a run declared none to the guard and asked it to deny none. */
function expectNoPromptDeclared(guard: ReturnType<typeof recordingGuard>): void {
  expect([guard.expected, guard.sweeps]).toEqual([[], 0])
}

describe('Check 34: restores the config and the channel, and leaves C in no channel, archived ones included (b.deo SRI-1506)', () => {
  let home = ''
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ci-live-check34-'))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  /** The copy (config.json as Check 30 found it) and the configurations Checks 30–33 leave, as jq writes them. */
  function states() {
    const copy = renderConfig(part9State(false))
    const on = jqEdit(home, JSON.parse(copy), switchOnFilter(DRY_RUN_IDS))
    const off = jqEdit(home, JSON.parse(on), switchFilter(false))
    return { copy, on, off }
  }

  /**
   * Check 34 over the seeded state: `world` (the config half, when given)
   * and the run channel (when `channel` is given: C a member or not, the
   * channel archived or not), plus any `others` channel C is in. The
   * container answers `answers` first.
   */
  async function check34Run(opts: {
    world?: ReloadWorld
    channel?: { cMember: boolean; archived?: boolean }
    others?: ScriptedChannel[]
    answers?: ReadonlyArray<readonly [string, Reply]>
  }) {
    const clock = virtualClock()
    const seed: ScriptedChannel[] = [...(opts.others ?? [])]
    if (opts.channel) {
      seed.push({ ...RUN_CHANNEL, archived: opts.channel.archived ?? false, members: new Set([DRY_RUN_IDS.humanUserId, ...(opts.channel.cMember ? [C_USER] : [])]) })
    }
    const slack = scriptedHuman(clock, {}, seed)
    const world = opts.world ?? { config: '', record: '', copy: null, pending: false, log: [] }
    const { container, scripts } = reloadContainer(home, world, opts.answers)
    const shared: CheckContext['shared'] = {
      ...(opts.world ? { invitedConfigCopy: CONFIG_COPY } : {}),
      ...(opts.channel ? { invitedChannel: RUN_CHANNEL } : {}),
    }
    const guard = recordingGuard()
    const ctx = makeCtx({ mode: 'real', clock, human: slack.human, container, shared, promptGuard: guard })
    const r = await check34.run(ctx)
    assertNoLeak(r)
    return { r, world, slack, scripts, shared: ctx.shared, guard }
  }

  /** The config half's end state: config.json and the record are the copy, nothing pending, the copy removed. */
  function expectRestored(run: Awaited<ReturnType<typeof check34Run>>, copy: string) {
    expect([run.world.config, run.world.record, run.world.pending, run.world.copy]).toEqual([copy, copy, false, null])
    expect(run.shared.invitedConfigCopy).toBeUndefined()
  }

  const KICK = `conversations.kick ${RUN_CHANNEL.id}`
  const ARCHIVE = `conversations.archive ${RUN_CHANNEL.id}`

  test.each([
    ['after Check 30, 31 or 33: the switch on', 'on', RELOAD_APPLIED],
    ['after Check 32 (Check 33 did not switch it on): the switch off, invited kept', 'off', RELOAD_NOOP],
  ] as const)('the config change only, %s: the copy is restored with the preview and apply outcome that state calls for, nothing pending; no channel gesture', async (_what, at, outcome) => {
    const s = states()
    const run = await check34Run({ world: { config: s[at], record: s[at], copy: s.copy, pending: false, log: [] } })
    expect([run.r.status, run.r.reason]).toEqual(['PASS', undefined])
    expectRestored(run, s.copy)
    const outcomeLines = run.world.log.filter((l) => l.includes(`] ${outcome}: `))
    expect(outcomeLines.length).toBe(1)
    // The runner's expected preview is the package's, for this state.
    const expected = restorePreview(
      { on: false, personas: JSON.parse(s.copy).personas.map((p: { name: string }) => ({ name: p.name, invited: 'null' })) },
      { on: at === 'on', personas: JSON.parse(s[at]).personas.map((p: { name: string; invited: unknown }) => ({ name: p.name, invited: JSON.stringify(p.invited) })) },
    )
    expect(expected.preview).toEqual(renderPreviewLines(srcPlan(s[at], s.copy)))
    expect(outcomeLines[0]).toBe(expected.outcome)
    expect(run.slack.calls.filter((c) => c.startsWith('conversations.'))).toEqual([])
  })

  test.each([
    ['with the edit pending (config.json edited, the record still the copy)', true],
    ['with nothing written (config.json still the copy)', false],
  ] as const)('the edit never confirmed, %s: the restore leaves nothing pending, with one reload-nothing-pending line only when a change was pending', async (_what, edited) => {
    const s = states()
    const run = await check34Run({ world: { config: edited ? s.on : s.copy, record: s.copy, copy: s.copy, pending: edited, log: [] } })
    expect([run.r.status, run.r.reason]).toEqual(['PASS', undefined])
    expectRestored(run, s.copy)
    expect(run.world.log.filter((l) => l.includes(`] ${NOTHING_PENDING_CLASS}: `)).length).toBe(edited ? 1 : 0)
    expect(run.world.log.filter((l) => l.includes(`] ${RELOAD_APPLIED}: `) || l.includes(`] ${RELOAD_NOOP}: `))).toEqual([])
    expect(run.scripts.filter((x) => x.includes('config.json.apply'))).toEqual([])
  })

  test.each([
    ["C's app still a member: kicked, then the channel archived", true, [KICK, ARCHIVE]],
    ["C's app already kicked (Check 33): only archived", false, [ARCHIVE]],
  ] as const)('the channel only, %s; no container command', async (_what, cMember, gestures) => {
    const run = await check34Run({ channel: { cMember } })
    expect([run.r.status, run.r.reason]).toEqual(['PASS', undefined])
    expect(run.slack.calls.filter((c) => c === KICK || c === ARCHIVE)).toEqual([...gestures])
    expect(run.slack.channels.get(RUN_CHANNEL.id)!.archived).toBe(true)
    expect(run.scripts).toEqual([])
    expect(run.r.evidence.at(-1)).toBe('C is in 0 channel(s), archived ones included')
  })

  test('both: the config restored and the channel kicked before it is archived', async () => {
    const s = states()
    const run = await check34Run({ world: { config: s.on, record: s.on, copy: s.copy, pending: false, log: [] }, channel: { cMember: true } })
    expect([run.r.status, run.r.reason]).toEqual(['PASS', undefined])
    expectRestored(run, s.copy)
    const kick = run.slack.calls.indexOf(KICK)
    expect(kick).toBeGreaterThan(-1)
    expect(run.slack.calls.indexOf(ARCHIVE)).toBeGreaterThan(kick)
    expect(unguardedChanges(run.scripts)).toEqual([])
    expectNoPromptDeclared(run.guard)
  })

  test("a container command of the config half throws: the channel is still kicked and archived, and the reason names the config half's throw", async () => {
    const s = states()
    const run = await check34Run({
      world: { config: s.on, record: s.on, copy: s.copy, pending: false, log: [] },
      channel: { cMember: true },
      answers: [
        [
          'jq -c',
          () => {
            throw new Error('the container went away')
          },
        ],
      ],
    })
    expect([run.r.status, run.r.reason]).toEqual(['FAIL', 'config: threw Error: the container went away'])
    expect(run.slack.calls.filter((c) => c === KICK || c === ARCHIVE)).toEqual([KICK, ARCHIVE])
    expect(run.slack.channels.get(RUN_CHANNEL.id)!.archived).toBe(true)
    expect(run.shared.invitedConfigCopy).toBe(CONFIG_COPY)
  })

  /**
   * A pending file the server writes: the fingerprint line (`digit` 64
   * times) and the package's preview of `plan`.
   */
  const pendingText = (digit: string, plan: ReturnType<typeof srcPlan>) =>
    [PENDING_FILE_HEADER, `fingerprint: sha256:${digit.repeat(64)}`, '', ...renderPreviewLines(plan), ''].join('\n')

  /**
   * An earlier edit (to the switch off) left pending over a record with the
   * switch on. `staleReads` is how many times `showpending` still shows the
   * earlier file once the restore has written config.json (the server's tick
   * not come yet; null: never rewritten); from then on it shows the
   * restore's own file, with a new fingerprint.
   */
  function staleWorld(staleReads: number | null) {
    const s = states()
    const world: ReloadWorld = { config: s.off, record: s.on, copy: s.copy, pending: true, log: [] }
    let reads = 0
    const showpending = (): Partial<ProcResult> | string => {
      if (!world.pending) return { code: 1, stdout: 'config.json.pending does not exist' }
      const restored = world.config === s.copy
      if (!restored || staleReads === null || reads++ < staleReads) return pendingText('a', srcPlan(world.record, s.off))
      return pendingText('b', srcPlan(world.record, world.config))
    }
    return { s, world, answers: [['showpending', showpending]] as const }
  }

  test('a pending file already there (an earlier edit): the restore waits for its own file, a new fingerprint, before it reads the preview and confirms', async () => {
    const { s, world, answers } = staleWorld(2)
    const run = await check34Run({ world, answers })
    expect([run.r.status, run.r.reason]).toEqual(['PASS', undefined])
    expectRestored(run, s.copy)
    expect(run.world.log.filter((l) => l.includes(`] ${RELOAD_APPLIED}: `)).length).toBe(1)
  })

  test('a pending file already there that the server never rewrites for the restore: a FAIL, and the earlier file is never confirmed', async () => {
    const { world, answers } = staleWorld(null)
    const run = await check34Run({ world, answers })
    expect(run.r.status).toBe('FAIL')
    expect(run.r.reason).toStartWith('config: config.json.pending was not rewritten for the restore (it kept the earlier fingerprint) (or held token-shaped text)')
    expect(run.scripts.filter((x) => x.includes('config.json.apply'))).toEqual([])
  })

  test('a pending file already there while config.json already holds the copy: that file is the restore\'s, read and confirmed with no wait for another', async () => {
    const s = states()
    const run = await check34Run({ world: { config: s.copy, record: s.on, copy: s.copy, pending: true, log: [] } })
    expect([run.r.status, run.r.reason]).toEqual(['PASS', undefined])
    expectRestored(run, s.copy)
    expect(run.scripts.filter((x) => x === 'showpending').length).toBe(1)
  })

  test("FAIL: C still listed in an archived channel (an earlier run's), whatever was restored", async () => {
    const old: ScriptedChannel = { id: 'C0OLDRUN01', name: 'cscb-live-invited-1690000000', archived: true, members: new Set([C_USER]) }
    const run = await check34Run({ channel: { cMember: true }, others: [old] })
    expect([run.r.status, run.r.reason]).toEqual(['FAIL', 'C is still in 1 channel(s), archived ones included: C0OLDRUN01'])
  })

  test('FAIL: C still in the run channel (archived before the kick, so Slack refuses the kick); the config half still runs', async () => {
    const s = states()
    const run = await check34Run({ world: { config: s.on, record: s.on, copy: s.copy, pending: false, log: [] }, channel: { cMember: true, archived: true } })
    expect([run.r.status, run.r.reason]).toEqual([
      'FAIL',
      `channel: threw HumanCallError: conversations.kick failed: is_archived; C is still in 1 channel(s), archived ones included: ${RUN_CHANNEL.id}`,
    ])
    expectRestored(run, s.copy)
  })
})

describe('Checks 30 to 32 against a scripted workspace and server (b.deo SRI-1502 to SRI-1504)', () => {
  let home = ''
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ci-live-check30-'))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const C = DRY_RUN_IDS.bots.c
  const cLog = (cls: typeof PERSONA_INVITED_CHANNEL | typeof PERSONA_CHANNEL_DELIVERY_SET | typeof UNCLAIMED_CHANNEL, cause: string) =>
    formatPersonaDiagnostic({ class: cls, name: personaName('c'), key: personaName('c'), index: 2, cause })

  /** How C and the server depart from the package's behaviour in one `invitedRun`. */
  interface InvitedOpts {
    /** Check 30's starting state is not ready (false). */
    ready?: boolean
    /** C never answers or logs anything in the channel. */
    quiet?: boolean
    /** C says done to the set_channel_delivery ask without the call. */
    noCall?: boolean
    /** Slack refuses the channel's creation. */
    createRefused?: boolean
    /** The guarded jq edit of config.json fails. */
    editFails?: boolean
    /** The mention before the invite shows in C's transcript (`tags c` prints a line). */
    earlyDelivered?: boolean
    /** How many persona-invited-channel lines C's first event logs (default 1). */
    invitedLines?: number
    /** How C's set_channel_delivery call ends (default ok), and how many persona-channel-delivery-set lines it logs (default 1). */
    callOutcome?: 'ok' | 'error'
    setLines?: number
    /** The delivery C's call asks for (default all). */
    askedDelivery?: 'mentions' | 'all'
    /** C does not answer the message that does not mention it. */
    ignorePlain?: boolean
    /** With the switch off, C logs no unclaimed-channel line ('silent') or answers the mention ('answers'). */
    switchedOff?: 'silent' | 'answers'
    /** The read of the switch in the record prints false (the switch already off before Check 32). */
    switchReadsOff?: boolean
  }

  /**
   * The run as far as Checks 30–32 go, over the reload world (config.json
   * as setup and Check 1 leave it, applied, the server running) and a
   * workspace where C behaves as the package makes it: with the switch on in
   * the record and its app in the channel, C answers a mention there (the
   * first event logging the package's persona-invited-channel line), calls
   * set_channel_delivery when asked (the package's line, then done) and, at
   * `all`, answers a message that does not mention it; with the switch off,
   * a mention logs the package's unclaimed-channel line and gets no answer.
   * `opts` (`InvitedOpts`) departs from that. `slackCalls` is every Slack
   * method the human calls, in order.
   */
  function invitedRun(opts: InvitedOpts = {}) {
    const clock = virtualClock()
    const config = renderConfig(SETUP_STATE())
    const world: ReloadWorld = { config, record: config, copy: null, pending: false, log: [] }
    const switchOn = () => (JSON.parse(world.record) as Record<string, unknown>)[SWITCH_KEY] === true
    const messages: ScriptedMessage[] = []
    let seq = 0
    const nextTs = () => `1700000100.${String(++seq).padStart(6, '0')}`
    const members = new Set<string>()
    const heard = new Set<string>()
    let delivery: 'mentions' | 'all' = 'mentions'
    const calls: string[] = []
    const slackCalls: string[] = []
    const answer = (channel: string, text: string) => messages.push({ channel, ts: nextTs(), text, user: C.userId })
    const logTimes = (n: number, line: string) => {
      for (let i = 0; i < n; i++) world.log.push(line)
    }
    const inner = scriptedSlack({
      messages,
      nextTs,
      poster: DRY_RUN_IDS.humanUserId,
      onPost: (channel, text) => {
        if (channel !== RUN_CHANNEL.id || opts.quiet) return
        const mentioned = text.includes(`<@${C.userId}>`)
        if (!members.has(C.userId) || (!mentioned && delivery === 'mentions')) return
        if (!switchOn()) {
          if (opts.switchedOff !== 'silent') world.log.push(cLog(UNCLAIMED_CHANNEL, srcUnclaimedChannelCause(channel)))
          if (opts.switchedOff === 'answers') answer(channel, 'off-check')
          return
        }
        if (!heard.has(channel)) logTimes(opts.invitedLines ?? 1, cLog(PERSONA_INVITED_CHANNEL, srcInvitedChannelCause(channel, 'public', delivery)))
        heard.add(channel)
        if (text.includes(`${SET_CHANNEL_DELIVERY_TOOL} tool once`)) {
          if (!opts.noCall) {
            const asked = opts.askedDelivery ?? 'all'
            const refused = opts.callOutcome === 'error'
            const error = refused ? slackRefusalToolErrorText(SET_CHANNEL_DELIVERY_TOOL, C_PERSONA, channel, undefined) : null
            calls.push(JSON.stringify({ channel, ts: null, threadTs: false, delivery: asked, outcome: refused ? 'error' : 'ok', error }))
            if (!refused) {
              logTimes(opts.setLines ?? 1, cLog(PERSONA_CHANNEL_DELIVERY_SET, srcChannelDeliverySetCause(channel, undefined, asked, asked)))
              delivery = asked
            }
          }
          answer(channel, 'done')
        } else if (text.includes('word invited')) answer(channel, 'invited')
        else if (text.includes('word heard-all') && !opts.ignorePlain) answer(channel, 'heard-all')
      },
    })
    const api: HumanApi = {
      call: async (method, params = {}) => {
        slackCalls.push(method)
        if (method === 'conversations.create') return opts.createRefused ? { ok: false, error: 'name_taken' } : { ok: true, channel: { id: RUN_CHANNEL.id } }
        if (method === 'conversations.invite') members.add(String(params.users))
        return inner.call(method, params)
      },
    }
    const { container, scripts } = reloadContainer(home, world, [
      ...(opts.editFails ? [['config.json.tmp', { code: 1 }] as const] : []),
      ...(opts.switchReadsOff ? [[`jq -c ${q(SWITCH_VALUE_JQ)} "$S/config.json.last-applied"`, 'false'] as const] : []),
      ['echo READY', opts.ready === false ? '' : 'READY'],
      [
        `cp "$S/config.json" ${CONFIG_COPY} && echo COPIED`,
        () => {
          world.copy = world.config
          return 'COPIED'
        },
      ],
      ['tags c ', opts.earlyDelivered ? `${C.userId} 1700000100.000001` : ''],
      ['cscb-live-c/', () => calls.join('\n')],
    ])
    const guard = recordingGuard()
    const ctx = makeCtx({ mode: 'real', clock, human: new HumanSession(api, clock), container, promptGuard: guard })
    return { ctx, world, scripts, messages, slackCalls, guard }
  }

  /** `invitedRun(opts)` through Checks 30 and 31, each a PASS: the state Check 32 starts from. */
  async function throughCheck31(opts: InvitedOpts = {}) {
    const run = invitedRun(opts)
    for (const c of [check30, check31]) {
      const r = await c.run(run.ctx)
      expect([c.id, r.status, r.reason]).toEqual([c.id, 'PASS', undefined])
    }
    return run
  }

  test('Check 30: the switch goes on with the preview the package writes, the channel is created, C is mentioned, invited and mentioned again, and answers; the copy and the channel are in shared state', async () => {
    const run = invitedRun()
    const r = await check30.run(run.ctx)
    assertNoLeak(r)
    expect([r.status, r.reason]).toEqual(['PASS', undefined])
    expect(run.ctx.shared.invitedConfigCopy).toBe(CONFIG_COPY)
    expect(run.ctx.shared.invitedChannel).toEqual(RUN_CHANNEL)
    expect(run.ctx.shared.invitedCAnswerTs).toBe(run.messages.find((m) => m.user === C.userId)!.ts)
    expect(run.world.copy).toBe(renderConfig(SETUP_STATE()))
    expect(channelModeOf(loadLive(run.world.record))).toBe('fungible')
    expect(r.notes).toEqual(['Check 30: the mention before the invite was not delivered to C'])
    const gestures = ['conversations.create', 'chat.postMessage', 'conversations.invite']
    expect(run.slackCalls.filter((m) => gestures.includes(m))).toEqual(['conversations.create', 'chat.postMessage', 'conversations.invite', 'chat.postMessage'])
    expectNoPromptDeclared(run.guard)
  })

  test("Check 30 notes it when the mention before the invite shows in C's transcript, and still passes", async () => {
    const run = invitedRun({ earlyDelivered: true })
    const r = await check30.run(run.ctx)
    expect([r.status, r.reason, r.notes]).toEqual(['PASS', undefined, ['Check 30: the mention before the invite was delivered to C']])
  })

  test('Check 30 FAILs when C answers but logs two persona-invited-channel lines for the channel', async () => {
    const run = invitedRun({ invitedLines: 2 })
    const r = await check30.run(run.ctx)
    expect([r.status, r.reason]).toEqual(['FAIL', `expected one ${PERSONA_INVITED_CHANNEL} line naming C and the run channel (public, mentions), found 2`])
  })

  test('Check 30 FAILs when the guarded edit of config.json fails: the copy is kept for Check 34, and no channel is created', async () => {
    const run = invitedRun({ editFails: true })
    const r = await check30.run(run.ctx)
    expect(r.status).toBe('FAIL')
    expect(r.reason).toStartWith('the guarded config edit did not run')
    expect([run.ctx.shared.invitedConfigCopy, run.ctx.shared.invitedChannel]).toEqual([CONFIG_COPY, undefined])
    expect(run.slackCalls).toEqual([])
  })

  test('Check 30 starts only from the applied, nothing-pending, running state; otherwise it FAILs with nothing changed', async () => {
    const run = invitedRun({ ready: false })
    const r = await check30.run(run.ctx)
    expect([r.status, r.reason]).toEqual(['FAIL', 'not in the applied, nothing-pending, running state; nothing was changed'])
    expect(run.scripts.filter((s) => s.startsWith('guard || exit 90'))).toEqual([])
    expect(run.ctx.shared).toEqual({})
  })

  test('Check 30 records the copy before its edit, and the channel as soon as it exists: a later throw leaves both for Check 34', async () => {
    const run = invitedRun({ createRefused: true })
    await expect(check30.run(run.ctx)).rejects.toThrow('conversations.create failed: name_taken')
    expect(run.ctx.shared.invitedConfigCopy).toBe(CONFIG_COPY)
    expect(run.ctx.shared.invitedChannel).toBeUndefined()
    const quiet = invitedRun({ quiet: true })
    const r = await check30.run(quiet.ctx)
    expect([r.status, r.reason]).toEqual(['FAIL', `C did not answer the mention in the run channel after the invite; expected one ${PERSONA_INVITED_CHANNEL} line naming C and the run channel (public, mentions), found 0`])
    expect([quiet.ctx.shared.invitedConfigCopy, quiet.ctx.shared.invitedChannel, quiet.ctx.shared.invitedCAnswerTs]).toEqual([CONFIG_COPY, RUN_CHANNEL, undefined])
  })

  test('Checks 30, 31 and 32 in order: C stores all and answers a message that does not mention it; then, with the switch off, a mention gets no answer and one unclaimed-channel line', async () => {
    const run = await throughCheck31()
    const r = await check32.run(run.ctx)
    assertNoLeak(r)
    expect([r.status, r.reason]).toEqual(['PASS', undefined])
    expect(channelModeOf(loadLive(run.world.record))).toBe('declarative')
    expect(run.world.log.filter((l) => l.includes(`] ${UNCLAIMED_CHANNEL}: `)).length).toBe(1)
    expect(unguardedChanges(run.scripts)).toEqual([])
    expectNoPromptDeclared(run.guard)
  })

  // Silence alone never passes Check 32: it needs the unclaimed-channel line, and the switch to have been on.
  test.each<[string, InvitedOpts, string]>([
    ['C silent and no unclaimed-channel line', { switchedOff: 'silent' }, `expected one ${UNCLAIMED_CHANNEL} line with the declarative cause naming C and the run channel, found 0`],
    ['C answering with the switch off', { switchedOff: 'answers' }, 'C answered in the run channel with the switch off'],
    ['the switch already off in the record', { switchReadsOff: true }, 'the switch is not on in the last-applied record, so there is nothing to switch off'],
  ])('Check 32 FAILs after Checks 30 and 31 pass: %s', async (_what, opts, reason) => {
    const run = await throughCheck31(opts)
    const edits = run.scripts.filter((x) => x.includes('config.json.tmp')).length
    const r = await check32.run(run.ctx)
    expect([r.status, r.reason]).toEqual(['FAIL', reason])
    // With nothing to switch off, Check 32 makes no edit.
    if (opts.switchReadsOff) expect(run.scripts.filter((x) => x.includes('config.json.tmp')).length).toBe(edits)
  })

  test.each<[string, InvitedOpts, string]>([
    ['a refused set_channel_delivery call', { callOutcome: 'error' }, `C's ${SET_CHANNEL_DELIVERY_TOOL} call was refused`],
    ['a call asking for a delivery other than all', { askedDelivery: 'mentions' }, `C's call asked for delivery mentions, not all`],
    ['no persona-channel-delivery-set line', { setLines: 0 }, `expected one ${PERSONA_CHANNEL_DELIVERY_SET} line naming C and the run channel (none to all, at all), found 0`],
    ['two persona-channel-delivery-set lines', { setLines: 2 }, `expected one ${PERSONA_CHANNEL_DELIVERY_SET} line naming C and the run channel (none to all, at all), found 2`],
    ['C not answering the message that does not mention it', { ignorePlain: true }, 'C did not answer the message that does not mention it'],
  ])('Check 31 FAILs on %s', async (_what, opts, failure) => {
    const run = invitedRun(opts)
    expect((await check30.run(run.ctx)).status).toBe('PASS')
    const r = await check31.run(run.ctx)
    assertNoLeak(r)
    expect(r.status).toBe('FAIL')
    expect(r.reason!.split('; ')).toContain(failure)
    if (opts.callOutcome === 'error') expect(r.evidence.filter((e) => e.startsWith('refusal: '))).toEqual([`refusal: ${slackRefusalToolErrorText(SET_CHANNEL_DELIVERY_TOOL, C_PERSONA, RUN_CHANNEL.id, undefined)}`])
  })

  test('Check 31: C saying done twice without the call is "not run"; C silent is a FAIL', async () => {
    const run = invitedRun({ noCall: true })
    await check30.run(run.ctx)
    const r = await check31.run(run.ctx)
    expect([r.status, r.reason]).toEqual([
      'SKIPPED',
      `not run: C made no ${SET_CHANNEL_DELIVERY_TOOL} call for the run channel (asked 2 times) (the plan records this as "not run", not a pass)`,
    ])
    expect(r.evidence.filter((e) => e.startsWith(`${SET_CHANNEL_DELIVERY_TOOL} ask `)).length).toBe(2)
    const silent = invitedRun()
    await check30.run(silent.ctx)
    const s = await check31.run({ ...silent.ctx, human: scriptedHuman(silent.ctx.clock).human })
    expect([s.status, s.reason]).toEqual(['FAIL', `C did not say done and made no ${SET_CHANNEL_DELIVERY_TOOL} call for the run channel`])
  })

  test.each([check31, check32, check33])("Check $id without Check 30's channel FAILs naming that, with no Slack call and no container command", async (c) => {
    const { container, scripts } = fakeContainer([])
    const s = scriptedHuman(virtualClock())
    const r = await c.run(makeCtx({ mode: 'real', container, human: s.human }))
    expect([r.status, r.reason]).toEqual(['FAIL', 'no run channel: Check 30 did not create one'])
    expect([scripts, s.calls]).toEqual([[], []])
  })
})

/** A session tool's name as C's transcript records it (the MCP server's name, then the tool's). */
const mcpTool = (tool: string) => `mcp__${MCP_SERVER_NAME}__${tool}`

describe("the tool-call reader (toolCalls) over a persona's transcript", () => {
  const CH = 'C0RUNCH001'
  const POST = '1700000050.000001'
  /** Content an accepted call returned: it must never reach the reader's output. */
  const CONTENT = 'SECRET-CONTENT the message text Slack returned'
  const refusal = (tool: string, code: string) => slackRefusalToolErrorText(tool, C_PERSONA, CH, code)
  const use = (id: string, tool: string, input: Record<string, unknown>) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: mcpTool(tool), input }] } })
  const result = (id: string, content: unknown, isError?: boolean) => ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError === undefined ? {} : { is_error: isError }) }] },
  })
  /**
   * C's calls of several tools: refused (string and block content), accepted
   * (with the content Slack returned), with no result yet, a threaded fetch,
   * a set_channel_delivery call, a call of another server's tool and of a
   * built-in tool, which are no session tool's.
   */
  const TRANSCRIPT = [
    use('t1', REPLY_TOOL, { chat_id: CH, text: 'after-kick check' }),
    result('t1', [{ type: 'text', text: refusal(REPLY_TOOL, 'not_in_channel') }], true),
    use('t2', FETCH_MESSAGES_TOOL, { channel: CH }),
    result('t2', refusal(FETCH_MESSAGES_TOOL, 'not_in_channel'), true),
    use('t3', REACT_TOOL, { chat_id: CH, message_id: POST, emoji: 'eyes' }),
    result('t3', [{ type: 'text', text: `Reacted: ${CONTENT}` }]),
    use('t4', EDIT_MESSAGE_TOOL, { chat_id: CH, message_id: POST, text: CONTENT }),
    use('t5', FETCH_MESSAGES_TOOL, { channel: CH, thread_ts: POST }),
    result('t5', [{ type: 'text', text: JSON.stringify([{ text: CONTENT }]) }], false),
    use('t6', SET_CHANNEL_DELIVERY_TOOL, { channel: CH, delivery: 'all' }),
    result('t6', [{ type: 'text', text: `Stored all ${CONTENT}` }]),
    use('t7', REPLY_TOOL, { chat_id: 'D0DRYDM001', text: 'done' }),
    result('t7', 'Sent 1 message(s) to D0DRYDM001'),
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't8', name: `mcp__other-server__${REPLY_TOOL}`, input: { chat_id: CH } }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: { command: REPLY_TOOL } }] } },
  ]

  let home = ''
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ci-live-tool-calls-'))
    const dir = join(home, '.claude', 'projects', '-home-testuser-cscb-live-c')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '0f0f0f0f-session.jsonl'), TRANSCRIPT.map((e) => JSON.stringify(e)).join('\n') + '\n')
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  /** The reader's script for `tool`, run by bash in the fixture home: its output lines. */
  function read(letter: PersonaLetter, tool: string): string[] {
    const r = Bun.spawnSync([Bun.which('bash')!, '-c', toolCallsScript(letter, tool)], { env: hostSafeChildEnv(home, { tools: ['bash', 'ls', 'head', 'jq'] }) })
    expect(r.stderr.toString()).toBe('')
    return r.stdout.toString().split('\n').filter((l) => l !== '')
  }

  const call = (over: Partial<ToolCall>): ToolCall => ({ channel: CH, ts: null, threadTs: false, delivery: null, outcome: 'ok', error: null, ...over })

  test.each([
    [REPLY_TOOL, [call({ outcome: 'error', error: refusal(REPLY_TOOL, 'not_in_channel') }), call({ channel: 'D0DRYDM001' })]],
    [FETCH_MESSAGES_TOOL, [call({ outcome: 'error', error: refusal(FETCH_MESSAGES_TOOL, 'not_in_channel') }), call({ threadTs: true })]],
    [REACT_TOOL, [call({ ts: POST })]],
    [EDIT_MESSAGE_TOOL, [call({ ts: POST, outcome: 'none' })]],
    [RUNNER_SET_CHANNEL_DELIVERY_TOOL, [call({ delivery: 'all' })]],
  ])('%s: exactly the projection of each of its calls, in order, and nothing of an accepted call\'s content', async (tool, expected) => {
    const out = read('c', tool)
    expect(out.map((l) => JSON.parse(l))).toEqual(expected)
    expect(out.join('\n')).not.toContain('SECRET-CONTENT')
    // Through the container, as a check reads it.
    const { container } = fakeContainer([['cscb-live-c/', out.join('\n')]])
    expect(await toolCalls(makeCtx({ container }), 'c', tool)).toEqual(expected)
  })

  test("another persona's transcript, or none, gives no call", () => {
    expect(read('a', REPLY_TOOL)).toEqual([])
  })
})

describe("Check 33: after the kick, reply and fetch_messages are refused with Slack's code; react, edit_message and threaded fetch_messages are recorded (b.deo SRI-1505, SRI-603)", () => {
  const CH = RUN_CHANNEL.id
  const POST = '1700000050.000001'
  const DM = 'D0DRYDM001'
  let home = ''
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ci-live-check33-'))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  /** How C's call of one tool ends: accepted, refused by Slack with a code, refused with another error, or made with no result yet. */
  type Ends = { ok: true } | { code: string } | { error: string } | { none: true }
  const refusal = (tool: string, code: string) => slackRefusalToolErrorText(tool, C_PERSONA, CH, code)
  /** The FAIL reason for a call on the run channel that did not come back as Slack's refusal. */
  const notRefused = (tool: string) => `C's ${tool} call on the run channel was not refused with the tool error naming C, the channel and Slack's code`
  const callOf =(tool: string, ends: Ends, input: Partial<ToolCall> = {}): ToolCall => ({
    channel: CH,
    ts: null,
    threadTs: false,
    delivery: null,
    ...input,
    ...('ok' in ends ? { outcome: 'ok', error: null } : 'none' in ends ? { outcome: 'none', error: null } : { outcome: 'error', error: 'code' in ends ? refusal(tool, ends.code) : ends.error }),
  })

  /** What C does on one ask by DM: says done or not, and the calls it makes (each tool's end; absent, no call). */
  interface Step {
    done: boolean
    calls?: Partial<Record<'reply' | 'fetch' | 'react' | 'edit' | 'thread', Ends>>
  }

  /**
   * Check 33 in a scripted world: the record holds `record` (the switch off
   * after Check 32 by default, so Check 33 turns it on again), the human's
   * DM with C plays `steps` (the first asks for reply and fetch_messages,
   * the next for the recorded three), C's calls are what `toolCalls` reads.
   */
  async function check33Run(steps: Step[], opts: { switchOn?: boolean; noEarlierPost?: boolean } = {}) {
    const clock = virtualClock()
    const s = (() => {
      const copy = renderConfig(part9State(false))
      const on = jqEdit(home, JSON.parse(copy), switchOnFilter(DRY_RUN_IDS))
      return { on, off: jqEdit(home, JSON.parse(on), switchFilter(false)) }
    })()
    const config = opts.switchOn ? s.on : s.off
    const world: ReloadWorld = { config, record: config, copy: null, pending: false, log: [] }
    const calls: (ToolCall & { tool: string })[] = []
    const messages: ScriptedMessage[] = []
    let seq = 0
    const nextTs = () => `1700000100.${String(++seq).padStart(6, '0')}`
    const asks: string[] = []
    const api = scriptedSlack({
      messages,
      nextTs,
      poster: DRY_RUN_IDS.humanUserId,
      openDm: DM,
      onPost: (channel, text) => {
        if (channel !== DM) return
        const step = steps[asks.length] ?? { done: false }
        asks.push(text)
        const c = step.calls ?? {}
        const add = (tool: string, ends: Ends | undefined, input: Partial<ToolCall> = {}) => {
          if (ends) calls.push({ tool, ...callOf(tool, ends, input) })
        }
        add(REPLY_TOOL, c.reply)
        add(FETCH_MESSAGES_TOOL, c.fetch)
        add(REACT_TOOL, c.react, { ts: POST })
        add(EDIT_MESSAGE_TOOL, c.edit, { ts: POST })
        add(FETCH_MESSAGES_TOOL, c.thread, { threadTs: true })
        if (step.done) messages.push({ channel: DM, ts: nextTs(), text: 'done', user: DRY_RUN_IDS.bots.c.userId })
      },
    })
    const slackCalls: string[] = []
    const kicks: Record<string, unknown>[] = []
    const kicking: HumanApi = {
      call: (method, params) => {
        if (method === 'conversations.kick') kicks.push({ ...params })
        return api.call(method, params)
      },
    }
    const { container, scripts } = reloadContainer(home, world, [
      [
        'cscb-live-c/',
        (script) => {
          const tool = /--arg tool '([a-z_]+)'/.exec(script)?.[1]
          return calls.filter((x) => x.tool === tool).map(({ tool: _t, ...x }) => JSON.stringify(x)).join('\n')
        },
      ],
    ])
    const guard = recordingGuard()
    const ctx = makeCtx({
      mode: 'real',
      clock,
      human: new HumanSession(recordingApi(kicking, 'human', slackCalls), clock),
      container,
      shared: { invitedChannel: RUN_CHANNEL, ...(opts.noEarlierPost ? {} : { invitedCAnswerTs: POST }) },
      promptGuard: guard,
    })
    const r = await check33.run(ctx)
    assertNoLeak(r)
    return { r, asks, world, scripts, slackCalls, kicks, guard, residuals: (r.notes ?? []).filter((n) => n.startsWith('Check 33 residual: ')) }
  }
  const REFUSED = { reply: { code: 'not_in_channel' }, fetch: { code: 'channel_not_found' } } as const
  const ALL_OK = { react: { ok: true }, edit: { ok: true }, thread: { ok: true } } as const

  test("the switch goes on again (an edit of the switch alone, confirmed), C's app is kicked from the run channel before C is asked; the refusals' codes are evidence and notes", async () => {
    const run = await check33Run([{ done: true, calls: REFUSED }, { done: true, calls: ALL_OK }])
    expect([run.r.status, run.r.reason]).toEqual(['PASS', undefined])
    expect(run.world.record).toBe(jqEdit(home, JSON.parse(run.world.record), switchFilter(true)))
    expect(run.world.log.filter((l) => l.includes(`] ${RELOAD_APPLIED}: `)).map((l) => l.includes(appliedLine({ settings: 1 })))).toEqual([true])
    const kick = run.slackCalls.indexOf('human conversations.kick')
    expect(kick).toBeGreaterThan(-1)
    expect(run.slackCalls.indexOf('human chat.postMessage')).toBeGreaterThan(kick)
    expect(run.kicks).toEqual([{ channel: RUN_CHANNEL.id, user: DRY_RUN_IDS.bots.c.userId }])
    const codes = [`${REPLY_TOOL}: refused by Slack (not_in_channel)`, `${FETCH_MESSAGES_TOOL} without thread_ts: refused by Slack (channel_not_found)`]
    expect(run.r.evidence.filter((e) => codes.includes(e))).toEqual(codes)
    // The codes reach the Results row's Notes, before the residual notes.
    expect(run.r.notes).toEqual([...codes, ...run.residuals])
    expect(run.asks.length).toBe(2)
    expectNoPromptDeclared(run.guard)
  })

  test("a refusal inside a wrapper the client adds, with a mixed-case code holding $, is still read as Slack's (as Check 16 reads a refused call)", async () => {
    const code = 'Not_In$Channel'
    const wrapped = (tool: string) => ({ error: `<tool_use_error>${refusal(tool, code)}</tool_use_error>` })
    const run = await check33Run([{ done: true, calls: { reply: wrapped(REPLY_TOOL), fetch: wrapped(FETCH_MESSAGES_TOOL) } }, { done: true, calls: ALL_OK }])
    expect([run.r.status, run.r.reason]).toEqual(['PASS', undefined])
    expect(run.r.notes!.slice(0, 2)).toEqual([`${REPLY_TOOL}: refused by Slack (${code})`, `${FETCH_MESSAGES_TOOL} without thread_ts: refused by Slack (${code})`])
  })

  test('the switch already on (Check 32 did not turn it off): no edit, a note, and the check runs on', async () => {
    const run = await check33Run([{ done: true, calls: REFUSED }, { done: true, calls: ALL_OK }], { switchOn: true })
    expect([run.r.status, run.r.reason]).toEqual(['PASS', undefined])
    expect(run.r.notes).toContain('Check 33: the switch was already on in the last-applied record (Check 32 did not turn it off); no edit was made')
    expect(run.scripts.filter((x) => x.includes('config.json.tmp'))).toEqual([])
    expectNoPromptDeclared(run.guard)
  })

  test.each<[string, Ends | undefined, string]>([
    ['accepted', { ok: true }, 'accepted'],
    ['refused by Slack', { code: 'not_in_channel' }, 'refused by Slack (not_in_channel)'],
    ['refused with no Slack code', { error: 'Tool "x" failed: the tool call failed.' }, 'refused with no Slack code'],
    ['made, with no result yet', { none: true }, 'made, with no result'],
    ['not made', undefined, 'not made'],
  ])('each recorded call %s: one note in the fixed form, and none decides the result', async (_what, ends, outcome) => {
    const run = await check33Run([{ done: true, calls: REFUSED }, { done: true, calls: { react: ends, edit: ends, thread: ends } }, { done: true, calls: {} }])
    expect([run.r.status, run.r.reason]).toEqual(['PASS', undefined])
    expect(run.residuals).toEqual(CHECK33_RECORDED_CALLS.map((call) => `Check 33 residual: ${call} after the kick: ${outcome}`))
    // A missing call is asked for once more (Check 16's rule), never a third time.
    expect(run.asks.length).toBe(ends === undefined ? 3 : 2)
    expectNoPromptDeclared(run.guard)
  })

  test('the recorded outcomes are independent: each call gets its own note', async () => {
    const run = await check33Run([{ done: true, calls: REFUSED }, { done: true, calls: { react: { ok: true }, edit: { code: 'cant_update_message' } } }, { done: true, calls: { thread: { code: 'not_in_channel' } } }])
    const [react, edit, thread] = CHECK33_RECORDED_CALLS
    expect(run.residuals).toEqual([
      residualNote(react, { kind: 'accepted' }),
      residualNote(edit, { kind: 'refused', code: 'cant_update_message' }),
      residualNote(thread, { kind: 'refused', code: 'not_in_channel' }),
    ])
  })

  test.each<[string, Step['calls'], string]>([
    ['reply accepted (not refused)', { reply: { ok: true }, fetch: { code: 'not_in_channel' } }, notRefused(REPLY_TOOL)],
    ['fetch_messages refused with no Slack code', { reply: { code: 'not_in_channel' }, fetch: { error: slackRefusalToolErrorText(FETCH_MESSAGES_TOOL, C_PERSONA, CH, undefined) } }, notRefused(FETCH_MESSAGES_TOOL)],
    ['fetch_messages with no result', { reply: { code: 'not_in_channel' }, fetch: { none: true } }, notRefused(FETCH_MESSAGES_TOOL)],
  ])('a missing or different refusal is a FAIL: %s', async (_what, calls, reason) => {
    const run = await check33Run([{ done: true, calls }, { done: true, calls: ALL_OK }])
    expect([run.r.status, run.r.reason]).toEqual(['FAIL', reason])
    expect(run.residuals.length).toBe(3)
  })

  test('C never answering is a FAIL after one ask, with nothing recorded', async () => {
    const run = await check33Run([{ done: false }])
    expect([run.r.status, run.r.reason]).toEqual(['FAIL', `C did not say done and made no ${REPLY_TOOL} and ${FETCH_MESSAGES_TOOL} call on the run channel`])
    expect([run.asks.length, run.residuals]).toEqual([1, []])
  })

  test('no reply and no fetch_messages call after two asks is "not run" (SKIPPED), with the three outcomes still recorded', async () => {
    const run = await check33Run([{ done: true }, { done: true }, { done: true, calls: ALL_OK }])
    expect([run.r.status, run.r.reason]).toEqual([
      'SKIPPED',
      `not run: C made no ${REPLY_TOOL} and ${FETCH_MESSAGES_TOOL} call on the run channel (asked 2 times) (the plan records this as "not run", not a pass)`,
    ])
    expect(run.residuals.map((n) => n.endsWith(': accepted'))).toEqual([true, true, true])
  })

  // Only one of the two calls made after two asks: the call made is still judged.
  test.each<[string, Step['calls'], CheckResult['status'], string, string[]]>([
    ['reply accepted, fetch_messages not made', { reply: { ok: true } }, 'FAIL', notRefused(REPLY_TOOL), []],
    ['fetch_messages accepted, reply not made', { fetch: { ok: true } }, 'FAIL', notRefused(FETCH_MESSAGES_TOOL), []],
    [
      "reply refused with Slack's code, fetch_messages not made",
      { reply: { code: 'not_in_channel' } },
      'SKIPPED',
      `not run: C made no ${FETCH_MESSAGES_TOOL} call on the run channel (asked 2 times) (the plan records this as "not run", not a pass)`,
      [`${REPLY_TOOL}: refused by Slack (not_in_channel)`],
    ],
  ])('one call made after two asks, %s: that call is judged', async (_what, calls, status, reason, codeNotes) => {
    const run = await check33Run([{ done: true, calls }, { done: true }, { done: true, calls: ALL_OK }])
    expect([run.r.status, run.r.reason]).toEqual([status, reason])
    expect(run.r.notes!.filter((n) => !run.residuals.includes(n))).toEqual(codeNotes)
    expect(run.residuals.length).toBe(3)
  })

  test('with no earlier post of C in the channel, the three are not asked for and are recorded as not made', async () => {
    const run = await check33Run([{ done: true, calls: REFUSED }], { noEarlierPost: true })
    expect([run.r.status, run.r.reason]).toEqual(['PASS', undefined])
    expect(run.asks.length).toBe(1)
    expect(run.residuals.every((n) => n.endsWith(': not made'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The prompts the checks declare to the prompt guard
// ---------------------------------------------------------------------------

describe('the prompts each check declares to the prompt guard, before it raises them', () => {
  /** Every check that raises a permission prompt, and what it declares (run 6's list: 5, 18, 22, 23, and 27 left open). */
  const DECLARED: Record<string, PromptExpectation[]> = {
    '5': [
      { persona: 'a', command: CHECK5_PROMPT_1 },
      { persona: 'a', command: CHECK5_PROMPT_2 },
    ],
    '18': [{ persona: 'c', command: CHECK18_PROMPT }],
    '22': [{ persona: 'b', command: CHECK22_PROMPT }],
    '23': [
      { persona: 'a', command: CHECK23_PROMPT_A },
      { persona: 'b', command: CHECK23_PROMPT_B },
      { persona: 'b', command: CHECK23_B_EXTRA },
    ],
    '27': [{ persona: 'd', command: CHECK27_PROMPT, leaveOpen: true }],
  }
  const live = PLAN_CHECKS.filter((c) => c.needs.includes('workspace') && !c.skip)

  /**
   * A silent workspace (as above) whose declarations, human posts and typing
   * into a persona's pane are recorded in order; the container answers
   * `container` first, if given.
   */
  function declaringCtx(leftovers = 0, container?: [string, Reply]) {
    const clock = virtualClock()
    const events: string[] = []
    const guard = recordingGuard(leftovers)
    const record = guard.expect
    guard.expect = (e) => {
      events.push(`expect ${e.persona}`)
      record(e)
    }
    const { human } = scriptedHuman(clock)
    const post = human.post.bind(human)
    human.post = async (channel, text, thread) => {
      events.push('post')
      return post(channel, text, thread)
    }
    const answers: [string, Reply][] = [
      ...(container ? [container] : []),
      [
        '',
        (script) => {
          if (script.includes('tmux send-keys')) events.push('type')
          return script === 'mark' ? '1:0' : ''
        },
      ],
    ]
    const ctx = makeCtx({
      mode: 'real',
      clock,
      human,
      second: { human: scriptedHuman(clock).human, userId: 'U0DRYSECND' },
      browser: idleBrowser(),
      container: fakeContainer(answers).container,
      promptGuard: guard,
    })
    return { ctx, events, guard }
  }

  test('the checks that raise prompts are the ones run 6 named', () => {
    expect(Object.keys(DECLARED).sort()).toEqual(['18', '22', '23', '27', '5'])
    expect(CHECK23_B_EXTRA.test('anything B runs')).toBe(true)
  })

  test("Part 11's checks (30 to 34) are among the live checks here and declare no prompt: C's set_channel_delivery and Slack tool calls raise none", () => {
    expect(live.map((c) => c.id).filter((id) => INVITED_CHECKS.some((x) => x.id === id))).toEqual(['30', '31', '32', '33', '34'])
    expect(Object.keys(DECLARED).filter((id) => INVITED_CHECKS.some((x) => x.id === id))).toEqual([])
  })

  // Why Check 31 (and 33) declare no prompt: the live container's first boot
  // writes the test user's Claude Code settings allowing the server's MCP
  // tools as a group, in the default mode with no bypass, so C's first
  // set_channel_delivery call raises no permission prompt. The provisioning
  // code is read as text; no settings.json is read. A change here fails this
  // case before a live run loses 15 s and a denial to the prompt guard.
  test("the live container's first boot allows the server's MCP tools as a group, with no bypass mode (so Check 31 declares no prompt)", () => {
    const entrypoint = readFileSync(join(import.meta.dir, '..', 'docker', 'live', 'entrypoint.sh'), 'utf-8')
    const firstBoot = entrypoint.slice(entrypoint.indexOf('\nfirst_boot() {\n'), entrypoint.indexOf('\n}\n', entrypoint.indexOf('\nfirst_boot() {\n')))
    const settingsLine = firstBoot.split('\n').find((l) => /^\s*settings = /.test(l))
    expect(settingsLine).toBeDefined()
    // The Python literal as JSON: it holds only strings, lists and dicts.
    const settings = JSON.parse(settingsLine!.replace(/^\s*settings = /, '').replace(/'/g, '"')) as { permissions?: { allow?: string[]; defaultMode?: string } }
    expect(settings.permissions?.allow).toContain(`mcp__${MCP_SERVER_NAME}__*`)
    expect(settings.permissions?.defaultMode).toBe('default')
    expect(firstBoot).toContain("open(os.path.join(home, '.claude', 'settings.json'), 'w')")
    const code = entrypoint.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
    expect(code).not.toMatch(/bypassPermissions|dangerously-skip-permissions|skipDangerousModePermissionPrompt/)
  })

  test.each(live.map((c) => [c.id, c] as const))('Check %s declares exactly its prompts, all before it posts or types what raises them', async (id, c) => {
    const { ctx, events, guard } = declaringCtx()
    await runChecks([c], ctx, { available: new Set<Need>(['workspace', 'claude', 'second-user']), only: [], now: () => 0, log: { info: () => {} } })
    expect(guard.expected).toEqual(DECLARED[id] ?? [])
    if (DECLARED[id]) {
      const raised = events.findIndex((e) => e === 'post' || e === 'type')
      const declared = events.map((e, i) => (e.startsWith('expect ') ? i : -1)).filter((i) => i >= 0)
      expect(raised).toBeGreaterThan(Math.max(...declared))
    }
  })

  test.each([
    ['Check 5', CHECK5_PROMPT_1, 'date > permission-check.txt', 'date > permission-check-2.txt'],
    ['Check 5 (2)', CHECK5_PROMPT_2, 'date > ~/cscb-live/a/permission-check-2.txt', 'date > permission-check.txt'],
    ['Check 18', CHECK18_PROMPT, 'date > dm-prompt-c.txt', 'ls'],
    ['Check 22', CHECK22_PROMPT, 'date +%F > "$(pwd)/dm-prompt-b.txt"', 'date > prompt-b.txt'],
    ['Check 23 (A)', CHECK23_PROMPT_A, '🤖🛠️ *Write*\n`/home/testuser/cscb-live/a/prompt-a.txt`', "env | grep -i -E 'cscb|slack'"],
    ['Check 27', CHECK27_PROMPT, 'date > removal-prompt.txt', 'pwd'],
  ])("%s's declared command matches its own prompt, not a detour", (_what, re, own, detour) => {
    expect([commandMatches(re, own), commandMatches(re, detour)]).toEqual([true, false])
  })
})

describe('Check 23: what it raised is denied when it ends, even on an early return or a throw', () => {
  function silent23(leftovers: number, container?: [string, Reply]) {
    const clock = virtualClock()
    const guard = recordingGuard(leftovers)
    const answers: [string, Reply][] = [...(container ? [container] : []), ['', (script) => (script === 'mark' ? '1:0' : '')]]
    const ctx = makeCtx({ mode: 'real', clock, human: scriptedHuman(clock).human, browser: idleBrowser(), container: fakeContainer(answers).container, promptGuard: guard })
    return { ctx, guard }
  }

  test("an early return (the prompts did not appear) still has the guard deny what it left open, and the denial is noted", async () => {
    const { ctx, guard } = silent23(2)
    const r = await check23.run(ctx)
    expect([r.status, r.reason]).toEqual(['FAIL', 'both prompts did not appear'])
    expect(guard.sweeps).toBe(1)
    expect(r.notes).toEqual(["Check 23: 2 prompt(s) it raised were still open at its end; denied (the prompt guard's notes name them)"])
  })

  test('with nothing left open, no note', async () => {
    const { ctx, guard } = silent23(0)
    const r = await check23.run(ctx)
    expect([guard.sweeps, r.notes]).toEqual([1, []])
  })

  test('a throw after the post still has the guard deny what it left open, then ends the check', async () => {
    const { ctx, guard } = silent23(1, [
      'cscb.chat_post.attempted',
      () => {
        throw new Error('container gone')
      },
    ])
    await expect(check23.run(ctx)).rejects.toThrow('container gone')
    expect(guard.sweeps).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Texts the checks expect, against the package
// ---------------------------------------------------------------------------

describe('expected texts match the package', () => {
  // Check 30's switch-on edit counts its A, B, C (and D, when D is still declared) in place and the switch.
  const COUNTS = [{ added: 1 }, { removed: 1, credentials: 1 }, { in_place: 2 }, { settings: 1 }, { destructive: 1 }, { in_place: 3, settings: 1 }, { in_place: 4, settings: 1 }]
  const srcCounts = (c: (typeof COUNTS)[number]): ChangePlanCounts => {
    const x = c as Partial<Record<string, number>>
    return { added: x.added ?? 0, removed: x.removed ?? 0, destructive: x.destructive ?? 0, inPlace: x.in_place ?? 0, credentials: x.credentials ?? 0, settings: x.settings ?? 0 }
  }
  const sized = (n: number) => Array.from({ length: n }, () => ({})) as never[]

  test.each(COUNTS)('counts %j: the preview header and the reload-applied line', (c) => {
    const counts = srcCounts(c)
    expect(countsText(c)).toBe(renderChangePlanCounts(counts))
    expect(previewHeader(c)).toBe(`${PENDING_PREVIEW_TITLE} ${renderChangePlanCounts(counts)}.`)
    const plan: ValidChangePlan = {
      valid: true,
      added: sized(counts.added),
      removed: sized(counts.removed),
      destructive: sized(counts.destructive),
      inPlace: Array.from({ length: counts.inPlace }, (_, i) => ({ key: `k${i}` })) as never[],
      credentials: sized(counts.credentials),
      nextLaunch: [],
      unchanged: [],
      recorded: [],
      settings: sized(counts.settings),
      noEffectiveChange: false,
      configDirsChanged: false,
    }
    expect(appliedLine(c)).toBe(renderAppliedLogLine(plan, `${S}/config.json.last-applied`))
  })

  test("the start summary: the ending the checks expect, and Check 1's line, are the package's buckets in its order", () => {
    // The package's line and ending, built by its own builders: a clean
    // first start of three personas, each a fresh spawn, every other count 0.
    // Typed over every summary count, so a new one fails the typecheck here.
    const zero: StartupSummaryCounts = {
      failed: 0,
      notBroughtUp: 0,
      resumed: 0,
      freshSpawned: 0,
      freshAfterAmnesia: 0,
      freshAfterInconclusiveAmnesia: 0,
      reconnected: 0,
      notReconnected: 0,
      noop: 0,
      latched: 0,
      retrying: 0,
      sequenceWaiting: 0,
      held: 0,
      freshRetired: 0,
    }
    const line = startupSummaryLine(3, { ...zero, freshSpawned: 3 })
    const ending = startupSummaryEnding(zero)
    // The checks' clean ending and Check 1's whole line are the package's
    // (b.jg5 SRJ-1111, SRJ-1015): every bucket, b.f2b's not-reconnected and
    // SRJ-1015's five counts included, in its order and words.
    expect(START_SUMMARY_END).toBe(ending)
    expect(line.endsWith(`, ${START_SUMMARY_END}`)).toBe(true)
    expect(COMPLETE_FIRST_START).toBe(line)
  })

  test("the checks' summary ending with the retried count (Check 28's acceptRetried: one persona not brought up), every other count defaulted to 0, is the package's builder's", () => {
    const all = { failed: 0, notBroughtUp: 1, notReconnected: 0, latched: 0, retrying: 0, sequenceWaiting: 0, held: 0, freshRetired: 0 }
    expect(startSummaryEnding({ notBroughtUp: 1 })).toBe(startupSummaryEnding(all))
  })

  test("the import-free modules the checks build from are the ones src/reload-plan.ts and src/session-manager.ts re-export, unchanged", () => {
    expect(startupSummaryEnding).toBe(summaryEndingModule.startupSummaryEnding)
    expect([DESTRUCTIVE_PREFIX, REMOVED_RETIRED_CLAUSE, DESTRUCTIVE_RETIRED_CLAUSE]).toEqual([
      previewClauses.DESTRUCTIVE_PREFIX,
      previewClauses.REMOVED_RETIRED_CLAUSE,
      previewClauses.DESTRUCTIVE_RETIRED_CLAUSE,
    ])
  })

  test("a persona's removal line (Checks 27 and 28) is the package's retired removal line, never the old 'will be destroyed' one", () => {
    const n = personaName('d')
    const line = removedPreviewLine('d')
    expect(line).toBe(removedLine({ key: n, name: n, index: 0 }))
    expect(line).not.toContain('destroyed')
  })

  test("the row states the checks read as not live are agent-director's dead states", () => {
    expect([...NOT_LIVE_ROW_STATES].sort()).toEqual([...AGENT_DIRECTOR_DEAD_STATES].sort())
  })

  test("the plan quotes the same texts: every summary ending it gives ends with the builder's last count, it holds the clean ending, Check 1's line and both checks' retired removal lines, and no 'will be destroyed'", () => {
    const plan = readFileSync(join(import.meta.dir, '..', 'testplans', 'b.yko', 'b.yko.md'), 'utf-8')
    const quoted = [...plan.matchAll(/`([^`]*\d+ failed, \d+ not brought up[^`]*)`/g)].map((m) => m[1]!)
    // The builder's last segment (`<n> fresh as retired keys`), its count any number.
    const lastWords = START_SUMMARY_END.split(', ').at(-1)!.replace(/^\d+ /, '')
    expect(quoted.filter((x) => !new RegExp(`, \\d+ ${lastWords}$`).test(x))).toEqual([])
    expect(quoted).toContain(START_SUMMARY_END)
    expect(quoted).toContain(COMPLETE_FIRST_START)
    expect(plan).toContain(removedPreviewLine('d'))
    expect(plan).toContain(removedPreviewLine('c'))
    expect(plan).not.toContain('will be destroyed')
  })

  // -------------------------------------------------------------------------
  // Part 11's copies (invited-checks.ts, live-config.ts, helpers.ts), each
  // pinned once against src/'s builder or constant, called with the checks'
  // own values (b.deo SRI-1501).
  // -------------------------------------------------------------------------

  const CH = 'C0RUNCH001'
  const C_NAME = personaName('c')
  const cPersona = { name: C_NAME, key: C_NAME }
  const namesOf = (letters: readonly PersonaLetter[]) => letters.map(personaName)

  test.each([
    ['fungible', ['a', 'b', 'c']],
    ['fungible', ['a', 'b', 'c', 'd']],
    ['declarative', ['a', 'b', 'c']],
    ['declarative', ['a', 'b', 'c', 'd']],
    ['fungible', []],
    ['declarative', []],
  ] as const)("the switch's preview line, turning %s mode on for %j (Checks 30, 32, 33 and 34)", (mode, letters) => {
    const names = namesOf(letters)
    expect(modeSwitchPreviewLine(mode, names)).toBe(modeSwitchLine(mode, names.map((n, index) => ({ name: n, key: n, index }))))
  })

  describe("the previews of Check 30's edit and of Checks 32 and 33's switch-only edits are src/'s rendering of the same change", () => {
    let home = ''
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'ci-live-previews-'))
    })
    afterEach(() => rmSync(home, { recursive: true, force: true }))

    test.each(STARTING_STATES)("Check 30 from %s: the header, each persona's in-place line and the switch's line", (_what, state) => {
      const before = renderConfig(state())
      const after = jqEdit(home, state(), switchOnFilter(DRY_RUN_IDS))
      const names = (state().personas as { name: string }[]).map((p) => p.name)
      const rendered = renderPreviewLines(srcPlan(before, after))
      expect(switchOnPreview(names).preview).toEqual(rendered)
      for (const n of names) expect(rendered).toContain(invitedInPlaceLine(n))
    })

    test.each([false, true])('the switch-only edit to %p (Check 32 off, Check 33 on)', (on) => {
      const fungible = jqEdit(home, part9State(false), switchOnFilter(DRY_RUN_IDS))
      const before = on ? jqEdit(home, JSON.parse(fungible), switchFilter(false)) : fungible
      const after = jqEdit(home, JSON.parse(before), switchFilter(on))
      expect(switchOnlyPreview(on, namesOf(['a', 'b', 'c']))).toEqual(renderPreviewLines(srcPlan(before, after)))
    })
  })

  test("Check 34's recorded line for a removed invited section, and its no-effective-change preview and reload-noop line", () => {
    expect(invitedRecordedLine(C_NAME)).toBe(recordedLine({ name: C_NAME, key: C_NAME, fields: ['invited'] }))
    const plan: ValidChangePlan = {
      valid: true, added: [], removed: [], destructive: [], inPlace: [], credentials: [], nextLaunch: [], unchanged: [], recorded: [], settings: [],
      noEffectiveChange: true, configDirsChanged: false,
    }
    expect([NO_EFFECTIVE_CHANGE_PREVIEW]).toEqual(renderPreviewLines(plan))
    expect(NO_EFFECTIVE_CHANGE_PREVIEW).toStartWith(`${PENDING_PREVIEW_TITLE} ${NO_EFFECTIVE_CHANGE}:`)
    expect(noopLine()).toBe(renderNoopLogLine(`${S}/config.json.last-applied`))
  })

  test.each([
    ['persona-invited-channel (public, mentions)', INVITED_CHANNEL_CLASS, PERSONA_INVITED_CHANNEL, runnerInvitedChannelCause(CH, 'public', 'mentions'), srcInvitedChannelCause(CH, 'public', 'mentions')],
    ['persona-channel-delivery-set (none to all, at all)', CHANNEL_DELIVERY_SET_CLASS, PERSONA_CHANNEL_DELIVERY_SET, runnerChannelDeliverySetCause(CH, undefined, 'all', 'all'), srcChannelDeliverySetCause(CH, undefined, 'all', 'all')],
    ['persona-channel-delivery-set (mentions to all, at all)', CHANNEL_DELIVERY_SET_CLASS, PERSONA_CHANNEL_DELIVERY_SET, runnerChannelDeliverySetCause(CH, 'mentions', 'all', 'all'), srcChannelDeliverySetCause(CH, 'mentions', 'all', 'all')],
    ["unclaimed-channel (0.11.1's declarative cause)", UNCLAIMED_CHANNEL_CLASS, UNCLAIMED_CHANNEL, runnerUnclaimedChannelCause(CH), srcUnclaimedChannelCause(CH)],
  ])('the %s line C logs', (_what, cls, srcCls, cause, srcCause) => {
    expect([cls, cause]).toEqual([srcCls, srcCause])
    expect(personaLine(cls, 2, C_NAME, cause)).toBe(formatPersonaDiagnostic({ class: srcCls as PersonaDiagnosticClass, ...cPersona, index: 2, cause: srcCause }))
  })

  test("the no-stored-choice word and the reload-nothing-pending class are src/'s", () => {
    expect(runnerChannelDeliverySetCause(CH, undefined, 'all', 'all')).toContain(`from ${NO_STORED_CHOICE} to`)
    expect(NOTHING_PENDING_CLASS).toBe(RELOAD_NOTHING_PENDING)
  })

  test.each([REPLY_TOOL, FETCH_MESSAGES_TOOL, REACT_TOOL, EDIT_MESSAGE_TOOL])("Check 33's tool error for a %s call Slack refuses, and the code read back from it", (tool) => {
    for (const code of ['not_in_channel', 'channel_not_found']) {
      const text = slackRefusalToolErrorText(tool, cPersona, CH, code)
      expect(slackRefusalText(tool, C_NAME, CH, code)).toBe(text)
      expect(slackRefusalCode(tool, C_NAME, CH, text)).toBe(code)
    }
    // A failure with no Slack code, another tool's or channel's error, and no error are no Slack refusal.
    expect(slackRefusalCode(tool, C_NAME, CH, slackRefusalToolErrorText(tool, cPersona, CH, undefined))).toBeNull()
    expect(slackRefusalCode(tool, C_NAME, CH, slackRefusalToolErrorText('download_attachment', cPersona, CH, 'not_in_channel'))).toBeNull()
    expect(slackRefusalCode(tool, C_NAME, CH, slackRefusalToolErrorText(tool, cPersona, 'C0OTHER001', 'not_in_channel'))).toBeNull()
    expect(slackRefusalCode(tool, C_NAME, CH, null)).toBeNull()
    // Found inside a wrapper the client adds, as Check 16 reads a refused call; any code src/ quotes is read.
    for (const code of ['Not_In$Channel', '$', 'a'.repeat(64)]) {
      expect(slackRefusalCode(tool, C_NAME, CH, `<tool_use_error>${slackRefusalToolErrorText(tool, cPersona, CH, code)}</tool_use_error>`)).toBe(code)
    }
    // A code src/ would not quote is no Slack refusal.
    for (const code of ['not-in-channel', '1code', 'a'.repeat(65)]) expect(slackRefusalCode(tool, C_NAME, CH, slackRefusalToolErrorText(tool, cPersona, CH, code))).toBeNull()
  })

  test("the Slack code Check 33 reads is src/'s short identifier, the only kind slackPlatformReason passes to the tool error", () => {
    const runner = new RegExp(`^${SLACK_CODE_PATTERN}$`)
    for (const code of ['not_in_channel', 'Not_In$Channel', '$', '_x', 'a'.repeat(64), 'a'.repeat(65), '1code', 'not-in-channel', 'a b', '']) {
      expect([code, runner.test(code)]).toEqual([code, isSafeIdentifier(code)])
    }
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'persona-connection-errors.ts'), 'utf-8')
    expect(source).toContain(`const SAFE_IDENTIFIER_RE = /^${SLACK_CODE_PATTERN}$/\n`)
  })

  test("the setting names live-config.ts writes: the switch's key, invited and its permission_prompts, and \"dm\"", () => {
    expect(SWITCH_KEY).toBe(MODE_SWITCH_SETTING)
    expect(PERSONA_TOP_LEVEL_KEYS).toContain(SWITCH_KEY)
    expect(PERSONA_ENTRY_KEYS).toContain(INVITED_KEY as never)
    expect([...PERSONA_INVITED_KEYS]).toEqual([INVITED_PERMISSION_PROMPTS_KEY])
    expect(RUNNER_DM_DESTINATION).toBe(DM_DESTINATION)
  })

  test('the tool names the checks and the tool-call reader match, and the inputs the reader reads, are the session tools the package lists', async () => {
    expect(RUNNER_SET_CHANNEL_DELIVERY_TOOL).toBe(SET_CHANNEL_DELIVERY_TOOL)
    expect(CSCB_MCP_SERVER_NAME).toBe(MCP_SERVER_NAME)
    const entry = { cwd: '', personaKey: '', transport: {}, server: {}, connected: false, peerPort: 0 } as unknown as SessionEntry
    const server = createSessionServer(entry, {} as SessionToolDeps)
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    const client = new Client({ name: 'ci-live-checks', version: '1.0.0' }, { capabilities: {} })
    await client.connect(clientSide)
    try {
      const { tools } = await client.listTools()
      const inputs = Object.fromEntries(tools.map((t) => [t.name, Object.keys(t.inputSchema.properties ?? {})]))
      for (const [tool, read] of [
        [REPLY_TOOL, ['chat_id']],
        [REACT_TOOL, ['chat_id', 'message_id']],
        [EDIT_MESSAGE_TOOL, ['chat_id', 'message_id']],
        [FETCH_MESSAGES_TOOL, ['channel', 'thread_ts']],
        [RUNNER_SET_CHANNEL_DELIVERY_TOOL, ['channel', 'delivery']],
      ] as const) {
        expect([tool, read.filter((input) => !(inputs[tool] ?? []).includes(input))]).toEqual([tool, []])
      }
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('parsePending splits the pending file the package writes', () => {
    expect(PENDING_HEADER).toBe(PENDING_FILE_HEADER)
    const fingerprint = `fingerprint: sha256:${'0'.repeat(64)}`
    const text = [PENDING_FILE_HEADER, fingerprint, '', previewHeader({ settings: 1 }), 'line two', ''].join('\n')
    const pending = parsePending(text)
    expect(pending).toEqual({ header: PENDING_FILE_HEADER, fingerprint, preview: [previewHeader({ settings: 1 }), 'line two'] })
    const f = new Findings()
    checkPreview(f, pending!, [previewHeader({ settings: 1 }), 'line two'])
    expect(f.failures).toEqual([])
    checkPreview(f, { ...pending!, fingerprint: 'fingerprint: none' }, ['other'])
    expect(f.failures.length).toBe(2)
    expect(parsePending('one\ntwo\nnot blank\nfour')).toBeNull()
    expect(parsePending('short')).toBeNull()
  })

  // -------------------------------------------------------------------------
  // The plan agrees with the runner: its Results header, Check 29a's file
  // list, Part 2.1's copy of the tool-call reader, and the texts Part 11
  // quotes, each rendered by the runner with the plan's placeholders.
  // -------------------------------------------------------------------------

  describe('the plan agrees with the runner', () => {
    const PLAN = 'testplans/b.yko/b.yko.md'
    const plan = readFileSync(join(import.meta.dir, '..', PLAN), 'utf-8')
    /** The plan's section under the heading `match` names. */
    const block = (match: HeadingMatch): string => requiredSection(plan, match, PLAN)
    /** A Markdown table row's cells. */
    const cells = (row: string) => row.replace(/^\||\|$/g, '').split('|')
    /** `text` as the plan quotes it: one backticked span. */
    const quoted = (text: string) => `\`${text}\``

    test("the Results table's header is the one results.md renders from RESULTS_COLUMNS, and every row under it has as many cells", () => {
      const summary: RunSummary = { runId: '1700000000', mode: 'dry-run', date: '', build: '', hostUser: '', verdict: 'PASS', results: [], notes: [] }
      const header = renderResultsMarkdown(summary).split('\n').find((l) => l.startsWith('| Date |'))
      const [planHeader, separator, ...rows] = block('## Results').split('\n').filter((l) => l.startsWith('|'))
      expect(planHeader).toBe(header!)
      expect(separator).toMatch(/^\|(?:-+\|)+$/)
      expect(rows.length).toBeGreaterThan(0)
      for (const row of [separator!, ...rows]) expect(cells(row).length).toBe(cells(header!).length)
    })

    test("Check 29a step 1's F=(…) list is the runner's state files (CHECK29A_STATE_FILES), in order", () => {
      const lists = [...block(/^## Part 12:/).matchAll(/^\s*F=\((.*)\)$/gm)].map((m) => m[1]!.split(' '))
      expect(lists).toEqual([[...CHECK29A_STATE_FILES]])
    })

    test("Part 2.1's toolcalls reads the runner's server name with the runner's jq filter (toolCallsScript)", () => {
      const between = (text: string, from: string, to: string) => {
        const start = text.indexOf(from)
        expect(start).toBeGreaterThan(-1)
        return text.slice(start + from.length, text.indexOf(to, start + from.length)).replace(/\s+/g, ' ').trim()
      }
      const planCopy = block(/^### 2\.1 /)
      const runner = toolCallsScript('c', REPLY_TOOL)
      expect(planCopy).toContain(`--arg server ${CSCB_MCP_SERVER_NAME} --arg tool "$2" '`)
      expect(between(planCopy, `--arg tool "$2" '`, `' "$t"`)).toBe(between(runner, `--arg tool ${q(REPLY_TOOL)} '`, `' "$t"`))
    })

    describe("Part 11 quotes the runner's texts, rendered with the plan's placeholders", () => {
      const RUN = '<RUN_CHANNEL_ID>'
      const CODE = '<SLACK_ERROR_CODE>'
      const PLAN_IDS = { ...DRY_RUN_IDS, aHome: '<A_HOME_CHANNEL_ID>', dHome: '<D_HOME_CHANNEL_ID>' }
      /** A line naming the container's state directory, as the plan writes it. */
      const planPath = (line: string) => line.replaceAll(`${S}/config.json`, '<path of config.json>')
      const [a, b, c, d] = (['a', 'b', 'c', 'd'] as const).map(personaName) as [string, string, string, string]
      const ABC = [a, b, c]
      const part11 = block(/^## Part 11:/)
      const check = (id: string) => block(new RegExp(`^### Check ${id}:`))
      /** Check 34's views: the copy (declarative, no invited section) and the record with the switch on or off. */
      const COPY = { on: false, personas: ABC.map((name) => ({ name, invited: 'null' })) }
      const record = (on: boolean) => ({ on, personas: ABC.map((name) => ({ name, invited: JSON.stringify({ permission_prompts: 'dm' }) })) })
      /** One case per line of `texts`, quoted by Check `id`. */
      const lines = (id: string, label: string, texts: readonly string[]) => texts.map((t, i): [string, string, string] => [id, `${label}, line ${i + 1}`, t])

      test('the placeholders are the ones Part 1.2 lists', () => {
        const placeholders = block(/^### 1\.2 /)
        for (const p of [RUN, CODE, PLAN_IDS.aHome, PLAN_IDS.dHome, '<C_ANSWER_TS>']) expect(placeholders).toContain(quoted(p))
      })

      test.each<[string, string, string]>([
        ...lines('30', 'the switch-on preview with A, B and C', switchOnPreview(ABC).preview),
        ['30', "D's in-place line", invitedInPlaceLine(d)],
        ['30', 'the reload-applied line', planPath(appliedLine(switchOnPreview(ABC).counts))],
        ['30', 'the persona-invited-channel line', personaLine(INVITED_CHANNEL_CLASS, 2, c, runnerInvitedChannelCause(RUN, 'public', 'mentions'))],
        ['31', 'the persona-channel-delivery-set line', personaLine(CHANNEL_DELIVERY_SET_CLASS, 2, c, runnerChannelDeliverySetCause(RUN, undefined, 'all', 'all'))],
        ...lines('32', 'the switch-off preview', switchOnlyPreview(false, ABC)),
        ['32', 'the reload-applied line', planPath(appliedLine({ settings: 1 }))],
        ['32', 'the unclaimed-channel line', personaLine(UNCLAIMED_CHANNEL_CLASS, 2, c, runnerUnclaimedChannelCause(RUN))],
        ['33', "the reply call's refusal", slackRefusalText(REPLY_TOOL, c, RUN, CODE)],
        ['33', "the fetch_messages call's refusal", slackRefusalText(FETCH_MESSAGES_TOOL, c, RUN, CODE)],
        ...lines('34', 'the restore preview, the switch on in the record', restorePreview(COPY, record(true)).preview),
        ['34', 'the restore outcome, the switch on in the record', planPath(restorePreview(COPY, record(true)).outcome)],
        ...lines('34', 'the restore preview, the switch off in the record', restorePreview(COPY, record(false)).preview),
        ['34', 'the restore outcome, the switch off in the record', planPath(restorePreview(COPY, record(false)).outcome)],
        ['34', 'the nothing-pending class', NOTHING_PENDING_CLASS],
      ])('Check %s quotes %s', (id, _what, text) => {
        expect(check(id)).toContain(quoted(text))
      })

      test("Check 30's variant with D still declared: the header's in-place count and the switch line's added ending", () => {
        const [abcHeader, ...abcRest] = switchOnPreview(ABC).preview
        const [abcdHeader, ...abcdRest] = switchOnPreview([a, b, c, d]).preview
        const abcSwitch = abcRest.at(-1)!
        const abcdSwitch = abcdRest.at(-1)!
        expect(abcdHeader).toBe(abcHeader!.replace('3 modified in place', '4 modified in place'))
        expect(appliedLine(switchOnPreview([a, b, c, d]).counts)).toContain('4 modified in place')
        expect(abcdSwitch.startsWith(abcSwitch.slice(0, -1))).toBe(true)
        expect(check('30')).toContain(quoted('4 modified in place'))
        expect(check('30')).toContain(quoted(abcdSwitch.slice(abcSwitch.length - 1)))
      })

      test("Check 33's switch-on preview is Check 32's with the mode words swapped, and its edit is the switch alone", () => {
        const [off, on] = ['declarative', 'fungible'].map((mode) => `turns ${mode} mode on`) as [string, string]
        expect(switchOnlyPreview(true, ABC)).toEqual(switchOnlyPreview(false, ABC).map((l) => l.replace(off, on)))
        expect(check('33')).toContain(`${quoted(on)} in place of ${quoted(off)}`)
        expect(check('33')).toContain(quoted(switchFilter(true)))
      })

      test("Check 33's residual notes: the form, each call and each of the five outcomes", () => {
        const outcomes: RecordedOutcome[] = [{ kind: 'accepted' }, { kind: 'refused', code: CODE }, { kind: 'refused', code: null }, { kind: 'unanswered' }, { kind: 'not-made' }]
        const [call] = CHECK33_RECORDED_CALLS
        const prefix = residualNote(call, { kind: 'accepted' }).replace(/accepted$/, '')
        expect(check('33')).toContain(quoted(`${prefix.replace(call, '<call>')}<outcome>`))
        for (const x of CHECK33_RECORDED_CALLS) expect(check('33')).toContain(quoted(x))
        for (const o of outcomes) expect(check('33')).toContain(quoted(residualNote(call, o).slice(prefix.length)))
      })

      test("the commands Part 11 gives: Check 30's copy and switch-on filter, Checks 32 and 34's switch read, Check 32's switch-off edit and the run channel's name", () => {
        expect(check('30')).toContain(`cp "$S/config.json" ${CONFIG_COPY}`)
        expect(check('30')).toContain(`jq '${switchOnFilter(PLAN_IDS)}'`)
        expect(check('32')).toContain(`jq '${switchFilter(false)}'`)
        for (const id of ['32', '34']) expect(check(id)).toContain(`jq -c '${SWITCH_VALUE_JQ}' "$S/config.json.last-applied"`)
        expect(check('34')).toContain(`if guard; then cp ${CONFIG_COPY} "$S/config.json"; fi`)
        expect(part11).toContain(quoted(runChannelName('')))
      })
    })
  })
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('check helpers', () => {
  test.each([`it's`, '$(touch /nonexistent/x) `id` $HOME', "'; echo pwned #", 'two\nlines', ''])('q(%p) is one literal shell word', (value) => {
    const bash = Bun.which('bash')!
    const home = mkdtempSync(join(tmpdir(), 'ci-live-q-'))
    try {
      // bash's own directory stays on PATH, so a word q failed to quote would still run its command.
      const r = Bun.spawnSync([bash, '-c', `printf %s ${q(value)}`], { env: hostSafeChildEnv(home, { tools: ['bash'] }) })
      expect([r.exitCode, r.stdout.toString()]).toEqual([0, value])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test.each([
    ['Hello, WORLD!', 'world', true],
    ['pineapple', 'apple', false],
    ['a re-run', 'run', false],
    ['echo: a.b done', 'a.b', true],
    ['xa.b', 'a.b', false],
  ])('hasWord(%p, %p) is %p', (text, word, expected) => {
    expect(hasWord(text, word)).toBe(expected)
  })

  test.each([
    [{ ts: '1.000001', text: '*Permission* — Allowed' }, 'allowed', false],
    [{ ts: '1.000001', text: '*Permission* — Denied by operator' }, 'denied', false],
    [{ ts: '1.000001', text: 'Bash wants to run', blocks: [{ elements: [{ text: { text: 'Allow' } }, { text: { text: 'Deny' } }] }] }, 'open', true],
    [{ ts: '1.000001', text: 'permission request: Bash' }, 'other', true],
    [{ ts: '1.000001', text: 'hello' }, 'other', false],
  ])('promptState(%j) is %p', (message, state, prompt) => {
    expect([promptState(message), isPrompt(message)] as unknown[]).toEqual([state, prompt])
  })

  test('tagAttr, expectOneTag and rawShape read IDs only', () => {
    const tag = '<channel source="slack" chat_id="C0DRYCOORD" user_id="U0DRYBOTA0" via="broadcast">'
    expect([tagAttr(tag, 'via'), tagAttr(tag, 'thread_ts')]).toEqual(['broadcast', null])
    const f = new Findings()
    expectOneTag(f, [tag], 'tags b TS', { via: 'broadcast', chat_id: 'C0DRYCOORD' }, { user_id: 'U0DRYBOTA0' })
    expect(f.failures).toEqual([])
    expectOneTag(f, [tag], 'x', { via: 'mention' }, { user_id: 'U0OTHER000', bot_id: 'B0OTHER000' })
    expectOneTag(f, [], 'y', {})
    expect(f.failures).toEqual(['x: via is broadcast, not mention', 'x: the tag\'s author is not U0OTHER000 / B0OTHER000', 'y: expected exactly one tag, found 0'])
    const token = fakeToken(BOT_TOKEN_PREFIX)
    const shape = rawShape(`RAW message event persona=persona_b: {"user":"U0A","bot_id":"B0A","bot_profile":{"x":1},"text":"${token}"}`)
    expect(shape).toEqual({ user: 'U0A', bot_id: 'B0A', subtype: 'absent', app_id: 'absent', bot_profile: 'present' })
    assertNoLeak(shape)
  })

  test("judgeLimitLines (Check 12's search): message-text lines are skipped, the known Slack rate-limit lines are notes, anything else fails", () => {
    const skipped = [
      '12:[slack] RAW message event persona=persona_b: {"text":"what is the limit of 7 times 6?"}',
      '13:[slack] Dispatching to persona "persona_a" (key=persona_a) chat_id=C0DRYCOORD text=no limit here',
    ]
    const rateLimit = [
      '20:[WARN]  web-api:WebClient:0 API Call failed due to rate limiting. Will retry in 3 seconds.',
      '21:[slack] A rate limit was exceeded (url: chat.postMessage, retry-after: 3)',
      '22:[slack] reactions.add failed: ratelimited',
    ]
    const other = ['30:[slack] bot-to-bot loop guard dropped a message', '31:[slack] Slack rate limited: retry-after 3', '32:throttled persona_b', '33:too many messages']
    expect(judgeLimitLines([...skipped, ...rateLimit, ...other])).toEqual({ failures: other, notes: rateLimit })
  })

  test('waitTags polls `tags` until it prints, then reads once more a poll later (a late duplicate counts); at the deadline it gives none', async () => {
    const tag = '<channel source="slack" chat_id="C0DRYCOORD" user_id="U0DRYBOTA0" via="mention">'
    let calls = 0
    const answers = ['', '', tag, `${tag}\n${tag}`]
    const clock = virtualClock()
    const c = fakeContainer([["tags b '1700000200.000001'", () => answers[calls++] ?? '']])
    const start = clock.now()
    expect(await waitTags(makeCtx({ container: c.container, clock }), 'b', '1700000200.000001')).toEqual([tag, tag])
    expect([calls, clock.now() - start]).toEqual([4, 15_000])

    const silent = virtualClock()
    const at = silent.now()
    expect(await waitTags(makeCtx({ clock: silent }), 'b', '1700000200.000001')).toEqual([])
    expect(silent.now() - at).toBe(TAG_TIMEOUT_MS)
  })

  test('liveIdsFrom names what apps.json lacks, and gives the IDs when it is complete', () => {
    expect(liveIdsFrom(emptyAppsState())).toBe(
      'apps.json is incomplete (persona a, persona b, persona c, persona d, team_id, human_user_id, channels): run the provisioning first',
    )
    const full = {
      version: 1 as const,
      team_id: DRY_RUN_IDS.teamId,
      human_user_id: DRY_RUN_IDS.humanUserId,
      personas: Object.fromEntries(Object.entries(DRY_RUN_IDS.bots).map(([l, b]) => [l, { app_id: b.appId, bot_user_id: b.userId, bot_id: b.botId }])),
      channels: { 'a-home': DRY_RUN_IDS.aHome, coordination: DRY_RUN_IDS.coordination, 'd-home': DRY_RUN_IDS.dHome },
    }
    expect(liveIdsFrom(full)).toEqual(DRY_RUN_IDS)
    delete (full.personas as Record<string, { bot_id?: string }>).c!.bot_id
    expect(liveIdsFrom(full)).toBe('apps.json is incomplete (persona c): run the provisioning first')
  })
})

// ---------------------------------------------------------------------------
// The transcript helpers `tags` and `tagstext`, run by bash over a fixture
// ---------------------------------------------------------------------------

describe("tags and tagstext over a transcript (the container's helpers and the plan's Part 1.3 copy)", () => {
  const REPO = join(import.meta.dir, '..')
  const containerHelpers = readFileSync(join(REPO, 'docker', 'live', 'cscb-live-helpers.sh'), 'utf-8')
  const planHelpers = (() => {
    const plan = readFileSync(join(REPO, 'testplans', 'b.yko', 'b.yko.md'), 'utf-8')
    const start = plan.indexOf("cat > ~/cscb-live-helpers.sh <<'EOF'\n")
    return plan.slice(start, plan.indexOf('\nEOF\n', start) + 1)
  })()

  /** The `name() { … }` definition in a helpers file, up to its closing `}` line. */
  function shellFunction(source: string, name: string): string {
    const start = source.indexOf(`\n${name}() {\n`)
    if (start < 0) throw new Error(`no ${name}() in the helpers`)
    return source.slice(start + 1, source.indexOf('\n}\n', start) + 3)
  }

  const TS = { idle: '1700000100.000001', midTurn: '1700000100.000002', blocks: '1700000100.000003', userBlocks: '1700000100.000004' }
  const tag = (ts: string, via: string) => `<channel source="slack" chat_id="${COORD}" user_id="${DRY_RUN_IDS.humanUserId}" ts="${ts}" via="${via}">`
  const body = (ts: string, via: string, text: string) => `${tag(ts, via)}\n${text}\n</channel>`
  const midTurn = body(TS.midTurn, 'receive_all', 'Window check two.')
  /**
   * One message delivered while A was idle (a user entry), one mid-turn (its
   * queue entries, then a queued_command attachment with a string prompt),
   * one mid-turn with content blocks, one user entry with content blocks,
   * and entries that are no delivery: a tool result, another attachment
   * type holding a tag, an attachment that is not an object, and A quoting
   * a tag.
   */
  const TRANSCRIPT = [
    { type: 'user', message: { role: 'user', content: body(TS.idle, 'mention', 'Idle delivery.') } },
    { type: 'queue-operation', operation: 'enqueue', content: midTurn },
    { type: 'queue-operation', operation: 'remove', content: midTurn },
    { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: midTurn } },
    {
      type: 'attachment',
      attachment: { type: 'queued_command', commandMode: 'prompt', prompt: [{ type: 'text', text: body(TS.blocks, 'mention', 'Blocks prompt.') }, { type: 'image', source: {} }] },
    },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: body(TS.userBlocks, 'broadcast', 'Blocks user entry.') }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } },
    { type: 'attachment', attachment: { type: 'prompt_snapshot', prompt: midTurn } },
    { type: 'attachment', attachment: 'not an object' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `I saw ${tag(TS.idle, 'mention')}` }] } },
  ]

  let home = ''
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ci-live-tags-'))
    const dir = join(home, '.claude', 'projects', '-home-testuser-cscb-live-a')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '0f0f0f0f-session.jsonl'), TRANSCRIPT.map((e) => JSON.stringify(e)).join('\n') + '\n')
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  /** What `tags` and `tagstext` run by name. */
  const HELPER_TOOLS = ['bash', 'ls', 'head', 'jq', 'grep']

  /** Run one helper, defined from `source`, in bash with the fixture home; its output lines. */
  function helper(source: string, ...args: string[]): string[] {
    const defs = `${shellFunction(source, 'tags')}\n${shellFunction(source, 'tagstext')}`
    const r = Bun.spawnSync([Bun.which('bash')!, '-c', `${defs}\n"$@"`, 'helpers', ...args], { env: hostSafeChildEnv(home, { tools: HELPER_TOOLS }) })
    expect(r.stderr.toString()).toBe('')
    return r.stdout.toString().split('\n').filter((l) => l !== '')
  }

  const SOURCES = [
    ['docker/live/cscb-live-helpers.sh', containerHelpers],
    ["the plan's Part 1.3", planHelpers],
  ] as const

  test.each(SOURCES)('%s: tags prints one tag per delivery, from a user entry or a queued_command attachment, string or blocks alike', (_where, source) => {
    expect(helper(source, 'tags', 'a', TS.idle)).toEqual([tag(TS.idle, 'mention')])
    // Mid-turn: the attachment only, not the queue entries or the prompt snapshot that hold the same text.
    expect(helper(source, 'tags', 'a', TS.midTurn)).toEqual([tag(TS.midTurn, 'receive_all')])
    expect(helper(source, 'tags', 'a', TS.blocks)).toEqual([tag(TS.blocks, 'mention')])
    expect(helper(source, 'tags', 'a', TS.userBlocks)).toEqual([tag(TS.userBlocks, 'broadcast')])
    expect(helper(source, 'tags', 'a', '1700000100.000009')).toEqual([])
  })

  test.each(SOURCES)('%s: tagstext finds the tag of a message by its text, in a queued_command attachment too', (_where, source) => {
    expect(helper(source, 'tagstext', 'a', 'Window check two.')).toEqual([tag(TS.midTurn, 'receive_all')])
    expect(helper(source, 'tagstext', 'a', 'Blocks prompt.')).toEqual([tag(TS.blocks, 'mention')])
    expect(helper(source, 'tagstext', 'a', 'Idle delivery.')).toEqual([tag(TS.idle, 'mention')])
    expect(helper(source, 'tagstext', 'a', 'never sent')).toEqual([])
  })

  // Check 14's search for the second user (dm-checks.ts `contactLines`): the
  // two scripts it hands the container, run by bash over the fixture home.
  describe("Check 14's search for the second user in this container's server log and persona transcripts", () => {
    const SECOND_ID = 'U0DRYSECND'
    const secondTag = (ts: string) => `<channel source="slack" chat_id="${DRY_RUN_IDS.aHome}" user_id="${SECOND_ID}" ts="${ts}" via="receive_all">`
    const secondBody = (ts: string) => `${secondTag(ts)}\nHello from the second user.\n</channel>`
    /** What the two scripts run by name. */
    const CONTACT_TOOLS = ['bash', 'cat', 'grep', 'jq']

    /** The log search and the tag search Check 14 runs for `userId`, in that order (the log answer names the ID, so it SKIPs after both). */
    async function contactScripts(userId: string): Promise<[string, string]> {
      const clock = virtualClock()
      const { container, scripts } = fakeContainer([['server.log*', `user=${userId}`]])
      const r = await check14.run(makeCtx({ mode: 'real', clock, second: { human: scriptedHuman(clock).human, userId }, container }))
      expect(r.status).toBe('SKIPPED')
      expect(scripts.length).toBe(2)
      return [scripts[0]!, scripts[1]!]
    }

    /** Run one script as the container's `sh` does (bash, `S` set as the helpers set it) in the fixture home; its output lines. */
    function inContainer(script: string): string[] {
      // The helpers' own `S=` line (the server's state dir under the container user's home), found when the case runs.
      const stateLine = /^S=.*$/m.exec(containerHelpers)?.[0]
      expect(stateLine).toBeDefined()
      const r = Bun.spawnSync([Bun.which('bash')!, '-c', `${stateLine}\n${script}`], { env: hostSafeChildEnv(home, { tools: CONTACT_TOOLS }) })
      expect(r.stderr.toString()).toBe('')
      return r.stdout.toString().split('\n').filter((l) => l !== '')
    }

    /** A transcript of `entries` at `~/.claude/projects/<dir>/<file>`. */
    function transcript(dir: string, file: string, entries: unknown[]): void {
      mkdirSync(join(home, '.claude', 'projects', dir), { recursive: true })
      writeFileSync(join(home, '.claude', 'projects', dir, file), entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
    }

    test.each(SOURCES)("%s: the tag search reads a transcript with tags()'s own jq filter (the two cannot drift)", async (_where, source) => {
      const filter = (script: string) => /jq -r '([^']*)'/.exec(script)?.[1]?.replace(/\s+/g, ' ')
      const [, tagScript] = await contactScripts(SECOND_ID)
      expect(filter(tagScript)).toBeDefined()
      expect(filter(tagScript)).toBe(filter(shellFunction(source, 'tags'))!)
    })

    test("over one persona's transcript the tag search prints exactly the tags tags() prints for each delivered message, in order", async () => {
      const [, tagScript] = await contactScripts(DRY_RUN_IDS.humanUserId)
      const byTs = [TS.idle, TS.midTurn, TS.blocks, TS.userBlocks].flatMap((ts) => helper(containerHelpers, 'tags', 'a', ts))
      expect(byTs.length).toBe(4)
      expect(inContainer(tagScript)).toEqual(byTs)
    })

    test('it reads every rotated server.log* and every transcript of every persona, and nothing else; priorContact counts what names the whole ID', async () => {
      const state = join(home, '.claude', 'channels', 'slack')
      mkdirSync(state, { recursive: true })
      const current = `[slack] Dispatching to persona "persona_c" (key=persona_c) chat_id=${DRY_RUN_IDS.aHome} user=${SECOND_ID}`
      const rotated = `[slack] dropped message user=${SECOND_ID} channel=C0DRYOTHER`
      const longer = `[slack] dropped message user=${SECOND_ID}9 channel=C0DRYOTHER`
      writeFileSync(join(state, 'server.log'), `[slack] started\n${current}\n[slack] dropped message user=U0DRYOTHER\n`)
      writeFileSync(join(state, 'server.log.1'), `${rotated}\n`)
      writeFileSync(join(state, 'server.log.2'), `${longer}\n`)
      // Persona c: an earlier transcript (a user entry) and the current one (a queued_command attachment), whose
      // queue entry and A's quote of a tag are no delivery; a project that is no persona's is not read.
      transcript('-home-testuser-cscb-live-c', '1-earlier.jsonl', [{ type: 'user', message: { role: 'user', content: secondBody('1700000200.000001') } }])
      transcript('-home-testuser-cscb-live-c', '2-current.jsonl', [
        { type: 'queue-operation', operation: 'enqueue', content: secondBody('1700000200.000002') },
        { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: secondBody('1700000200.000002') } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `I saw ${secondTag('1700000200.000003')}` }] } },
      ])
      transcript('-home-testuser-elsewhere', 'other.jsonl', [{ type: 'user', message: { role: 'user', content: secondBody('1700000200.000004') } }])

      const [logScript, tagScript] = await contactScripts(SECOND_ID)
      const log = inContainer(logScript)
      const tagLines = inContainer(tagScript)
      expect(log).toEqual([current, rotated, longer])
      expect(tagLines).toEqual([secondTag('1700000200.000001'), secondTag('1700000200.000002')])
      expect(priorContact(log, tagLines, SECOND_ID)).toBe(
        "this run's server has already seen the second account (2 server log line(s) and 2 persona tag(s) name its user ID before the check posted); it is no longer a first-time user",
      )
    })

    test('a fresh container (no server log yet, no transcript naming the ID): both searches print nothing and fail on nothing', async () => {
      const [logScript, tagScript] = await contactScripts(SECOND_ID)
      expect([inContainer(logScript), inContainer(tagScript)]).toEqual([[], []])
    })
  })
})
