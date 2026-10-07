/**
 * shipped-docs.test.ts — the shipped-description audit (b.av2 SR-13.5): what
 * the package ships to the operator and to bot instances describes personas
 * and nothing else. It backs the SR-14 `shipped-docs` rows for AC 39, AC 46
 * and AC 74.
 *
 * Covers:
 * - the Slack app manifest (AC 39, SR-4.3, SR-12): `im:write` and the pinned
 *   scopes and events, and its comments;
 * - the README's modify-semantics table (SR-12, SR-8.6), held against the
 *   change plan's exported classes in src/reload-plan.ts, the switch's row
 *   and the recorded row among them, each "Kept", and the server-wide row
 *   naming the switch as its exception (b.deo SRI-805, SRI-1103), the new
 *   rows self-checked on edited copies;
 * - the README persona reference (SR-12, b.deo SRI-1101): its key tables
 *   list exactly the loader's keys, and its two complete examples, one per
 *   channel mode, load through the real loader and are complete for their
 *   mode;
 * - the README's pointers to the setup wizard;
 * - the shipped-text audit (AC 46) over `SHIPPED_TEXTS` (the README, every
 *   file under `skills/`, the whole manifest, the setup wizard's packaged
 *   credentials script, the MCP instructions read
 *   through `MCP_INSTRUCTIONS` exported by src/registry.ts, the Slack Reply
 *   Guard's reminder text, the crontable template header, and
 *   `set_channel_delivery`'s texts read through their src/registry.ts
 *   exports, each builder rendered with fixed samples in each of its forms,
 *   with a membership case built from the module's exports (b.deo
 *   SRI-1308); the five 0.11.1 tools' descriptions are built inline and not
 *   read): no
 *   first-@mention claim (SR-12), and no term of `FORBIDDEN_TERMS` (the
 *   pre-persona shape, the token environment variables and command-line
 *   tokens, the access-control file, the retired name-rule wording). The
 *   exemptions (`AUDIT_EXCEPTIONS`) are exactly three: the debugging skill's
 *   SR-1.7 entry, and one entry per README runbook section, each exempting
 *   `access.json` only, and only inside "Switching over to agent-director
 *   Phase 1" (which saves the previous CSCB's file) or "Rolling back the
 *   switch-over" (which restores it) (b.jg5 SRJ-1108, SRJ-1109, SRJ-1516).
 *   Every other term stays banned inside those sections, the token
 *   variables' names included; a missing heading fails the audit;
 * - the README's receiving section (SR-12, SR-4.4): its table's row for each
 *   `via` value shows that value, and both injected kinds' rows show none;
 * - the MCP instructions carry no reload wording (AC 74, SR-8.8);
 * - the MCP instructions and the Reply Guard's reminder text name no
 *   spelling of `clear-latch` (AC 47, b.jg5 SRJ-511); the README and the
 *   skills may, for the operator;
 * - the two agent-director refusal classes, `ad-below-phase1-floor` and
 *   `ad-system-install-too-old` (b.jg5 SRJ-208): the debugging skill has an
 *   entry per label inside its refusal section and README "Startup errors" a
 *   line per label, each naming the switch-over runbook section by its title;
 *   neither the refusal section nor a README line carries an upgrade form
 *   (tests/test-helpers/upgrade-forms.ts, self-checked here; the runtime-stop
 *   remedy's `agent-director serve` span removed first, ruling C-1,
 *   SRJ-1104); exactly one
 *   README heading, under `## Migration`, carries the title the refusals
 *   name (replacing E2's no-link case), and every link into that section
 *   from the README and the two skills resolves;
 * - the switch-over runbook, README "Switching over to agent-director
 *   Phase 1" (b.jg5 SRJ-1108; the E2-gate and E5 hatch notes): its steps
 *   1–11 read in order by the shared step reader (`runbookSteps`,
 *   tests/test-helpers/runbooks.ts), one named case per
 *   SRJ-1108 element over each carrier (`SWITCH_OVER_CARRIERS`: the README
 *   section and the CHANGELOG release entry's copy), the
 *   negative and order checks, the "Arrived here from a startup refusal?"
 *   block's ordered elements and branches, the publishing-host block, the
 *   sections the runbook replaced or kept, and the reader's self-checks.
 *   Values CSCB defines are imported; agent-director vocabulary CSCB defines
 *   nowhere sits in `AD_VOCABULARY`, each row citing its source;
 * - the rollback runbook, README "Rolling back the switch-over" (b.jg5
 *   SRJ-1109; hatch A3): exactly one `###` heading under `## Migration`,
 *   after the switch-over section; its steps 1–9 read in order by the same
 *   step reader, one named case per SRJ-1109 element over each carrier
 *   (`ROLLBACK_CARRIERS`, the same two), the order rows (steps 6, 8 and 9), the cross-step
 *   rows ("Operator actions" named by title; no `tmux kill-session` and no
 *   finished-row option are E36 T4's whole-file checks), step 8's
 *   no-conversion-tool check, and ruling C-2: the
 *   switch-over refusal block's pointers to the rollback runbook and its
 *   step 8 are links that resolve, as are the runbooks' other links and the
 *   registry-install runbook's scope note links to both sections.
 * - `OPERATOR_TEXTS` (b.jg5 SRJ-1101's seven operator texts: the README, the
 *   debugging, install and setup skills, docs/architecture.md,
 *   docs/engineering-guide.md and CHANGELOG.md), read for SRJ-1107's checks:
 *   no "Upgrade steps" heading or link and no "checks its tmux session first"
 *   in any of them; the CHANGELOG release entry (the 0.11.0 entry, found by
 *   its version and publish date, never by its place; it alone holds the
 *   runbook copies) and its elements, one case each
 *   (exactly one unreleased entry, first; the breaking note's parts; the
 *   retired access file kept until rollback is no longer wanted and never
 *   deleted; the relaunch through agent-director; the dropped tmux-commands
 *   note; the prefix-key reason without the old agent-director version; the
 *   fresh-once note's runbook pointer), each self-checked against b.ob2's
 *   wording; the names the hatch-note entries introduce, through their `src/`
 *   exports; the two runbook copies, which join `SWITCH_OVER_CARRIERS` and
 *   `ROLLBACK_CARRIERS`, name the README as the maintained copy and match it
 *   word for word; and every CHANGELOG link resolves (hatch A3).
 * - Bug b.7sd (SRD A-19): no operator text, the CHANGELOG read as its
 *   release entry, nor any other shipped skill file or the registry-install
 *   runbook names an agent-director install-gate record (or any gate
 *   record), go line or post-install check line for the operator to read or
 *   write (only step 1's "agent-director ships no install-gate file or
 *   record" passes); self-checked on 0.11.0's runbook wording and on new
 *   forms, a denial by any other "no" among them.
 * - E36 T1's checks, also read through `OPERATOR_TEXTS`: no operator text
 *   quotes a sentence of the *Kill failed* or *Process outlived kill* alert
 *   but its title and closing sentences (the E20 note; both versions rendered
 *   from src/kill-failure-alert.ts with the stub's descriptions, one case per
 *   text and sentence); the README's and the debugging skill's
 *   `auto-restart disabled` lost-message text keeps not saying the persona
 *   will not restart on its own (the E8 note); each self-checked. The E8
 *   note's raw-command advice is checked over every operator text with E36
 *   T4's checks, below.
 * - E36 T2's checks, also read through `OPERATOR_TEXTS`:
 *   - SRJ-1102 (AC 78): the prefix-key reason sentence, built by
 *     `prefixRelatedKeysReason` in its operator-text form, in each carrier's
 *     section (README "Persona name and key", the debugging skill's "Across
 *     personas", the wizard's name step, the engineering guide's
 *     "Configuration", the architecture doc's "Persona config"; the
 *     CHANGELOG's note through its `RELEASE_ENTRY_CHECKS` row); the debugging
 *     skill quotes the validation text the loader renders for `dev` then
 *     `dev_2`; the example `tmux attach -t slack_bot_dev` stands in no
 *     operator text outside those two spans (`PREFIX_KEY_REASON_SPANS`, one
 *     file-local list citing SRJ-1102 and SRJ-1101's exception); and no
 *     operator text says CSCB or agent-director targets a session by prefix
 *     or passes a bare name (`PREFIX_TARGETING_CLAIMS`);
 *   - the E2-gate, E4 and E5 notes over the README: each install-check and
 *     startup-error entry this Task rewrote names the runbook section (the
 *     install check's not-found entry its publishing-host block, by a link
 *     that resolves; the startup gate's not-found entry, which runs on a bot
 *     host, switch-over step 1 by a link that resolves, and no
 *     publishing-host block) and carries no upgrade or re-install form; the catalog entry's
 *     `ErrUnknownErrorName` clause; the state-DB owner entry runs the server
 *     as the owner and never removes the file; the "Bots come back with no
 *     memory" paragraph and the `resume_enabled` row name no pre-floor
 *     version; "Preflight gates" counts its gates and lists SR-2.5 with
 *     `AD_VERSION_CHECK_FAIL_EXIT_CODE` (scripts/ad-version-check.ts) and the
 *     below-floor note; no operator text advises re-installing
 *     agent-director (`UPGRADE_FORMS`' re-install row, whose self-checks sit
 *     with the other rows' under SRJ-208). Each self-checked against the
 *     wording the Task replaced.
 * - E36 T3's checks over docs/architecture.md and docs/engineering-guide.md,
 *   read through `OPERATOR_TEXTS` (b.jg5 SRJ-1105, SRJ-1106, SRJ-612; AC 78;
 *   the passage and presence checks SRJ-1101's term checks cannot express):
 *   - both docs: no tmux call made by the server (a raw session, pane or
 *     server sub-command, `tmux send-keys`, an affirmed raw or direct tmux
 *     call; `SERVER_TMUX_CALLS`, `AFFIRMED_TMUX_CALLS`), no row delete
 *     described as live (`ROW_DELETE_CLAIMS`; a claim passes only when a
 *     negation governs its verb, `negationGoverns`), no dead-state streak, no
 *     incident write-up, and no word of the source audit's
 *     `delete-helper`, `finished-row-option` or `removed-identifier` rules
 *     (`SOURCE_WORD_RULES`, tests/test-helpers/source-audit.ts), the two
 *     delete-helper lists (`DELETE_HELPER_LISTS`, SRJ-716) excepted; none of
 *     the old raw-tmux guidance (its heading, a link to it, the known gap);
 *     every link resolves;
 *   - the engineering guide: SRJ-1106's section states the rule, links
 *     Source Invariants and names the source audit; agent-director's labels
 *     (`AD_VOCABULARY`) only inside it; the Layering section's two rules and
 *     its link to it; the Start Sweep's pre-persona-row rule says the kill is
 *     checked and the row kept;
 *   - the architecture doc: one passage per SRJ-1105 topic
 *     (`SRJ_1105_TOPICS`), each found by the `src/` exports it names
 *     (imported, `exportName`). Each self-checked against the old wording or
 *     a synthetic text.
 * - E36 T4's checks, read through `OPERATOR_TEXTS` (b.jg5 SRJ-1101, SRJ-1103,
 *   SRJ-1104; SRJ-1105 and SRJ-1106 through the term checks; AC 78, AC 79):
 *   - SRJ-1101 over all seven texts, each hit with file and line: none of
 *     `SRJ_1101_TERMS` (`has-session`, `tmux-kill`, `agent-director delete`,
 *     `find-missing --timeout`, `include-finished` and `include_finished`,
 *     `kill-pane`, `kill-server`), wrapped or in any case; `tmux kill-session`
 *     only in switch-over steps 5 and 6 of the two runbook carriers (the
 *     steps' lines cross-checked against `runbookSteps`; `-t =` through the
 *     allow-list); no `tmux attach -t` without `=` outside
 *     `PREFIX_KEY_REASON_SPANS`; no `agent-director kill` with a positional id
 *     and no kill-and-respawn advice (`RAW_COMMAND_FORMS`, the E8 note's two
 *     forms the other checks do not name); every tmux command on the
 *     layering rule's allow-list (`TMUX_ALLOWED_FORMS`: the exact-target
 *     attach, the runbooks' read-only `tmux ls`, `tmux list-windows -a` or
 *     `-t =`, `tmux display-message -p`, and `tmux kill-session -t =`), found
 *     by tmux's command names (`TMUX_COMMAND_NAMES`, citing tmux(1)); no
 *     pane, `read-pane` answer or GONE taken as proof a worker is gone
 *     (SRJ-613; a negation passes only when it governs the claim's verb);
 *     every `agent-director kill --claude-instance-id` (the id after a space
 *     or `=`) named with its result checked, and in the README and the
 *     CHANGELOG with "on an error, don't delete or respawn" (also a row per
 *     runbook step), and no fenced block running `agent-director kill`; the
 *     debugging skill's one-line `read-pane` check, both caveats and the
 *     pointer;
 *   - SRJ-1103 over the README, a row per prerequisite and per section
 *     (`README_SRJ_1103_ROWS`), the Troubleshooting entry of each notice by
 *     its `src/`-rendered title, each SRJ-1013 class under "Startup errors",
 *     the cron line (`AD_VOCABULARY`'s `findMissingCron`), the refusal items
 *     and the runtime-stop paragraph, switch-over steps 1 and 7 linking
 *     "Upgrading to personas" in both carriers;
 *   - SRJ-1104 over the debugging skill, a row per section
 *     (`DEBUG_SKILL_SRJ_1104_ROWS`), each SRJ-1013 class in its section, the
 *     refusal entries, and the runtime-stop remedy's elements
 *     (`RUNTIME_STOP_REMEDY_ROWS`), with no `command -v agent-director` and no
 *     upgrade form once ruling C-1's one span (`RUNBOOK_COMMAND_SPANS`) is
 *     removed. The settings values line and the runtime entry's pointer are
 *     pinned to src output in their own suites (tests/ad-settings.test.ts,
 *     tests/ad-version-gate.test.ts) and by the runtime-stop heading check here.
 *   Each self-checked: every row's items cut one by one from the document
 *   itself (`withItemCut`, only where the row's passage reads them) with the
 *   row's real check run on the edited document, and the rows SRJ-1103's and
 *   SRJ-1104's Test lines name reverted to the old wording.
 * - E39 T5's check of tests/README.md (b.jg5 SRJ-1112), with
 *   tests/integration/ listed read-only: the README names every `test-*.sh`
 *   there and no `test-<n>-<name>.sh` that is not there; no passage about
 *   the start sweep says it deletes, removes or loses a row
 *   (`SWEEP_DELETE_CLAIMS`, read through `affirmedClaims`); its Test 10
 *   passage says the sweep kills live rows, deletes none and records absent
 *   personas' keys as retired, so the rows stay. Each self-checked on
 *   in-memory copies, the old Test 10 passage among them. tests/README.md is
 *   no shipped description: `SHIPPED_TEXTS` does not hold it.
 * - b.deo SRI-1308's README checks (SRI-1101 to SRI-1105; AC 42), beside
 *   T1's key-table, example and in-place-row cases above:
 *   - the headings T17 added, each exactly once where it was placed
 *     (`README_DEO_PLACEMENTS`): `## Channel modes` between `## Configuration`
 *     and `## Reload` with its four subsections in order, the security
 *     subsection inside "How a persona receives messages", and
 *     "Downgrading to an earlier release" a `###` of its own right after
 *     "Upgrading to personas";
 *   - one row per element (`README_DEO_ROWS`, read by `docRowProblems`):
 *     the two modes (SRI-1102); the server-wide exception, the field marks,
 *     the declarative-scoped sections and "Load-time rules" per mode
 *     (SRI-1101); the receiving rows per mode, the @mention rule and the
 *     security statement (SRI-1102, SRI-1104); the introduction,
 *     "Personas (config.json)" and "Tools" per mode, the tools' rows, both
 *     known residuals, the prompt note and the archive reason (SRI-1103);
 *     the `channel-delivery.json` row, "Size limit", the preview's lines
 *     and rows, "Confirming a change" and the switch's take-effect exception
 *     (SRI-1103); the troubleshooting entries and the downgrade steps
 *     (SRI-1105). Setting names come from `src/` or typed names, preview
 *     lines from `modeSwitchLine` and `recordedLine` (built when the row
 *     runs), labels from their exports; the switch's line is read in its
 *     second carrier too, the setup wizard's step on how a change takes
 *     effect (`WIZARD_SWITCH_LINE_ROW`);
 *   - the declarative-scoped sections' pointers resolve into `## Channel
 *     modes`; the tools table lists exactly six tools; the fungible-mode
 *     preview example is `renderPreviewLines` of the change it describes,
 *     loaded through the real loader in a `mkdtempSync` directory; the
 *     downgrade steps stand in order; every same-file README link resolves.
 *   Each self-checked: every row item cut (`withItemCut`), each heading
 *   renamed, removed and moved, each pointer unlinked and its target
 *   renamed, the `set_channel_delivery` row removed, duplicated and renamed,
 *   a third residual bullet added, two downgrade steps swapped, all on
 *   in-memory copies.
 * CHANGELOG.md and docs/ are not shipped descriptions: the forbidden-term
 * audit still reads only `SHIPPED_TEXTS`, which holds neither. Besides the
 * two docs read through `OPERATOR_TEXTS`, the one docs/ file read is
 * docs/registry-install-runbook.md, for its links and bug b.7sd's check.
 *
 * Reads repo files resolved from this file's location, so the working
 * directory doesn't matter. The two writers are the complete-example load
 * and the fungible-mode preview example's case: each writes configurations
 * into its own `mkdtempSync` directory, removed after the test, and passes
 * that directory's `home` to the loader, which reads no credentials file. No
 * real HOME, no server, no CLI (SR-13.2).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'

import {
  CHANNEL_ENTRY_KEYS,
  CONFIG_FILE_NAME,
  agentDirectorCallTimeoutMsOf,
  DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
  DELIVERY_MODES,
  DM_DESTINATION,
  MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
  MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS,
  PERSONA_DM_KEYS,
  PERSONA_ENTRY_KEYS,
  PERSONA_INVITED_KEYS,
  PERSONA_TOP_LEVEL_KEYS,
  SERVER_PATH_SETTINGS,
  loadPersonaConfig,
  prefixRelatedKeysReason,
  resolvePersonaConfig,
  type ChannelMode,
  type PersonaConfig,
} from '../src/config.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { makePersona } from './test-helpers/persona-config.ts'
import {
  classHeading,
  findSection,
  flat,
  headingAnchors,
  headings,
  headingSlug,
  requiredSection,
  type Heading,
  type HeadingMatch,
  sectionRange,
  splitFences,
} from './test-helpers/markdown.ts'
import { RELOAD_TERMS } from './test-helpers/reload-terms.ts'
import { CLEAR_LATCH_TERMS, clearLatchTermsIn } from './test-helpers/clear-latch-terms.ts'
import { UPGRADE_FORMS } from './test-helpers/upgrade-forms.ts'
import { DELETE_HELPERS, REMOVED_IDENTIFIERS, SOURCE_WORD_RULES, type SourceWordRule } from './test-helpers/source-audit.ts'
import { CRONTABLE_TEMPLATE_HEADER } from '../src/cron-bootstrap.ts'
import type { Via } from '../src/delivery-decision.ts'
import * as registryExports from '../src/registry.ts'
import {
  channelDeliveryChannelRefusal,
  channelDeliveryDeclarativeRefusal,
  channelDeliveryNotStoredText,
  channelDeliverySetResultText,
  channelDeliveryUnreadableRefusal,
  channelDeliveryValueRefusal,
  channelDeliveryWriteFailedText,
  FUNGIBLE_TARGET_REFUSAL,
  MCP_INSTRUCTIONS,
  personaNotAppliedRefusal,
  sessionNotMatchedRefusal,
  SET_CHANNEL_DELIVERY_CHANNEL_DESCRIPTION,
  SET_CHANNEL_DELIVERY_DELIVERY_DESCRIPTION,
  SET_CHANNEL_DELIVERY_DESCRIPTION,
} from '../src/registry.ts'
import { CHANNEL_DELIVERY_FILE_NAME, CHANNEL_DELIVERY_UNREADABLE, SET_CHANNEL_DELIVERY_TOOL } from '../src/channel-delivery.ts'
import { AD_VERSION_RECHECK_INTERVAL_MS, DEBUG_SKILL_PATH, DEBUG_SKILL_RUNTIME_STOP_SECTION_TITLE, installAdVersionRecheck, meetsPhase1Floor, PHASE1_FLOOR_VERSION, PHASE1_RUNBOOK_SECTION_TITLE, PUBLISHING_HOST_BLOCK_HEADING } from '../src/ad-version-gate.ts'
import {
  AD_BELOW_PHASE1_FLOOR,
  AD_SHIM_CATALOG_INCOMPLETE,
  AD_SYSTEM_INSTALL_NOT_FOUND,
  AD_SYSTEM_INSTALL_TOO_OLD,
  AD_SYSTEM_INSTALL_UNREACHABLE,
  AD_VERSION_FLOOR_UNREADABLE,
  CLIENT_PACKAGE_REMEDY,
  PUBLISHING_HOST_BLOCK_POINTER,
} from '../src/install-check.ts'
import { AD_VERSION_CHECK_FAIL_EXIT_CODE, SR25_NOTE_PREFIX, SR25_PREFIX } from '../scripts/ad-version-check.ts'
import {
  AD_CALL_TIMEOUT_NEED_MARGIN_MS,
  AD_CEILING_VERBS,
  AD_LAUNCH_BOUND_GRACE_ADDEND_SECONDS,
  AD_LAUNCH_CEILING_VERBS,
  AD_PAUSE_TABLE,
  AD_PAUSE_TIMEOUT_KEY,
  AD_SETTING_MINIMUMS,
  AD_SETTINGS_RELATIVE_PATH,
  AD_TMUX_KEYS,
  AD_TMUX_TABLE,
  adCallTimeoutNeed,
  buildAdCallTimeoutWarningLine,
  checkAdCallTimeoutAtStartup,
  DEFAULT_AD_SETTINGS,
  DEFAULT_AD_SETTINGS_IN_EFFECT,
  DIALOG_READY_TIMEOUT_MS,
  installAdSettings,
  type AdTmuxKey,
} from '../src/ad-settings.ts'
import { DEFAULT_STORE_PATH } from '../src/agent-director-client.ts'
import { AD_ERROR_CLASS_CONFLICT, AD_ERROR_CLASS_UNAVAILABLE, AD_ERROR_CLASSES, classifyAdError } from '../src/ad-error-class.ts'
import {
  PERSONA_INSTANCE_ID_PREFIX,
  PERSONA_TMUX_SESSION_PREFIX,
  personaInstanceId,
  personaKey,
  personaTmuxSessionName,
  SERVICE_LABEL,
} from '../src/persona-identity.ts'
import { LAST_APPLIED_FILE_SUFFIX, RELOAD_RECORD_WRITE_FAILED } from '../src/reload.ts'
import {
  createOldLifeHoldSet,
  oldLifeKeyOf,
  RETIRED_KEYS_FILE_NAME,
  RETIRED_KEYS_FORMAT_VERSION,
  RETIRED_KEYS_UNREADABLE_LABEL,
  serializeRetiredKeys,
} from '../src/retired-keys.ts'
import {
  CLEAR_LATCH_COMMAND,
  CLEAR_LATCH_DIAL_HOST,
  CLEAR_LATCH_ROUTE,
  dialClearLatch,
  handleClearLatch,
  SERVER_PORT_FILE_NAME,
  writeServerPortRecord,
} from '../src/clear-latch.ts'
import {
  CLEAN_RESTART_NOT_RESTARTED_LABEL,
  CLI_COMMAND_CLEAN_RESTART,
  CLI_COMMAND_STOP_BOTS,
  CLI_TEARDOWN_FAILED_LABEL,
  PRECHECK_TRIES,
  precheckVerdictOf,
} from '../src/cli-teardown.ts'
import {
  KILL_FAILURE_CLOSING_CLI_TEARDOWN,
  KILL_FAILURE_CLOSING_DESTINATION,
  KILL_FAILURE_CLOSING_DESTINATION_LATCHED,
  KILL_FAILURE_CLOSING_LOG_ONLY,
  KILL_FAILURE_VERSION_ORDINARY,
  KILL_FAILURE_VERSION_SURVIVOR,
  killFailureAlertText,
  killFailureClosingSentence,
  killFailureSurvivorPidList,
  PERSONA_KILL_FAILED_LABEL,
  PERSONA_KILL_SURVIVOR_LABEL,
  PERSONA_TEARDOWN_NOTICE_LABEL,
  type KillFailureAlertContent,
  type KillFailureAlertVersion,
  type KillFailureClosing,
} from '../src/kill-failure-alert.ts'
import { STATE_WORDING } from '../src/lost-message.ts'
import { renderLogMessageText } from '../src/persona-connection-errors.ts'
import {
  abortKillOwnStuckLaunch,
  buildPendingRowRuleDeps,
  clearByHandOf,
  DIALOG_POLL_INTERVAL_MS,
  JSONL_DIAGNOSIS_INCONCLUSIVE_ENTRY_CLASS,
  LAUNCH_CALL_END_LAUNCH_TIMEOUT,
  LAUNCH_VERB_REUSE_SPAWN,
  PENDING_ROW_RULE_GET_SITE,
  runLatchClearSequence,
  startDialogApprover,
  startupSummaryEnding,
  STUCK_LAUNCH_ABORT_SITE,
} from '../src/session-manager.ts'
import {
  createUnavailableRetryController,
  UNAVAILABLE_RETRY_BASE_S,
  UNAVAILABLE_RETRY_CAUSE_COLLISION,
  UNAVAILABLE_RETRY_CEILING_S,
  UNAVAILABLE_RETRY_CONDITION_TMUX_UNAVAILABLE,
} from '../src/unavailable-retry.ts'
import { armPendingOnlyAfterLaunchFailure, ONSET_TEMPLATES, tmuxServerChangedOnset } from '../src/outage-state.ts'
import {
  createTmuxUnresponsiveCondition,
  PERSONA_EPISODE_KIND_AD_CONFIG_MALFORMED,
  PERSONA_UNCLASSIFIED_ERROR_LABEL,
  TMUX_UNRESPONSIVE_ONSET_FLOOR_MS,
  tmuxUnresponsiveAlertText,
  tmuxUnresponsiveOnsetText,
  tmuxUnresponsiveRecoveryText,
  unclassifiedErrorAlertText,
} from '../src/persona-episodes.ts'
import {
  CONFLICT_NOTICE_FIRST_LINE_HEAD,
  CONFLICT_RECOVERY_HEAD,
  createConflictLatch,
  createLatchRecheckController,
  decideLatchRecheck,
  HOLD_RECOVERY_HEAD,
  LATCH_RECHECK_INTERVAL_MS,
  LAUNCH_START_NOTICE_HEAD,
  recogniseConflictCase,
  UNUSABLE_NAME_NOTICE_HEAD,
} from '../src/conflict-latch.ts'
import { LATCHING_LIVENESS_NOTE } from '../src/row-read-rules.ts'
import { createLiveRowSequenceRegistry, LIVE_ROW_SEQUENCE_MAX_KILLS } from '../src/live-row-sequence.ts'
import { createStuckLaunchAbort, PENDING_ROW_NO_LAUNCH_START, STUCK_LAUNCH_HELD_HEAD, STUCK_LAUNCH_RELAUNCHING_HEAD } from '../src/pending-row.ts'
import { slowRecoveryText } from '../src/slow-recovery.ts'
import { INVALID_FLAGS_HOLD_ALERT_TEXT } from '../src/invalid-flags-hold.ts'
import { errTmuxKillFailed, KILL_FAILED_DESCRIPTIONS, STUB_SURVIVOR_PIDS } from './test-helpers/agent-director-stub.ts'
import { humanOnlySentencesIn } from './test-helpers/conflict-cases.ts'
import { CLIENT_MIN_VERSION, MIN_CLAUDE_CODE_VERSION, OLD_AD_VERSION } from './test-helpers/agent-director-versions.ts'
import {
  REFUSAL_BLOCK_HEADING,
  ROLLBACK_RUNBOOK_SECTION_TITLE,
  runbookSteps,
  stepHeadingPrefix,
  stepNumberOf,
} from './test-helpers/runbooks.ts'
import {
  DESTRUCTIVE_PREFIX,
  DESTRUCTIVE_SETTINGS,
  IN_PLACE_SETTINGS,
  MODE_SWITCH_SETTING,
  NEXT_LAUNCH_SETTINGS,
  RECORDED_SECTION_KEYS,
  buildChangePlan,
  INVALID_PREFIX,
  modeSwitchLine,
  NO_EFFECTIVE_CHANGE,
  PENDING_PREVIEW_TITLE,
  recordedLine,
  renderPreviewLines,
  type NextLaunchSetting,
  type RecordedSectionKey,
  type ValidChangePlan,
} from '../src/reload-plan.ts'
import { RELOAD_APPLIED, RELOAD_NOOP } from '../src/reload-apply.ts'
import {
  FUNGIBLE_REFUSAL_TEXTS,
  PERSONA_CHANNEL_DELIVERY_SET,
  PERSONA_INVITED_CHANNEL,
  UNCLAIMED_CHANNEL,
  UNCLAIMED_REASON_CHANNEL_ID_MALFORMED,
  UNCLAIMED_REASON_EXTERNALLY_SHARED,
} from '../src/persona-diagnostics.ts'
import { FUNGIBLE_MODE_ZERO_REASON } from '../src/jsonl-persistence-check.ts'

const REPO_ROOT = resolve(import.meta.dir, '..')

function readRepoFile(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf-8')
}

/** A quote may open a YAML scalar only at its start: line start or after `:`, `-`, `[`, `{`, `,`. */
function opensQuotedScalar(before: string): boolean {
  const prev = before.trimEnd()
  return prev === '' || /[:\-[{,]$/.test(prev)
}

/**
 * The text of every YAML comment (full-line `#` comments and inline ` # …`
 * tails), joined with spaces so a phrase wrapped across comment lines still
 * matches a `\s+`-separated pattern.
 *
 * A `#` inside a quoted scalar (which may span lines) or inside a block scalar
 * (`|` / `>`) body is value text, not a comment, and is skipped.
 */
function yamlComments(text: string): string {
  const comments: string[] = []
  let quote: '"' | "'" | null = null
  let blockParentIndent: number | null = null
  for (const line of text.split('\n')) {
    const indent = line.length - line.trimStart().length
    if (blockParentIndent !== null) {
      if (line.trim() === '' || indent > blockParentIndent) continue
      blockParentIndent = null
    }
    let content = line
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (quote === '"') {
        if (ch === '\\') i++
        else if (ch === '"') quote = null
      } else if (quote === "'") {
        if (ch === "'" && line[i + 1] === "'") i++
        else if (ch === "'") quote = null
      } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
        comments.push(line.slice(i + 1))
        content = line.slice(0, i)
        break
      } else if ((ch === '"' || ch === "'") && opensQuotedScalar(line.slice(0, i))) {
        quote = ch
      }
    }
    if (quote === null && /(?:^|[:-])\s*[|>][-+1-9]*\s*$/.test(content)) {
      blockParentIndent = indent
    }
  }
  return comments.join(' ')
}

describe('slack-app-manifest.yml', () => {
  const text = readRepoFile('slack-app-manifest.yml')
  const manifest = Bun.YAML.parse(text) as {
    features: { app_home: Record<string, unknown> }
    oauth_config: { scopes: { bot: string[] } }
    settings: { event_subscriptions: { bot_events: string[] } }
  }
  const comments = yamlComments(text)

  test('AC 39: the bot scopes include im:write', () => {
    expect(manifest.oauth_config.scopes.bot).toContain('im:write')
  })

  test('SR-4.3: message.im stays subscribed and message.mpim is not (group DMs unsubscribed)', () => {
    const events = manifest.settings.event_subscriptions.bot_events
    expect(events).toContain('message.im')
    expect(events).not.toContain('message.mpim')
  })

  test('the bot scopes are exactly the pinned list (none dropped, none added)', () => {
    expect([...manifest.oauth_config.scopes.bot].sort()).toEqual(
      [
        'app_mentions:read',
        'channels:history',
        'chat:write',
        'files:read',
        'files:write',
        'groups:history',
        'im:history',
        'im:write',
        'reactions:write',
        'users:read',
      ].sort(),
    )
  })

  test('the bot events are exactly the pinned list (none dropped, none added)', () => {
    expect([...manifest.settings.event_subscriptions.bot_events].sort()).toEqual(
      ['app_mention', 'message.channels', 'message.groups', 'message.im'].sort(),
    )
  })

  test('the Messages tab is on and writable, so a user can DM the persona', () => {
    expect(manifest.features.app_home.messages_tab_enabled).toBe(true)
    expect(manifest.features.app_home.messages_tab_read_only_enabled).toBe(false)
  })

  test.each([
    ['SLACK_APP_TOKEN', /SLACK_APP_TOKEN/],
    ['SLACK_BOT_TOKEN', /SLACK_BOT_TOKEN/],
    ['an environment variable', /environment\s+variable|\benv\s+var/i],
  ])('SR-12: no comment names %s', (_label, pattern) => {
    expect(comments).not.toMatch(pattern)
  })

  test.each([
    ['one app per persona', /one\s+app\s+per\s+persona/i],
    ['the credentials_file setting', /\bcredentials_file\b/],
    ['the bot_token key', /\bbot_token\b/],
    ['the app_token key', /\bapp_token\b/],
    ['im:write', /\bim:write\b/],
    ['re-installing existing apps', /\bre-?install/i],
  ])('SR-12: the comments name %s', (_label, pattern) => {
    expect(comments).toMatch(pattern)
  })
})

/** `findSection`, with '' when the heading is absent. */
function markdownSection(text: string, heading: string): string {
  return findSection(text, heading) ?? ''
}

/** The cells of one Markdown table row, trimmed; `\|` stays in its cell. */
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim())
}

/** The first pipe table in `section`: its header cells and body rows (the `|---|` line skipped). */
function firstTable(section: string): { header: string[]; rows: string[][] } {
  const lines = section.split('\n')
  const first = lines.findIndex((line) => line.trimStart().startsWith('|'))
  if (first < 0) return { header: [], rows: [] }
  const block: string[] = []
  for (const line of lines.slice(first)) {
    if (!line.trimStart().startsWith('|')) break
    block.push(line)
  }
  const [header, , ...rows] = block.map(tableCells)
  return { header, rows }
}

/** The backtick code spans in a cell, without the backticks. */
function codeSpans(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1])
}

/** The README's persona configuration reference heading and its complete-example heading, DOC-1's interface. */
const PERSONAS_HEADING = '### Personas (config.json)'
const EXAMPLE_HEADING = '#### Example'
/** The heading of the README's second complete example, in fungible mode (b.deo SRI-1101). */
const FUNGIBLE_EXAMPLE_HEADING = '#### Example in fungible mode'

/**
 * The persona-entry key holding the fungible section (b.deo SRI-102): read
 * only in fungible mode, so the declarative example need not carry it.
 */
const FUNGIBLE_SECTION_KEY = 'invited' satisfies (typeof PERSONA_ENTRY_KEYS)[number]

/** The fungible section's key naming the persona's destination, `invited.permission_prompts` (b.deo SRI-102). */
const INVITED_DESTINATION_KEY = 'permission_prompts' satisfies (typeof PERSONA_INVITED_KEYS)[number]

/** Where a section nested in the persona reference comes from, for `requiredSection` failures. */
const IN_PERSONAS = `README.md, under "${PERSONAS_HEADING}",`

/** The README's persona configuration reference, throwing when its heading is missing. */
function personasSection(readme: string): string {
  return requiredSection(readme, PERSONAS_HEADING, 'README.md')
}

/**
 * A complete example's text: the one fenced block, tagged `json`, directly
 * under `heading` (`#### Example`, or `#### Example in fungible mode`) inside
 * `### Personas (config.json)`. Throws naming what is missing, and on any
 * other count or tag, so the load case never passes vacuously or on some
 * other JSON block.
 */
function completeExample(readme: string, heading: string = EXAMPLE_HEADING): string {
  const example = requiredSection(personasSection(readme), heading, IN_PERSONAS)
  const { blocks } = splitFences(example)
  if (blocks.length !== 1 || blocks[0].info !== 'json') {
    const found = blocks.map((b) => `\`\`\`${b.info}`).join(', ') || 'none'
    throw new Error(`"${heading}" must hold exactly one fenced json block; found: ${found}`)
  }
  return blocks[0].body
}

/** The three server-wide settings moved into config.json by the persona format (b.av2 SR-1.6; not exported). */
const MOVED_SERVER_SETTINGS = ['ack_reaction', 'reply_chunk_limit', 'reply_chunk_mode']

/**
 * The reference's key tables: each `####` heading under `### Personas
 * (config.json)` with the keys its table must list, one code span per row in
 * the first column, built from the loader's exported key sets: the b.av2
 * SR-1.2 persona-entry keys (b.deo SRI-102; the `dm` sub-keys written
 * `dm.<key>`, the `invited` sub-keys `invited.<key>` alike), the SR-1.3
 * channel-entry keys (b.deo SRI-103), and the SR-1.1 / SR-1.6 top-level keys
 * but `personas` (b.deo SRI-101: `allow_invited_channels` among them).
 */
const KEY_TABLES: [heading: string, keys: readonly string[]][] = [
  ['Persona fields', PERSONA_ENTRY_KEYS.flatMap((key) => {
    if (key === 'dm') return PERSONA_DM_KEYS.map((sub) => `dm.${sub}`)
    if (key === FUNGIBLE_SECTION_KEY) return PERSONA_INVITED_KEYS.map((sub) => `${FUNGIBLE_SECTION_KEY}.${sub}`)
    return [key]
  })],
  ['Channel entries', CHANNEL_ENTRY_KEYS],
  ['Server-wide settings', PERSONA_TOP_LEVEL_KEYS.filter((key) => key !== 'personas')],
]

/** The setup wizard: its skill name, its skill file and the heading of its credentials command. */
const WIZARD_NAME = 'setup-slack-channel-bots'
const WIZARD_FILE = `skills/${WIZARD_NAME}/SKILL.md`
const WIZARD_CREDENTIALS_HEADING = 'Credentials command'
/** The script the wizard's credentials command runs (`claude-slack-channel-bots credentials`), shipped in the package. */
const CREDENTIALS_SCRIPT = 'scripts/write-credentials.sh'

/** The inline links in `text`: each target split into its path ('' for a same-file anchor) and its anchor ('' when none). */
function markdownLinks(text: string): { target: string; path: string; anchor: string }[] {
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)].map(([, target]) => {
    const hash = target.indexOf('#')
    return hash < 0
      ? { target, path: target, anchor: '' }
      : { target, path: target.slice(0, hash), anchor: target.slice(hash + 1) }
  })
}

describe('README.md', () => {
  const readme = readRepoFile('README.md')

  /**
   * b.av2 SR-12 / SR-8.6: the README's modify-semantics table, "What a
   * confirmation applies" in the Reload section. Each expected row is found by
   * the setting names in its Change cell (or a keyword where it names none),
   * and pinned by its Live session cell and whether its Once confirmed cell
   * carries `DESTRUCTIVE:`. Wording is not pinned. SR-8.6 as amended by b.jg5
   * SRJ-1511: removal and destructive rows read "Retired: never resumed". As
   * amended by b.deo SRI-805: the switch's row and the recorded row, each
   * "Kept", and the server-wide row naming the switch as its exception; the
   * new rows are self-checked on edited copies.
   */
  describe('What a confirmation applies (SR-8.6 rows)', () => {
    const reload = markdownSection(readme, '## Reload')
    const table = firstTable(markdownSection(reload, '### What a confirmation applies'))

    type Row = { change: string; confirmed: string; session: string }
    const rows: Row[] = table.rows.map(([change, confirmed, session]) => ({ change, confirmed, session }))

    /** The table's rows in `text` (the README, or an edited copy of it). */
    const rowsOf = (text: string): Row[] =>
      firstTable(markdownSection(markdownSection(text, '## Reload'), '### What a confirmation applies')).rows.map(([change, confirmed, session]) => ({ change, confirmed, session }))

    /** How the README row of a change is found, and the effect it must state. */
    type Expected = { label: string; find: (row: Row) => boolean; session: string; destructive: boolean }

    /** `expected`'s problems over `all`: not exactly one row, or the row's Live session or `DESTRUCTIVE:` not as expected. */
    function rowProblems(all: readonly Row[], expected: Expected): string[] {
      const matches = all.filter(expected.find)
      if (matches.length !== 1) return [`${matches.length} rows, expected 1`]
      const [row] = matches
      return [
        ...(row.session === expected.session ? [] : [`Live session "${row.session}", expected "${expected.session}"`]),
        ...(row.confirmed.includes(DESTRUCTIVE_PREFIX) === expected.destructive ? [] : [`${DESTRUCTIVE_PREFIX} ${expected.destructive ? 'missing' : 'present'}`]),
      ]
    }

    const naming = (...settings: readonly string[]) => (row: Row) =>
      settings.every((s) => codeSpans(row.change).includes(s))

    /** SR-8.6: each next-launch setting keeps the instance, `claude_config_dir` only until the next launch. */
    const NEXT_LAUNCH_SESSION: Record<NextLaunchSetting, string> = {
      claude_config_dir: 'Kept until the next launch',
      stop_hook_bootstrap: 'Kept',
    }

    /**
     * A removal or a destructive modify retires the persona: its session is
     * stopped and never resumed (b.jg5 SRJ-1511).
     */
    const RETIRED_SESSION = 'Retired: never resumed'

    /** The server-wide row: a server-wide setting, found by "server-wide" in its Change cell. */
    const SERVER_WIDE_ROW: Expected = {
      label: 'a server-wide setting',
      find: (row) => /server-wide/i.test(row.change),
      session: 'Not affected',
      destructive: false,
    }

    /** The switch's row, found by the switch named in its Change cell (b.deo SRI-805). */
    const SWITCH_ROW: Expected = { label: `the switch ${MODE_SWITCH_SETTING}`, find: naming(MODE_SWITCH_SETTING), session: 'Kept', destructive: false }

    /** The recorded row, found by the section keys its Change cell names (b.deo SRI-805, SRI-1103). */
    const RECORDED_ROW: Expected = {
      label: `a recorded change to the section not in force (${RECORDED_SECTION_KEYS.join(', ')})`,
      find: naming(...RECORDED_SECTION_KEYS),
      session: 'Kept',
      destructive: false,
    }

    /**
     * One entry per change kind the plan classifies (`ValidChangePlan`'s lists),
     * the settings expanded from the plan's exported classes. A new kind in the
     * plan fails the typecheck here until it has a README row; a new setting in
     * a class needs its name in that class's row, so the in-place row names
     * `invited.permission_prompts` too (b.deo SRI-1103). The plan reports the
     * switch (`MODE_SWITCH_SETTING`) among the server-wide settings, so the
     * switch's row is a second `settings` entry, found by the switch named in
     * its Change cell; the server-wide row names the switch only in its Once
     * confirmed cell, as its exception, so each finder matches one row. The
     * recorded row (a change to the section not in force) is found by the
     * section keys its Change cell names (`RECORDED_SECTION_KEYS`) (b.av2
     * SR-8.6, b.deo SRI-805, SRI-1103).
     */
    const EXPECTED: Record<
      Exclude<keyof ValidChangePlan, 'valid' | 'noEffectiveChange' | 'configDirsChanged' | 'unchanged'>,
      Expected[]
    > = {
      inPlace: [
        { label: IN_PLACE_SETTINGS.join(', '), find: naming(...IN_PLACE_SETTINGS), session: 'Kept', destructive: false },
      ],
      credentials: [
        {
          label: 'credentials file content, same path',
          find: (row) => /credentials file/i.test(row.change) && /same path/i.test(row.change),
          session: 'Kept',
          destructive: false,
        },
      ],
      nextLaunch: NEXT_LAUNCH_SETTINGS.map((setting) => ({
        label: setting,
        find: naming(setting),
        session: NEXT_LAUNCH_SESSION[setting],
        destructive: false,
      })),
      removed: [
        {
          label: 'a persona is removed',
          find: (row) => /\bremoved\b/i.test(row.change) && codeSpans(row.change).length === 0,
          session: RETIRED_SESSION,
          destructive: true,
        },
      ],
      destructive: DESTRUCTIVE_SETTINGS.map((setting) => ({
        label: setting,
        find: naming(setting),
        session: RETIRED_SESSION,
        destructive: true,
      })),
      settings: [SERVER_WIDE_ROW, SWITCH_ROW],
      recorded: [RECORDED_ROW],
      added: [
        {
          label: 'a persona is added',
          find: (row) => /\badded\b/i.test(row.change) && codeSpans(row.change).length === 0,
          session: 'New session',
          destructive: false,
        },
      ],
    }

    test('the table sits in the Reload section with the Change | Once confirmed | Live session columns', () => {
      expect(reload).not.toBe('')
      expect(table.header).toEqual(['Change', 'Once confirmed', 'Live session'])
      for (const row of table.rows) expect(row).toHaveLength(3)
    })

    test.each(Object.values(EXPECTED).flat().map((e) => [e.label, e] as const))(
      'SR-8.6 row for %s: exactly one row, with its Live session effect and DESTRUCTIVE: only if destructive',
      (_label, expected) => {
        expect(rowProblems(rows, expected)).toEqual([])
      },
    )

    test('the server-wide row names a real top-level setting, such as port', () => {
      const row = rows.find(SERVER_WIDE_ROW.find)
      if (!row) throw new Error('no server-wide row in the table')
      const named = codeSpans(row.change)
      expect(named).toContain('port')
      for (const setting of named) expect(PERSONA_TOP_LEVEL_KEYS).toContain(setting)
    })

    /** The server-wide row's problems in `all`: its Once confirmed cell keeps the next server start and names the switch as its exception (b.deo SRI-805). */
    function serverWideExceptionProblems(all: readonly Row[]): string[] {
      const row = all.find(SERVER_WIDE_ROW.find)
      if (row === undefined) return ['no server-wide row']
      return [
        ...(/\bnext server start\b/.test(row.confirmed) ? [] : ['Once confirmed names no next server start']),
        ...(codeSpans(row.confirmed).includes(MODE_SWITCH_SETTING) ? [] : [`Once confirmed names no \`${MODE_SWITCH_SETTING}\``]),
        ...(/\bexception\b/i.test(row.confirmed) ? [] : ['Once confirmed names no exception']),
      ]
    }

    test(`the server-wide row keeps "next server start" and names \`${MODE_SWITCH_SETTING}\` as its exception in its Once confirmed cell (b.deo SRI-805)`, () => {
      expect(serverWideExceptionProblems(rows)).toEqual([])
    })

    /** The recorded row's problems in `all`: its Once confirmed cell names no `reload-noop` (b.deo SRI-804, SRI-1103). */
    function recordedNoopProblems(all: readonly Row[]): string[] {
      const row = all.find(RECORDED_ROW.find)
      if (row === undefined) return ['no recorded row']
      return codeSpans(row.confirmed).includes(RELOAD_NOOP) ? [] : [`Once confirmed names no \`${RELOAD_NOOP}\``]
    }

    test(`the recorded row's Once confirmed cell names \`${RELOAD_NOOP}\` for a confirmation of recorded changes only (b.deo SRI-804, SRI-1103)`, () => {
      expect(recordedNoopProblems(rows)).toEqual([])
    })

    /**
     * Self-checks on edited copies of the README (b.deo SRI-805): each of the
     * two rows this work adds, the switch's and the recorded one, fails its
     * case when it is removed or duplicated, when its Live session changes,
     * and when its Once confirmed cell gains `DESTRUCTIVE:`; each leg of the
     * server-wide exception case (the next server start, the switch, the word
     * "exception") fails alone when cut from that row; and the recorded row's
     * `reload-noop` case fails when the label is cut from that row.
     */
    describe('self-checks, on edited copies', () => {
      const NEW_ROWS: readonly Expected[] = [SWITCH_ROW, RECORDED_ROW]

      /** `text` with `edit` applied to the raw line of the one table row `expected` finds; an edit to '' removes the line. */
      function withRowEdited(text: string, expected: Expected, edit: (line: string) => string): string {
        const lines = text.split('\n')
        const range = sectionRange(text, '### What a confirmation applies')
        if (range === undefined) throw new Error('README.md has no heading "### What a confirmation applies"')
        const at = lines.flatMap((line, i) => {
          if (i <= range.start || i >= range.end || !line.startsWith('| ')) return []
          const [change, confirmed, session] = tableCells(line)
          return expected.find({ change, confirmed, session }) ? [i] : []
        })
        if (at.length !== 1) throw new Error(`${at.length} README lines hold the row for ${expected.label}`)
        const replaced = edit(lines[at[0]])
        return [...lines.slice(0, at[0]), ...(replaced === '' ? [] : replaced.split('\n')), ...lines.slice(at[0] + 1)].join('\n')
      }

      const EDITS: readonly [how: string, edit: (line: string) => string][] = [
        ['removed', () => ''],
        ['duplicated', (line) => `${line}\n${line}`],
        ['with its Live session changed', (line) => line.replace(/\| Kept \|$/, '| Not affected |')],
        [`with ${DESTRUCTIVE_PREFIX} in its Once confirmed cell`, (line) => line.replace(/^(\|[^|]+\| )/, `$1Previewed ${DESTRUCTIVE_PREFIX} `)],
      ]

      test.each(NEW_ROWS.flatMap((expected) => EDITS.map(([how, edit]) => [expected.label, how, expected, edit] as const)))(
        'the row for %s, %s, fails its case',
        (_label, _how, expected, edit) => {
          const edited = withRowEdited(readme, expected, edit)
          expect(edited).not.toBe(readme)
          expect(rowProblems(rowsOf(edited), expected)).not.toEqual([])
        },
      )

      test.each([
        [`\`${MODE_SWITCH_SETTING}\``, (line: string) => line.replaceAll(`\`${MODE_SWITCH_SETTING}\``, 'the switch'), `Once confirmed names no \`${MODE_SWITCH_SETTING}\``],
        ['"next server start"', (line: string) => line.replaceAll('next server start', 'next start'), 'Once confirmed names no next server start'],
        ['"exception"', (line: string) => line.replace(/\bexception\b/gi, 'difference'), 'Once confirmed names no exception'],
      ] as const)('the server-wide row with %s cut fails the exception case on that leg alone', (_cut, edit, problem) => {
        const edited = withRowEdited(readme, SERVER_WIDE_ROW, edit)
        expect(edited).not.toBe(readme)
        expect(serverWideExceptionProblems(rowsOf(edited))).toEqual([problem])
      })

      test(`the recorded row with \`${RELOAD_NOOP}\` cut fails the ${RELOAD_NOOP} case`, () => {
        const edited = withRowEdited(readme, RECORDED_ROW, (line) => line.replaceAll(`\`${RELOAD_NOOP}\``, 'a no-op line'))
        expect(edited).not.toBe(readme)
        expect(recordedNoopProblems(rowsOf(edited))).toEqual([`Once confirmed names no \`${RELOAD_NOOP}\``])
      })
    })
  })

  /**
   * b.av2 SR-12 / SR-13.5, b.deo SRI-1101: the README persona reference. Its
   * key tables list exactly the keys the loader accepts, and each of its two
   * complete examples (declarative mode under `#### Example`, fungible mode
   * under `#### Example in fungible mode`) loads through the server's loader
   * and is complete for its own mode.
   */
  describe('persona configuration reference (SR-12, SR-13.5)', () => {
    test.each(KEY_TABLES)('the "#### %s" table lists exactly the loader\'s keys, one code span per row', (heading, keys) => {
      const table = firstTable(requiredSection(personasSection(readme), `#### ${heading}`, IN_PERSONAS))
      expect(table.header[0]).toBe('Field')
      const firstCells = table.rows.map(([cell]) => cell)
      expect(firstCells.filter((cell) => !/^`[^`]+`$/.test(cell))).toEqual([])
      expect(firstCells.map((cell) => cell.slice(1, -1)).sort()).toEqual([...keys].sort())
    })

    /**
     * Each complete example, written byte for byte into a temp dir and loaded
     * through the server's loader (default loader options, temp home). The
     * loader reads no credentials file (b.av2 SR-1.5; b.deo SRI-103, SRI-104
     * in each channel mode), so none is written.
     */
    describe('complete examples through the real loader', () => {
      let dir: string

      beforeEach(() => {
        dir = realpathSync(mkdtempSync(join(tmpdir(), 'shipped-docs-')))
      })

      afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
      })

      type RawPersona = Record<string, unknown> & { dm?: Record<string, unknown>; invited?: Record<string, unknown> }
      type Example = { raw: { personas: RawPersona[] } & Record<string, unknown>; home: string; config: PersonaConfig }

      /**
       * Write the complete example under `heading` as
       * `<dir>/state/config.json` and load it with `<dir>/home` as the home.
       * Returns its parsed value, the home and the loaded config. The example,
       * the config and any load error are leak-checked; a load error is
       * rethrown with its message.
       */
      function loadExample(heading: string = EXAMPLE_HEADING): Example {
        const text = completeExample(readme, heading)
        assertNoLeak(text, 'example')
        let raw: Example['raw']
        try {
          raw = JSON.parse(text)
        } catch {
          throw new Error(`the "${heading}" json block is not strict JSON`)
        }
        if (!Array.isArray(raw.personas)) throw new Error(`the "${heading}" json block has no personas array`)
        const home = join(dir, 'home')
        const state = join(dir, 'state')
        mkdirSync(home)
        mkdirSync(state)
        const configPath = join(state, 'config.json')
        writeFileSync(configPath, text)
        let config: PersonaConfig
        try {
          config = loadPersonaConfig(configPath, home)
        } catch (error) {
          assertNoLeak(error, 'load error')
          throw new Error(`the complete example under "${heading}" does not load: ${error instanceof Error ? error.message : String(error)}`)
        }
        assertNoLeak(config, 'loaded config')
        return { raw, home, config }
      }

      const EXAMPLE_HEADINGS = [EXAMPLE_HEADING, FUNGIBLE_EXAMPLE_HEADING]

      test.each(EXAMPLE_HEADINGS)('the example under "%s" loads with no error, one resolved persona per entry, in order', (heading) => {
        const { raw, config } = loadExample(heading)
        expect(raw.personas.length).toBeGreaterThanOrEqual(1)
        expect(config.personas.map((p) => p.name)).toEqual(raw.personas.map((p) => p.name as string))
      })

      test.each(EXAMPLE_HEADINGS)('every path in the example under "%s" resolves under the injected temp home or the temp config dir', (heading) => {
        const { config } = loadExample(heading)
        const paths = [
          ...config.personas.flatMap((p) => [p.credentials_file, p.working_directory, p.claude_config_dir]),
          ...SERVER_PATH_SETTINGS.map((setting) => config[setting]),
        ].filter((path): path is string => path !== undefined)
        expect(paths.filter((path) => !path.startsWith(`${dir}/`))).toEqual([])
      })

      /**
       * The declarative example (`#### Example`): declarative mode, every key
       * declarative mode reads, and the declarative shapes below. The
       * fungible section is not required (b.deo SRI-1101).
       */
      const COMPLETENESS: [label: string, check: (example: Example) => void][] = [
        ['the switch absent or false (declarative mode)', ({ raw }) => {
          expect([undefined, false] as unknown[]).toContainEqual(raw[MODE_SWITCH_SETTING])
        }],
        ['every persona-entry key declarative mode reads', ({ raw }) => {
          const read = PERSONA_ENTRY_KEYS.filter((key) => key !== FUNGIBLE_SECTION_KEY)
          expect(read.filter((key) => !raw.personas.some((p) => key in p))).toEqual([])
        }],
        ['every dm key', ({ raw }) => {
          expect(PERSONA_DM_KEYS.filter((key) => !raw.personas.some((p) => p.dm !== undefined && key in p.dm))).toEqual([])
        }],
        ['both channel deliveries', ({ config }) => {
          const deliveries = config.personas.flatMap((p) => p.channels.map((c) => c.delivery))
          expect([...new Set(deliveries)].sort()).toEqual([...DELIVERY_MODES].sort())
        }],
        ['a "dm" destination and a channel destination', ({ config }) => {
          const kinds = config.personas.map((p) => (p.permission_prompts === DM_DESTINATION ? 'dm' : 'channel'))
          expect([...new Set(kinds)].sort()).toEqual(['channel', 'dm'])
        }],
        ['a DM-only persona', ({ config }) => {
          const shapes = config.personas.map((p) => ({ name: p.name, channels: p.channels.length, dm: p.dm.enabled }))
          expect(shapes).toContainEqual(expect.objectContaining({ channels: 0, dm: true }))
        }],
        ['a channel shared by two personas', ({ config }) => {
          const ids = config.personas.flatMap((p) => p.channels.map((c) => c.id))
          expect(ids).not.toEqual([...new Set(ids)])
        }],
        ['the moved server-wide settings', ({ raw }) => {
          expect(MOVED_SERVER_SETTINGS.filter((key) => !(key in raw))).toEqual([])
        }],
        // SR-9.4: the reply guard refuses ~/.claude, so no config dir in the example, top-level or persona, may be it.
        ['no claude_config_dir is <home>/.claude (SR-9.4)', ({ home, config }) => {
          const dirs = [['top level', config.claude_config_dir], ...config.personas.map((p) => [p.name, p.claude_config_dir])]
          expect(dirs.filter(([, configDir]) => configDir === join(home, '.claude'))).toEqual([])
        }],
      ]

      test.each(COMPLETENESS)('the example is complete: %s', (_label, check) => {
        check(loadExample())
      })

      /**
       * The fungible example (`#### Example in fungible mode`, b.deo
       * SRI-1101): the switch on, a persona with DMs off and a channel
       * fungible destination, another whose destination is `"dm"` by default
       * (no `invited.permission_prompts` written), and every key of the
       * fungible section.
       */
      const FUNGIBLE_COMPLETENESS: [label: string, check: (example: Example) => void][] = [
        ['the switch true (fungible mode)', ({ raw }) => {
          expect(raw[MODE_SWITCH_SETTING]).toBe(true)
        }],
        ['a persona with DMs off and a channel fungible destination', ({ config }) => {
          const shapes = config.personas.map((p) => ({
            dm: p.dm.enabled,
            channelDestination: p.fungible_destination !== undefined && p.fungible_destination !== DM_DESTINATION,
          }))
          expect(shapes).toContainEqual({ dm: false, channelDestination: true })
        }],
        [`a persona whose destination is "${DM_DESTINATION}" by default, none written`, ({ raw, config }) => {
          const byDefault = config.personas.filter((p, i) => {
            const invited = raw.personas[i].invited
            const written = invited !== undefined && INVITED_DESTINATION_KEY in invited
            return p.fungible_destination === DM_DESTINATION && !written
          })
          expect(byDefault.map((p) => p.name)).not.toEqual([])
        }],
        ['every key of the fungible section', ({ raw }) => {
          const written = (key: string) => raw.personas.some((p) => p.invited !== undefined && key in p.invited)
          expect(PERSONA_INVITED_KEYS.filter((key) => !written(key))).toEqual([])
        }],
      ]

      test.each(FUNGIBLE_COMPLETENESS)('the fungible-mode example is complete: %s', (_label, check) => {
        check(loadExample(FUNGIBLE_EXAMPLE_HEADING))
      })
    })
  })

  /**
   * The README points to the setup wizard: the Quick Start links to its skill
   * file, and `#### Credentials files` names it and links to its credentials
   * command. Every link into `skills/` must land on a real file and heading.
   */
  describe('setup wizard pointer', () => {
    function credentialsFiles(): string {
      return requiredSection(personasSection(readme), '#### Credentials files', IN_PERSONAS)
    }

    test('the Quick Start links to the wizard skill file', () => {
      const quickStart = requiredSection(readme, '## Quick Start', 'README.md')
      expect(markdownLinks(quickStart).map((link) => link.path)).toContain(WIZARD_FILE)
    })

    test(`"#### Credentials files" names the wizard, ${WIZARD_NAME}, outside any link target`, () => {
      const prose = splitFences(credentialsFiles()).prose.replace(/\]\([^)]*\)/g, ']')
      expect(prose).toMatch(new RegExp(`\\b${WIZARD_NAME}\\b`))
    })

    test(`"#### Credentials files" links to the wizard's "## ${WIZARD_CREDENTIALS_HEADING}" heading`, () => {
      const targets = markdownLinks(credentialsFiles()).map((link) => link.target)
      // That the heading exists in the wizard is the links-into-skills/ case below.
      expect(targets).toContain(`${WIZARD_FILE}#${headingSlug(WIZARD_CREDENTIALS_HEADING)}`)
    })

    test('every README link into skills/ names an existing file and, with an anchor, one of its headings', () => {
      const links = markdownLinks(readme).filter((link) => link.path.startsWith('skills/'))
      expect(links.length).toBeGreaterThan(0)
      const broken = links
        .filter((link) => {
          const file = resolve(REPO_ROOT, link.path)
          if (!existsSync(file) || !statSync(file).isFile()) return true
          return link.anchor !== '' && !headingAnchors(readFileSync(file, 'utf-8')).includes(link.anchor)
        })
        .map((link) => link.target)
      expect(broken).toEqual([])
    })
  })
})

/** Every file under `skills/`, repo-relative and sorted, so a skill added later is audited too. */
function shippedSkillFiles(): string[] {
  return (readdirSync(resolve(REPO_ROOT, 'skills'), { recursive: true }) as string[])
    .map((rel) => join('skills', rel))
    .filter((rel) => statSync(resolve(REPO_ROOT, rel)).isFile())
    .sort()
}

/**
 * The MCP instruction text: `MCP_INSTRUCTIONS` as src/registry.ts exports it,
 * the exact string every session server sends as its `instructions` (never
 * the source file's text: its comments and identifiers aren't shipped). Throws
 * when it is empty, so the audit never passes on nothing.
 */
function mcpInstructionsText(): string {
  if (MCP_INSTRUCTIONS.trim() === '') throw new Error('src/registry.ts exports an empty MCP_INSTRUCTIONS')
  return MCP_INSTRUCTIONS
}

/** The name the MCP instructions go by in the audit's failures and case titles. */
const MCP_INSTRUCTIONS_NAME = 'MCP instructions (src/registry.ts MCP_INSTRUCTIONS)'

/** The Slack Reply Guard, whose reminder text reaches every persona's instance. */
const REPLY_GUARD_FILE = 'stop-hooks/slack-reply-guard.sh'

/**
 * The Slack Reply Guard's reminder text: every `PROVENANCE="…"` wording and
 * the `REMINDER_TAIL="…"` the hook prints to the instance, one per line, read
 * as the literal strings the script assigns (not its comments or code; an
 * assignment that expands a variable is skipped). Throws when either is
 * missing, so the audit never passes on nothing.
 */
function replyGuardReminderText(): string {
  const script = readRepoFile(REPLY_GUARD_FILE)
  const literals = (name: string) =>
    [...script.matchAll(new RegExp(`^\\s*${name}="([^"$]*)"\\s*$`, 'gm'))].map((m) => m[1])
  const provenances = literals('PROVENANCE')
  const tails = literals('REMINDER_TAIL')
  if (provenances.length === 0 || tails.length !== 1) {
    throw new Error(`${REPLY_GUARD_FILE}: expected PROVENANCE wordings and one REMINDER_TAIL, found ${provenances.length} and ${tails.length}`)
  }
  return [...provenances, ...tails].join('\n')
}

/** The crontable header the server writes for a new crontable, as src/cron-bootstrap.ts exports it. */
function crontableHeaderText(): string {
  if (CRONTABLE_TEMPLATE_HEADER.trim() === '') throw new Error('src/cron-bootstrap.ts exports an empty CRONTABLE_TEMPLATE_HEADER')
  return CRONTABLE_TEMPLATE_HEADER
}

/**
 * The fixed sample arguments `set_channel_delivery`'s text builders are
 * rendered with (b.deo SRI-1308): a persona from `makePersona` (its key from
 * `personaKey`), a channel ID, a stored-choice file path, and one value and
 * one channel each builder echoes and one each does not show (b.deo
 * SRI-503). No token, no `LEAK_SENTINEL`, no banned term. Built at its first
 * call, when a case runs, so a `makePersona` change fails only the cases that
 * read it.
 */
const toolTextSample = lazy(() => {
  const persona = makePersona()
  const name = String(persona.name)
  return {
    name,
    key: personaKey(name),
    channel: 'C0TOOLTEXT1',
    path: join('/srv/cscb-state', CHANNEL_DELIVERY_FILE_NAME),
    echoedValue: 'everything',
    hiddenValue: 42,
    hiddenChannel: 'not a channel ID',
  }
})

/**
 * `set_channel_delivery`'s shipped texts (b.deo SRI-501, SRI-503 to SRI-506,
 * SRI-1308), each read through its export in src/registry.ts:
 * [export name, form ('' for a text with one form), text]. The listing texts
 * as exported; each builder rendered with `toolTextSample()`, the value and
 * channel refusals in their echoed and their not-shown forms, the result in
 * its plain and its loop-guard-held forms; and the two resolution refusals
 * every tool shares (b.av2 SR-5.1, b.deo SRI-502), named for this tool. Each
 * text is rendered when its case runs.
 */
const SET_CHANNEL_DELIVERY_TEXTS: readonly [exportName: string, form: string, text: () => string][] = (() => {
  const s = toolTextSample
  return [
    ['SET_CHANNEL_DELIVERY_DESCRIPTION', '', () => SET_CHANNEL_DELIVERY_DESCRIPTION],
    ['SET_CHANNEL_DELIVERY_CHANNEL_DESCRIPTION', '', () => SET_CHANNEL_DELIVERY_CHANNEL_DESCRIPTION],
    ['SET_CHANNEL_DELIVERY_DELIVERY_DESCRIPTION', '', () => SET_CHANNEL_DELIVERY_DELIVERY_DESCRIPTION],
    [channelDeliveryDeclarativeRefusal.name, '', () => channelDeliveryDeclarativeRefusal(s().name, s().key)],
    [channelDeliveryUnreadableRefusal.name, '', () => channelDeliveryUnreadableRefusal(s().name, s().key, s().path)],
    [channelDeliveryValueRefusal.name, 'echoed', () => channelDeliveryValueRefusal(s().name, s().key, s().echoedValue)],
    [channelDeliveryValueRefusal.name, 'not shown', () => channelDeliveryValueRefusal(s().name, s().key, s().hiddenValue)],
    [channelDeliveryChannelRefusal.name, 'echoed', () => channelDeliveryChannelRefusal(s().name, s().key, s().channel)],
    [channelDeliveryChannelRefusal.name, 'not shown', () => channelDeliveryChannelRefusal(s().name, s().key, s().hiddenChannel)],
    [channelDeliverySetResultText.name, 'plain', () => channelDeliverySetResultText(s().channel, 'all', { delivery: 'all', heldByLoopGuard: false })],
    [channelDeliverySetResultText.name, 'held by the loop guard', () => channelDeliverySetResultText(s().channel, 'all', { delivery: 'mentions', heldByLoopGuard: true })],
    [channelDeliveryWriteFailedText.name, '', () => channelDeliveryWriteFailedText(s().name, s().key, s().path)],
    [channelDeliveryNotStoredText.name, '', () => channelDeliveryNotStoredText(s().name, s().key, 'set_at')],
    [sessionNotMatchedRefusal.name, '', () => sessionNotMatchedRefusal(SET_CHANNEL_DELIVERY_TOOL)],
    [personaNotAppliedRefusal.name, '', () => personaNotAppliedRefusal(SET_CHANNEL_DELIVERY_TOOL, s().key)],
  ]
})()

/** A `SET_CHANNEL_DELIVERY_TEXTS` entry's name in failures and case titles: the tool, the export, its form, and its file. */
function toolTextName(exportName: string, form: string): string {
  return `${SET_CHANNEL_DELIVERY_TOOL} ${exportName}${form === '' ? '' : ` (${form})`} (src/registry.ts)`
}

/** A `SET_CHANNEL_DELIVERY_TEXTS` entry as a `SHIPPED_TEXTS` entry, throwing when its text is empty, so the audit never passes on nothing. */
function toolTextEntry([exportName, form, text]: (typeof SET_CHANNEL_DELIVERY_TEXTS)[number]): [string, () => string] {
  const entryName = toolTextName(exportName, form)
  return [entryName, () => {
    const value = text()
    if (value.trim() === '') throw new Error(`${entryName} is empty`)
    return value
  }]
}

/**
 * Every shipped text the audit reads: [name in failures, text]. The five
 * 0.11.1 tools' descriptions are not read: src/registry.ts builds them inline
 * in `createSessionServer` and exports no list to read them through.
 * `set_channel_delivery`'s texts are read through their exports
 * (`SET_CHANNEL_DELIVERY_TEXTS`, b.deo SRI-1308).
 */
const SHIPPED_TEXTS: [name: string, read: () => string][] = [
  ['README.md', () => readRepoFile('README.md')],
  ...shippedSkillFiles().map((rel): [string, () => string] => [rel, () => readRepoFile(rel)]),
  ['slack-app-manifest.yml', () => readRepoFile('slack-app-manifest.yml')],
  [CREDENTIALS_SCRIPT, () => readRepoFile(CREDENTIALS_SCRIPT)],
  [MCP_INSTRUCTIONS_NAME, mcpInstructionsText],
  [`${REPLY_GUARD_FILE} (reminder text)`, replyGuardReminderText],
  ['CRONTABLE_TEMPLATE_HEADER (src/cron-bootstrap.ts)', crontableHeaderText],
  ...SET_CHANNEL_DELIVERY_TEXTS.map(toolTextEntry),
]

const DEBUG_SKILL_FILE = 'skills/debug-slack-channel-bots/SKILL.md'
const INSTALL_SKILL_FILE = 'skills/install-cscb/SKILL.md'
const CHANGELOG_FILE = 'CHANGELOG.md'

/**
 * b.jg5 SRJ-1101's operator texts, [name, text], read from the repository:
 * the README, the debugging, install and setup skills, the architecture doc,
 * the engineering guide and the CHANGELOG. SRJ-1107's checks (the CHANGELOG
 * release entry, at the end of this file) read their texts through this
 * list. It is not `SHIPPED_TEXTS`: the forbidden-term audit still reads only
 * that list, which holds neither the CHANGELOG nor `docs/`.
 */
const OPERATOR_TEXTS: [name: string, read: () => string][] = [
  'README.md',
  DEBUG_SKILL_FILE,
  INSTALL_SKILL_FILE,
  WIZARD_FILE,
  'docs/architecture.md',
  'docs/engineering-guide.md',
  CHANGELOG_FILE,
].map((file): [string, () => string] => [file, () => readRepoFile(file)])

/** One operator text by its name; throws naming a name `OPERATOR_TEXTS` lacks. */
function operatorText(name: string): string {
  const entry = OPERATOR_TEXTS.find(([text]) => text === name)
  if (entry === undefined) throw new Error(`OPERATOR_TEXTS has no text "${name}"`)
  return entry[1]()
}

/** A shipped file's text: through `operatorText` when `OPERATOR_TEXTS` holds it, else read from the repository (a shipped file that is no operator text, such as skills/EXAMPLE_CLAUDE.md). */
function docText(file: string): string {
  return OPERATOR_TEXTS.some(([name]) => name === file) ? operatorText(file) : readRepoFile(file)
}

/**
 * b.av2 SR-12: the claim that a first @mention activates (wakes, unlocks)
 * event delivery in a channel, in the forms the README and the wizard once
 * shipped ("Slack may not deliver messages until the bot is @mentioned for
 * the first time … the first @mention activates event delivery"). Matched
 * case-insensitively across line breaks. "Until … @mention" counts only next
 * to a deliver, send or event word, and activation only with an activation
 * verb (not the generic "starts" or "enables"), so the receiving section's
 * legitimate @mention and delivery wording matches none of them; the control
 * table below pins both sides.
 */
const FIRST_MENTION_CLAIM: [label: string, pattern: RegExp][] = [
  ['a first @mention', /\bfirst\s+@?mention/gi],
  ['@mentioned for the first time', /@?mention(?:ed|s|ing)?\b[^.]{0,40}?\bfirst\s+time\b/gi],
  ['activating delivery', /\b(?:activat|wak|unlock)\w*\s+(?:the\s+)?(?:\w+\s+)?(?:event\s+)?delivery\b|\btrigger\w*\s+(?:the\s+)?(?:\w+\s+)?event\s+delivery\b/gi],
  [
    'no delivery until @mentioned',
    /\b(?:deliver|send|sent|event)\w*\b[^.]{0,40}?\buntil\b[^.]{0,40}?@?mention(?:ed|s)?\b|\buntil\b[^.]{0,40}?@?mention(?:ed|s)?\b[^.]{0,40}?\b(?:deliver|send|sent|event)\w*/gi,
  ],
]

/** Each match of `terms` in `text`, as `<label>: <matched text>`. */
function termsIn(text: string, terms: readonly [label: string, pattern: RegExp][]): string[] {
  return terms.flatMap(([label, pattern]) => [...text.matchAll(pattern)].map((m) => `${label}: ${m[0]}`))
}

describe(`shipped text audit (README, skills, manifest, MCP instructions, ${SET_CHANNEL_DELIVERY_TOOL}'s texts)`, () => {
  test(`the audit covers every skill file, the wizard's ${WIZARD_FILE} included`, () => {
    expect(SHIPPED_TEXTS.map(([name]) => name)).toContain(WIZARD_FILE)
  })

  test.each(SHIPPED_TEXTS)('SR-12: %s does not claim a first @mention activates event delivery', (_name, read) => {
    expect(termsIn(read(), FIRST_MENTION_CLAIM)).toEqual([])
  })

  /** Controls for the matcher: the historical claim and its variants match; ordinary @mention and delivery wording doesn't. */
  test.each([
    ['Slack may not deliver messages until the bot is @mentioned for the first time.', true],
    ['This is a Slack Socket Mode behavior — the first @mention activates event delivery for that channel.', true],
    ['@mention the bot once to activate delivery.', true],
    ['Until you @mention the bot, it gets no events.', true],
    ['A persona waits until it is @mentioned, then replies.', false],
    ['The server enables event delivery for every configured channel.', false],
  ] as const)('the first-@mention matcher on %p: matches is %p', (sentence, claim) => {
    expect(termsIn(sentence, FIRST_MENTION_CLAIM).length > 0).toBe(claim)
  })
})

// ---------------------------------------------------------------------------
// AC 46: the forbidden-term audit
// ---------------------------------------------------------------------------

/** One forbidden term: its label in case titles and failures, and its pattern (flag `g`, so every occurrence is found). */
type Term = readonly [label: string, pattern: RegExp]

/** A group of forbidden terms: what they stand for, the b.av2 SRs (or E14 decisions) that retire them, and the terms. */
interface TermGroup {
  name: string
  cites: string
  terms: readonly Term[]
}

/**
 * AC 46's forbidden terms: the one list the audit checks every shipped text
 * against. The first-@mention claim is `FIRST_MENTION_CLAIM` above, checked
 * by its own case; reload wording is `RELOAD_TERMS` (tests/test-helpers/
 * reload-terms.ts), checked in the MCP instructions only (SR-8.8 lets the README and the skills describe the
 * gesture).
 *
 * Matching rules:
 * - Key, file and variable names match as whole words (`\b…\b`), as written,
 *   so `default_route` doesn't match inside a longer key.
 * - The pre-persona shape is banned as nouns, not the verb (E14 decision 13):
 *   `routes` only as a config key (`` `routes` ``, `"routes"`, `routes:`),
 *   and route-keyed noun phrases ("per-route", "a/each/the route",
 *   "route's", "routed channel", "route map"). "The server routes each Slack
 *   event to every persona" and the MCP server name `slack-channel-router`
 *   never match. `"cwd"` counts only inside a channel-keyed map
 *   (`"C…": { … "cwd": … }`), so pasted agent-director output with a `cwd`
 *   field is not a hit.
 * - The access-control file's camelCase fields are matched case-sensitively,
 *   so the persona settings `ack_reaction`, `reply_chunk_limit` and
 *   `reply_chunk_mode` never match `ackReaction`, `textChunkLimit` or
 *   `chunkMode`.
 * - Wording is matched case-insensitively, with `\s+` between words so a
 *   phrase wrapped across lines still matches.
 * - A bearer token on a curl command line matches every header flag form
 *   (`-H "…"`, `--header "…"`, `--header=…`, unquoted); the wizard's curl
 *   config line `header = "Authorization: Bearer %s"` is not a flag.
 * - The retired name rule matches only tied to a name ("a name that looks
 *   like a Slack token"); the redaction wording "a value that looks like a
 *   Slack token" is not a hit.
 * - Token environment variables are banned by name and by export form, not
 *   by the phrase "token environment variables": E14 decision 12 prescribes
 *   that phrase for the README upgrade entry ("remove any token environment
 *   variables you exported for the previous version"), so banning it would
 *   need a second exemption; a name or an export is what would tell an
 *   operator to set one.
 */
const FORBIDDEN_TERMS: readonly TermGroup[] = [
  {
    name: 'the pre-persona shape',
    cites: 'b.av2 SR-1.7, SR-10.2',
    terms: [
      ['routes', /`routes`|"routes"|\broutes:/g],
      ['default_route', /\bdefault_route\b/g],
      ['default_dm_session', /\bdefault_dm_session\b/g],
      ['per-route', /\bper[- ]route\b/gi],
      ['a/each/the route', /\b(?:a|each|the)\s+route\b/gi],
      ["route's", /\broute['’]s\b/gi],
      ['routing config', /\brouting\s+config(?:uration)?\b/gi],
      ['routed channel', /\brouted\s+channels?\b/gi],
      ['route map', /\broute\s+maps?\b/gi],
      ['a "cwd" in a channel-keyed map', /"C[A-Z0-9]+"\s*:\s*\{[^}]*"cwd"\s*:/g],
    ],
  },
  {
    name: 'the token environment variables',
    cites: 'b.av2 SR-1.4, SR-10.2; E14 decision 12',
    terms: [
      ['SLACK_BOT_TOKEN', /\bSLACK_BOT_TOKEN\b/g],
      ['SLACK_APP_TOKEN', /\bSLACK_APP_TOKEN\b/g],
      ['an export of a token variable', /\bexport\s+\w*TOKEN\w*=/gi],
      ['`export` lines for a shell profile', /`export`\s+lines\b/gi],
    ],
  },
  {
    name: 'a token on a command line',
    cites: 'b.av2 SR-1.4',
    terms: [['a bearer token in a curl header flag', /(?:-H|--header)[\s=]+["']?Authorization:\s*Bearer\b/gi]],
  },
  {
    name: 'the access-control file and its model',
    cites: 'b.av2 SR-10.1, SR-10.2, SR-12',
    terms: [
      ['access.json', /\baccess\.json\b/gi],
      ['SLACK_ACCESS_MODE', /\bSLACK_ACCESS_MODE\b/g],
      ['/slack-channel:access', /\bslack-channel:access\b/gi],
      ['claude-slack-channels-config', /\bclaude-slack-channels-config\b/gi],
      ['dmPolicy', /\bdmPolicy\b/g],
      ['allowFrom', /\ballowFrom\b/g],
      ['requireMention', /\brequireMention\b/g],
      ['ackReaction', /\backReaction\b/g],
      ['textChunkLimit', /\btextChunkLimit\b/g],
      ['chunkMode', /\bchunkMode\b/g],
      ['access-control wording', /\baccess[- ]control\b/gi],
      ['allowlist wording', /\ballow[- ]?list(?:s|ed|ing)?\b/gi],
      ['pairing wording', /\bpairing\b/gi],
    ],
  },
  {
    name: 'the retired persona-name rule',
    cites: 'b.av2 SR-1.2; E14 Task 0',
    terms: [['a name that "looks like a Slack token"', /\bnames?\b[^.]{0,40}\blooks?\s+like\s+an?\s+(?:Slack\s+)?token\b/gi]],
  },
]

/** One exemption: `terms` may appear in `file` only inside the section under `heading` (bounded at the next heading of its level or higher). */
interface AuditException {
  file: string
  heading: string
  terms: readonly string[]
  reason: string
}

/**
 * The first exemption (b.av2 SR-12): the debugging skill's SR-1.7 entry may
 * name the three pre-persona keys to say they are rejected. Any other term
 * inside that section, and those keys anywhere else, still fail. When the
 * heading is missing the audit throws for that file; it never exempts the
 * whole file.
 */
const SR_1_7_EXCEPTION: AuditException = {
  file: 'skills/debug-slack-channel-bots/SKILL.md',
  heading: '## Pre-persona configuration',
  terms: ['routes', 'default_route', 'default_dm_session'],
  reason: 'b.av2 SR-1.7 rejection entry: names the keys only to say they are rejected',
}

/**
 * The switch-over runbook's exemption (b.jg5 SRJ-1108, SRJ-1516): the README
 * section may name `access.json` among the previous CSCB's files it saves and
 * restores. Every other term stays banned there, the token variables' names
 * included, and `access.json` stays banned everywhere else. A missing heading
 * throws, as for the SR-1.7 entry. The rollback section has its own entry,
 * below.
 */
const SWITCH_OVER_EXCEPTION: AuditException = {
  file: 'README.md',
  heading: `### ${PHASE1_RUNBOOK_SECTION_TITLE}`,
  terms: ['access.json'],
  reason: "b.jg5 SRJ-1108, SRJ-1516: the switch-over runbook saves and restores the previous CSCB's access.json",
}

/** The rollback section's heading as the README writes it: a `###` under `## Migration`, after the switch-over section. */
const ROLLBACK_HEADING = `### ${ROLLBACK_RUNBOOK_SECTION_TITLE}`

/**
 * The rollback runbook's exemption (b.jg5 SRJ-1109, SRJ-1516): the README
 * section may name `access.json` among the files its step 8 restores. As for
 * the switch-over entry: every other term stays banned there, the token
 * variables' names included, `access.json` stays banned everywhere else, and
 * a missing heading throws.
 */
const ROLLBACK_EXCEPTION: AuditException = {
  file: 'README.md',
  heading: ROLLBACK_HEADING,
  terms: ['access.json'],
  reason: "b.jg5 SRJ-1109, SRJ-1516: the rollback runbook's step 8 restores the previous CSCB's access.json",
}

/** The two runbook entries (SRJ-1516): one per README runbook section, each exempting only `access.json`. */
const RUNBOOK_EXCEPTIONS: readonly AuditException[] = [SWITCH_OVER_EXCEPTION, ROLLBACK_EXCEPTION]

const AUDIT_EXCEPTIONS: readonly AuditException[] = [SR_1_7_EXCEPTION, ...RUNBOOK_EXCEPTIONS]

/** A forbidden term found in a text: its file, 1-based line, term label, matched text and whole line. */
interface TermHit {
  file: string
  line: number
  term: string
  match: string
  text: string
}

/** A hit as a failure line: `<file>:<line>: <term> ("<match>") in: <line>`. */
function formatHit(hit: TermHit): string {
  return `${hit.file}:${hit.line}: ${hit.term} ("${hit.match}") in: ${hit.text}`
}

/** Every occurrence of `terms` in `text`, with the line each starts on. Pure. */
function findTerms(file: string, text: string, terms: readonly Term[]): TermHit[] {
  return findTermsAt(file, text, terms).map(({ hit }) => hit)
}

/** `findTerms`, with each hit's offset in `text`, for a check that leaves some spans of the text out. Pure. */
function findTermsAt(file: string, text: string, terms: readonly Term[]): { hit: TermHit; index: number }[] {
  const lines = text.split('\n')
  return terms.flatMap(([term, pattern]) =>
    [...text.matchAll(pattern)].map((m) => {
      const index = m.index ?? 0
      const line = text.slice(0, index).split('\n').length
      return { index, hit: { file, line, term, match: flat(m[0]), text: lines[line - 1].trim() } }
    }),
  )
}

/**
 * `file`'s hits of `terms`, split into `hits` (failures) and `allowed` (inside
 * an exemption of `exceptions` for that file). Throws when an exemption's
 * heading is missing from `text`. Pure.
 */
function auditText(
  file: string,
  text: string,
  terms: readonly Term[],
  exceptions: readonly AuditException[] = AUDIT_EXCEPTIONS,
): { hits: TermHit[]; allowed: TermHit[] } {
  const ranges = exceptions
    .filter((exception) => exception.file === file)
    .map((exception) => {
      const range = sectionRange(text, exception.heading)
      if (range === undefined) {
        throw new Error(`${file} has no heading "${exception.heading}" (${exception.reason}); nothing in it is exempted`)
      }
      // 0-based [start, end) to 1-based lines, heading line included.
      return { terms: exception.terms, first: range.start + 1, last: range.end }
    })
  const exempt = (hit: TermHit) =>
    ranges.some((r) => r.terms.includes(hit.term) && hit.line >= r.first && hit.line <= r.last)
  const found = findTerms(file, text, terms)
  return { hits: found.filter((hit) => !exempt(hit)), allowed: found.filter(exempt) }
}

/** Every forbidden term, across the groups. */
const ALL_FORBIDDEN_TERMS: readonly Term[] = FORBIDDEN_TERMS.flatMap((group) => group.terms)

/** A group's term labels, for case titles. */
function termLabels(group: TermGroup): string {
  return group.terms.map(([label]) => label).join(', ')
}

describe(`AC 46: forbidden-term audit (README, skills, manifest, MCP instructions, ${SET_CHANNEL_DELIVERY_TOOL}'s texts)`, () => {
  test('the audit reads skills/EXAMPLE_CLAUDE.md', () => {
    expect(SHIPPED_TEXTS.map(([name]) => name)).toContain('skills/EXAMPLE_CLAUDE.md')
  })

  /**
   * b.deo SRI-1308: the audit reads every `set_channel_delivery` text
   * src/registry.ts exports (its listing texts, `SET_CHANNEL_DELIVERY_*`
   * `DESCRIPTION`; its builders, `channelDelivery…Refusal` and
   * `channelDelivery…Text`), found among the module's exports, so a text
   * added later is read too; the two shared resolution refusals; and both
   * forms of each builder that has two. The expected names are built from
   * the module, never from `SET_CHANNEL_DELIVERY_TEXTS`, so dropping an entry
   * fails here.
   */
  test(`the audit reads each of ${SET_CHANNEL_DELIVERY_TOOL}'s exported texts, each form of each two-form builder (b.deo SRI-1308)`, () => {
    const TWO_FORMS: Record<string, readonly string[]> = {
      [channelDeliveryValueRefusal.name]: ['echoed', 'not shown'],
      [channelDeliveryChannelRefusal.name]: ['echoed', 'not shown'],
      [channelDeliverySetResultText.name]: ['plain', 'held by the loop guard'],
    }
    const exported = Object.keys(registryExports).filter((name) => /^(?:SET_CHANNEL_DELIVERY_\w*DESCRIPTION|channelDelivery\w+(?:Refusal|Text))$/.test(name))
    expect(exported.length).toBeGreaterThanOrEqual(10)
    const expected = [...exported, sessionNotMatchedRefusal.name, personaNotAppliedRefusal.name]
      .flatMap((name) => (TWO_FORMS[name] ?? ['']).map((form) => toolTextName(name, form)))
    const read = SHIPPED_TEXTS.map(([name]) => name)
    expect(expected.filter((name) => !read.includes(name))).toEqual([])
  })

  test(`each two-form ${SET_CHANNEL_DELIVERY_TOOL} builder is read in both forms: the echoed form names the sample, the not-shown one does not`, () => {
    const text = (exportName: string, form: string) => SET_CHANNEL_DELIVERY_TEXTS.find(([n, f]) => n === exportName && f === form)![2]()
    const sample = toolTextSample()
    expect(text(channelDeliveryValueRefusal.name, 'echoed')).toContain(JSON.stringify(sample.echoedValue))
    expect(text(channelDeliveryValueRefusal.name, 'not shown')).not.toContain(String(sample.hiddenValue))
    expect(text(channelDeliveryChannelRefusal.name, 'echoed')).toContain(JSON.stringify(sample.channel))
    expect(text(channelDeliveryChannelRefusal.name, 'not shown')).not.toContain(sample.hiddenChannel)
    expect(text(channelDeliverySetResultText.name, 'held by the loop guard')).not.toBe(text(channelDeliverySetResultText.name, 'plain'))
  })

  test(`the audit reads ${CREDENTIALS_SCRIPT}, whose prompts and messages the operator sees`, () => {
    expect(SHIPPED_TEXTS.map(([name]) => name)).toContain(CREDENTIALS_SCRIPT)
  })

  const cases = SHIPPED_TEXTS.flatMap(([name, read]) =>
    FORBIDDEN_TERMS.map((group) => [name, group.name, group.cites, termLabels(group), read, group] as const),
  )

  test.each(cases)('%s: none of %s (%s): %s', (name, _group, _cites, _labels, read, group) => {
    expect(auditText(name, read(), group.terms).hits.map(formatHit)).toEqual([])
  })

  test(`the only allowed hit: ${SR_1_7_EXCEPTION.terms.join(', ')} in ${SR_1_7_EXCEPTION.file} under "${SR_1_7_EXCEPTION.heading}" (SR-1.7); with the exemption off, they appear nowhere else in shipped text`, () => {
    const keys = ALL_FORBIDDEN_TERMS.filter(([label]) => SR_1_7_EXCEPTION.terms.includes(label))
    expect(keys.map(([label]) => label)).toEqual([...SR_1_7_EXCEPTION.terms])
    const hits = SHIPPED_TEXTS.flatMap(([name, read]) => auditText(name, read(), keys, []).hits)
    const range = sectionRange(readRepoFile(SR_1_7_EXCEPTION.file), SR_1_7_EXCEPTION.heading)
    if (range === undefined) throw new Error(`${SR_1_7_EXCEPTION.file} has no heading "${SR_1_7_EXCEPTION.heading}"`)
    const inside = (hit: TermHit) => hit.file === SR_1_7_EXCEPTION.file && hit.line > range.start && hit.line <= range.end
    expect(hits.filter((hit) => !inside(hit)).map(formatHit)).toEqual([])
    expect([...new Set(hits.map((hit) => hit.term))].sort()).toEqual([...SR_1_7_EXCEPTION.terms].sort())
  })

  test('the exemptions are exactly the SR-1.7 entry and the two runbook entries, each runbook entry exempting only access.json in README.md (SRJ-1516)', () => {
    expect(AUDIT_EXCEPTIONS.map((e) => [e.file, e.heading, [...e.terms]])).toEqual([
      [SR_1_7_EXCEPTION.file, SR_1_7_EXCEPTION.heading, [...SR_1_7_EXCEPTION.terms]],
      ['README.md', `### ${PHASE1_RUNBOOK_SECTION_TITLE}`, ['access.json']],
      ['README.md', `### ${ROLLBACK_RUNBOOK_SECTION_TITLE}`, ['access.json']],
    ])
  })

  test(`the only allowed hits: access.json in README.md under "${SWITCH_OVER_EXCEPTION.heading}" and under "${ROLLBACK_EXCEPTION.heading}" (SRJ-1108, SRJ-1109, SRJ-1516); with the exemptions off, it appears nowhere else in shipped text, and both exemptions are used`, () => {
    const terms = ALL_FORBIDDEN_TERMS.filter(([label]) => label === 'access.json')
    expect(terms.map(([label]) => label)).toEqual(['access.json'])
    const readme = operatorText('README.md')
    const ranges = RUNBOOK_EXCEPTIONS.map((exception) => {
      const range = sectionRange(readme, exception.heading)
      if (range === undefined) throw new Error(`README.md has no heading "${exception.heading}"`)
      return range
    })
    const inside = (hit: TermHit) => hit.file === 'README.md' && ranges.some((range) => hit.line > range.start && hit.line <= range.end)
    const hits = SHIPPED_TEXTS.flatMap(([name, read]) => auditText(name, read(), terms, []).hits)
    expect(hits.filter((hit) => !inside(hit)).map(formatHit)).toEqual([])
    expect(auditText('README.md', readme, terms).hits.map(formatHit)).toEqual([])
    // Each runbook entry, alone, allows at least one hit: neither exemption is idle.
    expect(RUNBOOK_EXCEPTIONS.map((exception) => [exception.heading, auditText('README.md', readme, terms, [exception]).allowed.length > 0])).toEqual(
      RUNBOOK_EXCEPTIONS.map((exception) => [exception.heading, true]),
    )
  })

  test(`the SR-1.7 entry names the three keys, says they are rejected and that the configuration must be rewritten as personas`, () => {
    const entry = flat(requiredSection(readRepoFile(SR_1_7_EXCEPTION.file), SR_1_7_EXCEPTION.heading, SR_1_7_EXCEPTION.file))
    for (const key of SR_1_7_EXCEPTION.terms) expect(entry).toContain(`\`${key}\``)
    expect(entry).toMatch(/\brejected\b/i)
    expect(entry).toMatch(/\brewrit\w*\b[^.]*\bpersonas\b/i)
  })

  /**
   * Shipped wording that is deliberately not a hit, each tied to its file and
   * the reason no term matches it. Not exemptions: each line is scanned like
   * any other; these cases pin that the term list leaves them alone. A
   * RegExp names a line whose text is read from the file.
   */
  const NOT_HITS_BY_DESIGN: [file: string, snippet: string | RegExp, reason: string][] = [
    [SR_1_7_EXCEPTION.file, "## A persona's routing settings were changed by a confirmed change", "E14 decision 12: a persona's channel and DM settings"],
    [SR_1_7_EXCEPTION.file, '#a-personas-routing-settings-were-changed-by-a-confirmed-change', "E14 decision 12: that heading's anchor"],
    [SR_1_7_EXCEPTION.file, '`[slack] persona-routing: ', "E14 decision 12: the server's real log prefix"],
    [SR_1_7_EXCEPTION.file, 'routinely', 'whole words: "routine" is not "routes"'],
    ['README.md', 'remove any token environment variables you exported for the previous version', "E14 decision 12's upgrade wording: variables are banned by name and export form"],
    ['README.md', 'slack-channel-router', 'the MCP server name; no route term matches it'],
    [CREDENTIALS_SCRIPT, 'header = "Authorization: Bearer %s"', "the credentials script's curl config line, read from curl's stdin, not a command-line argument"],
    [WIZARD_FILE, /^allowed-tools:.*$/m, 'skill frontmatter: a tool list, not an allowlist'],
  ]

  test.each(NOT_HITS_BY_DESIGN)('%s: %p is not a hit (%s)', (file, snippet, _reason) => {
    const text = readRepoFile(file)
    const line = typeof snippet === 'string' ? (text.includes(snippet) ? snippet : undefined) : snippet.exec(text)?.[0]
    if (line === undefined) throw new Error(`${file} no longer contains ${String(snippet)}`)
    expect(findTerms(file, line, ALL_FORBIDDEN_TERMS).map(formatHit)).toEqual([])
  })
})

/**
 * Self-checks for the scanner and the exemption, on in-memory text only: each
 * term is flagged, the SR-1.7 exemption covers only its three keys and only
 * inside its section, and persona wording is left alone.
 */
describe('AC 46: forbidden-term scanner self-checks', () => {
  /** One sample per term, so a term added to the list needs a sample here. */
  const SAMPLES: Record<string, string> = {
    routes: 'Set `routes` to a map of channels.',
    default_route: 'Set `default_route` to a channel.',
    default_dm_session: 'Set `default_dm_session`.',
    'per-route': 'Each per-route working directory.',
    'a/each/the route': 'Each route has a cwd.',
    "route's": "The route's session starts on demand.",
    'routing config': 'Edit the routing\n  config in the file.',
    'routed channel': 'Each routed channel has a session.',
    'route map': 'The route map lists channels.',
    'a "cwd" in a channel-keyed map': '{ "C0000": { "cwd": "~/work" } }',
    SLACK_BOT_TOKEN: 'Set SLACK_BOT_TOKEN in your shell.',
    SLACK_APP_TOKEN: 'Set SLACK_APP_TOKEN in your shell.',
    'an export of a token variable': 'export MY_TOKEN="<bot token>"',
    '`export` lines for a shell profile': 'Add the `export`\nlines to your shell profile.',
    'a bearer token in a curl header flag': 'curl -H "Authorization: Bearer <bot token>" https://slack.com/api/auth.test',
    'access.json': 'Edit access.json by hand.',
    SLACK_ACCESS_MODE: 'Set SLACK_ACCESS_MODE to static.',
    '/slack-channel:access': 'Run /slack-channel:access to pair.',
    'claude-slack-channels-config': 'Run the claude-slack-channels-config skill to add a channel.',
    dmPolicy: 'Set "dmPolicy" to open.',
    allowFrom: 'Add the user to allowFrom.',
    requireMention: 'Set requireMention for the channel.',
    ackReaction: 'Set ackReaction to eyes.',
    textChunkLimit: 'Set textChunkLimit to 4000.',
    chunkMode: 'Set chunkMode to newline.',
    'access-control wording': 'The Access Control file decides who may DM.',
    'allowlist wording': 'Add the user to the allow-list.',
    'pairing wording': 'Pairing codes expire after an hour.',
    'a name that "looks like a Slack token"': 'A name that looks like a Slack\ntoken is rejected.',
  }

  /**
   * More must-flag samples for the terms decision 13 narrowed: each form of
   * the `routes` key, each route-keyed noun phrase, and each curl header
   * flag form.
   */
  test.each([
    ['routes', '`routes` in backticks', 'Remove `routes` from config.json.'],
    ['routes', 'a quoted "routes" key', '{ "routes": { "C0000": {} } }'],
    ['routes', 'a routes: key', 'routes:\n  C0000: {}'],
    ['a/each/the route', '"a route"', 'Add a route for the new channel.'],
    ['a/each/the route', '"the route"', 'The route for that channel is missing.'],
    ['a "cwd" in a channel-keyed map', 'a multi-line channel map', '{\n  "C0ABC123": {\n    "name": "x",\n    "cwd": "~/work"\n  }\n}'],
    ['a bearer token in a curl header flag', '--header "…"', 'curl --header "Authorization: Bearer <bot token>" https://slack.com/api/auth.test'],
    ['a bearer token in a curl header flag', 'unquoted -H', 'curl -H Authorization:Bearer\\ <bot token> https://slack.com/api/auth.test'],
    ['a bearer token in a curl header flag', '--header=…', "curl --header='Authorization: Bearer <bot token>' https://slack.com/api/auth.test"],
    ['a name that "looks like a Slack token"', 'plural names', 'Persona names that look like a token are rejected.'],
  ] as const)('%s is flagged in %s', (label, _form, text) => {
    expect(findTerms('sample', text, ALL_FORBIDDEN_TERMS).map((hit) => hit.term)).toContain(label)
  })

  test('every term has a sample', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(ALL_FORBIDDEN_TERMS.map(([label]) => label).sort())
  })

  test.each(FORBIDDEN_TERMS.flatMap((group) => group.terms.map(([label]) => [group.name, label] as const)))(
    '%s: the term %s is flagged in its sample',
    (_group, label) => {
      expect(findTerms('sample', SAMPLES[label], ALL_FORBIDDEN_TERMS).map((hit) => hit.term)).toContain(label)
    },
  )

  test.each([
    ['the moved persona settings', '`ack_reaction`, `reply_chunk_limit` and `reply_chunk_mode` are server-wide settings.'],
    ['the MCP server name', 'Tags carry source="slack-channel-router".'],
    ['"routine" and "routinely"', 'Slack refreshes connections routinely; a routine refresh needs no action.'],
    ['routing settings and the log prefix', "## A persona's routing settings\n`[slack] persona-routing: lost-message notice`"],
    ['persona channel and DM wording', 'Each persona lists its `channels`, each with a `delivery`, and a per-persona `dm.enabled` switch.'],
    ['frontmatter tool list', 'allowed-tools: [Read, Write, Edit, Bash, Glob]'],
    ["decision 12's upgrade wording", 'Remove any token environment variables you exported for the previous version.'],
    ['a non-token environment variable', 'Your persona key is in the `CSCB_PERSONA` environment variable. export CSCB_CRON_DIR=~/cron'],
    ['the curl config header line', `  h='header = "Authorization: Bearer %s"\\n'`],
    ['a token-like name, as the README now words it', 'a token-like name is redacted there too'],
    ['"routes" as a verb (decision 13)', 'The server routes each Slack event to every persona that receives it.'],
    ['pasted agent-director `cwd` output', '{\n  "claude_instance_id": "cscb_alpha",\n  "cwd": "/home/me/work",\n  "label": { "service": "cscb" }\n}'],
    ['the redaction wording, not the name rule', 'A config error never echoes a value that looks like a Slack token.'],
    ['the curl config header line, unindented', 'header = "Authorization: Bearer %s"'],
  ])('%s is not flagged', (_label, text) => {
    expect(findTerms('sample', text, ALL_FORBIDDEN_TERMS).map(formatHit)).toEqual([])
  })

  const FILE = SR_1_7_EXCEPTION.file
  /** A synthetic debugging skill: the SR-1.7 section (with a subsection) between two other sections. */
  const skill = (earlier: string, entry: string, later: string) =>
    [
      '# Debugging', //                                  l.1
      '## Earlier', //                                   l.2
      earlier, //                                        l.3
      SR_1_7_EXCEPTION.heading, //                       l.4
      entry, //                                          l.5
      '### Detail', //                                   l.6
      'Still inside: `default_route` is rejected.', //   l.7
      '## Later', //                                     l.8
      later, //                                          l.9
    ].join('\n')
  const ENTRY = '`routes`, `default_route` and `default_dm_session` are rejected.'

  test('inside the SR-1.7 section, including its subsections, the three keys are allowed, not hits', () => {
    const { hits, allowed } = auditText(FILE, skill('-', ENTRY, '-'), ALL_FORBIDDEN_TERMS)
    expect(hits).toEqual([])
    expect(allowed.map((hit) => `${hit.line}: ${hit.term}`)).toEqual(['5: routes', '5: default_route', '7: default_route', '5: default_dm_session'])
  })

  test.each([
    ['just after the section', skill('-', ENTRY, 'Set `default_route`.'), `${FILE}:9: default_route`],
    ['just before the section', skill('Set `default_dm_session`.', ENTRY, '-'), `${FILE}:3: default_dm_session`],
  ])('a pre-persona key %s is a hit, with file and line', (_where, text, expected) => {
    const hits = auditText(FILE, text, ALL_FORBIDDEN_TERMS).hits.map(formatHit)
    expect(hits).toHaveLength(1)
    expect(hits[0].startsWith(expected)).toBe(true)
  })

  test('the same section in another skill exempts nothing', () => {
    const other = 'skills/other-skill/SKILL.md'
    const { hits, allowed } = auditText(other, skill('-', ENTRY, '-'), ALL_FORBIDDEN_TERMS)
    expect(allowed).toEqual([])
    expect(hits.map((hit) => `${hit.file}:${hit.line}: ${hit.term}`).sort()).toEqual(
      [`${other}:5: routes`, `${other}:5: default_route`, `${other}:7: default_route`, `${other}:5: default_dm_session`].sort(),
    )
  })

  test.each([
    ['a token variable', 'Unset SLACK_BOT_TOKEN too.', 'SLACK_BOT_TOKEN'],
    ['the access-control file', 'Delete access.json too.', 'access.json'],
    ['route-keyed wording', 'Each per-route setting is gone.', 'per-route'],
  ])('%s inside the SR-1.7 section is a hit', (_label, line, term) => {
    const { hits } = auditText(FILE, skill('-', `${ENTRY}\n${line}`, '-'), ALL_FORBIDDEN_TERMS)
    expect(hits.map((hit) => `${hit.line}: ${hit.term}`)).toEqual([`6: ${term}`])
  })

  test.each([
    ['removed', (text: string) => text.replace(`${SR_1_7_EXCEPTION.heading}\n`, '')],
    ['renamed', (text: string) => text.replace(SR_1_7_EXCEPTION.heading, '## Legacy configuration')],
    ['moved to another level', (text: string) => text.replace(SR_1_7_EXCEPTION.heading, `#${SR_1_7_EXCEPTION.heading}`)],
  ])('with the SR-1.7 heading %s, the audit fails naming it and exempts nothing', (_how, edit) => {
    expect(() => auditText(FILE, edit(skill('-', ENTRY, '-')), ALL_FORBIDDEN_TERMS)).toThrow(
      `${FILE} has no heading "${SR_1_7_EXCEPTION.heading}"`,
    )
  })

  /** The two runbook exemptions (b.jg5 SRJ-1108, SRJ-1109, SRJ-1516), on a synthetic README. */
  describe('the two runbook exemptions', () => {
    const README = 'README.md'
    const SAVE = 'Keep a copy of `access.json`.'
    const RESTORE = 'Put back `access.json`.'
    type Parts = { earlier: string; inSwitchOver: string; between: string; inRollback: string; later: string; other: string }
    const EMPTY: Parts = { earlier: '-', inSwitchOver: '-', between: '-', inRollback: '-', later: '-', other: '-' }
    /**
     * A synthetic README: the switch-over section and the rollback section,
     * each with a step subsection, a section between them, one after them,
     * then another `##` section. Line numbers hold while each part is one line.
     */
    const readme = (parts: Partial<Parts>) => {
      const p = { ...EMPTY, ...parts }
      return [
        '# CSCB', //                                                  l.1
        '## Migration', //                                            l.2
        p.earlier, //                                                 l.3
        SWITCH_OVER_EXCEPTION.heading, //                             l.4
        p.inSwitchOver, //                                            l.5
        `#### ${stepHeadingPrefix(1)}Check the host`, //              l.6
        SAVE, //                                                      l.7
        '### Between the runbooks', //                                l.8
        p.between, //                                                 l.9
        ROLLBACK_EXCEPTION.heading, //                                l.10
        p.inRollback, //                                              l.11
        `#### ${stepHeadingPrefix(8)}Reinstall the previous CSCB`, // l.12
        RESTORE, //                                                   l.13
        '### Upgrading to personas', //                               l.14
        p.later, //                                                   l.15
        '## Troubleshooting', //                                      l.16
        p.other, //                                                   l.17
      ].join('\n')
    }

    test('inside either section, including its subsections, access.json is allowed, not a hit', () => {
      const { hits, allowed } = auditText(README, readme({ inSwitchOver: SAVE, inRollback: RESTORE }), ALL_FORBIDDEN_TERMS)
      expect(hits).toEqual([])
      expect(allowed.map((hit) => `${hit.line}: ${hit.term}`)).toEqual(['5: access.json', '7: access.json', '11: access.json', '13: access.json'])
    })

    test.each([
      ['just before the switch-over section', { earlier: SAVE }, `${README}:3: access.json`],
      ['between the two sections', { between: SAVE }, `${README}:9: access.json`],
      ['just after the rollback section', { later: RESTORE }, `${README}:15: access.json`],
      ['in another section', { other: RESTORE }, `${README}:17: access.json`],
    ] as const)('access.json %s is a hit, with file and line', (_where, parts, expected) => {
      const hits = auditText(README, readme(parts), ALL_FORBIDDEN_TERMS).hits.map(formatHit)
      expect(hits).toHaveLength(1)
      expect(hits[0].startsWith(expected)).toBe(true)
    })

    const OTHER_TERMS = [
      ['a token variable', 'Unset SLACK_APP_TOKEN too.', 'SLACK_APP_TOKEN'],
      ['the other token variable', 'Set SLACK_BOT_TOKEN again.', 'SLACK_BOT_TOKEN'],
      ['an export of a token variable', 'export MY_TOKEN="<bot token>"', 'an export of a token variable'],
      ['access-control wording', 'It holds the access control list.', 'access-control wording'],
      ['a pre-persona key', 'Put `default_route` back.', 'default_route'],
    ] as const

    /** Each section with the synthetic README carrying `line` just inside it, and the line number `line` lands on. */
    const WITH_LINE_INSIDE: [section: string, build: (line: string) => string, lineNumber: number][] = [
      ['switch-over', (line) => readme({ inSwitchOver: `${SAVE}\n${line}`, inRollback: RESTORE }), 6],
      ['rollback', (line) => readme({ inSwitchOver: SAVE, inRollback: `${RESTORE}\n${line}` }), 12],
    ]

    test.each(WITH_LINE_INSIDE.flatMap(([section, build, lineNumber]) => OTHER_TERMS.map(([label, line, term]) => [label, section, build(line), `${lineNumber}: ${term}`] as const)))(
      '%s inside the %s section is a hit',
      (_label, _section, text, expected) => {
        expect(auditText(README, text, ALL_FORBIDDEN_TERMS).hits.map((hit) => `${hit.line}: ${hit.term}`)).toEqual([expected])
      },
    )

    test('the same headings in a skill exempt nothing', () => {
      const other = 'skills/other-skill/SKILL.md'
      const { hits, allowed } = auditText(other, readme({ inSwitchOver: SAVE, inRollback: RESTORE }), ALL_FORBIDDEN_TERMS)
      expect(allowed).toEqual([])
      expect(hits.map((hit) => `${hit.file}:${hit.line}: ${hit.term}`)).toEqual(
        [5, 7, 11, 13].map((line) => `${other}:${line}: access.json`),
      )
    })

    test.each(
      RUNBOOK_EXCEPTIONS.flatMap(({ heading }) => [
        ['removed', heading, (text: string) => text.replace(`${heading}\n`, '')],
        ['renamed', heading, (text: string) => text.replace(heading, '### A runbook')],
        ['moved to another level', heading, (text: string) => text.replace(heading, `#${heading}`)],
      ] as const),
    )('with the heading %s (%s), the audit fails naming it and exempts nothing', (_how, heading, edit) => {
      const edited = edit(readme({ inSwitchOver: SAVE, inRollback: RESTORE }))
      expect(edited).not.toBe(readme({ inSwitchOver: SAVE, inRollback: RESTORE }))
      expect(() => auditText(README, edited, ALL_FORBIDDEN_TERMS)).toThrow(`${README} has no heading "${heading}"`)
    })
  })
})

// ---------------------------------------------------------------------------
// AC 46: the README's receiving section (b.av2 SR-12, SR-4.4)
// ---------------------------------------------------------------------------

/**
 * Every `via` value (b.av2 SR-4.4), with the README row that delivers it.
 * src/delivery-decision.ts exports only `type Via`, no runtime list, so the
 * list is written out here; typing it `Record<Via, …>` fails the typecheck
 * when a value is added to or removed from `Via` until this list follows.
 */
const VIA_ROWS: Record<Via, string> = {
  dm: 'Direct message',
  mention: 'Direct @mention',
  broadcast: '`@here` / `@channel` broadcast',
  receive_all_shared: 'Every message, shared channel',
  receive_all: 'Every message, this persona alone',
}
const VIA_VALUES = Object.keys(VIA_ROWS) as Via[]

const RECEIVING_HEADING = '## How a persona receives messages'

/** The two injected kinds' rows in the receiving table: they carry no `via` (b.av2 SR-12). */
const INJECTED_ROWS = ['Scheduled prompt', '`/interject` message']

/** Every pipe table in `section`, each as its header cells and body rows (the `|---|` line skipped). */
function pipeTables(section: string): { header: string[]; rows: string[][] }[] {
  const tables: { header: string[]; rows: string[][] }[] = []
  let block: string[] = []
  for (const line of [...section.split('\n'), '']) {
    if (line.trimStart().startsWith('|')) {
      block.push(line)
      continue
    }
    if (block.length > 0) {
      const [header, , ...rows] = block.map(tableCells)
      tables.push({ header, rows })
      block = []
    }
  }
  return tables
}

describe(`AC 46: README "${RECEIVING_HEADING}" (SR-12, SR-4.4)`, () => {
  const readme = readRepoFile('README.md')
  const section = () => requiredSection(readme, RECEIVING_HEADING, 'README.md')

  /**
   * The section's table of the ways a message reaches a persona: the one
   * table whose first column is `Kind` and that has a `` `via` `` column.
   * Throws naming what is missing, so the row cases never pass on nothing.
   */
  function kindsTable(): { viaColumn: number; rows: string[][] } {
    const tables = pipeTables(section()).filter((t) => t.header[0] === 'Kind' && t.header.includes('`via`'))
    if (tables.length !== 1) {
      throw new Error(`README.md "${RECEIVING_HEADING}" must hold one table with a Kind column and a \`via\` column; found ${tables.length}`)
    }
    return { viaColumn: tables[0].header.indexOf('`via`'), rows: tables[0].rows }
  }

  /** The `via` cell of the one row whose Kind cell is `label`; throws when there is no such row or more than one. */
  function viaCell(label: string): string {
    const { viaColumn, rows } = kindsTable()
    const matches = rows.filter((row) => row[0] === label)
    if (matches.length !== 1) throw new Error(`README.md "${RECEIVING_HEADING}": ${matches.length} rows of kind "${label}", expected 1`)
    return matches[0][viaColumn] ?? ''
  }

  test.each(VIA_VALUES.map((via) => [via, VIA_ROWS[via]] as const))(
    'the table row for `%s` (%s) shows exactly that via value as a code span',
    (via, label) => {
      expect(codeSpans(viaCell(label))).toEqual([via])
    },
  )

  test.each(INJECTED_ROWS)('the injected kind %s has a table row showing no via value', (label) => {
    expect(codeSpans(viaCell(label))).toEqual([])
  })

  test.each([
    ['the scheduled prompt', /\bscheduled\s+prompt\b/i],
    ['the `/interject` message', /`\/interject`\s+message\b/i],
    ['that injected messages carry no `via`', /\bno\s+`via`/i],
  ])('names %s', (_label, pattern) => {
    expect(flat(section())).toMatch(pattern)
  })

  test('no "Messages a bot receives" heading remains', () => {
    expect(headings(readme).filter((h) => /messages a bot receives/i.test(h.title)).map((h) => h.text)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// AC 74 (shipped-docs leg): no reload wording in the MCP instructions (b.av2 SR-8.8)
// ---------------------------------------------------------------------------

// `RELOAD_TERMS` (tests/test-helpers/reload-terms.ts) is the list the CLI and
// MCP tool-list cases use too. The README and the skills may describe the
// gesture and are not checked.
describe('AC 74: the MCP instructions carry no reload wording (SR-8.8)', () => {
  test.each(RELOAD_TERMS.map((term) => [String(term), term] as const))('%s is absent', (_label, term) => {
    const text = mcpInstructionsText()
    expect(typeof term === 'string' ? text.includes(term) : term.test(text)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC 47 (shipped-docs leg): clear-latch is not offered to a bot (b.jg5 SRJ-511)
// ---------------------------------------------------------------------------

// `CLEAR_LATCH_TERMS` (tests/test-helpers/clear-latch-terms.ts) is the list the
// tool-list and notice-text cases use too. The command is the operator's: the
// README and the debugging skill describe it, so they are not read here and the
// command is not one of `FORBIDDEN_TERMS`; the manifest, the crontable header
// and the CLI usage text are not read either.
describe('AC 47: the MCP instructions and the Reply Guard reminder do not name clear-latch (SRJ-511)', () => {
  const BOT_FACING_TEXTS: [name: string, read: () => string][] = [
    [MCP_INSTRUCTIONS_NAME, mcpInstructionsText],
    [`${REPLY_GUARD_FILE} (reminder text)`, replyGuardReminderText],
  ]

  test.each(BOT_FACING_TEXTS.flatMap(([name, read]) => CLEAR_LATCH_TERMS.map((term) => [name, term, read] as const)))(
    '%s: %s is absent',
    (_name, term, read) => {
      expect(clearLatchTermsIn(read()).filter((found) => found === term)).toEqual([])
    },
  )
})

// ---------------------------------------------------------------------------
// The agent-director refusal classes point to the switch-over runbook (b.jg5 SRJ-208)
// ---------------------------------------------------------------------------

/** The two startup refusal classes for an agent-director binary that is too old. */
const REFUSAL_LABELS: string[] = [AD_BELOW_PHASE1_FLOOR, AD_SYSTEM_INSTALL_TOO_OLD]

const STARTUP_ERRORS_HEADING = '## Startup errors'

/** The debugging skill's section holding the refusal entries, which its triage points to. */
const REFUSAL_SECTION_TITLE = 'The server refuses the agent-director binary at start'

/**
 * The list item in `section` that opens with the label as a code span
 * (`- \`label\` — …`), with any indented continuation lines, whitespace
 * collapsed. Throws naming the label unless exactly one item opens with it.
 */
function labelItem(section: string, label: string, where: string): string {
  const lines = section.split('\n')
  const starts = lines.flatMap((line, i) => (line.startsWith(`- \`${label}\``) ? [i] : []))
  if (starts.length !== 1) throw new Error(`${where}: ${starts.length} list items open with \`${label}\`, expected 1`)
  const item = [lines[starts[0]]]
  for (const line of lines.slice(starts[0] + 1)) {
    if (!/^\s+\S/.test(line)) break
    item.push(line)
  }
  return flat(item.join('\n'))
}

/** The debugging skill's section for a stop by the runtime re-check (b.jg5 SRJ-205, SRJ-1104), under the refusal section. */
const RUNTIME_STOP_HEADING = '### Found while the server was running'

/** `RUNBOOK_COMMAND_SPANS`' key for the debugging skill's runtime-stop remedy. */
const RUNTIME_STOP_REMEDY = "the debugging skill's runtime-stop remedy"

/**
 * Ruling C-1 (b.jg5 SRJ-1104, SRJ-1108): the backticked agent-director
 * command lines an operator text may carry where `UPGRADE_FORMS` applies,
 * each removed exactly (that span, as written) before the forms are applied;
 * any other backticked agent-director command line there still fails. No
 * pattern is narrowed. The runbook's refusal block and the debugging skill's
 * runtime-stop remedy (under `RUNTIME_STOP_HEADING`, and only there) name the
 * process `agent-director serve` among those stopped around the binary change
 * (SRJ-1104, SRJ-1108; HO C15); step 1's version item runs
 * `agent-director version` (SRJ-1108).
 */
const RUNBOOK_COMMAND_SPANS: Record<'refusal block' | "step 1's version item" | typeof RUNTIME_STOP_REMEDY, string> = {
  'refusal block': code('agent-director serve'),
  "step 1's version item": code('agent-director version'),
  [RUNTIME_STOP_REMEDY]: code('agent-director serve'),
}

/**
 * The debugging skill's refusal section, flattened, with ruling C-1's span
 * removed from its `RUNTIME_STOP_HEADING` subsection only: the text
 * `UPGRADE_FORMS` is applied to. Throws naming a missing section or
 * subsection.
 */
function refusalSectionForUpgradeForms(skill: string): string {
  const section = requiredSection(skill, `## ${REFUSAL_SECTION_TITLE}`, DEBUG_SKILL_FILE)
  const range = sectionRange(section, RUNTIME_STOP_HEADING)
  if (range === undefined) throw new Error(`${DEBUG_SKILL_FILE}, under "## ${REFUSAL_SECTION_TITLE}", has no heading "${RUNTIME_STOP_HEADING}"`)
  const lines = section.split('\n')
  const remedy = withoutAllowedSpan(flat(lines.slice(range.start, range.end).join('\n')), RUNTIME_STOP_REMEDY)
  return flat([...lines.slice(0, range.start), remedy, ...lines.slice(range.end)].join('\n'))
}

/** The label of `UPGRADE_FORMS`' re-install row (E36 T2 ruling; SRJ-1101); throws when the helper has no such row. */
const REINSTALL_FORM: string = (() => {
  const row = UPGRADE_FORMS.find(([label]) => /\bre-install\b/i.test(label))
  if (row === undefined) throw new Error('UPGRADE_FORMS has no re-install row')
  return row[0]
})()

describe('the agent-director refusal classes name the switch-over runbook (b.jg5 SRJ-208)', () => {
  const debugSkill = operatorText(DEBUG_SKILL_FILE)
  const readme = operatorText('README.md')
  const runbookAnchor = headingSlug(PHASE1_RUNBOOK_SECTION_TITLE)
  const debugEntry = (label: string) => flat(requiredSection(debugSkill, classHeading(label), DEBUG_SKILL_FILE))
  const readmeItem = (label: string) =>
    labelItem(requiredSection(readme, STARTUP_ERRORS_HEADING, 'README.md'), label, `README.md "${STARTUP_ERRORS_HEADING}"`)

  describe(DEBUG_SKILL_FILE, () => {
    test.each(REFUSAL_LABELS)('has a `###` entry headed by `%s`', (label) => {
      expect(headings(debugSkill).filter((h) => classHeading(label).test(h.text))).toHaveLength(1)
    })

    test.each(REFUSAL_LABELS)('the `%s` entry sits under the refusal section', (label) => {
      const parent = sectionRange(debugSkill, `## ${REFUSAL_SECTION_TITLE}`)
      const entry = sectionRange(debugSkill, classHeading(label))
      expect(parent).toBeDefined()
      expect(entry).toBeDefined()
      expect(entry!.start).toBeGreaterThan(parent!.start)
      expect(entry!.end).toBeLessThanOrEqual(parent!.end)
    })

    test.each(REFUSAL_LABELS)('the `%s` entry names the runbook section by its title', (label) => {
      expect(debugEntry(label)).toContain(PHASE1_RUNBOOK_SECTION_TITLE)
    })

    test.each(UPGRADE_FORMS.map(([form, pattern]) => [form, pattern] as const))(
      `the refusal section carries no %s, once the runtime-stop remedy's ${RUNBOOK_COMMAND_SPANS[RUNTIME_STOP_REMEDY]} span is removed (ruling C-1; SRJ-1104)`,
      (_form, pattern) => {
        expect(refusalSectionForUpgradeForms(debugSkill)).not.toMatch(pattern)
      },
    )

    describe(`self-checks (ruling C-1): the ${RUNBOOK_COMMAND_SPANS[RUNTIME_STOP_REMEDY]} span is removed only inside "${RUNTIME_STOP_HEADING}"`, () => {
      /** A synthetic debugging skill: the refusal section, a class entry, then the runtime-stop subsection. */
      const skill = (entry: string, remedy: string) =>
        [`## ${REFUSAL_SECTION_TITLE}`, 'Intro.', `### \`${AD_BELOW_PHASE1_FLOOR}\``, entry, RUNTIME_STOP_HEADING, remedy, '## Later', 'Out.'].join('\n')
      const SPAN = RUNBOOK_COMMAND_SPANS[RUNTIME_STOP_REMEDY]
      test.each([
        ['the span in the remedy only', skill('Fix: follow the block.', `Stop every process (${SPAN} included).`), []],
        ['the span in the class entry', skill(`Fix: restart ${SPAN}.`, 'Stop everything.'), ['backticked agent-director command line']],
        ['another backticked agent-director command in the remedy', skill('Fix: follow the block.', `Stop every process (${SPAN} included), then run \`agent-director upgrade\`.`), ['backticked agent-director command line', 'upgrade wording']],
        ['the span with arguments in the remedy', skill('Fix: follow the block.', `Restart ${code('agent-director serve --port 1')}.`), ['backticked agent-director command line']],
      ] as const)('%s', (_label, text, forms) => {
        expect(upgradeFormsIn(refusalSectionForUpgradeForms(text)).sort()).toEqual([...forms].sort())
      })

      test(`a skill with no "${RUNTIME_STOP_HEADING}" heading throws naming it`, () => {
        expect(() => refusalSectionForUpgradeForms(`## ${REFUSAL_SECTION_TITLE}\nIntro.\n`)).toThrow(RUNTIME_STOP_HEADING)
      })
    })

    test('the triage points to the refusal section by an anchor that resolves', () => {
      const anchor = headingSlug(REFUSAL_SECTION_TITLE)
      expect(markdownLinks(debugSkill).filter((link) => link.path === '').map((link) => link.anchor)).toContain(anchor)
      expect(headingAnchors(debugSkill)).toContain(anchor)
    })
  })

  describe(`README.md "${STARTUP_ERRORS_HEADING}"`, () => {
    test.each(REFUSAL_LABELS)('the `%s` line names the runbook section by its title', (label) => {
      expect(readmeItem(label)).toContain(PHASE1_RUNBOOK_SECTION_TITLE)
    })

    test.each(REFUSAL_LABELS.flatMap((label) => UPGRADE_FORMS.map(([form, pattern]) => [label, form, pattern] as const)))(
      'the `%s` line carries no %s',
      (label, _form, pattern) => {
        expect(readmeItem(label)).not.toMatch(pattern)
      },
    )
  })

  // E2 gate (b.jg5 SRJ-1108): the section the refusals name exists once, under
  // `## Migration`, and every link into it resolves.
  test('exactly one README heading carries the title every refusal names, a `###` under `## Migration`', () => {
    expect(runbookTitleProblems(readme)).toEqual([])
  })

  test(`every link from README.md, ${DEBUG_SKILL_FILE} and ${INSTALL_SKILL_FILE} into the runbook section resolves to a heading in it`, () => {
    const texts: [string, string][] = [['README.md', readme], ...[DEBUG_SKILL_FILE, INSTALL_SKILL_FILE].map((file): [string, string] => [file, operatorText(file)])]
    const { checked, broken } = runbookLinkProblems(readme, texts)
    expect(broken).toEqual([])
    expect(checked).toContain(`README.md -> #${runbookAnchor}`)
  })

  test.each([
    ['renamed', (text: string) => text.replace(`### ${PHASE1_RUNBOOK_SECTION_TITLE}\n`, '### Switching over\n')],
    ['re-levelled', (text: string) => text.replace(`### ${PHASE1_RUNBOOK_SECTION_TITLE}\n`, `#### ${PHASE1_RUNBOOK_SECTION_TITLE}\n`)],
  ])('self-check: with the runbook heading %s, the title case and the link case both fail', (_how, edit) => {
    const edited = edit(readme)
    expect(edited).not.toBe(readme)
    expect(runbookTitleProblems(edited)).not.toEqual([])
    expect(runbookLinkProblems(edited, [['README.md', edited]]).broken).toContain(`README.md -> #${runbookAnchor}`)
  })

  test.each(UPGRADE_FORMS)('self-check: the %s pattern matches its synthetic string', (_form, pattern, sample) => {
    expect(flat(sample)).toMatch(pattern)
  })

  test('self-check: no pattern matches the runbook pointer itself', () => {
    const pointer = flat(`Follow the README section "${PHASE1_RUNBOOK_SECTION_TITLE}" from its block "${REFUSAL_BLOCK_HEADING}"; the new CSCB is started only as step 10 starts it.`)
    expect(UPGRADE_FORMS.filter(([, pattern]) => pattern.test(pointer)).map(([form]) => form)).toEqual([])
  })

  // The re-install row (E36 T2 ruling; SRJ-1101, HO C8): it flags each
  // re-install advice the install and startup texts gave, and neither the
  // remedies that replaced them nor re-installing a Slack app or CSCB.
  test.each([
    'Reinstall agent-director from npm and retry.',
    'Diagnose with the install-cscb skill or re-install agent-director.',
    "Run: reinstall a matching 'agent-director' version.",
    'check or reinstall the `agent-director` npm package',
    'Re-install agent-director as the correct user or remove the mismatched file.',
  ])('self-check: the re-install row flags the old advice "%s"', (text) => {
    expect(upgradeFormsIn(flat(text))).toContain(REINSTALL_FORM)
  })

  test.each([
    ['the client-package remedy', CLIENT_PACKAGE_REMEDY],
    ['the publishing-host pointer', PUBLISHING_HOST_BLOCK_POINTER],
    ['re-installing a Slack app', 'Re-install the app to the workspace, then restart agent-director.'],
    ['reinstalling CSCB', 'reinstall CSCB from the version step 1 recorded'],
  ])('self-check: the re-install row does not flag %s', (_name, text) => {
    expect(upgradeFormsIn(flat(text))).not.toContain(REINSTALL_FORM)
  })

  test('self-check: a README item missing its label fails naming the label', () => {
    expect(() => labelItem('- `other-class` — text', AD_BELOW_PHASE1_FLOOR, 'fixture')).toThrow(`0 list items open with \`${AD_BELOW_PHASE1_FLOOR}\``)
  })

  test('self-check: a README item takes its indented continuation lines and stops at the next item', () => {
    const fixture = `- \`${AD_BELOW_PHASE1_FLOOR}\` — first\n  second\n- \`next\` — third`
    expect(labelItem(fixture, AD_BELOW_PHASE1_FLOOR, 'fixture')).toBe(`- \`${AD_BELOW_PHASE1_FLOOR}\` — first second`)
  })
})

describe('the runtime re-check\'s pointer names a debug skill section that exists (b.jg5 SRJ-1104)', () => {
  test(`${DEBUG_SKILL_PATH} has exactly one heading titled "${DEBUG_SKILL_RUNTIME_STOP_SECTION_TITLE}"`, () => {
    const titles = headings(readRepoFile(DEBUG_SKILL_PATH)).map((h) => h.title)
    expect(titles.filter((title) => title === DEBUG_SKILL_RUNTIME_STOP_SECTION_TITLE)).toHaveLength(1)
  })
})

/** The README section the runbooks sit under. */
const MIGRATION_HEADING = '## Migration'

/** The switch-over section's heading as the README writes it: a `###` under `## Migration`. */
const SWITCH_OVER_HEADING = `### ${PHASE1_RUNBOOK_SECTION_TITLE}`

/** The README section the switch-over runbook replaced (b.jg5 SRJ-1103): no heading carries it and no link reaches it. */
const GONE_TITLE = 'First start on a host with running bots'

/**
 * What is wrong with the README heading the refusals name (E2 gate, b.jg5
 * SRJ-1108): exactly one heading carries `PHASE1_RUNBOOK_SECTION_TITLE`, at
 * `###`, inside `## Migration`. Pure; `[]` when all holds.
 */
function runbookTitleProblems(readme: string): string[] {
  const titled = headings(readme).filter((h) => h.title === PHASE1_RUNBOOK_SECTION_TITLE)
  if (titled.length !== 1) return [`${titled.length} README headings are titled "${PHASE1_RUNBOOK_SECTION_TITLE}", expected 1`]
  const [heading] = titled
  const problems: string[] = []
  if (heading.text !== SWITCH_OVER_HEADING) problems.push(`"${heading.text}" is not "${SWITCH_OVER_HEADING}"`)
  const migration = sectionRange(readme, MIGRATION_HEADING)
  if (migration === undefined || heading.line <= migration.start || heading.line >= migration.end) {
    problems.push(`"${heading.text}" is not under "${MIGRATION_HEADING}"`)
  }
  return problems
}

/**
 * Every link from `texts` into the switch-over section, as `<file> -> #<anchor>`
 * (`checked`), and those that resolve to no heading inside the README section
 * (`broken`). A README link counts by its same-file anchor, a skill's by a
 * path ending in `README.md`. A link is into the section when its anchor is
 * the section's or a block's slug, the anchor of a heading inside the
 * section, or a `step-<n>-…` anchor that resolves nowhere in the README (a
 * step anchor that resolves outside the section, such as the rollback's, is
 * not counted). Pure.
 */
function runbookLinkProblems(readme: string, texts: readonly [file: string, text: string][]): { checked: string[]; broken: string[] } {
  const range = sectionRange(readme, SWITCH_OVER_HEADING)
  const all = headings(readme)
  const anchors = headingAnchors(readme)
  const inside = range === undefined ? [] : anchors.filter((_, i) => all[i].line >= range.start && all[i].line < range.end)
  const named = [PHASE1_RUNBOOK_SECTION_TITLE, REFUSAL_BLOCK_HEADING, PUBLISHING_HOST_BLOCK_HEADING].map(headingSlug)
  const into = (anchor: string) =>
    named.includes(anchor) || inside.includes(anchor) || (/^step-\d+-/.test(anchor) && !anchors.includes(anchor))
  const links = texts.flatMap(([file, text]) =>
    markdownLinks(text)
      .filter((link) => (file === 'README.md' ? link.path === '' : /(?:^|\/)README\.md$/.test(link.path)) && into(link.anchor))
      .map((link) => ({ name: `${file} -> #${link.anchor}`, resolves: inside.includes(link.anchor) })),
  )
  return { checked: links.map((l) => l.name), broken: links.filter((l) => !l.resolves).map((l) => l.name) }
}

// ---------------------------------------------------------------------------
// The switch-over runbook (b.jg5 SRJ-1108; the E2-gate and E5 hatch notes)
// ---------------------------------------------------------------------------

/** `value` with every RegExp metacharacter escaped, so a pattern built around it matches it literally. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A short phrase, matched literally and case-insensitively in flattened text. */
function ci(phrase: string): RegExp {
  return new RegExp(escapeRegExp(phrase), 'i')
}

/** `text` as a Markdown code span. */
function code(text: string): string {
  return `\`${text}\``
}

/** The memoised answer of `build`, built at its first call (when a case runs, never at collection). */
function lazy<T>(build: () => T): () => T {
  let built: { value: T } | undefined
  return () => (built ??= { value: build() }).value
}

/** agent-director's home install path, which the client looks at first (SRJ-1301): the `homeBinary` and `findMissingCron` rows' common part. */
const AD_HOME_BINARY = '$HOME/.agent-director/bin/agent-director'

/**
 * agent-director vocabulary the operator texts name and CSCB defines nowhere,
 * each row citing its source (HO: agent-director's handoff notes; ADSRD: its
 * SRD). Everything CSCB defines (versions, settings keys, defaults, minimums,
 * the margin, the verbs, the store path, titles, labels) is imported instead.
 * `ceiling <name>` rows are ADSRD SR-13.2's ceiling formulas as the runbook
 * lists them (b.jg5 SRJ-213), one per ceiling CSCB calls.
 */
const AD_VOCABULARY: Record<string, { text: string; source: string }> = {
  homeBinary: { text: AD_HOME_BINARY, source: "agent-director's client discovery: its home install, found before the first `agent-director` on PATH (b.jg5 SRJ-1301; SRJ-1104, SRJ-1108)" },
  findMissingCron: { text: `* * * * * ${AD_HOME_BINARY} find-missing`, source: "HO C19; b.jg5 SRJ-1101: the README Migration section's cron line, with no flags, run as the workers' user on their tmux socket (C7)" },
  stoppingSetItem: { text: '"Stopping a set of agents before a binary change"', source: 'HO rev 27: the "Operator actions" item a human follows to stop a set of agents, CSCB\'s bots included; SRJ-1104, SRJ-1108' },
  tmuxMinimum: { text: '3.2', source: 'HO rev 17: tmux 3.2 or later; b.jg5 SRJ-1108 step 1, SRJ-1103' },
  remainOnExit: { text: code('remain-on-exit'), source: 'HO rev 17: kept off; SRJ-1108 step 1' },
  baseIndex: { text: 'base-index', source: 'HO rev 17: agent-director depends on it not at all; SRJ-1108 step 1 names it not' },
  paneBaseIndex: { text: 'pane-base-index', source: 'HO rev 17; SRJ-1108 step 1 names it not' },
  hookIgnored: { text: code('ad.hook.ignored'), source: 'HO rev 24, rev 31: the event of a hook on a Claude Code too old for exec-form hooks' },
  noExecForm: { text: code('no_exec_form'), source: "HO rev 24, rev 31: that event's reason" },
  sessionStartCapSeconds: { text: '540', source: "HO rev 25; A-33: the cap on agent-director's SessionStart wait, in seconds" },
  waitMinutes: { text: '5', source: 'SRJ-1108 steps 4 and 6, SRJ-1109 step 4: the waits for a row to read `ended` or `missing`, in minutes' },
  operatorActions: { text: '"Operator actions"', source: "HO rev 27; A-2, A-26: the section of agent-director's README a human follows; SRJ-1109 steps 3 to 5" },
  notThisLaunch: { text: "not this launch's session", source: "HO §2; SRJ-1109 steps 4 and 5: a `kill`'s CONFLICT on a leftover of an earlier launch" },
  downgradeRecipe: { text: 'emergency downgrade recipe', source: "HO C15; ADA question 8; SRJ-1109 step 6: the only way the previous agent-director is restored" },
  downgradeSchemaVersion: { text: '4', source: 'HO C15; ADA question 8; SRJ-1109 step 6: the schema version the recipe stamps' },
  sqliteBackup: { text: code('.backup'), source: "HO C15; SRJ-1108 step 8: sqlite3's online-consistent copy of the WAL-mode store" },
  migrationColumns: { text: 'thirteen', source: "HO rev 15: the columns Phase 1's schema migration adds (and the downgrade recipe drops, SRJ-1109 step 6)" },
  storeMeta: { text: code('store_meta'), source: "HO rev 15, rev 19: the one-row table holding the store's id" },
  configMalformed: { text: code('ErrConfigMalformed'), source: "HO §1; ADSRD SR-4.1: agent-director's answer to a malformed settings file" },
  ownerLabel: { text: code('@ad_owner'), source: "HO rev 15; b.jg5 SRJ-612: the session label by which agent-director proves a session is a row's" },
  paneLabel: { text: code('@ad_pane'), source: 'HO rev 17; b.jg5 SRJ-612, SRJ-613: the per-pane label' },
  unknownErrorName: { text: code('ErrUnknownErrorName'), source: "agent-director's client: the error a name outside its catalog arrives as; the E4 hatch note (`ad-shim-catalog-incomplete`)" },
  expireAll: { text: code('--older-than 0d'), source: 'HO C6; SRJ-1108 step 11: never used' },
  'ceiling kill': { text: 'the larger of 2Q + 2A + E + 4W and 3Q + 2A + 5W', source: 'ADSRD SR-13.2; SRJ-213' },
  'ceiling read-pane': { text: '3Q + A + 4W', source: 'ADSRD SR-13.2; SRJ-213' },
  'ceiling send-keys': { text: '3Q + 2A + 5W', source: 'ADSRD SR-13.2; SRJ-213' },
  'ceiling pause': { text: `3Q + 2A + 5W, plus ${code(`[${AD_PAUSE_TABLE}] ${AD_PAUSE_TIMEOUT_KEY}`)} (times 1000)`, source: 'ADSRD SR-13.2; SRJ-213: with its configured wait' },
  [`ceiling ${AD_LAUNCH_CEILING_VERBS.join('/')}`]: { text: 'the larger of Q + C + 2A + 4W and 2Q + C + 3W', source: 'ADSRD SR-13.2; SRJ-213: the launch row' },
  'ceiling find-missing': { text: 'B + Q + W', source: 'ADSRD SR-13.2; SRJ-213: the sweep row' },
}

/** One vocabulary row's text; throws naming a key the table lacks. */
function vocab(key: string): string {
  const row = AD_VOCABULARY[key]
  if (row === undefined) throw new Error(`AD_VOCABULARY has no row "${key}"`)
  return row.text
}

/** Each ceiling CSCB calls, as the runbook names it: the launch row's three verbs as one name (AD_LAUNCH_CEILING_VERBS). */
const CSCB_CEILINGS: readonly string[] = [
  ...new Set(
    AD_CEILING_VERBS.filter((v) => v.cscbCalls).map((v) => (AD_LAUNCH_CEILING_VERBS.includes(v.verb) ? AD_LAUNCH_CEILING_VERBS.join('/') : v.verb)),
  ),
]

/** The verbs of the ceiling table CSCB never calls (`expire`). */
const UNCALLED_VERBS: readonly string[] = AD_CEILING_VERBS.filter((v) => !v.cscbCalls).map((v) => v.verb)

/** The three windows step 1 confirms (b.jg5 SRJ-209). */
const AD_WINDOWS: readonly AdTmuxKey[] = ['pending_grace_seconds', 'stopping_window_seconds', 'starting_session_seconds']

/** The switch-over runbook's step count (SRJ-1108: steps 1 to 11). */
const SWITCH_OVER_STEP_COUNT = 11

/** A runbook as one carrier holds it: its section body, its frame, its steps and its blocks' heading level. */
interface RunbookCarrier {
  /** The carrier's name in failures: the file and the section heading. */
  name: string
  /** The section's body, heading line excluded. */
  section: string
  /** The section's text before its first subsection, flattened. */
  frame: string
  /** Step n's text at index n - 1, flattened. */
  steps: string[]
  /** The anchor of step n's heading at index n - 1. */
  stepAnchors: string[]
  /** The level of the section's blocks and steps, one below its heading. */
  blockLevel: number
}

/**
 * A runbook carrier read from `text` under `heading` (a section whose steps
 * sit one level below it), through the shared step reader (`runbookSteps`,
 * `tests/test-helpers/runbooks.ts`) at that level with `count` steps, each
 * step's text flattened with `flat`. Every carrier (the README's switch-over
 * and rollback sections and their CHANGELOG copies) is read here. Throws as
 * the reader does, naming the carrier and the step.
 */
function readRunbookCarrier(file: string, text: string, heading: string, count: number): RunbookCarrier {
  const name = `${file} "${heading}"`
  const section = requiredSection(text, heading, file)
  const blockLevel = heading.indexOf(' ') + 1
  const lines = section.split('\n')
  const first = headings(section)[0]
  const steps = runbookSteps(section, { count, level: blockLevel, name })
  return {
    name,
    section,
    frame: flat(lines.slice(0, first === undefined ? lines.length : first.line).join('\n')).trim(),
    steps: steps.map((step) => flat(step.text).trim()),
    stepAnchors: steps.map((step) => headingSlug(step.title)),
    blockLevel,
  }
}

/**
 * Every carrier of the switch-over runbook: its name and its reader. The
 * README section, and the CHANGELOG release entry's copy (b.jg5 SRJ-1107;
 * hatch A3), read through `OPERATOR_TEXTS` from the entry only.
 */
const SWITCH_OVER_CARRIERS: [name: string, read: () => RunbookCarrier][] = [
  ['README.md', lazy(() => readRunbookCarrier('README.md', operatorText('README.md'), SWITCH_OVER_HEADING, SWITCH_OVER_STEP_COUNT))],
  [CHANGELOG_FILE, lazy(() => readRunbookCarrier(CHANGELOG_FILE, releaseEntry(operatorText(CHANGELOG_FILE)), SWITCH_OVER_HEADING, SWITCH_OVER_STEP_COUNT))],
]

/** The numbered items with a bold lead (`1. **Lead.** …`) in a step's flattened text, each running to the next. */
function stepItems(stepText: string): { lead: string; text: string }[] {
  const starts = [...stepText.matchAll(/(?:^|\s)\d+\. \*\*([^*]+)\*\*/g)]
  return starts.map((m, k) => ({ lead: m[1], text: stepText.slice(m.index!, starts[k + 1]?.index ?? stepText.length).trim() }))
}

/**
 * The text an element row names: `frame`, `step <n>`, or `step <n> › <lead>`
 * for the one item of step n whose bold lead starts with `<lead>`
 * (case-insensitive). Throws naming the carrier, the step and the lead.
 */
function textAt(carrier: RunbookCarrier, where: string): string {
  if (where === 'frame') return carrier.frame
  const m = /^step (\d+)(?: › (.+))?$/.exec(where)
  if (m === null) throw new Error(`no such place in a runbook: ${where}`)
  const step = carrier.steps[Number(m[1]) - 1]
  if (step === undefined) throw new Error(`${carrier.name}: no step ${m[1]}`)
  if (m[2] === undefined) return step
  const lead = m[2].toLowerCase()
  const items = stepItems(step).filter((item) => item.lead.toLowerCase().startsWith(lead))
  if (items.length !== 1) throw new Error(`${carrier.name}, step ${m[1]}: ${items.length} items lead with "${m[2]}", expected 1`)
  return items[0].text
}

/** A required item: a code span, imported value or literal (as written), a case-insensitive phrase pattern, or a value read from the carrier. */
type Item = string | RegExp | ((carrier: RunbookCarrier) => string)

/** Each of `required` that `text` lacks, as text for the failure. */
function missingItems(carrier: RunbookCarrier, text: string, required: readonly Item[]): string[] {
  return required
    .map((item) => (typeof item === 'function' ? item(carrier) : item))
    .filter((item) => (typeof item === 'string' ? !text.includes(item) : !item.test(text)))
    .map(String)
}

/** A link to step n's heading in the carrier, as Markdown writes its target. */
const stepLink = (n: number) => (carrier: RunbookCarrier) => `(#${carrier.stepAnchors[n - 1]})`

/** The README section that keeps the conversion steps the switch-over's steps 1 and 7 point to (b.jg5 SRJ-1103). */
const UPGRADING_TITLE = 'Upgrading to personas'

/**
 * A link to the README heading titled `title` as the carrier writes it: a
 * same-file anchor in the README, `README.md#…` in the CHANGELOG copy (b.jg5
 * SRJ-1107; the E35 T1 PM note).
 */
const readmeLink = (title: string) => (carrier: RunbookCarrier) => `(${carrier.name.startsWith(`${CHANGELOG_FILE} `) ? 'README.md' : ''}#${headingSlug(title)})`

/** A link to `UPGRADING_TITLE`'s README heading as the carrier writes it. */
const upgradingLink = readmeLink(UPGRADING_TITLE)

/**
 * SRJ-1101's words for a kill a runbook step tells a human to run: its result
 * checked, and nothing deleted or respawned on an error (switch-over step 6,
 * rollback steps 4 and 5; the README's advice to kill leftover workers).
 */
const KILL_CAVEAT = "check its result; on an error, don't delete or respawn"

/** `(operator action)`, the marker of each operator-only action (Runbook Markdown contract). */
const OPERATOR_ACTION = '(operator action)'

/**
 * One row per SRJ-1108 element: where it sits (`frame`, `step <n>` or
 * `step <n> › <item lead>`), the element, and the items its text must hold.
 * The `operator action` rows mark each operator-only action SRJ-1108 names
 * (C6, C7, C15, the go-ahead of steps 1 and 8 (A-19), the §6 prompt, the
 * host's autostart for CSCB) at its step.
 */
const SWITCH_OVER_ELEMENTS: [where: string, element: string, required: readonly Item[]][] = [
  // The section-level statements.
  ['frame', "the SRJ-1515 sentence: Phase 1 is installed together with this release, which changes no agent-director code, and both roll back together", [
    ci('requires agent-director Phase 1, installed on the host together with it; CSCB changes no agent-director code'),
    `rolled back together, by "${ROLLBACK_RUNBOOK_SECTION_TITLE}"`,
  ]],
  ['frame', `the old CSCB never runs against Phase 1 and the new one never against ${OLD_AD_VERSION}`, [
    ci('the old CSCB never runs against Phase 1'),
    ci(`the new one never against ${OLD_AD_VERSION}`),
  ]],
  ['frame', 'no bot server runs between step 3 and step 10', [ci('no bot server runs between step 3 and step 10')]],
  ['frame', 'no side-by-side install under another path is used', [ci('no side-by-side install under another path')]],
  ['frame', 'every agent and long-running agent-director process is stopped before each binary change and started after it (C15)', [
    ci(`every agent on the host, with every long-running agent-director process (${code('agent-director serve')} included), is stopped before either binary change and started again after it`),
  ]],
  ['frame', "the switch-over log is the operator's own record, and each step says what to record", [
    ci('the switch-over log is your own record'),
    ci('each step says what to record in it'),
  ]],
  ['frame', "commands run as the workers' user in the tmux environment step 1 pins", [
    ci("run every command as the workers' user"),
    ci('in the tmux environment step 1 pins'),
  ]],
  ['frame', 'operator-only actions are marked "operator action"', [ci('steps marked "operator action" are done by a human on the host')]],

  // Step 1, beforehand.
  ['step 1', 'beforehand, with the old CSCB running and still installed as the global package', [
    ci('beforehand, with the old CSCB running and still installed as the global package'),
  ]],
  ['step 1 › The go-ahead', "the operator's go-ahead for the switch-over on this host, the approval, confirmed and recorded in the switch-over log; with none, stop before anything goes down (A-19)", [
    ci('confirm the go-ahead for the switch-over on this host, and record it in the switch-over log'),
    ci('the go-ahead is the approval for the switch-over'),
    ci('if there is no go-ahead, stop here, before anything goes down'),
  ]],
  ['step 1 › The go-ahead', 'operator action: the go-ahead (C15; A-19)', [OPERATOR_ACTION]],
  ['step 1 › The go-ahead', "the go-ahead is the operator's decision and agent-director ships no install-gate file or record; the install gate is the CSCB fixes Phase 1 needs on a host, which this release installed with Phase 1 meets (A-19; bug b.7sd)", [
    ci("the go-ahead is the operator's decision, and agent-director ships no install-gate file or record"),
    ci("agent-director's Phase 1 install gate is the set of CSCB fixes that must be in place on a host before Phase 1 is installed there"),
    ci('this release, installed together with agent-director Phase 1 as this runbook does, meets it'),
  ]],
  ["step 1 › agent-director's version", `\`agent-director version\` in the launcher environment as the workers' user shows ${OLD_AD_VERSION}, the only supported starting point; stop before anything goes down; no command for an earlier version`, [
    code('agent-director version'),
    ci("in the bot server's launcher environment"),
    ci("as the workers' user"),
    ci(`shows ${OLD_AD_VERSION}, the only supported starting point`),
    ci('stop here, before anything goes down'),
    ci(`below ${CLIENT_MIN_VERSION}`),
    ci(`brings agent-director to ${OLD_AD_VERSION}, outside this runbook`),
    ci('names no command for it'),
  ]],
  ['step 1 › The tmux socket', "the tmux socket pinned for the launcher, the host's sweep schedule and the workers, checked from all three, one HOME, recorded", [
    ci("pin the tmux socket for the bot server's launcher, the host's sweep schedule and the workers"),
    code("tmux display-message -p '#{socket_path}'"),
    ci("from the bot server's launcher, the sweep schedule's environment and a worker's"),
    ci('all three print the same path'),
    ci('it is the pinned path'),
    `${code('TMUX_TMPDIR')} that names a missing path falls back silently to ${code('/tmp')}`,
    ci('the three share one HOME'),
    ci('record the result in the switch-over log'),
  ]],
  ['step 1 › The tmux socket', "the host's sweep schedule named generically: whatever runs agent-director find-missing on a schedule, a cron entry, a systemd timer or a loop script (b.3ut)", [
    ci('the sweep schedule is whatever runs `agent-director find-missing` on a schedule on your host: a cron entry, a systemd timer or a loop script'),
  ]],
  ['step 1 › The tmux socket', 'a host with no sweep schedule checks the other two and runs the one step 11 adds in the same environment (b.3ut)', [
    ci('a host with no sweep schedule checks the other two, and runs the one step 11 adds in the same environment'),
  ]],
  ['step 1 › The tmux socket', 'operator action: pinning the tmux socket (C7)', [OPERATOR_ACTION]],
  ['step 1 › tmux', `tmux ${vocab('tmuxMinimum')} or later with remain-on-exit off`, [
    ci(`tmux ${vocab('tmuxMinimum')} or later`),
    `${vocab('remainOnExit')} off`,
  ]],
  ['step 1 › Claude Code', `\`claude --version\` in the launcher environment, ${MIN_CLAUDE_CODE_VERSION} or later (MIN_CLAUDE_CODE_VERSION), the agent-director minimum and the fleet's version; stop before anything goes down`, [
    code('claude --version'),
    ci("in the bot server's launcher environment"),
    ci('the same user and `PATH` the server launches workers with'),
    `${MIN_CLAUDE_CODE_VERSION} or later`,
    ci('the minimum agent-director states for its exec-form hooks'),
    ci('the version the fleet runs'),
    ci(`older than ${MIN_CLAUDE_CODE_VERSION}, stop here, before anything goes down`),
  ]],
  ['step 1 › Claude Code', 'a Claude Code too old for exec-form hooks: ad.hook.ignored with no_exec_form, every launch pending', [
    ci('too old for exec-form hooks'),
    `${vocab('hookIgnored')} with the reason ${vocab('noExecForm')}`,
    ci('every launch stays `pending`'),
  ]],
  ["step 1 › agent-director's timing settings", `all nine [${AD_TMUX_TABLE}] keys of ~/${AD_SETTINGS_RELATIVE_PATH} and [${AD_PAUSE_TABLE}] ${AD_PAUSE_TIMEOUT_KEY} (its default), effective values recorded`, [
    ci('all nine keys of the'),
    code(`[${AD_TMUX_TABLE}]`),
    code(`~/${AD_SETTINGS_RELATIVE_PATH}`),
    ci('a missing file, a missing key or `0` means the default'),
    `${code(`[${AD_PAUSE_TABLE}] ${AD_PAUSE_TIMEOUT_KEY}`)} (${DEFAULT_AD_SETTINGS.pause.timeout_seconds} s when the file or the key is missing)`,
    ci('record the effective values in the switch-over log'),
  ]],
  ['step 1', `the nine [${AD_TMUX_TABLE}] keys are each named`, AD_TMUX_KEYS.map(code)],
  ["step 1 › agent-director's timing settings", 'the three windows are the intended values, each at or above its minimum', [
    ci('the three windows'),
    ...AD_WINDOWS.map(code),
    ci('are the values you intend'),
    ci('at or above its minimum'),
    `${code('starting_session_seconds')} ${AD_SETTING_MINIMUMS.starting_session_seconds}`,
    `${code('stopping_window_seconds')} ${AD_SETTING_MINIMUMS.stopping_window_seconds}`,
    `the larger of ${AD_SETTING_MINIMUMS.pending_grace_seconds.floor} and`,
    `/ 1000⌉ + ${AD_SETTING_MINIMUMS.pending_grace_seconds.addend}`,
  ]],
  ["step 1 › agent-director's timing settings", `a pending_grace_seconds above ${vocab('sessionStartCapSeconds')} s shortens the SessionStart wait to ${vocab('sessionStartCapSeconds')} s`, [
    ci(`${code('pending_grace_seconds')} above ${vocab('sessionStartCapSeconds')} s shortens agent-director's SessionStart wait to ${vocab('sessionStartCapSeconds')} s`),
  ]],
  ['step 1 › The call timeout', `the staged agent_director_call_timeout_ms (${DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS} when left out) exceeds the largest ceiling CSCB calls plus the margin, from the host's values; the need recorded`, [
    ci("always computing from this host's values"),
    code('agent_director_call_timeout_ms'),
    `${code(String(DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS))} when it leaves the setting out`,
    ci('the largest ceiling among the verbs CSCB calls'),
    `plus the ${AD_CALL_TIMEOUT_NEED_MARGIN_MS / 1000n} s margin (${AD_CALL_TIMEOUT_NEED_MARGIN_MS} ms)`,
    ci('record the computed need in the switch-over log'),
  ]],
  ['step 1 › The call timeout', "the ceiling formulas, one per ceiling CSCB calls, pause's with its wait", CSCB_CEILINGS.map(
    (name) => new RegExp(`${escapeRegExp(code(name))}[^:;]*: ${escapeRegExp(vocab(`ceiling ${name}`))}[;.]`),
  )],
  ['step 1 › The call timeout', "the formulas' letters name the host's settings", [
    ci("with Q, A, C, W and E the host's"),
    ...(['query_timeout_ms', 'action_timeout_ms', 'create_timeout_ms', 'pipe_close_wait_ms', 'kill_exit_wait_ms', 'sweep_budget_seconds'] satisfies AdTmuxKey[]).map(code),
  ]],
  ['step 1 › The call timeout', 'the verbs CSCB never calls set no ceiling', UNCALLED_VERBS.map((verb) => ci(`${code(verb)} is not among them`))],
  ['step 1 › Leftover sessions', "tmux ls against agent-director list, as the workers' user on the pinned socket; every slack_bot_ session no row names recorded", [
    ci("as the workers' user, on the pinned socket"),
    `compare ${code('tmux ls')} with ${code('agent-director list')}`,
    ci('record in the switch-over log every `slack_bot_` session that no row names'),
  ]],
  ['step 1 › Stage the new release', "the release staged, not installed: its exact version recorded; the persona configuration in a separate file; the Slack apps; step 3's stop is the old version's own", [
    ci('choose its exact version, record it in the switch-over log'),
    ci('available to install'),
    ci('persona configuration, with `agent_director_call_timeout_ms`, in a separate file, never `config.json`, which the old CSCB reads'),
    ci('prepare the Slack apps'),
    ci(`nothing is installed over the global package yet, so step 3's ${code(CLI_COMMAND_STOP_BOTS)} is the old version's own and reads the old, pre-persona \`config.json\``),
  ]],
  ['step 1 › Copies for rollback', "copies of the pre-persona config.json, the crontable, the /interject callers, access.json and the Slack token environment variables", [
    ci('keep copies of the pre-persona `config.json`, the crontable, the `/interject` callers'),
    ci("the host crontab's `curl` lines included"),
    code('access.json'),
    ci('the Slack token environment variables the old CSCB uses'),
  ]],
  ['step 1 › Copies for rollback', "the old CSCB's exact version recorded in the switch-over log", [ci("record the old CSCB's exact version in the switch-over log")]],
  ['step 1 › The orchestrator prompt', 'the shared orchestrator prompt\'s §6 "ship now" wording may go out any time before', [
    ci('the shared orchestrator prompt\'s "ship now" wording may go out any time before'),
  ]],
  ['step 1 › The orchestrator prompt', 'the shared orchestrator prompt named generically, at its first use: the system prompt the orchestrator bots load, for example the append_system_prompt_file file (b.3ut)', [
    ci(`the shared orchestrator prompt is the system prompt your orchestrator bots load, for example the file ${code('append_system_prompt_file' satisfies (typeof SERVER_PATH_SETTINGS)[number])} names`),
  ]],
  ['step 1 › The orchestrator prompt', 'operator action: the §6 "ship now" wording', [OPERATOR_ACTION]],
  ['step 1', `the conversion steps kept in "${UPGRADING_TITLE}" are linked (SRJ-1103; the E35 T1 PM note)`, [upgradingLink]],

  // Steps 2 to 11.
  ['step 2', "the host's autostart for CSCB disabled until step 10", [ci("disable the host's autostart for CSCB until step 10")]],
  ['step 2', "operator action: disabling the host's autostart for CSCB", [ci(`autostart for CSCB until step 10 ${OPERATOR_ACTION}`)]],
  ['step 3', `the old CSCB's own ${CLI_COMMAND_STOP_BOTS}, reading the old, pre-persona config.json`, [
    `claude-slack-channel-bots ${CLI_COMMAND_STOP_BOTS}`,
    ci(`the old version's own ${code(CLI_COMMAND_STOP_BOTS)}, which reads the old, pre-persona \`config.json\``),
    ci('nothing new is installed before step 7'),
  ]],
  ['step 3', 'an operator arriving from a startup refusal has first reinstalled the previous CSCB', [
    ci('an operator arriving from a startup refusal has first reinstalled the previous CSCB'),
    `(#${headingSlug(REFUSAL_BLOCK_HEADING)})`,
  ]],
  ['step 4', `agent-director find-missing, then at most ${vocab('waitMinutes')} minutes for every service=cscb row to read ended or missing`, [
    code('agent-director find-missing'),
    ci(`wait at most ${vocab('waitMinutes')} minutes for every \`service=cscb\` row to read \`ended\` or \`missing\``),
  ]],
  ['step 5', "a read-only tmux ls as the workers' user on the pinned socket, for old sessions and live old rows (C17)", [
    ci("as the workers' user, on the socket pinned in step 1, run a read-only `tmux ls`"),
    code('slack_bot_<name>_<channel>'),
    code('slack_bot_<channel ID>'),
    ci('any live old row'),
  ]],
  ['step 5', 'a leftover with a row is ended in step 6, before the Phase 1 install', [/a leftover with a row\W+\(live or finished\) is ended in step 6, before the Phase 1 install/i]],
  ['step 5', "a leftover with no row whose name cannot equal a persona's slack_bot_<key> is recorded and the switch-over goes on", [
    /a leftover with no row, whose name cannot equal any new persona's `slack_bot_<key>`/i,
    ci('record it in the switch-over log and go on'),
    ci('agent-director matches session names exactly'),
    ci('you may end it later with the exact-name `tmux kill-session -t =<name>`'),
  ]],
  ['step 5', "a leftover with no row whose name equals a persona's slack_bot_<key>: windows noted, ended by exact name, the gone check", [
    /a leftover with no row, whose name equals a new persona's `slack_bot_<key>`/i,
    ci('note its window ids with a read-only `tmux list-windows -t =<name>`'),
    ci('end it with the exact-name `tmux kill-session -t =<name>`'),
    ci('make the gone check'),
  ]],
  ['step 5', 'the gone check: tmux ls without the session and tmux list-windows -a without its windows', [
    /the gone check\W+as the workers' user on the pinned socket/i,
    ci('a read-only `tmux ls` no longer shows the session'),
    ci('a read-only `tmux list-windows -a` shows none of its windows in any other session'),
    ci('a grouped session or a linked window keeps the worker running'),
  ]],
  ['step 6', `only for a leftover with a row, ended with the still-installed ${OLD_AD_VERSION} binary, with the reason (no flag named)`, [
    ci('only if step 5 found a leftover with a row'),
    ci(`with the still-installed ${OLD_AD_VERSION} binary`),
    ci('no launch token or recorded socket'),
    ci("Phase 1's `kill` fails closed on it"),
    ci("not even agent-director's option for a finished row ends its session"),
  ]],
  ['step 6', 'kill by instance id, the gone check, the exact-name kill if anything remains, find-missing until ended or missing', [
    ci("note the session's window ids"),
    code('agent-director kill --claude-instance-id <id>'),
    ci('then make the gone check'),
    ci('if the session or one of its windows remains, end the session with the exact-name `tmux kill-session -t =<name>`, and make the gone check again'),
    ci(`\`agent-director find-missing\` until the row reads \`ended\` or \`missing\`, for at most ${vocab('waitMinutes')} minutes`),
  ]],
  ['step 6', "the kill's result is checked, and on an error nothing is deleted or respawned (SRJ-1101)", [
    ci(`${code('agent-director kill --claude-instance-id <id>')} and ${KILL_CAVEAT}`),
  ]],
  ['step 6', 'a leftover that cannot be ended means no Phase 1 install: step 8\'s "no go", investigated by session name', [
    ci('a leftover that cannot be ended this way means no Phase 1 install'),
    ci('step 8\'s "no go" branch'),
    code('agent-director list --tmux-session-name <name>'),
  ]],
  ['step 7', 'the staged package installed over the global install without starting it; autostart still disabled', [
    ci('install the staged package over the global install, without starting it'),
    ci('the autostart stays disabled from step 2'),
  ]],
  ['step 7', 'the persona configuration in place, credentials files written, crontable targets and /interject callers rewritten', [
    ci('put the persona configuration in place as `config.json`'),
    ci("write each persona's credentials file with the new CLI"),
    ci('rewrite crontable targets and `/interject` callers to name personas'),
  ]],
  ['step 7', `the new install check passes on the still-installed ${OLD_AD_VERSION} with its note`, [
    ci('install check'),
    ci(`passes on the still-installed ${OLD_AD_VERSION}, with its note`),
  ]],
  ['step 7', 'from this step the new CSCB is deployed but not started', [ci('from this step the new CSCB is deployed but not started')]],
  ['step 7', `the conversion steps kept in "${UPGRADING_TITLE}" are linked (SRJ-1103; the E35 T1 PM note)`, [upgradingLink]],
  ['step 8 › The go-ahead', "the go-ahead for this host confirmed as still standing, and recorded in the switch-over log (A-19)", [
    ci('confirm that the go-ahead for this host still stands, and record it in the switch-over log'),
  ]],
  ['step 8 › The go-ahead', 'operator action: confirming the go-ahead (A-19)', [OPERATOR_ACTION]],
  ['step 8', `"no go": no Phase 1 install; the previous CSCB back with step 1's files, started on ${OLD_AD_VERSION}, autostart re-enabled, the stopped agents started again; the runbook stops`, [
    ci('if there is no go-ahead, there is no Phase 1 install'),
    ci('with the `config.json`, crontable, `/interject` callers, `access.json` and Slack token environment variables saved in step 1'),
    ci(`start it on ${OLD_AD_VERSION} and re-enable its autostart`),
    ci(`every other agent this step already stopped is started again on ${OLD_AD_VERSION} by its owner`),
    ci('the runbook stops there'),
  ]],
  ['step 8', '"no go" reinstalls the previous CSCB at the version step 1 recorded', [ci('reinstall the previous CSCB, the version step 1 recorded')]],
  ['step 8', 'operator action: the agents "no go" stopped are started again by their owners (C15)', [ci(`started again on ${OLD_AD_VERSION} by its owner ${OPERATOR_ACTION}`)]],
  ['step 8', `operator action: "no go" starting the previous CSCB on ${OLD_AD_VERSION} and re-enabling its autostart`, [ci(`start it on ${OLD_AD_VERSION} and re-enable its autostart ${OPERATOR_ACTION}`)]],
  ['step 8', 'every other agent stopped before the install, checked with agent-director list and tmux ls and recorded; one that cannot be stopped means "no go"', [
    ci('before the install, stop every other agent on the host'),
    ci("orchestrators' workers, hand-started sessions and sessions with an `agent-director serve`"),
    ci("confirm with `agent-director list` that each stopped agent's row reads `ended` or `missing`"),
    ci(`a row that ${OLD_AD_VERSION} left stuck live for a dead agent is expected`),
    ci('a read-only `tmux ls` that no agent session is left'),
    ci('record it in the switch-over log'),
    ci('an agent that cannot be stopped means "no go"'),
  ]],
  ['step 8 › Stop every other agent', 'operator action: stopping every other agent before the install (C15)', [OPERATOR_ACTION]],
  ['step 8', `the store backed up with sqlite3's ${vocab('sqliteBackup')}, for disaster recovery only, not the rollback path`, [
    code(DEFAULT_STORE_PATH),
    ci('online-consistent copy'),
    ci(`sqlite3's ${vocab('sqliteBackup')}`),
    ci('not a plain file copy, because the store runs in WAL mode'),
    ci('for disaster recovery only'),
    ci('not the rollback path'),
  ]],
  ['step 8', `agent-director Phase 1 installed: ${vocab('migrationColumns')} columns and ${vocab('storeMeta')}; agent-director version shows the Phase 1 version`, [
    ci(`schema migration adds ${vocab('migrationColumns')} columns and the one-row ${vocab('storeMeta')} table, which holds the store's id`),
    ci('confirm that `agent-director version` shows the Phase 1 version'),
  ]],
  ['step 8', `non-default [${AD_TMUX_TABLE}] values written right after the install, before the restarts and the new CSCB's start`, [
    ci('right after the install, before the restarts that follow and so before the new CSCB starts'),
    ci(`write any non-default ${code(`[${AD_TMUX_TABLE}]`)} values you want into ${code(`~/${AD_SETTINGS_RELATIVE_PATH}`)}`),
    ci('a long-running agent-director process reads the file only when it starts'),
  ]],
  ['step 8', 'every agent-director serve and other long-running process restarted, none older than the install, recorded', [
    ci('restart every `agent-director serve` process and every other long-running agent-director process still running'),
    ci('compare process start times to confirm that none is older than the install'),
    ci('record the version and that result in the switch-over log'),
  ]],
  ['step 8 › Restart `serve`', 'operator action: restarting serve and the other long-running processes (C15)', [OPERATOR_ACTION]],
  ['step 8', `the settings read and confirmed again, the call timeout raised if the need grew, agent-director list without ${vocab('configMalformed')}`, [
    ci(`read the nine timing settings and ${code(`[${AD_PAUSE_TABLE}] ${AD_PAUSE_TIMEOUT_KEY}`)} again as in step 1`),
    ci('record the effective values'),
    ci('confirm them and the call timeout as in step 1'),
    ci('raise `agent_director_call_timeout_ms` in `config.json` before step 10'),
    ci(`confirm that \`agent-director list\` answers without ${vocab('configMalformed')}`),
  ]],
  ['step 9', 'every other agent started again by its owner, its serve processes on the Phase 1 binary', [
    ci('every other agent on the host is started again by its owner'),
    ci('which also starts its `serve` processes on the Phase 1 binary'),
  ]],
  ['step 9', 'operator action: the other agents started again by their owners (C15)', [ci(`started again by its owner ${OPERATOR_ACTION}`)]],
  ['step 10 › The orchestrator prompt', 'the shared orchestrator prompt, and its source copy if one is kept, change worker cleanup to "kill, then leave the row" before the new CSCB starts', [
    ci('change worker cleanup in the shared orchestrator prompt, and in its source copy if you keep one, from row-delete cleanup to "kill, then leave the row"'),
    ci('before the new CSCB starts'),
    ci('in the same deploy as agent-director Phase 1'),
    ci(`kill-then-leave works on ${OLD_AD_VERSION} too, so a rollback does not revert it`),
  ]],
  ['step 10 › The orchestrator prompt', "operator action: the orchestrator prompt's worker cleanup", [OPERATOR_ACTION]],
  ['step 10 › Start the new CSCB', "the new CSCB started, then the host's autostart for CSCB re-enabled", [
    'claude-slack-channel-bots start',
    ci("then re-enable the host's autostart for CSCB"),
  ]],
  ['step 10 › Start the new CSCB', "operator action: re-enabling the host's autostart for CSCB", [ci(`autostart for CSCB ${OPERATOR_ACTION}`)]],
  ['step 10', 'each persona starts fresh once; pre-persona rows are kept and never resumed', [
    ci('each persona starts fresh once'),
    ci('pre-persona rows are kept and never resumed'),
  ]],
  ['step 10 › The post-install check', 'once every agent is started again, every pending row shows launch_started_at; the result recorded in the switch-over log only (A-19); a row without one held', [
    ci('once every agent has been started again'),
    code('agent-director list --state pending'),
    ci('shows a `launch_started_at` on every row'),
    // The full stop: the record goes to the switch-over log and nowhere else.
    ci('record the result in the switch-over log.'),
    ci("a row without one is a human's to look at"),
    ci('the persona whose row it is is held'),
  ]],
  ['step 10 › The post-install check', 'operator action: the post-install check (C15)', [OPERATOR_ACTION]],
  ['step 11', `a daily agent-director expire at the default retention, never ${vocab('expireAll')}, as the workers' user in the pinned tmux environment`, [
    ci(`schedule a daily \`agent-director expire\` at the default retention, never ${vocab('expireAll')}`),
    ci("as the workers' user in the tmux environment step 1 pinned"),
  ]],
  ['step 11', 'operator action: scheduling the daily expire (C6)', [ci(`step 1 pinned ${OPERATOR_ACTION}`)]],
  ['step 11', "the daily expire goes into the host's sweep schedule, the one step 1's socket check names: whatever runs agent-director find-missing on a schedule", [
    ci("add it to the host's sweep schedule, the one step 1's socket check names: whatever runs `agent-director find-missing` on a schedule on your host, such as a cron entry, a systemd timer or a loop script"),
    ci('nothing on the host runs `expire` before this step'),
  ]],
  ['step 11', "a host with no sweep schedule adds one now (operator action), as the workers' user in the pinned tmux environment, running both find-missing on a schedule (Migration, linked, shows it as a cron entry) and the daily expire (b.3ut; the User's ruling)", [
    ci("a host with no sweep schedule must add one now (operator action), as the workers' user in the tmux environment step 1 pinned, running both `agent-director find-missing` on a schedule"),
    (carrier) => `([Migration]${readmeLink(MIGRATION_HEADING.slice('## '.length))(carrier)} shows it as a cron entry) and the daily \`expire\`.`,
  ]],
  ['step 11', 'the shared orchestrator prompt\'s §6 "hold until after" wording goes out then', [ci('the shared orchestrator prompt\'s "hold until after" wording goes out now')]],
  ['step 11', 'operator action: the §6 "hold until after" wording', [ci(`goes out now ${OPERATOR_ACTION}`)]],
]

/** One carrier's place, for the cases that run over every carrier. */
const overCarriers = <T extends readonly unknown[]>(rows: readonly T[]) =>
  SWITCH_OVER_CARRIERS.flatMap(([name, read]) => rows.map((row) => [name, ...row, read] as const))

/** `text` without the one command span ruling C-1 allows in `where`. */
function withoutAllowedSpan(text: string, where: keyof typeof RUNBOOK_COMMAND_SPANS): string {
  return text.split(RUNBOOK_COMMAND_SPANS[where]).join('')
}

/** The labels of the `UPGRADE_FORMS` rows that match `text`. */
function upgradeFormsIn(text: string): string[] {
  return UPGRADE_FORMS.filter(([, pattern]) => pattern.test(text)).map(([label]) => label)
}

/** The refusal block's raw text, under the helper's heading one level below the section. */
function refusalBlock(carrier: RunbookCarrier): string {
  return requiredSection(carrier.section, `${'#'.repeat(carrier.blockLevel)} ${REFUSAL_BLOCK_HEADING}`, carrier.name)
}

/** The publishing-host block's flattened text, under the helper's heading one level below the section. */
function publishingHostBlock(carrier: RunbookCarrier): string {
  return flat(requiredSection(carrier.section, `${'#'.repeat(carrier.blockLevel)} ${PUBLISHING_HOST_BLOCK_HEADING}`, carrier.name)).trim()
}

/** A block's parts, raw: the text before its first bold-led paragraph, then each paragraph led by `**…**` with what follows it. */
function blockParts(block: string): string[] {
  const parts: string[][] = [[]]
  for (const line of block.split('\n')) {
    if (line.startsWith('**')) parts.push([])
    parts[parts.length - 1].push(line)
  }
  return parts.map((lines) => lines.join('\n'))
}

/** The one part of the refusal block, flattened, that matches `anchor`; throws naming the carrier unless exactly one does. */
function refusalPart(carrier: RunbookCarrier, anchor: RegExp): string {
  const parts = blockParts(refusalBlock(carrier)).map((part) => flat(part).trim()).filter((part) => anchor.test(part))
  if (parts.length !== 1) throw new Error(`${carrier.name}, "${REFUSAL_BLOCK_HEADING}": ${parts.length} parts match ${String(anchor)}, expected 1`)
  return parts[0]
}

/** The numbered items (`1. …`, with indented continuation lines) of the refusal block's first part, the ordered list, flattened. */
function refusalOrderItems(carrier: RunbookCarrier): { n: number; text: string }[] {
  const items: { n: number; lines: string[] }[] = []
  for (const line of blockParts(refusalBlock(carrier))[0].split('\n')) {
    const start = /^(\d+)\. /.exec(line)
    if (start !== null) items.push({ n: Number(start[1]), lines: [line] })
    else if (items.length > 0 && /^\s+\S/.test(line)) items[items.length - 1].lines.push(line)
  }
  return items.map(({ n, lines }) => ({ n, text: flat(lines.join('\n')).trim() }))
}

/**
 * The refusal block's ordered elements (SRJ-1108; hatch A3), each with the
 * pattern that finds its list item and the items it must hold. The block acts
 * in this order, so the four are items 1 to 4 of its list.
 */
const REFUSAL_ORDER: [element: string, anchor: RegExp, required: readonly Item[]][] = [
  ["a persona-form config.json with no pre-persona copy: a stop that changes nothing, rollback step 8's rebuild, then the block again from its start", ci('`config.json` is in persona form'), [
    ci("no pre-persona copy of it exists, neither step 1's copy nor one you kept elsewhere"),
    ci('stop here and change nothing'),
    ci('no reinstall, no start and no step 1'),
    `step 8 of "${ROLLBACK_RUNBOOK_SECTION_TITLE}"`,
    ci('follow this block again from its start'),
  ]],
  ["otherwise: the crontable targets and /interject callers rebuilt by hand, then the previous CSCB reinstalled from step 1's files and started, autostart re-enabled", ci('first rebuild by hand'), [
    `step 8 of "${ROLLBACK_RUNBOOK_SECTION_TITLE}"`,
    ci("the crontable targets and `/interject` callers that the conversion to personas left in persona form where step 1's copy of them is missing"),
    ci('reinstall the previous CSCB, the version step 1 recorded or else the version the host ran before'),
    ci('`access.json` and Slack token environment variables'),
    ci("from step 1's files, or a pre-persona copy of `config.json` you kept, where they exist, and otherwise from those still in place"),
    ci("re-enabling the host's autostart for CSCB if it was disabled"),
  ]],
  [`then, under either class, agent-director brought to ${OLD_AD_VERSION} outside the runbook, with no command`, ci(`if agent-director is not ${OLD_AD_VERSION}`), [
    `below ${CLIENT_MIN_VERSION} under ${code(AD_SYSTEM_INSTALL_TOO_OLD)}`,
    ci(`under ${code(AD_BELOW_PHASE1_FLOOR)}`),
    ci(`bring it to ${OLD_AD_VERSION} outside this runbook`),
    ci('gives no command for it'),
  ]],
  ['then the runbook from step 1, by a link to its heading', ci('start the runbook at'), [stepLink(1)]],
]

/** The refusal block's branches and pointers after its ordered list (SRJ-1108; hatch A3), each found by the part it sits in. */
const REFUSAL_BRANCHES: [element: string, part: RegExp, required: readonly Item[]][] = [
  ["a refusal after Phase 1 was installed: at step 10 or any later start of the new CSCB, on a host whose Phase 1 install was step 8's or a publishing host's own, and only it", ci('a refusal at step 10'), [
    ci('installing agent-director Phase 1 migrates agent-director\'s store'),
    ci('a refusal at step 10, or at any later start of the new CSCB'),
    `an autostart, ${code(CLI_COMMAND_CLEAN_RESTART)} or the restart in step 4 of "${ROLLBACK_RUNBOOK_SECTION_TITLE}" included`,
    ci("whose Phase 1 install was step 8's or agent-director's own install on a publishing host"),
    ci('the server finds the wrong agent-director binary'),
    ci('for that refusal, and only for it'),
  ]],
  ["the binary check: the lookup order, then `<path> version` on the startup-errors entry's path, as the workers' user in the launcher environment", ci('a refusal at step 10'), [
    `${code(vocab('homeBinary'))} first, then the first ${code('agent-director')} on ${code('PATH')}`,
    ci('the binary path the startup-errors entry names'),
    code('<path> version'),
    ci("as the workers' user in the bot server's launcher environment"),
  ]],
  ['put Phase 1 back, with every agent and long-running process stopped around the change and CSCB bots stopped through "Operator actions", then start the new CSCB as step 10 does; or follow the rollback', ci('a refusal at step 10'), [
    ci('put agent-director Phase 1 back as the binary the server finds'),
    `follow "${ROLLBACK_RUNBOOK_SECTION_TITLE}", which starts the previous CSCB`,
    ci(`stop every agent on the host and every long-running agent-director process (${code('agent-director serve')} included) before that binary change, and start them again after it`),
    vocab('stoppingSetItem'),
    `${vocab('operatorActions')} section of agent-director's README`,
    ci('once the server finds Phase 1, start the new CSCB as'),
    stepLink(10),
  ]],
  ['the old CSCB is never reinstalled onto the migrated store', ci('a refusal at step 10'), [ci('never reinstall the old CSCB onto the migrated store')]],
  ["at rollback step 4's restart with an agent still running: nothing put back, no rollback rerun, the new CSCB stopped until agent-director has dealt with it", ci('a refusal at step 10'), [
    ci(`at the restart in step 4 of "${ROLLBACK_RUNBOOK_SECTION_TITLE}", an agent that could not be stopped still runs`),
    ci('put nothing back'),
    ci("don't follow the rollback again"),
    ci('the new CSCB stays stopped until agent-director has dealt with that agent'),
    ci('then this branch applies'),
  ]],
  ['Phase 1 installed any other way outside the runbook: not a target; the rollback runbook and "Operator actions"', ci('installed in any other way outside this runbook'), [
    ci('installed in any other way outside this runbook is not a target of this runbook'),
    ci(`follow "${ROLLBACK_RUNBOOK_SECTION_TITLE}"`),
    '"agent-director was installed outside the caller\'s switch-over"',
    vocab('operatorActions'),
  ]],
  ['a stop by the runtime re-check: not a switch-over case; the debugging skill instead', ci('runtime re-check'), [
    ci('not a switch-over case'),
    `(${DEBUG_SKILL_FILE}#`,
  ]],
]

/** The publishing-host block's elements (SRJ-1108; the E5 hatch note; hatch A3). */
const PUBLISHING_HOST_ELEMENTS: [element: string, required: readonly Item[]][] = [
  [`/publish needs an agent-director binary the client accepts (${CLIENT_MIN_VERSION} or later)`, [
    ci('`/publish` checks that the publishing host has an agent-director binary the client accepts'),
    ci(`${CLIENT_MIN_VERSION}, the client's minimum, or later`),
  ]],
  ['publish from a host that already passes that check', [ci('publish from a host that already passes that check')]],
  ["a host with no agent-director installs Phase 1 by agent-director's own install, then publishes", [
    ci("a host with no agent-director installs agent-director's Phase 1 release by agent-director's own install, then publishes"),
    ci('no agents and nothing to back up'),
  ]],
  [`a host below the client's minimum publishes from another host, is not a target, and brings agent-director to ${OLD_AD_VERSION} first outside the runbook, with no command`, [
    ci(`a host below the client's minimum (${CLIENT_MIN_VERSION}) publishes from another host`),
    ci('is not a target of this runbook'),
    ci(`brings agent-director to ${OLD_AD_VERSION} first, outside this runbook, since step 1 stops on any version but ${OLD_AD_VERSION}`),
    ci('gives no command for it'),
  ]],
  ['a publishing host needs no operator go-ahead', [ci('a publishing host needs no operator go-ahead')]],
]

/** The step reader's helper, loaded in the `/ci` image from `/tests`, which holds `tests/` without `src/` or the repo's `node_modules`. */
const RUNBOOKS_HELPER = 'tests/test-helpers/runbooks.ts'

/** The directory every file on `RUNBOOKS_HELPER`'s load path must sit in. */
const IMAGE_SAFE_HELPERS_DIR = 'tests/test-helpers/'

/** Each module specifier `text` imports or re-exports: `import … from`, `export … from`, a bare `import '…'`, `import('…')` and `require('…')`. */
function moduleSpecifiers(text: string): string[] {
  const forms = /^\s*(?:import|export)\b[^'";()`]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/gm
  return [...text.matchAll(forms)].map((m) => m[1] ?? m[2] ?? m[3])
}

/**
 * The files on `entry`'s load path (repo-relative, `entry` first, in the order
 * reached) and its problems: an import of anything but a relative file
 * inside `IMAGE_SAFE_HELPERS_DIR` (`src/`, `agent-director`, a `node:` or
 * other package), and any use of `Bun.`, `process.` or `Deno.`, through
 * which a module reads or writes. `read` gives a file's text. Pure.
 */
function helperLoadPath(entry: string, read: (relPath: string) => string): { files: string[]; problems: string[] } {
  const files = [entry]
  const problems: string[] = []
  for (let k = 0; k < files.length; k++) {
    const file = files[k]
    const text = read(file)
    for (const use of text.match(/\b(?:Bun|process|Deno)\./g) ?? []) problems.push(`${file} uses ${use}`)
    for (const spec of moduleSpecifiers(text)) {
      const target = spec.startsWith('.') ? join(dirname(file), spec) : undefined
      if (target === undefined || !target.startsWith(IMAGE_SAFE_HELPERS_DIR)) problems.push(`${file} imports "${spec}", outside ${IMAGE_SAFE_HELPERS_DIR}`)
      else if (!files.includes(target)) files.push(target)
    }
  }
  return { files, problems }
}

describe(`the switch-over runbook, "${PHASE1_RUNBOOK_SECTION_TITLE}" (b.jg5 SRJ-1108)`, () => {
  describe(`the step reader's load path, from ${RUNBOOKS_HELPER} (ruling Q13; the /ci image's /tests)`, () => {
    test(`${RUNBOOKS_HELPER} and everything it imports sit in ${IMAGE_SAFE_HELPERS_DIR}, import nothing from src/, agent-director or any package, and read and write nothing`, () => {
      expect(helperLoadPath(RUNBOOKS_HELPER, readRepoFile)).toEqual({ files: [RUNBOOKS_HELPER, 'tests/test-helpers/markdown.ts'], problems: [] })
    })

    test.each([
      ['a re-export from src/', `export { PUBLISHING_HOST_BLOCK_HEADING } from '../../src/ad-version-gate.ts'\n`, `${RUNBOOKS_HELPER} imports "../../src/ad-version-gate.ts", outside ${IMAGE_SAFE_HELPERS_DIR}`],
      ['an agent-director import', `import type { UnreachableReason } from 'agent-director'\n`, `${RUNBOOKS_HELPER} imports "agent-director", outside ${IMAGE_SAFE_HELPERS_DIR}`],
      ['a multi-line import from a node: module', `import {\n  readFileSync,\n} from 'node:fs'\n`, `${RUNBOOKS_HELPER} imports "node:fs", outside ${IMAGE_SAFE_HELPERS_DIR}`],
      ['a file read through Bun', `const text = await Bun.file('x').text()\n`, `${RUNBOOKS_HELPER} uses Bun.`],
    ])('self-check: with %s added to the helper, the load-path check names it', (_how, line, problem) => {
      const read = (relPath: string) => (relPath === RUNBOOKS_HELPER ? line : '') + readRepoFile(relPath)
      expect(helperLoadPath(RUNBOOKS_HELPER, read).problems).toEqual([problem])
    })

    test('self-check: a src/ import in a file the helper imports is named with that file', () => {
      const markdown = 'tests/test-helpers/markdown.ts'
      const read = (relPath: string) => (relPath === markdown ? `import { flat } from '../../src/text.ts'\n` : '') + readRepoFile(relPath)
      expect(helperLoadPath(RUNBOOKS_HELPER, read).problems).toEqual([`${markdown} imports "../../src/text.ts", outside ${IMAGE_SAFE_HELPERS_DIR}`])
    })
  })

  describe('the step reader (self-checks, in memory)', () => {
    const section = (...numbers: number[]) => numbers.map((n) => `#### ${stepHeadingPrefix(n)}Do ${n}\nBody ${n}.`).join('\n')

    test('steps 1 to n in order are read by number, each without its heading line', () => {
      expect(runbookSteps(section(1, 2, 3), { count: 3, level: 4, name: 'fixture' })).toEqual([
        { number: 1, title: `${stepHeadingPrefix(1)}Do 1`, line: 0, text: 'Body 1.' },
        { number: 2, title: `${stepHeadingPrefix(2)}Do 2`, line: 2, text: 'Body 2.' },
        { number: 3, title: `${stepHeadingPrefix(3)}Do 3`, line: 4, text: 'Body 3.' },
      ])
    })

    test.each([
      ['missing', section(1, 3), 3, 'fixture: step 2 is missing'],
      ['duplicated', section(1, 2, 2, 3), 3, 'fixture: step 2 appears 2 times'],
      ['out of order', section(1, 3, 2), 3, 'fixture: step 3 is out of order'],
      ['beyond the count', section(1, 2, 3, 4), 3, 'fixture: step 4 is beyond the expected 3 steps'],
      ['at another level', section(1, 2).replace('#### Step 2', '##### Step 2'), 2, 'fixture: step 2 is missing'],
    ])('a step %s throws naming the step', (_how, text, count, message) => {
      expect(() => runbookSteps(text, { count, level: 4, name: 'fixture' })).toThrow(message)
    })

    test("a step's text keeps its lower headings and stops at the next heading of its level or higher", () => {
      const text = `#### ${stepHeadingPrefix(1)}A\none\n##### Detail\ninner\n#### Other block\nafter\n#### ${stepHeadingPrefix(2)}B\ntwo\n### Next section\nout`
      expect(runbookSteps(text, { count: 2, level: 4, name: 'fixture' }).map((step) => step.text)).toEqual(['one\n##### Detail\ninner', 'two'])
    })

    test("with no level given, steps are read at the section's shallowest heading level, its blocks' level", () => {
      const text = `Frame.\n#### A block\nblock\n${section(1, 2)}\n##### ${stepHeadingPrefix(3)}Nested\nnested`
      expect(runbookSteps(text, { count: 2 }).map((step) => step.number)).toEqual([1, 2])
      expect(() => runbookSteps(text.replace('#### A block', '### A block'), { count: 2 })).toThrow('step 1 is missing (no "### Step 1: …" heading)')
    })

    test('with no count given, the highest step number is the count, and a gap below it still throws naming the step', () => {
      expect(runbookSteps(section(1, 2, 3, 4)).map((step) => step.number)).toEqual([1, 2, 3, 4])
      expect(() => runbookSteps(section(1, 2, 4))).toThrow('step 3 is missing')
      expect(() => runbookSteps(section(2, 1))).toThrow('step 2 is out of order')
    })

    test.each([
      ['no heading at all', 'Only prose.', 'step 1 is missing (no "Step 1: …" heading)'],
      ['no step heading', '#### A block\nblock', 'step 1 is missing (no "#### Step 1: …" heading)'],
      ['a step 0', section(0, 1), 'step 0 is not a step number (steps start at 1)'],
    ])('a section with %s throws naming the step, with no name before it when none is given', (_how, text, message) => {
      expect(() => runbookSteps(text)).toThrow(new Error(message))
    })

    test.each(Array.from({ length: SWITCH_OVER_STEP_COUNT }, (_, i) => i + 1))("the helper's step form reads back step %d", (n) => {
      expect(stepNumberOf(`${stepHeadingPrefix(n)}Title`)).toBe(n)
    })

    test.each([REFUSAL_BLOCK_HEADING, PUBLISHING_HOST_BLOCK_HEADING, 'Step 1 Title', 'Step 01: Title', 'Steps 1: Title', 'Step 1: ', 'Step one: Title'])(
      "the helper's step form rejects %p",
      (title) => {
        expect(stepNumberOf(title)).toBeUndefined()
      },
    )
  })

  test('the vocabulary table has a ceiling formula for exactly the ceilings CSCB calls', () => {
    const rows = Object.keys(AD_VOCABULARY).filter((key) => key.startsWith('ceiling ')).map((key) => key.slice('ceiling '.length))
    expect(rows.sort()).toEqual([...CSCB_CEILINGS].sort())
  })

  test.each(overCarriers(SWITCH_OVER_ELEMENTS))('%s, %s: %s', (carrierName, where, element, required, read) => {
    const carrier = read()
    expect({ carrier: carrierName, where, element, missing: missingItems(carrier, textAt(carrier, where), required) }).toEqual({
      carrier: carrierName,
      where,
      element,
      missing: [],
    })
  })

  describe('negative and order checks', () => {
    test.each(overCarriers([[vocab('baseIndex')], [vocab('paneBaseIndex')]] as const))('%s: step 1 does not name %s', (_name, term, read) => {
      expect(read().steps[0]).not.toContain(term)
    })

    test.each(SWITCH_OVER_CARRIERS)("%s: step 1's version check comes right after the go-ahead item, before anything else", (_name, read) => {
      const items = stepItems(read().steps[0])
      expect(items.findIndex((item) => item.text.includes('Confirm the go-ahead for the switch-over on this host'))).toBe(0)
      expect(items.findIndex((item) => item.text.includes(code('agent-director version')))).toBe(1)
    })

    test.each(overCarriers(UPGRADE_FORMS.map(([label, pattern]) => [label, pattern] as const)))(
      "%s: step 1's version item carries no %s once its `agent-director version` span is removed (ruling C-1)",
      (_name, _label, pattern, read) => {
        expect(withoutAllowedSpan(textAt(read(), "step 1 › agent-director's version"), "step 1's version item")).not.toMatch(pattern)
      },
    )

    test.each(SWITCH_OVER_CARRIERS)('%s: step 8 confirms the go-ahead, stops the agents, backs up, installs, writes [tmux] and restarts serve, in that order', (_name, read) => {
      const step = read().steps[7]
      const order = [
        ci('confirm that the go-ahead for this host still stands'),
        ci('stop every other agent on the host'),
        ci(vocab('sqliteBackup')),
        ci('schema migration adds'),
        ci(`write any non-default ${code(`[${AD_TMUX_TABLE}]`)} values`),
        ci('restart every `agent-director serve` process'),
      ].map((pattern) => step.search(pattern))
      expect(order.filter((at) => at < 0)).toEqual([])
      expect(order).toEqual([...order].sort((a, b) => a - b))
    })

    test.each(SWITCH_OVER_CARRIERS)('%s: step 10 changes the orchestrator prompt, starts the new CSCB, then re-enables the autostart, in that order', (_name, read) => {
      const step = read().steps[9]
      const order = [ci('"kill, then leave the row"'), ci('start the new CSCB'), ci("re-enable the host's autostart for CSCB")].map((pattern) => step.search(pattern))
      expect(order.filter((at) => at < 0)).toEqual([])
      expect(order).toEqual([...order].sort((a, b) => a - b))
    })

    // SRJ-1101's placement of `tmux kill-session` (steps 5 and 6 only, always
    // `-t =`) and its terms (include-finished, agent-director delete) are
    // checked over the whole of each carrier file by E36 T4's whole-file
    // cases: `killSessionsOutsideSteps`, the step-reader count case,
    // `offListTmuxCommands` and `SRJ_1101_TERMS`.
  })

  describe(`the "${REFUSAL_BLOCK_HEADING}" block (E2 gate; hatch A3)`, () => {
    test.each(SWITCH_OVER_CARRIERS)("%s: the helper's heading is the section's first subsection, one level below it, before step 1", (_name, read) => {
      const carrier = read()
      const [first] = headings(carrier.section)
      expect(first?.text).toBe(`${'#'.repeat(carrier.blockLevel)} ${REFUSAL_BLOCK_HEADING}`)
    })

    test.each(overCarriers(REFUSAL_LABELS.map((label) => [label] as const)))('%s: the block names %s as a code span', (_name, label, read) => {
      expect(flat(refusalBlock(read()))).toContain(code(label))
    })

    test.each(SWITCH_OVER_CARRIERS)('%s: the block covers only a refusal before Phase 1 is installed, by step 8 or otherwise', (_name, read) => {
      expect(flat(blockParts(refusalBlock(read()))[0])).toMatch(ci('covers only a refusal before agent-director Phase 1 is installed on the host, by step 8 or otherwise'))
    })

    test.each(overCarriers(REFUSAL_ORDER))('%s, in order: %s', (_name, element, anchor, required, read) => {
      const carrier = read()
      const items = refusalOrderItems(carrier).filter((item) => anchor.test(item.text))
      if (items.length !== 1) throw new Error(`${carrier.name}: ${items.length} items of the ordered list match ${String(anchor)}, expected 1`)
      expect({ element, missing: missingItems(carrier, items[0].text, required) }).toEqual({ element, missing: [] })
    })

    test.each(SWITCH_OVER_CARRIERS)('%s: the ordered elements are items 1 to 4 of the list, in that order', (_name, read) => {
      const items = refusalOrderItems(read())
      expect(REFUSAL_ORDER.map(([, anchor]) => items.filter((item) => anchor.test(item.text)).map((item) => item.n))).toEqual([[1], [2], [3], [4]])
    })

    test.each(overCarriers(REFUSAL_BRANCHES))('%s: %s', (_name, element, part, required, read) => {
      const carrier = read()
      expect({ element, missing: missingItems(carrier, refusalPart(carrier, part), required) }).toEqual({ element, missing: [] })
    })

    test.each(SWITCH_OVER_CARRIERS)('%s: the after-install branch names no `command -v agent-director`', (_name, read) => {
      expect(flat(refusalBlock(read()))).not.toMatch(/command -v agent-director/)
    })

    test.each(SWITCH_OVER_CARRIERS)('%s: a host whose Phase 1 came some other way is offered no "put Phase 1 back and start"', (_name, read) => {
      const carrier = read()
      const part = refusalPart(carrier, ci('installed in any other way outside this runbook'))
      const offers = [...part.matchAll(/put (?:agent-director )?Phase 1 back/gi)].filter((m) => !/\b(?:don't|do not|never|no)\s+$/i.test(part.slice(0, m.index)))
      expect(offers.map((m) => m[0])).toEqual([])
      expect(part).not.toContain(stepLink(10)(carrier))
    })

    test.each(overCarriers(UPGRADE_FORMS.map(([label, pattern]) => [label, pattern] as const)))(
      '%s: the block carries no %s once its `agent-director serve` span is removed (ruling C-1)',
      (_name, _label, pattern, read) => {
        expect(withoutAllowedSpan(flat(refusalBlock(read())), 'refusal block')).not.toMatch(pattern)
      },
    )

    test.each([
      ['another backticked agent-director command', `Stop it (${RUNBOOK_COMMAND_SPANS['refusal block']} included), then run \`agent-director stop-all\`.`, ['backticked agent-director command line']],
      ['the allowed span with arguments', `Restart ${code('agent-director serve --port 1')}.`, ['backticked agent-director command line']],
      ['only the allowed span', `Stop every process (${RUNBOOK_COMMAND_SPANS['refusal block']} included).`, []],
    ])('self-check (ruling C-1): a synthetic block with %s', (_label, block, forms) => {
      expect(upgradeFormsIn(withoutAllowedSpan(block, 'refusal block'))).toEqual(forms)
    })

    test(`self-check (ruling C-1): another agent-director command in step 1's version item still fails`, () => {
      const item = `Run ${RUNBOOK_COMMAND_SPANS["step 1's version item"]}; if it is older, run \`agent-director install --phase1\`.`
      expect(upgradeFormsIn(withoutAllowedSpan(item, "step 1's version item"))).toEqual(['backticked agent-director command line'])
    })
  })

  describe(`the "${PUBLISHING_HOST_BLOCK_HEADING}" block (E5 hatch note)`, () => {
    test.each(overCarriers(PUBLISHING_HOST_ELEMENTS))('%s: %s', (_name, element, required, read) => {
      const carrier = read()
      expect({ element, missing: missingItems(carrier, publishingHostBlock(carrier), required) }).toEqual({ element, missing: [] })
    })

    test.each(overCarriers(UPGRADE_FORMS.map(([label, pattern]) => [label, pattern] as const)))('%s: the block carries no %s', (_name, _label, pattern, read) => {
      expect(publishingHostBlock(read())).not.toMatch(pattern)
    })
  })

  describe('README.md: the links and the sections the runbook replaced or kept', () => {
    const readme = operatorText('README.md')
    const migration = () => requiredSection(readme, MIGRATION_HEADING, 'README.md')
    const readmeCarrier = () => readRunbookCarrier('README.md', readme, SWITCH_OVER_HEADING, SWITCH_OVER_STEP_COUNT)

    test('the runtime-stop pointer links a heading inside the debugging skill\'s refusal section', () => {
      const skill = operatorText(DEBUG_SKILL_FILE)
      const part = refusalPart(readmeCarrier(), ci('runtime re-check'))
      const anchors = markdownLinks(part).filter((link) => link.path === DEBUG_SKILL_FILE).map((link) => link.anchor)
      expect(anchors).toHaveLength(1)
      const index = headingAnchors(skill).indexOf(anchors[0])
      const parent = sectionRange(skill, `## ${REFUSAL_SECTION_TITLE}`)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(parent).toBeDefined()
      const line = headings(skill)[index].line
      expect(line > parent!.start && line < parent!.end).toBe(true)
    })

    test(`no README heading is "${GONE_TITLE}"`, () => {
      expect(headings(readme).filter((h) => h.title === GONE_TITLE).map((h) => h.text)).toEqual([])
    })

    test.each(['README.md', ...shippedSkillFiles().filter((file) => file.endsWith('.md'))])(`%s links nowhere to "${GONE_TITLE}"`, (file) => {
      const anchor = headingSlug(GONE_TITLE)
      expect(markdownLinks(docText(file)).filter((link) => link.anchor === anchor).map((link) => link.target)).toEqual([])
    })

    const UPGRADING_HEADING = `### ${UPGRADING_TITLE}`
    const upgrading = () => flat(requiredSection(migration(), UPGRADING_HEADING, `README.md, under "${MIGRATION_HEADING}",`))

    test.each([
      ['config.json rewritten by hand', ci('rewrite `config.json` by hand')],
      ['persona names whose keys do not start with one another', ci("pick persona names whose keys don't start with one another")],
      ['the reply settings', ci('set the reply settings in `config.json`')],
      ['the tokens moved into credentials files', ci('move the tokens into credentials files')],
      ['a Slack app per persona', ci('give each persona its own Slack app')],
      ['who can reach each persona', ci('decide who can reach each persona')],
      ['crontable lines naming personas', ci('rewrite crontable lines to name personas')],
      ['/interject callers sending persona', ci('update `/interject` callers to send `persona`')],
    ])(`"${UPGRADING_HEADING}" keeps its conversion step: %s`, (_label, pattern) => {
      expect(upgrading()).toMatch(pattern)
    })

    test(`"${UPGRADING_HEADING}" says step 1 writes these steps into the separate staged file, not config.json, and step 7 puts it in place as config.json`, () => {
      expect(upgrading()).toMatch(ci('at switch-over step 1, these steps are written into the separate staged file, not `config.json`'))
      expect(upgrading()).toMatch(ci('step 7 puts that file in place as `config.json`'))
    })

    test.each([1, 7])(`"${UPGRADING_HEADING}" links switch-over step %d`, (n) => {
      expect(markdownLinks(upgrading()).map((link) => link.anchor)).toContain(readmeCarrier().stepAnchors[n - 1])
    })

    test.each([CLI_COMMAND_STOP_BOTS, 'claude-slack-channel-bots start'])(`"${UPGRADING_HEADING}" no longer holds %s`, (command) => {
      expect(upgrading()).not.toContain(command)
    })
  })
})

// ---------------------------------------------------------------------------
// The rollback runbook (b.jg5 SRJ-1109; hatch A3; ruling C-2)
// ---------------------------------------------------------------------------

/** The rollback runbook's step count (SRJ-1109: steps 1 to 9). */
const ROLLBACK_STEP_COUNT = 9

/** Every carrier of the rollback runbook: its name and its reader. The README section and the CHANGELOG release entry's copy, as for `SWITCH_OVER_CARRIERS`. */
const ROLLBACK_CARRIERS: [name: string, read: () => RunbookCarrier][] = [
  ['README.md', lazy(() => readRunbookCarrier('README.md', operatorText('README.md'), ROLLBACK_HEADING, ROLLBACK_STEP_COUNT))],
  [CHANGELOG_FILE, lazy(() => readRunbookCarrier(CHANGELOG_FILE, releaseEntry(operatorText(CHANGELOG_FILE)), ROLLBACK_HEADING, ROLLBACK_STEP_COUNT))],
]

/** One rollback carrier's place, for the cases that run over every carrier. */
const overRollbackCarriers = <T extends readonly unknown[]>(rows: readonly T[]) =>
  ROLLBACK_CARRIERS.flatMap(([name, read]) => rows.map((row) => [name, ...row, read] as const))

/** A count as the runbooks write it, in words; throws for a count it lacks, so a changed count fails naming it. */
function countWord(n: number): string {
  const words: Record<number, string> = { 7: 'seven', 8: 'eight', 9: 'nine' }
  const word = words[n]
  if (word === undefined) throw new Error(`countWord has no word for ${n}`)
  return word
}

/** The old CSCB's tmux session names, which the previous CSCB uses again after the rollback (SRJ-1109 step 5). */
const OLD_SESSION_NAMES = [`${PERSONA_TMUX_SESSION_PREFIX}<name>_<channel>`, `${PERSONA_TMUX_SESSION_PREFIX}<channel ID>`]

/**
 * One row per SRJ-1109 element: where it sits (`frame`, `step <n>` or
 * `step <n> › <item lead>`), the element, and the items its text must hold.
 * The `operator action` rows mark each operator-only action at its step.
 * Links are checked only in the README (ruling C-2, below), so the rows hold
 * for a copy whose links differ.
 */
const ROLLBACK_ELEMENTS: [where: string, element: string, required: readonly Item[]][] = [
  // The section-level statements.
  ['frame', `back to the previous CSCB on agent-director ${OLD_AD_VERSION}; both binaries rolled back together`, [
    ci(`back to the previous CSCB on agent-director ${OLD_AD_VERSION}`),
    ci('both binaries are rolled back together'),
  ]],
  ['frame', `the previous agent-director is restored only with agent-director's ${vocab('downgradeRecipe')}, never state.db from the switch-over backup`, [
    ci(`the previous agent-director is restored only with agent-director's ${vocab('downgradeRecipe')}, in step 6`),
    ci("never restore `state.db` from the switch-over's backup"),
  ]],
  ['frame', "the reason: the store is shared, and a restore drops other services' rows, leaving their workers running with no row", [
    ci('the store is shared by every agent-director user on the host'),
    ci("a restore would drop the rows of other services' workers spawned since the switch-over, leaving them running with no row"),
  ]],
  ['frame', 'every agent and long-running agent-director process stopped before the previous binary is restored and started again after it (C15)', [
    ci(`every agent on the host, with every long-running agent-director process (${code('agent-director serve')} included), is stopped before the previous binary is restored and started again after it`),
  ]],
  ['frame', 'the switch-over log kept in use; each step says what to record', [ci('keep using the switch-over log'), ci('each step says what to record in it')]],
  ['frame', "commands run as the workers' user in the tmux environment switch-over step 1 pinned", [
    ci("run every command as the workers' user, in the tmux environment switch-over step 1 pinned"),
  ]],
  ['frame', 'operator-only actions are marked "operator action"', [ci('steps marked "operator action" are done by a human on the host')]],
  ['frame', `${vocab('operatorActions')} is that section of agent-director's README`, [ci(`${vocab('operatorActions')} is that section of agent-director's README`)]],

  // Steps 1 and 2.
  ['step 1', "the host's autostart for CSCB disabled until step 9, recorded", [
    ci("disable the host's autostart for CSCB until step 9"),
    ci('record it in the switch-over log'),
  ]],
  ['step 1', "operator action: disabling the host's autostart for CSCB", [ci(`until step 9 ${OPERATOR_ACTION}`)]],
  ['step 2', "the daily agent-director expire switch-over step 11 added removed from the host's sweep schedule, whatever runs it, recorded", [
    ci("remove the daily `agent-director expire` run that switch-over step 11 added to the host's sweep schedule, the cron entry, systemd timer or loop script that runs it"),
    ci('record it in the switch-over log'),
  ]],
  ['step 2', 'before the previous binary is restored, because the older expire does not check tmux', [
    ci('before the previous binary is restored, because the older `expire` does not check tmux'),
  ]],
  ['step 2', 'operator action: removing the daily expire', [ci(`loop script that runs it ${OPERATOR_ACTION}`)]],

  // Step 3.
  ['step 3', `the new CSCB stopped with ${CLI_COMMAND_STOP_BOTS}, whose failure lines the README describes (E32, E33)`, [
    `claude-slack-channel-bots ${CLI_COMMAND_STOP_BOTS}`,
    ci("the command's failure lines are described in"),
    'Precheck before stopping bots',
    "What the command prints when a bot can't be stopped",
  ]],
  ['step 3', `a persona in ${AD_ERROR_CLASS_CONFLICT}: a human follows ${vocab('operatorActions')} for its session, checks the result and runs ${CLI_COMMAND_STOP_BOTS} again`, [
    `naming a persona in ${AD_ERROR_CLASS_CONFLICT}`,
    ci(`a human follows ${vocab('operatorActions')} for that persona's session, checks the result, and runs ${code(CLI_COMMAND_STOP_BOTS)} again`),
  ]],
  ['step 3', `that session not ended, agent-director not answering or a call ${AD_ERROR_CLASS_UNAVAILABLE} after its retries: plain stop, each persona and session recorded`, [
    ci('if that session cannot be ended that way'),
    ci('the command exits non-zero because agent-director does not answer'),
    `a call stays ${AD_ERROR_CLASS_UNAVAILABLE} after its retries`,
    ci('stop the server with plain `stop`'),
    'claude-slack-channel-bots stop ```',
    ci('record in the switch-over log each persona and session the failed command named'),
  ]],

  // Step 4.
  ['step 4', `agent-director find-missing, then at most ${vocab('waitMinutes')} minutes for every ${SERVICE_LABEL} row, retired keys' rows included, to read ended or missing`, [
    code('agent-director find-missing'),
    ci(`wait at most ${vocab('waitMinutes')} minutes for every \`${SERVICE_LABEL}\` row, the rows of retired persona keys included, to read \`ended\` or \`missing\``),
  ]],
  ['step 4', `a row still live (a retired key whose kill failed, which ${CLI_COMMAND_STOP_BOTS} does not cover) is ended by a human with agent-director kill, its result checked`, [
    ci(`a row still live after that (for example a retired key whose kill failed, which ${code(CLI_COMMAND_STOP_BOTS)} does not cover) is ended by a human`),
    ci('run `agent-director kill --claude-instance-id <id>`, and check its result'),
  ]],
  ['step 4', "the kill's result is checked, and on an error nothing is deleted or respawned (SRJ-1101)", [
    ci(`${code('agent-director kill --claude-instance-id <id>')}, and ${KILL_CAVEAT}`),
  ]],
  ['step 4', `a kill refused with ${AD_ERROR_CLASS_CONFLICT} ("${vocab('notThisLaunch')}") meets a leftover of an earlier launch, handled as ${vocab('operatorActions')} describes`, [
    `refused with ${AD_ERROR_CLASS_CONFLICT} ("${vocab('notThisLaunch')}")`,
    ci('has met a leftover of an earlier launch'),
    ci(`handle it as ${vocab('operatorActions')} describes`),
  ]],
  ['step 4', `kills that keep failing: ${vocab('operatorActions')} for that worker, recorded`, [
    ci(`if these kills keep failing, follow ${vocab('operatorActions')} for that worker, and record it in the switch-over log`),
  ]],
  ['step 4', 'nothing goes on to step 6 while such a worker runs, because every agent must be stopped before the restore (ADA question 9)', [
    ci('nothing goes on to step 6 while such a worker runs, because every agent must be stopped before the previous binary is restored'),
  ]],
  ['step 4', `a worker ${vocab('operatorActions')} cannot end: the rollback stops with Phase 1 installed and the worker goes to agent-director`, [
    ci(`when ${vocab('operatorActions')} cannot end it either`),
    ci('the rollback stops here, with Phase 1 still installed, and the worker is taken to agent-director'),
  ]],
  ['step 4', "then the new CSCB started again, step 2's expire restored and the autostart re-enabled, so the fleet does not stay down", [
    ci('so that the fleet does not stay down while agent-director investigates'),
    ci('start the new CSCB again'),
    ci("restore step 2's daily `expire` to the host's sweep schedule"),
    ci("re-enable the host's autostart for CSCB"),
  ]],
  ['step 4', "operator action: the new CSCB's restart, the expire and the autostart", [ci(`autostart for CSCB ${OPERATOR_ACTION}`)]],
  ['step 4', `a refused restart: the new CSCB stays stopped until agent-director has dealt with the worker, then the refusal block's after-install branch (SRJ-1108)`, [
    ci('if that start is refused, the new CSCB stays stopped until agent-director has dealt with that worker'),
    ci('then follow "A refusal after Phase 1 was installed"'),
    REFUSAL_BLOCK_HEADING,
  ]],

  // Step 5.
  ['step 5', `a read-only tmux ls, as the workers' user on the pinned socket, confirms no ${PERSONA_TMUX_SESSION_PREFIX}<key> session is left`, [
    ci("as the workers' user, on the socket switch-over step 1 pinned, run a read-only `tmux ls`"),
    ci(`confirm that no ${code(`${PERSONA_TMUX_SESSION_PREFIX}<key>`)} session is left`),
    ci("handle each leftover by whether it has a row and, if it has one, by that row's current state"),
  ]],
  ['step 5', `a live row's leftover: agent-director kill of ${PERSONA_INSTANCE_ID_PREFIX}<key>; refused with "${vocab('notThisLaunch')}", ${vocab('operatorActions')}`, [
    ci('a leftover whose row is live'),
    code(`agent-director kill --claude-instance-id ${PERSONA_INSTANCE_ID_PREFIX}<key>`),
    ci(`when that \`kill\` is refused with "${vocab('notThisLaunch')}", handle it as ${vocab('operatorActions')} describes`),
  ]],
  ['step 5', "the live row's kill: its result checked, and on an error nothing deleted or respawned (SRJ-1101)", [
    ci(`${code(`agent-director kill --claude-instance-id ${PERSONA_INSTANCE_ID_PREFIX}<key>`)}, and ${KILL_CAVEAT}`),
  ]],
  ['step 5', `a finished row's own leftover session: as ${vocab('operatorActions')} describes`, [
    new RegExp(`a finished row's own leftover session\\W+handle it as ${escapeRegExp(vocab('operatorActions'))} describes`, 'i'),
  ]],
  ['step 5', 'an operator action refused inside the stopping window or starting-session bound: retried once the longer has passed, the nine settings read again and recorded; a plain kill never refuses so', [
    ci('an operator action refused inside the stopping window or the starting-session bound'),
    ci('retry it once the longer of the two has passed'),
    () => `all ${countWord(AD_TMUX_KEYS.length)} timing settings again, as in switch-over step 1`,
    ci('record them in the switch-over log'),
    ci('a plain `kill` never refuses for that reason'),
  ]],
  ['step 5', "a leftover with no row: as in switch-over step 5, against the previous CSCB's session names", [
    ci('a leftover with no row'),
    ci('switch-over step 5'),
    ci("against the previous CSCB's session names"),
    ...OLD_SESSION_NAMES.map(code),
  ]],
  ['step 5', "each result checked, then find-missing and switch-over step 5's gone check again", [
    ci("check each result, then run `agent-director find-missing` and switch-over step 5's gone check again"),
  ]],
  ['step 5', "no going on while a leftover remains: the previous CSCB's first start deletes every row without a channel label", [
    ci("don't go on while a leftover remains"),
    ci("the previous CSCB's first start deletes every row without a `channel` label"),
  ]],

  // Step 6.
  ['step 6 › Stop every other agent', "every other agent and long-running agent-director process stopped before the restore: workers, hand-started sessions, serve sessions, whose Claude session is stopped too (HO C15; ADA question 9)", [
    ci('before the previous binary is restored, stop every other agent on the host and every long-running agent-director process'),
    ci("orchestrators' workers, hand-started sessions and sessions with an `agent-director serve`"),
    ci('a `serve` runs inside its Claude session, so that session is stopped too'),
  ]],
  ['step 6 › Stop every other agent', 'operator action: stopping every other agent (C15)', [OPERATOR_ACTION]],
  ['step 6 › Stop every other agent', 'confirmed as in switch-over step 8: agent-director list, a read-only tmux ls, recorded', [
    ci('confirm as in'),
    ci('switch-over step 8'),
    ci("`agent-director list` shows each stopped agent's row `ended` or `missing`"),
    ci('a read-only `tmux ls` shows no agent session left'),
    ci('record it in the switch-over log'),
  ]],
  ['step 6 › Stop every other agent', 'no restore while any agent runs; one that cannot be stopped stops the rollback as step 4 says, and the stopped agents start again on Phase 1', [
    ci('the restore does not begin while any agent runs'),
    ci('if one cannot be stopped, the rollback stops as step 4 says'),
    ci('every agent this step stopped is started again on Phase 1 by its owner'),
  ]],
  ['step 6 › Stop every other agent', 'operator action: the stopped agents started again on Phase 1 by their owners', [ci(`started again on Phase 1 by its owner ${OPERATOR_ACTION}`)]],
  ['step 6 › Restore the previous agent-director', `restored with agent-director's ${vocab('downgradeRecipe')}, never from the switch-over's state.db backup`, [
    ci(`with agent-director's ${vocab('downgradeRecipe')}, never from the switch-over's \`state.db\` backup`),
  ]],
  ['step 6 › Restore the previous agent-director', `the recipe drops the ${vocab('migrationColumns')} columns and the ${vocab('storeMeta')} table holding the store's id (HO rev 15, rev 19)`, [
    ci(`drops the ${vocab('migrationColumns')} columns the Phase 1 migration added and its ${vocab('storeMeta')} table, which holds the store's id`),
  ]],
  ['step 6 › Restore the previous agent-director', `the recipe stamps schema version ${vocab('downgradeSchemaVersion')} and deletes no row or history entry; the older binary shows every life's history again`, [
    ci(`stamps schema version ${vocab('downgradeSchemaVersion')}`),
    ci("it deletes no row or history entry, so the older binary shows every life's history again"),
  ]],
  ['step 6 › Restore the previous agent-director', "a later Phase 1 install creates a new store id: an earlier-labelled session reads as another store's, one more reason no agent runs across the restore (HO rev 15)", [
    ci('a later Phase 1 install creates a new store id'),
    ci("a session labelled before the rollback would then read as another agent-director store's session, which agent-director never acts on"),
    ci('one more reason no agent may run across the restore'),
  ]],
  ['step 6 › Start the other agents again', 'every other agent started again by its owner on the previous binary, its serve processes on it', [
    ci('every other agent on the host is started again by its owner on the previous binary, which also starts its `serve` processes on it'),
  ]],
  ['step 6 › Start the other agents again', 'operator action: the other agents started again (C15)', [OPERATOR_ACTION]],

  // Steps 7 to 9.
  ['step 7', 'the shared orchestrator prompt\'s §6 "hold until after" wording reverted', [ci('revert the shared orchestrator prompt\'s "hold until after" wording that switch-over step 11 put out')]],
  ['step 7', 'operator action: reverting the "hold until after" wording', [ci(`put out ${OPERATOR_ACTION}`)]],
  ['step 7', `the "kill, then leave the row" cleanup stays: it works on ${OLD_AD_VERSION} too (reconcile note)`, [
    ci('the worker cleanup switch-over step 10 changed to "kill, then leave the row" stays'),
    ci(`it works on ${OLD_AD_VERSION} too`),
  ]],
  ['step 8', `${CONFIG_FILE_NAME}${LAST_APPLIED_FILE_SUFFIX} and ${RETIRED_KEYS_FILE_NAME} moved aside`, [
    ci(`move aside ${code(`${CONFIG_FILE_NAME}${LAST_APPLIED_FILE_SUFFIX}`)} and ${code(RETIRED_KEYS_FILE_NAME)}`),
  ]],
  ['step 8', 'the previous CSCB reinstalled: the version switch-over step 1 recorded, or else the version the host ran before (hatch A3)', [
    ci('reinstall the previous CSCB, the version switch-over step 1 recorded, or else the version the host ran before'),
    'bun install -g claude-slack-channel-bots@<the previous version>',
  ]],
  ['step 8', "switch-over step 1's files put back: the pre-persona config.json, crontable, /interject callers, access.json and the Slack token environment variables (SRJ-1516)", [
    ci('put back what switch-over step 1 saved'),
    ci(`the pre-persona ${code(CONFIG_FILE_NAME)}, the crontable, the \`/interject\` callers`),
    ci("the host crontab's `curl` lines included"),
    code('access.json'),
    ci('the Slack token environment variables'),
  ]],
  ['step 8', "a file whose switch-over step 1 copy is missing is rebuilt by hand from the persona configuration, reversing the manual conversion (hatch A3)", [
    ci("where switch-over step 1's copy of a file is missing, the operator rebuilds the pre-persona file by hand from the persona configuration"),
    ci('reversing the manual conversion'),
  ]],
  ['step 8', 'no tooling for the rebuild: none ships in either direction (hatch A3)', [
    ci('no tooling does this'),
    ci('ships no conversion tooling in either direction'),
  ]],
  ['step 9', "the previous CSCB started, then the host's autostart for CSCB re-enabled, recorded", [
    ci("start the previous CSCB, then re-enable the host's autostart for CSCB"),
    'claude-slack-channel-bots start',
    ci('record it in the switch-over log'),
  ]],
  ['step 9', "operator action: re-enabling the host's autostart for CSCB", [ci(`autostart for CSCB ${OPERATOR_ACTION}`)]],
]

/** The steps that send a human beyond `agent-director kill`, each naming agent-director's "Operator actions" by title (SRJ-1109). */
const OPERATOR_ACTIONS_STEPS: readonly number[] = [3, 4, 5]

/**
 * What in a rollback step-8 text names a tool or command for the rebuild by
 * hand (hatch A3): a fenced block other than the previous CSCB's reinstall, a
 * code span naming a script or a CSCB subcommand, a link to a file, or
 * conversion wording tied to a tool, script or command. A link to a heading
 * of `README.md` is the CHANGELOG copy's form of the README's same-file link
 * (b.jg5 SRJ-1107), not a file. Takes the flattened step text. Pure; `[]`
 * when none.
 */
function conversionToolsIn(stepText: string): string[] {
  const REINSTALL = /^bun install -g claude-slack-channel-bots@<[^>]+>$/
  const blocks = [...stepText.matchAll(/```\w*\s(.*?)\s?```/g)].map((m) => m[1].trim())
  const prose = stepText.replace(/```\w*\s.*?\s?```/g, ' ')
  return [
    ...blocks.filter((body) => !REINSTALL.test(body)).map((body) => `fenced block: ${body}`),
    ...[...prose.matchAll(/`[^`]*(?:\.(?:sh|ts|js|py)\b|claude-slack-channel-bots\s+\w)[^`]*`/g)].map((m) => `code span: ${m[0]}`),
    ...markdownLinks(prose)
      .filter((link) => link.path !== '' && !(link.path === 'README.md' && link.anchor !== ''))
      .map((link) => `link to a file: ${link.target}`),
    ...[...prose.matchAll(/\b(?:conver\w*|migrat\w*)\b[^.]*\b(?:tool|script|command|subcommand)s?\b|\b(?:tool|script|command|subcommand)s?\b[^.]*\bconver\w*/gi)].map((m) => `wording: ${m[0]}`),
  ]
}

/** The README heading `anchor` resolves to, as GitHub assigns anchors; undefined when none does. */
function headingAt(readme: string, anchor: string): Heading | undefined {
  const index = headingAnchors(readme).indexOf(anchor)
  return index < 0 ? undefined : headings(readme)[index]
}

/** The inline links in `text`, each with its link text and its target split as `markdownLinks` splits it. */
function linksWithText(text: string): { text: string; path: string; anchor: string; target: string }[] {
  return [...text.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)].map(([, linkText, target]) => ({ text: linkText, ...markdownLinks(`](${target})`)[0] }))
}

/**
 * What is wrong with the rollback section's heading (b.jg5 SRJ-1109): exactly
 * one heading carries `ROLLBACK_RUNBOOK_SECTION_TITLE`, at `###`, inside
 * `## Migration`, after the switch-over section ends. Pure; `[]` when all holds.
 */
function rollbackTitleProblems(readme: string): string[] {
  const titled = headings(readme).filter((h) => h.title === ROLLBACK_RUNBOOK_SECTION_TITLE)
  if (titled.length !== 1) return [`${titled.length} README headings are titled "${ROLLBACK_RUNBOOK_SECTION_TITLE}", expected 1`]
  const [heading] = titled
  const problems: string[] = []
  if (heading.text !== ROLLBACK_HEADING) problems.push(`"${heading.text}" is not "${ROLLBACK_HEADING}"`)
  const migration = sectionRange(readme, MIGRATION_HEADING)
  if (migration === undefined || heading.line <= migration.start || heading.line >= migration.end) {
    problems.push(`"${heading.text}" is not under "${MIGRATION_HEADING}"`)
  }
  const switchOver = sectionRange(readme, SWITCH_OVER_HEADING)
  if (switchOver === undefined || heading.line < switchOver.end) problems.push(`"${heading.text}" is not after "${SWITCH_OVER_HEADING}"`)
  return problems
}

/**
 * Ruling C-2 (hatch A3): the switch-over runbook's pointers to the rollback
 * runbook are links that resolve. Each pointer phrase, wherever it is
 * written, must be the text of a link resolving to its target: the frame's
 * "rolled back together, by "<title>"" and the refusal block's
 * "follow "<title>"" to the rollback heading, and the refusal block's
 * "step 8 of "<title>"" to rollback step 8; each must be written at least
 * once. The refusal block also links rollback step 4, whose restart it names.
 * Pure; `[]` when all holds.
 */
function rollbackPointerProblems(readme: string): string[] {
  const rollback = sectionRange(readme, ROLLBACK_HEADING)
  if (rollback === undefined) return [`README.md has no heading "${ROLLBACK_HEADING}"`]
  const switchOver = requiredSection(readme, SWITCH_OVER_HEADING, 'README.md')
  const lines = switchOver.split('\n')
  const first = headings(switchOver)[0]
  const frame = flat(lines.slice(0, first === undefined ? lines.length : first.line).join('\n'))
  const block = flat(requiredSection(switchOver, `#### ${REFUSAL_BLOCK_HEADING}`, `README.md, under "${SWITCH_OVER_HEADING}",`))
  const isSection = (h: Heading) => h.text === ROLLBACK_HEADING
  const isStep = (n: number) => (h: Heading) => h.line > rollback.start && h.line < rollback.end && h.level === 4 && stepNumberOf(h.title) === n
  const title = escapeRegExp(`"${ROLLBACK_RUNBOOK_SECTION_TITLE}"`)
  const pointers: [where: string, text: string, phrase: RegExp, target: string, resolves: (h: Heading) => boolean][] = [
    ['the switch-over frame', frame, new RegExp(`rolled back together, by ${title}`, 'gi'), 'the rollback section', isSection],
    [`"${REFUSAL_BLOCK_HEADING}"`, block, new RegExp(`follow ${title}`, 'gi'), 'the rollback section', isSection],
    [`"${REFUSAL_BLOCK_HEADING}"`, block, new RegExp(`step 8 of ${title}`, 'gi'), 'rollback step 8', isStep(8)],
  ]
  const problems: string[] = []
  for (const [where, text, phrase, target, resolves] of pointers) {
    const written = [...text.matchAll(phrase)].length
    const linked = linksWithText(text)
      .filter((link) => link.path === '')
      .filter((link) => {
        const h = headingAt(readme, link.anchor)
        return h !== undefined && resolves(h)
      })
      .reduce((n, link) => n + [...link.text.matchAll(phrase)].length, 0)
    if (written === 0) problems.push(`${where} never writes ${String(phrase)}`)
    else if (linked !== written) problems.push(`${where}: ${written - linked} of ${written} pointers ${String(phrase)} are not links resolving to ${target}`)
  }
  const step4 = linksWithText(block).filter((link) => {
    const h = link.path === '' ? headingAt(readme, link.anchor) : undefined
    return h !== undefined && isStep(4)(h)
  })
  if (step4.length === 0) problems.push(`"${REFUSAL_BLOCK_HEADING}" has no link resolving to rollback step 4`)
  return problems
}

describe(`the rollback runbook, "${ROLLBACK_RUNBOOK_SECTION_TITLE}" (b.jg5 SRJ-1109)`, () => {
  const readme = operatorText('README.md')

  test('exactly one README heading carries the rollback title, a `###` under `## Migration`, after the switch-over section', () => {
    expect(rollbackTitleProblems(readme)).toEqual([])
  })

  test.each([
    ['re-levelled', (text: string) => text.replace(`${ROLLBACK_HEADING}\n`, `#${ROLLBACK_HEADING}\n`), 'is not "'],
    ['duplicated', (text: string) => `${text}\n${ROLLBACK_HEADING}\n`, '2 README headings'],
    ['placed before the switch-over section', (text: string) => text.replace(`${ROLLBACK_HEADING}\n`, '').replace(`${SWITCH_OVER_HEADING}\n`, `${ROLLBACK_HEADING}\n\n${SWITCH_OVER_HEADING}\n`), 'is not after'],
  ])('self-check: with the rollback heading %s, the title case fails', (_how, edit, problem) => {
    const edited = edit(readme)
    expect(edited).not.toBe(readme)
    expect(rollbackTitleProblems(edited).join('\n')).toContain(problem)
  })

  test.each(ROLLBACK_CARRIERS)(`%s: the section reads as steps 1 to ${ROLLBACK_STEP_COUNT}, in order, one heading level below it`, (_name, read) => {
    expect(read().steps).toHaveLength(ROLLBACK_STEP_COUNT)
  })

  describe('the step reader on the rollback section (self-checks, on edited README text)', () => {
    const start = readme.indexOf(`${ROLLBACK_HEADING}\n`)
    /** The README with `edit` applied to the rollback section and what follows it only. */
    const inRollback = (edit: (rest: string) => string) => readme.slice(0, start) + edit(readme.slice(start))
    const step = (n: number) => `#### ${stepHeadingPrefix(n)}`
    test.each([
      ['missing', inRollback((rest) => rest.replace(step(7), '#### Then: ')), 'step 7 is missing'],
      ['duplicated', inRollback((rest) => rest.replace(step(8), step(7))), 'step 7 appears 2 times'],
      ['out of order', inRollback((rest) => rest.replace(step(7), '#### SWAP: ').replace(step(8), step(7)).replace('#### SWAP: ', step(8))), 'step 8 is out of order'],
      ['beyond the count', inRollback((rest) => rest.replace(step(9), `${step(10)}Extra\n\n${step(9)}`)), 'step 10 is beyond the expected 9 steps'],
    ])('a rollback step %s fails naming the rollback section and the step', (_how, text, message) => {
      expect(start).toBeGreaterThan(0)
      expect(() => readRunbookCarrier('README.md', text, ROLLBACK_HEADING, ROLLBACK_STEP_COUNT)).toThrow(`README.md "${ROLLBACK_HEADING}": ${message}`)
    })
  })

  test.each(overRollbackCarriers(ROLLBACK_ELEMENTS))('%s, rollback %s: %s', (carrierName, where, element, required, read) => {
    const carrier = read()
    expect({ carrier: carrierName, runbook: 'rollback', where, element, missing: missingItems(carrier, textAt(carrier, where), required) }).toEqual({
      carrier: carrierName,
      runbook: 'rollback',
      where,
      element,
      missing: [],
    })
  })

  describe('order rows', () => {
    const ORDERS: [step: number, label: string, order: RegExp[]][] = [
      [6, "step 6 stops every other agent and confirms it, then restores with the recipe, then starts the agents again on the previous binary", [
        ci('stop every other agent on the host'),
        ci("shows each stopped agent's row"),
        ci('restore the previous agent-director'),
        ci(vocab('downgradeRecipe')),
        ci('started again by its owner on the previous binary'),
      ]],
      [8, 'step 8 moves the last-applied record and the retired keys aside, then reinstalls the previous CSCB, then puts back the saved files', [
        ci('move aside'),
        ci('reinstall the previous CSCB'),
        ci('bun install -g claude-slack-channel-bots@'),
        ci('put back what switch-over step 1 saved'),
      ]],
      [9, "step 9 starts the previous CSCB, then re-enables the host's autostart for CSCB", [ci('start the previous CSCB'), ci("re-enable the host's autostart for CSCB")]],
    ]

    test.each(overRollbackCarriers(ORDERS))('%s, step %d: %s, in that order', (_name, n, _label, order, read) => {
      const text = read().steps[n - 1]
      const at = order.map((pattern) => text.search(pattern))
      expect(order.filter((_, i) => at[i] < 0).map(String)).toEqual([])
      expect(at).toEqual([...at].sort((a, b) => a - b))
    })
  })

  describe('cross-step rows', () => {
    // No `tmux kill-session`, include-finished, include_finished or
    // agent-director delete in the section: E36 T4's whole-file cases
    // (`killSessionsOutsideSteps`, `SRJ_1101_TERMS`) check every carrier file.

    test.each(overRollbackCarriers(OPERATOR_ACTIONS_STEPS.map((n) => [n] as const)))(
      `%s: step %d, which sends a human beyond \`agent-director kill\`, names ${vocab('operatorActions')} by title`,
      (_name, n, read) => {
        expect(read().steps[n - 1]).toContain(vocab('operatorActions'))
      },
    )

    test.each(overRollbackCarriers(UPGRADE_FORMS.map(([label, pattern]) => [label, pattern] as const)))(
      "%s: step 6's restore item carries no %s: the recipe is agent-director's, named, never spelled out",
      (_name, _label, pattern, read) => {
        expect(textAt(read(), 'step 6 › Restore the previous agent-director')).not.toMatch(pattern)
      },
    )

    test.each(ROLLBACK_CARRIERS)('%s: step 8 names no conversion tool or command for the rebuild by hand (hatch A3)', (_name, read) => {
      expect(conversionToolsIn(read().steps[7])).toEqual([])
    })

    test.each([
      ['a CSCB subcommand', 'Rebuild it with `claude-slack-channel-bots unpersona`.', 'code span'],
      ['a script', 'Run `scripts/unpersona.sh` on the file.', 'code span'],
      ['a fenced command', 'Rebuild it: ```sh cscb-convert config.json ```', 'fenced block'],
      ['a link to a file', 'See [the helper](tools/rebuild.ts).', 'link to a file'],
      ['conversion wording tied to a tool', 'Run the conversion tool on the persona configuration.', 'wording'],
    ])('self-check (hatch A3): a step 8 naming %s is flagged', (_label, text, kind) => {
      expect(conversionToolsIn(flat(`Reinstall: \`\`\`sh bun install -g claude-slack-channel-bots@<v> \`\`\` ${text}`)).map((found) => found.split(':')[0])).toEqual([kind])
    })

    test.each([
      ['a same-file heading link', '(see [Upgrading to personas](#upgrading-to-personas))', []],
      ["a README heading link, the CHANGELOG copy's form of it (SRJ-1107)", '(see [Upgrading to personas](README.md#upgrading-to-personas))', []],
      ['a link to the README file itself', '(see [the README](README.md))', ['link to a file']],
    ] as const)('self-check (hatch A3): a step 8 with %s', (_label, text, kinds) => {
      expect(conversionToolsIn(flat(`Rebuild it by hand ${text}.`)).map((found) => found.split(':')[0])).toEqual([...kinds])
    })
  })

  describe('README.md: ruling C-2 and the runbooks\' links', () => {
    test("the switch-over runbook's pointers to the rollback runbook and its step 8 are links that resolve (ruling C-2; hatch A3)", () => {
      expect(rollbackPointerProblems(readme)).toEqual([])
    })

    test.each([
      ['rollback step 8 renamed', (text: string) => text.replace(`#### ${stepHeadingPrefix(8)}Reinstall`, `#### ${stepHeadingPrefix(8)}Put back`), 'rollback step 8'],
      ['a step 8 pointer unlinked', (text: string) => text.replace(/\[(step 8 of "[^"]+")\]\(#[^)]+\)/, '$1'), '1 of 2 pointers'],
      ['the frame pointer unlinked', (text: string) => text.replace(/\[(rolled back together, by "[^"]+")\]\(#[^)]+\)/, '$1'), 'the switch-over frame'],
    ])('self-check (ruling C-2): with %s, the pointer case fails', (_how, edit, problem) => {
      const edited = edit(readme)
      expect(edited).not.toBe(readme)
      expect(rollbackPointerProblems(edited).join('\n')).toContain(problem)
    })

    test.each([SWITCH_OVER_HEADING, ROLLBACK_HEADING])('every same-file link in "%s" resolves to a README heading', (heading) => {
      const section = requiredSection(readme, heading, 'README.md')
      const anchors = headingAnchors(readme)
      const links = linksWithText(section).filter((link) => link.path === '')
      expect(links.length).toBeGreaterThan(0)
      expect(links.filter((link) => !anchors.includes(link.anchor)).map((link) => link.target)).toEqual([])
    })

    test('each "switch-over step <n>" link in the rollback section resolves to that step of the switch-over section', () => {
      const switchOver = sectionRange(readme, SWITCH_OVER_HEADING)
      if (switchOver === undefined) throw new Error(`README.md has no heading "${SWITCH_OVER_HEADING}"`)
      const links = linksWithText(requiredSection(readme, ROLLBACK_HEADING, 'README.md')).filter((link) => link.path === '' && /^switch-over step \d+$/i.test(link.text))
      expect(links.length).toBeGreaterThan(0)
      const wrong = links.filter((link) => {
        const h = headingAt(readme, link.anchor)
        return h === undefined || h.line <= switchOver.start || h.line >= switchOver.end || stepNumberOf(h.title) !== Number(/\d+$/.exec(link.text)![0])
      })
      expect(wrong.map((link) => `[${link.text}](${link.target})`)).toEqual([])
    })

    test('docs/registry-install-runbook.md links both runbook sections, and the links resolve', () => {
      const anchors = markdownLinks(readRepoFile('docs/registry-install-runbook.md'))
        .filter((link) => link.path === '../README.md')
        .map((link) => link.anchor)
      for (const heading of [SWITCH_OVER_HEADING, ROLLBACK_HEADING]) {
        const anchor = headingSlug(heading.slice('### '.length))
        expect(anchors).toContain(anchor)
        expect(headingAt(readme, anchor)?.text).toBe(heading)
      }
    })
  })
})

/**
 * Paths that exist on one host only, which neither runbook names in either
 * carrier, nor the README's Migration section (b.3ut): the steps name the
 * host's sweep schedule and the shared orchestrator prompt generically
 * instead. Read over those sections only: elsewhere the README quotes a
 * server log line naming the sweep script, and `horde_admin` is an example
 * persona name.
 */
const HOST_SPECIFIC_PATHS = ['find-missing-loop.sh', '~/startup/', 'horde_admin/cscb_system_prompt.md', '~/.claude/channels/slack/system-prompt.md'] as const

/** The `HOST_SPECIFIC_PATHS` a text names. Pure. */
const hostPathsIn = (section: string) => HOST_SPECIFIC_PATHS.filter((path) => section.includes(path))

/** Each runbook section in each carrier, by name: the switch-over's, then the rollback's. */
const RUNBOOK_SECTIONS: [name: string, read: () => string][] = [
  ...SWITCH_OVER_CARRIERS.map(([name, read]): [string, () => string] => [`${name}, switch-over`, () => read().section]),
  ...ROLLBACK_CARRIERS.map(([name, read]): [string, () => string] => [`${name}, rollback`, () => read().section]),
]

describe('the runbooks name no host-specific path (b.3ut)', () => {
  test.each([
    ...RUNBOOK_SECTIONS,
    [`README.md "${MIGRATION_HEADING}" (to the next \`##\`, both runbooks included)`, () => requiredSection(operatorText('README.md'), MIGRATION_HEADING, 'README.md')],
  ] satisfies [string, () => string][])(`%s: the text, its headings included, names none of ${HOST_SPECIFIC_PATHS.join(', ')}`, (_name, read) => {
    expect(hostPathsIn(read())).toEqual([])
  })

  test.each(RUNBOOK_SECTIONS)('%s: the section never calls the shared orchestrator prompt the "orchestrator system prompt"', (_name, read) => {
    expect(flat(read())).not.toMatch(ci('orchestrator system prompt'))
  })

  test('self-check: the README with the host-specific wording put back in steps 10 and 11 and rollback steps 2 and 4 is reported in both runbooks', () => {
    const edited = operatorText('README.md')
      .replace(', and in its source copy if you keep one,', ', `~/.claude/channels/slack/system-prompt.md`, and its source copy, `~/projects/horde_admin/cscb_system_prompt.md`,')
      .replace("Add it to the host's sweep schedule, the one", "Add it to the host's sweep loop, `~/startup/find-missing-loop.sh`, the script")
      .replace("added to the host's sweep schedule, the cron entry, systemd timer or loop script that runs it", "added to the host's sweep loop, `~/startup/find-missing-loop.sh`")
      .replace("restore step 2's daily `expire` to the host's sweep schedule", "restore step 2's daily `expire` in `~/startup/find-missing-loop.sh`")
    const switchOver = readRunbookCarrier('README.md', edited, SWITCH_OVER_HEADING, SWITCH_OVER_STEP_COUNT)
    const rollback = readRunbookCarrier('README.md', edited, ROLLBACK_HEADING, ROLLBACK_STEP_COUNT)
    expect({ switchOver: hostPathsIn(switchOver.section), rollback: hostPathsIn(rollback.section) }).toEqual({
      switchOver: [...HOST_SPECIFIC_PATHS],
      rollback: ['find-missing-loop.sh', '~/startup/'],
    })
    expect(hostPathsIn(textAt(rollback, 'step 2'))).toEqual(['find-missing-loop.sh', '~/startup/'])
    expect(hostPathsIn(textAt(rollback, 'step 4'))).toEqual(['find-missing-loop.sh', '~/startup/'])
  })
})

// ---------------------------------------------------------------------------
// The CHANGELOG release entry (b.jg5 SRJ-1107; hatch A3), read through OPERATOR_TEXTS
// ---------------------------------------------------------------------------

/**
 * The release that introduced the switch-over and rollback runbooks (b.jg5
 * SRJ-1107). Its CHANGELOG entry, the release entry, carries the two runbook
 * copies and the release notes SRJ-1107 checks. A later runbook change is
 * made in that copy in place, and the file's first, unreleased entry says
 * what changed (the doc-writing guide's "Release notes (CHANGELOG.md)").
 */
const RUNBOOK_RELEASE_VERSION = '0.11.0'

/** A published release's `##` heading title: its version, then its publish date (`0.11.0 (2026-10-06)`). */
function publishedTitle(version: string): RegExp {
  return new RegExp(`^${escapeRegExp(version)} \\(\\d{4}-\\d{2}-\\d{2}\\)$`)
}

/**
 * The 0-based line range `[start, end)` of the CHANGELOG's release entry,
 * found by its version, never by its place in the file: the one `##` section
 * titled `RUNBOOK_RELEASE_VERSION` and its publish date. Throws unless
 * exactly one `##` heading is.
 */
function releaseEntryRange(changelog: string): { start: number; end: number } {
  const title = publishedTitle(RUNBOOK_RELEASE_VERSION)
  const found = headings(changelog).filter((h) => h.level === 2 && title.test(h.title))
  if (found.length !== 1) {
    throw new Error(`${CHANGELOG_FILE} has ${found.length} \`##\` entries titled ${RUNBOOK_RELEASE_VERSION} and its publish date, expected 1`)
  }
  return sectionRange(changelog, found[0].text)!
}

/** The CHANGELOG's release entry (`releaseEntryRange`): its body, heading line excluded. */
function releaseEntry(changelog: string): string {
  const { start, end } = releaseEntryRange(changelog)
  return changelog.split('\n').slice(start + 1, end).join('\n')
}

/** The release entry's notes: the entry without its two runbook copies, so a note is never found in a runbook's words. */
function releaseNotes(changelog: string): string {
  const entry = releaseEntry(changelog)
  const ranges = [SWITCH_OVER_HEADING, ROLLBACK_HEADING].flatMap((heading) => sectionRange(entry, heading) ?? [])
  return entry
    .split('\n')
    .filter((_, i) => !ranges.some((range) => i >= range.start && i < range.end))
    .join('\n')
}

/** `text` with each inline link replaced by its link text. */
function linkTexts(text: string): string {
  return text.replace(/\[([^\]]*)\]\([^)\s]+\)/g, '$1')
}

/**
 * `text`'s units, flattened: each heading, list item (with its continuation
 * lines) and paragraph. A unit that ends with a colon is read together with
 * the one it introduces (a list item or a fenced command), so an instruction
 * and its command are one unit. Pure.
 */
function textUnits(text: string): string[] {
  const units: string[][] = []
  let open = false
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      open = false
      continue
    }
    const heading = /^#{1,6}\s/.test(line)
    if (!open || heading || /^\s*(?:[-*]|\d+\.)\s/.test(line)) units.push([line])
    else units[units.length - 1].push(line)
    open = !heading
  }
  return units
    .map((lines) => flat(lines.join('\n')).trim())
    .reduce<string[]>((out, unit) => {
      if (out.length > 0 && out[out.length - 1].endsWith(':')) out[out.length - 1] += ` ${unit}`
      else out.push(unit)
      return out
    }, [])
}

/** Each of `required` that `text` lacks, as a problem line. */
function lacking(text: string, required: readonly (string | RegExp)[]): string[] {
  return required.filter((item) => (typeof item === 'string' ? !text.includes(item) : !item.test(text))).map((item) => `lacks ${String(item)}`)
}

/** `check`'s problems on the one release-note unit matching `anchor`, or a problem naming the anchor unless exactly one unit does. */
function noteUnitProblems(changelog: string, anchor: RegExp, check: (unit: string) => string[]): string[] {
  const units = textUnits(releaseNotes(changelog)).filter((unit) => anchor.test(unit))
  if (units.length !== 1) return [`${units.length} release-note units match ${String(anchor)}, expected 1`]
  return check(units[0])
}

/** The heading title of b.ob2's dropped section (SRJ-1107: replaced by the switch-over runbook). */
const UPGRADE_STEPS_TITLE = 'Upgrade steps'

/** Each heading titled `UPGRADE_STEPS_TITLE` in `text`, and each link to its anchor. Pure. */
function upgradeStepsProblems(text: string): string[] {
  return [
    ...headings(text).filter((h) => h.title.toLowerCase() === UPGRADE_STEPS_TITLE.toLowerCase()).map((h) => `heading "${h.text}"`),
    ...markdownLinks(text).filter((link) => link.anchor === headingSlug(UPGRADE_STEPS_TITLE)).map((link) => `link (${link.target})`),
  ]
}

/** b.ob2's wording for the prompt-open relaunch, which SRJ-1107 replaces with a check through agent-director. */
const TMUX_FIRST = ci('checks its tmux session first')

/** Each "checks its tmux session first" in `text`, flattened. Pure. */
function tmuxFirstProblems(text: string): string[] {
  return [...flat(text).matchAll(new RegExp(TMUX_FIRST.source, 'gi'))].map((m) => m[0])
}

/** A word that tells the reader to delete a file. */
const DELETE_WORDS = /\b(?:delet\w*|remov\w*|rm|eras\w*|discard\w*)\b/i

/** SRJ-1107's breaking note, one row per part, each found in the release notes' text with links read as their text. */
const BREAKING_NOTE: [part: string, pattern: RegExp][] = [
  ['this release requires agent-director Phase 1 or later', ci('requires agent-director Phase 1 or later')],
  ['it exits at startup on an older binary', ci('exits at startup on an older agent-director binary')],
  ['no older CSCB may run on the Phase 1 binary', ci('no older CSCB may run on the Phase 1 binary')],
  ['the two are installed, and rolled back, together', /\binstalled together\b[^.]*\brolled back together\b/i],
  ['every agent and long-running agent-director process is stopped before either binary change and started again after it (HO C15; ADA question 9)', ci(
    'every agent on the host, with every long-running agent-director process, is stopped before either binary change and started again after it',
  )],
]

/** An agent-director version named in prose ("agent-director <version>"), its version captured; a sentence's closing full stop is not taken. */
const AD_NAMED_VERSION = /\bagent-director v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)/g

/** The release entry's row-deletion note: the one note naming agent-director's admin binary. */
const ROW_DELETION_ELEMENT = 'the row-deletion note names `agent-director-admin`, and the agent-director version it names is the Phase 1 floor'

/**
 * One row per SRJ-1107 element of the release entry: its name and its check,
 * which returns the CHANGELOG text's problems (`[]` when the element holds).
 * Each check is self-checked below on the CHANGELOG with that element reverted
 * to b.ob2's wording, or, for an element b.ob2 lacked, broken.
 */
const RELEASE_ENTRY_CHECKS: [element: string, problems: (changelog: string) => string[]][] = [
  ['exactly one unreleased entry, the first `##` entry in the file', (changelog) => {
    const entries = headings(changelog).filter((h) => h.level === 2)
    const unreleased = entries.filter((h) => /\bunreleased\b/i.test(h.title))
    return [
      ...(unreleased.length === 1 ? [] : [`${unreleased.length} unreleased \`##\` entries, expected 1`]),
      ...(entries.length > 0 && unreleased.includes(entries[0]) ? [] : [`the first \`##\` entry, "${entries[0]?.text}", is not an unreleased one`]),
    ]
  }],
  ...BREAKING_NOTE.map(([part, pattern]): [string, (changelog: string) => string[]] => [
    `the breaking note: ${part}`,
    (changelog) => lacking(flat(linkTexts(releaseNotes(changelog))), [pattern]),
  ]),
  ['`access.json` is kept until rollback is no longer wanted, because the previous CSCB reads it', (changelog) =>
    lacking(flat(releaseNotes(changelog)), [ci('keep `access.json` until rollback is no longer wanted, because the previous CSCB reads it')])],
  ['nothing in the file tells the reader to delete `access.json`', (changelog) =>
    textUnits(changelog).filter((unit) => /\baccess\.json\b/.test(unit) && DELETE_WORDS.test(unit)).map((unit) => `a delete instruction: ${unit}`)],
  ['the prompt-open relaunch note says the server checks the session through agent-director', (changelog) =>
    noteUnitProblems(changelog, ci('prompt or question open'), (unit) => lacking(unit, [ci('checks the session through agent-director')]))],
  [`the note "The server's own tmux commands act only on a bot's own session" is gone (E17, E18)`, (changelog) =>
    [...flat(changelog).matchAll(/the server's own tmux commands/gi)].map((m) => `the dropped note is back: ${m[0]}`)],
  [`the prefix-key note's reason is SRJ-1102's sentence and does not name agent-director ${OLD_AD_VERSION} (SRJ-1102)`, (changelog) =>
    noteUnitProblems(changelog, ci("may start with another persona's key"), (unit) => [
      // DOCS_PREFIX_KEY_REASON: from the loader's builder, with SRJ-1102's other checks below.
      ...lacking(unit, [DOCS_PREFIX_KEY_REASON]),
      ...(unit.includes(OLD_AD_VERSION) ? [`names ${OLD_AD_VERSION}: ${unit}`] : []),
    ])],
  ['the fresh-once note stays, its rows kept and never resumed, pointing to the switch-over runbook', (changelog) =>
    noteUnitProblems(changelog, ci('starts fresh once'), (unit) => [
      ...lacking(unit, [/\brows? (?:are|is) kept\b/i, ci('never resumed')]),
      ...(linksWithText(unit).some((link) => link.anchor === headingSlug(PHASE1_RUNBOOK_SECTION_TITLE) && (link.path === '' || link.path === 'README.md'))
        ? []
        : [`no link to "${PHASE1_RUNBOOK_SECTION_TITLE}"`]),
    ])],
  [ROW_DELETION_ELEMENT, (changelog) =>
    noteUnitProblems(changelog, ci(code('agent-director-admin')), (unit) => {
      const versions = [...unit.matchAll(AD_NAMED_VERSION)].map((m) => m[1])
      return [
        ...(versions.length > 0 ? [] : ['names no agent-director version']),
        ...versions.filter((v) => v !== PHASE1_FLOOR_VERSION).map((v) => `names agent-director ${v}, not the Phase 1 floor ${PHASE1_FLOOR_VERSION}`),
      ]
    })],
]

/** One release-entry check by its element; throws naming an element the table lacks. */
function releaseCheck(element: string): (changelog: string) => string[] {
  const row = RELEASE_ENTRY_CHECKS.find(([name]) => name === element)
  if (row === undefined) throw new Error(`RELEASE_ENTRY_CHECKS has no element "${element}"`)
  return row[1]
}

/**
 * The names the hatch-note entries introduce (the Task's ruling: only these
 * are pinned, each through the `src/` export that defines it, no sentence
 * pinned), with the Epic and source of each.
 */
const HATCH_NOTE_NAMES: [name: string, source: string][] = [
  [CLEAR_LATCH_COMMAND, 'E31: src/clear-latch.ts CLEAR_LATCH_COMMAND (SRJ-509)'],
  [SERVER_PORT_FILE_NAME, 'E31: src/clear-latch.ts SERVER_PORT_FILE_NAME (SRJ-510)'],
  [CLI_TEARDOWN_FAILED_LABEL, 'E33: src/cli-teardown.ts CLI_TEARDOWN_FAILED_LABEL (SRJ-909, SRJ-1013)'],
  [PERSONA_KILL_FAILED_LABEL, 'E33: src/kill-failure-alert.ts PERSONA_KILL_FAILED_LABEL (SRJ-1013)'],
  [PERSONA_KILL_SURVIVOR_LABEL, 'E33: src/kill-failure-alert.ts PERSONA_KILL_SURVIVOR_LABEL (SRJ-1013)'],
  [CLEAN_RESTART_NOT_RESTARTED_LABEL, 'E33: src/cli-teardown.ts CLEAN_RESTART_NOT_RESTARTED_LABEL (SRJ-906, SRJ-1013)'],
  ...startSummaryCountLabels().map((label): [string, string] => [label, 'E26: src/session-manager.ts startupSummaryEnding (SRJ-1015)']),
  [UNAVAILABLE_RETRY_CAUSE_COLLISION, "E36 T1: src/unavailable-retry.ts UNAVAILABLE_RETRY_CAUSE_COLLISION (the retry cause's rename, reconcile ruling)"],
  [lostMessageStateLabel('auto-restart-disabled'), "E8, E36 T4: src/lost-message.ts STATE_WORDING['auto-restart-disabled'] (SRJ-1011)"],
]

/**
 * The start summary's five counts SRJ-1015 added, as src/session-manager.ts's
 * `startupSummaryEnding` writes them: each count given its own number, then
 * its label read after that number. Throws naming a count it can't find.
 */
function startSummaryCountLabels(): string[] {
  const numbered = { failed: 1, notBroughtUp: 2, notReconnected: 3, latched: 4, retrying: 5, sequenceWaiting: 6, held: 7, freshRetired: 8 }
  const parts = startupSummaryEnding(numbered).split(', ')
  return (['latched', 'retrying', 'sequenceWaiting', 'held', 'freshRetired'] as const).map((key) => {
    const part = parts.find((p) => p.startsWith(`${numbered[key]} `))
    if (part === undefined) throw new Error(`startupSummaryEnding wrote no "${numbered[key]} …" part for ${key}`)
    return part.slice(`${numbered[key]} `.length)
  })
}

/** Every link from `text` (the repository file `file`) that resolves nowhere: a same-file anchor `text` lacks, or a file (relative to `file`'s directory) or its heading that does not exist. */
function brokenRepoLinks(file: string, text: string): { checked: number; broken: string[] } {
  const own = headingAnchors(text)
  const links = markdownLinks(text).filter((link) => !/^[a-z][a-z0-9+.-]*:/i.test(link.path))
  const broken = links.flatMap((link) => {
    if (link.path === '') return own.includes(link.anchor) ? [] : [`${file} -> ${link.target} (no such heading in ${file})`]
    const target = resolve(REPO_ROOT, dirname(file), link.path)
    if (!existsSync(target)) return [`${file} -> ${link.target} (no such file)`]
    if (link.anchor === '') return []
    return headingAnchors(readFileSync(target, 'utf-8')).includes(link.anchor) ? [] : [`${file} -> ${link.target} (no such heading in ${link.path})`]
  })
  return { checked: links.length, broken }
}

/** Each part of a runbook section (its text before the first subsection, then each subsection by heading), flattened, for a word-for-word comparison. */
function sectionChunks(section: string): { heading: string; text: string }[] {
  const lines = section.split('\n')
  const hs = headings(section)
  return [-1, ...hs.map((h) => h.line)].map((start, k) => ({
    heading: k === 0 ? '(before the first subsection)' : hs[k - 1].text,
    text: flat(lines.slice(start + 1, k < hs.length ? hs[k].line : lines.length).join('\n')).trim(),
  }))
}

/** The line of a CHANGELOG runbook copy that names the README section as the maintained copy. */
const MAINTAINED_COPY = ci('is the maintained copy of this runbook')

/** A CHANGELOG runbook copy as the README writes it: its maintained-copy line dropped, and each `README.md#` link read as a same-file link. */
function asReadmeText(section: string): string {
  return section
    .split('\n')
    .filter((line) => !MAINTAINED_COPY.test(line))
    .join('\n')
    .replaceAll('](README.md#', '](#')
}

/** The two runbooks the release entry copies: each section's title and heading. */
const RUNBOOK_COPIES: [title: string, heading: string][] = [
  [PHASE1_RUNBOOK_SECTION_TITLE, SWITCH_OVER_HEADING],
  [ROLLBACK_RUNBOOK_SECTION_TITLE, ROLLBACK_HEADING],
]

describe('the CHANGELOG release entry, read through OPERATOR_TEXTS (b.jg5 SRJ-1107; SRJ-1101 list)', () => {
  const changelog = () => operatorText(CHANGELOG_FILE)

  describe('OPERATOR_TEXTS', () => {
    test("holds exactly SRJ-1101's seven operator texts, each read from the repository", () => {
      expect(OPERATOR_TEXTS.map(([name]) => name)).toEqual([
        'README.md',
        'skills/debug-slack-channel-bots/SKILL.md',
        'skills/install-cscb/SKILL.md',
        'skills/setup-slack-channel-bots/SKILL.md',
        'docs/architecture.md',
        'docs/engineering-guide.md',
        'CHANGELOG.md',
      ])
      expect(OPERATOR_TEXTS.filter(([, read]) => read().trim() === '').map(([name]) => name)).toEqual([])
    })

    test('SHIPPED_TEXTS, which the forbidden-term audit reads, still holds neither the CHANGELOG nor any docs/ file', () => {
      expect(SHIPPED_TEXTS.map(([name]) => name).filter((name) => name === CHANGELOG_FILE || name.startsWith('docs/'))).toEqual([])
    })

    test.each(OPERATOR_TEXTS)(`%s: no heading titled "${UPGRADE_STEPS_TITLE}" and no link to its anchor (SRJ-1107)`, (_name, read) => {
      expect(upgradeStepsProblems(read())).toEqual([])
    })

    test.each(OPERATOR_TEXTS)('%s: no "checks its tmux session first" (SRJ-1107)', (_name, read) => {
      expect(tmuxFirstProblems(read())).toEqual([])
    })

    test.each([
      ['a heading', `### ${UPGRADE_STEPS_TITLE}\n\nTake these steps in order.`, upgradeStepsProblems, [`heading "### ${UPGRADE_STEPS_TITLE}"`]],
      ['a link to its anchor', `Stop the old bots (step 1 of [${UPGRADE_STEPS_TITLE}](#${headingSlug(UPGRADE_STEPS_TITLE)})).`, upgradeStepsProblems, [`link (#${headingSlug(UPGRADE_STEPS_TITLE)})`]],
      ['the relaunch wording, wrapped', 'but the server checks its tmux\nsession first and relaunches it', tmuxFirstProblems, ['checks its tmux session first']],
    ] as const)("self-check: b.ob2's %s is reported", (_label, text, problems, expected) => {
      expect(problems(text)).toEqual([...expected])
    })
  })

  describe('the release entry', () => {
    test.each(RELEASE_ENTRY_CHECKS)('%s', (element, problems) => {
      expect({ element, problems: problems(changelog()) }).toEqual({ element, problems: [] })
    })

    const breakingNote = (text: string) => text.replace(/^### Requires agent-director Phase 1\n[\s\S]*?(?=^### )/m, '')
    const REVERTS: [element: string, how: string, edit: (text: string) => string][] = [
      [RELEASE_ENTRY_CHECKS[0][0], 'an earlier release entry placed first', (text) => text.replace(/^## /m, '## 1.0.0\n\nAn earlier release.\n\n## ')],
      [RELEASE_ENTRY_CHECKS[0][0], 'a second unreleased entry', (text) => `${text}\n## Unreleased (patch)\n\nMore.\n`],
      [RELEASE_ENTRY_CHECKS[0][0], 'the unreleased entry published, none left', (text) => text.replace(/^## Unreleased\b.*$/m, '## 0.11.1 (2026-10-07)')],
      ...BREAKING_NOTE.map(([part]): [string, string, (text: string) => string] => [`the breaking note: ${part}`, "the breaking note dropped, as in b.ob2's entry", breakingNote]),
      ['`access.json` is kept until rollback is no longer wanted, because the previous CSCB reads it', 'the keep sentence dropped', (text) =>
        text.replace(/ Keep `access\.json` until rollback is no longer wanted, because the previous CSCB reads it\./, '')],
      ['nothing in the file tells the reader to delete `access.json`', "b.ob2's upgrade note back", (text) =>
        `${text}\n### Upgrade note: leftover \`access.json\`\n\nAn upgraded host keeps any existing \`access.json\` in the state directory. The server never reads it, so it is an ignored file. Delete it by hand once the personas are running:\n\n\`\`\`sh\nrm "\${SLACK_STATE_DIR:-$HOME/.claude/channels/slack}/access.json"\n\`\`\`\n`],
      ['the prompt-open relaunch note says the server checks the session through agent-director', "b.ob2's tmux-first wording", (text) =>
        text.replace('checks the session through agent-director', 'checks its tmux session first')],
      [RELEASE_ENTRY_CHECKS.find(([e]) => e.startsWith('the note "'))![0], "b.ob2's note back", (text) =>
        text.replace(/^- \*\*One stuck persona/m, "- **The server's own tmux commands act only on a bot's own session.** When the server ends a bot's leftover tmux session before a relaunch, it now names the session exactly.\n- **One stuck persona")],
      [RELEASE_ENTRY_CHECKS.find(([e]) => e.startsWith("the prefix-key note's"))![0], "b.ob2's reason", (text) =>
        text.replace(/The reason: [^\n]*?could reach another persona's session\./, `agent-director ${OLD_AD_VERSION} finds a persona's tmux session by a name that also matches the start of a longer one, so with such a pair it could read, type into or end the other persona's session.`)],
      [RELEASE_ENTRY_CHECKS.find(([e]) => e.startsWith("the prefix-key note's"))![0], 'the reason sentence dropped, no version named', (text) =>
        text.replace(/ The reason: [^\n]*?could reach another persona's session\./, '')],
      ['the fresh-once note stays, its rows kept and never resumed, pointing to the switch-over runbook', "b.ob2's pointer to the upgrade steps", (text) =>
        text.replace(/(starts fresh once\.[^\n]*?)\(see \[[^\]]*\]\([^)]*\)\)/i, `$1(step 1 of [${UPGRADE_STEPS_TITLE}](#${headingSlug(UPGRADE_STEPS_TITLE)}))`)],
      [ROW_DELETION_ELEMENT, 'another agent-director version named', (text) =>
        text.replace(`agent-director ${PHASE1_FLOOR_VERSION}, its Phase 1 release`, `agent-director ${OLD_AD_VERSION}, its Phase 1 release`)],
      [ROW_DELETION_ELEMENT, 'a release candidate of the floor named', (text) =>
        text.replace(`agent-director ${PHASE1_FLOOR_VERSION}, its Phase 1 release`, `agent-director ${PHASE1_FLOOR_VERSION}-rc.1, its Phase 1 release`)],
      [ROW_DELETION_ELEMENT, 'no version named', (text) =>
        text.replace(`agent-director ${PHASE1_FLOOR_VERSION}, its Phase 1 release`, "agent-director's Phase 1 release")],
      [ROW_DELETION_ELEMENT, '`agent-director-admin` dropped', (text) =>
        text.replace('its separate `agent-director-admin` binary', 'a separate binary')],
    ]

    test.each(REVERTS)('self-check: "%s" fails with %s', (element, _how, edit) => {
      const text = changelog()
      const edited = edit(text)
      expect(edited).not.toBe(text)
      expect(releaseCheck(element)(edited)).not.toEqual([])
    })

    test.each(HATCH_NOTE_NAMES)('the release notes name %s as a code span (%s)', (name) => {
      expect(flat(releaseNotes(changelog()))).toContain(code(name))
    })
  })

  describe('the runbook copies (SRJ-1107; hatch A3: the README is the maintained copy)', () => {
    test.each(RUNBOOK_COPIES)(`the copy of "%s" sits in the ${RUNBOOK_RELEASE_VERSION} entry, the release that introduced it, and nowhere else in the file`, (_title, heading) => {
      const text = changelog()
      const { start, end } = releaseEntryRange(text)
      expect(headings(text).filter((h) => h.text === heading).map((h) => h.line > start && h.line < end)).toEqual([true])
    })

    test('self-check: the release entry is found by its version and publish date, not by its place', () => {
      const text = changelog()
      expect(releaseEntry(text.replace(/^## /m, '## 0.12.0 (2026-11-01)\n\nA later release.\n\n## '))).toBe(releaseEntry(text))
      const undated = text.replace(new RegExp(`^## ${escapeRegExp(RUNBOOK_RELEASE_VERSION)} \\(.*$`, 'm'), `## ${RUNBOOK_RELEASE_VERSION}`)
      expect(undated).not.toBe(text)
      expect(() => releaseEntry(undated)).toThrow(
        `${CHANGELOG_FILE} has 0 \`##\` entries titled ${RUNBOOK_RELEASE_VERSION} and its publish date, expected 1`,
      )
      expect(() => releaseEntry(`${text}\n## ${RUNBOOK_RELEASE_VERSION} (2026-10-07)\n\nAgain.\n`)).toThrow(
        `${CHANGELOG_FILE} has 2 \`##\` entries titled ${RUNBOOK_RELEASE_VERSION} and its publish date, expected 1`,
      )
    })

    test.each(RUNBOOK_COPIES)('the copy of "%s" names the README section as the maintained copy, by a link that resolves', (title, heading) => {
      const units = textUnits(requiredSection(releaseEntry(changelog()), heading, CHANGELOG_FILE)).filter((unit) => MAINTAINED_COPY.test(unit))
      expect(units).toHaveLength(1)
      const anchor = headingSlug(title)
      expect(linksWithText(units[0]).filter((link) => link.path === 'README.md' && link.anchor === anchor).map((link) => link.target)).toEqual([`README.md#${anchor}`])
      expect(headingAt(operatorText('README.md'), anchor)?.text).toBe(heading)
    })

    test.each(RUNBOOK_COPIES)("the copy of \"%s\" is the README section word for word, headings included, once its maintained-copy line is dropped and its README.md# links read as the README's own", (_title, heading) => {
      const readmeSection = requiredSection(operatorText('README.md'), heading, 'README.md')
      const copy = asReadmeText(requiredSection(releaseEntry(changelog()), heading, CHANGELOG_FILE))
      expect(sectionChunks(copy)).toEqual(sectionChunks(readmeSection))
    })

    // The audit reads only SHIPPED_TEXTS, so the README copies' token-variable check does not reach the CHANGELOG's.
    test.each(RUNBOOK_COPIES)('the copy of "%s" names no Slack token environment variable (SRJ-1516: the runbooks never name one)', (_title, heading) => {
      const group = FORBIDDEN_TERMS.find((g) => g.name === 'the token environment variables')
      if (group === undefined) throw new Error('FORBIDDEN_TERMS has no group "the token environment variables"')
      const section = requiredSection(releaseEntry(changelog()), heading, CHANGELOG_FILE)
      expect(findTerms(CHANGELOG_FILE, section, group.terms).map(formatHit)).toEqual([])
      expect(flat(section)).toMatch(ci('the Slack token environment variables'))
    })
  })

  describe('links', () => {
    test(`every link in ${CHANGELOG_FILE} resolves: a same-file anchor to a heading in it, a README.md or other repository link to an existing file and heading`, () => {
      const { checked, broken } = brokenRepoLinks(CHANGELOG_FILE, changelog())
      expect(broken).toEqual([])
      expect(checked).toBeGreaterThan(0)
    })

    test.each([
      [`a link to the removed "${GONE_TITLE}"`, `See [${GONE_TITLE}](README.md#${headingSlug(GONE_TITLE)}).`, `${CHANGELOG_FILE} -> README.md#${headingSlug(GONE_TITLE)} (no such heading in README.md)`],
      ['a same-file anchor with no heading', `See [${UPGRADE_STEPS_TITLE}](#${headingSlug(UPGRADE_STEPS_TITLE)}).`, `${CHANGELOG_FILE} -> #${headingSlug(UPGRADE_STEPS_TITLE)} (no such heading in ${CHANGELOG_FILE})`],
      ['a missing file', 'See [the notes](docs/no-such-file.md).', `${CHANGELOG_FILE} -> docs/no-such-file.md (no such file)`],
    ])('self-check: %s fails naming the link', (_label, text, problem) => {
      expect(brokenRepoLinks(CHANGELOG_FILE, text).broken).toEqual([problem])
    })
  })
})

// ---------------------------------------------------------------------------
// Bug b.7sd: no operator text sends the operator to an agent-director
// install-gate record. agent-director ships none (SRD A-19); the go-ahead is
// the operator's, recorded in the switch-over log.
// ---------------------------------------------------------------------------

/**
 * An agent-director install-gate file, record, line, entry or log (the install
 * gate's own one too), or a gate record by any other name, matched across a
 * line wrap. An operator text names one only in step 1's denial, which
 * `SHIPS_NO_DENIAL` passes.
 */
const INSTALL_GATE_ARTIFACT: Term = [
  'an install-gate file, record, line or entry, or a gate record',
  /\b(?:install[-\s]gate(?:['’]s)?\s+(?:files?|records?|lines?|entr(?:y|ies)|logs?)|gate(?:['’]s)?\s+records?)\b/gi,
]

/**
 * Step 1's sanctioned denial, "agent-director ships no install-gate file or
 * record", as the text right before an `INSTALL_GATE_ARTIFACT` hit (across a
 * line wrap). Only a hit it ends right before passes; one after any other
 * "no" ("has no", "there is no") is reported.
 */
const SHIPS_NO_DENIAL = /\bagent-director\s+ships\s+no\s+$/i

/**
 * The lines 0.11.0's runbook had the operator read from and write to that
 * record: this host's dated go line (steps 1 and 8, the publishing host) and
 * its dated post-install check line (step 10). No operator text names either,
 * denied or not.
 */
const INSTALL_GATE_LINES: readonly Term[] = [
  ['a go line', /\bgo[-\s]lines?\b/gi],
  ['a post-install check line', /\bpost-install\s+check\s+lines?\b/gi],
]

/** Each `INSTALL_GATE_ARTIFACT` hit in `text` (the text `file`) not right after `SHIPS_NO_DENIAL`, then each `INSTALL_GATE_LINES` hit. Pure. */
function installGateHits(file: string, text: string): TermHit[] {
  const denied = (index: number) => SHIPS_NO_DENIAL.test(text.slice(Math.max(0, index - 64), index))
  return [
    ...findTermsAt(file, text, [INSTALL_GATE_ARTIFACT]).filter(({ index }) => !denied(index)),
    ...findTermsAt(file, text, INSTALL_GATE_LINES),
  ].map(({ hit }) => hit)
}

/** `text` with every line outside `range` blanked, so a check reads only that range and still names each hit by its line in the file. */
function onlyLines(text: string, range: { start: number; end: number }): string {
  return text
    .split('\n')
    .map((line, i) => (i >= range.start && i < range.end ? line : ''))
    .join('\n')
}

/**
 * The texts an operator reads for the switch-over, [name, text]: every
 * operator text (`OPERATOR_TEXTS`), the CHANGELOG read as its release entry
 * only (the runbook copies and their release's notes; a later entry may say
 * what changed), every other shipped skill file, and the registry-install
 * runbook, which a publishing host follows.
 */
const SWITCH_OVER_OPERATOR_TEXTS: [name: string, read: () => string][] = [
  ...OPERATOR_TEXTS.map(([name, read]): [string, () => string] =>
    name === CHANGELOG_FILE
      ? [`${CHANGELOG_FILE} (its ${RUNBOOK_RELEASE_VERSION} entry)`, () => {
          const text = read()
          return onlyLines(text, releaseEntryRange(text))
        }]
      : [name, read]),
  ...shippedSkillFiles()
    .filter((file) => !OPERATOR_TEXTS.some(([name]) => name === file))
    .map((file): [string, () => string] => [file, () => readRepoFile(file)]),
  ['docs/registry-install-runbook.md', () => readRepoFile('docs/registry-install-runbook.md')],
]

describe('bug b.7sd: no operator text sends the operator to an agent-director install-gate record (SRD A-19)', () => {
  test.each(SWITCH_OVER_OPERATOR_TEXTS)('%s: names no install-gate record, go line or post-install check line for the operator to read or write', (name, read) => {
    expect(installGateHits(name, read()).map(formatHit)).toEqual([])
  })

  // 0.11.0's runbook wording, which these cases report (bug b.7sd).
  test.each([
    [
      "step 1's go-line item",
      "1. **The go line.** Confirm that agent-director's Phase 1 install-gate record has this host's dated go line. It is written before the Phase 1 install and is the approval for the switch-over. If it does not, stop here, before anything goes down. This runbook never writes the go line.",
      ['install-gate record', 'go line', 'go line', 'go line'],
    ],
    ["step 8's go-line item", "1. **The go line.** Confirm that the install-gate record has this host's dated go line.", ['install-gate record', 'go line', 'go line']],
    [
      "step 10's post-install record",
      "Record the result in the switch-over log, and as this host's dated post-install check line in agent-director's install-gate record.",
      ['install-gate record', 'post-install check line'],
    ],
    ["the publishing host's go line", 'A publishing host needs no install-gate go line.', ['go line']],
    ['a record named across a line wrap', "Record it in agent-director's install-gate\n   record.", ['install-gate record']],
    ['an install-gate file to check', "Check the install-gate file for this host's entry.", ['install-gate file']],
    // After a "no" that is not step 1's denial, and by other names.
    ['a missing record entry to stop on', 'If this host has no install-gate record entry, stop here, before anything goes down.', ['install-gate record']],
    ['a missing entry that stops the install', 'If there is no install-gate entry for this host, there is no Phase 1 install.', ['install-gate entry']],
    ["agent-director's gate record to check", "Check agent-director's gate record for this host.", ['gate record']],
    ["the install gate's record to confirm", "Confirm the install gate's record has this host's approval.", ["install gate's record"]],
  ])("self-check: 0.11.0's or a new form, %s, is reported", (_label, text, matches) => {
    expect(installGateHits('README.md', text).map((hit) => hit.match)).toEqual(matches)
  })

  test.each([
    ['as written', "The go-ahead is the operator's decision, and agent-director ships no install-gate file or record. agent-director's Phase 1 install gate is the set of CSCB fixes that must be in place on a host before Phase 1 is installed there."],
    ['across a line wrap', "The go-ahead is the operator's decision, and agent-director ships\n   no install-gate file or record."],
  ])("self-check: step 1's statement that agent-director ships no install-gate file or record passes, %s", (_label, statement) => {
    expect(installGateHits('README.md', statement)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// E36 T1: the kill-failure alerts' sentences (the E20 note) and the README's
// and debugging skill's `auto-restart disabled` lines (the E8 note), read
// through OPERATOR_TEXTS; the E8 note's raw-command forms are E36 T4's
// ---------------------------------------------------------------------------

/** The persona the rendered alerts concern. */
const ALERT_KEY = 'alpha'

/** Each version's closings: the survivor version has no latched one. */
const ALERT_CLOSINGS: Readonly<Record<KillFailureAlertVersion, readonly KillFailureClosing[]>> = Object.freeze({
  [KILL_FAILURE_VERSION_ORDINARY]: [
    KILL_FAILURE_CLOSING_DESTINATION,
    KILL_FAILURE_CLOSING_DESTINATION_LATCHED,
    KILL_FAILURE_CLOSING_CLI_TEARDOWN,
    KILL_FAILURE_CLOSING_LOG_ONLY,
  ],
  [KILL_FAILURE_VERSION_SURVIVOR]: [KILL_FAILURE_CLOSING_DESTINATION, KILL_FAILURE_CLOSING_CLI_TEARDOWN, KILL_FAILURE_CLOSING_LOG_ONLY],
})

/** An alert's title: the emoji and bold name it opens with (`:rotating_light: *Kill failed*`). File-local. */
const ALERT_TITLE = /^:[a-z_]+: \*[^*]+\*/

/** The fewest words a checked sentence part has: a shorter one ("and check its result.") is common wording, not a quote. */
const MIN_QUOTE_WORDS = 5

/** One rendering of an alert: what it says, and the values in its text that vary (session, instance id, quoted descriptions, pids). */
interface AlertRendering {
  readonly content: KillFailureAlertContent
  readonly variables: readonly string[]
}

/**
 * Both versions rendered with the stub's descriptions: the ordinary version
 * with no description, with each `ErrTmuxKillFailed` description, and with
 * the last failure's and an earlier survivor-naming one; the survivor version
 * quoting its survivor-naming description.
 */
function killFailureAlertRenderings(): AlertRendering[] {
  const session = personaTmuxSessionName(ALERT_KEY)
  const instanceId = personaInstanceId(ALERT_KEY)
  const description = (d: (typeof KILL_FAILED_DESCRIPTIONS)[number]) => errTmuxKillFailed(session, d, STUB_SURVIVOR_PIDS).errDescription ?? ''
  const survivorDescription = description('pane-process-survived')
  const ordinary = (quotes?: { lastKillFailedDescription?: string; earlierSurvivorDescription?: string }): AlertRendering => ({
    content: { version: KILL_FAILURE_VERSION_ORDINARY, session, instanceId, ...(quotes === undefined ? {} : { quotes }) },
    variables: [session, instanceId, ...Object.values(quotes ?? {}).map((quote) => renderLogMessageText(quote))],
  })
  return [
    ordinary(),
    ...KILL_FAILED_DESCRIPTIONS.map((d) => ordinary({ lastKillFailedDescription: description(d) })),
    ordinary({ lastKillFailedDescription: description('outlived-exit-wait'), earlierSurvivorDescription: survivorDescription }),
    {
      content: { version: KILL_FAILURE_VERSION_SURVIVOR, session, survivorDescription },
      variables: [session, renderLogMessageText(survivorDescription), killFailureSurvivorPidList(survivorDescription)],
    },
  ]
}

/**
 * The sentence parts of an alert's `text` that an operator text may not
 * quote: `text` with its title, its closing sentences and the human-only
 * sentence taken out, cut at each varying value and split into sentences (at
 * `.` or `;`), each part of at least `MIN_QUOTE_WORDS` words (a word holds a
 * letter, so a lone quote mark or backtick is none).
 */
function quotableAlertParts(text: string, version: KillFailureAlertVersion, variables: readonly string[]): string[] {
  let rest = text.replace(ALERT_TITLE, '\n')
  // SRJ-1001's human-only sentence (the shared pattern): every notice that
  // names a command or "Operator actions" carries it, so it is SRJ-1001's
  // sentence, not the alert's, and the engineering guide states it as the rule.
  for (const sentence of humanOnlySentencesIn(rest)) rest = rest.split(sentence).join('\n')
  for (const closing of ALERT_CLOSINGS[version]) rest = rest.split(killFailureClosingSentence(version, closing)).join('\n')
  for (const value of [...variables].filter((v) => v !== '').sort((a, b) => b.length - a.length)) rest = rest.split(value).join('\n')
  return rest
    .split(/\n|(?<=[.;])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.split(/\s+/).filter((word) => /[a-z]/i.test(word)).length >= MIN_QUOTE_WORDS)
}

/** Every [version, sentence part] of both alerts, over every rendering, closing and form, each once. */
const KILL_ALERT_PARTS: readonly (readonly [version: KillFailureAlertVersion, part: string])[] = (() => {
  const seen = new Set<string>()
  const parts: [KillFailureAlertVersion, string][] = []
  for (const { content, variables } of killFailureAlertRenderings()) {
    for (const closing of ALERT_CLOSINGS[content.version]) {
      for (const forSlack of [false, true]) {
        for (const part of quotableAlertParts(killFailureAlertText(content, closing, forSlack), content.version, variables)) {
          const key = `${content.version}\n${part}`
          if (!seen.has(key)) {
            seen.add(key)
            parts.push([content.version, part])
          }
        }
      }
    }
  }
  return parts
})()

/**
 * A run this many words long of an alert sentence is a quote of it, even
 * with the words around it changed (a sentence restated with "GONE" for
 * `ErrTmuxCaptureFailed` still quotes it). Shorter runs are wording a
 * passage may share with the alert because both repeat agent-director's
 * description ("no session or pane of this launch was found"), as the
 * debugging skill's own `read-pane` caveats do.
 */
const QUOTE_RUN_WORDS = 15

/** `text` for comparing words: lower case, Markdown's backticks and emphasis dropped, one space apart, padded with a space. */
function quoteComparable(text: string): string {
  return ` ${text.toLowerCase().replace(/[`*]/g, '').split(/\s+/).filter((word) => word !== '').join(' ')} `
}

/**
 * Whether `comparable` (from `quoteComparable`) quotes `part`: the whole
 * part (its edges may be cut at a varying value, so it is matched as is), or
 * any run of `QUOTE_RUN_WORDS` of its words, matched as whole words.
 */
function quotesAlertPart(comparable: string, part: string): boolean {
  const words = quoteComparable(part).trim().split(' ')
  if (comparable.includes(words.join(' '))) return true
  return Array.from({ length: Math.max(0, words.length - QUOTE_RUN_WORDS + 1) }, (_, i) => words.slice(i, i + QUOTE_RUN_WORDS)).some((run) =>
    comparable.includes(` ${run.join(' ')} `),
  )
}

/** Each alert sentence part `text` quotes (across line breaks and Markdown marks), as `<version>: <part>`. */
function alertPartsQuotedIn(text: string): string[] {
  const comparable = quoteComparable(text)
  return KILL_ALERT_PARTS.filter(([, part]) => quotesAlertPart(comparable, part)).map(([version, part]) => `${version}: ${part}`)
}

/** Each operator text, made comparable once. */
const COMPARABLE_OPERATOR_TEXTS = new Map(OPERATOR_TEXTS.map(([name, read]) => [name, lazy(() => quoteComparable(read()))] as const))

describe('E20: operator texts quote the Kill failed and Process outlived kill alerts only by title and closing sentence (b.jg5 SRJ-1001, SRJ-1007)', () => {
  test.each(OPERATOR_TEXTS.flatMap(([name]) => KILL_ALERT_PARTS.map(([version, part]) => [name, version, part] as const)))(
    '%s does not quote the %s alert sentence "%s"',
    (name, _version, part) => {
      expect(quotesAlertPart(COMPARABLE_OPERATOR_TEXTS.get(name)!(), part)).toBe(false)
    },
  )

  test('both versions give sentences to check, apart from their titles and closings', () => {
    for (const version of [KILL_FAILURE_VERSION_ORDINARY, KILL_FAILURE_VERSION_SURVIVOR]) {
      expect({ version, parts: KILL_ALERT_PARTS.filter(([v]) => v === version).length >= 3 }).toEqual({ version, parts: true })
    }
  })

  test.each(KILL_ALERT_PARTS.map(([version, part]) => [version, part] as const))('self-check: a text quoting the %s alert sentence "%s", wrapped, is reported', (version, part) => {
    const wrapped = `An operator text.\nThe alert says: ${part.replace(' ', '\n')} And more.`
    expect(alertPartsQuotedIn(wrapped)).toContain(`${version}: ${part}`)
  })

  test(`self-check: a sentence restated with a word changed is reported while ${QUOTE_RUN_WORDS} of its words run unchanged, and not with one fewer`, () => {
    const [version, part] = [...KILL_ALERT_PARTS].sort(([, a], [, b]) => b.length - a.length)[0]!
    const words = part.split(' ')
    expect(words.length).toBeGreaterThan(QUOTE_RUN_WORDS)
    const restated = ['Restated:', ...words.slice(1, QUOTE_RUN_WORDS + 1), 'CHANGED'].join(' ')
    expect(alertPartsQuotedIn(restated)).toContain(`${version}: ${part}`)
    const shorter = ['Restated:', ...words.slice(1, QUOTE_RUN_WORDS), 'CHANGED'].join(' ')
    expect(alertPartsQuotedIn(shorter)).not.toContain(`${version}: ${part}`)
  })

  test('self-check: a text quoting a whole alert is reported for each of its sentences; its title, closing and human-only sentences alone are not', () => {
    for (const { content, variables } of killFailureAlertRenderings()) {
      for (const closing of ALERT_CLOSINGS[content.version]) {
        const text = killFailureAlertText(content, closing, false)
        const parts = quotableAlertParts(text, content.version, variables)
        expect(alertPartsQuotedIn(text)).toEqual(expect.arrayContaining(parts.map((part) => `${content.version}: ${part}`)))
        const allowed = [ALERT_TITLE.exec(text)?.[0] ?? '', killFailureClosingSentence(content.version, closing), ...humanOnlySentencesIn(text)]
        expect(allowed.filter((sentence) => sentence === '')).toEqual([])
        expect(alertPartsQuotedIn(allowed.join(' '))).toEqual([])
      }
    }
  })
})

// ---------------------------------------------------------------------------
// E36 T2: the prefix-key rule's reason (b.jg5 SRJ-1102, AC 78), read through
// OPERATOR_TEXTS
// ---------------------------------------------------------------------------

/** The prefix-related pair the reason's example and the debugging skill's quoted message use: the shorter persona first. */
const PREFIX_PAIR = ['dev', 'dev_2'] as const

/**
 * SRJ-1102's reason sentence as the operator texts state it, from the
 * loader's own builder: the example session is the shorter persona's, what it
 * could reach is "another persona's session", and `=` and the example command
 * are code spans.
 */
const DOCS_PREFIX_KEY_REASON = prefixRelatedKeysReason(personaTmuxSessionName(PREFIX_PAIR[0]), "another persona's session", code)

/**
 * The validation text for `PREFIX_PAIR` in array order, after the later
 * persona's prefix, as the loader renders it (`resolvePersonaConfig`, which
 * runs `describePrefixRelatedKeys`; pure, no file read): the message the
 * debugging skill quotes. Throws unless the loader rejects the pair with it.
 */
const renderedPrefixKeyMessage = lazy((): string => {
  const base = join(tmpdir(), 'cscb-shipped-docs-prefix-pair')
  const raw = { personas: PREFIX_PAIR.map((name) => makePersona({ name }, base)) }
  let message: string | undefined
  try {
    resolvePersonaConfig(raw, base, base, { record: true })
  } catch (err) {
    assertNoLeak(err, 'prefix-pair rejection')
    message = err instanceof Error ? err.message : undefined
  }
  const lead = `(key=${PREFIX_PAIR[1]}): `
  const at = message?.indexOf(lead) ?? -1
  if (message === undefined || at < 0) throw new Error(`the loader did not reject ${PREFIX_PAIR.join(' then ')} with a persona-entry message: ${message}`)
  return message.slice(at + lead.length)
})

/**
 * The spans an operator text may carry a `tmux attach -t` without `=` in
 * (b.jg5 SRJ-1102; SRJ-1101's one exception), file-local and built from the
 * src builders, never written out: the reason sentence in the operator
 * texts' form, and the validation text rendered for `PREFIX_PAIR`, which the
 * debugging skill quotes (SRJ-1101's literal exception, the Task's ruling).
 * Each is removed, as written, from the flattened text before a check looks
 * for the example or an attach without `=`; nothing else is.
 */
const PREFIX_KEY_REASON_SPANS: readonly [label: string, span: () => string][] = [
  ['the reason sentence in the operator texts (SRJ-1102)', () => DOCS_PREFIX_KEY_REASON],
  [`the validation text rendered for ${PREFIX_PAIR.join(' then ')}, which the debugging skill quotes (SRJ-1101's literal exception)`, renderedPrefixKeyMessage],
]

/** `text`, whitespace collapsed, with each `PREFIX_KEY_REASON_SPANS` span removed. */
function withoutPrefixKeyReason(text: string): string {
  return PREFIX_KEY_REASON_SPANS.reduce((rest, [, span]) => rest.split(span()).join(' '), flat(text))
}

/** The reason's example command, `tmux attach -t slack_bot_dev`, wherever it stands, code span or not; a longer session name is not it. */
const PREFIX_KEY_EXAMPLE = new RegExp(`\\btmux attach(?:-session)?\\s+-t\\s+${escapeRegExp(personaTmuxSessionName(PREFIX_PAIR[0]))}(?![\\w-])`, 'g')

/**
 * The carriers of the reason (SRJ-1102; the Task's ruling): each text and the
 * section that states it, found by title. The CHANGELOG's note is a row of
 * `RELEASE_ENTRY_CHECKS`.
 */
const PREFIX_KEY_REASON_CARRIERS: readonly [file: string, heading: HeadingMatch][] = [
  ['README.md', '#### Persona name and key'],
  [DEBUG_SKILL_FILE, '### Across personas'],
  [WIZARD_FILE, /^#### .*\bName$/],
  ['docs/engineering-guide.md', '## Configuration'],
  ['docs/architecture.md', '### Persona config'],
]

/** One carrier's section of `text`, flattened; throws naming the file and heading when there is none. */
function reasonCarrierSection(file: string, heading: HeadingMatch, text: string = operatorText(file)): string {
  return flat(requiredSection(text, heading, file))
}

/**
 * The claim SRJ-1102 bars (file-local): that CSCB or agent-director targets,
 * finds or passes a tmux session by prefix or by a bare name. A sentence here
 * runs to a full stop followed by whitespace, so a version's dots stay inside
 * it. Each with a synthetic string it must match, b.ob2's and E35's wording.
 */
const SAME_SENTENCE = '(?:[^.]|\\.(?=\\S))'
const PREFIX_TARGETING_CLAIMS: readonly [label: string, pattern: RegExp, sample: string][] = [
  [
    'a session name passed to tmux bare',
    new RegExp(`\\b(?:agent-director|CSCB|the server)\\b${SAME_SENTENCE}{0,160}?\\b(?:pass(?:es|ed)?|hand(?:s|ed)?)\\b${SAME_SENTENCE}{0,80}?\\b(?:to tmux bare|a bare (?:session )?name)\\b`, 'gi'),
    `agent-director ${OLD_AD_VERSION}'s verbs (read-pane, send-keys, kill) pass \`slack_bot_<key>\` to tmux bare`,
  ],
  [
    "agent-director's or CSCB's tmux calls prefix-match",
    new RegExp(`\\b(?:agent-director|CSCB|the server)\\b${SAME_SENTENCE}{0,80}?\\bprefix-match\\w*`, 'gi'),
    "Known gap: agent-director's own tmux calls still prefix-match.",
  ],
  [
    'agent-director or CSCB finds a session by a name that matches a longer one',
    new RegExp(`\\b(?:agent-director|CSCB|the server)\\b${SAME_SENTENCE}{0,160}?\\b(?:by (?:its )?(?:prefix|start)|matches the start of)`, 'gi'),
    `agent-director ${OLD_AD_VERSION} finds a persona's tmux session by a name that also matches the start of a longer one`,
  ],
]

describe("E36 T2: the prefix-key rule's reason is SRJ-1102's in every carrier, and its example stands nowhere else (b.jg5 SRJ-1102, AC 78)", () => {
  test.each(PREFIX_KEY_REASON_CARRIERS)('%s, under %s, states the reason sentence', (file, heading) => {
    expect(reasonCarrierSection(file, heading)).toContain(DOCS_PREFIX_KEY_REASON)
  })

  test(`${DEBUG_SKILL_FILE}, under "### Across personas", quotes the validation text rendered for ${PREFIX_PAIR.join(' then ')}`, () => {
    expect(reasonCarrierSection(DEBUG_SKILL_FILE, '### Across personas')).toContain(code(renderedPrefixKeyMessage()))
  })

  test.each(OPERATOR_TEXTS)(`%s: the example \`tmux attach -t ${personaTmuxSessionName(PREFIX_PAIR[0])}\` stands only inside the reason sentence`, (_name, read) => {
    expect(withoutPrefixKeyReason(read()).match(PREFIX_KEY_EXAMPLE) ?? []).toEqual([])
  })

  test.each(OPERATOR_TEXTS)('%s: no text says CSCB or agent-director targets a tmux session by prefix or by a bare name', (_name, read) => {
    expect(termsIn(flat(read()), PREFIX_TARGETING_CLAIMS.map(([label, pattern]) => [label, pattern] as const))).toEqual([])
  })

  describe('self-checks', () => {
    test("the rendered message carries the reason for the pair's two session names, and both spans hold the example", () => {
      expect(renderedPrefixKeyMessage()).toContain(prefixRelatedKeysReason(personaTmuxSessionName(PREFIX_PAIR[0]), personaTmuxSessionName(PREFIX_PAIR[1])))
      for (const [label, span] of PREFIX_KEY_REASON_SPANS) expect({ label, examples: span().match(PREFIX_KEY_EXAMPLE)?.length }).toEqual({ label, examples: 1 })
    })

    test.each(PREFIX_KEY_REASON_CARRIERS)("%s fails with the reason reverted to b.ob2's wording", (file, heading) => {
      const text = operatorText(file)
      // As written, so wrapped across lines in the wizard.
      const asWritten = new RegExp(escapeRegExp(DOCS_PREFIX_KEY_REASON).replace(/ /g, '\\s+'))
      const edited = text.replace(asWritten, `agent-director ${OLD_AD_VERSION} finds a persona's tmux session by a name that also matches the start of a longer one.`)
      expect(edited).not.toBe(text)
      expect(reasonCarrierSection(file, heading, edited)).not.toContain(DOCS_PREFIX_KEY_REASON)
      expect(termsIn(flat(edited), PREFIX_TARGETING_CLAIMS.map(([label, pattern]) => [label, pattern] as const))).not.toEqual([])
    })

    test('the example outside the reason sentence is reported, wrapped or not; the exact target and a longer session are not', () => {
      const session = personaTmuxSessionName(PREFIX_PAIR[0])
      expect(withoutPrefixKeyReason(`${DOCS_PREFIX_KEY_REASON} Attach with \`tmux attach -t\n${session}\`.`).match(PREFIX_KEY_EXAMPLE)).toHaveLength(1)
      expect(withoutPrefixKeyReason(`tmux attach -t ${session} (for example)`).match(PREFIX_KEY_EXAMPLE)).toHaveLength(1)
      expect(withoutPrefixKeyReason(`\`tmux attach -t =${session}\` and \`tmux attach -t ${personaTmuxSessionName(PREFIX_PAIR[1])}\``).match(PREFIX_KEY_EXAMPLE)).toBeNull()
    })

    test.each(PREFIX_TARGETING_CLAIMS)('the %s pattern matches its synthetic string', (_label, pattern, sample) => {
      expect(flat(sample).match(pattern)).not.toBeNull()
    })

    test("no claim pattern flags the reason, the rendered message or the engineering guide's exact-target wording", () => {
      const fine = [
        DOCS_PREFIX_KEY_REASON,
        renderedPrefixKeyMessage(),
        'Build the target with `tmuxExactSessionTarget` (`src/persona-identity.ts`, `=<name>`, used only for the operator\'s `attach` command); never pass a bare name. Why: tmux resolves a bare name by prefix when no session has that exact name.',
        'it is about a human\'s command, never about how CSCB or agent-director reach a session.',
      ].join('\n')
      expect(termsIn(flat(fine), PREFIX_TARGETING_CLAIMS.map(([label, pattern]) => [label, pattern] as const))).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------
// E36 T2: the README's install and startup texts point to the runbook and
// name no install, re-install or removal (the E2-gate, E4 and E5 hatch notes;
// b.jg5 SRJ-208, SRJ-212, SRJ-1101), read through OPERATOR_TEXTS
// ---------------------------------------------------------------------------

const INSTALL_CHECK_HEADING = '### Checking your agent-director install'
const PREFLIGHT_GATES_HEADING = '### Preflight gates'
const TROUBLESHOOTING_HEADING = '## Troubleshooting'

/** The script SR-2.5 runs in `/publish`'s preflight (b.jg5 SRJ-211). */
const AD_VERSION_CHECK_SCRIPT = 'scripts/ad-version-check.ts'

/** The README's list item for `label` under `heading`, a nested item (`  - \`label\``) read as a top-level one. */
function readmeLabelItem(heading: string, label: string, readme: string): string {
  const section = requiredSection(readme, heading, 'README.md').replace(/^ {2}(?=- `)/gm, '')
  return labelItem(section, label, `README.md "${heading}"`)
}

/**
 * The install-check and startup-error entries of the classes this Task
 * rewrote (the too-old and below-floor lines of "Startup errors" are checked
 * under SRJ-208 above): each names the switch-over runbook section by its
 * title, and the install check's not-found entry its publishing-host block by
 * its heading (the E35 hatch note's third bullet). The startup gate's
 * not-found entry runs on a bot host, so it names the section's step 1, never
 * that block (the code-review fix; `startupNotFoundItemProblems`).
 */
const README_REMEDY_ITEMS: readonly [heading: string, label: string, required: readonly string[]][] = [
  [INSTALL_CHECK_HEADING, AD_SYSTEM_INSTALL_NOT_FOUND, [PHASE1_RUNBOOK_SECTION_TITLE, `"${PUBLISHING_HOST_BLOCK_HEADING}"`]],
  [INSTALL_CHECK_HEADING, AD_SYSTEM_INSTALL_TOO_OLD, [PHASE1_RUNBOOK_SECTION_TITLE]],
  [INSTALL_CHECK_HEADING, AD_SYSTEM_INSTALL_UNREACHABLE, [PHASE1_RUNBOOK_SECTION_TITLE]],
  [INSTALL_CHECK_HEADING, AD_VERSION_FLOOR_UNREADABLE, [PHASE1_RUNBOOK_SECTION_TITLE]],
  [STARTUP_ERRORS_HEADING, AD_SYSTEM_INSTALL_NOT_FOUND, [PHASE1_RUNBOOK_SECTION_TITLE]],
  [STARTUP_ERRORS_HEADING, AD_SYSTEM_INSTALL_UNREACHABLE, [PHASE1_RUNBOOK_SECTION_TITLE]],
  [STARTUP_ERRORS_HEADING, AD_VERSION_FLOOR_UNREADABLE, [PHASE1_RUNBOOK_SECTION_TITLE]],
  [STARTUP_ERRORS_HEADING, AD_SHIM_CATALOG_INCOMPLETE, [vocab('unknownErrorName'), 'be misclassified']],
]

/** A remedy item's problems: what it lacks and each upgrade form it carries (the re-install row included). */
function remedyItemProblems(heading: string, label: string, required: readonly string[], readme: string = operatorText('README.md')): string[] {
  const item = readmeLabelItem(heading, label, readme)
  return [...lacking(item, required), ...upgradeFormsIn(item)]
}

/**
 * README "Startup errors"' `ad-system-install-not-found` item (the startup
 * gate's; the code-review fix): it runs on a bot host, so it links the
 * switch-over section's step 1, whose version check shows whether the
 * launcher's HOME or PATH differs from the workers', and the link resolves to
 * that step's heading in the section; it names no publishing-host block, by
 * its quoted heading or a link to it.
 */
function startupNotFoundItemProblems(readme: string = operatorText('README.md')): string[] {
  const item = readmeLabelItem(STARTUP_ERRORS_HEADING, AD_SYSTEM_INSTALL_NOT_FOUND, readme)
  const carrier = readRunbookCarrier('README.md', readme, SWITCH_OVER_HEADING, SWITCH_OVER_STEP_COUNT)
  const step1 = headingAt(readme, carrier.stepAnchors[0])
  const runbook = sectionRange(readme, SWITCH_OVER_HEADING)
  const blockNames = [`"${PUBLISHING_HOST_BLOCK_HEADING}"`, `(#${headingSlug(PUBLISHING_HOST_BLOCK_HEADING)})`]
  return [
    ...lacking(item, [stepLink(1)(carrier)]),
    ...(step1 !== undefined && stepNumberOf(step1.title) === 1 && runbook !== undefined && step1.line > runbook.start && step1.line < runbook.end
      ? []
      : [`#${carrier.stepAnchors[0]} resolves to no step 1 heading inside "${SWITCH_OVER_HEADING}"`]),
    ...blockNames.filter((name) => item.includes(name)).map((name) => `names the publishing-host block: ${name}`),
  ]
}

/** The `ad-same-user` ruling's own words, the one removal an install or startup text may name (as in tests/dependency-check.test.ts). */
const NEVER_REMOVE_THE_FILE = 'never remove or recreate the file'

/**
 * The README "Startup errors" item for a state DB owned by another user (the
 * `ad-same-user` entry; src/agent-director-startup.ts exports no constant for
 * that label, so the item is found by what it says): the one class item that
 * names `DEFAULT_STORE_PATH` as owned by a different UID. Throws unless
 * exactly one does.
 */
function sameUserItem(readme: string): string {
  const lines = requiredSection(readme, STARTUP_ERRORS_HEADING, 'README.md').split('\n')
  const items = lines
    .flatMap((line, i) => (line.startsWith('- `') ? [i] : []))
    .map((start) => {
      const end = lines.findIndex((line, i) => i > start && !/^\s+\S/.test(line))
      return flat(lines.slice(start, end < 0 ? undefined : end).join('\n'))
    })
    .filter((item) => item.includes(`${code(DEFAULT_STORE_PATH)} is owned by a different UID`))
  if (items.length !== 1) throw new Error(`README.md "${STARTUP_ERRORS_HEADING}": ${items.length} class items say ${DEFAULT_STORE_PATH} is owned by a different UID, expected 1`)
  return items[0]
}

/** The same-user item's problems (the E2-gate ruling): run as the file's owner, the runbook section, no re-install and no removal but the ruling's own words. */
function sameUserProblems(readme: string = operatorText('README.md')): string[] {
  const item = sameUserItem(readme)
  const rest = item.split(NEVER_REMOVE_THE_FILE).join('')
  return [
    ...lacking(item, [`the user that owns ${code(DEFAULT_STORE_PATH)}`, NEVER_REMOVE_THE_FILE, PHASE1_RUNBOOK_SECTION_TITLE]),
    ...upgradeFormsIn(item),
    ...[DELETE_WORDS, /\brecreat\w*/i].filter((pattern) => pattern.test(rest)).map((pattern) => `a removal: ${rest.match(pattern)?.[0]}`),
  ]
}

/**
 * The historical versions the self-checks put back into an in-memory doc
 * (file-local; none is a version CSCB checks against, so none sits in
 * tests/test-helpers/agent-director-versions.ts), each citing where it stood.
 */
const HISTORICAL_VERSIONS = {
  /** b.ob2's agent-director requirement for reboot recovery, "≥ 0.8.0", in README "Bots come back with no memory" and the `resume_enabled` row (removed by the E5 hatch note). */
  resumeRecoveryMinimum: '0.8.0',
  /** b.ob2's agent-director series that passed the old install check, written `0.7.x`, in the same Troubleshooting paragraph (the E5 hatch note). */
  oldInstallCheckSeries: '0.7.x',
  /** The Claude Code minimum for agent-director's exec-form hooks, which b.ob2's README prerequisites named before RN-9 (HO rev 31; SRJ-1304) raised it to `MIN_CLAUDE_CODE_VERSION`. */
  execFormHooksClaudeCode: '2.1.139',
  /** The zombie agent-director release README "Note on agent-director versions" named (b.ob2; removed by E36 T4, SRJ-1103). */
  zombieRelease: 'v0.4.1',
} as const

/** A version written in prose (`0.8.0`, `0.7.x`). */
const ANY_VERSION = /\b\d+\.\d+\.(?:\d+|x)\b/g

/** An agent-director version requirement in a table row or paragraph ("`agent-director` ≥ 0.8.0"). */
const AD_VERSION_CLAIM = /\bagent-director`?[^.|]{0,40}?\d+\.\d+\.\d+/g

/**
 * The README Troubleshooting paragraph "Bots come back with no memory …" (the
 * E5 hatch note): it names the below-floor refusal and no version (b.ob2's
 * "≥ 0.8.0" and install check's `0.7.0` floor are gone), and the
 * `resume_enabled` row names no agent-director version.
 */
function noMemoryProblems(readme: string = operatorText('README.md')): string[] {
  const units = textUnits(requiredSection(readme, TROUBLESHOOTING_HEADING, 'README.md')).filter((unit) => ci('**Bots come back with no memory').test(unit))
  if (units.length !== 1) return [`${units.length} Troubleshooting units open with "Bots come back with no memory", expected 1`]
  const rows = readme.split('\n').filter((line) => line.startsWith('| `resume_enabled` |'))
  return [
    ...lacking(units[0], [code(AD_BELOW_PHASE1_FLOOR)]),
    ...[...units[0].matchAll(ANY_VERSION)].map((m) => `the paragraph names version ${m[0]}`),
    ...(rows.length === 1 ? [...rows[0].matchAll(AD_VERSION_CLAIM)].map((m) => `the resume_enabled row: ${m[0]}`) : [`${rows.length} resume_enabled rows, expected 1`]),
  ]
}

/**
 * README "Preflight gates" (the E5 hatch note; b.jg5 SRJ-211): the count its
 * lead names matches its numbered gates, and exactly one gate runs
 * `scripts/ad-version-check.ts`, naming its exit (`AD_VERSION_CHECK_FAIL_EXIT_CODE`
 * and its value), its `SR-2.5 (preflight)` line and the below-floor note's
 * prefix, the runbook section and its publishing-host block, with no upgrade
 * form.
 */
function preflightGateProblems(readme: string = operatorText('README.md')): string[] {
  const section = requiredSection(readme, PREFLIGHT_GATES_HEADING, 'README.md')
  const gates = section.split('\n').filter((line) => /^\d+\. /.test(line))
  const lead = /\benforces (\w+) fail-fast gates\b/.exec(flat(section))?.[1]
  const sr25 = gates.filter((gate) => gate.includes(code(AD_VERSION_CHECK_SCRIPT))).map(flat)
  return [
    ...(lead === countWord(gates.length) ? [] : [`the lead names ${lead} gates, the list has ${gates.length}`]),
    ...gates.flatMap((gate, i) => (gate.startsWith(`${i + 1}. `) ? [] : [`gate ${i + 1} is numbered "${gate.slice(0, 4)}"`])),
    ...(sr25.length === 1
      ? [
        ...lacking(sr25[0], [
          `exit ${AD_VERSION_CHECK_FAIL_EXIT_CODE}`,
          code('AD_VERSION_CHECK_FAIL_EXIT_CODE'),
          code(SR25_PREFIX),
          code(SR25_NOTE_PREFIX),
          PHASE1_RUNBOOK_SECTION_TITLE,
          `"${PUBLISHING_HOST_BLOCK_HEADING}"`,
          ci('the server will not start on it'),
        ]),
        ...upgradeFormsIn(sr25[0]),
      ]
      : [`${sr25.length} gates name ${code(AD_VERSION_CHECK_SCRIPT)}, expected 1`]),
  ]
}

describe("E36 T2: the README's install and startup texts point to the runbook and name no install, re-install or removal (E2 gate, E4, E5; b.jg5 SRJ-208, SRJ-212, SRJ-1101)", () => {
  test.each(README_REMEDY_ITEMS)('README.md "%s": the `%s` item names %p and carries no upgrade or re-install form', (heading, label, required) => {
    expect(remedyItemProblems(heading, label, required)).toEqual([])
  })

  test(`"${INSTALL_CHECK_HEADING.slice('### '.length)}": the not-found item's "${PUBLISHING_HOST_BLOCK_HEADING}" link resolves to that block's heading in the switch-over section`, () => {
    const readme = operatorText('README.md')
    const anchor = headingSlug(PUBLISHING_HOST_BLOCK_HEADING)
    expect(readmeLabelItem(INSTALL_CHECK_HEADING, AD_SYSTEM_INSTALL_NOT_FOUND, readme)).toContain(`(#${anchor})`)
    expect(headingAt(readme, anchor)?.title).toBe(PUBLISHING_HOST_BLOCK_HEADING)
    const block = sectionRange(readme, new RegExp(`^#+ ${escapeRegExp(PUBLISHING_HOST_BLOCK_HEADING)}$`))
    const runbook = sectionRange(readme, SWITCH_OVER_HEADING)
    expect(block !== undefined && runbook !== undefined && block.start > runbook.start && block.end <= runbook.end).toBe(true)
  })

  test(`"${STARTUP_ERRORS_HEADING.slice('## '.length)}": the startup gate's not-found item links switch-over step 1, which resolves, and names no "${PUBLISHING_HOST_BLOCK_HEADING}" block (it runs on a bot host)`, () => {
    expect(startupNotFoundItemProblems()).toEqual([])
  })

  test(`the ${STARTUP_ERRORS_HEADING.slice(3)} item for a state DB owned by another user: run as its owner, never remove or recreate it, the runbook section, no re-install`, () => {
    expect(sameUserProblems()).toEqual([])
  })

  test('the Troubleshooting "Bots come back with no memory" paragraph and the `resume_enabled` row name no pre-floor agent-director version', () => {
    expect(noMemoryProblems()).toEqual([])
  })

  test(`"${PREFLIGHT_GATES_HEADING.slice(4)}" lists SR-2.5 (${AD_VERSION_CHECK_SCRIPT}, exit ${AD_VERSION_CHECK_FAIL_EXIT_CODE}, the below-floor note) and counts its gates`, () => {
    expect(existsSync(resolve(REPO_ROOT, AD_VERSION_CHECK_SCRIPT))).toBe(true)
    expect(preflightGateProblems()).toEqual([])
  })

  test.each(OPERATOR_TEXTS)("%s: no text advises re-installing agent-director (UPGRADE_FORMS' re-install row; SRJ-1101, HO C8)", (_name, read) => {
    expect(upgradeFormsIn(flat(read())).filter((form) => form === REINSTALL_FORM)).toEqual([])
  })

  describe('self-checks (each edits an in-memory README back to the wording this Task replaced)', () => {
    const readme = () => operatorText('README.md')

    test.each([
      [INSTALL_CHECK_HEADING, AD_SYSTEM_INSTALL_NOT_FOUND, 'Install AD and retry.', /The message points to the block [^\n]*?no agent-director\./],
      [INSTALL_CHECK_HEADING, AD_VERSION_FLOOR_UNREADABLE, 'The remediation is to check or reinstall the `agent-director` npm package.', /The message says to check the `agent-director` npm package [^\n]*?Phase 1"\./],
      [STARTUP_ERRORS_HEADING, AD_SYSTEM_INSTALL_UNREACHABLE, 'Diagnose with the install-cscb skill or re-install agent-director.', /says to diagnose with the install-cscb skill, names the README section "[^"]*"/],
      [STARTUP_ERRORS_HEADING, AD_SHIM_CATALOG_INCOMPLETE, 'Envelopes with these names would surface as the base AgentDirectorError.', /errors with these names would arrive as `ErrUnknownErrorName` and be misclassified/],
    ] as const)('README.md "%s": the `%s` item fails with "%s"', (heading, label, old, current) => {
      const text = readme()
      const edited = text.replace(current, old)
      expect(edited).not.toBe(text)
      const required = README_REMEDY_ITEMS.find(([h, l]) => h === heading && l === label)![2]
      expect(remedyItemProblems(heading, label, required, edited)).not.toEqual([])
    })

    test(`the startup gate's not-found item fails with the publishing-host pointer back, and with its step 1 link dropped or broken`, () => {
      const text = readme()
      const current = /(^- `ad-system-install-not-found` — `Client\.create\(\)`[^\n]*?)The startup gate runs on a bot host,[^\n]*?differs from the workers'\./m
      const blockLink = `["${PUBLISHING_HOST_BLOCK_HEADING}"](#${headingSlug(PUBLISHING_HOST_BLOCK_HEADING)})`
      const old = text.replace(current, `$1The message points to the block ${blockLink} in the README section "${PHASE1_RUNBOOK_SECTION_TITLE}", which covers a host with no agent-director.`)
      expect(old).not.toBe(text)
      expect(startupNotFoundItemProblems(old)).toEqual(expect.arrayContaining([`names the publishing-host block: "${PUBLISHING_HOST_BLOCK_HEADING}"`, expect.stringMatching(/^lacks \(#/)]))
      const step1 = readRunbookCarrier('README.md', text, SWITCH_OVER_HEADING, SWITCH_OVER_STEP_COUNT).stepAnchors[0]
      const lines = text.split('\n')
      const at = lines.findIndex((line) => line.startsWith(`- \`${AD_SYSTEM_INSTALL_NOT_FOUND}\` — \`Client.create()\``))
      expect(at).toBeGreaterThanOrEqual(0)
      const broken = [...lines.slice(0, at), lines[at].replaceAll(`(#${step1})`, '(#no-such-step)'), ...lines.slice(at + 1)].join('\n')
      expect(startupNotFoundItemProblems(broken)).toEqual([`lacks (#${step1})`])
      // A heading of the same title before the runbook takes the anchor, so the link no longer reaches step 1.
      const shadowed = `## ${headingAt(text, step1)?.title}\n\n${text}`
      expect(startupNotFoundItemProblems(shadowed)).toEqual([`#${step1} resolves to no step 1 heading inside "${SWITCH_OVER_HEADING}"`])
    })

    test('the same-user item fails with "Reinstall agent-director as the correct user or remove the mismatched file."', () => {
      const text = readme()
      const edited = text.replace(/Run the server as the user that owns [^\n]*?Phase 1"\./, 'Reinstall agent-director as the correct user or remove the mismatched file.')
      expect(edited).not.toBe(text)
      expect(sameUserProblems(edited)).toEqual(expect.arrayContaining([REINSTALL_FORM, 'a removal: remove']))
    })

    test("the Troubleshooting paragraph fails with b.ob2's version advice back", () => {
      const text = readme()
      const edited = text.replace(/(\*\*Bots come back with no memory[^\n]*\n)[^\n]*/, `$1If it comes back amnesiac, confirm the system-installed \`agent-director\` is **≥ ${HISTORICAL_VERSIONS.resumeRecoveryMinimum}** (\`agent-director version\`). Its client floor is \`${CLIENT_MIN_VERSION}\`, so install-check passes on a \`${HISTORICAL_VERSIONS.oldInstallCheckSeries}\` binary.`)
      expect(edited).not.toBe(text)
      expect(noMemoryProblems(edited)).not.toEqual([])
    })

    test(`the resume_enabled row fails with its "≥ ${HISTORICAL_VERSIONS.resumeRecoveryMinimum}" requirement back`, () => {
      const text = readme()
      const edited = text.replace(/^(\| `resume_enabled` \|[^\n]*?)( \|)$/m, `$1 Requires a system-installed \`agent-director\` ≥ ${HISTORICAL_VERSIONS.resumeRecoveryMinimum} for reboot recovery.$2`)
      expect(edited).not.toBe(text)
      expect(noMemoryProblems(edited)).toEqual([`the resume_enabled row: agent-director\` ≥ ${HISTORICAL_VERSIONS.resumeRecoveryMinimum}`])
    })

    test('"Preflight gates" fails as the seven-gate list without SR-2.5', () => {
      const text = readme()
      const edited = text
        .replace(/^6\. \*\*The host's agent-director[^\n]*\n/m, '')
        .replace('enforces eight fail-fast gates', 'enforces seven fail-fast gates')
        .replace(/^7\. \*\*No stranded/m, '6. **No stranded')
        .replace(/^8\. \*\*`\/ci`/m, '7. **`/ci`')
      expect(edited).not.toBe(text)
      expect(preflightGateProblems(edited)).toEqual([`0 gates name ${code(AD_VERSION_CHECK_SCRIPT)}, expected 1`])
    })

    test('"Preflight gates" fails when the lead\'s count and the list disagree', () => {
      const text = readme()
      const edited = text.replace('enforces eight fail-fast gates', 'enforces seven fail-fast gates')
      expect(edited).not.toBe(text)
      expect(preflightGateProblems(edited)).not.toEqual([])
    })
  })
})

/** A lost-message state's label as the notice and the docs name it: the words between `Recovery: ` and ` —`. */
function lostMessageStateLabel(state: keyof typeof STATE_WORDING): string {
  const label = /^Recovery: (.+?) —/.exec(STATE_WORDING[state])?.[1]
  if (label === undefined) throw new Error(`STATE_WORDING["${state}"] has no "Recovery: <label> —" lead`)
  return label
}

/**
 * The claim the E8 note removed, that an `auto-restart disabled` persona will
 * not restart or come back on its own (false since E8 for a persona its
 * UNAVAILABLE retry timer owns). File-local, citing the E8 note.
 */
const STALE_AUTO_RESTART_CLAIM: readonly [label: string, pattern: RegExp][] = [
  ['will not restart or come back on its own', /\b(?:will not|won't|does not|doesn't|never|cannot|can't)\s+(?:be\s+)?(?:restart|come back|recover)\w*/gi],
]

/** The README's `auto-restart disabled` row in its lost-message recovery table; throws unless there is exactly one. */
function readmeAutoRestartRow(): string {
  const lead = `| \`${lostMessageStateLabel('auto-restart-disabled')}\` |`
  const rows = operatorText('README.md').split('\n').filter((line) => line.startsWith(lead))
  if (rows.length !== 1) throw new Error(`README.md has ${rows.length} rows starting ${lead}`)
  return rows[0]
}

/** The debugging skill's `auto-restart disabled` state, up to the next state (`restart limit reached`), in its lost-message entry. */
function debugSkillAutoRestartEntry(): string {
  const text = flat(operatorText(DEBUG_SKILL_FILE))
  const start = text.indexOf(`\`${lostMessageStateLabel('auto-restart-disabled')}\`: `)
  const end = text.indexOf(`\`${lostMessageStateLabel('restart-limit-reached')}\`: `, start)
  if (start < 0 || end < 0) throw new Error(`${DEBUG_SKILL_FILE} has no lost-message entry with the auto-restart disabled and restart limit reached states`)
  return text.slice(start, end)
}

describe("E8: the README's and debugging skill's `auto-restart disabled` text keeps not saying the persona will not restart on its own (b.jg5 SRJ-1011)", () => {
  test.each([
    ['README.md: the lost-message recovery row', readmeAutoRestartRow],
    [`${DEBUG_SKILL_FILE}: the lost-message entry's state`, debugSkillAutoRestartEntry],
  ] as const)('%s', (_label, passage) => {
    const text = passage()
    expect(text).toContain(lostMessageStateLabel('auto-restart-disabled'))
    expect(termsIn(text, STALE_AUTO_RESTART_CLAIM)).toEqual([])
  })

  test('self-check: the old claim is reported; the lost-message notice\'s own wording is not', () => {
    expect(termsIn('`session_restart_delay` is `0`, so the instance will not restart on its own.', STALE_AUTO_RESTART_CLAIM)).not.toEqual([])
    expect(termsIn("the persona won't come back on its own", STALE_AUTO_RESTART_CLAIM)).not.toEqual([])
    expect(termsIn(STATE_WORDING['auto-restart-disabled'], STALE_AUTO_RESTART_CLAIM)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// E36 T3: the architecture doc and the engineering guide match the build
// (b.jg5 SRJ-1105, SRJ-1106, SRJ-612; AC 78), read through OPERATOR_TEXTS.
// SRJ-1101's term checks over every operator text are not here; these are the
// passage and presence checks the terms cannot express.
// ---------------------------------------------------------------------------

const ARCHITECTURE_FILE = 'docs/architecture.md'
const ENGINEERING_GUIDE_FILE = 'docs/engineering-guide.md'

/** The two texts SRJ-1105 and SRJ-1106 describe. */
const DESIGN_DOCS: readonly string[] = [ARCHITECTURE_FILE, ENGINEERING_GUIDE_FILE]

/** The one source audit both docs point to for the rules they state (b.jg5 SRJ-716, SRJ-612, SRJ-601). */
const SOURCE_AUDIT_FILE = 'tests/fmk-source-audit.test.ts'

/**
 * An imported binding's name as a code span, bare or called (`` `name` ``,
 * `` `name()` ``, `` `name(key, …)` ``), read from the binding (`{ name }`),
 * so a rename in `src/` fails the typecheck and no name is typed.
 */
function exportName(binding: Record<string, unknown>): RegExp {
  const names = Object.keys(binding)
  if (names.length !== 1) throw new Error(`exportName takes one binding, got ${names.length}`)
  return new RegExp(`\`${escapeRegExp(names[0])}(?:\\([^\`]*\\))?\``)
}

/** `text` without the section under `heading` (heading line included); throws naming `file` when there is no such heading. */
function outsideSection(text: string, heading: HeadingMatch, file: string): string {
  const range = sectionRange(text, heading)
  if (range === undefined) throw new Error(`${file} has no heading ${typeof heading === 'string' ? `"${heading}"` : `matching ${String(heading)}`}`)
  return text
    .split('\n')
    .filter((_, i) => i < range.start || i >= range.end)
    .join('\n')
}

/** A negation right before a verb, at most one word between ("does not prove", "never deletes", "doesn't ever call", "neither … nor resumes"), or "no" right before it ("is no proof", "makes no raw tmux call", "no longer deletes"). */
const NEGATED_VERB = /(?:\b(?:not|never|cannot|nor|neither|without)|n't)\s+(?:[\w`'-]+\s+)?$|\bno\s+(?:longer\s+)?$/i

/** A clause negated from its start, which governs its verb: a negated subject ("No path calls tmux", "Nothing deletes a row", "Neither path …") or a negated imperative ("Never follow it with … a raw tmux call", "Don't …"). */
const NEGATED_SUBJECT = /^\s*(?:no|nothing|none|neither|never|don't|do not)\b/i

/** A verb whose object is negated: "proves nothing", "deletes no row". */
const NEGATED_OBJECT = /^\s*(?:nothing|no rows?)\b/i

/**
 * Whether a negation governs the verb a claim stands on: `before` is the
 * claim's clause up to the verb, `after` the text after it. A negation
 * elsewhere in the clause ("After no reply, the teardown deletes its row";
 * "means no pane is left, so the worker is gone") does not.
 */
function negationGoverns(before: string, after: string): boolean {
  return NEGATED_VERB.test(before) || NEGATED_SUBJECT.test(before) || NEGATED_OBJECT.test(after)
}

/** A clause's end: `.`, `;` or `:`, any closing emphasis, bracket or quote (`.**`, `.)`), then whitespace. */
const CLAUSE_END = /[.;:][*_)"'`]*\s/g

/** The clause of `unit` before offset `at`: from the last `CLAUSE_END` before it (a bold lead's `.** ` included). */
function clauseBefore(unit: string, at: number): string {
  const before = unit.slice(0, at)
  const ends = [...before.matchAll(CLAUSE_END)]
  const last = ends.at(-1)
  return last === undefined ? before : before.slice((last.index ?? 0) + last[0].length - 1)
}

/**
 * Each match of `claims` in `text`'s units (`textUnits`), its verb the
 * match's start, that no negation governs (`negationGoverns`), as
 * `<label>: <matched text>`: "No path in `src/` calls tmux directly", "The
 * sweep never deletes a row" and "makes no raw tmux call" pass; "Four paths
 * still call tmux directly" and "After no reply, the teardown deletes its
 * row" do not.
 */
function affirmedClaims(text: string, claims: readonly [label: string, pattern: RegExp][]): string[] {
  return textUnits(text).flatMap((unit) =>
    claims.flatMap(([label, pattern]) =>
      [...unit.matchAll(pattern)]
        .filter((m) => !negationGoverns(clauseBefore(unit, m.index ?? 0), unit.slice((m.index ?? 0) + m[0].length)))
        .map((m) => `${label}: ${m[0]}`),
    ),
  )
}

/**
 * A tmux call made by the server (SRJ-1105, SRJ-1106: neither doc describes
 * one), file-local: a raw tmux sub-command that ends, probes, starts, reads
 * or types into a session, pane or server, named with or without `tmux`
 * (agent-director's own verb `send-keys` counts only after `tmux`), and an
 * affirmed raw or direct tmux call. A human's `tmux attach -t =…` and a
 * read-only `tmux ls` are no such call.
 */
const SERVER_TMUX_CALLS: readonly [label: string, pattern: RegExp][] = [
  [
    'a tmux sub-command that ends, probes, starts, reads or types into a session',
    /\b(?:capture-pane|kill-session|kill-server|kill-pane|kill-window|has-session|new-session|start-server|respawn-pane|respawn-window|rename-session|set-option|show-options|set-environment|show-environment)\b/gi,
  ],
  ['tmux send-keys', /\btmux\s+send-keys\b/gi],
]

/** The affirmed forms of a server tmux call (`affirmedClaims`): "raw tmux calls", "calls tmux directly". */
const AFFIRMED_TMUX_CALLS: readonly [label: string, pattern: RegExp][] = [
  ['a raw tmux call', /\braw\s+`?tmux\b/gi],
  ['a direct tmux call', /\bcalls?\s+`?tmux`?\s+directly\b/gi],
]

/**
 * A row delete described as live (SRJ-1105: the delete-then-spawn, start
 * sweep and persona teardown deletes are gone; b.jg5 SRJ-716), file-local,
 * read through `affirmedClaims`.
 */
const ROW_DELETE_CLAIMS: readonly [label: string, pattern: RegExp][] = [
  ['a delete-then-spawn', /\bdelete-then-spawn\b/gi],
  ['a kill or pause, then a delete', /\b(?:kill|kills|killed|killing|pause|pauses|paused)\b[^.;]{0,80}?\band\s+(?:then\s+)?delet\w*/gi],
  ['a row deleted', /\bdelet(?:e|es|ed|ing)\s+(?:the|its|a|each|every|that|this|one)\s+(?:[\w`<>-]+\s+){0,3}?rows?\b/gi],
  ['a delete attempted', /\b(?:attempts?|tries|makes?|calls?|runs?|issues?)\s+(?:the\s+|a\s+|its\s+|one\s+)?`?delete\b/gi],
]

/** The approver's dead-state streak (SRJ-1105, SRJ-402), file-local, named at all; its constant is a `REMOVED_IDENTIFIERS` entry. */
const DEAD_STATE_STREAK_CLAIMS: readonly [label: string, pattern: RegExp][] = [
  ["the approver's dead-state streak", /\bdead-state streak\b|\b(?:polls|laps|reads) in a row\b[^.]{0,60}?\bdead\b/gi],
]

/** A pointer to an incident write-up: history, not the current rule (the docs describe only the current design). */
const HISTORY_POINTERS: readonly [label: string, pattern: RegExp][] = [['an incident write-up', /\bincident-[\w.-]+/gi]]

/** The source audit's word rules both docs keep too (SRJ-1105, SRJ-1106): the row-delete helpers, the finished-row option and the removed identifiers. */
const DOC_WORD_RULES: readonly SourceWordRule[] = ['delete-helper', 'finished-row-option', 'removed-identifier']

/** One source audit word rule's pattern; throws naming a rule `SOURCE_WORD_RULES` lacks. */
function sourceWordRule(rule: SourceWordRule): RegExp {
  const row = SOURCE_WORD_RULES.find(([name]) => name === rule)
  if (row === undefined) throw new Error(`SOURCE_WORD_RULES has no rule "${rule}"`)
  return row[1]
}

const SECURITY_MODEL_HEADING = '## Security Model'
const SOURCE_INVARIANTS_HEADING = '## Source Invariants'

/**
 * The two passages that list the row-delete helpers on purpose, so a reader
 * knows which names must never come back (b.jg5 SRJ-716; the engineering
 * guide's Source Invariants): each [file, section heading, the list item's
 * lead]. Each item, and only it, is left out before `DOC_WORD_RULES`' row
 * `delete-helper` reads its doc.
 */
const DELETE_HELPER_LISTS: readonly [file: string, heading: string, lead: string][] = [
  [ARCHITECTURE_FILE, SECURITY_MODEL_HEADING, '- no agent-director row is ever deleted:'],
  [ENGINEERING_GUIDE_FILE, SOURCE_INVARIANTS_HEADING, '- **Write no row-delete helper**'],
]

/** `text` (the doc `file`) without the one item of each `DELETE_HELPER_LISTS` entry for it; throws unless each entry finds exactly one item. */
function withoutDeleteHelperLists(file: string, text: string): string {
  return DELETE_HELPER_LISTS.filter(([listFile]) => listFile === file).reduce((rest, [, heading, lead]) => {
    const items = textUnits(requiredSection(rest, heading, file)).filter((unit) => unit.startsWith(lead))
    if (items.length !== 1) throw new Error(`${file} "${heading}": ${items.length} items open with "${lead}", expected 1`)
    const lines = rest.split('\n')
    const at = lines.findIndex((line) => line.trimStart().startsWith(lead))
    return [...lines.slice(0, at), ...lines.slice(at + 1)].join('\n')
  }, text)
}

/** Each source-audit word in `text` (the doc `file`), the `DELETE_HELPER_LISTS` items left out, as `<rule>: <word>`. */
function sourceWordsIn(file: string, text: string): string[] {
  const rest = withoutDeleteHelperLists(file, text)
  return DOC_WORD_RULES.flatMap((rule) => [...rest.matchAll(sourceWordRule(rule))].map((m) => `${rule}: ${m[0]}`))
}

/** Everything both docs must not describe as live or name: each problem as `<label>: <matched text>`. */
function staleDesignProblems(file: string, text: string): string[] {
  const flatText = withoutPrefixKeyReason(text)
  return [
    ...termsIn(flatText, SERVER_TMUX_CALLS),
    ...affirmedClaims(text, AFFIRMED_TMUX_CALLS),
    ...affirmedClaims(text, ROW_DELETE_CLAIMS),
    ...termsIn(flatText, DEAD_STATE_STREAK_CLAIMS),
    ...termsIn(flatText, HISTORY_POINTERS),
    ...sourceWordsIn(file, text),
  ]
}

// SRJ-1106: the engineering guide's rule

/** SRJ-1106's section of the engineering guide (file-local, citing SRJ-1106): its heading and its rule sentence. */
const SRJ_1106_HEADING = '## The Server Reaches a Session Only Through agent-director'
const SRJ_1106_RULE = `The server starts no tmux process and reaches a session only through agent-director, and never touches agent-director's ${vocab('ownerLabel')} label or its per-pane ${vocab('paneLabel')} label`

/** The section the old raw-tmux guidance stood under, replaced by SRJ-1106's rule. */
const OLD_RAW_TMUX_TITLE = 'Raw tmux Calls'

/** The old raw-tmux guidance's passages, file-local: its known-gap bullet and its bullet's reason that persona keys can prefix one another. */
const OLD_RAW_TMUX_GUIDANCE: readonly [label: string, pattern: RegExp][] = [
  ['the known-gap passage', /\bknown gap\b/gi],
  ['the old raw-tmux reason', /\bcan prefix one another\b/gi],
]

/** The old raw-tmux guidance in `text`: a heading titled `OLD_RAW_TMUX_TITLE`, a link to its anchor, or one of its passages. */
function oldRawTmuxGuidance(text: string): string[] {
  return [
    ...headings(text).filter((h) => h.title.toLowerCase() === OLD_RAW_TMUX_TITLE.toLowerCase()).map((h) => `heading "${h.text}"`),
    ...markdownLinks(text).filter((link) => link.anchor === headingSlug(OLD_RAW_TMUX_TITLE)).map((link) => `link (${link.target})`),
    ...termsIn(flat(text), OLD_RAW_TMUX_GUIDANCE),
  ]
}

/** What SRJ-1106's section lacks: the rule sentence, a link to Source Invariants that resolves, and the source audit by its path. */
function srj1106SectionProblems(guide: string): string[] {
  const section = flat(requiredSection(guide, SRJ_1106_HEADING, ENGINEERING_GUIDE_FILE))
  const invariants = headingSlug(SOURCE_INVARIANTS_HEADING.slice('## '.length))
  return [
    ...lacking(section, [SRJ_1106_RULE, code(SOURCE_AUDIT_FILE), `](#${invariants})`]),
    ...(headingAnchors(guide).includes(invariants) ? [] : [`no heading "${SOURCE_INVARIANTS_HEADING}" for the link`]),
  ]
}

/** Each mention of agent-director's labels (the source audit's `ad-label` rule) in the engineering guide outside SRJ-1106's section. */
function labelsOutsideRule(guide: string): string[] {
  return [...outsideSection(guide, SRJ_1106_HEADING, ENGINEERING_GUIDE_FILE).matchAll(sourceWordRule('ad-label'))].map((m) => m[0])
}

/** The engineering guide's Layering section and its two rules (the Task's hatch note: CSCB never touches tmux and never replicates agent-director). */
const LAYERING_HEADING = '## Layering: agent-director Owns tmux'
const LAYERING_RULES: readonly string[] = ['- **CSCB never touches tmux.**', '- **CSCB never replicates agent-director functionality.**']

/** What the Layering section lacks: each rule as a list item, and a link to SRJ-1106's section. */
function layeringProblems(guide: string): string[] {
  const units = textUnits(requiredSection(guide, LAYERING_HEADING, ENGINEERING_GUIDE_FILE))
  return [
    ...LAYERING_RULES.filter((rule) => !units.some((unit) => unit.startsWith(rule))).map((rule) => `no item "${rule}"`),
    ...(units.some((unit) => unit.includes(`](#${headingSlug(SRJ_1106_HEADING.slice('## '.length))})`)) ? [] : [`no link to "${SRJ_1106_HEADING}"`]),
  ]
}

const START_SWEEP_HEADING = '## The Start Sweep'

/** The Start Sweep's pre-persona-row rule (SRJ-1106, SRJ-714): the one sentence that says what a pre-persona row's kill is; it says the kill is checked and the row kept, and names no delete. */
function prePersonaRuleProblems(guide: string): string[] {
  const sentences = flat(requiredSection(guide, START_SWEEP_HEADING, ENGINEERING_GUIDE_FILE))
    .split(/(?<=\.)\s+/)
    .filter((sentence) => /\bA pre-persona row\b.*?\bkilled\b/.test(sentence))
  if (sentences.length !== 1) return [`${sentences.length} Start Sweep sentences say what a pre-persona row's kill is, expected 1`]
  return [...lacking(sentences[0], [/\bchecked\b/, /\bkept\b/]), ...(/\bdelet\w*/i.test(sentences[0]) ? [`a delete: ${sentences[0]}`] : [])]
}

// SRJ-1105: one passage per topic of the architecture doc

/** Where a topic's passage stands in the architecture doc, and how it is read (flattened). */
interface Passage {
  where: string
  read: (doc: string) => string
}

/** The section under `heading`. */
function sectionPassage(heading: HeadingMatch): Passage {
  return { where: `under ${typeof heading === 'string' ? `"${heading}"` : String(heading)}`, read: (doc) => flat(requiredSection(doc, heading, ARCHITECTURE_FILE)) }
}

/** The one unit (`textUnits`) under `heading` that opens with `lead`. */
function itemPassage(heading: HeadingMatch, lead: string): Passage {
  return {
    where: `the unit "${lead}" under ${typeof heading === 'string' ? `"${heading}"` : String(heading)}`,
    read: (doc) => {
      const units = textUnits(requiredSection(doc, heading, ARCHITECTURE_FILE)).filter((unit) => unit.startsWith(lead))
      if (units.length !== 1) throw new Error(`${ARCHITECTURE_FILE} ${String(heading)}: ${units.length} units open with "${lead}", expected 1`)
      return units[0]
    },
  }
}

const SERVER_MANAGED_STARTUP = sectionPassage(/^### Server-Managed Startup\b/)
const UNAVAILABLE_RETRY_HEADING = /^#### UNAVAILABLE retry\b/
const UNAVAILABLE_RETRY = sectionPassage(UNAVAILABLE_RETRY_HEADING)

/**
 * SRJ-1105's topics (file-local, citing SRJ-1105; the titles are the
 * architecture doc's, built from a `src/` constant where one names them):
 * each topic's passage and what it must name, every name an imported `src/`
 * export or value (`exportName`), or agent-director's vocabulary
 * (`AD_VOCABULARY`).
 */
const SRJ_1105_TOPICS: readonly [topic: string, passage: Passage, names: readonly (string | RegExp)[]][] = [
  ['the classifier', sectionPassage(/^### Agent-director error classes\b/), [exportName({ classifyAdError }), exportName({ AD_ERROR_CLASSES })]],
  ['the retry timer', UNAVAILABLE_RETRY, [exportName({ createUnavailableRetryController })]],
  ["the retry timer's pending-only mode", sectionPassage(/^#### Pending-only mode\b/), [exportName({ armPendingOnlyAfterLaunchFailure }), exportName({ UNAVAILABLE_RETRY_CONDITION_TMUX_UNAVAILABLE })]],
  ['the tmux-unresponsive condition', sectionPassage(/^#### The tmux-unresponsive condition\b/), [exportName({ createTmuxUnresponsiveCondition }), exportName({ TMUX_UNRESPONSIVE_ONSET_FLOOR_MS })]],
  [`the ${PERSONA_EPISODE_KIND_AD_CONFIG_MALFORMED} outage`, itemPassage(UNAVAILABLE_RETRY_HEADING, '**CONFIG (b.jg5 SRJ-316).**'), [code(PERSONA_EPISODE_KIND_AD_CONFIG_MALFORMED), vocab('configMalformed')]],
  ['the latch and its cases', sectionPassage(/^#### Session conflict latch\b/), [exportName({ createConflictLatch }), exportName({ recogniseConflictCase })]],
  ["the latch's re-check", sectionPassage(/^##### The re-check\b/), [exportName({ createLatchRecheckController }), exportName({ decideLatchRecheck }), exportName({ LATCH_RECHECK_INTERVAL_MS })]],
  ['how a latch clears, by hand included', sectionPassage(/^##### How a latch clears\b/), [exportName({ clearByHandOf })]],
  [`the ${CLEAR_LATCH_COMMAND} command`, sectionPassage(new RegExp(`^### ${escapeRegExp(CLEAR_LATCH_COMMAND)} command\\b`)), [code(CLEAR_LATCH_COMMAND), exportName({ dialClearLatch })]],
  [`the ${CLEAR_LATCH_ROUTE} route`, sectionPassage(new RegExp(`^### POST ${escapeRegExp(CLEAR_LATCH_ROUTE)}$`)), [exportName({ handleClearLatch }), exportName({ runLatchClearSequence })]],
  [`the ${SERVER_PORT_FILE_NAME} record`, sectionPassage(new RegExp(`^### ${escapeRegExp(SERVER_PORT_FILE_NAME)} \\(`)), [exportName({ writeServerPortRecord })]],
  [`${CLEAR_LATCH_COMMAND} is not offered to the bots`, itemPassage(SECURITY_MODEL_HEADING, `- **${code(CLEAR_LATCH_COMMAND)} is not offered to the bots**`), [/\bSRJ-511\b/]],
  ['the live-row sequence', sectionPassage(/^#### The live-row sequence\b/), [exportName({ createLiveRowSequenceRegistry }), exportName({ LIVE_ROW_SEQUENCE_MAX_KILLS })]],
  ['reuse', sectionPassage(/^#### Reuse spawn\b/), [exportName({ LAUNCH_VERB_REUSE_SPAWN })]],
  ['the retired-key record', sectionPassage(new RegExp(`^### ${escapeRegExp(RETIRED_KEYS_FILE_NAME)} \\(`)), [exportName({ RETIRED_KEYS_FORMAT_VERSION }), exportName({ serializeRetiredKeys })]],
  ['the old-life hold', sectionPassage(/^#### The old-life hold\b/), [exportName({ createOldLifeHoldSet }), exportName({ oldLifeKeyOf })]],
  ['launch pending', sectionPassage(/^### Launch pending\b/), [exportName({ PENDING_ROW_NO_LAUNCH_START }), exportName({ LAUNCH_CALL_END_LAUNCH_TIMEOUT })]],
  ['the approver through agent-director', SERVER_MANAGED_STARTUP, [exportName({ startDialogApprover }), exportName({ DIALOG_POLL_INTERVAL_MS }), /\bThe dialog approver calls no tmux: it reads and types only through agent-director\b/]],
  ['the pending-row rule', sectionPassage(/^#### The pending-row rule\b/), [exportName({ buildPendingRowRuleDeps }), exportName({ PENDING_ROW_RULE_GET_SITE })]],
  ['the stuck-launch abort', sectionPassage(/^#### CSCB's own stuck launch and its one abort\b/), [exportName({ createStuckLaunchAbort }), exportName({ abortKillOwnStuckLaunch }), exportName({ STUCK_LAUNCH_ABORT_SITE })]],
  ['the timing settings CSCB reads', SERVER_MANAGED_STARTUP, [exportName({ installAdSettings })]],
  ['the call timeout', SERVER_MANAGED_STARTUP, [exportName({ agentDirectorCallTimeoutMsOf }), exportName({ checkAdCallTimeoutAtStartup })]],
  ["the server never touches agent-director's session label or a persona's session", itemPassage(SECURITY_MODEL_HEADING, "- **agent-director's rows, labels, socket and sessions are its own**"), [vocab('ownerLabel'), /\bSRJ-612\b/]],
  ['the source audit that pins it', sectionPassage(SECURITY_MODEL_HEADING), [code(SOURCE_AUDIT_FILE), vocab('paneLabel')]],
  ['the version gate', SERVER_MANAGED_STARTUP, [exportName({ meetsPhase1Floor }), exportName({ installAdVersionRecheck })]],
  ['the CLI precheck', sectionPassage(/^### The CLI precheck\b/), [exportName({ precheckVerdictOf }), exportName({ PRECHECK_TRIES })]],
]

/** One topic's problems on `doc`: its passage missing, or each name it lacks. */
function topicProblems(passage: Passage, names: readonly (string | RegExp)[], doc: string): string[] {
  let text: string
  try {
    text = passage.read(doc)
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)]
  }
  return lacking(text, names)
}

/** Each problem's label: the text before its first `: `. */
function problemLabels(problems: readonly string[]): string[] {
  return problems.map((problem) => problem.split(': ')[0])
}

/** `text` with `paragraph` appended as a paragraph of its own. */
function withParagraph(text: string, paragraph: string): string {
  return `${text}\n\n${paragraph}\n`
}

describe('E36 T3: the architecture doc and the engineering guide match the build (b.jg5 SRJ-1105, SRJ-1106, SRJ-612; AC 78)', () => {
  describe('both docs, read through OPERATOR_TEXTS', () => {
    test.each(DESIGN_DOCS.map((file) => [file] as const))(
      '%s describes no tmux call made by the server, no live row delete, no dead-state streak and no incident write-up, and names no row-delete helper, finished-row option or removed identifier',
      (file) => {
        expect(staleDesignProblems(file, operatorText(file))).toEqual([])
      },
    )

    test.each(DESIGN_DOCS.map((file) => [file] as const))(`%s carries none of the old raw-tmux guidance (a "${OLD_RAW_TMUX_TITLE}" heading or link, the known gap)`, (file) => {
      expect(oldRawTmuxGuidance(operatorText(file))).toEqual([])
    })

    test.each(DESIGN_DOCS.map((file) => [file] as const))('%s: every link resolves (a same-file anchor to a heading in it, a relative link to a file and its heading)', (file) => {
      const { checked, broken } = brokenRepoLinks(file, operatorText(file))
      expect(broken).toEqual([])
      expect(checked).toBeGreaterThan(0)
    })
  })

  describe(`${ENGINEERING_GUIDE_FILE} (SRJ-1106)`, () => {
    const guide = () => operatorText(ENGINEERING_GUIDE_FILE)

    test(`"${SRJ_1106_HEADING}" states SRJ-1106's rule, links Source Invariants and names ${SOURCE_AUDIT_FILE}`, () => {
      expect(srj1106SectionProblems(guide())).toEqual([])
      expect(existsSync(resolve(REPO_ROOT, SOURCE_AUDIT_FILE))).toBe(true)
    })

    test(`agent-director's labels (${vocab('ownerLabel')}, ${vocab('paneLabel')}) are named only inside "${SRJ_1106_HEADING}"`, () => {
      expect(labelsOutsideRule(guide())).toEqual([])
      expect(lacking(flat(requiredSection(guide(), SRJ_1106_HEADING, ENGINEERING_GUIDE_FILE)), [vocab('ownerLabel'), vocab('paneLabel')])).toEqual([])
    })

    test(`"${LAYERING_HEADING}" keeps both rules (CSCB never touches tmux; CSCB never replicates agent-director) and links "${SRJ_1106_HEADING}"`, () => {
      expect(layeringProblems(guide())).toEqual([])
    })

    test(`"${START_SWEEP_HEADING}": the pre-persona-row rule says the kill is checked and the row kept (SRJ-714)`, () => {
      expect(prePersonaRuleProblems(guide())).toEqual([])
    })
  })

  describe(`${ARCHITECTURE_FILE} (SRJ-1105): a passage per topic, found by the src/ export it describes`, () => {
    test.each(SRJ_1105_TOPICS)('%s', (topic, passage, names) => {
      expect({ topic, where: passage.where, problems: topicProblems(passage, names, operatorText(ARCHITECTURE_FILE)) }).toEqual({ topic, where: passage.where, problems: [] })
    })
  })

  describe('self-checks (each puts old wording back into an in-memory doc, or uses a synthetic text)', () => {
    const arch = () => operatorText(ARCHITECTURE_FILE)
    const guide = () => operatorText(ENGINEERING_GUIDE_FILE)

    test.each([
      [
        'the raw-tmux passage (b.1ix)',
        "- **Raw tmux calls address one session exactly (b.1ix).** Four paths still call tmux directly: the self-heal kill (`kill-session`), the approver's pane read and Enter for an `ended`/`missing` row (`capture-pane`, `send-keys`), the liveness probe (`has-session`) and the reconnect's `start-server`.",
        ['a tmux sub-command that ends, probes, starts, reads or types into a session', 'a raw tmux call', 'a direct tmux call'],
      ],
      ['the b.m4r raw kill example', 'A bot killed mid-turn (e.g. `tmux kill-session` on its session) leaves its AD row at `working`.', ['a tmux sub-command that ends, probes, starts, reads or types into a session']],
      [
        "the approver's raw pane read and Enter",
        'For those states the loop reads the pane with raw `tmux capture-pane -p -t =slack_bot_<key>:` and sends Enter with raw `tmux send-keys -t =slack_bot_<key>: Enter`.',
        ['a tmux sub-command that ends, probes, starts, reads or types into a session', 'tmux send-keys', 'a raw tmux call'],
      ],
      ["the approver's dead-state streak", 'An `ended`/`missing` row with no needle for 20 polls in a row counts as a dead spawn.', ["the approver's dead-state streak"]],
      ['the delete-then-spawn chain', "- the kill and delete of the collision ladder's delete-then-spawn chains, all through `unusableNameAt`.", ['a delete-then-spawn']],
      ["the persona teardown's delete", 'Persona teardown acts on one removed or destructively modified persona while the server keeps running, kills its bot without waiting and deletes its row.', ['a kill or pause, then a delete']],
      ["the destructive modify's delete", '**Fresh.** The teardown kills `cscb_<key>` and deletes its agent-director row, so the launch in step 6 finds no row and spawns a new instance.', ['a kill or pause, then a delete', 'a row deleted']],
      ["the start sweep's delete", 'A failed kill of a swept row still attempts the delete.', ['a delete attempted']],
      ["the ladder's config_dir delete", "A changed directory has a different `config_dir` label, so the ladder's `config_dir` guard deletes the row and spawns fresh.", ['a row deleted']],
      ['an incident write-up', 'The rule follows the b.qps outage (see `incident-2026-09-18-clean_restart.md`).', ['an incident write-up']],
      ['the finished-row request field', 'Every kill passes `include_finished: true`.', ['finished-row-option']],
      ['the finished-row CLI flag', 'Run `agent-director kill --include-finished`.', ['finished-row-option']],
    ] as const)('%s, put back into each doc, is reported', (_label, paragraph, expected) => {
      for (const file of DESIGN_DOCS) {
        expect({ file, labels: problemLabels(staleDesignProblems(file, withParagraph(operatorText(file), paragraph))) }).toEqual({ file, labels: expect.arrayContaining([...expected]) })
      }
    })

    test('the current wording is not reported: a negated tmux call or delete, a deleted row as the reason, the exact attach, a read-only listing', () => {
      const fine = [
        'No path in `src/` calls tmux directly and no `src/` file starts a process whose command is `tmux`.',
        '- **The server starts no tmux process; its one target is exact.** No path in `src/` calls tmux directly.',
        'Never follow it with a kill of the session, a raw tmux call or a spawn retried in its place.',
        'The server makes no raw tmux call: no raw tmux path is left in `src/`.',
        'No persona teardown deletes a row, and no delete-then-spawn site is left.',
        'Why: a deleted row whose kill may have failed leaves a live session with nothing to find it by.',
        'The sweep kills only rows listed live, keeps every row it lists and makes no `delete` call on any path.',
        `Attach with \`tmux attach -t =${personaTmuxSessionName(ALERT_KEY)}\`; list sessions with \`tmux ls\`.`,
      ].join('\n\n')
      expect(staleDesignProblems('(synthetic)', fine)).toEqual([])
    })

    test.each([
      ...DELETE_HELPERS.map((name) => ['delete-helper', name] as const),
      ...REMOVED_IDENTIFIERS.map((name) => ['removed-identifier', name] as const),
    ])('the source audit word %s %s, named outside the two delete-helper lists, is reported in each doc', (rule, name) => {
      for (const file of DESIGN_DOCS) {
        expect({ file, problems: sourceWordsIn(file, withParagraph(operatorText(file), `It calls \`${name}\`.`)) }).toEqual({ file, problems: [`${rule}: ${name}`] })
      }
    })

    test.each(DELETE_HELPER_LISTS)('%s: the delete-helper list under "%s" (%s) is one item that names a helper, and is the part left out', (file, heading, lead) => {
      const text = operatorText(file)
      const item = textUnits(requiredSection(text, heading, file)).find((unit) => unit.startsWith(lead))
      expect(item === undefined ? [] : DELETE_HELPERS.filter((name) => new RegExp(`\\b${name}\\b`).test(item)).length).toBeGreaterThan(0)
      expect([...text.matchAll(sourceWordRule('delete-helper'))].length).toBeGreaterThan(0)
      expect(sourceWordsIn(file, text)).toEqual([])
    })

    test(`the old "${OLD_RAW_TMUX_TITLE}" section put back in place of SRJ-1106's fails each engineering-guide case`, () => {
      const text = guide()
      const range = sectionRange(text, SRJ_1106_HEADING)!
      const lines = text.split('\n')
      const old = [
        `## ${OLD_RAW_TMUX_TITLE}`,
        '',
        'The server makes no raw tmux call: no raw tmux path is left in `src/`.',
        '',
        '- **Address a session exactly in an operator command.** Build the target with `tmuxExactSessionTarget`; never pass a bare name. Why: tmux resolves a bare name by prefix, and persona keys can prefix one another.',
        "- **Known gap: agent-director's own tmux calls still prefix-match.** Until the b.fmk version, claim exactness only for the operator's `attach` target.",
        '',
      ]
      const edited = [...lines.slice(0, range.start), ...old, ...lines.slice(range.end)]
        .join('\n')
        .replace(`](#${headingSlug(SRJ_1106_HEADING.slice('## '.length))})`, `](#${headingSlug(OLD_RAW_TMUX_TITLE)})`)
      expect(edited).not.toBe(text)
      expect(oldRawTmuxGuidance(edited)).toEqual([
        `heading "## ${OLD_RAW_TMUX_TITLE}"`,
        `link (#${headingSlug(OLD_RAW_TMUX_TITLE)})`,
        'the known-gap passage: Known gap',
        'the old raw-tmux reason: can prefix one another',
      ])
      expect(() => srj1106SectionProblems(edited)).toThrow(SRJ_1106_HEADING)
      expect(layeringProblems(edited)).toEqual([`no link to "${SRJ_1106_HEADING}"`])
    })

    test("SRJ-1106's rule sentence reverted to the old raw-tmux intro is reported", () => {
      const text = guide()
      const edited = text.replace(SRJ_1106_RULE, 'The server makes no raw tmux call')
      expect(edited).not.toBe(text)
      expect(srj1106SectionProblems(edited)).toEqual([`lacks ${SRJ_1106_RULE}`])
    })

    test(`a label named in "${SOURCE_INVARIANTS_HEADING}", as the ad-label bullet once did, is reported`, () => {
      const text = guide()
      const edited = text.replace(/^(- \*\*Never name agent-director's labels\*\*[^\n]*)/m, `$1 Never write ${vocab('ownerLabel')} or ${vocab('paneLabel')}.`)
      expect(edited).not.toBe(text)
      expect(labelsOutsideRule(edited)).toHaveLength(2)
    })

    test.each(LAYERING_RULES.map((rule) => [rule] as const))(`"${LAYERING_HEADING}" without the rule %s is reported`, (rule) => {
      const text = guide()
      const edited = text.replace(new RegExp(`^${escapeRegExp(rule)}[^\\n]*\\n`, 'm'), '')
      expect(edited).not.toBe(text)
      expect(layeringProblems(edited)).toEqual([`no item "${rule}"`])
    })

    test.each([
      ['the kill unchecked and the row deleted', 'A pre-persona row (b.1ix) is killed when live, then deleted.', ['lacks /\\bchecked\\b/', 'lacks /\\bkept\\b/', 'a delete']],
      ['the kill unchecked', 'A pre-persona row (b.1ix) is killed when live, and kept.', ['lacks /\\bchecked\\b/']],
    ] as const)("the Start Sweep's pre-persona-row rule with %s is reported", (_label, sentence, expected) => {
      const text = guide()
      const edited = text.replace(/A pre-persona row \(b\.1ix\) is killed when live[^.]*\./, sentence)
      expect(edited).not.toBe(text)
      expect(prePersonaRuleProblems(edited).map((problem) => problem.split(': ')[0])).toEqual([...expected])
    })

    test.each(SRJ_1105_TOPICS)('SRJ-1105 topic "%s" fails once each name it pins is gone from the doc', (_topic, passage, names) => {
      const edited = names.reduce<string>(
        (text, name) => (typeof name === 'string' ? text.split(name).join(name.replace(/`$/, '_GONE`')) : text.replace(new RegExp(name.source, 'g'), '')),
        arch(),
      )
      expect(topicProblems(passage, names, edited)).toHaveLength(names.length)
    })

    test('a topic whose heading or item is gone is one problem, not a throw', () => {
      expect(topicProblems(sectionPassage('### No such section'), [], arch())).toEqual([`${ARCHITECTURE_FILE} has no heading "### No such section"`])
      expect(topicProblems(itemPassage(SECURITY_MODEL_HEADING, '- **No such item**'), [], arch())).toHaveLength(1)
    })

    test("AD_VOCABULARY's label rows are what the source audit's ad-label rule finds", () => {
      expect([...`${vocab('ownerLabel')} ${vocab('paneLabel')}`.matchAll(sourceWordRule('ad-label'))]).toHaveLength(2)
    })

    test('a broken relative link from docs/ is reported, a resolving one is not', () => {
      const readmeAnchor = headingSlug(PERSONAS_HEADING.slice('### '.length))
      expect(brokenRepoLinks(ARCHITECTURE_FILE, `See [the README](../README.md#${readmeAnchor}) and [gone](../README.md#no-such-heading).`).broken).toEqual([
        `${ARCHITECTURE_FILE} -> ../README.md#no-such-heading (no such heading in ../README.md)`,
      ])
    })
  })
})

// ---------------------------------------------------------------------------
// E36 T4: SRJ-1101's term and placement checks over every operator text, the
// layering rule's tmux allow-list, and SRJ-1103's README and SRJ-1104's
// debugging-skill sections (b.jg5 SRJ-1101, SRJ-1103, SRJ-1104; SRJ-1105 and
// SRJ-1106 through the term checks; AC 78, AC 79), read through OPERATOR_TEXTS
// ---------------------------------------------------------------------------

/**
 * SRJ-1101's terms (file-local, citing SRJ-1101's Test line and the Task's
 * hatch notes): `has-session`, `tmux-kill`, `agent-director delete`,
 * `find-missing --timeout`, the finished-row option in both spellings
 * (`include_finished` beside `include-finished`, the orchestrator's hatch
 * note), and tmux's two other raw kills, `kill-pane` and `kill-server`
 * (`tmux kill-session` is placed by its own case). Case-insensitive, a space
 * matching any whitespace, so a term wrapped across lines is found.
 */
const SRJ_1101_TERMS: readonly Term[] = [
  ['has-session', /\bhas-session\b/gi],
  ['tmux-kill', /\btmux-kill\b/gi],
  ['agent-director delete', /\bagent-director\s+delete\b/gi],
  ['find-missing --timeout', /\bfind-missing\s+--timeout\b/gi],
  ['include-finished', /\binclude-finished\b/gi],
  ['include_finished', /\binclude_finished\b/gi],
  ['kill-pane', /\bkill-pane\b/gi],
  ['kill-server', /\bkill-server\b/gi],
]

/**
 * The raw-command advice the E8 note removed that SRJ-1101's own checks do
 * not name (file-local): an `agent-director kill` with a positional id rather
 * than `--claude-instance-id` (a log line's "`agent-director kill of …`" is
 * no command), and kill-and-respawn advice, checked over every operator text.
 * The note's other forms are this section's own checks: `has-session`,
 * `tmux-kill` and `kill-server` (`SRJ_1101_TERMS`), an attach target without
 * `=` (`unexactAttaches`) and `tmux kill-session` (`killSessionsOutsideSteps`).
 * A space matches any whitespace, so a wrapped form is found in raw text.
 */
const RAW_COMMAND_FORMS: readonly Term[] = [
  ['`agent-director kill` without --claude-instance-id', /`agent-director\s+kill\s+(?!--claude-instance-id\b|of\b)[^`]*`/g],
  ['kill-and-respawn advice', /\bkill(?:s|ed|ing)?\s*(?:and|\+|\/)\s*respawn\w*/gi],
]

/** Each [start, end) offset of `span` in `text`, a space in it matching any whitespace. Pure. */
function spanOffsets(text: string, span: string): [start: number, end: number][] {
  return [...text.matchAll(new RegExp(escapeRegExp(span.trim()).replace(/ /g, '\\s+'), 'g'))].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length])
}

/** `findTermsAt`'s hits of `terms` in `text` that start inside no occurrence of `spans`. Pure. */
function hitsOutsideSpans(file: string, text: string, terms: readonly Term[], spans: readonly string[]): { hit: TermHit; index: number }[] {
  const offsets = spans.flatMap((span) => spanOffsets(text, span))
  return findTermsAt(file, text, terms).filter(({ index }) => !offsets.some(([start, end]) => index >= start && index < end))
}

/** The prefix-key reason's spans (`PREFIX_KEY_REASON_SPANS`), built: the one place an operator text may show an attach without `=` (SRJ-1102). */
function prefixKeyReasonSpans(): string[] {
  return PREFIX_KEY_REASON_SPANS.map(([, span]) => span())
}

/** A raw tmux session kill, wrapped or not; SRJ-1101 allows it only in switch-over steps 5 and 6, with `=`. */
const KILL_SESSION: Term = ['tmux kill-session', /\btmux\s+kill-session\b/gi]

/** The switch-over steps SRJ-1101 lets name `tmux kill-session -t =<name>` (SRJ-1108 steps 5 and 6). */
const KILL_SESSION_STEPS: readonly number[] = [5, 6]

/** The files that carry the switch-over runbook (`SWITCH_OVER_CARRIERS`' names). */
const SWITCH_OVER_CARRIER_FILES: readonly string[] = SWITCH_OVER_CARRIERS.map(([name]) => name)

/**
 * The 0-based [start, end) line ranges, in `text` (a carrier's whole file),
 * of switch-over `steps`: each step's heading line to the end of its text, as
 * the shared step reader (`runbookSteps`) reads the file's first
 * `SWITCH_OVER_HEADING` section (the README's, or the CHANGELOG release
 * entry's copy, the only one in the file) with all `SWITCH_OVER_STEP_COUNT`
 * steps. Throws naming the file when the section is missing, and the file,
 * the section and the step as the reader does.
 */
function switchOverStepRanges(file: string, text: string, steps: readonly number[]): { start: number; end: number }[] {
  const section = sectionRange(text, SWITCH_OVER_HEADING)
  if (section === undefined) throw new Error(`${file} has no heading "${SWITCH_OVER_HEADING}"`)
  const body = text.split('\n').slice(section.start + 1, section.end).join('\n')
  const read = runbookSteps(body, { count: SWITCH_OVER_STEP_COUNT, level: SWITCH_OVER_HEADING.indexOf(' ') + 1, name: `${file} "${SWITCH_OVER_HEADING}"` })
  return steps.map((n) => {
    const start = section.start + 1 + read[n - 1].line
    return { start, end: start + 1 + read[n - 1].text.split('\n').length }
  })
}

/** Each `tmux kill-session` in `text` (the operator text `file`) outside switch-over steps 5 and 6, which only the runbook's carriers hold. Pure. */
function killSessionsOutsideSteps(file: string, text: string): TermHit[] {
  const ranges = SWITCH_OVER_CARRIER_FILES.includes(file) ? switchOverStepRanges(file, text, KILL_SESSION_STEPS) : []
  return findTerms(file, text, [KILL_SESSION]).filter((hit) => !ranges.some((range) => hit.line > range.start && hit.line <= range.end))
}

/** A `tmux attach -t` (or `attach-session -t`) target without `=` (SRJ-1101, SRJ-1102; the E8 note), wrapped, for the raw text of every operator text. */
const UNEXACT_ATTACH: Term = ['a tmux attach target without =', /\btmux\s+attach(?:-session)?\s+-t\s*(?!=)[^\s`]+/g]

/** Each `tmux attach -t` (or `attach-session -t`) without `=` in `text`, outside `spans` (the prefix-key reason's, by default). Pure. */
function unexactAttaches(file: string, text: string, spans: readonly string[] = prefixKeyReasonSpans()): string[] {
  return hitsOutsideSpans(file, text, [UNEXACT_ATTACH], spans).map(({ hit }) => formatHit(hit))
}

/**
 * tmux's commands (file-local; tmux(1), COMMANDS, tmux 3.2 and later): each
 * command's name and its documented alias. A fact of tmux, which neither CSCB
 * nor agent-director defines, so it sits here rather than in `AD_VOCABULARY`.
 * A word after `tmux` that is none of these ("tmux session", "tmux server
 * changed") is prose, not a command.
 */
const TMUX_COMMAND_NAMES: readonly string[] = [
  'attach-session', 'attach', 'bind-key', 'bind', 'break-pane', 'breakp', 'capture-pane', 'capturep', 'choose-buffer', 'choose-client',
  'choose-tree', 'clear-history', 'clearhist', 'clear-prompt-history', 'clearphist', 'clock-mode', 'command-prompt', 'confirm-before',
  'confirm', 'copy-mode', 'customize-mode', 'delete-buffer', 'deleteb', 'detach-client', 'detach', 'display-menu', 'menu',
  'display-message', 'display', 'display-panes', 'displayp', 'display-popup', 'popup', 'find-window', 'findw', 'has-session', 'has',
  'if-shell', 'if', 'join-pane', 'joinp', 'kill-pane', 'killp', 'kill-server', 'kill-session', 'kill-window', 'killw', 'last-pane',
  'lastp', 'last-window', 'last', 'link-window', 'linkw', 'list-buffers', 'lsb', 'list-clients', 'lsc', 'list-commands', 'lscm',
  'list-keys', 'lsk', 'list-panes', 'lsp', 'list-sessions', 'ls', 'list-windows', 'lsw', 'load-buffer', 'loadb', 'lock-client',
  'lockc', 'lock-server', 'lock', 'lock-session', 'locks', 'move-pane', 'movep', 'move-window', 'movew', 'new-session', 'new',
  'new-window', 'neww', 'next-layout', 'nextl', 'next-window', 'next', 'paste-buffer', 'pasteb', 'pipe-pane', 'pipep',
  'previous-layout', 'prevl', 'previous-window', 'prev', 'refresh-client', 'refresh', 'rename-session', 'rename', 'rename-window',
  'renamew', 'resize-pane', 'resizep', 'resize-window', 'resizew', 'respawn-pane', 'respawnp', 'respawn-window', 'respawnw',
  'rotate-window', 'rotatew', 'run-shell', 'run', 'save-buffer', 'saveb', 'select-layout', 'selectl', 'select-pane', 'selectp',
  'select-window', 'selectw', 'send-keys', 'send', 'send-prefix', 'server-access', 'set-buffer', 'setb', 'set-environment', 'setenv',
  'set-hook', 'set-option', 'set', 'set-window-option', 'setw', 'show-buffer', 'showb', 'show-environment', 'showenv', 'show-hooks',
  'show-messages', 'showmsgs', 'show-options', 'show', 'show-prompt-history', 'showphist', 'show-window-options', 'showw',
  'source-file', 'source', 'split-window', 'splitw', 'start-server', 'start', 'suspend-client', 'suspendc', 'swap-pane', 'swapp',
  'swap-window', 'swapw', 'switch-client', 'switchc', 'unbind-key', 'unbind', 'unlink-window', 'unlinkw', 'wait-for', 'wait',
]

/** A tmux command in a text: `tmux`, any global flags (`-L <name>`, `-S <path>`), then one of `TMUX_COMMAND_NAMES` as a whole word, wrapped or not. */
const TMUX_COMMAND: RegExp = new RegExp(
  `\\btmux(?:\\s+-[A-Za-z0-9]+(?:\\s+(?!-)[^\\s\`]+)?)*?\\s+(?:${[...TMUX_COMMAND_NAMES].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})(?![\\w-])`,
  'gi',
)

/**
 * The layering rule's allow-list (the Task's ruling, citing the engineering
 * guide's "CSCB never touches tmux"; file-local): the tmux commands an
 * operator text may name, each a human's read-only or exact-target command.
 * The exact-target attach (SRJ-1101); the runbooks' read-only `tmux ls`,
 * `tmux list-windows -a` or `-t =<name>` and `tmux display-message -p`
 * (SRJ-1108 steps 1 and 5); and the exact-name `tmux kill-session -t =` of
 * switch-over steps 5 and 6, whose placement its own case checks. Each form
 * is matched against a command's text from `tmux` on, flattened; a command
 * matching none, global flags included, is off the list.
 */
const TMUX_ALLOWED_FORMS: readonly [form: string, pattern: RegExp][] = [
  ['`tmux attach -t =<name>` (SRJ-1101)', /^tmux\s+attach(?:-session)?\s+-t\s*=/i],
  ['`tmux ls`, read-only (SRJ-1108 steps 1 and 5)', /^tmux\s+ls(?![\w-])/i],
  ['`tmux list-windows -a` or `-t =<name>`, read-only (SRJ-1108 step 5)', /^tmux\s+list-windows\s+(?:-a(?![\w-])|-t\s*=)/i],
  ['`tmux display-message -p …`, read-only (SRJ-1108 step 1)', /^tmux\s+display-message\s+-p(?![\w-])/i],
  ['`tmux kill-session -t =<name>` (SRJ-1101: switch-over steps 5 and 6 only)', /^tmux\s+kill-session\s+-t\s*=/i],
]

/** Each tmux command in `text` that no `TMUX_ALLOWED_FORMS` form allows, outside `spans` (the prefix-key reason's, by default), with file and line. Pure. */
function offListTmuxCommands(file: string, text: string, spans: readonly string[] = prefixKeyReasonSpans()): string[] {
  return hitsOutsideSpans(file, text, [['a tmux command off the allow-list', TMUX_COMMAND]], spans)
    .filter(({ index }) => {
      const command = flat(text.slice(index, index + 200))
      return !TMUX_ALLOWED_FORMS.some(([, form]) => form.test(command))
    })
    .map(({ hit }) => formatHit(hit))
}

/**
 * SRJ-613's claim (file-local, citing SRJ-613 and SRJ-1101): that a pane, a
 * `read-pane` answer or a GONE (`ErrTmuxCaptureFailed`) proves, shows or
 * means a worker gone. Its groups: the `subject` up to the verb, the `verb`,
 * and the `object` up to the gone word, which holds no negated verb of its
 * own (so a later "does not prove … gone" is read with its own verb). A match
 * whose verb a negation governs (`negationGoverns`: "does not prove the
 * worker gone", "proves nothing … gone") is the caveat, not the claim; a
 * negation elsewhere ("means no pane is left, so the worker is gone") is not.
 */
const GONE_AS_PROOF: readonly [label: string, pattern: RegExp][] = [
  [
    'a pane, a read-pane answer or a GONE taken as proof the worker is gone',
    /\b(?<subject>(?:GONE|ErrTmuxCaptureFailed|panes?|read-pane)\b[^.;:]{0,80}?)\b(?<verb>proves?|proof|confirms?|shows?|means?)\b(?<object>(?:(?!\b(?:not|never|cannot)\b|n't\b)[^.;:]){0,60}?)\b(?:gone|dead|exited|not running)\b/g,
  ],
]

/** Each affirmed `GONE_AS_PROOF` claim in `text`'s units, as `<label>: <matched text>`. Pure. */
function goneAsProofClaims(text: string): string[] {
  return textUnits(text).flatMap((unit) =>
    GONE_AS_PROOF.flatMap(([label, pattern]) =>
      [...unit.matchAll(pattern)]
        .filter((m) => !negationGoverns(`${clauseBefore(unit, m.index ?? 0)}${m.groups?.subject ?? ''}`, m.groups?.object ?? ''))
        .map((m) => `${label}: ${m[0]}`),
    ),
  )
}

/** An instruction to kill a row's worker: the backticked `agent-director kill --claude-instance-id …`, the id after a space or `=` (a log line's `agent-director kill of …` is no instruction). */
const KILL_INSTRUCTION = /`agent-director kill --claude-instance-id[=\s][^`]*`/g

/** A fenced command line that runs `agent-director kill`, in any form: a fenced block carries no sentence that checks its result. */
const FENCED_KILL = /^\s*(?:\$\s+)?(?:\S*\/)?agent-director\s+kill\b/m

/** SRJ-1101: an `agent-director kill` named with its result checked. */
const CHECKS_THE_RESULT = /\bcheck(?:s|ed|ing)? (?:the|its) result\b/i

/** SRJ-1101: the README's advice to kill a leftover worker adds "check the result; on an error, don't delete or respawn". */
const CHECKS_AND_DOES_NOT_DELETE = /\bchecks? (?:the|its) result; on an error, don't delete or respawn\b/i

/** The rest of the sentence of flattened `text` from offset `at`: up to its next full stop followed by whitespace, or the end. */
function sentenceAfter(text: string, at: number): string {
  const rest = text.slice(at)
  const end = rest.search(/\.(?:\s|$)/)
  return end < 0 ? rest : rest.slice(0, end)
}

/** Each `KILL_INSTRUCTION` in `text` whose sentence does not match `rule`, with that sentence, and each fenced block that runs `agent-director kill` (`FENCED_KILL`). Pure. */
function killAdviceProblems(text: string, rule: RegExp): string[] {
  const flatText = flat(text)
  return [
    ...[...flatText.matchAll(KILL_INSTRUCTION)]
      .map((m) => `${m[0]}${sentenceAfter(flatText, (m.index ?? 0) + m[0].length)}`)
      .filter((sentence) => !rule.test(sentence)),
    ...splitFences(text).blocks.filter((block) => FENCED_KILL.test(block.body)).map((block) => `a fenced \`agent-director kill\`: ${flat(block.body).trim()}`),
  ]
}

/** A notice's title: the words between its first pair of `*`. Throws on a text with none. */
function noticeTitle(text: string): string {
  const m = /\*([^*]+)\*/.exec(text)
  if (m === null) throw new Error(`no *title* in: ${text.slice(0, 80)}`)
  return m[1]
}

/**
 * The Slack notices README "Troubleshooting" gives an entry each (SRJ-1103:
 * the retry timer's, `tmux-unresponsive`'s, the kill-failure alert's two
 * versions and the other new notices), each title rendered by the `src/`
 * builder or head that posts it.
 */
const TROUBLESHOOTING_NOTICES: readonly [source: string, title: () => string][] = [
  ['tmuxUnresponsiveOnsetText', () => noticeTitle(tmuxUnresponsiveOnsetText(ALERT_KEY))],
  ['tmuxUnresponsiveAlertText', () => noticeTitle(tmuxUnresponsiveAlertText(ALERT_KEY, TMUX_UNRESPONSIVE_ONSET_FLOOR_MS))],
  ['tmuxUnresponsiveRecoveryText', () => noticeTitle(tmuxUnresponsiveRecoveryText(ALERT_KEY))],
  ['slowRecoveryText', () => noticeTitle(slowRecoveryText(ALERT_KEY))],
  ['STUCK_LAUNCH_RELAUNCHING_HEAD', () => noticeTitle(STUCK_LAUNCH_RELAUNCHING_HEAD)],
  ['STUCK_LAUNCH_HELD_HEAD', () => noticeTitle(STUCK_LAUNCH_HELD_HEAD)],
  ["ONSET_TEMPLATES['tmux-unavailable']", () => noticeTitle(ONSET_TEMPLATES['tmux-unavailable']())],
  ['tmuxServerChangedOnset', () => noticeTitle(tmuxServerChangedOnset())],
  ['CONFLICT_NOTICE_FIRST_LINE_HEAD', () => noticeTitle(CONFLICT_NOTICE_FIRST_LINE_HEAD)],
  ['UNUSABLE_NAME_NOTICE_HEAD', () => noticeTitle(UNUSABLE_NAME_NOTICE_HEAD)],
  ['LAUNCH_START_NOTICE_HEAD', () => noticeTitle(LAUNCH_START_NOTICE_HEAD)],
  ['INVALID_FLAGS_HOLD_ALERT_TEXT', () => noticeTitle(INVALID_FLAGS_HOLD_ALERT_TEXT)],
  ...killFailureAlertRenderings()
    .filter(({ content }, i, all) => all.findIndex((r) => r.content.version === content.version) === i)
    .map(({ content }): [string, () => string] => [`killFailureAlertText (${content.version})`, () => noticeTitle(killFailureAlertText(content, KILL_FAILURE_CLOSING_DESTINATION, true))]),
  ["ONSET_TEMPLATES['ad-config-malformed']", () => noticeTitle(ONSET_TEMPLATES['ad-config-malformed']())],
  ['unclassifiedErrorAlertText', () => noticeTitle(unclassifiedErrorAlertText({ reportedName: undefined, message: '' }))],
]

/** The README Troubleshooting section's entries: each bold title line (`**…**` alone on its line) with its text up to the next, flattened. Pure. */
function troubleshootingEntries(readme: string): { title: string; text: string }[] {
  const entries: { title: string; lines: string[] }[] = []
  for (const line of requiredSection(readme, TROUBLESHOOTING_HEADING, 'README.md').split('\n')) {
    if (/^\*\*.+\*\*\s*$/.test(line)) entries.push({ title: line.trim(), lines: [] })
    else entries.at(-1)?.lines.push(line)
  }
  return entries.map(({ title, lines }) => ({ title, text: flat(lines.join('\n')).trim() }))
}

/** The one Troubleshooting entry whose title holds `titlePart`, its title and text flattened; throws unless exactly one does. */
function troubleshootingEntry(readme: string, titlePart: string): string {
  const entries = troubleshootingEntries(readme).filter((entry) => entry.title.includes(titlePart))
  if (entries.length !== 1) throw new Error(`README.md "${TROUBLESHOOTING_HEADING}": ${entries.length} entries' titles hold "${titlePart}", expected 1`)
  return `${entries[0].title} ${entries[0].text}`
}

/** A section of `file`'s text under `heading`, flattened (a row's passage). */
const sectionOf = (file: string, heading: HeadingMatch) => (text: string) => flat(requiredSection(text, heading, file))

/** The one unit (`textUnits`) of `file`'s section under `heading` that opens with `lead`, link targets dropped (a row's passage). */
const unitOf = (file: string, heading: HeadingMatch, lead: string) => (text: string) => {
  const units = textUnits(requiredSection(text, heading, file)).filter((unit) => unit.startsWith(lead))
  if (units.length !== 1) throw new Error(`${file} ${String(heading)}: ${units.length} units open with "${lead}", expected 1`)
  return linkTexts(units[0])
}

/** The Troubleshooting entry whose title holds `*<title>*` (a row's passage). */
const entryOf = (title: () => string) => (readme: string) => troubleshootingEntry(readme, `*${title()}*`)

/**
 * An item a row's passage must hold: a literal, a pattern, or a thunk that
 * builds one when the row runs (a quote rendered by a `src/` builder), so a
 * builder whose wording changes fails only its own row, never the whole file
 * at collection.
 */
type DocItem = string | RegExp | (() => string | RegExp)

/** One row: an element, the passage of its text it sits in, and the items the passage must hold. */
type DocRow = readonly [element: string, passage: (text: string) => string, required: readonly DocItem[]]

/** `item` as a literal or pattern: a thunk's answer, else `item` itself. Throws what the thunk throws. */
function resolveItem(item: DocItem): string | RegExp {
  return typeof item === 'function' ? item() : item
}

/** A row's problems on `text`: its passage missing, each item that cannot be built (its error), or each item it lacks. */
function docRowProblems(passage: (text: string) => string, required: readonly DocItem[], text: string): string[] {
  const unbuilt: string[] = []
  const items = required.flatMap((item) => {
    try {
      return [resolveItem(item)]
    } catch (err) {
      unbuilt.push(err instanceof Error ? err.message : String(err))
      return []
    }
  })
  let found: string
  try {
    found = passage(text)
  } catch (err) {
    return [...unbuilt, err instanceof Error ? err.message : String(err)]
  }
  return [...unbuilt, ...lacking(found, items)]
}

/** What a cut leaves in place of a letter or digit: a character no item holds. */
const CUT_MARK = '¤'

/** What may stand between two words of an item in a doc's raw text: the end of an inline link's text (`](target)`), whitespace (a wrap), the start of a link (`[`). */
const RAW_GAP = String.raw`(?:\]\([^)\s]*\))?\s+\[?`

/** `source` (a RegExp's) with each literal space matching `RAW_GAP`, and any whitespace inside a character class. */
function rawGapSource(source: string): string {
  let out = ''
  let inClass = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (c === '\\') {
      out += source.slice(i, i + 2)
      i++
    } else if (c === ' ') {
      out += inClass ? String.raw`\s` : RAW_GAP
    } else {
      if (c === '[') inClass = true
      else if (c === ']') inClass = false
      out += c
    }
  }
  return out
}

/**
 * `doc` with `item` cut from its row's passage, for a self-check that runs
 * the row's real check on an edited document. Each occurrence of `item` in
 * `doc`'s raw text is found as the passage reads it (`rawGapSource`: a wrapped
 * item, or one whose word closes an inline link, which `unitOf` reads as its
 * text); only the occurrences the passage reads are cut: cutting the one
 * occurrence changes the passage, which is still found (an occurrence the
 * passage is found by, such as its heading, is left). Each is cut by its last
 * letter or digit becoming `CUT_MARK`, so the text around it stays. Throws
 * when the passage reads no occurrence. Pure.
 */
function withItemCut(doc: string, passage: (text: string) => string, item: string | RegExp): string {
  const source = typeof item === 'string' ? escapeRegExp(item) : item.source
  const flags = typeof item === 'string' ? 'g' : `${item.flags.replace('g', '')}g`
  const pattern = new RegExp(rawGapSource(source), flags)
  const cut = (text: string, m: RegExpMatchArray): string => {
    const last = m[0].search(/[\p{L}\p{N}](?=[^\p{L}\p{N}]*$)/u)
    if (last < 0) throw new Error(`${String(item)} holds no letter or digit to cut`)
    const at = (m.index ?? 0) + last
    return `${text.slice(0, at)}${CUT_MARK}${text.slice(at + 1)}`
  }
  const original = passage(doc)
  const readsIt = (m: RegExpMatchArray): boolean => {
    try {
      return passage(cut(doc, m)) !== original
    } catch {
      return false
    }
  }
  const inPassage = [...doc.matchAll(pattern)].filter(readsIt)
  if (inPassage.length === 0) throw new Error(`the passage reads no occurrence of ${String(item)} in the document as written`)
  return inPassage.reduce((text, m) => cut(text, m), doc)
}

/** A notice title from `TROUBLESHOOTING_NOTICES` by its source. */
function troubleshootingNoticeTitle(source: string): () => string {
  const row = TROUBLESHOOTING_NOTICES.find(([name]) => name === source)
  if (row === undefined) throw new Error(`TROUBLESHOOTING_NOTICES has no source "${source}"`)
  return row[1]
}

/** A number written as the README writes a range bound: thousands joined by `_` (`3_600_000`). */
function underscored(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '_')
}

/**
 * The startup call-timeout warning as the README shows it (SRJ-213): the line
 * `buildAdCallTimeoutWarningLine` renders at the defaults for a value one
 * below the need, with the value, the need and the ceiling's name replaced by
 * the README's placeholders `<value>`, `<need>` and `<verb>`. Throws when a
 * placeholder's place is not found, so a reworded line fails naming it.
 */
function callTimeoutWarningTemplate(): string {
  const { needMs } = adCallTimeoutNeed(DEFAULT_AD_SETTINGS_IN_EFFECT)
  const value = Number(needMs - 1n)
  const line = buildAdCallTimeoutWarningLine(value, DEFAULT_AD_SETTINGS_IN_EFFECT)
  if (line === undefined) throw new Error(`buildAdCallTimeoutWarningLine renders no line for ${value}, one below the need of ${needMs} ms`)
  const places: [from: RegExp, to: string][] = [
    [new RegExp(` is ${value},`), ' is <value>,'],
    [new RegExp(` of ${needMs} ms `), ' of <need> ms '],
    [/\(the \S+ ceiling /, '(the <verb> ceiling '],
  ]
  return places.reduce((text, [from, to]) => {
    if (!from.test(text)) throw new Error(`the call-timeout warning has no ${String(from)}: ${line}`)
    return text.replace(from, to)
  }, line)
}

/** The README's clear-latch CLI entry heading. */
const CLEAR_LATCH_CLI_HEADING = `### \`claude-slack-channel-bots ${CLEAR_LATCH_COMMAND}\``

/** The all-interfaces `bind`, the other value through which `clear-latch` reaches the server (SRJ-510); the loopback one is `CLEAR_LATCH_DIAL_HOST`. */
const ALL_INTERFACES_BIND = '0.0.0.0'

/** The README section and subsection the call-timeout entry sits in (SRJ-1103: under "Configuration"). */
const CONFIGURATION_HEADING = '## Configuration'
const CALL_TIMEOUT_SIZING_HEADING = '#### Sizing the agent-director call timeout'

/** The README's timing-settings section (SRJ-209, SRJ-1103). */
const TIMING_SETTINGS_HEADING = "### agent-director's timing settings"

/** The README's prerequisites section. */
const PREREQUISITES_HEADING = '## Prerequisites'

/** The re-check interval in the words the docs use: "every 2 minutes" (`LATCH_RECHECK_INTERVAL_MS`, SRJ-505). */
const LATCH_RECHECK_WORDS = `every ${LATCH_RECHECK_INTERVAL_MS / 60_000} minutes`

/**
 * SRJ-1103's README rows (AC 78, AC 79): the prerequisites, one row per item;
 * then one row per section SRJ-1103 names. Values CSCB defines are imported;
 * agent-director's from `AD_VOCABULARY`. Each row is self-checked below: each
 * item cut from its passage is reported, and the rows SRJ-1103's Test line
 * names fail on the README with that item reverted.
 */
const README_SRJ_1103_ROWS: readonly DocRow[] = [
  // The prerequisites.
  [`prerequisites: Claude Code ${MIN_CLAUDE_CODE_VERSION} or later for the workers (MIN_CLAUDE_CODE_VERSION), the minimum agent-director states for its exec-form hooks and the fleet's version (RN-9; HO rev 31; SRJ-1304)`, unitOf('README.md', PREREQUISITES_HEADING, '- [Claude Code]'), [
    `Claude Code ${MIN_CLAUDE_CODE_VERSION} or later for the workers`,
    ci('installed and authenticated'),
    ci('the minimum agent-director states for its exec-form hooks'),
    ci('the version the fleet runs'),
  ]],
  ['prerequisites: agent-director Phase 1 or later, installed system-wide', unitOf('README.md', PREREQUISITES_HEADING, '- [`agent-director`]'), [
    ci('`agent-director` Phase 1 or later'),
    ci('installed system-wide'),
  ]],
  ['prerequisites: this release and agent-director Phase 1 are installed, and rolled back, together; CSCB changes no agent-director code (SRJ-1515)', unitOf('README.md', PREREQUISITES_HEADING, '- [`agent-director`]'), [
    ci('installed on the host together with it, and the two are rolled back together'),
    ci('CSCB changes no agent-director code'),
  ]],
  ['prerequisites: every agent and long-running agent-director process stopped before either binary change and started again after it (HO C15; ADA question 9)', unitOf('README.md', PREREQUISITES_HEADING, '- [`agent-director`]'), [
    ci(`every agent on the host, with every long-running agent-director process (${code('agent-director serve')} included), is stopped before either binary change`),
    ci("the Phase 1 install, and the rollback's restore of the previous binary"),
    ci('and started again after it'),
  ]],
  [`prerequisites: tmux ${vocab('tmuxMinimum')} or later, with remain-on-exit off (HO rev 17)`, unitOf('README.md', PREREQUISITES_HEADING, '- [tmux]'), [
    ci(`tmux ${vocab('tmuxMinimum')} or later, with ${vocab('remainOnExit')} off`),
  ]],
  ['prerequisites: agent-director depends on neither base-index nor pane-base-index (HO rev 17)', unitOf('README.md', PREREQUISITES_HEADING, '- [tmux]'), [
    ci(`agent-director does not depend on tmux's ${code(vocab('baseIndex'))} or ${code(vocab('paneBaseIndex'))}`),
  ]],

  // Migration, beside the runbooks.
  ["Migration: the find-missing job runs as the workers' user and resolves their tmux socket (C7, C19)", sectionOf('README.md', MIGRATION_HEADING), [
    ci("the job must run as the workers' user and resolve their tmux socket"),
    ci('the socket switch-over step 1 pins'),
  ]],
  ["Migration: a host that follows the switch-over runbook runs a periodic sweep, which switch-over step 11 (linked) adds where the host has none; it runs as a cron entry, a systemd timer or a loop script, the runbook's sweep schedule (b.3ut)", sectionOf('README.md', MIGRATION_HEADING), [
    ci('a host that follows the switch-over runbook runs one'),
    '[switch-over step 11](#step-11-schedule-the-daily-expire) adds it where the host has none',
    ci("run it as a cron entry, a systemd timer or a loop script (the switch-over runbook calls this the host's sweep schedule)"),
  ]],

  // Destructive changes: the retired persona, no delete, checked kills.
  ['Destructive changes: a removed, renamed or destructively modified persona is retired, never resumed, and a re-add starts fresh', sectionOf('README.md', '### Destructive changes'), [
    ci("a retired persona's session is stopped and never resumed"),
    ci('a persona removed and added again with the same key, or renamed and then renamed back, always starts a new conversation'),
  ]],
  ["Destructive changes: CSCB never deletes a row and checks every kill; a removed persona's row is kept until expire", sectionOf('README.md', '### Destructive changes'), [
    ci('CSCB never deletes an agent-director row, and it checks the result of every kill it makes'),
    ci("a removed persona's row stays until agent-director's `expire` removes it, and is never resumed"),
  ]],

  // The latch.
  [`the *${troubleshootingNoticeTitle('CONFLICT_NOTICE_FIRST_LINE_HEAD')()}* entry: a CONFLICT and conflicting labels latch; the persona is ${lostMessageStateLabel('held-for-human')}`, entryOf(troubleshootingNoticeTitle('CONFLICT_NOTICE_FIRST_LINE_HEAD')), [
    ci('a session conflict'),
    ci("conflicting labels on the persona's own row"),
    code(lostMessageStateLabel('held-for-human')),
  ]],
  [`the *${troubleshootingNoticeTitle('CONFLICT_NOTICE_FIRST_LINE_HEAD')()}* entry: the re-check ${LATCH_RECHECK_WORDS} (SRJ-505), how a hold ends, clear-latch, and "Operator actions" for a human only`, entryOf(troubleshootingNoticeTitle('CONFLICT_NOTICE_FIRST_LINE_HEAD')), [
    ci(`**The server's own check.** ${LATCH_RECHECK_WORDS}`),
    ci('**How a hold ends.**'),
    `(#${headingSlug(CLEAR_LATCH_CLI_HEADING.slice('### '.length))})`,
    vocab('operatorActions'),
    ci('for a human only'),
  ]],
  [`the *${troubleshootingNoticeTitle('UNUSABLE_NAME_NOTICE_HEAD')()}* entry: an unusable recorded name latches`, entryOf(troubleshootingNoticeTitle('UNUSABLE_NAME_NOTICE_HEAD')), [
    ci('recorded on it cannot be used'),
    vocab('operatorActions'),
  ]],
  [`the *${troubleshootingNoticeTitle('LAUNCH_START_NOTICE_HEAD')()}* entry: a pending row with no launch start latches`, entryOf(troubleshootingNoticeTitle('LAUNCH_START_NOTICE_HEAD')), [
    ci('reads pending but records no launch start'),
    vocab('operatorActions'),
  ]],

  // A pending launch and the stuck-launch post (SRJ-410 to SRJ-412, SRJ-1017).
  ["\"A persona's instance is still starting\": a pending launch is never launched over, its retries check it after agent-director's grace period", (readme) => troubleshootingEntry(readme, "**A persona's instance is still starting**"), [
    code('pending_grace_seconds'),
    ci('they never launch a second instance over it and never end it'),
    ci('a launch that is still starting never counts as a failure'),
  ]],
  [`the *${troubleshootingNoticeTitle('STUCK_LAUNCH_RELAUNCHING_HEAD')()}* or *${troubleshootingNoticeTitle('STUCK_LAUNCH_HELD_HEAD')()}* entry: the later of 5 minutes and pending_grace_seconds plus 60 s`, entryOf(troubleshootingNoticeTitle('STUCK_LAUNCH_RELAUNCHING_HEAD')), [
    `*${troubleshootingNoticeTitle('STUCK_LAUNCH_HELD_HEAD')()}*`,
    ci(`the later of ${DIALOG_READY_TIMEOUT_MS / 60_000} minutes and agent-director's \`pending_grace_seconds\` plus ${AD_LAUNCH_BOUND_GRACE_ADDEND_SECONDS} s`),
  ]],

  // agent-director's timing settings (SRJ-209, SRJ-210).
  [`timing settings: the nine [${AD_TMUX_TABLE}] keys of ~/${AD_SETTINGS_RELATIVE_PATH}, read at start and every ${AD_VERSION_RECHECK_INTERVAL_MS / 1000} s with agent-director's rule; agent-director's answers decide`, sectionOf('README.md', TIMING_SETTINGS_HEADING), [
    code(`[${AD_TMUX_TABLE}]`),
    code(`~/${AD_SETTINGS_RELATIVE_PATH}`),
    ...AD_TMUX_KEYS.map(code),
    ci(`when it starts and every ${AD_VERSION_RECHECK_INTERVAL_MS / 1000} s after that`),
    ci("a missing file, a missing key or `0` means agent-director's default"),
    ci("agent-director's own answers always decide"),
  ]],
  ['timing settings: each key\'s default as src/ad-settings.ts holds it', sectionOf('README.md', TIMING_SETTINGS_HEADING), AD_TMUX_KEYS.map((key) => `| ${code(key)} | ${code(String(DEFAULT_AD_SETTINGS.tmux[key]))} |`)],

  // The ad-config-malformed outage (SRJ-316).
  [`the *${troubleshootingNoticeTitle("ONSET_TEMPLATES['ad-config-malformed']")()}* entry (${PERSONA_EPISODE_KIND_AD_CONFIG_MALFORMED}): CSCB acts on nothing and retries`, entryOf(troubleshootingNoticeTitle("ONSET_TEMPLATES['ad-config-malformed']")), [
    code(`~/${AD_SETTINGS_RELATIVE_PATH}`),
    ci('kills, deletes and relaunches nothing'),
    ci('it retries the persona on its own'),
  ]],

  // The call timeout, under "Configuration" (SRJ-213).
  [`Server-wide settings: agent_director_call_timeout_ms, default ${DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS}, range [${MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS}, ${MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS}]`, (readme) => readme.split('\n').find((line) => line.startsWith(`| ${code('agent_director_call_timeout_ms')} |`)) ?? '', [
    `| number | ${code(String(DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS))} |`,
    `[${MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS}, ${underscored(MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS)}]`,
    `(#${headingSlug(CALL_TIMEOUT_SIZING_HEADING.slice('#### '.length))})`,
  ]],
  [`call timeout: its default ${DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS}, its range, and the need: the largest ceiling CSCB calls plus the ${AD_CALL_TIMEOUT_NEED_MARGIN_MS / 1000n} s margin`, sectionOf('README.md', CALL_TIMEOUT_SIZING_HEADING), [
    `${code('agent_director_call_timeout_ms')} (default ${code(String(DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS))}, an integer in ${code(`[${MIN_AGENT_DIRECTOR_CALL_TIMEOUT_MS}, ${underscored(MAX_AGENT_DIRECTOR_CALL_TIMEOUT_MS)}]`)}`,
    ci('the largest ceiling among the agent-director verbs CSCB calls'),
    ci(`plus a ${AD_CALL_TIMEOUT_NEED_MARGIN_MS / 1000n} s margin (${AD_CALL_TIMEOUT_NEED_MARGIN_MS} ms`),
  ]],
  ['call timeout: the ceilings\' formulas, one table row per ceiling CSCB calls (ADSRD SR-13.2; SRJ-213)', sectionOf('README.md', CALL_TIMEOUT_SIZING_HEADING),
    CSCB_CEILINGS.map((name) => `| ${vocab(`ceiling ${name}`)} |`)],
  ['call timeout: the startup warning, its line in server.log', sectionOf('README.md', CALL_TIMEOUT_SIZING_HEADING), [
    ci('**The startup warning.**'),
    callTimeoutWarningTemplate(),
  ]],

  // clear-latch under "CLI Reference" (SRJ-510).
  [`clear-latch: it reaches the server at ${CLEAR_LATCH_DIAL_HOST}, so bind is ${CLEAR_LATCH_DIAL_HOST} or ${ALL_INTERFACES_BIND}`, sectionOf('README.md', CLEAR_LATCH_CLI_HEADING), [
    `It reaches the server at ${code(CLEAR_LATCH_DIAL_HOST)}`,
    `${code(CLEAR_LATCH_DIAL_HOST)} (the default) or ${code(ALL_INTERFACES_BIND)}`,
  ]],
  ['clear-latch: on any other bind, a hold ends only by the re-check, the teardown or a server restart, which drops every hold', sectionOf('README.md', CLEAR_LATCH_CLI_HEADING), [
    ci(`a hold ends only by the server's own check ${LATCH_RECHECK_WORDS}`),
    ci("by the persona's teardown"),
    ci('or by a server restart, which drops every hold'),
  ]],

  // The retry timer (SRJ-301).
  ['"A persona is retried after agent-director refuses it": the retry timer\'s schedule, whatever session_restart_delay and health_check_interval are, never toward the restart limit', (readme) => troubleshootingEntry(readme, '**A persona is retried after agent-director refuses it**'), [
    ci(`${UNAVAILABLE_RETRY_BASE_S} seconds after the refusal`),
    ci(`then every ${UNAVAILABLE_RETRY_CEILING_S} seconds`),
    ci('whatever `session_restart_delay` and `health_check_interval` are, `0` included'),
    ci('a refusal never counts toward the restart limit'),
  ]],

  // The files and the PID file (SRJ-510, SRJ-802).
  [`Files beside the config file: ${RETIRED_KEYS_FILE_NAME}`, sectionOf('README.md', '### Files beside the config file'), [`| ${code(RETIRED_KEYS_FILE_NAME)} | The retired-key record`]],
  [`PID file: ${SERVER_PORT_FILE_NAME}`, sectionOf('README.md', '### PID file'), [ci(`${code(`STATE_DIR/${SERVER_PORT_FILE_NAME}`)} records the server's process ID and the port it actually listens on`)]],

  // The permission wedge (SRJ-1012, SRJ-1101).
  ['the permission-wedge entry names agent-director read-pane and kill, the kill with its result checked and nothing deleted or respawned, for a human only', (readme) => troubleshootingEntry(readme, '**Bot appears dead / posts a "blocked on a native Claude Code permission prompt" warning**'), [
    code('agent-director read-pane --claude-instance-id <id>'),
    `${code('agent-director kill --claude-instance-id <id>')} and check the result; on an error, don't delete or respawn`,
    vocab('operatorActions'),
    ci('for a human only'),
  ]],

  // The *Still not answering* read-only check (E19; SRJ-1101).
  [`the *${troubleshootingNoticeTitle('tmuxUnresponsiveAlertText')()}* check: the one-line read-pane through agent-director, its caveats in the debugging skill`, entryOf(troubleshootingNoticeTitle('tmuxUnresponsiveOnsetText')), [
    code(`agent-director read-pane --claude-instance-id ${PERSONA_INSTANCE_ID_PREFIX}<key> --n-lines 1`),
    `(${DEBUG_SKILL_FILE}#${headingSlug('Listing instances')})`,
    ci("take ownership from agent-director's row, never from the pane"),
  ]],
]

/** The element of the one `README_SRJ_1103_ROWS` row that starts with `prefix`; throws unless exactly one does. */
function readmeRow(prefix: string): string {
  const rows = README_SRJ_1103_ROWS.filter(([element]) => element.startsWith(prefix))
  if (rows.length !== 1) throw new Error(`${rows.length} README_SRJ_1103_ROWS rows start with "${prefix}", expected 1`)
  return rows[0][0]
}

/** The README rows SRJ-1103's Test line names, each with an edit reverting one of its items, and the row it must fail. */
const README_REVERTS: readonly [row: string, how: string, edit: (readme: string) => string][] = [
  [readmeRow('prerequisites: Claude Code'), `the Claude Code line without ${MIN_CLAUDE_CODE_VERSION} (b.ob2's line)`, (readme) =>
    readme.replace(/^- \[Claude Code\]\(([^)]+)\) [^\n]*$/m, '- [Claude Code]($1) installed and authenticated')],
  [readmeRow('prerequisites: Claude Code'), 'an older Claude Code version', (readme) =>
    readme.replace(`) ${MIN_CLAUDE_CODE_VERSION} or later for the workers`, `) ${HISTORICAL_VERSIONS.execFormHooksClaudeCode} or later for the workers`)],
  [readmeRow('prerequisites: every agent'), 'the C15 sentence dropped', (readme) => readme.replace(/ Every agent on the host, with every long-running agent-director process [^\n]*?started again after it\./, '')],
  [readmeRow('prerequisites: tmux'), 'the tmux line dropped', (readme) => readme.replace(/^- \[tmux\][^\n]*\n/m, '')],
  ...[
    [CLEAR_LATCH_DIAL_HOST, code(ALL_INTERFACES_BIND)],
    [ALL_INTERFACES_BIND, `${code(CLEAR_LATCH_DIAL_HOST)} (the default)`],
  ].map(([bind, left]): [string, string, (readme: string) => string] => [
    readmeRow('clear-latch: it reaches'),
    `the bind value ${bind} dropped`,
    (readme) => readme.replace(`must be ${code(CLEAR_LATCH_DIAL_HOST)} (the default) or ${code(ALL_INTERFACES_BIND)}`, `must be ${left}`),
  ]),
  [readmeRow('clear-latch: on any other bind'), 'the restart fallback dropped', (readme) =>
    readme.replace(', or by a server restart, which drops every hold.', '.')],
  [readmeRow('Server-wide settings: agent_director_call_timeout_ms'), 'another default', (readme) =>
    readme.replace(`| ${code('agent_director_call_timeout_ms')} | number | ${code(String(DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS))} |`, `| ${code('agent_director_call_timeout_ms')} | number | ${code('30000')} |`)],
  [readmeRow('call timeout: its default'), 'the margin dropped', (readme) =>
    readme.replace(/, plus a \d+ s margin \([^)]*\)/, '')],
  [readmeRow("call timeout: the ceilings' formulas"), `${CSCB_CEILINGS[0]}'s formula changed`, (readme) =>
    readme.replace(`| ${vocab(`ceiling ${CSCB_CEILINGS[0]}`)} |`, '| 2Q + 2A |')],
]

/** The SRJ-1013 classes (`startup-errors.log`), each as `src/` exports it; README "Startup errors" lists each, and the debugging skill describes each. */
const SRJ_1013_CLASSES: readonly string[] = [
  AD_BELOW_PHASE1_FLOOR,
  PERSONA_KILL_FAILED_LABEL,
  PERSONA_KILL_SURVIVOR_LABEL,
  PERSONA_TEARDOWN_NOTICE_LABEL,
  PERSONA_UNCLASSIFIED_ERROR_LABEL,
  CLI_TEARDOWN_FAILED_LABEL,
  CLEAN_RESTART_NOT_RESTARTED_LABEL,
  RETIRED_KEYS_UNREADABLE_LABEL,
]

/** Whether README "Startup errors" has a list item opening with `label` as a code span, alone or among other labels (`- \`a\` and \`b\` — …`). */
function readmeListsClass(readme: string, label: string): boolean {
  const section = requiredSection(readme, STARTUP_ERRORS_HEADING, 'README.md')
  return new RegExp(`^\\s*- (?:\`[^\`]+\`(?:,| and| or)\\s+)*\`${escapeRegExp(label)}\``, 'm').test(section)
}

/** The debugging skill's section on a persona the two CLI teardown commands could not stop, its heading built from their names in src/cli-teardown.ts. */
const CLI_TEARDOWN_SECTION_HEADING = `## ${code(CLI_COMMAND_STOP_BOTS)} or ${code(CLI_COMMAND_CLEAN_RESTART)} could not stop a persona`

/** The debugging skill's section describing each SRJ-1013 class (file-local; SRJ-1104: an entry per class with its cause and fix). */
const DEBUG_SKILL_CLASS_SECTIONS: Readonly<Record<string, HeadingMatch>> = {
  [AD_BELOW_PHASE1_FLOOR]: classHeading(AD_BELOW_PHASE1_FLOOR),
  [PERSONA_KILL_FAILED_LABEL]: '## A persona posts a Kill failed or Process outlived kill notice',
  [PERSONA_KILL_SURVIVOR_LABEL]: '## A persona posts a Kill failed or Process outlived kill notice',
  [PERSONA_TEARDOWN_NOTICE_LABEL]: '## A persona was added or removed by a confirmed change',
  [PERSONA_UNCLASSIFIED_ERROR_LABEL]: '## agent-director refuses a persona: it is retried on its own',
  [CLI_TEARDOWN_FAILED_LABEL]: CLI_TEARDOWN_SECTION_HEADING,
  [CLEAN_RESTART_NOT_RESTARTED_LABEL]: CLI_TEARDOWN_SECTION_HEADING,
  [RETIRED_KEYS_UNREADABLE_LABEL]: "### The retired-key record can't be read or is invalid",
}

/**
 * Whether the debugging skill's section for `label` (`DEBUG_SKILL_CLASS_SECTIONS`),
 * its heading included, names the class: as a code span, or as a
 * `startup-errors.log` entry's `[label]`. False when the section is missing.
 */
function debugClassSectionNames(skill: string, label: string): boolean {
  const heading = DEBUG_SKILL_CLASS_SECTIONS[label]
  const range = heading === undefined ? undefined : sectionRange(skill, heading)
  if (range === undefined) return false
  const text = flat(skill.split('\n').slice(range.start, range.end).join('\n'))
  return text.includes(code(label)) || text.includes(`[${label}]`)
}

/** The refusal entries' old ending, which the "Arrived here from a startup refusal?" block replaced (E2-gate note; SRJ-1108). */
const START_AGAIN = ci('start the server again')

/** A README refusal item's problems: it names the refusal block by a link that resolves and step 10 by its link, and says no "start the server again". */
function readmeRefusalItemProblems(label: string, readme: string): string[] {
  const item = readmeLabelItem(STARTUP_ERRORS_HEADING, label, readme)
  const carrier = readRunbookCarrier('README.md', readme, SWITCH_OVER_HEADING, SWITCH_OVER_STEP_COUNT)
  return [
    ...lacking(item, [`["${REFUSAL_BLOCK_HEADING}"](#${headingSlug(REFUSAL_BLOCK_HEADING)})`, stepLink(10)(carrier)]),
    ...(START_AGAIN.test(item) ? [`says "start the server again": ${item}`] : []),
    ...(headingAt(readme, headingSlug(REFUSAL_BLOCK_HEADING))?.title === REFUSAL_BLOCK_HEADING ? [] : [`no heading "${REFUSAL_BLOCK_HEADING}" for the link`]),
  ]
}

/** README "Startup errors"' paragraph on a stop by the runtime re-check (SRJ-205): its one unit opening "**Found while the server was running.**". */
function readmeRuntimeParagraph(readme: string): string {
  const units = textUnits(requiredSection(readme, STARTUP_ERRORS_HEADING, 'README.md')).filter((unit) => unit.startsWith(`**${RUNTIME_STOP_HEADING.slice('### '.length)}.**`))
  if (units.length !== 1) throw new Error(`README.md "${STARTUP_ERRORS_HEADING}": ${units.length} units open with the runtime-stop lead, expected 1`)
  return units[0]
}

/** The README runtime paragraph's problems: it links the debugging skill's runtime-stop section, which resolves inside the refusal section, says it is not a switch-over case, and no "start the server again". */
function readmeRuntimeParagraphProblems(readme: string, skill: string = operatorText(DEBUG_SKILL_FILE)): string[] {
  const paragraph = readmeRuntimeParagraph(readme)
  const anchor = headingSlug(RUNTIME_STOP_HEADING.slice('### '.length))
  const linked = markdownLinks(paragraph).filter((link) => link.path === DEBUG_SKILL_FILE && link.anchor === anchor)
  const index = headingAnchors(skill).indexOf(anchor)
  const parent = sectionRange(skill, `## ${REFUSAL_SECTION_TITLE}`)
  const line = index < 0 ? -1 : headings(skill)[index].line
  return [
    ...(linked.length === 1 ? [] : [`${linked.length} links to ${DEBUG_SKILL_FILE}#${anchor}, expected 1`]),
    ...(parent !== undefined && line > parent.start && line < parent.end ? [] : [`${DEBUG_SKILL_FILE}#${anchor} resolves to no heading inside "## ${REFUSAL_SECTION_TITLE}"`]),
    ...lacking(paragraph, [ci('not a switch-over case')]),
    ...(START_AGAIN.test(paragraph) ? ['says "start the server again"'] : []),
  ]
}

/** The debugging skill's runtime-stop section, flattened (`RUNTIME_STOP_HEADING`, under the refusal section). */
function runtimeStopSection(skill: string): string {
  return flat(requiredSection(requiredSection(skill, `## ${REFUSAL_SECTION_TITLE}`, DEBUG_SKILL_FILE), RUNTIME_STOP_HEADING, `${DEBUG_SKILL_FILE}, under "## ${REFUSAL_SECTION_TITLE}",`))
}

/**
 * SRJ-1104's runtime-stop remedy (its Test line; hatch A3), one row per
 * element, each found in the debugging skill's `RUNTIME_STOP_HEADING` section.
 */
const RUNTIME_STOP_REMEDY_ROWS: readonly [element: string, required: readonly (string | RegExp)[]][] = [
  ['the binary the server finds is not the one the running server started with', [ci('the agent-director binary the server finds is not the one the running server started with')]],
  ['the lookup order: the home binary first, then the first agent-director on PATH (SRJ-1301)', [`${code(vocab('homeBinary'))} first, then the first ${code('agent-director')} on ${code('PATH')}`]],
  ["`<path> version` on the binary path the startup-errors entry names, as the workers' user in the bot server's launcher environment", [
    ci('take the binary path the startup-errors entry names'),
    code('<path> version'),
    ci("as the workers' user in the bot server's launcher environment"),
  ]],
  ['Phase 1 put back as the binary the server finds, with every agent and every long-running agent-director process stopped before and started after (HO C15; ADA question 9)', [
    ci('put agent-director Phase 1 back as the binary the server finds'),
    ci(`every agent on the host and every long-running agent-director process (${code('agent-director serve')} included) is stopped before that binary change and started again after it`),
  ]],
  [`CSCB's own bots stopped by a human through "Operator actions" item ${vocab('stoppingSetItem')}, no command named (HO rev 27; hatch A3)`, [
    ci("CSCB's own bots, which the stop left running, are stopped by a human"),
    vocab('stoppingSetItem'),
    `${vocab('operatorActions')} section of agent-director's README`,
    ci('names no command for it'),
  ]],
  ['once the server finds Phase 1, CSCB is started', [ci('once the server finds Phase 1, start CSCB')]],
  [`or the rollback runbook, "${ROLLBACK_RUNBOOK_SECTION_TITLE}", which starts the previous CSCB`, [
    `["${ROLLBACK_RUNBOOK_SECTION_TITLE}"](../../README.md#${headingSlug(ROLLBACK_RUNBOOK_SECTION_TITLE)})`,
    ci('which starts the previous CSCB'),
  ]],
  ['the old CSCB is never reinstalled onto the migrated store', [ci("installing agent-director Phase 1 migrated agent-director's store, so never reinstall the old CSCB onto it")]],
  ["at rollback step 4's restart, an agent that could not be stopped still runs: nothing put back, no rollback rerun, the new CSCB stopped until agent-director has dealt with it, then this remedy", [
    ci(`the restart in step 4 of "${ROLLBACK_RUNBOOK_SECTION_TITLE}"`),
    ci('an agent that could not be stopped still runs, so put nothing back'),
    ci("don't follow the rollback runbook again"),
    ci('the new CSCB stays stopped until agent-director has dealt with that agent'),
    ci('then this remedy applies'),
  ]],
  ['a bot or this skill never changes the agent-director install, and never starts the server without the operator\'s say-so', [
    ci('a bot or this skill never changes the agent-director install itself'),
  ]],
]

/** The forms the runtime-stop remedy must not carry (SRJ-1104; hatch A3): a `command -v agent-director`; `UPGRADE_FORMS` apply through ruling C-1's span list. */
const COMMAND_V = /\bcommand -v agent-director\b/

/** The runtime-stop remedy's problems: its rows' missing items, a `command -v agent-director`, and the upgrade forms once ruling C-1's span is removed. */
function runtimeStopProblems(skill: string): string[] {
  const text = runtimeStopSection(skill)
  return [
    ...RUNTIME_STOP_REMEDY_ROWS.flatMap(([element, required]) => lacking(text, required).map((item) => `${element}: ${item}`)),
    ...(COMMAND_V.test(text) ? ['names `command -v agent-director`'] : []),
    ...upgradeFormsIn(withoutAllowedSpan(text, RUNTIME_STOP_REMEDY)),
  ]
}

/** The debugging skill's refusal entries' Fix lines (SRJ-1104, SRJ-1108; the E2-gate note): the refusal block by title, step 10, no "start the server again". */
function debugRefusalEntryProblems(label: string, skill: string): string[] {
  const entry = flat(requiredSection(skill, classHeading(label), DEBUG_SKILL_FILE))
  return [
    ...lacking(entry, [`the block "${flat(REFUSAL_BLOCK_HEADING)}" of the README section "${PHASE1_RUNBOOK_SECTION_TITLE}"`, ci("the runbook's step 10 starts the new server")]),
    ...(START_AGAIN.test(entry) ? [`says "start the server again": ${entry}`] : []),
  ]
}

/** The one-line `read-pane` check SRJ-1101 gives the debugging skill, as its fenced block holds it. */
const READ_PANE_CHECK = `agent-director read-pane --claude-instance-id ${PERSONA_INSTANCE_ID_PREFIX}<key> --n-lines 1`

/**
 * SRJ-1104's debugging-skill rows, one per section it names (AC 78): each
 * passage and its items; titles rendered from `src/`, labels imported.
 */
const DEBUG_SKILL_SRJ_1104_ROWS: readonly DocRow[] = [
  ['retired persona: a removed persona\'s row is kept until expire and never resumed', sectionOf(DEBUG_SKILL_FILE, '## A persona was added or removed by a confirmed change'), [
    ci("its agent-director row is kept until agent-director's `expire` removes it"),
    ci('which is never resumed'),
  ]],
  ['retired persona: a key added again or renamed back starts a new conversation, the old one never resumed', sectionOf(DEBUG_SKILL_FILE, '### Added again or renamed back'), [
    code(RETIRED_KEYS_FILE_NAME),
    ci('starts a new conversation on the same instance'),
    ci('the old conversation is never resumed'),
  ]],
  ["no delete: a server start's clean-up never deletes a row; the teardown table keeps the row", sectionOf(DEBUG_SKILL_FILE, '## Listing instances'), [
    ci("a server start's clean-up never deletes it"),
    ci('the row is kept'),
  ]],
  [`latch: the hold's cases (case=…), the conflicting-labels note (${LATCHING_LIVENESS_NOTE}), the re-check ${LATCH_RECHECK_WORDS}, and "Operator actions" for a human only`, sectionOf(DEBUG_SKILL_FILE, '## A persona posts a Held: tmux session conflict notice'), [
    code(LATCHING_LIVENESS_NOTE),
    ci(LATCH_RECHECK_WORDS),
    vocab('operatorActions'),
    ci('for a human only'),
  ]],
  [`clear-latch: it reaches the server at ${CLEAR_LATCH_DIAL_HOST}, so bind is ${CLEAR_LATCH_DIAL_HOST} or ${ALL_INTERFACES_BIND}; otherwise the re-check, the teardown or a restart`, sectionOf(DEBUG_SKILL_FILE, '## Clearing a hold by hand: `clear-latch`'), [
    `${code(CLEAR_LATCH_DIAL_HOST)} (the default) or ${code(ALL_INTERFACES_BIND)}`,
    ci("a hold ends only by the server's own check"),
    ci("by the persona's teardown"),
    ci('or by a server restart, which drops every hold'),
  ]],
  ['Constraints: clear-latch runs only on the operator\'s say-so, never by a bot', sectionOf(DEBUG_SKILL_FILE, '## Constraints'), [
    ci(`NEVER run ${code(CLEAR_LATCH_COMMAND)} without the operator's explicit say-so`),
    ci('never tell a persona, or any bot, to run it'),
  ]],
  // The section is found by both titles in its heading; its items are read in its body only, so the heading's "Launch stuck" never answers for `launch`.
  [`stuck launch: the *${troubleshootingNoticeTitle('STUCK_LAUNCH_RELAUNCHING_HEAD')()}* and *${troubleshootingNoticeTitle('STUCK_LAUNCH_HELD_HEAD')()}* post`, (skill) =>
    sectionOf(DEBUG_SKILL_FILE, `## A persona posts a ${troubleshootingNoticeTitle('STUCK_LAUNCH_RELAUNCHING_HEAD')()} or ${troubleshootingNoticeTitle('STUCK_LAUNCH_HELD_HEAD')()} notice`)(skill), [code('pending'), ci('launch')]],
  [`timing settings: the [${AD_TMUX_TABLE}] table of ~/${AD_SETTINGS_RELATIVE_PATH}, read at start and every ${AD_VERSION_RECHECK_INTERVAL_MS / 1000} s`, sectionOf(DEBUG_SKILL_FILE, "## agent-director's timing settings"), [
    code(`[${AD_TMUX_TABLE}]`),
    code(`~/${AD_SETTINGS_RELATIVE_PATH}`),
    ci(`every ${AD_VERSION_RECHECK_INTERVAL_MS / 1000} s`),
  ]],
  [`the ${PERSONA_EPISODE_KIND_AD_CONFIG_MALFORMED} outage: *${troubleshootingNoticeTitle("ONSET_TEMPLATES['ad-config-malformed']")()}*`, sectionOf(DEBUG_SKILL_FILE, '## agent-director refuses a persona: it is retried on its own'), [
    `**${troubleshootingNoticeTitle("ONSET_TEMPLATES['ad-config-malformed']")()}**`,
    code(PERSONA_EPISODE_KIND_AD_CONFIG_MALFORMED),
  ]],
  [`precheck: ${CLI_COMMAND_STOP_BOTS} and ${CLI_COMMAND_CLEAN_RESTART} check agent-director first; a failed check stops nothing and exits 1`, sectionOf(DEBUG_SKILL_FILE, '## A precheck failed: nothing was stopped'), [
    ci('check agent-director before they stop anything'),
    ci('when the check fails, the command stops nothing and exits 1'),
    `<command>: precheck failed for persona "<name>" (key=<key>), session "${PERSONA_TMUX_SESSION_PREFIX}<key>": <CLASS>: <description>`,
  ]],
  ['old binary: the two CLI commands on a binary below the floor or the client\'s minimum', sectionOf(DEBUG_SKILL_FILE, '### The two CLI commands on an old binary'), [
    code(AD_BELOW_PHASE1_FLOOR),
    code(AD_SYSTEM_INSTALL_TOO_OLD),
    PHASE1_RUNBOOK_SECTION_TITLE,
  ]],
  [`CLI teardown: ${CLI_TEARDOWN_FAILED_LABEL} and ${CLEAN_RESTART_NOT_RESTARTED_LABEL}`, sectionOf(DEBUG_SKILL_FILE, CLI_TEARDOWN_SECTION_HEADING), [
    code(CLI_TEARDOWN_FAILED_LABEL),
    code(CLEAN_RESTART_NOT_RESTARTED_LABEL),
  ]],
  [`the refusal section points to the runbook's "${REFUSAL_BLOCK_HEADING}" block by a link`, sectionOf(DEBUG_SKILL_FILE, `## ${REFUSAL_SECTION_TITLE}`), [
    `["${REFUSAL_BLOCK_HEADING}"](../../README.md#${headingSlug(REFUSAL_BLOCK_HEADING)})`,
    ci('never starts the server on its own after a refusal'),
  ]],
  [`the install check's below-floor note points to the switch-over runbook (SRJ-1104, SRJ-1108; hatch A3)`, (skill) =>
    textUnits(skill).filter((unit) => /\binstall[- ]check\b/i.test(unit) && /\bnote\b/i.test(unit)).join(' '), [
    /\binstall[- ]check\b/i,
    /\bnote\b/i,
    PHASE1_RUNBOOK_SECTION_TITLE,
  ]],
  [`the ${troubleshootingNoticeTitle('tmuxUnresponsiveOnsetText')()} check: the one-line read-pane, with its caveats under "Listing instances"`, sectionOf(DEBUG_SKILL_FILE, '## A persona posts a Not answering notice'), [
    READ_PANE_CHECK,
    `(#${headingSlug('Listing instances')})`,
  ]],
]

/** The debugging skill's "Listing instances" read-pane check's problems (SRJ-1101, SRJ-613; the E19 note): the fenced command, both caveats and the pointer. */
function readPaneCheckProblems(skill: string): string[] {
  const raw = requiredSection(skill, '## Listing instances', DEBUG_SKILL_FILE)
  const text = flat(raw)
  return [
    ...(splitFences(raw).blocks.some((block) => block.body.trim() === READ_PANE_CHECK) ? [] : [`no fenced block holding only \`${READ_PANE_CHECK}\``]),
    ...lacking(text, [
      ci('**A pane:** a session of the persona is there'),
      ci('it can be a single leftover of an earlier launch'),
      `answers ${AD_ERROR_CLASS_CONFLICT}, "${vocab('notThisLaunch')}"`,
      `**${code('ErrTmuxCaptureFailed')}:** no session of the row's current launch is there`,
      ci('that does not prove the worker gone after a kill failure whose description says no session or pane of this launch was found'),
      `the ${vocab('operatorActions')} section of agent-director's README`,
    ]),
  ]
}

describe('E36 T4: SRJ-1101 over every operator text (b.jg5 SRJ-1101; SRJ-1105, SRJ-1106 through it; AC 78)', () => {
  test.each(OPERATOR_TEXTS.flatMap(([name, read]) => SRJ_1101_TERMS.map(([label, pattern]) => [name, label, pattern, read] as const)))(
    '%s: no %s',
    (name, label, pattern, read) => {
      expect(findTerms(name, read(), [[label, pattern]]).map(formatHit)).toEqual([])
    },
  )

  test.each(OPERATOR_TEXTS)('%s: `tmux kill-session` stands only in switch-over steps 5 and 6', (name, read) => {
    expect(killSessionsOutsideSteps(name, read()).map(formatHit)).toEqual([])
  })

  test.each(SWITCH_OVER_CARRIERS)(`%s: every \`tmux kill-session\` in the file is one the step reader reads in steps 5 and 6`, (name, read) => {
    const text = operatorText(name)
    const inSteps = KILL_SESSION_STEPS.map((n) => [...read().steps[n - 1].matchAll(/tmux kill-session/g)].length).reduce((a, b) => a + b, 0)
    expect(inSteps).toBeGreaterThan(0)
    expect(findTerms(name, text, [KILL_SESSION])).toHaveLength(inSteps)
  })

  test.each(OPERATOR_TEXTS)('%s: every `tmux attach -t` is written with `=`, apart from the prefix-key reason sentence (SRJ-1102)', (name, read) => {
    expect(unexactAttaches(name, read())).toEqual([])
  })

  test.each(OPERATOR_TEXTS)("%s: every tmux command it names is on the layering rule's allow-list", (name, read) => {
    expect(offListTmuxCommands(name, read())).toEqual([])
  })

  test.each(OPERATOR_TEXTS)('%s: no pane, read-pane answer or GONE is taken as proof a worker is gone (SRJ-613)', (_name, read) => {
    expect(goneAsProofClaims(read())).toEqual([])
  })

  test.each(OPERATOR_TEXTS)('%s: every `agent-director kill --claude-instance-id` it names is followed by checking its result, and no fenced block runs `agent-director kill`', (_name, read) => {
    expect(killAdviceProblems(read(), CHECKS_THE_RESULT)).toEqual([])
  })

  test.each(OPERATOR_TEXTS)('%s: no `agent-director kill` with a positional id and no kill-and-respawn advice (the E8 note)', (name, read) => {
    expect(findTerms(name, read(), RAW_COMMAND_FORMS).map(formatHit)).toEqual([])
  })

  test.each(['README.md', CHANGELOG_FILE])("%s: every kill advice adds \"check the result; on an error, don't delete or respawn\"", (name) => {
    const text = operatorText(name)
    expect([...flat(text).matchAll(KILL_INSTRUCTION)].length).toBeGreaterThan(0)
    expect(killAdviceProblems(text, CHECKS_AND_DOES_NOT_DELETE)).toEqual([])
  })

  test(`${DEBUG_SKILL_FILE}: "Listing instances" carries the one-line read-pane check, both caveats and the "Operator actions" pointer (SRJ-1101, SRJ-613)`, () => {
    expect(readPaneCheckProblems(operatorText(DEBUG_SKILL_FILE))).toEqual([])
  })

  describe('self-checks (synthetic texts, or an operator text with the old wording put back)', () => {
    test.each(SRJ_1101_TERMS.map(([label]) => [label] as const))('%s, wrapped and in other letter case, is reported with file and line', (label) => {
      const sample = `Line one.\nThen ${label.toUpperCase().replace(' ', '\n  ')} here.`
      expect(findTerms('sample.md', sample, SRJ_1101_TERMS).map((hit) => `${hit.file}:${hit.line}: ${hit.term}`)).toEqual([`sample.md:2: ${label}`])
    })

    test('each SRJ-1101 term of the old wording is reported: the has-session check, the cron flag, the finished-row option, a row delete', () => {
      const old = [
        'timeout 10 tmux has-session -t =slack_bot_<key>',
        '* * * * * /usr/local/bin/agent-director find-missing --timeout 30s',
        'Run `agent-director kill --include-finished` for a finished row.',
        'Every kill passes `include_finished: true`.',
        'then `agent-director delete --claude-instance-id <id>`',
        'end it with tmux-kill and respawn it',
      ].join('\n')
      expect(findTerms('old.md', old, SRJ_1101_TERMS).map((hit) => `${hit.line}: ${hit.term}`).sort()).toEqual(
        ['1: has-session', '2: find-missing --timeout', '3: include-finished', '4: include_finished', '5: agent-director delete', '6: tmux-kill'].sort(),
      )
    })

    /** A synthetic runbook carrier: the switch-over section with all its steps, only steps 4 to 6 with a body, then another section. */
    const carrierText = (step4: string, step5: string, step6: string, after: string) =>
      [
        '# Doc', //                                            l.1
        SWITCH_OVER_HEADING, //                                l.2
        `#### ${stepHeadingPrefix(1)}Check`, //                l.3
        `#### ${stepHeadingPrefix(2)}Stage`, //                l.4
        `#### ${stepHeadingPrefix(3)}Stop`, //                 l.5
        `#### ${stepHeadingPrefix(4)}Wait`, //                 l.6
        step4, //                                              l.7
        `#### ${stepHeadingPrefix(5)}Check`, //                l.8
        step5, //                                              l.9
        `#### ${stepHeadingPrefix(6)}End`, //                  l.10
        step6, //                                              l.11
        ...Array.from({ length: SWITCH_OVER_STEP_COUNT - 6 }, (_, k) => `#### ${stepHeadingPrefix(k + 7)}Later`), // l.12 to l.16
        '## Troubleshooting', //                               l.17
        after, //                                              l.18
      ].join('\n')
    const KILL = 'end it with `tmux kill-session -t =<name>`'

    test.each([
      ['in steps 5 and 6 of a carrier', 'README.md', carrierText('-', KILL, KILL, '-'), []],
      ['in step 4 of a carrier', 'README.md', carrierText(KILL, KILL, '-', '-'), ['README.md:7: tmux kill-session']],
      ['after the runbook in a carrier', CHANGELOG_FILE, carrierText('-', KILL, '-', `Or ${KILL.replace(' kill', '\nkill')}.`), [`${CHANGELOG_FILE}:18: tmux kill-session`]],
      ['in a text that is no carrier, steps 5 and 6 included', DEBUG_SKILL_FILE, carrierText('-', KILL, KILL, '-'), [`${DEBUG_SKILL_FILE}:9: tmux kill-session`, `${DEBUG_SKILL_FILE}:11: tmux kill-session`]],
    ] as const)('`tmux kill-session` %s', (_where, file, text, expected) => {
      expect(killSessionsOutsideSteps(file, text).map((hit) => `${hit.file}:${hit.line}: ${hit.term}`)).toEqual([...expected])
    })

    test('a carrier with no switch-over section, or no step 6, throws naming the file', () => {
      expect(() => killSessionsOutsideSteps('README.md', '# Doc\nNo runbook.')).toThrow(`README.md has no heading "${SWITCH_OVER_HEADING}"`)
      expect(() => killSessionsOutsideSteps('README.md', carrierText('-', '-', '-', '-').replace(`${stepHeadingPrefix(6)}`, 'Then: '))).toThrow(`README.md "${SWITCH_OVER_HEADING}": step 6 is missing`)
    })

    test('an attach without `=` is reported with file and line, wrapped or not; the exact target and the reason sentence are not', () => {
      const session = personaTmuxSessionName(ALERT_KEY)
      const text = [
        `Attach with \`tmux attach -t =${session}\`.`, //            l.1
        `Or with \`tmux attach -t ${session}\`.`, //                  l.2
        `Or with \`tmux\nattach-session -t ${session}\`.`, //         l.3-4
        DOCS_PREFIX_KEY_REASON, //                                   l.5
      ].join('\n')
      expect(unexactAttaches('sample.md', text).map((hit) => hit.split(' (')[0])).toEqual(['sample.md:2: a tmux attach target without =', 'sample.md:3: a tmux attach target without ='])
      expect(unexactAttaches('sample.md', DOCS_PREFIX_KEY_REASON, [])).toHaveLength(1)
    })

    test.each([
      ['the exact-target attach', `\`tmux attach -t =${personaTmuxSessionName(ALERT_KEY)}\``],
      ['a read-only tmux ls', 'run a read-only `tmux ls`'],
      ['the window list, all sessions', '`tmux list-windows -a`'],
      ['the window list, one exact target', '`tmux list-windows -t =<name>`'],
      ['the socket check', "`tmux display-message -p '#{socket_path}'`"],
      ['the exact-name kill (placed by its own case)', '`tmux kill-session -t =<name>`'],
      ['prose naming tmux', 'the tmux session conflict; a tmux server changed notice; tmux is not available; the tmux socket'],
      ['flags and labels with tmux in them', '`--tmux-session-name <name>`, `tmux-unresponsive`, `TMUX_TMPDIR`'],
    ])("the allow-list passes %s", (_label, text) => {
      expect(offListTmuxCommands('sample.md', text, [])).toEqual([])
    })

    test.each([
      ['the debugging skill\'s old liveness check', 'timeout 10 tmux list-sessions'],
      ['a session probe', '`tmux has-session -t =slack_bot_alpha`'],
      ['a server kill', 'run `tmux kill-server`'],
      ['a kill behind a global flag', '`tmux -L other kill-session -t =slack_bot_alpha`'],
      ['a session kill without =', '`tmux kill-session -t slack_bot_alpha`'],
      ['a window list without =', '`tmux list-windows -t slack_bot_alpha`'],
      ['a pane read', '`tmux capture-pane -p -t =slack_bot_alpha:`'],
      ['typing into a session, wrapped', 'press Enter with `tmux\nsend-keys -t =slack_bot_alpha: Enter`'],
      ['an attach without =', '`tmux attach -t slack_bot_alpha`'],
      ['a new session', '`tmux new -s slack_bot_alpha`'],
    ])('the allow-list reports %s', (_label, text) => {
      expect(offListTmuxCommands('sample.md', text, [])).toHaveLength(1)
    })

    test('the finder reads every allowed form in the README, so the allow-list case is not vacuous', () => {
      const readme = operatorText('README.md')
      const commands = findTermsAt('README.md', readme, [['a tmux command', TMUX_COMMAND]]).map(({ index }) => flat(readme.slice(index, index + 200)))
      expect(TMUX_ALLOWED_FORMS.filter(([, form]) => !commands.some((command) => form.test(command))).map(([label]) => label)).toEqual([])
    })

    test("the debugging skill fails the allow-list with its old liveness check put back", () => {
      const skill = operatorText(DEBUG_SKILL_FILE)
      const edited = skill.replace(READ_PANE_CHECK, 'timeout 10 tmux list-sessions')
      expect(edited).not.toBe(skill)
      expect(offListTmuxCommands(DEBUG_SKILL_FILE, edited).map((hit) => hit.split(': ')[1])).toEqual(['a tmux command off the allow-list ("tmux list-sessions") in'])
    })

    test.each([
      'A GONE from `read-pane` proves the worker is gone.',
      '`ErrTmuxCaptureFailed` means the worker is dead.',
      'If the pane is missing, that shows the worker has gone: a read-pane answer of ErrTmuxCaptureFailed confirms it is gone.',
      'A GONE from read-pane means no pane is left, so the worker is gone.',
      'A pane read that fails, and no other check, shows the worker is gone.',
    ])('SRJ-613: the claim %p is reported', (text) => {
      expect(goneAsProofClaims(text)).not.toEqual([])
    })

    test("SRJ-613: the debugging skill's caveats and the alert's wording are not reported", () => {
      const fine = [
        '`ErrTmuxCaptureFailed`: no session of the row\'s current launch is there. That does not prove the worker gone after a kill failure whose description says no session or pane of this launch was found.',
        'A pane read can show a leftover\'s pane, and a failed read does not prove the worker gone.',
        'A GONE says that agent-director found no session or pane of the row\'s launch; it does not prove the worker\'s process gone.',
        'A pane proves nothing.',
        'A pane proves nothing about whether the worker is gone.',
        'No pane read shows the worker gone.',
      ].join('\n\n')
      expect(goneAsProofClaims(fine)).toEqual([])
    })

    test.each([
      ['an unchecked kill', 'Then run `agent-director kill --claude-instance-id <id>`. Respawn it after.', CHECKS_THE_RESULT],
      ['an unchecked kill with the id after `=`', 'Then run `agent-director kill --claude-instance-id=<id>`. Respawn it after.', CHECKS_THE_RESULT],
      ['a checked kill without the delete-or-respawn caveat', 'Run `agent-director kill --claude-instance-id <id>` and check the result.', CHECKS_AND_DOES_NOT_DELETE],
      ['a fenced kill, its result checked in the sentence before', 'Run this, then check the result; on an error, don\'t delete or respawn:\n\n```sh\nagent-director kill --claude-instance-id <id>\n```\n', CHECKS_AND_DOES_NOT_DELETE],
      ['a fenced positional kill by path', '```sh\n$HOME/.agent-director/bin/agent-director kill cscb_alpha\n```\n', CHECKS_THE_RESULT],
    ] as const)('kill advice: %s is reported', (_label, text, rule) => {
      expect(killAdviceProblems(text, rule)).toHaveLength(1)
    })

    test('kill advice: a log line naming a kill is no instruction, and a fenced block running another verb is not reported', () => {
      expect(killAdviceProblems('`agent-director kill of cscb_alpha refused at a try: outcome=not-killed class=CONFLICT …`', CHECKS_THE_RESULT)).toEqual([])
      expect(killAdviceProblems(`\`\`\`sh\n${READ_PANE_CHECK}\n\`\`\`\n\n\`\`\`cron\n${vocab('findMissingCron')}\n\`\`\`\n`, CHECKS_THE_RESULT)).toEqual([])
    })

    test.each([
      [`ends it with \`agent-director kill ${personaInstanceId(ALERT_KEY)}\``, '`agent-director kill` without --claude-instance-id'],
      ['run `agent-director kill <id>`', '`agent-director kill` without --claude-instance-id'],
      ['run `agent-director\n  kill <id>`', '`agent-director kill` without --claude-instance-id'],
      ['(`agent-director kill` / tmux-kill + respawn)', 'kill-and-respawn advice'],
      ['then kill and\nrespawn the session', 'kill-and-respawn advice'],
    ] as const)('the E8 note: %p is reported as %s', (text, label) => {
      expect(findTerms('sample.md', text, RAW_COMMAND_FORMS).map((hit) => hit.term)).toEqual([label])
    })

    test('the E8 note: the checked kill, a kill log line, a bare `agent-director kill` and "don\'t delete or respawn" are not reported', () => {
      const fine = [
        `run \`agent-director kill --claude-instance-id ${personaInstanceId(ALERT_KEY)}\` and check the result; on an error, don't delete or respawn`,
        `run \`agent-director kill --claude-instance-id=${personaInstanceId(ALERT_KEY)}\` and check the result`,
        `\`agent-director kill of ${personaInstanceId(ALERT_KEY)} refused at a try: outcome=not-killed class=CONFLICT …\``,
        'then `agent-director kill`, whose result the human checks; on an error, nothing is deleted or respawned',
      ].join('\n')
      expect(findTerms('sample.md', fine, RAW_COMMAND_FORMS)).toEqual([])
    })

    test("the prefix-key reason's spans are the attaches without = left out, and any other attach without = is still reported (SRJ-1102)", () => {
      const session = personaTmuxSessionName(PREFIX_PAIR[0])
      const spans = prefixKeyReasonSpans()
      expect(spans.map((span) => unexactAttaches('sample.md', span, []).length)).toEqual(spans.map(() => 1))
      expect(unexactAttaches('sample.md', spans.join('\n'))).toEqual([])
      const others = [
        `Attach with \`tmux attach -t ${session}\`.`,
        DOCS_PREFIX_KEY_REASON.replace(code(`tmux attach -t ${session}`), code(`tmux attach -t ${personaTmuxSessionName(PREFIX_PAIR[1])}`)),
        renderedPrefixKeyMessage().replace('could reach', 'reaches'),
      ]
      for (const other of others) {
        expect({ other, reported: unexactAttaches('sample.md', [...spans, other].join('\n')).length }).toEqual({ other, reported: 1 })
      }
    })

    test("the README's runbook kills fail their rows with the delete-or-respawn caveat dropped, in each step (SRJ-1101)", () => {
      const readme = operatorText('README.md')
      const edited = readme.replaceAll(`; on an error, don't delete or respawn`, '')
      expect(edited).not.toBe(readme)
      const switchOver = readRunbookCarrier('README.md', edited, SWITCH_OVER_HEADING, SWITCH_OVER_STEP_COUNT)
      const rollback = readRunbookCarrier('README.md', edited, ROLLBACK_HEADING, ROLLBACK_STEP_COUNT)
      const caveatRows = <T extends readonly [string, string, readonly Item[]]>(rows: readonly T[]) => rows.filter(([, element]) => element.includes('deleted or respawned (SRJ-1101)'))
      const failing = [
        ...caveatRows(SWITCH_OVER_ELEMENTS).filter(([where, , required]) => missingItems(switchOver, textAt(switchOver, where), required).length > 0).map(([where]) => `switch-over ${where}`),
        ...caveatRows(ROLLBACK_ELEMENTS).filter(([where, , required]) => missingItems(rollback, textAt(rollback, where), required).length > 0).map(([where]) => `rollback ${where}`),
      ]
      expect(failing).toEqual(['switch-over step 6', 'rollback step 4', 'rollback step 5'])
      expect(killAdviceProblems(edited, CHECKS_AND_DOES_NOT_DELETE).length).toBeGreaterThanOrEqual(3)
    })

    test.each([1, 7])(`the README's switch-over step %d fails its "${UPGRADING_TITLE}" row with the link dropped`, (n) => {
      const readme = operatorText('README.md')
      const anchor = `#${headingSlug(UPGRADING_TITLE)}`
      const step = sectionRange(readme, new RegExp(`^#### ${escapeRegExp(stepHeadingPrefix(n))}`))!
      const lines = readme.split('\n')
      const edited = [...lines.slice(0, step.start), ...lines.slice(step.start, step.end).map((line) => line.replaceAll(`](${anchor})`, '](#no-such-heading)')), ...lines.slice(step.end)].join('\n')
      expect(edited).not.toBe(readme)
      const carrier = readRunbookCarrier('README.md', edited, SWITCH_OVER_HEADING, SWITCH_OVER_STEP_COUNT)
      expect(missingItems(carrier, carrier.steps[n - 1], [upgradingLink])).toEqual([`(${anchor})`])
    })

    test(`the "Listing instances" read-pane check fails without its fenced command, either caveat or the pointer`, () => {
      const skill = operatorText(DEBUG_SKILL_FILE)
      const edits: [string, string][] = [
        [`\`\`\`sh\n${READ_PANE_CHECK}\n\`\`\``, `\`\`\`sh\nagent-director read-pane --claude-instance-id ${PERSONA_INSTANCE_ID_PREFIX}<key>\n\`\`\``],
        ['- **A pane:** a session of the persona is there.', '- **A pane:** the worker runs.'],
        ['description says no session or pane of this launch was found.', 'description says so.'],
      ]
      for (const [from, to] of edits) {
        const edited = skill.replace(from, to)
        expect({ from, changed: edited !== skill }).toEqual({ from, changed: true })
        expect({ from, problems: readPaneCheckProblems(edited).length > 0 }).toEqual({ from, problems: true })
      }
    })
  })
})

/** The title of b.ob2's README version note, which SRJ-1103 removes. */
const VERSION_NOTE_TITLE = 'Note on agent-director versions'

/** The README's version note, put back: a problem when the README names its title anywhere (SRJ-1103). */
function versionNoteProblems(readme: string): string[] {
  return ci(VERSION_NOTE_TITLE).test(readme) ? [`names "${VERSION_NOTE_TITLE}"`] : []
}

/**
 * The prerequisites' base-index sentences (SRJ-1103; HO rev 17): at least one
 * names `base-index`, and each that does says agent-director does not depend
 * on it.
 */
function prerequisiteBaseIndexProblems(readme: string): string[] {
  const sentences = flat(requiredSection(readme, PREREQUISITES_HEADING, 'README.md'))
    .split(/(?<=\.)\s+/)
    .filter((sentence) => sentence.includes(vocab('baseIndex')))
  return [
    ...(sentences.length === 0 ? [`no prerequisites sentence names ${vocab('baseIndex')}`] : []),
    ...sentences.filter((sentence) => !/\bdoes not depend\b/.test(sentence)).map((sentence) => `names ${vocab('baseIndex')} without "does not depend": ${sentence}`),
  ]
}

/** The old system path of the agent-director binary, which no cron line or other README text names (C19). */
const OLD_SYSTEM_BINARY_PATH = '/usr/local/bin/agent-director'

/**
 * Migration's cron line (SRJ-1101; C7, C19): the `cron` blocks of the
 * section's preamble are exactly `AD_VOCABULARY`'s `findMissingCron`, and the
 * README names the old system binary path nowhere.
 */
function migrationCronProblems(readme: string): string[] {
  const migration = requiredSection(readme, MIGRATION_HEADING, 'README.md')
  const preamble = migration.split('\n').slice(0, headings(migration)[0]?.line).join('\n')
  const lines = splitFences(preamble).blocks.filter((block) => block.info === 'cron').map((block) => block.body.trim())
  return [
    ...(lines.length === 1 && lines[0] === vocab('findMissingCron') ? [] : [`the cron blocks hold ${JSON.stringify(lines)}, expected ["${vocab('findMissingCron')}"]`]),
    ...(readme.includes(OLD_SYSTEM_BINARY_PATH) ? [`names ${OLD_SYSTEM_BINARY_PATH}`] : []),
  ]
}

describe('E36 T4: the README describes the build (b.jg5 SRJ-1103; AC 78, AC 79)', () => {
  const readme = () => operatorText('README.md')

  test.each(README_SRJ_1103_ROWS)('%s', (element, passage, required) => {
    expect({ element, problems: docRowProblems(passage, required, readme()) }).toEqual({ element, problems: [] })
  })

  test.each(TROUBLESHOOTING_NOTICES)('"Troubleshooting" has one entry titled by the *%s* notice\'s title, as src/ renders it', (_source, title) => {
    const entries = troubleshootingEntries(readme()).filter((entry) => entry.title.includes(`*${title()}*`))
    expect(entries.map((entry) => entry.title)).toHaveLength(1)
  })

  test.each(SRJ_1013_CLASSES.map((label) => [label] as const))(`"${STARTUP_ERRORS_HEADING}" lists the SRJ-1013 class %s`, (label) => {
    expect(readmeListsClass(readme(), label)).toBe(true)
  })

  test('the prerequisites name base-index and pane-base-index only to say agent-director does not depend on them', () => {
    expect(prerequisiteBaseIndexProblems(readme())).toEqual([])
  })

  test(`the version note ("${VERSION_NOTE_TITLE}") is gone`, () => {
    expect(versionNoteProblems(readme())).toEqual([])
  })

  test(`Migration's cron line is SRJ-1101's, "${vocab('findMissingCron')}", and no other agent-director path or flag (C19)`, () => {
    expect(migrationCronProblems(readme())).toEqual([])
  })

  test.each(REFUSAL_LABELS)(`"${STARTUP_ERRORS_HEADING}": the \`%s\` item points to the "${REFUSAL_BLOCK_HEADING}" block and step 10, never "start the server again" (E2 gate; SRJ-1108)`, (label) => {
    expect(readmeRefusalItemProblems(label, readme())).toEqual([])
  })

  test(`"${STARTUP_ERRORS_HEADING}": the runtime-stop paragraph links the debugging skill's "${RUNTIME_STOP_HEADING.slice('### '.length)}" (SRJ-1104; hatch A3)`, () => {
    expect(readmeRuntimeParagraphProblems(readme())).toEqual([])
  })

  test(`"${CALL_TIMEOUT_SIZING_HEADING.slice('#### '.length)}" sits under "${CONFIGURATION_HEADING}" (SRJ-1103)`, () => {
    const configuration = sectionRange(readme(), CONFIGURATION_HEADING)
    const sizing = sectionRange(readme(), CALL_TIMEOUT_SIZING_HEADING)
    expect(configuration !== undefined && sizing !== undefined && sizing.start > configuration.start && sizing.end <= configuration.end).toBe(true)
  })

  test('"Destructive changes" says neither that a teardown deletes a row nor that a bring-up may resume it', () => {
    const section = requiredSection(readme(), '### Destructive changes', 'README.md')
    expect(affirmedClaims(section, ROW_DELETE_CLAIMS)).toEqual([])
    expect(affirmedClaims(section, [['a resume', /\bresum\w*/gi]])).toEqual([])
  })

  describe('self-checks', () => {
    test.each(README_SRJ_1103_ROWS)('%s: each of its items, cut from its passage in the README, is reported by the row', (element, passage, required) => {
      for (const item of required.map(resolveItem)) {
        const edited = withItemCut(readme(), passage, item)
        expect({ element, item: String(item), reported: docRowProblems(passage, required, edited).includes(`lacks ${String(item)}`) }).toEqual({ element, item: String(item), reported: true })
      }
    })

    test.each(README_REVERTS)('"%s" fails with %s', (row, _how, edit) => {
      const text = readme()
      const edited = edit(text)
      expect(edited).not.toBe(text)
      const [, passage, required] = README_SRJ_1103_ROWS.find(([element]) => element === row)!
      expect(docRowProblems(passage, required, edited)).not.toEqual([])
    })

    test("the version note put back is reported", () => {
      const text = readme()
      const edited = text.replace(INSTALL_CHECK_HEADING, `> **${VERSION_NOTE_TITLE}.** ${HISTORICAL_VERSIONS.zombieRelease} is a zombie release.\n\n${INSTALL_CHECK_HEADING}`)
      expect(edited).not.toBe(text)
      expect(versionNoteProblems(edited)).toHaveLength(1)
    })

    test('a base-index requirement in the prerequisites is reported, and so are prerequisites that no longer name base-index', () => {
      const text = readme()
      const edited = text.replace(/(^- \[tmux\][^\n]*)$/m, `$1 Set ${code(vocab('baseIndex'))} to 1.`)
      expect(edited).not.toBe(text)
      expect(prerequisiteBaseIndexProblems(edited)).toEqual([`names ${vocab('baseIndex')} without "does not depend": Set ${code(vocab('baseIndex'))} to 1.`])
      const dropped = text.replace(/ agent-director does not depend on tmux's [^\n]*?\./, '')
      expect(dropped).not.toBe(text)
      expect(prerequisiteBaseIndexProblems(dropped)).toEqual([`no prerequisites sentence names ${vocab('baseIndex')}`])
    })

    test("Migration's old cron line is reported, by the cron case and by SRJ-1101's term", () => {
      const text = readme()
      const edited = text.replace(vocab('findMissingCron'), `* * * * * ${OLD_SYSTEM_BINARY_PATH} find-missing --timeout 30s`)
      expect(edited).not.toBe(text)
      expect(migrationCronProblems(edited)).toHaveLength(2)
      expect(findTerms('README.md', edited, SRJ_1101_TERMS).map((hit) => hit.term)).toEqual(['find-missing --timeout'])
    })

    test.each(REFUSAL_LABELS)('the `%s` item fails with "then start the server again" back', (label) => {
      const text = readme()
      const edited = text.replace(
        new RegExp(`(^- \`${escapeRegExp(label)}\`[^\\n]*?)Follow (?:that|the README) section[^\\n]*?starts it\\.`, 'm'),
        `$1Follow the README section "${PHASE1_RUNBOOK_SECTION_TITLE}", then start the server again.`,
      )
      expect(edited).not.toBe(text)
      expect(readmeRefusalItemProblems(label, edited)).not.toEqual([])
    })

    test('the runtime-stop paragraph fails with its old ending back', () => {
      const text = readme()
      const edited = text.replace(/(\*\*Found while the server was running\.\*\*[^\n]*?)This stop is not a switch-over case:[^\n]*/, `$1Follow the README section "${PHASE1_RUNBOOK_SECTION_TITLE}", then start the server again.`)
      expect(edited).not.toBe(text)
      expect(readmeRuntimeParagraphProblems(edited)).toEqual(expect.arrayContaining([`0 links to ${DEBUG_SKILL_FILE}#${headingSlug(RUNTIME_STOP_HEADING.slice('### '.length))}, expected 1`, 'says "start the server again"']))
    })

    test('the runtime-stop paragraph fails when the debugging skill\'s section is renamed', () => {
      const skill = operatorText(DEBUG_SKILL_FILE).replace(RUNTIME_STOP_HEADING, '### A stop while running')
      expect(readmeRuntimeParagraphProblems(readme(), skill).join('\n')).toContain('resolves to no heading')
    })

    test('a notice title renamed in "Troubleshooting" is no longer found', () => {
      const [, title] = TROUBLESHOOTING_NOTICES[0]
      const edited = readme().replace(`**A persona posts a *${title()}*`, '**A persona posts a *Unreachable*')
      expect(edited).not.toBe(readme())
      expect(troubleshootingEntries(edited).filter((entry) => entry.title.includes(`*${title()}*`))).toHaveLength(0)
    })

    test('a resumed or deleted row in "Destructive changes" is reported, a negation that does not govern the verb included', () => {
      expect(affirmedClaims('A bring-up may resume the old conversation.', [['a resume', /\bresum\w*/gi]])).toHaveLength(1)
      expect(affirmedClaims('The teardown kills the bot and deletes its row.', ROW_DELETE_CLAIMS)).not.toEqual([])
      expect(affirmedClaims('After no reply, the teardown deletes its row.', ROW_DELETE_CLAIMS)).toEqual(['a row deleted: deletes its row'])
      expect(affirmedClaims('With no other row live, a bring-up resumes the old conversation.', [['a resume', /\bresum\w*/gi]])).toHaveLength(1)
    })

    test('a negation that governs the verb is the caveat: before it, as its subject, or as its object', () => {
      const fine = [
        'The teardown never deletes its row.',
        "It doesn't delete the row, and it never resumes.",
        'No teardown deletes a row.',
        'The teardown kills the bot and deletes nothing.',
        'A bring-up is no longer resumed.',
      ].join('\n\n')
      expect(affirmedClaims(fine, [...ROW_DELETE_CLAIMS, ['a resume', /\bresum\w*/gi]])).toEqual([])
    })
  })
})

describe('E36 T4: the debugging skill describes the build (b.jg5 SRJ-1104; AC 78)', () => {
  const skill = () => operatorText(DEBUG_SKILL_FILE)

  test.each(DEBUG_SKILL_SRJ_1104_ROWS)('%s', (element, passage, required) => {
    expect({ element, problems: docRowProblems(passage, required, skill()) }).toEqual({ element, problems: [] })
  })

  test.each(SRJ_1013_CLASSES.map((label) => [label, String(DEBUG_SKILL_CLASS_SECTIONS[label])] as const))('the SRJ-1013 class %s is described in its section, %s', (label) => {
    expect(debugClassSectionNames(skill(), label)).toBe(true)
  })

  test('self-check: a class named nowhere in its section, heading included, is reported', () => {
    expect(debugClassSectionNames(`### \`${AD_BELOW_PHASE1_FLOOR}\`\nThe binary is below the floor.\n`, AD_BELOW_PHASE1_FLOOR)).toBe(true)
    const retired = String(DEBUG_SKILL_CLASS_SECTIONS[RETIRED_KEYS_UNREADABLE_LABEL])
    expect(debugClassSectionNames(`${retired}\nThe record can't be read.\n`, RETIRED_KEYS_UNREADABLE_LABEL)).toBe(false)
    expect(debugClassSectionNames(`${retired}\n\`[${RETIRED_KEYS_UNREADABLE_LABEL}] …\`\n`, RETIRED_KEYS_UNREADABLE_LABEL)).toBe(true)
    expect(debugClassSectionNames(`## Other\n\`${RETIRED_KEYS_UNREADABLE_LABEL}\`\n`, RETIRED_KEYS_UNREADABLE_LABEL)).toBe(false)
  })

  test.each(REFUSAL_LABELS)(`the \`%s\` entry's fix follows the "${REFUSAL_BLOCK_HEADING}" block and the runbook's step 10, never "start the server again" (E2 gate; SRJ-1108)`, (label) => {
    expect(debugRefusalEntryProblems(label, skill())).toEqual([])
  })

  test(`the refusal section names no "start the server again"`, () => {
    expect(flat(requiredSection(skill(), `## ${REFUSAL_SECTION_TITLE}`, DEBUG_SKILL_FILE))).not.toMatch(START_AGAIN)
  })

  test.each(RUNTIME_STOP_REMEDY_ROWS)(`"${RUNTIME_STOP_HEADING.slice('### '.length)}": %s (SRJ-1104; hatch A3)`, (element, required) => {
    expect({ element, missing: lacking(runtimeStopSection(skill()), required) }).toEqual({ element, missing: [] })
  })

  test(`"${RUNTIME_STOP_HEADING.slice('### '.length)}" names no \`command -v agent-director\` and, once ruling C-1's span is removed, no upgrade or install command`, () => {
    expect(runtimeStopProblems(skill())).toEqual([])
  })

  test(`the rollback link of "${RUNTIME_STOP_HEADING.slice('### '.length)}" resolves to the README's "${ROLLBACK_HEADING}"`, () => {
    const links = markdownLinks(runtimeStopSection(skill())).filter((link) => link.path === '../../README.md')
    expect(links.length).toBeGreaterThan(0)
    expect(links.map((link) => headingAt(operatorText('README.md'), link.anchor)?.text)).toEqual(links.map(() => ROLLBACK_HEADING))
  })

  describe('self-checks', () => {
    test.each(DEBUG_SKILL_SRJ_1104_ROWS)('%s: each of its items, cut from its passage in the skill, is reported by the row', (element, passage, required) => {
      for (const item of required.map(resolveItem)) {
        const edited = withItemCut(skill(), passage, item)
        expect({ element, item: String(item), reported: docRowProblems(passage, required, edited).includes(`lacks ${String(item)}`) }).toEqual({ element, item: String(item), reported: true })
      }
    })

    test.each(RUNTIME_STOP_REMEDY_ROWS.flatMap(([element, required]) => required.map((item) => [element, String(item), item] as const)))(
      'the remedy "%s" with its item %s cut in the skill is reported by runtimeStopProblems',
      (element, label, item) => {
        const edited = withItemCut(skill(), runtimeStopSection, item)
        expect(runtimeStopProblems(edited)).toContain(`${element}: lacks ${label}`)
      },
    )

    test.each([
      ['`command -v agent-director`', 'Find it with `command -v agent-director`.', 'names `command -v agent-director`'],
      ['another backticked agent-director command line', 'Then run `agent-director stop-all`.', 'backticked agent-director command line'],
      ['an upgrade command', 'Or upgrade it with `install.sh`.', 'upgrade wording'],
    ])('the remedy with %s added is reported', (_label, sentence, problem) => {
      const fakeSkill = `## ${REFUSAL_SECTION_TITLE}\n\n${RUNTIME_STOP_HEADING}\n\n${runtimeStopSection(skill())} ${sentence}\n`
      expect(runtimeStopProblems(fakeSkill)).toContain(problem)
    })

    test.each(REFUSAL_LABELS)('the `%s` entry fails with its old fix back', (label) => {
      const text = skill()
      const entryStart = text.indexOf(`### \`${label}\``)
      const fix = new RegExp(
        escapeRegExp(`- **Fix:** the operator follows the block "${REFUSAL_BLOCK_HEADING}" of the README section "${PHASE1_RUNBOOK_SECTION_TITLE}" (above); the runbook's step 10 starts the new server.`).replace(/ /g, '\\s+'),
      )
      const rest = text.slice(entryStart).replace(fix, `- **Fix:** the operator follows the README section "${PHASE1_RUNBOOK_SECTION_TITLE}", then starts the server again.`)
      const edited = text.slice(0, entryStart) + rest
      expect(edited).not.toBe(text)
      expect(debugRefusalEntryProblems(label, edited)).not.toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------
// E39 T5: tests/README.md names the integration scripts and keeps the start
// sweep's rows (b.jg5 SRJ-1112). Each later scenario Epic names its script
// there, and this block enforces it. tests/README.md is no shipped
// description, so the forbidden-term audit does not read it.
// ---------------------------------------------------------------------------

const TESTS_README_FILE = 'tests/README.md'
const INTEGRATION_DIR = 'tests/integration'

/** Every `test-*.sh` file name in tests/integration/, listed read-only, sorted. */
function integrationScripts(): string[] {
  return readdirSync(resolve(REPO_ROOT, INTEGRATION_DIR))
    .filter((name) => /^test-.*\.sh$/.test(name))
    .sort()
}

/** Whether `text` names the file `name` as a whole name: not inside a longer name, a path ending in it (`tests/integration/<name>`) included. */
function namesFile(text: string, name: string): boolean {
  return new RegExp(`(?<![\\w.-])${escapeRegExp(name)}(?![\\w-]|\\.\\w)`).test(text)
}

/** Each of `scripts` that `readme` does not name. */
function unnamedScripts(readme: string, scripts: readonly string[]): string[] {
  return scripts.filter((name) => !namesFile(readme, name))
}

/** A `test-<n>-<name>.sh` file name, a number then a name; the `test-N-<short-name>.sh` template is none. */
const SCRIPT_FILE_NAME = /(?<![\w.-])test-\d+-[\w-]+\.sh(?![\w-]|\.\w)/g

/** Each `test-<n>-<name>.sh` `readme` names that is not one of `scripts` (a removed script), once, in order. */
function removedScriptsNamed(readme: string, scripts: readonly string[]): string[] {
  return [...new Set(readme.match(SCRIPT_FILE_NAME) ?? [])].filter((name) => !scripts.includes(name))
}

/** A text unit about the server's start sweep. */
const NAMES_SWEEP = /\bsweep\b|\breconcileOrphans\b/i

/**
 * A start sweep that loses rows (SRJ-1112: it deletes none, so the rows
 * earlier scripts leave stay), file-local, read through `affirmedClaims`, so
 * a negation that governs the verb passes ("never deletes a row", "does not
 * delete", "No row is deleted"). Any delete verb counts, a backticked
 * `delete` included, unless its object is negated ("deletes no row",
 * "deletes none"); `ROW_DELETE_CLAIMS` needs a determiner before "row" and
 * reads "kills … and deletes none" as a delete, so it is not reused here.
 */
const SWEEP_DELETE_CLAIMS: readonly [label: string, pattern: RegExp][] = [
  ['a delete', /`?\bdelet(?:e|es|ed|ing)\b`?(?!\s+(?:no|none|nothing)\b)/gi],
  ['a row removed', /\bremov(?:e|es|ed|ing)\s+(?:the|its|their|a|each|every|all|that|this|one)\s+(?:[^\s.;]+\s+){0,3}?rows?\b/gi],
  ['a row gone or removed', /\brows?\b[^.;]{0,80}?\b(?:is|are|was|were)\s+(?:then\s+)?(?:gone|removed)\b/gi],
]

/** Each `SWEEP_DELETE_CLAIMS` match no negation governs, in the text units of `readme` that name the start sweep, as `<label>: <matched text>`. */
function sweepDeleteClaims(readme: string): string[] {
  return textUnits(readme)
    .filter((unit) => NAMES_SWEEP.test(unit))
    .flatMap((unit) => affirmedClaims(unit, SWEEP_DELETE_CLAIMS))
}

/** SRJ-1112's Test 10 passage, element by element: [element, pattern over the flattened passage]. */
const TEST_10_SWEEP_ELEMENTS: readonly [element: string, pattern: RegExp][] = [
  ['the sweep kills live rows', /\bkills\b[^.;]*?\blive\b/i],
  ['it deletes none', /\b(?:deletes\s+(?:no\s+rows?|none|nothing)|never\s+deletes|does\s+not\s+delete)\b/i],
  ["it records absent personas' keys as retired", /\brecords\b(?=[^.;]*\bkeys?\b)(?=[^.;]*\babsent\b)(?=[^.;]*\bretired\b)/i],
  ['the rows earlier scripts leave stay', /\brows?\b[^.;]*?\bstays?\b/i],
]

/** Whether a text unit or paragraph is the Test 10 passage: it names Test 10 and the start sweep. */
function isTest10Passage(text: string): boolean {
  return /\bTest 10\b/.test(text) && NAMES_SWEEP.test(text)
}

/** Each `TEST_10_SWEEP_ELEMENTS` element the Test 10 passage of `readme` lacks; one problem unless exactly one unit is that passage. */
function test10PassageProblems(readme: string): string[] {
  const passages = textUnits(readme).filter(isTest10Passage)
  if (passages.length !== 1) return [`${passages.length} passages name Test 10 and the start sweep, expected 1`]
  return TEST_10_SWEEP_ELEMENTS.filter(([, pattern]) => !pattern.test(passages[0])).map(([element]) => `lacks: ${element}`)
}

/** `readme` with its one Test 10 paragraph replaced by `passage`, in memory; throws unless exactly one paragraph is that passage. */
function withTest10Passage(readme: string, passage: string): string {
  const paragraphs = readme.split('\n\n')
  const at = paragraphs.map((p, i) => (isTest10Passage(p) ? i : -1)).filter((i) => i >= 0)
  if (at.length !== 1) throw new Error(`${TESTS_README_FILE}: ${at.length} paragraphs name Test 10 and the start sweep, expected 1`)
  return [...paragraphs.slice(0, at[0]), passage, ...paragraphs.slice(at[0] + 1)].join('\n\n')
}

/** The Test 10 passage the README carried before SRJ-1112: the sweep killed and deleted rows, and the rows were gone. */
const OLD_TEST_10_PASSAGE = `Test 10's live start runs the server's start sweep (\`reconcileOrphans\`,
\`src/session-manager.ts\`), which kills and deletes every \`service=cscb\`
agent-director row whose persona is not in Test 10's own config (and any row
with a foreign instance ID or another working directory; a row with no
persona label is killed when live and kept). Every persona row an earlier
script left behind is gone after Test 10's start, and Test 12's live start
does the same to Test 10's rows; that is acceptable only because the
container is ephemeral and the scripts run one at a time. The sweep reaches
only the shared store: an fmk script's rows are in its own store, which no
other script's start sees.`

describe(`E39 T5: ${TESTS_README_FILE} names every integration script and keeps the start sweep's rows (b.jg5 SRJ-1112)`, () => {
  const readme = () => readRepoFile(TESTS_README_FILE)

  test(`every ${INTEGRATION_DIR}/test-*.sh on disk is named in ${TESTS_README_FILE}`, () => {
    const scripts = integrationScripts()
    expect(scripts).not.toEqual([])
    expect(unnamedScripts(readme(), scripts)).toEqual([])
  })

  test(`every test-<n>-<name>.sh ${TESTS_README_FILE} names exists in ${INTEGRATION_DIR} (no removed script)`, () => {
    expect(removedScriptsNamed(readme(), integrationScripts())).toEqual([])
  })

  test(`no passage of ${TESTS_README_FILE} about the start sweep says it deletes, removes or loses a row`, () => {
    expect(textUnits(readme()).some((unit) => NAMES_SWEEP.test(unit))).toBe(true)
    expect(sweepDeleteClaims(readme())).toEqual([])
  })

  test("the Test 10 passage says the sweep kills live rows, deletes none and records absent personas' keys as retired, so the rows stay", () => {
    expect(test10PassageProblems(readme())).toEqual([])
  })

  test(`the forbidden-term audit does not read ${TESTS_README_FILE}`, () => {
    expect(SHIPPED_TEXTS.map(([name]) => name)).not.toContain(TESTS_README_FILE)
  })

  describe('self-checks, on in-memory copies', () => {
    test('a script on disk the README does not name is reported', () => {
      expect(unnamedScripts(readme(), [...integrationScripts(), 'test-29-fmk-unnamed-scenario.sh'])).toEqual(['test-29-fmk-unnamed-scenario.sh'])
    })

    test('a script named only inside a longer name is not named', () => {
      expect(unnamedScripts('Runs `xtest-1-install-startup.sh` and `test-1-install-startup.sh.bak`.', ['test-1-install-startup.sh'])).toEqual(['test-1-install-startup.sh'])
      expect(unnamedScripts('Runs `tests/integration/test-1-install-startup.sh`.', ['test-1-install-startup.sh'])).toEqual([])
    })

    test('a removed script the README names is reported, added to the README or gone from disk', () => {
      const scripts = integrationScripts()
      const added = `${readme()}\n\`test-11-exact-tmux-targets.sh\` checks the exact tmux targets.\n`
      expect(removedScriptsNamed(added, scripts)).toEqual(['test-11-exact-tmux-targets.sh'])
      expect(removedScriptsNamed(readme(), scripts.filter((name) => name !== 'test-12-bot-hook-absoluteness.sh'))).toEqual(['test-12-bot-hook-absoluteness.sh'])
    })

    test('the new-script template test-N-<short-name>.sh names no script', () => {
      expect(removedScriptsNamed('Add `tests/integration/test-N-<short-name>.sh`, or `test-N-fmk-<short-name>`.', [])).toEqual([])
    })

    test.each([
      ['the old Test 10 passage', OLD_TEST_10_PASSAGE],
      ['kills and deletes', "Test 10's start sweep kills and deletes each live row whose persona is absent."],
      ['deletes the rows', "Test 10's start sweep deletes the rows of absent personas."],
      ['and deleted', "Test 10's start sweep kills each live stray and deleted its row."],
      ['a passive delete', "Test 10's start sweep kills each live stray, and its row is deleted."],
      ['a delete after the kill', "Test 10's start sweep kills each live stray, then deletes it."],
      ['a `delete` call', "Test 10's start sweep calls `delete` on each absent persona's row."],
      ['removes the row', "Test 10's start sweep removes each absent persona's row."],
      ['rows gone', "Every row an earlier script left behind is gone after Test 10's start sweep."],
    ])('the Test 10 passage saying the sweep loses rows (%s) is reported', (_label, passage) => {
      expect(sweepDeleteClaims(withTest10Passage(readme(), passage))).not.toEqual([])
    })

    test.each([
      ['deletes none', "Test 10's start sweep kills each live stray, deletes none and records each absent persona's key as retired; the rows earlier scripts leave stay."],
      ['deletes no row', "Test 10's start sweep kills live strays and deletes no row."],
      ['never deletes', "Test 10's start sweep never deletes a row: it kills live strays and records absent personas' keys as retired."],
      ['does not delete', "Test 10's start sweep does not delete a row."],
      ['no row is deleted', "Test 10's start sweep kills live strays. No row is deleted."],
      ['no `delete` call', "Test 10's start sweep makes no `delete` call."],
    ])('the Test 10 passage saying the sweep keeps rows (%s) is not reported', (_label, passage) => {
      expect(sweepDeleteClaims(withTest10Passage(readme(), passage))).toEqual([])
    })

    test('the old Test 10 passage lacks every element', () => {
      expect(test10PassageProblems(withTest10Passage(readme(), OLD_TEST_10_PASSAGE))).toEqual(TEST_10_SWEEP_ELEMENTS.map(([element]) => `lacks: ${element}`))
    })

    test.each([
      ['the sweep kills live rows', "Test 10's start sweep deletes no row and records the key of every row whose persona is absent as retired, so every row stays."],
      ['it deletes none', "Test 10's start sweep kills each live stray and records the key of every row whose persona is absent as retired, so every row stays."],
      ["it records absent personas' keys as retired", "Test 10's start sweep kills each live stray and deletes no row, so every row stays."],
      ['the rows earlier scripts leave stay', "Test 10's start sweep kills each live stray, deletes no row and records the key of every row whose persona is absent as retired."],
    ])('a Test 10 passage without "%s" is reported', (element, passage) => {
      expect(test10PassageProblems(withTest10Passage(readme(), passage))).toEqual([`lacks: ${element}`])
    })

    test('a README with no Test 10 passage, or two, is reported', () => {
      expect(test10PassageProblems(withTest10Passage(readme(), 'Test 12 starts live.'))).toEqual(['0 passages name Test 10 and the start sweep, expected 1'])
      const twice = `${readme()}\n\nTest 10's start sweep kills live strays.\n`
      expect(test10PassageProblems(twice)).toEqual(['2 passages name Test 10 and the start sweep, expected 1'])
    })
  })
})

// ---------------------------------------------------------------------------
// b.deo SRI-1308: the README describes both channel modes (SRI-1101 to
// SRI-1105, SRI-805; AC 42). T1's cases above pin the key tables, both
// complete examples and the in-place row; these pin the rest.
// ---------------------------------------------------------------------------

/** The README's channel-modes section and its four subsections, in order (b.deo SRI-1102). */
const CHANNEL_MODES_HEADING = '## Channel modes'
const WHAT_EACH_MODE_SERVES_HEADING = '### What each mode serves'
const TURNING_FUNGIBLE_HEADING = '### Turning fungible mode on or off'
const FUNGIBLE_DELIVERY_HEADING = '### Channel delivery in fungible mode'
const FUNGIBLE_PROMPTS_HEADING = '### Permission prompts in fungible mode'
const CHANNEL_MODES_SUBSECTIONS = [WHAT_EACH_MODE_SERVES_HEADING, TURNING_FUNGIBLE_HEADING, FUNGIBLE_DELIVERY_HEADING, FUNGIBLE_PROMPTS_HEADING] as const

/** The security subsection, inside the receiving section after its bullet list (b.deo SRI-1104). */
const WHO_CAN_REACH_HEADING = '### Who can reach a persona in fungible mode'

/** The downgrade section, under `## Migration` right after "Upgrading to personas" (b.deo SRI-1105). */
const DOWNGRADE_HEADING = '### Downgrading to an earlier release'

/** Other README headings the rows read. */
const RELOAD_HEADING = '## Reload'
const TOOLS_HEADING = '## Tools'
const README_TITLE_HEADING = '# Claude Slack Channel Bots'

/** A heading's anchor, `(#<slug>)`, as a same-file link target. */
function anchorLink(heading: string): string {
  return `(#${headingSlug(heading.replace(/^#+ /, ''))})`
}

/**
 * Setting names, values and defaults the rows name, each tied to the
 * loader's exported sets by `satisfies` (a rename fails the typecheck) or
 * imported; the switch is `MODE_SWITCH_SETTING` (src/reload-plan.ts).
 */
const CHANNELS_KEY = 'channels' satisfies (typeof PERSONA_ENTRY_KEYS)[number]
const PROMPTS_KEY = 'permission_prompts' satisfies (typeof PERSONA_ENTRY_KEYS)[number]
const DM_KEY = 'dm' satisfies (typeof PERSONA_ENTRY_KEYS)[number]
const DELIVERY_KEY = 'delivery' satisfies (typeof CHANNEL_ENTRY_KEYS)[number]
const DM_CONTACT = `${DM_KEY}.${'contact' satisfies (typeof PERSONA_DM_KEYS)[number]}`
const DM_ENABLED = `${DM_KEY}.${'enabled' satisfies (typeof PERSONA_DM_KEYS)[number]}`
const INVITED_DESTINATION = `${FUNGIBLE_SECTION_KEY}.${INVITED_DESTINATION_KEY}`
const MENTIONS = 'mentions' satisfies (typeof DELIVERY_MODES)[number]
const ALL = 'all' satisfies (typeof DELIVERY_MODES)[number]
const RECEIVE_ALL_SHARED = 'receive_all_shared' satisfies Via
/** `"dm"`, as the README writes the destination value in a code span. */
const DM_VALUE = code(JSON.stringify(DM_DESTINATION))
const SWITCH = code(MODE_SWITCH_SETTING)
const TOOL = code(SET_CHANNEL_DELIVERY_TOOL)
const INVALID = code(INVALID_PREFIX.replace(/:$/, ''))

/** The five tools that take a target (src/registry.ts builds them inline in `createSessionServer` and exports no list); with `set_channel_delivery`, the tools table's six rows (b.deo SRI-1103). */
const TARGETING_TOOLS = ['reply', 'react', 'edit_message', 'fetch_messages', 'download_attachment'] as const

/** A README section's flattened text (a row's passage). */
const readmeSection = (heading: HeadingMatch) => sectionOf('README.md', heading)

/** The one line of the README section under `heading` that opens a table row with `| <prefix>`; throws unless exactly one does (a row's passage). */
const tableRowOf = (heading: HeadingMatch, prefix: string) => (text: string) => {
  const rows = requiredSection(text, heading, 'README.md').split('\n').filter((line) => line.startsWith(`| ${prefix}`))
  if (rows.length !== 1) throw new Error(`README.md ${String(heading)}: ${rows.length} table rows open with "| ${prefix}", expected 1`)
  return rows[0]
}

/** The receiving table's row of `via` (its Kind cell `VIA_ROWS[via]`) (a row's passage). */
const kindRowOf = (via: Via) => tableRowOf(RECEIVING_HEADING, `${VIA_ROWS[via]} |`)

/** The tools table's row of `tool` (a row's passage). */
const toolRowOf = (tool: string) => tableRowOf(TOOLS_HEADING, `${code(tool)} |`)

/** The numbered steps of "Downgrading to an earlier release", one line each, link targets dropped. */
function downgradeSteps(readme: string): string[] {
  return requiredSection(readme, DOWNGRADE_HEADING, 'README.md').split('\n').filter((line) => /^\d+\. /.test(line)).map((line) => linkTexts(flat(line)))
}

/** Downgrade step `n` (a row's passage); throws when the `n`th numbered step is missing or not numbered `n`. */
const downgradeStep = (n: number) => (readme: string) => {
  const step = downgradeSteps(readme)[n - 1]
  if (step === undefined || !step.startsWith(`${n}. `)) throw new Error(`README.md "${DOWNGRADE_HEADING}": no step ${n} in place`)
  return step
}

/** The troubleshooting entries b.deo SRI-1105 names, by their titles (T17's closing note). */
const SILENT_INVITED_TITLE = 'A persona is silent in a channel it was invited to'
const RECEIVES_EVERYTHING_TITLE = 'A persona receives every message in a channel'
const UNCLAIMED_ENTRY_TITLE = 'Messages in a channel no persona is configured into are not delivered'

/** The one troubleshooting entry whose title line is `**<title>**`, its title and text flattened; throws unless exactly one is (a row's passage). */
const titledEntry = (title: string) => (readme: string) => troubleshootingEntry(readme, `**${title}**`)

/**
 * The part of `FUNGIBLE_MODE_ZERO_REASON` (src/jsonl-persistence-check.ts,
 * b.deo SRI-704) the README's `jsonl-diagnosis-inconclusive` item quotes:
 * the reason up to "and the configuration cannot predict its traffic".
 * Throws when the reason holds no such phrase (its row's item, built when
 * the row runs).
 */
function fungibleZeroReasonQuoted(): string {
  const [quoted, rest] = FUNGIBLE_MODE_ZERO_REASON.split(' and the configuration cannot predict')
  if (rest === undefined) throw new Error(`FUNGIBLE_MODE_ZERO_REASON has no "and the configuration cannot predict": ${FUNGIBLE_MODE_ZERO_REASON}`)
  return quoted
}

/** The sample persona the preview lines are rendered with: `toolTextSample()`'s name and key (from `makePersona`). */
function previewSample(): { name: string; key: string } {
  const { name, key } = toolTextSample()
  return { name, key }
}

/**
 * The switch's preview line as README "Reading the preview" and the wizard's
 * Step 10 quote it (b.deo SRI-803): `modeSwitchLine` rendered for `mode`
 * with one persona, the mode replaced by `<mode>` and the persona list by
 * `…`. Each carrier's row reads the quote of each direction, so a carrier's
 * one quote stands for both only while both directions give the same text.
 * Called when a row runs; throws when the line renders no mode or list.
 */
function switchLineQuote(mode: ChannelMode): string {
  const line = modeSwitchLine(mode, [previewSample()])
  const at = line.lastIndexOf(', for ')
  if (at < 0 || !line.includes(` turns ${mode} mode on`)) throw new Error(`modeSwitchLine renders no mode or persona list: ${line}`)
  return `${line.slice(0, at).replace(` turns ${mode} mode on`, ' turns <mode> mode on')}, for …`
}

/** The ending of the switch's line when no persona is in both configurations (`modeSwitchLine` with none), from its last `;`. */
function switchLineNoPersonaEnding(): string {
  const line = modeSwitchLine('fungible', [])
  return line.slice(line.lastIndexOf(';'))
}

/**
 * A recorded line as README "Reading the preview" quotes it (b.deo SRI-804):
 * `recordedLine` for a change to the section of `mode`'s, from ` changed in
 * the`, after `…`. The declarative section's for `channels`, the fungible
 * section's for `invited`.
 */
function recordedLineQuote(section: ChannelMode): string {
  const fields: RecordedSectionKey[] = section === 'fungible' ? [FUNGIBLE_SECTION_KEY] : [CHANNELS_KEY]
  const line = recordedLine({ ...previewSample(), fields })
  const at = line.indexOf(' changed in the ')
  if (at < 0) throw new Error(`recordedLine renders no " changed in the ": ${line}`)
  return `…${line.slice(at)}`
}

/**
 * The README rows of b.deo SRI-1101 to SRI-1105 that T1's cases do not read
 * (`DocRow`, read by `docRowProblems`; each item self-checked by
 * `withItemCut`): one row per element, its passage the narrowest section,
 * unit, table row or entry that holds it. Setting names come from `src/` or
 * the typed names above; preview lines from their builders, as `DocItem`
 * thunks built when the row runs; labels from their exports.
 */
const README_DEO_ROWS: readonly DocRow[] = [
  // SRI-1102, the two modes: "## Channel modes" (T20 S2).
  ['Channel modes: what each mode serves, the switch, who sets delivery and the destination, per mode', readmeSection(WHAT_EACH_MODE_SERVES_HEADING), [
    ci(`| The switch | ${SWITCH} absent or ${code('false')}, the default | ${code(`${MODE_SWITCH_SETTING}: true`)} |`),
    ci(`The channels listed in its ${code(CHANNELS_KEY)} | Every public or private channel its Slack app is a member of that Slack marks as not externally shared`),
    ci(`The operator, with each channel entry's ${code(DELIVERY_KEY)} | The persona's agent, with ${TOOL}; ${code(MENTIONS)} otherwise`),
    ci(`| Destination of prompts and notices | ${code(PROMPTS_KEY)} | ${code(INVITED_DESTINATION)}, ${DM_VALUE} when it is absent`),
  ]],
  ['Channel modes: two separate sections, neither reading nor overriding the other', readmeSection(WHAT_EACH_MODE_SERVES_HEADING), [
    ci('**Each mode reads only its own section.** Neither reads nor overrides the other'),
    ci(`in declarative mode ${code(FUNGIBLE_SECTION_KEY)} is not read, and in fungible mode ${code(CHANNELS_KEY)} and the top-level ${code(PROMPTS_KEY)} are not read, whatever they hold`),
    ci('A persona may carry both sections, so switching back and forth needs no rewrite'),
  ]],
  ['Channel modes: turning fungible mode on serves, from the next message, every public or private channel each app is already in that is not externally shared, at mentions unless a stored choice applies, listed delivery not carried over', readmeSection(TURNING_FUNGIBLE_HEADING), [
    ci("**Turning it on.** From each channel's next message, fungible mode serves every public or private channel each persona's app is already in that is not externally shared"),
    ci(`Each channel is served at ${code(MENTIONS)} unless a stored choice applies`),
    ci(`Listed ${code(DELIVERY_KEY)} values are not carried over`),
  ]],
  [`Channel modes: before turning it on, the operator reviews each app's channels and past ${UNCLAIMED_CHANNEL} lines`, readmeSection(TURNING_FUNGIBLE_HEADING), [
    ci("Before you turn it on, review each persona's app's channel memberships in Slack, private channels included"),
    ci(`Past ${code(UNCLAIMED_CHANNEL)} lines in ${code('server.log')} show channels`),
    `grep ${UNCLAIMED_CHANNEL} ~/.claude/channels/slack/server.log*`,
  ]],
  ['Channel modes: upgrades stay declarative, with no migration', readmeSection(WHAT_EACH_MODE_SERVES_HEADING), [
    ci(`**Upgrades stay declarative.** A configuration without ${SWITCH} runs in declarative mode`),
    ci(`Upgrading needs no migration, and nothing rewrites ${code(CONFIG_FILE_NAME)}`),
  ]],
  ['Channel modes: switching and switching back go through pending and confirm, with no restart', readmeSection(TURNING_FUNGIBLE_HEADING), [
    ci('The switch changes through a confirmed edit, like every other setting'),
    ci('Read the pending preview. The switch has its own line'),
    ci('It applies in place, at once, from the next event, tool call, prompt and notice, with no restart, and every session is kept'),
    ci(`To turn it off, remove the setting or set it to ${code('false')}`),
    ci('**Turning it off.** The change is checked by the declarative rules'),
  ]],
  [`Channel modes: channel delivery, ${MENTIONS} by default, ${SET_CHANNEL_DELIVERY_TOOL}, and the loop guard`, readmeSection(FUNGIBLE_DELIVERY_HEADING), [
    ci(`**${code(MENTIONS)} is the default.** A channel is at ${code(ALL)} only when the persona's agent stored ${code(ALL)} for it with ${TOOL}`),
    ci(`**The loop guard.** A channel that is another persona's fungible destination (its ${code(INVITED_DESTINATION)} channel) is held at ${code(MENTIONS)} for every other persona, whatever they stored`),
    ci(`a ${DM_VALUE} destination holds nothing`),
    ci(`**Stored choices persist.** Each choice is kept in ${code(CHANNEL_DELIVERY_FILE_NAME)}`),
  ]],
  [`Channel modes: the ${RECEIVE_ALL_SHARED} approximation, a stored choice saying nothing of whether the other app remains in the channel`, readmeSection(FUNGIBLE_DELIVERY_HEADING), [
    ci(`**${code(RECEIVE_ALL_SHARED)} is an approximation.**`),
    ci("A stored choice says nothing about whether the other persona's app remains in the channel"),
  ]],
  [`Channel modes: the warning against two personas at ${ALL} in one channel`, readmeSection(FUNGIBLE_DELIVERY_HEADING), [
    ci(`**Don't keep two personas at ${code(ALL)} in one channel.**`),
    ci('the two can keep answering each other with no human involved'),
    ci(`If one should listen to everything, keep the other at ${code(MENTIONS)}`),
  ]],
  [`Channel modes: the fungible destination ${INVITED_DESTINATION}, "${DM_DESTINATION}" by default`, readmeSection(FUNGIBLE_PROMPTS_HEADING), [
    ci(`In fungible mode, a persona's destination is its ${code(INVITED_DESTINATION)}, ${DM_VALUE} when it is absent`),
    ci('**A channel ID:** any channel; it needs no listing and no DMs'),
    ci(`**${DM_VALUE}, written or by default:** a DM from the persona's app to its ${code(DM_CONTACT)}`),
  ]],

  // SRI-1101, the configuration sections T1's cases do not read (T20 S3).
  [`Server-wide settings: the opening paragraph names ${MODE_SWITCH_SETTING} as the one setting a confirmation applies in place`, unitOf('README.md', '#### Server-wide settings', 'These top-level fields apply'), [
    ci('A confirmed change to one takes effect at the next server start'),
    ci(`${SWITCH} is the one setting a confirmation applies in place, at once`),
  ]],
  [`Persona fields: ${CHANNELS_KEY} is a declarative-mode field`, tableRowOf('#### Persona fields', `${code(CHANNELS_KEY)} |`), [
    ci('in declarative mode, yes unless'),
    ci('Declarative mode only:'),
    ci('Not read in fungible mode'),
  ]],
  [`Persona fields: ${PROMPTS_KEY} is a declarative-mode field`, tableRowOf('#### Persona fields', `${code(PROMPTS_KEY)} |`), [
    ci('in declarative mode, yes'),
    ci('Declarative mode only:'),
    ci('Not read in fungible mode'),
  ]],
  [`Persona fields: the note on ${DM_KEY} names ${FUNGIBLE_SECTION_KEY}`, unitOf('README.md', '#### Persona fields', `${code(DM_KEY)} is an object`), [
    ci(`${code(FUNGIBLE_SECTION_KEY)} is an object holding ${code(INVITED_DESTINATION_KEY)}`),
  ]],
  // Each section's pointer into "## Channel modes" is read by `pointerProblems` (DECLARATIVE_POINTERS), not here.
  ['Channel entries: applies in declarative mode', readmeSection('#### Channel entries'), [
    ci('Channel entries apply in declarative mode'),
  ]],
  ['Channel delivery: applies in declarative mode', readmeSection('#### Channel delivery'), [
    ci('This section applies in declarative mode'),
  ]],
  ['Permission prompts: applies in declarative mode', readmeSection('#### Permission prompts'), [
    ci(`This section applies in declarative mode, where ${code(PROMPTS_KEY)} is required`),
  ]],
  ['Load-time rules: the switch is checked before any persona, and a non-boolean value is rejected naming it', readmeSection('#### Load-time rules'), [
    ci(`It checks the server-wide settings first, ${SWITCH} among them, before any persona, in either mode`),
    ci(`a non-boolean ${SWITCH} is rejected naming the setting`),
  ]],
  [`Load-time rules: in declarative mode ${FUNGIBLE_SECTION_KEY} is neither checked nor read`, readmeSection('#### Load-time rules'), [
    ci(`${code(FUNGIBLE_SECTION_KEY)} is neither checked nor read in declarative mode`),
  ]],
  [`Load-time rules: in fungible mode ${CHANNELS_KEY} and the top-level ${PROMPTS_KEY} are neither checked nor read`, readmeSection('#### Load-time rules'), [
    ci(`${code(CHANNELS_KEY)} and the top-level ${code(PROMPTS_KEY)} are neither checked nor read in fungible mode`),
  ]],
  [`Load-time rules: in fungible mode ${FUNGIBLE_SECTION_KEY} is an object holding only ${INVITED_DESTINATION_KEY}, "${DM_DESTINATION}" or a channel ID`, readmeSection('#### Load-time rules'), [
    ci(`${code(FUNGIBLE_SECTION_KEY)} isn't an object, or holds a key other than ${code(INVITED_DESTINATION_KEY)}`),
    ci(`${code(INVITED_DESTINATION)} is neither ${DM_VALUE} nor a well-formed channel ID`),
  ]],
  [`Load-time rules: in fungible mode a "${DM_DESTINATION}" destination, written or by default, needs ${DM_ENABLED} true and a ${DM_CONTACT}`, readmeSection('#### Load-time rules'), [
    ci(`The persona's destination is ${DM_VALUE}, written or by default, without ${code(`${DM_ENABLED}: true`)} or without a ${code(DM_CONTACT)}`),
  ]],
  ['Load-time rules: in fungible mode a channel destination needs no listing and no DMs', readmeSection('#### Load-time rules'), [
    ci('A channel destination needs no listing and no DMs'),
  ]],
  ['Load-time rules: the cross-persona rules apply in both modes', readmeSection('#### Load-time rules'), [
    ci("In both modes: - A persona's name or key equals another persona's name or key. - A persona's key starts with another persona's key"),
    ci(`Two personas share a ${code('working_directory' satisfies (typeof PERSONA_ENTRY_KEYS)[number])} or a ${code('credentials_file' satisfies (typeof PERSONA_ENTRY_KEYS)[number])}, compared by real path`),
  ]],
  ['Load-time rules: a change is judged by the mode it turns on, INVALID in each direction', readmeSection('#### Load-time rules'), [
    ci('A pending change is judged by the rules of the mode its own switch picks, not by the mode in effect'),
    ci(`A change that turns fungible mode on is ${INVALID} when a persona's ${code(FUNGIBLE_SECTION_KEY)} section breaks the fungible-mode rules`),
    ci(`a change that turns it off is ${INVALID} when a persona's ${code(CHANNELS_KEY)} or ${code(PROMPTS_KEY)} breaks the declarative-mode rules`),
  ]],

  // SRI-1102, receiving; SRI-1104, security (T20 S4).
  ...(['mention', 'broadcast'] as const).map((via): DocRow => [`receiving: the ${via} row, scoped per mode`, kindRowOf(via), [
    ci(`In declarative mode: in a channel listed in ${via === 'mention' ? 'its' : "the persona's"} ${code(CHANNELS_KEY)}`),
    ci('In fungible mode: in a public or private channel its app is in that is not externally shared, at either channel delivery'),
  ]]),
  [`receiving: the ${RECEIVE_ALL_SHARED} row, scoped per mode`, kindRowOf(RECEIVE_ALL_SHARED), [
    ci(`In declarative mode: in a channel listed in its ${code(CHANNELS_KEY)} with ${code(`${DELIVERY_KEY}: ${ALL}`)}, when at least one other persona`),
    ci(`In fungible mode: in a public or private channel its app is in that is not externally shared, where its channel delivery is ${code(ALL)}`),
    ci(`has a channel delivery of ${code(ALL)} for that channel by the same rule, whether or not that persona's app remains in the channel`),
  ]],
  ['receiving: the receive_all row, scoped per mode', kindRowOf('receive_all'), [
    ci(`In declarative mode: in a channel listed in its ${code(CHANNELS_KEY)} with ${code(`${DELIVERY_KEY}: ${ALL}`)}, when no other persona`),
    ci(`In fungible mode: in a public or private channel its app is in that is not externally shared, where its channel delivery is ${code(ALL)}, when no other persona in the applied configuration has a channel delivery of ${code(ALL)} for that channel`),
  ]],
  ['receiving: in fungible mode an @mention is delivered from its message event', unitOf('README.md', RECEIVING_HEADING, '- **In fungible mode, an @mention is delivered from its'), [
    ci(`**In fungible mode, an @mention is delivered from its ${code('message')} event.**`),
    ci(`the ${code('app_mention')} event decides nothing and the ${code('message')} event carrying the same mention decides`),
  ]],
  ['receiving: "Anyone in the workspace can reach a persona", in both modes', unitOf('README.md', RECEIVING_HEADING, '- **Anyone in the workspace can reach a persona,**'), [
    ci('**Anyone in the workspace can reach a persona,** in both modes'),
    ci(`in declarative mode in its listed channels, by each channel's ${code(DELIVERY_KEY)}`),
    ci('in fungible mode in every channel its app is invited to that it serves, by its channel delivery there'),
    ci(`in both modes by DM when its ${code(DM_ENABLED)} is ${code('true')}`),
  ]],
  ["security: an invite changes a persona's audience", readmeSection(WHO_CAN_REACH_HEADING), [
    ci("Each persona's Claude worker runs with tool access on the host"),
    ci("**An invite changes a persona's audience.**"),
  ]],
  ['security: any member can point a worker at any channel they are in, private channels included, which the operator may not see', readmeSection(WHO_CAN_REACH_HEADING), [
    ci("Any workspace member can point a persona's worker at any channel they are in by inviting the persona's app there"),
    ci('This includes private channels, which the operator may not be able to see'),
  ]],
  [`security: anyone who can reach the persona can switch any channel it serves to ${ALL}, one they are not in included`, readmeSection(WHO_CAN_REACH_HEADING), [
    ci(`**Anyone who can reach the persona can switch a channel to ${code(ALL)}.** In any channel it serves, or by DM, anyone can ask the persona to switch any channel it serves to ${code(ALL)}, including a channel they are not in`),
    ci('From then on, every message in that channel reaches the worker'),
  ]],
  ['security: fetch_messages reads every channel the app is in, so content can be carried between channels', readmeSection(WHO_CAN_REACH_HEADING), [
    ci(`**${code('fetch_messages' satisfies (typeof TARGETING_TOOLS)[number])} reads every channel the app is in.**`),
    ci('so content can be carried from one channel to another'),
  ]],
  ['security: Slack Connect channels are never served in fungible mode', readmeSection(WHO_CAN_REACH_HEADING), [
    ci('**Slack Connect channels are never served.** An externally shared channel is never served in fungible mode'),
  ]],
  ["security: an Enterprise Grid channel is served when Slack marks it not externally shared, so every sharing workspace's members can reach the persona", readmeSection(WHO_CAN_REACH_HEADING), [
    ci("**Enterprise Grid: Slack's flag decides.**"),
    ci('is served when Slack marks it as not externally shared, and then members of every workspace sharing it can reach the persona'),
  ]],
  [`security: the audit lines ${PERSONA_INVITED_CHANNEL} and ${PERSONA_CHANNEL_DELIVERY_SET}`, readmeSection(WHO_CAN_REACH_HEADING), [
    ci(`The audit lines in ${code('server.log')} are ${code(PERSONA_INVITED_CHANNEL)}, logged the first time a persona hears a channel in fungible mode`),
    ci(`and ${code(PERSONA_CHANNEL_DELIVERY_SET)}, logged for each stored ${TOOL} choice`),
  ]],
  ["security: log rotation can discard a channel's only audit line, and a restart logs every heard channel again", readmeSection(WHO_CAN_REACH_HEADING), [
    ci("log rotation can discard a channel's only audit line"),
    ci('After a restart, the first event from each channel a persona hears in fungible mode logs its line again'),
  ]],

  // SRI-1103, the introduction, "Personas (config.json)" and "Tools" (T20 S5).
  ['introduction: the channels a persona serves, per mode', unitOf('README.md', README_TITLE_HEADING, 'A single HTTP MCP server'), [
    ci('in declarative mode, the default, the channels it is configured into; in fungible mode, every public or private channel its Slack app is invited to that is not externally shared'),
  ]],
  ["introduction: what a persona's tool calls may target, per mode", unitOf('README.md', README_TITLE_HEADING, 'A single HTTP MCP server'), [
    ci("Each persona's tool calls act as that persona: in declarative mode only in the channels it is configured into, in fungible mode in any channel ID it names, where the call goes to Slack, which decides"),
  ]],
  ['Personas (config.json): the channels a persona serves and its tools may target, per mode', unitOf('README.md', PERSONAS_HEADING, 'Each bot is a **persona**'), [
    ci('In declarative mode, the default, those are the channels it is configured into, and its tools may target only them'),
    ci('in fungible mode, they are the public and private channels its app is invited to that are not externally shared, and its tools may target any channel ID: the call goes to Slack, which decides'),
  ]],
  ['Tools: in declarative mode a refused target sends nothing to Slack', unitOf('README.md', TOOLS_HEADING, '- **In declarative mode,**'), [
    ci("a tool call with any other target, a channel the persona isn't configured into included, is refused with a tool error naming the persona and the target, and nothing is sent to Slack"),
  ]],
  ["Tools: in fungible mode a target that is no channel ID or allowed DM target is refused before any Slack call (FUNGIBLE_TARGET_REFUSAL), and Slack's refusal of any other reaches the persona", unitOf('README.md', TOOLS_HEADING, '- **In fungible mode,**'), [
    ci(`a target that ${FUNGIBLE_TARGET_REFUSAL.replace(/^it /, '').replace(/\.$/, '')} is refused before any Slack call, with a tool error naming the persona and the target`),
    ci('Any other channel target goes to Slack, which decides'),
    ci(`for example ${code('not_in_channel')} for a channel the persona's app is not in, reaches the persona as a tool error naming the persona, the channel and Slack's error code`),
  ]],
  ...TARGETING_TOOLS.map((tool): DocRow => [`Tools: the ${tool} row states its targets in each mode`, toolRowOf(tool), [
    ci(tool === 'reply' ? "in declarative mode one of the persona's configured channels; in fungible mode any channel ID" : 'a configured channel in declarative mode; any channel ID in fungible mode'),
  ]]),
  [`Tools: the ${SET_CHANNEL_DELIVERY_TOOL} row, exactly one`, toolRowOf(SET_CHANNEL_DELIVERY_TOOL), [
    anchorLink(FUNGIBLE_DELIVERY_HEADING),
    ci(`Two inputs: ${code('channel')}, a channel ID, and ${code(DELIVERY_KEY)}, ${code(MENTIONS)} or ${code(ALL)}`),
    ci('It works only in fungible mode: every call is refused in declarative mode'),
    ci(`and while ${code(CHANNEL_DELIVERY_FILE_NAME)} is unreadable`),
    ci('It accepts only a channel the persona has heard a message from in fungible mode since it came up, or one it holds a stored choice for'),
    ci('It makes no Slack call'),
    ci(`The choice persists in ${code(CHANNEL_DELIVERY_FILE_NAME)} and applies from the next message in that channel`),
    ci(`says so when the loop guard holds the channel at ${code(MENTIONS)}`),
    ci(`Each accepted call logs one ${code(PERSONA_CHANNEL_DELIVERY_SET)} line`),
    ci('It changes no configuration and applies no reload'),
  ]],
  ['Tools: the known residual in an externally shared channel the app is in (SRI-603)', readmeSection(TOOLS_HEADING), [
    ci("CSCB makes no Slack call to learn whether a channel holds the persona's app, is externally shared or is a group DM"),
    ci('So in fungible mode it refuses no post, read, reaction or edit in an externally shared channel that the app belongs to'),
  ]],
  ['Tools: the known residual in a group DM the app is in, where Slack refuses reads (SRI-603)', readmeSection(TOOLS_HEADING), [
    ci('The same holds in a group DM the app belongs to, except that Slack refuses reads there'),
    ci(`the app has no ${code('mpim:history')} scope`),
  ]],
  [`Tools: the permission-prompt note for ${SET_CHANNEL_DELIVERY_TOOL}`, readmeSection(TOOLS_HEADING), [
    ci("On a host whose Claude Code permission settings don't allow the server's tools as a group"),
    ci(`the first ${TOOL} call raises a permission prompt, in either mode`),
  ]],
  [`Startup errors: the ${JSONL_DIAGNOSIS_INCONCLUSIVE_ENTRY_CLASS} item gives the fungible-mode reason (FUNGIBLE_MODE_ZERO_REASON, SRI-704)`, (readme) => readmeLabelItem(STARTUP_ERRORS_HEADING, JSONL_DIAGNOSIS_INCONCLUSIVE_ENTRY_CLASS, readme), [
    fungibleZeroReasonQuoted,
    ci('so the archive counts no channel and a zero count proves nothing'),
  ]],

  // SRI-1103, Reload outside "What a confirmation applies" (T20 S6).
  [`Files beside the config file: ${CHANNEL_DELIVERY_FILE_NAME}, what it holds, only the server writes it, never edit it by hand`, tableRowOf('### Files beside the config file', `${code(CHANNEL_DELIVERY_FILE_NAME)} |`), [
    ci("The stored-choice file: each persona's stored channel-delivery choices"),
    ci('It holds no token and no message text'),
    ci('Only the server reads and writes it, never the CLI'),
    ci(`It is absent until the first accepted ${TOOL} call, so it is never created in declarative mode`),
    ci('Never edit it by hand'),
    ci('The server reads it once at each start'),
  ]],
  [`Files beside the config file: ${CHANNEL_DELIVERY_FILE_NAME}, the unreadable state, linked to the debugging skill`, tableRowOf('### Files beside the config file', `${code(CHANNEL_DELIVERY_FILE_NAME)} |`), [
    `[${code(CHANNEL_DELIVERY_UNREADABLE)}](${DEBUG_SKILL_FILE}${anchorLink(code(CHANNEL_DELIVERY_UNREADABLE)).slice(1)}`,
    ci('starts and runs every persona, but for that run no stored choice applies'),
    ci(`in fungible mode every channel is at ${code(MENTIONS)}, ${TOOL} is refused, and nothing is written to the file or dropped from it`),
  ]],
  [`Files beside the config file: ${CHANNEL_DELIVERY_FILE_NAME}, its fix is moving it aside`, tableRowOf('### Files beside the config file', `${code(CHANNEL_DELIVERY_FILE_NAME)} |`), [
    ci('To fix it, move the file aside, then restart the server; this discards every stored choice'),
  ]],
  [`Files beside the config file: ${CHANNEL_DELIVERY_FILE_NAME}, the residual of restoring an unreadable file (SRI-409)`, tableRowOf('### Files beside the config file', `${code(CHANNEL_DELIVERY_FILE_NAME)} |`), [
    ci('If you restore that same file in place instead of moving it aside, a persona removed and added back with the same'),
    ci('while it was unreadable gets its earlier choices again'),
  ]],
  [`Size limit: ${CHANNEL_DELIVERY_FILE_NAME} has no size cap`, readmeSection('### Size limit'), [
    ci(`and the stored-choice file (${code(CHANNEL_DELIVERY_FILE_NAME)}) have no size cap`),
  ]],
  [`Reading the preview: the header counts the switch among the server-wide settings, and a persona with only recorded changes is not counted`, readmeSection('### Reading the preview'), [
    ci(`and the server-wide settings changed, the switch ${SWITCH} among them`),
    ci('A persona whose only changes are recorded ones (changes to the section not in force, see the table below) is not counted as modified'),
  ]],
  ["Reading the preview: the switch's line, as modeSwitchLine renders it in each direction, and its row", readmeSection('### Reading the preview'), [
    () => `| ${code(switchLineQuote('fungible'))} |`,
    () => `| ${code(switchLineQuote('declarative'))} |`,
    () => ci(`ends ${code(switchLineNoPersonaEnding())} when there is none`),
    ci('Unlike other server-wide settings, it applies at once, with no restart, and every session is kept'),
  ]],
  ['Reading the preview: the recorded lines, as recordedLine renders them for each section, and their row', readmeSection('### Reading the preview'), [
    () => code(recordedLineQuote('declarative')),
    () => code(recordedLineQuote('fungible')),
    ci(`(${code(CHANNELS_KEY)} or ${code(PROMPTS_KEY)} in fungible mode, ${code(FUNGIBLE_SECTION_KEY)} in declarative mode)`),
    ci('These lines come after every persona line and before the server-wide setting lines'),
    ci(`A change made only of recorded changes previews as ${code(NO_EFFECTIVE_CHANGE)}, followed by its recorded lines`),
  ]],
  [`Confirming a change: the switch is the exception to "recorded and take effect later"`, readmeSection('### Confirming a change'), [
    ci(`next-launch and server-wide settings are recorded and take effect later, except the switch ${SWITCH}, which applies in place at once`),
  ]],
  [`Confirming a change: ${RELOAD_NOOP} covers a confirmation of recorded changes only`, tableRowOf('### Confirming a change', `\`[slack] ${RELOAD_NOOP}:`), [
    ci('as for a confirmation whose only changes are recorded ones (changes to the section not in force)'),
  ]],
  [`Confirming a change: ${RELOAD_RECORD_WRITE_FAILED} names the stored-choice file (SRI-408)`, tableRowOf('### Confirming a change', `\`[slack] ${RELOAD_RECORD_WRITE_FAILED}:`), [
    ci(`The line can also name the stored-choice file (${code(CHANNEL_DELIVERY_FILE_NAME)})`),
    ci('a confirmation that brings up a persona whose stored choices were dropped earlier, by a write that failed, first writes that file'),
    ci("when it can't, nothing is applied, the retired-key record is not written, and the change stays pending"),
  ]],
  ['When next-launch and server-wide changes take effect: the switch takes effect once confirmed, with no restart', readmeSection('### When next-launch and server-wide changes take effect'), [
    ci(`Server-wide settings take effect at the next server start, except the switch ${SWITCH}: it takes effect when the change is confirmed, and needs no ${code(CLI_COMMAND_CLEAN_RESTART)}`),
  ]],

  // SRI-1105, troubleshooting and downgrade (T20 S8).
  [`"${SILENT_INVITED_TITLE}": declarative mode, listing the channel or turning fungible mode on`, titledEntry(SILENT_INVITED_TITLE), [
    ci(`**Declarative mode.** With ${SWITCH} absent or ${code('false')}, a persona serves only the channels listed in its ${code(CHANNELS_KEY)}`),
    ci(`each message from a channel no applied persona lists logs an ${code(UNCLAIMED_CHANNEL)} line`),
    ci('List the channel, or turn fungible mode on'),
  ]],
  [`"${SILENT_INVITED_TITLE}": an externally shared channel`, titledEntry(SILENT_INVITED_TITLE), [
    ci('**An externally shared channel.** Fungible mode never serves a Slack Connect channel'),
    ci(`with the reason ${code(UNCLAIMED_REASON_EXTERNALLY_SHARED)}`),
    ci('Serve it in declarative mode, with the channel listed'),
  ]],
  [`"${SILENT_INVITED_TITLE}": a group DM`, titledEntry(SILENT_INVITED_TITLE), [
    ci('**A group DM.** A DM with more than one person is never served, in either mode'),
  ]],
  [`"${SILENT_INVITED_TITLE}": an edit that adds a mention`, titledEntry(SILENT_INVITED_TITLE), [
    ci('**An edit that adds a mention.** In fungible mode, an @mention is delivered from its message'),
    ci('Post a new message that mentions it'),
  ]],
  [`"${SILENT_INVITED_TITLE}": a message posted before the invite`, titledEntry(SILENT_INVITED_TITLE), [
    ci("**A message posted before the invite.** Slack sends the persona's app no event for a message posted before the app joined the channel"),
  ]],
  [`"${RECEIVES_EVERYTHING_TITLE}": an agent chose ${ALL}`, titledEntry(RECEIVES_EVERYTHING_TITLE), [
    ci(`In fungible mode, the persona's agent chose ${code(ALL)} for that channel with ${TOOL}`),
    ci(`each such choice logs a ${code(PERSONA_CHANNEL_DELIVERY_SET)} line`),
  ]],
  [`"${RECEIVES_EVERYTHING_TITLE}": ask the persona to switch back`, titledEntry(RECEIVES_EVERYTHING_TITLE), [
    ci(`Ask the persona, in that channel or by DM, to switch the channel back to ${code(MENTIONS)}`),
  ]],
  [`"${RECEIVES_EVERYTHING_TITLE}": remove the app from the channel`, titledEntry(RECEIVES_EVERYTHING_TITLE), [
    ci("Remove the persona's app from the channel"),
  ]],
  [`"${RECEIVES_EVERYTHING_TITLE}": turn the switch off`, titledEntry(RECEIVES_EVERYTHING_TITLE), [
    ci('Turn fungible mode off'),
  ]],
  [`"${UNCLAIMED_ENTRY_TITLE}": the ${UNCLAIMED_CHANNEL} fix in declarative mode, fungible mode the other fix, never for a group DM`, titledEntry(UNCLAIMED_ENTRY_TITLE), [
    ci(`**In declarative mode,** the channel is in no persona's ${code(CHANNELS_KEY)}`),
    ci(`Add the channel to a persona's ${code(CHANNELS_KEY)} and apply the change`),
    ci('For a public or private channel that is not externally shared, turning fungible mode on is the other fix'),
    ci('a group DM is never served'),
  ]],
  [`"${UNCLAIMED_ENTRY_TITLE}": the ${UNCLAIMED_CHANNEL} fix in fungible mode, each reason (FUNGIBLE_REFUSAL_TEXTS); for every reason but a malformed channel ID, served only in declarative mode with the channel listed; a malformed channel ID served in neither mode`, titledEntry(UNCLAIMED_ENTRY_TITLE), [
    ci("**In fungible mode,** the line says why fungible mode doesn't serve the channel"),
    // Each reason inside the sentence that lists them, since one is named again after it.
    ...Object.values(FUNGIBLE_REFUSAL_TEXTS).map((reason) => new RegExp(`${escapeRegExp("the line says why fungible mode doesn't serve the channel: ")}[^.]*${escapeRegExp(code(reason))}`, 'i')),
    ci(`For every reason but ${code(UNCLAIMED_REASON_CHANNEL_ID_MALFORMED)}, the channel is served only in declarative mode, with the channel listed`),
    ci('Neither mode serves a malformed channel ID: declarative mode rejects a listed one'),
  ]],
  [`Downgrading: an earlier release rejects ${MODE_SWITCH_SETTING} and ${FUNGIBLE_SECTION_KEY}, so the record must hold neither`, readmeSection(DOWNGRADE_HEADING), [
    ci(`An earlier release's loader rejects ${SWITCH} and ${code(FUNGIBLE_SECTION_KEY)} as unknown keys`),
    ci('so the record must not hold either key when the older build starts'),
  ]],
  ['Downgrading: step 1 gives every persona a valid declarative section', downgradeStep(1), [
    ci('**Give every persona a valid declarative section.**'),
  ]],
  [`Downgrading: step 2 removes both keys from ${CONFIG_FILE_NAME}`, downgradeStep(2), [
    ci(`**Remove ${SWITCH} and every persona's ${code(FUNGIBLE_SECTION_KEY)} from ${code(CONFIG_FILE_NAME)}.**`),
  ]],
  ['Downgrading: step 3 confirms the change', downgradeStep(3), [
    ci('**Confirm the pending change, and wait for its'),
    ci(`${code(RELOAD_APPLIED)} or ${code(RELOAD_NOOP)} line**`),
  ]],
  [`Downgrading: step 4 installs the older build, which ignores ${CHANNEL_DELIVERY_FILE_NAME}`, downgradeStep(4), [
    ci('**Install the older build and restart the server on it.**'),
    ci(`The older build ignores ${code(CHANNEL_DELIVERY_FILE_NAME)}`),
  ]],
]

/** The setup wizard's step on how a change takes effect, found by its title, whatever its number. */
const WIZARD_TAKES_EFFECT_HEADING = /^### Step \d+ — How the change takes effect$/

/**
 * The switch's preview line in its second carrier, the setup wizard's step on
 * how a change takes effect (b.deo SRI-803): the step quotes the line as
 * README "Reading the preview" does, so it is read against `modeSwitchLine`
 * in each direction (`switchLineQuote`) as the README's row is. Read here, so
 * the wizard's own suite renders no builder.
 */
const WIZARD_SWITCH_LINE_ROW: DocRow = [
  `${WIZARD_FILE}: the switch's line, as modeSwitchLine renders it in each direction`,
  sectionOf(WIZARD_FILE, WIZARD_TAKES_EFFECT_HEADING),
  [() => code(switchLineQuote('fungible')), () => code(switchLineQuote('declarative'))],
]

/** Where a README heading must stand: exactly once, inside `parent`, right after `previous` (the nearest heading at its level or above), and after a line matching `after`. */
interface Placement {
  heading: string
  parent?: string
  previous?: string
  next?: string
  after?: RegExp
}

/** `p`'s problems in `readme`; `[]` when the heading stands where `p` says. Pure. */
function placementProblems(readme: string, p: Placement): string[] {
  const all = headings(readme)
  const found = all.filter((h) => h.text === p.heading)
  if (found.length !== 1) return [`${found.length} headings "${p.heading}", expected 1`]
  const [h] = found
  const i = all.indexOf(h)
  const problems: string[] = []
  if (p.parent !== undefined) {
    const range = sectionRange(readme, p.parent)
    if (range === undefined || h.line <= range.start || h.line >= range.end) problems.push(`not inside "${p.parent}"`)
  }
  const previous = all.slice(0, i).reverse().find((o) => o.level <= h.level)
  if (p.previous !== undefined && previous?.text !== p.previous) problems.push(`after "${previous?.text}", expected right after "${p.previous}"`)
  const next = all.slice(i + 1).find((o) => o.level <= h.level)
  if (p.next !== undefined && next?.text !== p.next) problems.push(`before "${next?.text}", expected right before "${p.next}"`)
  if (p.after !== undefined) {
    const at = readme.split('\n').findIndex((line) => p.after!.test(line))
    if (at < 0 || at > h.line) problems.push(`not after a line matching ${String(p.after)}`)
  }
  return problems
}

/**
 * The headings b.deo SRI-1102, SRI-1104 and SRI-1105 add, as T17 placed
 * them: `## Channel modes` between `## Configuration` and `## Reload`, its
 * four subsections in order inside it, the security subsection inside the
 * receiving section after its "Anyone in the workspace" bullet, and the
 * downgrade section a `###` of its own (the "Upgrading to personas" cases
 * read that section alone) right after "Upgrading to personas".
 */
const README_DEO_PLACEMENTS: readonly Placement[] = [
  { heading: CHANNEL_MODES_HEADING, previous: CONFIGURATION_HEADING, next: RELOAD_HEADING },
  ...CHANNEL_MODES_SUBSECTIONS.map((heading, i): Placement => ({
    heading,
    parent: CHANNEL_MODES_HEADING,
    previous: i === 0 ? CHANNEL_MODES_HEADING : CHANNEL_MODES_SUBSECTIONS[i - 1],
  })),
  { heading: WHO_CAN_REACH_HEADING, parent: RECEIVING_HEADING, previous: RECEIVING_HEADING, after: /^- \*\*Anyone in the workspace can reach a persona,\*\*/ },
  { heading: DOWNGRADE_HEADING, parent: MIGRATION_HEADING, previous: `### ${UPGRADING_TITLE}` },
]

/** Each declarative-scoped configuration section and the `## Channel modes` subsection its pointer must link (b.deo SRI-1101). */
const DECLARATIVE_POINTERS: readonly [section: string, target: string][] = [
  ['#### Channel entries', WHAT_EACH_MODE_SERVES_HEADING],
  ['#### Channel delivery', FUNGIBLE_DELIVERY_HEADING],
  ['#### Permission prompts', FUNGIBLE_PROMPTS_HEADING],
]

/** The pointer from `section` to `target`'s problems: no same-file link to its anchor, or the anchor resolving to no heading, another heading, or one outside `## Channel modes`. Pure. */
function pointerProblems(readme: string, section: string, target: string): string[] {
  const anchor = anchorLink(target).slice(2, -1)
  const problems = markdownLinks(requiredSection(readme, section, 'README.md')).some((link) => link.path === '' && link.anchor === anchor) ? [] : [`no link to #${anchor}`]
  const heading = headingAt(readme, anchor)
  if (heading?.text !== target) problems.push(`#${anchor} resolves to ${heading === undefined ? 'no heading' : `"${heading.text}"`}`)
  const modes = sectionRange(readme, CHANNEL_MODES_HEADING)
  if (heading !== undefined && (modes === undefined || heading.line <= modes.start || heading.line >= modes.end)) problems.push(`#${anchor} is not inside "${CHANNEL_MODES_HEADING}"`)
  return problems
}

/** Every same-file link in the README's prose whose anchor names no README heading. Pure. */
function brokenReadmeAnchors(readme: string): string[] {
  const anchors = headingAnchors(readme)
  return markdownLinks(splitFences(readme).prose).filter((link) => link.path === '' && link.anchor !== '' && !anchors.includes(link.anchor)).map((link) => link.target)
}

/** `readme` with the section under `heading` (its heading line to the end of its range) cut and appended at the end. */
function withSectionMovedToEnd(readme: string, heading: string): string {
  const range = sectionRange(readme, heading)
  if (range === undefined) throw new Error(`README.md has no heading "${heading}"`)
  const lines = readme.split('\n')
  return [...lines.slice(0, range.start), ...lines.slice(range.end), '', ...lines.slice(range.start, range.end)].join('\n')
}

/** `readme` with each line `edit` matches replaced; throws when none does. */
function withLineEdited(readme: string, match: (line: string) => boolean, edit: (line: string) => string): string {
  const lines = readme.split('\n')
  if (!lines.some(match)) throw new Error('no line to edit')
  return lines.map((line) => (match(line) ? edit(line) : line)).join('\n')
}

describe('b.deo SRI-1308: the README describes both channel modes (SRI-1101 to SRI-1105; AC 42)', () => {
  const readme = () => operatorText('README.md')

  describe('headings', () => {
    test.each(README_DEO_PLACEMENTS.map((p) => [p.heading, p] as const))('"%s" appears once, where T17 placed it', (_heading, placement) => {
      expect(placementProblems(readme(), placement)).toEqual([])
    })

    test.each(README_DEO_PLACEMENTS.flatMap((p) => [
      ['renamed', p, (text: string) => withLineEdited(text, (line) => line === p.heading, (line) => `${line} again`)],
      ['removed', p, (text: string) => withLineEdited(text, (line) => line === p.heading, () => '')],
      ['moved', p, (text: string) => withSectionMovedToEnd(text, p.heading)],
    ] as const).map(([how, p, edit]) => [p.heading, how, p, edit] as const))('self-check: "%s" %s, on an edited copy, fails its case', (_heading, _how, placement, edit) => {
      const edited = edit(readme())
      expect(edited).not.toBe(readme())
      expect(placementProblems(edited, placement)).not.toEqual([])
    })
  })

  describe('rows', () => {
    test.each(README_DEO_ROWS)('%s', (element, passage, required) => {
      expect({ element, problems: docRowProblems(passage, required, readme()) }).toEqual({ element, problems: [] })
    })

    test.each(README_DEO_ROWS)('self-check: %s: each of its items, cut from its passage in the README, is reported by the row', (element, passage, required) => {
      for (const item of required.map(resolveItem)) {
        const edited = withItemCut(readme(), passage, item)
        expect({ element, item: String(item), reported: docRowProblems(passage, required, edited).includes(`lacks ${String(item)}`) }).toEqual({ element, item: String(item), reported: true })
      }
    })

    test('self-check: an item whose builder throws fails its own row with the error, and the row still reads its other items', () => {
      const passage = readmeSection('### Reading the preview')
      const broken = () => {
        throw new Error('modeSwitchLine renders no mode or persona list')
      }
      expect(docRowProblems(passage, [broken, ci('no such phrase anywhere')], readme())).toEqual([
        'modeSwitchLine renders no mode or persona list',
        `lacks ${String(ci('no such phrase anywhere'))}`,
      ])
    })
  })

  describe('pointers from the declarative-scoped sections (SRI-1101)', () => {
    test.each(DECLARATIVE_POINTERS)('"%s" links "%s", and the link resolves', (section, target) => {
      expect(pointerProblems(readme(), section, target)).toEqual([])
    })

    test.each(DECLARATIVE_POINTERS)('self-check: "%s" with its link to "%s" dropped, or that heading renamed, fails', (section, target) => {
      const anchor = anchorLink(target).slice(2, -1)
      const unlinked = readme().replaceAll(`](#${anchor})`, ']')
      expect(unlinked).not.toBe(readme())
      expect(pointerProblems(unlinked, section, target)).toEqual([`no link to #${anchor}`])
      const renamed = withLineEdited(readme(), (line) => line === target, (line) => `${line} again`)
      expect(pointerProblems(renamed, section, target)).toEqual([`#${anchor} resolves to no heading`])
    })
  })

  describe(`the tools table (SRI-1103)`, () => {
    const toolsTable = (text: string) => firstTable(requiredSection(text, TOOLS_HEADING, 'README.md'))

    test(`its first column lists exactly six tools: ${TARGETING_TOOLS.join(', ')} and ${SET_CHANNEL_DELIVERY_TOOL}`, () => {
      const { header, rows } = toolsTable(readme())
      expect(header[0]).toBe('Tool')
      expect(rows.map(([tool]) => tool).sort()).toEqual([...TARGETING_TOOLS, SET_CHANNEL_DELIVERY_TOOL].map(code).sort())
    })

    test(`self-check: the ${SET_CHANNEL_DELIVERY_TOOL} row removed, duplicated, or the tool renamed in src/, fails its row`, () => {
      const passage = toolRowOf(SET_CHANNEL_DELIVERY_TOOL)
      const isRow = (line: string) => line.startsWith(`| ${TOOL} |`)
      const removed = withLineEdited(readme(), isRow, () => '')
      const duplicated = withLineEdited(readme(), isRow, (line) => `${line}\n${line}`)
      expect(() => passage(removed)).toThrow('0 table rows')
      expect(() => passage(duplicated)).toThrow('2 table rows')
      expect(() => toolRowOf(`${SET_CHANNEL_DELIVERY_TOOL}_renamed`)(readme())).toThrow('0 table rows')
      expect(toolsTable(removed).rows.map(([tool]) => tool)).not.toContain(TOOL)
    })

    test('self-check: a third residual bullet fails no case: the residual rows and the six-tool case still pass', () => {
      const edited = withLineEdited(
        readme(),
        (line) => line.startsWith('- The same holds in a group DM the app belongs to'),
        (line) => `${line}\n- Slack accepts a reaction in a channel the app is not in.`,
      )
      const residualRows = README_DEO_ROWS.filter(([element]) => element.startsWith('Tools: the known residual') || element.startsWith('Tools: the permission-prompt note'))
      expect(residualRows).toHaveLength(3)
      expect(residualRows.flatMap(([, passage, required]) => docRowProblems(passage, required, edited))).toEqual([])
      expect(toolsTable(edited).rows).toHaveLength(TARGETING_TOOLS.length + 1)
    })
  })

  describe('"Reading the preview": the lines it quotes are the builders\' (SRI-803, SRI-804)', () => {
    describe(`the switch's line in its second carrier, ${WIZARD_FILE} (SRI-803)`, () => {
      const wizard = () => operatorText(WIZARD_FILE)
      const [element, passage, required] = WIZARD_SWITCH_LINE_ROW

      test(element, () => {
        expect(docRowProblems(passage, required, wizard())).toEqual([])
      })

      test('self-check: the quote cut from the step, or reworded, is reported by the row', () => {
        for (const item of required.map(resolveItem)) {
          const edited = withItemCut(wizard(), passage, item)
          expect(docRowProblems(passage, required, edited)).toContain(`lacks ${String(item)}`)
        }
        const reworded = wizard().replace('applied in place at once, from the next event,', 'applied at once, from the next event,')
        expect(reworded).not.toBe(wizard())
        expect(docRowProblems(passage, required, reworded)).not.toEqual([])
      })

      test('self-check: the step found by its title, so its heading renamed is reported', () => {
        const renamed = withLineEdited(wizard(), (line) => WIZARD_TAKES_EFFECT_HEADING.test(line), (line) => `${line} again`)
        expect(docRowProblems(passage, required, renamed)).toEqual([`${WIZARD_FILE} has no heading matching ${String(WIZARD_TAKES_EFFECT_HEADING)}`])
        const renumbered = withLineEdited(wizard(), (line) => WIZARD_TAKES_EFFECT_HEADING.test(line), (line) => line.replace(/Step \d+/, 'Step 12'))
        expect(docRowProblems(passage, required, renumbered)).toEqual([])
      })
    })

    test(`every example's header line opens with PENDING_PREVIEW_TITLE`, () => {
      const blocks = splitFences(requiredSection(readme(), '### Reading the preview', 'README.md')).blocks
      expect(blocks.length).toBeGreaterThanOrEqual(2)
      for (const block of blocks) expect(block.body.split('\n').filter((line) => line.startsWith(PENDING_PREVIEW_TITLE))).toHaveLength(1)
    })

    describe('the fungible-mode example through the real loader', () => {
      let dir: string

      beforeEach(() => {
        dir = realpathSync(mkdtempSync(join(tmpdir(), 'shipped-docs-preview-')))
      })

      afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
      })

      /**
       * The second example, a body excerpt (no title, no `fingerprint:` line),
       * is the preview of the change the README describes, made to the
       * declarative `#### Example`: the switch turned on, `planner` given an
       * `invited.permission_prompts` (its home channel, so the candidate is
       * valid), and `reviewer`'s `channels` edited. Both configurations load
       * through the real loader in a temp dir; the plan's rendered lines must
       * be the block's lines, byte for byte.
       */
      test('the fungible-mode example is renderPreviewLines of the change it describes, made to the declarative Example', () => {
        const home = join(dir, 'home')
        mkdirSync(home)
        const load = (name: string, raw: unknown): PersonaConfig => {
          const path = join(dir, name)
          writeFileSync(path, JSON.stringify(raw))
          return loadPersonaConfig(path, home)
        }
        const example = JSON.parse(completeExample(readme())) as { personas: Record<string, unknown>[] } & Record<string, unknown>
        const applied = load('applied.json', example)
        const candidate = structuredClone(example)
        candidate[MODE_SWITCH_SETTING] = true
        const byName = (name: string) => {
          const persona = candidate.personas.find((p) => p.name === name)
          if (persona === undefined) throw new Error(`the declarative Example has no persona "${name}"`)
          return persona
        }
        const planner = byName('planner')
        planner[FUNGIBLE_SECTION_KEY] = { [INVITED_DESTINATION_KEY]: planner[PROMPTS_KEY] }
        const reviewer = byName('reviewer')
        reviewer[CHANNELS_KEY] = [...(reviewer[CHANNELS_KEY] as unknown[]), { id: planner[PROMPTS_KEY], [DELIVERY_KEY]: MENTIONS }]
        const plan = buildChangePlan(applied, { kind: 'valid', config: load('candidate.json', candidate) }, { realPath: (path) => path, home })
        assertNoLeak(plan, 'preview plan')
        const blocks = splitFences(requiredSection(readme(), '### Reading the preview', 'README.md')).blocks
        const excerpts = blocks.filter((block) => block.body.startsWith(PENDING_PREVIEW_TITLE))
        expect(excerpts).toHaveLength(1)
        expect(excerpts[0].body.trimEnd().split('\n')).toEqual(renderPreviewLines(plan))
      })
    })
  })

  describe('troubleshooting entries (SRI-1105)', () => {
    test.each([SILENT_INVITED_TITLE, RECEIVES_EVERYTHING_TITLE, UNCLAIMED_ENTRY_TITLE])('self-check: a second entry titled "%s" fails its rows', (title) => {
      const edited = withLineEdited(readme(), (line) => line.trim() === `**${title}**`, (line) => `${line}\n\n${line}`)
      const rows = README_DEO_ROWS.filter(([element]) => element.startsWith(`"${title}"`))
      expect(rows.length).toBeGreaterThan(0)
      for (const [element, passage, required] of rows) {
        expect({ element, problems: docRowProblems(passage, required, edited) }).toEqual({
          element,
          problems: [`README.md "${TROUBLESHOOTING_HEADING}": 2 entries' titles hold "**${title}**", expected 1`],
        })
      }
    })
  })

  /**
   * The downgrade steps (SRI-1105). Each step's row (`downgradeStep(n)`)
   * already requires step n's own lead in the nth place, so the order is read
   * there; this case adds only that there are exactly four steps.
   */
  describe('downgrade steps (SRI-1105)', () => {
    /** The numbers of the downgrade steps, in order, comma-separated. */
    const stepNumbers = (text: string) => downgradeSteps(text).map((step) => /^\d+/.exec(step)![0]).join(',')

    test('"Downgrading to an earlier release" has exactly four numbered steps, 1 to 4', () => {
      expect(stepNumbers(readme())).toBe('1,2,3,4')
    })

    test('self-check: a fifth step added fails the step-count case', () => {
      const edited = withLineEdited(readme(), (line) => line.startsWith('4. **Install the older build'), (line) => `${line}\n5. **Delete the stored-choice file.**`)
      expect(stepNumbers(edited)).toBe('1,2,3,4,5')
    })

    test('self-check: steps 1 and 2 swapped, numbers kept, fail the rows of steps 1 and 2', () => {
      const firstTwoStepRows = [1, 2].map((n) => {
        const row = README_DEO_ROWS.find(([element]) => element.startsWith(`Downgrading: step ${n} `))
        if (row === undefined) throw new Error(`README_DEO_ROWS has no row for downgrade step ${n}`)
        return row
      })
      const lines = readme().split('\n')
      const range = sectionRange(readme(), DOWNGRADE_HEADING)!
      const at = lines.flatMap((line, i) => (i > range.start && i < range.end && /^\d+\. /.test(line) ? [i] : []))
      const [first, second] = [lines[at[0]], lines[at[1]]]
      lines[at[0]] = `1. ${second.slice(3)}`
      lines[at[1]] = `2. ${first.slice(3)}`
      const swapped = lines.join('\n')
      expect(stepNumbers(swapped)).toBe('1,2,3,4')
      for (const [element, passage, required] of firstTwoStepRows) {
        expect({ element, failed: docRowProblems(passage, required, swapped).length > 0 }).toEqual({ element, failed: true })
      }
    })
  })

  describe('README-wide same-file links (T17 hatch note 10)', () => {
    test('every same-file link in the README resolves to a README heading', () => {
      const links = markdownLinks(splitFences(readme()).prose).filter((link) => link.path === '' && link.anchor !== '')
      expect(links.length).toBeGreaterThan(25)
      expect(brokenReadmeAnchors(readme())).toEqual([])
    })

    test('self-check: a linked heading renamed is reported', () => {
      const edited = withLineEdited(readme(), (line) => line === CHANNEL_MODES_HEADING, (line) => `${line} again`)
      expect(brokenReadmeAnchors(edited)).toContain(`#${headingSlug(CHANNEL_MODES_HEADING.slice(3))}`)
    })
  })
})
