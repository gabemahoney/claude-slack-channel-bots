/**
 * fmk-texts.ts — the one value printer of the fmk scenarios (b.jg5 SRJ-1401,
 * SRJ-1306). A scenario script cannot import TypeScript, and a test never
 * retypes a notice text, class label, version or settings value that `src/`
 * exports. So a script asks this printer for the value, and the printer
 * prints the installed package's own export (the tarball under test): a
 * constant as it is, or a builder's output for the script's arguments.
 *
 * Every fmk scenario uses this one printer. A scenario that needs another
 * value adds a named entry to `ENTRIES` here, and never a second printer.
 *
 * REFUSAL
 * -------
 * Runs only in a cscb-ci image. Its first statement checks for the image
 * marker `/etc/cscb-ci-image`; without it, the printer prints
 * `FAIL: fmk-texts: refused: /etc/cscb-ci-image is absent …` on stderr and
 * exits 2, before it reads an argument or loads a module. Only `node:`
 * built-ins are imported statically: the package's modules are imported
 * dynamically, after the check, by the entry that needs them.
 *
 * USAGE
 * -----
 *   bun fmk-texts.ts <entry> [<arg>…]
 *
 * It prints the entry's value on stdout, byte for byte, with nothing added
 * (no trailing newline; a multi-line text is printed as it is), and exits 0.
 * A script runs it directly in its own shell (not through `cscb_run`: the
 * printer is not a CSCB process) and captures the value with a command
 * substitution, failing the scenario when the printer fails:
 *
 *   FLOOR="$(bun "${SCENARIO_FIXTURES}/fmk-texts.ts" PHASE1_FLOOR_VERSION)" \
 *       || fail "fmk-texts: PHASE1_FLOOR_VERSION"
 *   STOP_MSG="$(bun "${SCENARIO_FIXTURES}/fmk-texts.ts" \
 *       buildBelowPhase1FloorMessage "${OLD_VERSION}" "${BIN_PATH}" runtime)" \
 *       || fail "fmk-texts: buildBelowPhase1FloorMessage"
 *
 * A command substitution drops trailing newlines. No value below ends with
 * one but CONFLICT_NOTICE_LINE_SEPARATOR, which is one; an entry whose value
 * can must be captured with a sentinel instead:
 * `V="$(bun … && printf x)" || fail …; V="${V%x}"`.
 *
 * Failures print one `FAIL: fmk-texts: <reason>` line on stderr:
 *   - no entry named, an unknown entry, or arguments the entry does not
 *     take: exit 64, with the usage and the entry names;
 *   - the installed package lacks the export, the export is not of the kind
 *     the entry prints, or a builder throws: exit 1.
 *
 * INPUTS (env)
 * ------------
 *   CSCB_PKG_DIR   the installed package (default
 *                  /test-repo/node_modules/claude-slack-channel-bots), as
 *                  `driver.ts` and `fmk-driver.ts` read it
 *
 * ENTRIES (each named after its `src/` export)
 * -------
 *   PHASE1_FLOOR_VERSION                         src/ad-version-gate.ts, the Phase 1 floor
 *   AD_BELOW_PHASE1_FLOOR                        src/install-check-labels.ts, the class label
 *   buildBelowPhase1FloorMessage <found-version> <binary-path> <startup|runtime>
 *                                                src/ad-version-gate.ts, the floor message;
 *                                                `startup` and `runtime` select the package's
 *                                                FOUND_BY_STARTUP_CHECK and
 *                                                FOUND_BY_RUNTIME_RECHECK forms
 *   RUNTIME_RECHECK_PHRASE                       src/ad-version-gate.ts
 *   AD_VERSION_RECHECK_INTERVAL_MS               src/ad-version-gate.ts, in decimal
 *   AD_VERSION_RECHECK_COULD_NOT_RUN_LOG_PREFIX  src/ad-version-gate.ts
 *   INVALID_FLAGS_HOLD_ALERT_TEXT                src/invalid-flags-hold.ts, SRJ-1008's
 *                                                Cannot launch alert body
 *   formatPersonaNotice <persona-name> <entry> [<arg>…]
 *                                                src/persona-notifier.ts: the posted text of
 *                                                another entry's value as persona
 *                                                <persona-name>'s notice (the persona
 *                                                prefix added, the key derived by the
 *                                                package's personaKey, as the config
 *                                                loader derives it)
 *
 * The latch scenarios' entries (E42–E43, test-15 onward). Constants, each
 * printed as it is, named after their export:
 *   LATCH_CASE_*, REFUSED_OPERATION_*, CONFLICT_NOTICE_*, UNUSABLE_NAME_NOTICE_*,
 *   LAUNCH_START_NOTICE_*, LATCH_RECOVERY_REASON_ROW_READS_HEAD,
 *   CONFLICT_RECOVERY_HEAD, CONFLICT_RECOVERY_REASON_LEAD, HOLD_RECOVERY_HEAD,
 *   LATCH_RECOVERY_TAIL, LATCH_RECHECK_INTERVAL_MS (in decimal), RECHECK_STEP_*,
 *   RECHECK_LINE_STEP_NOT_DECIDED, RECHECK_CALL_*
 *                                                src/conflict-latch.ts (the full list is
 *                                                LATCH_CONSTANT_NAMES below);
 *                                                CONFLICT_NOTICE_LINE_SEPARATOR is a line
 *                                                break, so capture it with the sentinel
 *   UNUSABLE_RECORDED_NAME_PHRASE, CONFLICT_*_PHRASE (the nine case phrases),
 *   PLAIN_SPAWN_LABEL_NAMES_THIS_ID_PHRASE, PLAIN_SPAWN_LABEL_NOT_THIS_ID_PHRASE,
 *   NEW_ROW_ENDED_PHRASE, NOTHING_WRITTEN_PHRASE
 *                                                src/ad-description-phrases.ts
 * Builders (<case> is a latch case's value, as the LATCH_CASE_* entries print
 * it; <reason> is LATCH_RECOVERY_REASON_ROW_GONE,
 * LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED,
 * LATCH_RECOVERY_REASON_RELAUNCH_NOT_REFUSED, LATCH_RECOVERY_REASON_CLEARED_BY_HAND,
 * or `latchRecoveryReasonRowReads <state>`):
 *   personaNoticePrefix <persona-name> [<key>]   src/persona-notifier.ts formatPersonaNotice's
 *                                                prefix (its output for an empty body); the
 *                                                key personaKey(<persona-name>) unless given
 *   personaInstanceId <key>                      src/persona-identity.ts
 *   conflictNoticeText <case> <session-name> [<description>]
 *                                                src/conflict-latch.ts, the whole CONFLICT
 *                                                notice body (a CONFLICT case only)
 *   conflictNoticeFirstLine <case> <session-name>
 *                                                its first line (head, the quoted session,
 *                                                the case sentence when the case has one,
 *                                                tail)
 *   conflictNoticeListLine <session-name>        its list line for that name (or the
 *                                                unsafe-name line in its place)
 *   conflictCaseSentence <case>                  the case sentence; fails for a case with none
 *   unusableNameNoticeText <key> <description>   SRJ-1019's notice body
 *   launchStartNotRecordedNoticeText <key>       SRJ-1020's notice body
 *   conflictRecoveryText <session-name> <reason> the CONFLICT recovery notice body
 *   holdRecoveryText <reason>                    the hold recovery notice body
 *   conflictLatchSetLine <key> <case> <session-name> <refused-operation> <row-state> [<previous-case>]
 *                                                the latch-set server-log line (no description;
 *                                                <row-state> a state read, `no-row` or
 *                                                `unreadable`, as the LATCH_ROW_STATE_KIND_*
 *                                                values spell them)
 *   latchClearedLine <key> <case> <session-name> <posted|not-posted> <reason>
 *                                                the clear's server-log line
 *   latchRecheckRoundLine <persona-name> <case> <step> <call> <answer>
 *                                                the re-check round's server-log line, the
 *                                                reference renderPersonaRef(<persona-name>)
 * Scenario 19's entries (test-16):
 *   personaTmuxSessionName <key>                 src/persona-identity.ts, the session name a
 *                                                persona's launches ask for
 *   LATCH_ROW_STATE_KIND_NO_ROW                  src/conflict-latch.ts, the latch-set line's
 *                                                word for no row (conflictLatchSetLine's
 *                                                <row-state>)
 *   adGraceMs, adLaunchBoundMs                   src/ad-settings.ts, G and B in milliseconds at
 *                                                agent-director's default settings
 *                                                (DEFAULT_AD_SETTINGS_IN_EFFECT), in decimal
 * Scenario 25's entries (test-27):
 *   AD_ERROR_CLASS_UNUSABLE_NAME                 src/ad-error-class.ts, CSCB's class for an
 *                                                unusable recorded name, as fmk-driver.ts's
 *                                                outcome line gives it (`class=<class>`)
 *   Scenario 10 (test-22-fmk-wrong-server.sh). An entry of the same name in
 *   another scenario's lane takes the same arguments and prints the same value:
 *   personaInstanceId <key>                      src/persona-identity.ts, `cscb_<key>`
 *   personaTmuxSessionName <key>                 src/persona-identity.ts, `slack_bot_<key>`
 *   CONFLICT_NOTICE_FIRST_LINE_HEAD              src/conflict-latch.ts, the CONFLICT notice's parts
 *   CONFLICT_NOTICE_POINTER_LINE                 (SRJ-1004) CSCB writes around agent-director's
 *   CONFLICT_NOTICE_HUMAN_ONLY_LINE              description
 *   conflictCaseSentence <case>                  src/conflict-latch.ts, a latch case's sentence
 *                                                (<case> one of the package's LATCH_CASES; a case
 *                                                with none is a failure)
 *   LATCH_CASE_OWN_ID                            src/conflict-latch.ts, the "this row's own id" case
 *   conflictRecoveryText <session-name> <reason>
 *                                                src/conflict-latch.ts, the CONFLICT recovery
 *                                                notice's body; <reason> is one of
 *                                                LATCH_RECOVERY_REASON_ROW_GONE,
 *                                                LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED,
 *                                                LATCH_RECOVERY_REASON_RELAUNCH_NOT_REFUSED,
 *                                                LATCH_RECOVERY_REASON_CLEARED_BY_HAND, or
 *                                                `latchRecoveryReasonRowReads <state>`
 *   LATCH_RECHECK_INTERVAL_MS                    src/conflict-latch.ts, in decimal
 *   RECHECK_CALL_PROBE RECHECK_CALL_RESUME       src/conflict-latch.ts, the call, step and verdict
 *   RECHECK_STEP_TABLE                           labels a re-check's round line carries
 *   RECHECK_VERDICT_STILL_LATCHED
 *   conflictLatchSetLineHead <key> <latched|relatched>
 *                                                src/conflict-latch.ts conflictLatchSetLine for a
 *                                                new latch (CONFLICT_LATCH_SET_LATCHED) or a
 *                                                relatch (CONFLICT_LATCH_SET_RELATCHED) of persona
 *                                                <key>, cut where the case begins: the head of
 *                                                every such line, up to and including `case=`
 *   latchRecheckRoundLine <persona-name> <case> <step> <call> <answer>
 *                                                the re-check round's server-log line, the
 *                                                reference renderPersonaRef(<persona-name>)
 *   PROBE_PANE_READ_LINES                        src/pane-read.ts, in decimal
 *   PANE_READ_PANE PANE_READ_GONE                src/pane-read.ts, a pane read's outcome kinds
 *   CONFLICT_OWN_ID_PHRASE STILL_STOPPING_PHRASE STILL_STARTING_PHRASE
 *                                                src/ad-description-phrases.ts
 *   AD_SETTINGS_RELATIVE_PATH                    src/ad-settings.ts, the settings file's path
 *                                                relative to a HOME
 *   AD_TMUX_TABLE                                src/ad-settings.ts, the timing keys' table
 *   AD_PAUSE_TABLE                               src/ad-settings.ts, `pause`'s table
 *   AD_PAUSE_TIMEOUT_KEY                         src/ad-settings.ts, `pause`'s wait key
 *   AD_SETTING_MINIMUMS <key> [<part>]           src/ad-settings.ts: agent-director's minimum
 *                                                for [tmux] <key>, in decimal; for a minimum
 *                                                with parts (pending_grace_seconds), the
 *                                                named <part> (`floor` or `addend`)
 *   MAX_AGENT_DIRECTOR_POLL_INTERVAL_MS          src/config.ts, in decimal: the longest permission
 *                                                poll interval a config may set
 *   sessionEndingCommandsIn                      reads a post's text on standard input and prints
 *                                                the names of the session-ending command forms
 *                                                (tests/test-helpers/session-ending-commands.ts,
 *                                                SRJ-1001) its CSCB-authored lines match, one per
 *                                                line, nothing when none: every line but the one
 *                                                that opens with the package's
 *                                                CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD (lines split
 *                                                at CONFLICT_NOTICE_LINE_SEPARATOR)
 *
 *   Scenario 26 (test-28-fmk-provenance.sh):
 *   tmuxServerChangedOnset                       src/outage-state.ts, the `tmux-unavailable` onset
 *                                                for a re-bound socket (SRJ-1021)
 *   ONSET_TEMPLATES <outage-class>               src/outage-state.ts, the class's onset template
 *                                                built with no detail (`tmux-unavailable`: the
 *                                                generic onset); a class with no template is a
 *                                                failure
 *   ALL_CLEAR_TEMPLATE <outage-class>…           src/outage-state.ts: the all-clear for a bad
 *                                                stretch of the given classes (each one of the
 *                                                package's OUTAGE_CLASS_ORDER, given once),
 *                                                none with a detail (posted as a persona
 *                                                notice: wrap it in formatPersonaNotice)
 *   DIFFERENT_TMUX_SERVER_PHRASE                 src/ad-description-phrases.ts
 *   UNAVAILABLE_RETRY_BASE_S                     src/unavailable-retry.ts, in decimal: the retry
 *                                                timer's first wait, which each later wait doubles
 *   UNAVAILABLE_RETRY_CEILING_S                  src/unavailable-retry.ts, the retry timer's
 *                                                longest wait, in seconds, in decimal
 *   unavailableRetryDueS <retry>                 when the retry timer's retry <retry> (from 1)
 *                                                falls due after its arm, in seconds, in
 *                                                decimal: the sum of src/backoff.ts
 *                                                doublingBackoffDelay(UNAVAILABLE_RETRY_BASE_S,
 *                                                <k>, UNAVAILABLE_RETRY_CEILING_S) for <k> from 0
 *                                                to <retry> - 1, the waits src/unavailable-retry.ts
 *                                                arms (each re-arm is measured from the end of the
 *                                                run before it, so the real due time is no earlier)
 *   waitingRowPaneGoneLineHead <key>             src/session-manager.ts: the head of a line, the
 *   escalateDeadSweepLineHead <key>              text the builder (waitingRowPaneGoneLine,
 *   reconnectGoneLineHead                        escalateDeadSweepLine, reconnectGoneLine) writes
 *                                                before the part agent-director's answer or a
 *                                                verdict fills: for persona <key> (as the builder's
 *                                                own key reference renders it), and for
 *                                                reconnectGoneLine the text before the persona's
 *                                                reference, which its callers give in more than one
 *                                                form
 *   launchStartNotRecordedNoticeText <key>       src/conflict-latch.ts, the "launch start not
 *                                                recorded" notice's body for persona <key> (SRJ-1020)
 *   holdRecoveryText <reason>                    src/conflict-latch.ts, the hold recovery notice's
 *                                                body; <reason> as for conflictRecoveryText
 *   LATCH_CASE_LAUNCH_START_NOT_RECORDED         src/conflict-latch.ts, the hold case
 *   RECHECK_CALL_NONE                            src/conflict-latch.ts, the call label a
 *                                                status-only re-check's round line carries
 *   relaunchAfterKillLine <key> <cwd> RELAUNCH_KILL_NONE
 *                                                src/restart.ts, the restart work's line before a
 *                                                launch with no kill (only the RELAUNCH_KILL_NONE form)
 *   relaunchWithoutKillLine <key> <reason-export> <dead-reading-export>
 *                                                src/restart.ts, the restart work's no-kill line with no
 *                                                verdict carried, for the package's RELAUNCH_NO_KILL_*
 *                                                reason and its src/liveness-reading.ts
 *                                                LIVENESS_READING_DEAD* reading named
 *   latchClearRetryAtOnceLineHead <ref>          src/session-manager.ts, the head of the after-clear
 *                                                retry's answer line for persona reference <ref>
 *   DEFAULT_AD_SETTINGS <table> <key>            src/ad-settings.ts: agent-director's default
 *                                                for `[<table>] <key>` (for example `tmux
 *                                                starting_session_seconds`), in decimal
 *   tmuxUnresponsiveOnsetText <key>              src/persona-episodes.ts, the tmux-unresponsive
 *                                                onset's body for persona <key> (SRJ-1006)
 *   tmuxUnresponsiveAlertText <key>              src/persona-episodes.ts, the tmux-unresponsive
 *                                                alert's body for persona <key> at the alert
 *                                                threshold of agent-director's default settings
 *                                                (src/ad-settings.ts adAlertThresholdMs of
 *                                                DEFAULT_AD_SETTINGS_IN_EFFECT)
 *   restartCapReachedNoticeText                  src/session-manager.ts, the restart-cap notice's body,
 *                                                a spawn-failure notice (several lines)
 *   FULL_PANE_READ_LINES                         src/pane-read.ts, in decimal: the line count of a
 *                                                full pane read (the waiting-row check's)
 *
 * The fixed-argument entries of scenarios 2, 6, 7, 9, 12, 15, 16 and 18
 * (`ARGS_ENTRIES`; test-14, test-18, test-19 and test-21). Each takes
 * exactly the arguments shown; a wrong count is a usage failure (exit 64).
 * They use the shared entries above too: `personaNoticePrefix <name>` for
 * the persona notifier's prefix, `personaInstanceId`,
 * `personaTmuxSessionName` and `launchStartNotRecordedNoticeText`.
 * Scenario 2, a kill that really fails (test-14; b.jg5 SRJ-1403, SRJ-704,
 * SRJ-1007, SRJ-1013, SRJ-1014):
 *   LAST_APPLIED_FILE_SUFFIX         the suffix of the last-applied record
 *                                    beside config.json (src/reload.ts)
 *   ORPHAN_CLEANUP_LABEL             the start sweep's startup-errors class
 *                                    (src/kill-failure-alert.ts)
 *   RETRY_KILL_LATER_PHRASE          agent-director's kill-failure words
 *   NEVER_DELETE_ROW_PHRASE          (src/ad-description-phrases.ts)
 *   KILL_RETRY_TRIES                 the bounded retry's tries (src/kill-retry.ts)
 *   killRetryTryLine.description-head <instance-id> <try>
 *                                    the fixed part of the bounded retry's
 *                                    per-try line (`killRetryTryLine`,
 *                                    src/kill-retry.ts) for an
 *                                    `ErrTmuxKillFailed` try <try> of
 *                                    KILL_RETRY_TRIES of <instance-id>, from
 *                                    its `: kill try` up to the JSON-quoted
 *                                    description (`describeKillOutcome`,
 *                                    src/checked-kill.ts): a script finds the
 *                                    line holding it and reads agent-director's
 *                                    description, JSON-decoded, right after it
 *   killRetryTryLine.description-head-of <instance-id> <try> <max>
 *                                    the same, for try <try> of <max> (a start
 *                                    sweep's row swept after the pass's
 *                                    retries were spent makes one try of 1)
 *   killRetryEndLine.head <instance-id>
 *   killRetryEndLine.tail <instance-id>
 *                                    the parts of the bounded retry's end line
 *                                    (`killRetryEndLine`) before and after the
 *                                    outcome, for <instance-id>'s tries that
 *                                    ended exhausted after KILL_RETRY_TRIES
 *                                    kills with the ordinary alert decided
 *   startSweepKillFailedEntry <instance-id> <persona> <state> <session> <description>
 *                                    the start sweep's `orphan-cleanup` entry
 *                                    head (src/session-manager.ts) for a swept
 *                                    row whose kill stands as an
 *                                    `ErrTmuxKillFailed` carrying <description>
 *                                    (`killOutcomeOf`, `describeKillOutcome`)
 *   killFailureAlertEntryText.start-sweep <instance-id> <session> <description>
 *                                    the kill-failure alert's ordinary version
 *                                    in its start-sweep log-line and
 *                                    `orphan-cleanup` entry form, with that
 *                                    route's closing sentence
 *                                    (`selectKillFailureAlertRoute`,
 *                                    `killFailureAlertContentOf`,
 *                                    `killFailureAlertText`,
 *                                    `killFailureAlertEntryText`,
 *                                    src/kill-failure-alert.ts)
 *   killFailureAlertText.destination <instance-id> <session> <description>
 *                                    the ordinary version as posted at a
 *                                    configured, unlatched persona's
 *                                    destination (context `recovery`), the
 *                                    body after the persona notifier's prefix
 *                                    (`formatPersonaNotice` above): escaped for
 *                                    Slack, with the "keeps retrying" closing
 *                                    sentence
 *   uncoveredPendingRowLine <name> <reason>
 *                                    the line for the persona named <name>'s
 *                                    `pending` row that is not covered, sent to
 *                                    the live-row sequence
 *                                    (`uncoveredPendingRowLine`,
 *                                    src/session-manager.ts), <reason> the
 *                                    name of a `PENDING_ROW_REASON_*` export of
 *                                    src/pending-row.ts (its persona reference
 *                                    from `renderPersonaRef`)
 *   tmuxUnresponsiveOnsetText <key>  the `tmux-unresponsive` onset's body
 *                                    (src/persona-episodes.ts), for absence
 *                                    checks
 * Scenarios 16 and 15, an upgrade's start sweep with one failing kill and a
 * persona removal whose kill fails (test-14; b.jg5 SRJ-1417, SRJ-714,
 * SRJ-715, SRJ-801, SRJ-802, SRJ-1003, SRJ-1007, SRJ-1013, SRJ-1020):
 *   SERVICE_LABEL, PERSONA_LABEL_KEY the `service` label CSCB's rows carry and
 *                                    the `persona` label's key
 *                                    (src/persona-identity.ts)
 *   PENDING_FILE_SUFFIX              the suffixes of the pending file and the
 *   APPLY_FILE_SUFFIX                confirmation beside config.json
 *                                    (src/reload.ts)
 *   PERSONA_TEARDOWN_NOTICE_LABEL    the persona teardown's startup-errors
 *                                    class (src/kill-failure-alert.ts)
 *   RETIRED_KEYS_FILE_NAME           the retired-key record's file name, its
 *   retiredKeysPath <state-dir>      path in the server's state directory
 *   RETIRED_KEY_CAUSE_REMOVED        and the causes `removed` and
 *   RETIRED_KEY_CAUSE_ABSENT_AT_START `absent-at-start` (src/retired-keys.ts)
 *   startSweepKillFailedEntry.pre-persona <instance-id> <state> <session> <description>
 *                                    the start sweep's `orphan-cleanup` entry
 *                                    head for a pre-persona row (no `persona`
 *                                    label), as `startSweepKillFailedEntry`
 *                                    above; its alert is
 *                                    `killFailureAlertEntryText.start-sweep`
 *                                    with the row's instance id
 *   startSweepKillSucceededLine.head <instance-id> <persona>
 *   startSweepKillSucceededLine.pre-persona-head <instance-id>
 *   startSweepKillSucceededLine.tail <instance-id>
 *                                    the parts of the start sweep's per-row
 *                                    line for a kill whose success stands
 *                                    (`startSweepKillSucceededLine`,
 *                                    src/session-manager.ts) before and after
 *                                    the outcome: for a swept row (<persona>
 *                                    as the line names it: an absent
 *                                    persona's label value) or a pre-persona
 *                                    row
 *   startSweepSummaryLine <listed> <killed> <kept> <kill-failed> <recorded-as-retired> <left-for-latch>
 *                                    the start sweep's summary line for those
 *                                    counts (src/session-manager.ts)
 *   startSweepSummaryLine.head       its fixed part before the first count
 *   startSweepLatchedFromOwnRowLine.launch-start-not-recorded <name> <instance-id>
 *                                    the start sweep's line for the persona
 *                                    named <name> latched from its own listed
 *                                    row with the case "launch start not
 *                                    recorded" (src/session-manager.ts,
 *                                    LATCH_CASE_LAUNCH_START_NOT_RECORDED,
 *                                    src/conflict-latch.ts)
 *   personaTeardownNoticeEntryText.kill-failure <name> <session> <description>
 *                                    the kill-failure alert's ordinary version
 *                                    on the persona-teardown route, in its
 *                                    `persona-teardown-notice` entry form: the
 *                                    persona named <name>, "raised during its
 *                                    teardown", then the alert for its own row
 *                                    and <session> with that route's closing
 *                                    sentence, unescaped
 *                                    (`personaTeardownNoticeEntryText`,
 *                                    src/persona-notifier.ts; the alert as
 *                                    `killFailureAlertEntryText.start-sweep`
 *                                    builds it, with context
 *                                    KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN)
 * Scenario 6, a wedged tmux (test-18; b.jg5 SRJ-1408, SRJ-302, SRJ-307 to
 * SRJ-310, SRJ-702, SRJ-1006, AC 56):
 *   tmuxUnresponsiveAlertText <key>  the `tmux-unresponsive` alert's body for
 *                                    persona <key> at the alert threshold of
 *                                    agent-director's default settings
 *                                    (src/persona-episodes.ts, the threshold
 *                                    as `adAlertThresholdMs.default` below)
 *   tmuxUnresponsiveRecoveryText <key>
 *                                    the recovery's body (src/persona-episodes.ts)
 *   tmuxUnresponsiveStartedLine.head <key>
 *                                    the condition's started line
 *                                    (`tmuxUnresponsiveStartedLine`,
 *                                    src/persona-episodes.ts) up to the
 *                                    refusing verb: a script reads the
 *                                    persona's first refusal's time from it
 *   adAlertThresholdMs.default       the alert threshold in milliseconds at
 *                                    agent-director's default settings
 *                                    (`adAlertThresholdMs` of
 *                                    DEFAULT_AD_SETTINGS_IN_EFFECT,
 *                                    src/ad-settings.ts)
 *   UNAVAILABLE_RETRY_BASE_S         the retry timer's first wait and its
 *   UNAVAILABLE_RETRY_CEILING_S      ceiling, in seconds (src/unavailable-retry.ts)
 *   TMUX_UNRESPONSIVE_ONSET_FLOOR_MS the onset's floor with the health check
 *                                    off (src/persona-episodes.ts)
 *   restartCapReachedNoticeText      the restart-cap notice's body
 *                                    (src/session-manager.ts), for absence
 *                                    checks
 *   restartRetryCapSkippedLine <key> the retry entry's line for a persona at
 *                                    the restart cap (src/restart.ts)
 *   UNAVAILABLE_RETRY_STOP_CAPPED    the retry timer's stop reason at the
 *                                    restart cap (src/unavailable-retry.ts)
 *   DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS
 *                                    CSCB's default agent-director call
 *                                    timeout (src/config.ts, b.jg5 SRJ-213)
 *   KILL_RETRY_SPACING_MS            the wait between a kill's tries
 *                                    (src/kill-retry.ts)
 *   killRetryTryLine.head <instance-id> <try> <max>
 *   killRetryTryLine.tail <next>     the parts of the bounded retry's per-try
 *                                    line (`killRetryTryLine`, no prefix)
 *                                    before and after its outcome, for try
 *                                    <try> of <max> of <instance-id>, and for
 *                                    what follows it, <next> the name of a
 *                                    `KILL_RETRY_NEXT_*` export of
 *                                    src/kill-retry.ts
 * Scenario 9, teardowns that meet a conflict (test-21; b.jg5 SRJ-1411,
 * SRJ-901, SRJ-903 to SRJ-907, SRJ-909, SRJ-1007, SRJ-1013). <command> is the
 * name of a `CLI_COMMAND_*` export of src/cli-teardown.ts, <class> the name of
 * an `AD_ERROR_CLASS_*` export of src/ad-error-class.ts, and a persona is
 * named by <name> (its key from `personaKey`, its session from
 * `personaTmuxSessionName`):
 *   CLI_COMMAND_CLEAN_RESTART        the two teardown commands as their lines
 *   CLI_COMMAND_STOP_BOTS            name them (src/cli-teardown.ts)
 *   adErrorClass <class>             the class label (src/ad-error-class.ts)
 *   adErrorName <error-class>        the error name of the agent-director error
 *                                    class <error-class> the package re-exports
 *                                    (src/agent-director-errors.ts; for
 *                                    example ErrSpawnNotPausable)
 *   CONFLICT_PANE_NOT_FOUND_PHRASE   agent-director's CONFLICT words "the
 *                                    agent's pane was not found"
 *                                    (src/ad-description-phrases.ts; one of
 *                                    the shared CASE_PHRASE_NAMES entries)
 *   precheckFailureLine.head <command> <name> <class>
 *                                    the precheck's failure line
 *                                    (`precheckFailureLine`) up to its
 *                                    description: the persona, key, session
 *                                    and class
 *   precheckNothingStoppedLine <command>
 *                                    the failed precheck's last line
 *   teardownFailureLine.head <command> <name> <class>
 *                                    a persona's teardown failure line
 *                                    (`teardownFailureLine`) up to its
 *                                    description
 *   cliTeardownKillFailed.failure-line <command> <name> <description>
 *   cliTeardownKillFailed.alert-line <command> <name> <description>
 *   cliTeardownKillFailed.entry-class <command> <name> <description>
 *   cliTeardownKillFailed.entry-message <command> <name> <description>
 *                                    the report of a persona whose teardown
 *                                    kill's tries ended exhausted on an
 *                                    `ErrTmuxKillFailed` carrying
 *                                    <description> with the ordinary alert
 *                                    decided (`teardownKillOutcomeOf`, then
 *                                    `personaTeardownReportOf`,
 *                                    src/cli-teardown.ts): its failure line,
 *                                    the kill-failure alert's ordinary
 *                                    version for the CLI-teardown route with
 *                                    its closing sentence (the line after
 *                                    it), and its startup-errors entry's
 *                                    class and message
 *   teardownNotStoppedLine <command> <count>
 *                                    the command's last line when <count>
 *                                    personas could not be stopped
 *   PERSONA_KILL_FAILED_LABEL        the CLI-teardown route's startup-errors
 *                                    class (src/kill-failure-alert.ts)
 *   CLEAN_RESTART_NOT_RESTARTED_LABEL
 *                                    the not-restarted alert's class
 *                                    (src/cli-teardown.ts)
 *   cleanRestartNotRestartedAlert <class> <names>
 *                                    `clean_restart`'s not-restarted alert
 *                                    for the personas <names> (comma-
 *                                    separated, in configuration order), each
 *                                    failed under <class>
 *   answerCheckFailedTryLine.head <try>
 *                                    `clean_restart`'s answer check's line
 *                                    for a failed `list` try <try>
 *                                    (`answerCheckFailedTryLine`) up to its
 *                                    class
 *   adGraceMs.default                agent-director's pending grace period G
 *                                    in milliseconds at its default settings
 *                                    (`adGraceMs` of
 *                                    DEFAULT_AD_SETTINGS_IN_EFFECT,
 *                                    src/ad-settings.ts)
 * Scenario 7, reuse replaces delete (test-19; b.jg5 SRJ-1409, SRJ-413,
 * SRJ-707, SRJ-712):
 *   personaPreTrustLogLine <name> <verb> <value>
 *                                    the one `pre_trust` line a successful
 *                                    launch logs (`preTrustLogLine`,
 *                                    src/session-manager.ts) for the persona
 *                                    named <name> (its reference from
 *                                    `renderPersonaRef`), <verb> the name of a
 *                                    `LAUNCH_VERB_*` export of
 *                                    src/session-manager.ts (for example
 *                                    LAUNCH_VERB_REUSE_SPAWN) and <value> the
 *                                    result's `pre_trust` (for example `ok`)
 *   JSONL_DIAGNOSIS_REUSE_WORDING    the fixed fragment every log line of the
 *                                    lost-transcript diagnosis
 *                                    (`diagnoseJsonlMissing`,
 *                                    src/session-manager.ts) holds: the
 *                                    persona brought up fresh by a reuse spawn
 *                                    of the same instance, its row kept
 *   JSONL_DIAGNOSIS_INCONCLUSIVE_ENTRY_CLASS
 *   JSONL_TRANSCRIPT_LOST_ENTRY_CLASS
 *                                    the diagnosis's startup-errors classes
 *                                    (src/session-manager.ts)
 * Scenario 12, a missing row with no session id and an ended row with a
 * stale `config_dir` label beside a running session (test-19; b.jg5
 * SRJ-1414, SRJ-707, SRJ-410):
 *   classifyAdError <error-class>    the class label `classifyAdError`
 *                                    (src/ad-error-class.ts) gives an error of
 *                                    the agent-director error class
 *                                    <error-class> the package re-exports
 *                                    (src/agent-director-errors.ts; for
 *                                    example ErrTmuxSessionConflict), made
 *                                    with the verb `spawn`, its own name and
 *                                    an empty description: a script reads a
 *                                    refused call's class from the error name
 *                                    its log line names
 * Scenario 18, a persona removed and re-added, and one whose
 * `credentials_file` changes, comes back fresh by reuse (test-19; b.jg5
 * SRJ-1419, SRJ-803, SRJ-805):
 *   RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY
 *                                    the retired-key record's cause of the old
 *                                    half of a destructive modify
 *                                    (src/retired-keys.ts)
 *   reloadAppliedLogLine <added> <removed> <destructive> <in-place> <credentials> <settings> <config-path>
 *                                    the `reload-applied` line an apply logs
 *                                    once all its steps ran
 *                                    (`renderAppliedLogLine`,
 *                                    src/reload-apply.ts) for a change plan of
 *                                    those counts (`changePlanCounts`,
 *                                    src/reload-plan.ts, reads only its
 *                                    classes' lengths, so the plan holds
 *                                    stand-in entries), naming the
 *                                    last-applied record beside the
 *                                    configuration file at <config-path>
 *                                    (`reloadFilePaths`, src/reload.ts)
 *
 * The body entries print a body without the persona prefix; wrap one in
 * `formatPersonaNotice <persona-name> <entry> …` for the posted text.
 *
 * The one-function entries of scenarios 5, 11, 13, 21 and 22
 * (`FN_ENTRIES`; test-17, test-24 and test-25). Each checks its own
 * arguments. `DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS`,
 * `UNAVAILABLE_RETRY_BASE_S`, `UNAVAILABLE_RETRY_CEILING_S` and
 * `tmuxUnresponsiveOnsetText <key>`, which test-17 reads too, are the
 * fixed-argument entries above; `personaInstanceId <key>` and
 * `personaTmuxSessionName <key>`, which test-24 and test-25 read, are the
 * shared ones.
 *   APPROVER_LOG_PREFIX           src/session-manager.ts APPROVER_LOG_PREFIX: the head
 *                                 of every log line the dialog approver writes
 *   DEV_CHANNELS_DIALOG_NEEDLE    src/session-manager.ts DEV_CHANNELS_DIALOG_NEEDLE: the
 *                                 approver's needle for the dev-channels dialog
 *   TRUST_DIALOG_NEEDLE           src/session-manager.ts TRUST_DIALOG_NEEDLE: the
 *                                 approver's needle for the folder-trust prompt
 *   DIALOG_POLL_INTERVAL_MS       src/session-manager.ts DIALOG_POLL_INTERVAL_MS: the
 *                                 approver's pace before G, in milliseconds
 *   DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds
 *                                 src/ad-settings.ts DEFAULT_AD_SETTINGS, its
 *                                 `tmux.pending_grace_seconds`: agent-director's
 *                                 default pending grace period G, in whole seconds
 *   DEFAULT_AD_SETTINGS.tmux.create_timeout_ms
 *                                 src/ad-settings.ts DEFAULT_AD_SETTINGS, its
 *                                 `tmux.create_timeout_ms`: agent-director's default
 *                                 bound on its session-creating tmux call, in
 *                                 milliseconds
 *   DEFAULT_AD_SETTINGS.tmux.stopping_window_seconds
 *                                 src/ad-settings.ts DEFAULT_AD_SETTINGS, its
 *                                 `tmux.stopping_window_seconds`: agent-director's
 *                                 default stopping window, how long an ended row
 *                                 whose agent has not exited counts as still
 *                                 stopping, in whole seconds
 *   LAUNCH_TIMEOUT_PHRASE         src/ad-description-phrases.ts LAUNCH_TIMEOUT_PHRASE:
 *                                 the phrase an ErrTmuxUnresponsive carries when it
 *                                 ends a launch call as a launch timeout
 *   STILL_STOPPING_PHRASE         src/ad-description-phrases.ts STILL_STOPPING_PHRASE:
 *                                 the phrase an ErrTmuxUnresponsive carries for a
 *                                 row that appears to still be stopping
 *   LAUNCH_UNAVAILABLE_OUTCOME_APPROVER
 *                                 src/session-manager.ts
 *                                 LAUNCH_UNAVAILABLE_OUTCOME_APPROVER: the outcome the
 *                                 one `get` after a launch timeout logs for a covered
 *                                 `pending` row whose approver it started
 *   LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT
 *                                 src/ad-error-class.ts LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT:
 *                                 the name the post-timeout get line gives a launch
 *                                 timeout that was CSCB's own call timeout
 *   PENDING_ROW_RULE_LOG_HEAD     src/pending-row.ts PENDING_ROW_RULE_LOG_HEAD: the
 *                                 head of the pending-row rule's lines
 *   PENDING_ROW_RUN_MARKED_MISSING
 *                                 src/pending-row.ts PENDING_ROW_RUN_MARKED_MISSING: the
 *                                 placement a pending-row rule round's line gives
 *                                 its bypassing `find-missing` run when the run
 *                                 marked the row `missing`
 * None of the above takes an argument.
 *   tmuxUnresponsiveEndedLines <key>
 *                                 src/persona-episodes.ts tmuxUnresponsiveEndedLine for
 *                                 persona key <key>, once for each end reason
 *                                 TMUX_UNRESPONSIVE_END_TEXT names, in its order, one
 *                                 line each: every ended line the persona's
 *                                 tmux-unresponsive condition can log
 *   spawnFailureNoticeHead <error-name>
 *                                 src/session-manager.ts spawnFailureNoticeText (the
 *                                 body `notifySpawnFailure` posts) for an
 *                                 agent-director error named <error-name> (letters
 *                                 and digits, starting `Err`), cut where the error's
 *                                 description begins: the notice's first line, then
 *                                 its error line up to and including the `—` after
 *                                 the label (the description is agent-director's and
 *                                 the remediation follows it, so neither is printed)
 *   unavailableRetryLineHead <key>
 *                                 src/unavailable-retry.ts: the longest head that
 *                                 unavailableRetryArmedLine, unavailableRetryRetryLine,
 *                                 unavailableRetryReArmedLine and
 *                                 unavailableRetryStoppedLine for persona key <key>
 *                                 share: the head of every retry-timer line of the
 *                                 persona
 *   unavailableRetryArmedHead <key>
 *                                 src/unavailable-retry.ts unavailableRetryArmedLine for
 *                                 <key>, in full and in pending-only mode, each cut
 *                                 where its description begins, then their longest
 *                                 shared head: the head of the persona's arm line in
 *                                 either mode
 *   unavailableRetryStoppedHead <key>
 *                                 src/unavailable-retry.ts unavailableRetryStoppedLine
 *                                 for <key>, with no tag and with the pending-only
 *                                 mode and a row read, each cut where its reason
 *                                 begins, then their longest shared head: the head of
 *                                 the persona's stop line in either form
 *   unavailableRetryNotArmedHead <key>
 *                                 src/unavailable-retry.ts
 *                                 unavailableRetryNotArmedClosedLine for <key>, cut
 *                                 where the refused cause begins: the head of the line
 *                                 an arm logs once the controller is closed (the
 *                                 server's shutdown)
 *   unavailableRetryRetryLineParts <key>
 *                                 src/unavailable-retry.ts unavailableRetryRetryLine
 *                                 for <key>, split where the retry number stands, three
 *                                 lines: the head before the number, the text after it
 *                                 in full mode, then in pending-only mode. A retry line
 *                                 is exactly the head, a number and one of the two
 *                                 tails; the re-armed line, which starts the same way,
 *                                 is neither
 *   launchUnavailableGetLineParts <ref>
 *                                 src/session-manager.ts launchUnavailableGetLine for
 *                                 persona reference <ref>, two lines: the text before
 *                                 the call's name (`what`), then the text from after it
 *                                 to the outcome's form
 *   launchUnavailableFormText <form>
 *                                 src/session-manager.ts launchUnavailableFormText: for
 *                                 <form> the name of a src/ad-error-class.ts
 *                                 launch-timeout form export (LAUNCH_TIMEOUT_FORM_…),
 *                                 the text naming that form; for `none` (no launch
 *                                 timeout), the UNAVAILABLE text cut where the rendered
 *                                 failure begins
 *   tmuxUnresponsiveLineHead <key>
 *                                 src/persona-episodes.ts tmuxUnresponsiveLine for <key>,
 *                                 cut where its text begins: the head of every
 *                                 tmux-unresponsive line of the persona
 *   approverShutdownStopLine <ref>
 *                                 src/session-manager.ts approverLogLine of
 *                                 approverStopRequestedMessage for persona reference
 *                                 <ref> and APPROVER_STOP_SHUTDOWN: the line shutdown
 *                                 logs when it stops the persona's running approver
 * A <key> is a persona key (lower-case letters, digits and `_`); a <ref> is
 * one line. A head or part is printed as it is, a trailing space included.
 *
 * The stuck-launch entries (scenario 21), each printing a `src/` export or a
 * builder's output for its arguments. <ref> is a persona reference as the
 * server logs it (`"<name>" (key=<key>)`), <key> a persona key, <name> a
 * persona name, <launch-start> a row's `launch_started_at` as agent-director
 * prints it, and <bound-ms> B in milliseconds:
 *   PENDING_ROW_RUN_NOT_JUDGED    src/pending-row.ts PENDING_ROW_RUN_NOT_JUDGED: the
 *                                 placement a pending-row rule round's line gives
 *                                 its bypassing `find-missing` run when the run left
 *                                 the `pending` row in neither list (not judged)
 *   PENDING_ROW_RULE_ORIGIN_RETRY src/pending-row.ts PENDING_ROW_RULE_ORIGIN_RETRY: the
 *                                 origin a rule line names for a run at a retry of
 *                                 the persona's retry timer
 *   PENDING_ROW_RULE_ORIGIN_APPROVER_STOP
 *                                 src/pending-row.ts
 *                                 PENDING_ROW_RULE_ORIGIN_APPROVER_STOP: the origin a
 *                                 rule line names for the run at the dialog
 *                                 approver's stop
 *   adLaunchBoundMs(DEFAULT_AD_SETTINGS_IN_EFFECT)
 *                                 src/ad-settings.ts adLaunchBoundMs over
 *                                 DEFAULT_AD_SETTINGS_IN_EFFECT: B, CSCB's launch
 *                                 bound at agent-director's default settings, in
 *                                 milliseconds
 * None of the above takes an argument.
 *   approverBoundLine <ref> <bound-ms>
 *                                 src/session-manager.ts approverLogLine over
 *                                 approverBoundMessage(<ref>, <bound-ms>,
 *                                 APPROVER_BOUND_FROM_LAUNCH_START): the one line the
 *                                 dialog approver writes when it stops at B measured
 *                                 from the launch start
 *   pendingRowRuleApproverStopRelaunchLine <ref>
 *                                 src/session-manager.ts
 *                                 pendingRowRuleApproverStopLine(<ref>,
 *                                 APPROVER_STOP_BOUND, …) for the rule's answer
 *                                 PENDING_ROW_RULE_RELAUNCH with
 *                                 PENDING_ROW_RELAUNCH_SEQUENCE_STARTED
 *                                 (src/pending-row.ts): the line of the rule's run at
 *                                 the approver's stop at B that made the relaunching
 *                                 post and the abort, and started the live-row
 *                                 sequence
 *   stuckLaunchRelaunchingPost <name> <key> <bound-ms>
 *                                 src/persona-notifier.ts formatPersonaNotice for the
 *                                 persona over src/pending-row.ts
 *                                 stuckLaunchRelaunchingText(<key>, <bound-ms>): the
 *                                 whole relaunching post as the persona notifier
 *                                 posts it
 *   stuckLaunchHeldPost <name> <key> <launch-start> <true|false>
 *                                 src/persona-notifier.ts formatPersonaNotice for the
 *                                 persona over src/pending-row.ts
 *                                 stuckLaunchHeldText(<key>, <launch-start>, <met
 *                                 not interactive>): the whole held post (with the
 *                                 attach remedy for `false`), multi-line
 *   describeLaunchStartForLog <launch-start>
 *                                 src/pending-row.ts describeLaunchStartForLog: the one
 *                                 renderer of a launch start, in the held text and
 *                                 the rule's lines
 *   stuckLaunchPostLine <key> <mark> <answer>
 *                                 src/pending-row.ts stuckLaunchPostLine(<key>, <mark>,
 *                                 <answer>), where <mark> is STUCK_LAUNCH_MARK_RELAUNCHING
 *                                 or STUCK_LAUNCH_MARK_HELD and <answer> one of the
 *                                 poster's answers (STUCK_LAUNCH_POSTED,
 *                                 STUCK_LAUNCH_ALREADY_POSTED, STUCK_LAUNCH_SUPPRESSED,
 *                                 STUCK_LAUNCH_NOT_POSTED_CLOSED,
 *                                 STUCK_LAUNCH_POST_FAILED), each given by its value:
 *                                 the poster's one line for that answer
 *   stuckLaunchAbortKillSucceededHead <key>
 *                                 src/pending-row.ts stuckLaunchAbortKillLine for the
 *                                 answer STUCK_LAUNCH_ABORT_KILL_SUCCEEDED whose
 *                                 description is src/checked-kill.ts
 *                                 describeKillOutcome of a KILL_OUTCOME_KILLED outcome
 *                                 with `kill_sent` true, cut where what follows
 *                                 begins: the abort kill's line up to and including
 *                                 the `— ` after the description
 *   liveRowSequenceStep3MarkedMissingLines <ref>
 *                                 src/live-row-sequence.ts liveRowSequenceRunLine(<ref>,
 *                                 3, <n>, LIVE_ROW_RUN_MARKED_MISSING) for each <n> from
 *                                 1 to LIVE_ROW_SEQUENCE_STEP3_RUNS, one line each:
 *                                 every line a step-3 run of the live-row sequence
 *                                 logs when it marked the row `missing`
 *   stuckLaunchHeldPostedLines <key>
 *                                 src/pending-row.ts stuckLaunchPostLine(<key>,
 *                                 STUCK_LAUNCH_MARK_HELD, STUCK_LAUNCH_POSTED, …) for
 *                                 each form of the held text (with the attach line,
 *                                 and without it: `metNotInteractive` false, then
 *                                 true), each unmuted, then muted by a submitted
 *                                 teardown, one line each: every line the held
 *                                 text's poster logs for the answer `posted`
 *   pendingRowRuleRoundLineHead <ref> <origin>
 *                                 src/pending-row.ts pendingRowRuleRoundLine(<ref>,
 *                                 <origin>, …), where <origin> is
 *                                 PENDING_ROW_RULE_ORIGIN_RETRY or
 *                                 PENDING_ROW_RULE_ORIGIN_APPROVER_STOP by its value,
 *                                 cut where the launch start's rendering
 *                                 (describeLaunchStartForLog) begins: the head of every
 *                                 round line of the pending-row rule for <ref> from
 *                                 that origin, up to and including `launch started `
 *
 * The relabelled-session entries (scenario 21's abort kill answered CONFLICT,
 * "not this launch's session"). <description> is agent-director's description
 * of that CONFLICT as the latch's record holds it (the `message="…"` of its
 * latch-set line, JSON-decoded); an entry given one that lacks
 * CONFLICT_NOT_THIS_LAUNCH_PHRASE, or that the package recognises as another
 * case, fails:
 * Neither of the above takes an argument.
 *   stuckLaunchAbortKillConflictHead <key>
 *                                 src/pending-row.ts stuckLaunchAbortKillLine for the
 *                                 answer STUCK_LAUNCH_ABORT_KILL_LATCHED whose
 *                                 description is src/checked-kill.ts
 *                                 describeKillOutcome of the outcome killOutcomeOf
 *                                 gives a thrown ErrTmuxSessionConflict (src/agent-
 *                                 director-errors.ts, the client's class), cut where
 *                                 agent-director's description begins: the abort kill's
 *                                 line for a CONFLICT that latched the persona, up to
 *                                 and including the `message="` before that description
 *   conflictLatchSetLineHead <key> <latched|relatched>
 *                                 src/conflict-latch.ts conflictLatchSetLine for a new
 *                                 latch (CONFLICT_LATCH_SET_LATCHED) or a relatch
 *                                 (CONFLICT_LATCH_SET_RELATCHED), cut where the case
 *                                 begins: the head of every such line for the persona,
 *                                 up to and including `case=`
 *   conflictNotThisLaunchLatchedLine <key> <description>
 *                                 src/conflict-latch.ts conflictLatchSetLine for the
 *                                 latch the abort kill's CONFLICT sets: case
 *                                 LATCH_CASE_NOT_THIS_LAUNCH, the session
 *                                 conflictSessionName(<description>, <key>), refused
 *                                 operation REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY,
 *                                 the row state src/liveness-reading.ts
 *                                 AGENT_DIRECTOR_PENDING_STATE (latchRowStateRead), and
 *                                 the description (src/persona-connection-errors.ts
 *                                 renderLogMessageText, as the record stores it)
 *   conflictNotThisLaunchPost <name> <key> <description>
 *                                 src/persona-notifier.ts formatPersonaNotice for the
 *                                 persona over src/conflict-latch.ts conflictNoticeText
 *                                 for that latch's record (the session, the case and
 *                                 the description as above; the list line decided from
 *                                 the session name, which the record keeps unchanged
 *                                 for a name rendering does not change): the whole
 *                                 CONFLICT post, multi-line
 *   latchRecheckNotThisLaunchRoundHead <ref>
 *                                 src/conflict-latch.ts latchRecheckRoundLine(<ref>,
 *                                 LATCH_CASE_NOT_THIS_LAUNCH, …), cut where the step
 *                                 begins: the head of every re-check round line of a
 *                                 "not this launch's session" latch, up to and
 *                                 including `step=`
 *
 * The pre-trust entries (scenario 22). <ref> is a persona reference as the
 * server logs it, <key> a persona key, <verb> a launch verb by its value (one
 * of LAUNCH_VERB_SPAWN, LAUNCH_VERB_RESUME and LAUNCH_VERB_REUSE_SPAWN; any
 * other fails), and <value> a `pre_trust` value as a launch result carries it:
 *   LAUNCH_VERB_SPAWN            src/session-manager.ts LAUNCH_VERB_SPAWN: the verb a
 *                                 `pre_trust` line names for a plain spawn
 *   LAUNCH_VERB_RESUME            src/session-manager.ts LAUNCH_VERB_RESUME: the verb a
 *                                 `pre_trust` line names for a `resume`
 *   LAUNCH_VERB_REUSE_SPAWN       src/session-manager.ts LAUNCH_VERB_REUSE_SPAWN: the
 *                                 verb a `pre_trust` line names for a reuse spawn
 * None of the above takes an argument.
 *   preTrustLogLine <ref> <verb> [<value>]
 *                                 src/session-manager.ts preTrustLogLine(<ref>, <verb>,
 *                                 <value>): the one line a successful launch writes
 *                                 about its `pre_trust`; with no <value>, the line for
 *                                 a result that carries no `pre_trust` field (the
 *                                 older-binary wording)
 *   preTrustLogLineHead <ref> <verb>
 *                                 src/session-manager.ts preTrustLogLine for a present
 *                                 value, cut where the value begins: the head of
 *                                 every such line for <ref> and <verb>, whatever
 *                                 value it shows
 *   personaDefaultConfigDirLabels <key> <home>
 *                                 the labels a spawn of persona <key> with no
 *                                 `claude_config_dir` carries under the home
 *                                 directory <home>, one per line, in the order
 *                                 src/session-manager.ts buildSpawnParams lists them:
 *                                 src/persona-identity.ts SERVICE_LABEL, then
 *                                 PERSONA_LABEL_PREFIX and <key>, then
 *                                 CONFIG_DIR_LABEL_PREFIX and
 *                                 src/session-manager.ts personaConfigDirLabelValue
 *                                 (no directory, <home>), which resolves
 *                                 `<home>/.claude` to its real path (the one
 *                                 derivation the spawn labels and the collision
 *                                 ladder's `config_dir` comparison share)
 *
 * An entry is one `Entry` in `ENTRIES`: its argument synopsis, the export it
 * prints and a `print` function from its arguments to the value. Constants
 * use `constantEntry`; a builder entry checks its own arguments with
 * `expectArguments` and loads its export with `packageFunction`. A
 * fixed-argument entry is one `ArgsEntry` in `ARGS_ENTRIES` (its argument
 * names and a `print` from them), loading its exports with `fn`, `value` and
 * `text`; `argsEntries` turns them into entries. A one-function entry is one `FnEntry` in `FN_ENTRIES`, a function
 * from the arguments to the value that checks them itself (`noArguments`,
 * `oneArgument`), loading its exports with `exportOf`, `stringExport` and
 * `wholeNumberAt`; `fnEntries` turns them into entries. `ENTRIES` joins the
 * tables, and a name in two fails every run of the printer, so each name has
 * one entry. A name documented in more than one block above has its one
 * entry in the shared table (the `constantEntry` and named `Entry` values),
 * which the other blocks' scenarios read as well.
 *
 * The printer makes no agent-director call, starts no process or server,
 * opens no socket, reads no token and writes no file.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

if (!existsSync('/etc/cscb-ci-image')) {
  console.error('FAIL: fmk-texts: refused: /etc/cscb-ci-image is absent; this printer runs only in a cscb-ci image (/ci)')
  process.exit(2)
}

/** The name the printer's FAIL lines carry. */
const PRINTER_NAME = 'fmk-texts'

/** Exit status for a missing or unknown entry, or arguments an entry does not take (EX_USAGE). */
const USAGE_EXIT = 64

/** Exit status for a missing or mistyped export, or a builder that throws. */
const PRINTER_FAIL_EXIT = 1

/** The installed package under test. */
const PKG_DIR = process.env['CSCB_PKG_DIR'] ?? '/test-repo/node_modules/claude-slack-channel-bots'

/** What an entry gets besides its arguments. */
interface EntryContext {
  /** Import a module of the installed package's `src/` (for example `ad-version-gate.ts`). */
  importPackageModule(relPath: string): Promise<Record<string, unknown>>
  /** The value another entry prints for `args` (for an entry that wraps one). */
  entryValue(name: string, args: readonly string[]): Promise<string>
}

/** One named entry of the printer. */
interface Entry {
  /** The arguments it takes, as the usage shows them ('' for none). */
  readonly synopsis: string
  /** The value for `args`, exactly as printed. */
  print(args: readonly string[], context: EntryContext): Promise<string>
}

/** Prints `FAIL: fmk-texts: <reason>` on one line (line breaks become spaces) and exits with `code`. */
function fail(code: number, reason: string): never {
  console.error(`FAIL: ${PRINTER_NAME}: ${reason.replace(/\s*\n\s*/g, ' ')}`)
  process.exit(code)
}

/** A usage failure: the reason, the usage and each entry with its arguments; exit 64. */
function usageFail(detail: string): never {
  const known = Object.keys(ENTRIES)
    .sort()
    .map((name) => (ENTRIES[name].synopsis === '' ? name : `${name} ${ENTRIES[name].synopsis}`))
  fail(USAGE_EXIT, `${detail}; usage: bun fmk-texts.ts <entry> [<arg>…] (entries: ${known.join(', ')})`)
}

/** Fails with a usage failure unless `args` holds exactly `names.length` non-empty arguments. */
function expectArguments(entry: string, args: readonly string[], names: readonly string[]): void {
  const shown = names.length === 0 ? 'no argument' : names.map((n) => `<${n}>`).join(' ')
  if (args.length !== names.length) usageFail(`${entry} takes ${shown} (got ${args.length})`)
  const empty = args.findIndex((a) => a === '')
  if (empty >= 0) usageFail(`${entry}: <${names[empty]}> is empty`)
}

/** Export `name` of the package module `relPath`; a failure when it is undefined. */
async function packageExport(context: EntryContext, relPath: string, name: string): Promise<unknown> {
  const mod = await context.importPackageModule(relPath)
  const value = mod[name]
  if (value === undefined) fail(PRINTER_FAIL_EXIT, `the installed package's src/${relPath} exports no ${name}`)
  return value
}

/** Export `name` of the package module `relPath`, which must be a function. */
async function packageFunction<F>(context: EntryContext, relPath: string, name: string): Promise<F> {
  const value = await packageExport(context, relPath, name)
  if (typeof value !== 'function') fail(PRINTER_FAIL_EXIT, `the installed package's src/${relPath} export ${name} is not a function`)
  return value as F
}

/** Export `name` of the package module `relPath`, which must be a string. */
async function packageString(context: EntryContext, relPath: string, name: string): Promise<string> {
  const value = await packageExport(context, relPath, name)
  if (typeof value !== 'string') fail(PRINTER_FAIL_EXIT, `the installed package's src/${relPath} export ${name} is not a string`)
  return value
}

/** Fails unless a builder's output is a string; answers it. */
function builtString(entry: string, value: unknown): string {
  if (typeof value !== 'string') fail(PRINTER_FAIL_EXIT, `${entry} built a ${typeof value}, not a string`)
  return value
}

/** An entry printing the package constant `name` of `relPath`: a string as it is, a finite number in decimal. No argument. */
function constantEntry(relPath: string, name: string): Entry {
  return {
    synopsis: '',
    async print(args, context) {
      expectArguments(name, args, [])
      const value = await packageExport(context, relPath, name)
      if (typeof value === 'string') return value
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
      fail(PRINTER_FAIL_EXIT, `the installed package's src/${relPath} export ${name} is a ${typeof value}, not a string or a finite number`)
    },
  }
}

/** The printer's words for which check found a refused binary, by the package export each selects. */
const FOUND_BY_EXPORTS: Readonly<Record<string, string>> = {
  startup: 'FOUND_BY_STARTUP_CHECK',
  runtime: 'FOUND_BY_RUNTIME_RECHECK',
}

/** `buildBelowPhase1FloorMessage({ foundVersion, binaryPath }, foundBy)`, `foundBy` read from the package. */
const belowPhase1FloorMessage: Entry = {
  synopsis: '<found-version> <binary-path> <startup|runtime>',
  async print(args, context) {
    const entry = 'buildBelowPhase1FloorMessage'
    expectArguments(entry, args, ['found-version', 'binary-path', 'startup|runtime'])
    const [foundVersion, binaryPath, finder] = args
    const foundByExport = Object.hasOwn(FOUND_BY_EXPORTS, finder) ? FOUND_BY_EXPORTS[finder] : undefined
    if (foundByExport === undefined) usageFail(`${entry}: the finder must be startup or runtime (got '${finder}')`)
    const foundBy = await packageString(context, 'ad-version-gate.ts', foundByExport)
    const build = await packageFunction<(parts: object, foundBy: string) => unknown>(context, 'ad-version-gate.ts', entry)
    return builtString(entry, build({ foundVersion, binaryPath }, foundBy))
  },
}

/** `formatPersonaNotice({ name, key: personaKey(name) }, <another entry's value>)`: the text a persona's notice is posted as. */
const personaNotice: Entry = {
  synopsis: '<persona-name> <entry> [<arg>…]',
  async print(args, context) {
    const entry = 'formatPersonaNotice'
    const [name, inner, ...innerArgs] = args
    if (name === undefined || name === '' || inner === undefined || inner === '') {
      usageFail(`${entry} takes <persona-name> <entry> [<arg>…] (got ${args.length} argument${args.length === 1 ? '' : 's'})`)
    }
    const body = await context.entryValue(inner, innerArgs)
    const personaKey = await packageFunction<(name: string) => unknown>(context, 'persona-identity.ts', 'personaKey')
    const format = await packageFunction<(persona: { name: string; key: unknown }, text: string) => unknown>(context, 'persona-notifier.ts', entry)
    return builtString(entry, format({ name, key: personaKey(name) }, body))
  },
}

// ---------------------------------------------------------------------------
// The latch scenarios' entries (E42–E43): the latch notices, the recovery
// texts, agent-director's case phrases, the re-check interval and the latch's
// server-log lines, every one from conflict-latch.ts, ad-description-phrases.ts,
// persona-notifier.ts or persona-identity.ts.
// ---------------------------------------------------------------------------

/** conflict-latch.ts's constants the latch scenarios print as they are. */
const LATCH_CONSTANT_NAMES: readonly string[] = [
  'LATCH_CASE_CONFLICTING_LABELS',
  'LATCH_CASE_PANE_NOT_FOUND',
  'LATCH_CASE_NOT_THIS_LAUNCH',
  'LATCH_CASE_LEFTOVER',
  'LATCH_CASE_NEVER_REPORTED_IN',
  'LATCH_CASE_OWN_ID',
  'LATCH_CASE_NO_VALID_ID',
  'LATCH_CASE_DIFFERENT_ID',
  'LATCH_CASE_ANOTHER_STORE',
  'LATCH_CASE_UNRECOGNISED',
  'LATCH_CASE_UNUSABLE_RECORDED_NAME',
  'LATCH_CASE_LAUNCH_START_NOT_RECORDED',
  'REFUSED_OPERATION_PLAIN_SPAWN',
  'REFUSED_OPERATION_REUSE_SPAWN',
  'REFUSED_OPERATION_RESUME',
  'REFUSED_OPERATION_BRING_UP',
  'REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY',
  'REFUSED_OPERATION_NONE',
  'CONFLICT_NOTICE_FIRST_LINE_HEAD',
  'CONFLICT_NOTICE_CASE_SENTENCE_LEAD',
  'CONFLICT_NOTICE_FIRST_LINE_TAIL',
  'CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD',
  'CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL',
  'CONFLICT_NOTICE_POINTER_LINE',
  'CONFLICT_NOTICE_DIFFERENT_ID_MUST_NOT_END_LINE',
  'CONFLICT_NOTICE_ANOTHER_STORE_MUST_NOT_END_LINE',
  'CONFLICT_NOTICE_LIST_LINE_HEAD',
  'CONFLICT_NOTICE_LIST_LINE_TAIL',
  'CONFLICT_NOTICE_LIST_LINE_UNSAFE_NAME',
  'CONFLICT_NOTICE_HUMAN_ONLY_LINE',
  'CONFLICT_NOTICE_LINE_SEPARATOR',
  'UNUSABLE_NAME_NOTICE_HEAD',
  'UNUSABLE_NAME_NOTICE_REASON',
  'UNUSABLE_NAME_NOTICE_DESCRIPTION_END',
  'UNUSABLE_NAME_NOTICE_POINTER',
  'UNUSABLE_NAME_NOTICE_HOLD',
  'UNUSABLE_NAME_NOTICE_SEPARATOR',
  'LAUNCH_START_NOTICE_HEAD',
  'LAUNCH_START_NOTICE_SESSION_END',
  'LAUNCH_START_NOTICE_POINTER',
  'LAUNCH_START_NOTICE_HOLD',
  'LAUNCH_START_NOTICE_SEPARATOR',
  'LATCH_RECOVERY_REASON_ROW_READS_HEAD',
  'CONFLICT_RECOVERY_HEAD',
  'CONFLICT_RECOVERY_REASON_LEAD',
  'HOLD_RECOVERY_HEAD',
  'LATCH_RECOVERY_TAIL',
  'LATCH_RECHECK_INTERVAL_MS',
  'RECHECK_STEP_CLEAR_REPORTED_IN',
  'RECHECK_STEP_CLEAR_GONE',
  'RECHECK_STEP_SPAWN_RETRY',
  'RECHECK_STEP_FINISHED_ROW_RETRY',
  'RECHECK_STEP_TABLE',
  'RECHECK_STEP_NO_INFORMATION',
  'RECHECK_LINE_STEP_NOT_DECIDED',
  'RECHECK_CALL_NONE',
  'RECHECK_CALL_PROBE',
  'RECHECK_CALL_PENDING_READ_PANE',
  'RECHECK_CALL_PLAIN_SPAWN',
  'RECHECK_CALL_REUSE_SPAWN',
  'RECHECK_CALL_RESUME',
  'RECHECK_CALL_RESTART_DECISION',
  'RECHECK_CALL_FINISHED_ROW',
]

/** ad-description-phrases.ts's words the latch scenarios match in agent-director's descriptions and fmk-driver.ts's outcome line. */
const CASE_PHRASE_NAMES: readonly string[] = [
  'UNUSABLE_RECORDED_NAME_PHRASE',
  'CONFLICT_CONFLICTING_LABELS_PHRASE',
  'CONFLICT_PANE_NOT_FOUND_PHRASE',
  'CONFLICT_NOT_THIS_LAUNCH_PHRASE',
  'CONFLICT_LEFTOVER_PHRASE',
  'CONFLICT_NEVER_REPORTED_IN_PHRASE',
  'CONFLICT_OWN_ID_PHRASE',
  'CONFLICT_NO_VALID_ID_PHRASE',
  'CONFLICT_DIFFERENT_ID_PHRASE',
  'CONFLICT_ANOTHER_STORE_PHRASE',
  'PLAIN_SPAWN_LABEL_NAMES_THIS_ID_PHRASE',
  'PLAIN_SPAWN_LABEL_NOT_THIS_ID_PHRASE',
  'NEW_ROW_ENDED_PHRASE',
  'NOTHING_WRITTEN_PHRASE',
]

/** A `constantEntry` for each of `names`, all of `relPath`. */
function constantEntries(relPath: string, names: readonly string[]): Record<string, Entry> {
  return Object.fromEntries(names.map((name) => [name, constantEntry(relPath, name)]))
}

/** Fails with a usage failure unless `args` holds `min` to `names.length` non-empty arguments. */
function expectSomeArguments(entry: string, args: readonly string[], names: readonly string[], min: number): void {
  const shown = names.map((n, i) => (i < min ? `<${n}>` : `[<${n}>]`)).join(' ')
  if (args.length < min || args.length > names.length) usageFail(`${entry} takes ${shown} (got ${args.length})`)
  const empty = args.findIndex((a) => a === '')
  if (empty >= 0) usageFail(`${entry}: <${names[empty]}> is empty`)
}

/** Export `name` of conflict-latch.ts, which must be an array of strings. */
async function latchStrings(context: EntryContext, name: string): Promise<readonly string[]> {
  const value = await packageExport(context, 'conflict-latch.ts', name)
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    fail(PRINTER_FAIL_EXIT, `the installed package's src/conflict-latch.ts export ${name} is not an array of strings`)
  }
  return value as string[]
}

/** `value` when the package's LATCH_CASES holds it (a CONFLICT case only, with `conflictOnly`); a usage failure otherwise. */
async function latchCaseArgument(context: EntryContext, entry: string, value: string, conflictOnly = false): Promise<string> {
  const cases = await latchStrings(context, 'LATCH_CASES')
  if (!cases.includes(value)) usageFail(`${entry}: '${value}' is not a latch case (${cases.join(', ')})`)
  if (conflictOnly && (await latchStrings(context, 'HOLD_LATCH_CASES')).includes(value)) {
    usageFail(`${entry}: '${value}' is a hold case, which takes no CONFLICT notice`)
  }
  return value
}

/** `value` when the package's REFUSED_OPERATIONS holds it; a usage failure otherwise. */
async function refusedOperationArgument(context: EntryContext, entry: string, value: string): Promise<string> {
  const operations = await latchStrings(context, 'REFUSED_OPERATIONS')
  if (!operations.includes(value)) usageFail(`${entry}: '${value}' is not a refused operation (${operations.join(', ')})`)
  return value
}

/** The recorded row state for a word: the package's no-row or unreadable value for its kind, else `latchRowStateRead(word)`. */
async function rowStateArgument(context: EntryContext, word: string): Promise<unknown> {
  if (word === (await packageString(context, 'conflict-latch.ts', 'LATCH_ROW_STATE_KIND_NO_ROW'))) {
    return await packageExport(context, 'conflict-latch.ts', 'LATCH_ROW_STATE_NO_ROW')
  }
  if (word === (await packageString(context, 'conflict-latch.ts', 'LATCH_ROW_STATE_KIND_UNREADABLE'))) {
    return await packageExport(context, 'conflict-latch.ts', 'LATCH_ROW_STATE_UNREADABLE')
  }
  const read = await packageFunction<(state: string) => unknown>(context, 'conflict-latch.ts', 'latchRowStateRead')
  return read(word)
}

/** The SRJ-1005 reasons with no state, by the export that holds each. */
const RECOVERY_REASON_EXPORTS: readonly string[] = [
  'LATCH_RECOVERY_REASON_ROW_GONE',
  'LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED',
  'LATCH_RECOVERY_REASON_RELAUNCH_NOT_REFUSED',
  'LATCH_RECOVERY_REASON_CLEARED_BY_HAND',
]

/** The state-bearing reason's builder, by its export name. */
const ROW_READS_REASON = 'latchRecoveryReasonRowReads'

/** The reason the words `<reason> [<state>]` name: one of RECOVERY_REASON_EXPORTS (no state), or ROW_READS_REASON with its state. */
async function recoveryReasonArgument(context: EntryContext, entry: string, words: readonly string[]): Promise<unknown> {
  const [name, ...rest] = words
  if (name === ROW_READS_REASON && rest.length === 1 && rest[0] !== '') {
    return (await packageFunction<(state: string) => unknown>(context, 'conflict-latch.ts', ROW_READS_REASON))(rest[0])
  }
  if (name !== undefined && RECOVERY_REASON_EXPORTS.includes(name) && rest.length === 0) {
    return await packageExport(context, 'conflict-latch.ts', name)
  }
  usageFail(`${entry}: the reason must be one of ${RECOVERY_REASON_EXPORTS.join(', ')}, or ${ROW_READS_REASON} <state> (got '${words.join(' ')}')`)
}

/** `conflictNoticeText({ sessionName, latchCase, description })`: the CONFLICT notice body as src builds it. */
async function conflictNoticeBody(context: EntryContext, entry: string, latchCase: string, sessionName: string, description?: string): Promise<string> {
  const build = await packageFunction<(source: object) => unknown>(context, 'conflict-latch.ts', 'conflictNoticeText')
  const source = description === undefined ? { sessionName, latchCase } : { sessionName, latchCase, description }
  return builtString(entry, build(source))
}

/** The CONFLICT notice body's lines, split on the package's CONFLICT_NOTICE_LINE_SEPARATOR. */
async function conflictNoticeLines(context: EntryContext, entry: string, latchCase: string, sessionName: string): Promise<string[]> {
  const separator = await packageString(context, 'conflict-latch.ts', 'CONFLICT_NOTICE_LINE_SEPARATOR')
  return (await conflictNoticeBody(context, entry, latchCase, sessionName)).split(separator)
}

/** The persona prefix `formatPersonaNotice` adds: `formatPersonaNotice({ name, key }, '')`, the key `personaKey(name)` unless given. */
const personaNoticePrefix: Entry = {
  synopsis: '<persona-name> [<key>]',
  async print(args, context) {
    const entry = 'personaNoticePrefix'
    expectSomeArguments(entry, args, ['persona-name', 'key'], 1)
    const [name, given] = args
    const derive = await packageFunction<(name: string) => unknown>(context, 'persona-identity.ts', 'personaKey')
    const key = given ?? builtString(entry, derive(name))
    const format = await packageFunction<(persona: { name: string; key: string }, text: string) => unknown>(context, 'persona-notifier.ts', 'formatPersonaNotice')
    return builtString(entry, format({ name, key }, ''))
  },
}

/** `personaInstanceId(key)`: a persona's agent-director instance id. */
const personaInstanceId: Entry = {
  synopsis: '<key>',
  async print(args, context) {
    const entry = 'personaInstanceId'
    expectArguments(entry, args, ['key'])
    return builtString(entry, (await packageFunction<(key: string) => unknown>(context, 'persona-identity.ts', entry))(args[0]))
  },
}

/** The whole CONFLICT notice body for a CONFLICT case, a quoted session and, when given, agent-director's description. */
const conflictNoticeText: Entry = {
  synopsis: '<case> <session-name> [<description>]',
  async print(args, context) {
    const entry = 'conflictNoticeText'
    expectSomeArguments(entry, args, ['case', 'session-name', 'description'], 2)
    const latchCase = await latchCaseArgument(context, entry, args[0], true)
    return await conflictNoticeBody(context, entry, latchCase, args[1], args[2])
  },
}

/** The CONFLICT notice's first line (head, `"<session>"`, the case sentence when the case has one, tail), from `conflictNoticeText`. */
const conflictNoticeFirstLine: Entry = {
  synopsis: '<case> <session-name>',
  async print(args, context) {
    const entry = 'conflictNoticeFirstLine'
    expectArguments(entry, args, ['case', 'session-name'])
    const latchCase = await latchCaseArgument(context, entry, args[0], true)
    return (await conflictNoticeLines(context, entry, latchCase, args[1]))[0]
  },
}

/** The CONFLICT notice's list line for a session name (or the unsafe-name line in its place), from `conflictNoticeText`. */
const conflictNoticeListLine: Entry = {
  synopsis: '<session-name>',
  async print(args, context) {
    const entry = 'conflictNoticeListLine'
    expectArguments(entry, args, ['session-name'])
    const leftover = await packageString(context, 'conflict-latch.ts', 'LATCH_CASE_LEFTOVER')
    const lines = await conflictNoticeLines(context, entry, leftover, args[0])
    const line = lines[lines.length - 2]
    const head = await packageString(context, 'conflict-latch.ts', 'CONFLICT_NOTICE_LIST_LINE_HEAD')
    const unsafe = await packageString(context, 'conflict-latch.ts', 'CONFLICT_NOTICE_LIST_LINE_UNSAFE_NAME')
    if (line === undefined || !(line.startsWith(head) || line === unsafe)) {
      fail(PRINTER_FAIL_EXIT, `${entry}: the notice's line before the human-only line is not its list line`)
    }
    return line
  },
}

/** `conflictCaseSentence(case)`: SRJ-1004's case sentence; a failure for a case that has none. */
const conflictCaseSentence: Entry = {
  synopsis: '<case>',
  async print(args, context) {
    const entry = 'conflictCaseSentence'
    expectArguments(entry, args, ['case'])
    const latchCase = await latchCaseArgument(context, entry, args[0])
    const sentence = (await packageFunction<(latchCase: string) => unknown>(context, 'conflict-latch.ts', entry))(latchCase)
    if (sentence === undefined) fail(PRINTER_FAIL_EXIT, `${entry}: case '${latchCase}' has no case sentence`)
    return builtString(entry, sentence)
  },
}

/** `unusableNameNoticeText(key, description)`: SRJ-1019's notice body. */
const unusableNameNoticeText: Entry = {
  synopsis: '<key> <description>',
  async print(args, context) {
    const entry = 'unusableNameNoticeText'
    expectArguments(entry, args, ['key', 'description'])
    return builtString(entry, (await packageFunction<(key: string, d: string) => unknown>(context, 'conflict-latch.ts', entry))(args[0], args[1]))
  },
}

/** `launchStartNotRecordedNoticeText(key)`: SRJ-1020's notice body. */
const launchStartNotRecordedNoticeText: Entry = {
  synopsis: '<key>',
  async print(args, context) {
    const entry = 'launchStartNotRecordedNoticeText'
    expectArguments(entry, args, ['key'])
    return builtString(entry, (await packageFunction<(key: string) => unknown>(context, 'conflict-latch.ts', entry))(args[0]))
  },
}

/** `conflictRecoveryText(session, reason)`: the CONFLICT recovery notice body. */
const conflictRecoveryText: Entry = {
  synopsis: `<session-name> <${RECOVERY_REASON_EXPORTS.join('|')}|${ROW_READS_REASON} <state>>`,
  async print(args, context) {
    const entry = 'conflictRecoveryText'
    const [sessionName, ...reasonWords] = args
    if (sessionName === undefined || sessionName === '') usageFail(`${entry} takes <session-name> <reason> [<state>]`)
    const reason = await recoveryReasonArgument(context, entry, reasonWords)
    return builtString(entry, (await packageFunction<(s: string, r: unknown) => unknown>(context, 'conflict-latch.ts', entry))(sessionName, reason))
  },
}

/** `holdRecoveryText(reason)`: the hold recovery notice body. */
const holdRecoveryText: Entry = {
  synopsis: `<${RECOVERY_REASON_EXPORTS.join('|')}|${ROW_READS_REASON} <state>>`,
  async print(args, context) {
    const entry = 'holdRecoveryText'
    const reason = await recoveryReasonArgument(context, entry, args)
    return builtString(entry, (await packageFunction<(r: unknown) => unknown>(context, 'conflict-latch.ts', entry))(reason))
  },
}

/** `conflictLatchSetLine(key, record, previousCase)`: the latch-set server-log line, the record built from the arguments (no description). */
const conflictLatchSetLine: Entry = {
  synopsis: '<key> <case> <session-name> <refused-operation> <row-state> [<previous-case>]',
  async print(args, context) {
    const entry = 'conflictLatchSetLine'
    expectSomeArguments(entry, args, ['key', 'case', 'session-name', 'refused-operation', 'row-state', 'previous-case'], 5)
    const [key, caseWord, sessionName, operation, state, previous] = args
    const record = {
      sessionName,
      latchCase: await latchCaseArgument(context, entry, caseWord),
      refusedOperation: await refusedOperationArgument(context, entry, operation),
      rowState: await rowStateArgument(context, state),
    }
    const previousCase = previous === undefined ? undefined : await latchCaseArgument(context, entry, previous)
    const build = await packageFunction<(key: string, record: object, previous?: string) => unknown>(context, 'conflict-latch.ts', entry)
    return builtString(entry, build(key, record, previousCase))
  },
}

/** The printer's words for whether the recovery notice was posted. */
const POSTED_WORDS: Readonly<Record<string, boolean>> = { posted: true, 'not-posted': false }

/** `latchClearedLine(key, record, reason, posted)`: the clear's server-log line (the builder reads the record's case and session only). */
const latchClearedLine: Entry = {
  synopsis: `<key> <case> <session-name> <posted|not-posted> <${RECOVERY_REASON_EXPORTS.join('|')}|${ROW_READS_REASON} <state>>`,
  async print(args, context) {
    const entry = 'latchClearedLine'
    const [key, caseWord, sessionName, postedWord, ...reasonWords] = args
    if ([key, caseWord, sessionName, postedWord].some((a) => a === undefined || a === '')) {
      usageFail(`${entry} takes <key> <case> <session-name> <posted|not-posted> <reason> [<state>]`)
    }
    const posted = Object.hasOwn(POSTED_WORDS, postedWord) ? POSTED_WORDS[postedWord] : undefined
    if (posted === undefined) usageFail(`${entry}: <posted|not-posted> is '${postedWord}'`)
    const record = {
      sessionName,
      latchCase: await latchCaseArgument(context, entry, caseWord),
      refusedOperation: await packageString(context, 'conflict-latch.ts', 'REFUSED_OPERATION_NONE'),
      rowState: await packageExport(context, 'conflict-latch.ts', 'LATCH_ROW_STATE_UNREADABLE'),
    }
    const reason = await recoveryReasonArgument(context, entry, reasonWords)
    const build = await packageFunction<(key: string, record: object, reason: unknown, posted: boolean) => unknown>(context, 'conflict-latch.ts', entry)
    return builtString(entry, build(key, record, reason, posted))
  },
}

/** `latchRecheckRoundLine(ref, case, step, call, answer)`: the re-check round's server-log line, `ref` the persona reference `renderPersonaRef` gives the name. */
const latchRecheckRoundLine: Entry = {
  synopsis: '<persona-name> <case> <step> <call> <answer>',
  async print(args, context) {
    const entry = 'latchRecheckRoundLine'
    expectArguments(entry, args, ['persona-name', 'case', 'step', 'call', 'answer'])
    const [name, caseWord, step, call, answer] = args
    const latchCase = await latchCaseArgument(context, entry, caseWord)
    const ref = (await packageFunction<(name: string) => unknown>(context, 'persona-identity.ts', 'renderPersonaRef'))(name)
    const build = await packageFunction<(ref: unknown, c: string, s: string, call: string, a: string) => unknown>(context, 'conflict-latch.ts', entry)
    return builtString(entry, build(builtString(entry, ref), latchCase, step, call, answer))
  },
}

/** `personaTmuxSessionName(key)`: the tmux session name a persona's launches ask for. */
const personaTmuxSessionName: Entry = {
  synopsis: '<key>',
  async print(args, context) {
    const entry = 'personaTmuxSessionName'
    expectArguments(entry, args, ['key'])
    return builtString(entry, (await packageFunction<(key: string) => unknown>(context, 'persona-identity.ts', entry))(args[0]))
  },
}

/** An entry printing ad-settings.ts's `name(DEFAULT_AD_SETTINGS_IN_EFFECT)` in decimal: a wait at agent-director's default settings, in milliseconds. No argument. */
function adSettingsDefaultMs(name: string): Entry {
  return {
    synopsis: '',
    async print(args, context) {
      expectArguments(name, args, [])
      const defaults = await packageExport(context, 'ad-settings.ts', 'DEFAULT_AD_SETTINGS_IN_EFFECT')
      const value = (await packageFunction<(values: unknown) => unknown>(context, 'ad-settings.ts', name))(defaults)
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(PRINTER_FAIL_EXIT, `${name} gave ${String(value)}, not a finite number`)
      return String(value)
    },
  }
}


/** An entry printing the output of the package builder `name` of `relPath` for its string arguments `argNames`. */
function builderEntry(relPath: string, name: string, argNames: readonly string[]): Entry {
  return {
    synopsis: argNames.map((n) => `<${n}>`).join(' '),
    async print(args, context) {
      expectArguments(name, args, argNames)
      const build = await packageFunction<(...parts: string[]) => unknown>(context, relPath, name)
      return builtString(name, build(...args))
    },
  }
}

// ---------------------------------------------------------------------------
// agent-director's settings, as scenario 24's lane prints them (the same
// names, arguments and values).
// ---------------------------------------------------------------------------

/** A value in decimal: a `bigint`, or a `number` that is a safe integer; a failure for anything else. */
function decimal(entry: string, value: unknown): string {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  fail(PRINTER_FAIL_EXIT, `${entry} gave ${typeof value === 'number' ? String(value) : `a ${typeof value}`}, not an integer`)
}

/**
 * `DEFAULT_AD_SETTINGS[<table>][<key>]` in decimal: agent-director's default
 * for one setting as CSCB records it (an integer, a `bigint` in the package).
 */
const adSettingDefault: Entry = {
  synopsis: '<table> <key>',
  async print(args, context) {
    const entry = 'DEFAULT_AD_SETTINGS'
    expectArguments(entry, args, ['table', 'key'])
    const [table, key] = args
    const defaults = await packageExport(context, 'ad-settings.ts', entry)
    if (typeof defaults !== 'object' || defaults === null) fail(PRINTER_FAIL_EXIT, `the installed package's src/ad-settings.ts export ${entry} is not an object`)
    const tables = defaults as Record<string, unknown>
    const values = Object.hasOwn(tables, table) ? tables[table] : undefined
    if (typeof values !== 'object' || values === null) usageFail(`${entry}: the installed package records no table '${table}'`)
    const keyed = values as Record<string, unknown>
    const value = Object.hasOwn(keyed, key) ? keyed[key] : undefined
    if (value === undefined) usageFail(`${entry}: the installed package records no key '${key}' in table '${table}'`)
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
    fail(PRINTER_FAIL_EXIT, `the installed package's ${entry}.${table}.${key} is a ${typeof value}, not an integer`)
  },
}

/** `AD_SETTING_MINIMUMS[<key>]` in decimal, or `AD_SETTING_MINIMUMS[<key>][<part>]` for a key whose minimum has parts (`floor`, `addend`). */
const adSettingMinimum: Entry = {
  synopsis: '<key> [<part>]',
  async print(args, context) {
    const entry = 'AD_SETTING_MINIMUMS'
    const [key, part] = args
    if (args.length < 1 || args.length > 2 || args.some((a) => a === '')) usageFail(`${entry} takes <key> [<part>] (got ${args.length} argument${args.length === 1 ? '' : 's'})`)
    const minimums = await packageExport(context, 'ad-settings.ts', entry)
    if (typeof minimums !== 'object' || minimums === null) fail(PRINTER_FAIL_EXIT, `the installed package's src/ad-settings.ts export ${entry} is not an object`)
    const byKey = minimums as Record<string, unknown>
    const value = Object.hasOwn(byKey, key) ? byKey[key] : undefined
    if (value === undefined) usageFail(`${entry}: the installed package records no minimum for '${key}'`)
    if (typeof value === 'object' && value !== null) {
      const parts = value as Record<string, unknown>
      if (part === undefined) usageFail(`${entry}: the minimum of '${key}' has parts (${Object.keys(parts).join(', ')}); name one`)
      if (!Object.hasOwn(parts, part)) usageFail(`${entry}: the minimum of '${key}' has no part '${part}'`)
      return decimal(`${entry}.${key}.${part}`, parts[part])
    }
    if (part !== undefined) usageFail(`${entry}: the minimum of '${key}' has no parts`)
    return decimal(`${entry}.${key}`, value)
  },
}

/** The import-free session-ending forms helper, in this file's own tree (`/tests` in the image). */
const SESSION_ENDING_COMMANDS_PATH = join(import.meta.dir, '..', '..', 'test-helpers', 'session-ending-commands.ts')

/** The session-ending command forms a post's CSCB-authored lines match (the post read on standard input). */
const sessionEndingForms: Entry = {
  synopsis: '',
  async print(args, context) {
    const entry = 'sessionEndingCommandsIn'
    expectArguments(entry, args, [])
    const head = await packageString(context, 'conflict-latch.ts', 'CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD')
    const separator = await packageString(context, 'conflict-latch.ts', 'CONFLICT_NOTICE_LINE_SEPARATOR')
    const helper = (await import(SESSION_ENDING_COMMANDS_PATH)) as Record<string, unknown>
    const find = helper[entry]
    if (typeof find !== 'function') fail(PRINTER_FAIL_EXIT, `${SESSION_ENDING_COMMANDS_PATH} exports no function ${entry}`)
    const text = await Bun.stdin.text()
    const own = text.split(separator).filter((line) => !line.startsWith(head))
    const found = own.flatMap((line) => (find as (text: string) => string[])(line))
    return [...new Set(found)].join('\n')
  },
}

/** `ONSET_TEMPLATES[<outage-class>]()`: the class's onset with no detail. */
const onsetTemplate: Entry = {
  synopsis: '<outage-class>',
  async print(args, context) {
    const entry = 'ONSET_TEMPLATES'
    expectArguments(entry, args, ['outage-class'])
    const [outageClass] = args
    const templates = await packageExport(context, 'outage-state.ts', entry)
    if (typeof templates !== 'object' || templates === null) fail(PRINTER_FAIL_EXIT, `the installed package's src/outage-state.ts export ${entry} is not an object`)
    const template = Object.hasOwn(templates, outageClass) ? (templates as Record<string, unknown>)[outageClass] : undefined
    if (typeof template !== 'function') fail(PRINTER_FAIL_EXIT, `the installed package's src/outage-state.ts ${entry} has no template for outage class '${outageClass}'`)
    return builtString(entry, (template as () => unknown)())
  },
}

/**
 * `ALL_CLEAR_TEMPLATE(<a bad stretch of the given classes, none with a detail>)`:
 * the all-clear notice. Each class must be one of the package's
 * `OUTAGE_CLASS_ORDER`, given once.
 */
const allClear: Entry = {
  synopsis: '<outage-class>…',
  async print(args, context) {
    const entry = 'ALL_CLEAR_TEMPLATE'
    if (args.length === 0) usageFail(`${entry} takes <outage-class>… (got none)`)
    const order = await packageExport(context, 'outage-state.ts', 'OUTAGE_CLASS_ORDER')
    if (!Array.isArray(order) || order.some((c) => typeof c !== 'string')) {
      fail(PRINTER_FAIL_EXIT, "the installed package's src/outage-state.ts export OUTAGE_CLASS_ORDER is not an array of class names")
    }
    const resolved = new Map<string, object>()
    for (const cls of args) {
      if (!order.includes(cls)) usageFail(`${entry}: '${cls}' is not one of the package's outage classes (${order.join(', ')})`)
      if (resolved.has(cls)) usageFail(`${entry}: ${cls} is given twice`)
      resolved.set(cls, {})
    }
    const build = await packageFunction<(resolved: Map<string, object>) => unknown>(context, 'outage-state.ts', entry)
    return builtString(entry, build(resolved))
  },
}

/** Stands for the part of a line its builder fills from agent-director's answer, a verdict or a reference. */
const HEAD_SENTINEL = 'FMK-TEXTS-HEAD-SENTINEL'

/** The text of `line` before HEAD_SENTINEL; a failure when the sentinel is absent or opens the line. */
function headBefore(entry: string, line: string): string {
  const at = line.indexOf(HEAD_SENTINEL)
  if (at <= 0) fail(PRINTER_FAIL_EXIT, `${entry}: the builder's line holds no text before the part it fills`)
  return line.slice(0, at)
}

/** `waitingRowPaneGoneLine(<key>, <a GONE pane read>)` before the read's description. */
const waitingRowPaneGoneHead: Entry = {
  synopsis: '<key>',
  async print(args, context) {
    const entry = 'waitingRowPaneGoneLineHead'
    expectArguments(entry, args, ['key'])
    const kind = await packageString(context, 'pane-read.ts', 'PANE_READ_GONE')
    const errorClass = await packageString(context, 'ad-error-class.ts', 'AD_ERROR_CLASS_GONE')
    const build = await packageFunction<(key: string, read: object) => unknown>(context, 'session-manager.ts', 'waitingRowPaneGoneLine')
    return headBefore(entry, builtString(entry, build(args[0], { kind, errorClass, description: HEAD_SENTINEL })))
  },
}

/** `escalateDeadSweepLine(<key>, <verdict>)` before the verdict. */
const escalateDeadSweepHead: Entry = {
  synopsis: '<key>',
  async print(args, context) {
    const entry = 'escalateDeadSweepLineHead'
    expectArguments(entry, args, ['key'])
    const build = await packageFunction<(key: string, verdict: string) => unknown>(context, 'session-manager.ts', 'escalateDeadSweepLine')
    return headBefore(entry, builtString(entry, build(args[0], HEAD_SENTINEL)))
  },
}

/** `reconnectGoneLine(<ref>, <failure>)` before the persona's reference. */
const reconnectGoneHead: Entry = {
  synopsis: '',
  async print(args, context) {
    const entry = 'reconnectGoneLineHead'
    expectArguments(entry, args, [])
    const build = await packageFunction<(ref: string, failure: string) => unknown>(context, 'session-manager.ts', 'reconnectGoneLine')
    return headBefore(entry, builtString(entry, build(HEAD_SENTINEL, `${HEAD_SENTINEL}-failure`)))
  },
}

/** The printer's words for what a latch-set line reports, by the package export each selects. */
const LATCH_SET_OUTCOME_EXPORTS: Readonly<Record<string, string>> = {
  latched: 'CONFLICT_LATCH_SET_LATCHED',
  relatched: 'CONFLICT_LATCH_SET_RELATCHED',
}

/**
 * `conflictLatchSetLine(<key>, <record>[, <previous case>])` up to and
 * including `case=`: the head of persona <key>'s latch-set lines for a new
 * latch (no previous case) or a relatch (a previous case). The record's
 * case, session and refused operation are the sentinel and its row state the
 * package's LATCH_ROW_STATE_NO_ROW; the line is cut where the case begins.
 */
const conflictLatchSetHead: Entry = {
  synopsis: '<key> <latched|relatched>',
  async print(args, context) {
    const entry = 'conflictLatchSetLineHead'
    expectArguments(entry, args, ['key', 'latched|relatched'])
    const [key, word] = args
    const outcomeExport = Object.hasOwn(LATCH_SET_OUTCOME_EXPORTS, word) ? LATCH_SET_OUTCOME_EXPORTS[word] : undefined
    if (outcomeExport === undefined) usageFail(`${entry}: the outcome must be latched or relatched (got '${word}')`)
    const outcome = await packageString(context, 'conflict-latch.ts', outcomeExport)
    if (outcome !== word) fail(PRINTER_FAIL_EXIT, `the installed package's src/conflict-latch.ts ${outcomeExport} is '${outcome}', not '${word}'`)
    const relatched = await packageString(context, 'conflict-latch.ts', 'CONFLICT_LATCH_SET_RELATCHED')
    const noRow = await packageExport(context, 'conflict-latch.ts', 'LATCH_ROW_STATE_NO_ROW')
    const record = { sessionName: HEAD_SENTINEL, latchCase: HEAD_SENTINEL, refusedOperation: HEAD_SENTINEL, rowState: noRow }
    const build = await packageFunction<(key: string, record: object, previousCase?: string) => unknown>(context, 'conflict-latch.ts', 'conflictLatchSetLine')
    const line = builtString(entry, outcome === relatched ? build(key, record, HEAD_SENTINEL) : build(key, record))
    return headBefore(entry, line)
  },
}

/** `relaunchAfterKillLine(<key>, <cwd>, RELAUNCH_KILL_NONE)`: the restart work's line before a launch with no kill. */
const relaunchAfterKill: Entry = {
  synopsis: '<key> <cwd> RELAUNCH_KILL_NONE',
  async print(args, context) {
    const entry = 'relaunchAfterKillLine'
    expectArguments(entry, args, ['key', 'cwd', 'kill-export'])
    if (args[2] !== 'RELAUNCH_KILL_NONE') usageFail(`${entry}: <kill-export> must be RELAUNCH_KILL_NONE (got '${args[2]}')`)
    const none = await packageString(context, 'restart.ts', 'RELAUNCH_KILL_NONE')
    const build = await packageFunction<(key: string, cwd: string, killed: string) => unknown>(context, 'restart.ts', entry)
    return builtString(entry, build(args[0], args[1], none))
  },
}

/** `relaunchWithoutKillLine(<key>, no verdict, <RELAUNCH_NO_KILL_* named>, <LIVENESS_READING_DEAD* named>)`. */
const relaunchWithoutKill: Entry = {
  synopsis: '<key> <reason-export> <dead-reading-export>',
  async print(args, context) {
    const entry = 'relaunchWithoutKillLine'
    expectArguments(entry, args, ['key', 'reason-export', 'dead-reading-export'])
    const [key, reasonExport, readingExport] = args
    if (!reasonExport.startsWith('RELAUNCH_NO_KILL_')) usageFail(`${entry}: <reason-export> must name a RELAUNCH_NO_KILL_* value (got '${reasonExport}')`)
    if (!readingExport.startsWith('LIVENESS_READING_DEAD')) {
      usageFail(`${entry}: <dead-reading-export> must name a LIVENESS_READING_DEAD* value (got '${readingExport}')`)
    }
    const reason = await packageString(context, 'restart.ts', reasonExport)
    const reading = await packageExport(context, 'liveness-reading.ts', readingExport)
    const build = await packageFunction<(key: string, verdict: undefined, reason: string, reading: unknown) => unknown>(context, 'restart.ts', entry)
    return builtString(entry, build(key, undefined, reason, reading))
  },
}

/** `tmuxUnresponsiveAlertText(<key>, adAlertThresholdMs(DEFAULT_AD_SETTINGS_IN_EFFECT))`: the alert at agent-director's default settings. */
const unresponsiveAlert: Entry = {
  synopsis: '<key>',
  async print(args, context) {
    const entry = 'tmuxUnresponsiveAlertText'
    expectArguments(entry, args, ['key'])
    const settings = await packageExport(context, 'ad-settings.ts', 'DEFAULT_AD_SETTINGS_IN_EFFECT')
    const threshold = await packageFunction<(values: unknown) => unknown>(context, 'ad-settings.ts', 'adAlertThresholdMs')
    const thresholdMs = threshold(settings)
    if (typeof thresholdMs !== 'number' || !Number.isFinite(thresholdMs)) fail(PRINTER_FAIL_EXIT, `${entry}: adAlertThresholdMs gave no finite number`)
    const build = await packageFunction<(key: string, thresholdMs: number) => unknown>(context, 'persona-episodes.ts', entry)
    return builtString(entry, build(args[0], thresholdMs))
  },
}

/**
 * When the retry timer's retry <retry> (from 1) falls due after its arm, in
 * seconds: `doublingBackoffDelay(UNAVAILABLE_RETRY_BASE_S, k,
 * UNAVAILABLE_RETRY_CEILING_S)` summed for k from 0 to <retry> - 1, the waits
 * src/unavailable-retry.ts arms (its first at the base, each later one after
 * k refusals).
 */
const unavailableRetryDue: Entry = {
  synopsis: '<retry>',
  async print(args, context) {
    const entry = 'unavailableRetryDueS'
    expectArguments(entry, args, ['retry'])
    if (!/^[1-9][0-9]{0,2}$/.test(args[0])) usageFail(`${entry}: <retry> must be a whole number from 1 to 999 (got '${args[0]}')`)
    const base = await packageExport(context, 'unavailable-retry.ts', 'UNAVAILABLE_RETRY_BASE_S')
    const ceiling = await packageExport(context, 'unavailable-retry.ts', 'UNAVAILABLE_RETRY_CEILING_S')
    if (typeof base !== 'number' || typeof ceiling !== 'number') {
      fail(PRINTER_FAIL_EXIT, "the installed package's src/unavailable-retry.ts UNAVAILABLE_RETRY_BASE_S or UNAVAILABLE_RETRY_CEILING_S is not a number")
    }
    const delay = await packageFunction<(base: number, priorAttempts: number, ceiling: number) => unknown>(context, 'backoff.ts', 'doublingBackoffDelay')
    let due = 0
    for (let k = 0; k < Number(args[0]); k++) {
      const wait = delay(base, k, ceiling)
      if (typeof wait !== 'number' || !Number.isFinite(wait)) fail(PRINTER_FAIL_EXIT, `${entry}: doublingBackoffDelay gave ${String(wait)}, not a finite number`)
      due += wait
    }
    return decimal(entry, due)
  },
}

// ---------------------------------------------------------------------------
// The fixed-argument entries (scenarios 2, 6, 7, 9, 12, 15, 16 and 18)
// ---------------------------------------------------------------------------


/**
 * A stand-in description, for entries that cut a line at the description:
 * letters only, so redaction, JSON quoting and Slack escaping leave it as it
 * is, and found once in the line it is put in.
 */
const DESCRIPTION_STAND_IN = 'FMKTEXTSDESCRIPTIONSTANDIN'

/** A usage or export failure, carried to the one FAIL line. */
class PrinterFailure extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message)
  }
}

/** One fixed-argument entry: its arguments' names, and the value it prints for them. */
interface ArgsEntry {
  readonly args: readonly string[]
  readonly print: (args: readonly string[]) => Promise<string>
}

/** Import the installed package's `src/<relPath>`. */
async function packageModule(relPath: string): Promise<Record<string, unknown>> {
  return (await import(join(PKG_DIR, 'src', relPath))) as Record<string, unknown>
}

/** Export `name` of `src/<relPath>`, which must be a function. */
async function fn<F>(relPath: string, name: string): Promise<F> {
  const value = (await packageModule(relPath))[name]
  if (typeof value !== 'function') throw new PrinterFailure(`the installed package's src/${relPath} exports no function ${name}`, PRINTER_FAIL_EXIT)
  return value as F
}

/** Export `name` of `src/<relPath>`, which must be defined. */
async function value(relPath: string, name: string): Promise<unknown> {
  const v = (await packageModule(relPath))[name]
  if (v === undefined) throw new PrinterFailure(`the installed package's src/${relPath} exports no ${name}`, PRINTER_FAIL_EXIT)
  return v
}

/** Export `name` of `src/<relPath>` as text (a string, or a number printed as it is). */
async function text(relPath: string, name: string): Promise<string> {
  const v = await value(relPath, name)
  if (typeof v !== 'string' && typeof v !== 'number') throw new PrinterFailure(`src/${relPath}'s ${name} is neither a string nor a number`, PRINTER_FAIL_EXIT)
  return String(v)
}

/** `<try>` as a whole number from 1. */
function tryNumber(raw: string): number {
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < 1) throw new PrinterFailure(`try '${raw}' is not a whole number from 1`, USAGE_EXIT)
  return n
}

/** The bounded retry's tries (`KILL_RETRY_TRIES`). */
async function killRetryTries(): Promise<number> {
  const tries = await value('kill-retry.ts', 'KILL_RETRY_TRIES')
  if (typeof tries !== 'number') throw new PrinterFailure("src/kill-retry.ts's KILL_RETRY_TRIES is not a number", PRINTER_FAIL_EXIT)
  return tries
}

/**
 * The kill outcome of an `ErrTmuxKillFailed` carrying `description`, as the
 * checked kill reads it (`killOutcomeOf`), from the client class the package
 * re-exports (src/agent-director-errors.ts).
 */
async function killFailedOutcome(description: string): Promise<unknown> {
  const errors = await packageModule('agent-director-errors.ts')
  const KillFailed = errors['ErrTmuxKillFailed']
  const name = errors['ERR_TMUX_KILL_FAILED_NAME']
  if (typeof KillFailed !== 'function' || typeof name !== 'string') {
    throw new PrinterFailure("the installed package's src/agent-director-errors.ts exports no ErrTmuxKillFailed and ERR_TMUX_KILL_FAILED_NAME", PRINTER_FAIL_EXIT)
  }
  const thrown = new (KillFailed as new (verb: string, errName: string, errDescription: string) => Error)('', name, description)
  const killOutcomeOf = await fn<(settled: { thrown: unknown }) => unknown>('checked-kill.ts', 'killOutcomeOf')
  return killOutcomeOf({ thrown })
}

/** `describeKillOutcome` of `outcome`. */
async function describeKillOutcome(outcome: unknown): Promise<string> {
  return (await fn<(o: unknown) => string>('checked-kill.ts', 'describeKillOutcome'))(outcome)
}

/** `line` before and after the one place `part` sits in it. */
function around(line: string, part: string, what: string): { readonly head: string; readonly tail: string } {
  const at = line.indexOf(part)
  if (at < 0 || line.indexOf(part, at + 1) >= 0) throw new PrinterFailure(`${what} does not hold its outcome exactly once`, PRINTER_FAIL_EXIT)
  return { head: line.slice(0, at), tail: line.slice(at + part.length) }
}

/**
 * The bounded retry's end line (`killRetryEndLine`, no prefix) for
 * `instanceId`'s tries that ended exhausted after `KILL_RETRY_TRIES` kills,
 * with a read before each further try and the ordinary alert decided, cut
 * around its outcome.
 */
async function killRetryEndLineParts(instanceId: string): Promise<{ readonly head: string; readonly tail: string }> {
  const tries = await killRetryTries()
  const outcome = await killFailedOutcome(DESCRIPTION_STAND_IN)
  const end = await value('kill-retry.ts', 'KILL_RETRY_END_EXHAUSTED')
  const ordinary = await value('kill-retry.ts', 'KILL_RETRY_ALERT_ORDINARY')
  const endLine = await fn<(prefix: string, id: string, result: object) => string>('kill-retry.ts', 'killRetryEndLine')
  const line = endLine('', instanceId, { outcome, end, tries, reads: tries - 1, alert: { kind: ordinary, lastKillFailedDescription: DESCRIPTION_STAND_IN } })
  return around(line, await describeKillOutcome(outcome), 'killRetryEndLine')
}

/**
 * A stand-in count, for the entry that cuts the start sweep's summary line
 * at its first count: found once in the line it is put in.
 */
const COUNT_STAND_IN = 918273645

/** `<n>` as a whole number from 0. */
function count(raw: string): number {
  const n = Number(raw)
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(n)) throw new PrinterFailure(`count '${raw}' is not a whole number from 0`, USAGE_EXIT)
  return n
}

/**
 * The start sweep's line for a kill whose success stands
 * (`startSweepKillSucceededLine`, src/session-manager.ts) for `instanceId`
 * (named `persona`; none for a pre-persona row), cut around its outcome
 * (`describeKillOutcome` of a kill that answered `kill_sent` true).
 */
async function startSweepKillSucceededParts(instanceId: string, persona: string | undefined): Promise<{ readonly head: string; readonly tail: string }> {
  const killOutcomeOf = await fn<(settled: { result: unknown }) => unknown>('checked-kill.ts', 'killOutcomeOf')
  const outcome = killOutcomeOf({ result: { kill_sent: true } })
  const line = (await fn<(id: string, p: string | undefined, o: unknown) => string>('session-manager.ts', 'startSweepKillSucceededLine'))(instanceId, persona, outcome)
  return around(line, await describeKillOutcome(outcome), 'startSweepKillSucceededLine')
}

/** The ordinary alert's content for `description` (`killFailureAlertContentOf`). */
async function ordinaryContent(instanceId: string, session: string, description: string): Promise<unknown> {
  const ordinary = await value('kill-retry.ts', 'KILL_RETRY_ALERT_ORDINARY')
  const contentOf = await fn<(decision: object, session: string, id: string) => unknown>('kill-failure-alert.ts', 'killFailureAlertContentOf')
  return contentOf({ kind: ordinary, lastKillFailedDescription: description }, session, instanceId)
}

/** The ordinary version's route for `context` (`selectKillFailureAlertRoute`). */
async function ordinaryRoute(context: unknown, configured: boolean): Promise<{ readonly closing: unknown }> {
  const version = await value('kill-failure-alert.ts', 'KILL_FAILURE_VERSION_ORDINARY')
  const select = await fn<(input: object) => { closing: unknown }>('kill-failure-alert.ts', 'selectKillFailureAlertRoute')
  return select({ version, context, configured, latched: false })
}

/** `killFailureAlertText` of `content` for `closing`. */
async function alertText(content: unknown, closing: unknown, forSlack: boolean): Promise<string> {
  return (await fn<(c: unknown, closing: unknown, forSlack: boolean) => string>('kill-failure-alert.ts', 'killFailureAlertText'))(content, closing, forSlack)
}

/** The alert threshold at agent-director's default settings (`adAlertThresholdMs`). */
async function defaultAlertThresholdMs(): Promise<number> {
  const defaults = await value('ad-settings.ts', 'DEFAULT_AD_SETTINGS_IN_EFFECT')
  return (await fn<(values: unknown) => number>('ad-settings.ts', 'adAlertThresholdMs'))(defaults)
}

/** A stand-in verb, for the entry that cuts the condition's started line at its verb: found once in it. */
const VERB_STAND_IN = 'FMKTEXTSVERBSTANDIN'

/**
 * The bounded retry's per-try line (`killRetryTryLine`, no prefix) for try
 * `n` of `max` of `instanceId`, followed by `next`, cut around its outcome
 * (an `ErrTmuxKillFailed` naming no survivor, so no survivor clause sits
 * between the outcome and what follows).
 */
async function killRetryTryLineParts(instanceId: string, n: number, max: number, next: unknown): Promise<{ readonly head: string; readonly tail: string }> {
  const outcome = await killFailedOutcome(DESCRIPTION_STAND_IN)
  const tryLine = await fn<(prefix: string, id: string, n: number, max: number, outcome: unknown, next: unknown) => string>('kill-retry.ts', 'killRetryTryLine')
  return around(tryLine('', instanceId, n, max, outcome, next), await describeKillOutcome(outcome), 'killRetryTryLine')
}

/**
 * The per-try line's fixed part for an `ErrTmuxKillFailed` try `n` of `max`
 * of `instanceId`, up to its JSON-quoted description. What follows the
 * description (the next step) is not in it, so either next step gives it.
 */
async function killRetryTryDescriptionHead(instanceId: string, n: number, max: number): Promise<string> {
  const outcome = await killFailedOutcome(DESCRIPTION_STAND_IN)
  const next = await value('kill-retry.ts', n < max ? 'KILL_RETRY_NEXT_AGAIN' : 'KILL_RETRY_NEXT_EXHAUSTED')
  const tryLine = await fn<(prefix: string, id: string, n: number, max: number, outcome: unknown, next: unknown) => string>('kill-retry.ts', 'killRetryTryLine')
  return around(tryLine('', instanceId, n, max, outcome, next), JSON.stringify(DESCRIPTION_STAND_IN), 'killRetryTryLine').head
}

/** A stand-in class label, for the entry that cuts a line at its class: found once in it. */
const CLASS_STAND_IN = 'FMKTEXTSCLASSSTANDIN'

/** The value of the `CLI_COMMAND_*` export named `name` (src/cli-teardown.ts). */
async function cliCommand(name: string): Promise<string> {
  if (!/^CLI_COMMAND_[A-Z_]+$/.test(name)) throw new PrinterFailure(`command '${name}' is not a CLI_COMMAND_* export's name`, USAGE_EXIT)
  return text('cli-teardown.ts', name)
}

/** The value of the `AD_ERROR_CLASS_*` export named `name` (src/ad-error-class.ts). */
async function adErrorClass(name: string): Promise<string> {
  if (!/^AD_ERROR_CLASS_[A-Z_]+$/.test(name)) throw new PrinterFailure(`class '${name}' is not an AD_ERROR_CLASS_* export's name`, USAGE_EXIT)
  return text('ad-error-class.ts', name)
}

/** The persona named `name` as the CLI's lines take it: its name and key (`personaKey`). */
async function cliPersona(name: string): Promise<{ readonly name: string; readonly key: string }> {
  return { name, key: (await fn<(n: string) => string>('persona-identity.ts', 'personaKey'))(name) }
}

/**
 * The report (`personaTeardownReportOf`) of the persona named `name` under
 * the `CLI_COMMAND_*` export `commandName`, whose teardown kill's tries
 * ended exhausted after `KILL_RETRY_TRIES` kills on an `ErrTmuxKillFailed`
 * carrying `description`, with the ordinary alert decided, its outcome
 * mapped by `teardownKillOutcomeOf` as the CLI maps it.
 */
async function cliTeardownKillFailedReport(
  commandName: string,
  name: string,
  description: string,
): Promise<{ readonly printed: readonly string[]; readonly entry?: { readonly classLabel: string; readonly message: string } }> {
  const command = await cliCommand(commandName)
  const persona = await cliPersona(name)
  const tries = await killRetryTries()
  const result = {
    outcome: await killFailedOutcome(description),
    end: await value('kill-retry.ts', 'KILL_RETRY_END_EXHAUSTED'),
    tries,
    reads: tries - 1,
    alert: { kind: await value('kill-retry.ts', 'KILL_RETRY_ALERT_ORDINARY'), lastKillFailedDescription: description },
  }
  const outcome = (await fn<(r: object) => unknown>('cli-teardown.ts', 'teardownKillOutcomeOf'))(result)
  const report = (await fn<(c: string, p: object, o: unknown) => { printed: string[]; entry?: { classLabel: string; message: string } }>(
    'cli-teardown.ts',
    'personaTeardownReportOf',
  ))(command, persona, outcome)
  if (report.printed.length !== 2 || report.entry === undefined) {
    throw new PrinterFailure('personaTeardownReportOf did not give a failure line, an alert line and an entry for a kill that failed with the ordinary alert', PRINTER_FAIL_EXIT)
  }
  return report
}

/** The entries, by the name a script passes. */

/** The fixed-argument entries, by the name a script passes. */
const ARGS_ENTRIES: Readonly<Record<string, ArgsEntry>> = {
  LAST_APPLIED_FILE_SUFFIX: { args: [], print: () => text('reload.ts', 'LAST_APPLIED_FILE_SUFFIX') },
  ORPHAN_CLEANUP_LABEL: { args: [], print: () => text('kill-failure-alert.ts', 'ORPHAN_CLEANUP_LABEL') },
  RETRY_KILL_LATER_PHRASE: { args: [], print: () => text('ad-description-phrases.ts', 'RETRY_KILL_LATER_PHRASE') },
  NEVER_DELETE_ROW_PHRASE: { args: [], print: () => text('ad-description-phrases.ts', 'NEVER_DELETE_ROW_PHRASE') },
  KILL_RETRY_TRIES: { args: [], print: async () => String(await killRetryTries()) },
  'killRetryTryLine.description-head': {
    args: ['instance-id', 'try'],
    print: async ([instanceId, raw]) => killRetryTryDescriptionHead(instanceId, tryNumber(raw), await killRetryTries()),
  },
  'killRetryTryLine.description-head-of': {
    args: ['instance-id', 'try', 'max'],
    print: async ([instanceId, raw, rawMax]) => {
      const n = tryNumber(raw)
      const max = tryNumber(rawMax)
      if (n > max) throw new PrinterFailure(`try ${n} is past the last try, ${max}`, USAGE_EXIT)
      return killRetryTryDescriptionHead(instanceId, n, max)
    },
  },
  'killRetryEndLine.head': { args: ['instance-id'], print: async ([instanceId]) => (await killRetryEndLineParts(instanceId)).head },
  'killRetryEndLine.tail': { args: ['instance-id'], print: async ([instanceId]) => (await killRetryEndLineParts(instanceId)).tail },
  startSweepKillFailedEntry: {
    args: ['instance-id', 'persona', 'state', 'session', 'description'],
    print: async ([instanceId, persona, state, session, description]) => {
      const outcome = await describeKillOutcome(await killFailedOutcome(description))
      const entry = await fn<(input: object) => string>('session-manager.ts', 'startSweepKillFailedEntry')
      return entry({ instanceId, persona, state, session, outcome, stoppedAtShutdown: false })
    },
  },
  'killFailureAlertEntryText.start-sweep': {
    args: ['instance-id', 'session', 'description'],
    print: async ([instanceId, session, description]) => {
      const context = await value('kill-failure-alert.ts', 'KILL_FAILURE_CONTEXT_START_SWEEP')
      const route = await ordinaryRoute(context, false)
      const body = await alertText(await ordinaryContent(instanceId, session, description), route.closing, false)
      const entryText = await fn<(ref: string, context: unknown, text: string) => string>('kill-failure-alert.ts', 'killFailureAlertEntryText')
      // The row's reference as the start sweep writes it, `instanceId=<id>`
      // (src/session-manager.ts sweepKillAlertEntry; no exported builder).
      return entryText(`instanceId=${instanceId}`, context, body)
    },
  },
  'killFailureAlertText.destination': {
    args: ['instance-id', 'session', 'description'],
    print: async ([instanceId, session, description]) => {
      const context = await value('kill-failure-alert.ts', 'KILL_FAILURE_CONTEXT_RECOVERY')
      const route = await ordinaryRoute(context, true)
      return alertText(await ordinaryContent(instanceId, session, description), route.closing, true)
    },
  },
  uncoveredPendingRowLine: {
    args: ['name', 'reason'],
    print: async ([name, reasonName]) => {
      if (!/^PENDING_ROW_REASON_[A-Z_]+$/.test(reasonName)) throw new PrinterFailure(`reason '${reasonName}' is not a PENDING_ROW_REASON_* export's name`, USAGE_EXIT)
      const reason = await value('pending-row.ts', reasonName)
      const ref = (await fn<(n: string) => string>('persona-identity.ts', 'renderPersonaRef'))(name)
      return (await fn<(r: string, why: unknown) => string>('session-manager.ts', 'uncoveredPendingRowLine'))(ref, reason)
    },
  },
  SERVICE_LABEL: { args: [], print: () => text('persona-identity.ts', 'SERVICE_LABEL') },
  PERSONA_LABEL_KEY: { args: [], print: () => text('persona-identity.ts', 'PERSONA_LABEL_KEY') },
  PENDING_FILE_SUFFIX: { args: [], print: () => text('reload.ts', 'PENDING_FILE_SUFFIX') },
  APPLY_FILE_SUFFIX: { args: [], print: () => text('reload.ts', 'APPLY_FILE_SUFFIX') },
  PERSONA_TEARDOWN_NOTICE_LABEL: { args: [], print: () => text('kill-failure-alert.ts', 'PERSONA_TEARDOWN_NOTICE_LABEL') },
  RETIRED_KEYS_FILE_NAME: { args: [], print: () => text('retired-keys.ts', 'RETIRED_KEYS_FILE_NAME') },
  retiredKeysPath: {
    args: ['state-dir'],
    print: async ([stateDir]) => (await fn<(dir: string) => string>('retired-keys.ts', 'retiredKeysPath'))(stateDir),
  },
  RETIRED_KEY_CAUSE_REMOVED: { args: [], print: () => text('retired-keys.ts', 'RETIRED_KEY_CAUSE_REMOVED') },
  RETIRED_KEY_CAUSE_ABSENT_AT_START: { args: [], print: () => text('retired-keys.ts', 'RETIRED_KEY_CAUSE_ABSENT_AT_START') },
  'startSweepKillFailedEntry.pre-persona': {
    args: ['instance-id', 'state', 'session', 'description'],
    print: async ([instanceId, state, session, description]) => {
      const outcome = await describeKillOutcome(await killFailedOutcome(description))
      const entry = await fn<(input: object) => string>('session-manager.ts', 'startSweepKillFailedEntry')
      return entry({ instanceId, state, session, outcome, stoppedAtShutdown: false })
    },
  },
  'startSweepKillSucceededLine.head': {
    args: ['instance-id', 'persona'],
    print: async ([instanceId, persona]) => (await startSweepKillSucceededParts(instanceId, persona)).head,
  },
  'startSweepKillSucceededLine.pre-persona-head': {
    args: ['instance-id'],
    print: async ([instanceId]) => (await startSweepKillSucceededParts(instanceId, undefined)).head,
  },
  'startSweepKillSucceededLine.tail': {
    args: ['instance-id'],
    print: async ([instanceId]) => (await startSweepKillSucceededParts(instanceId, undefined)).tail,
  },
  startSweepSummaryLine: {
    args: ['listed', 'killed', 'kept', 'kill-failed', 'recorded-as-retired', 'left-for-latch'],
    print: async ([listed, killed, kept, killFailed, recorded, left]) => {
      const summary = await fn<(result: object) => string>('session-manager.ts', 'startSweepSummaryLine')
      return summary({
        listed: count(listed),
        killed: count(killed),
        kept: count(kept),
        killFailed: count(killFailed),
        recordedAsRetired: count(recorded),
        leftForLatch: count(left),
      })
    },
  },
  'startSweepSummaryLine.head': {
    args: [],
    print: async () => {
      const summary = await fn<(result: object) => string>('session-manager.ts', 'startSweepSummaryLine')
      const line = summary({ listed: COUNT_STAND_IN, killed: 0, kept: 0, killFailed: 0, recordedAsRetired: 0, leftForLatch: 0 })
      return around(line, String(COUNT_STAND_IN), 'startSweepSummaryLine').head
    },
  },
  'startSweepLatchedFromOwnRowLine.launch-start-not-recorded': {
    args: ['name', 'instance-id'],
    print: async ([name, instanceId]) => {
      const ref = (await fn<(n: string) => string>('persona-identity.ts', 'renderPersonaRef'))(name)
      const latchCase = await text('conflict-latch.ts', 'LATCH_CASE_LAUNCH_START_NOT_RECORDED')
      return (await fn<(r: string, id: string, c: string) => string>('session-manager.ts', 'startSweepLatchedFromOwnRowLine'))(ref, instanceId, latchCase)
    },
  },
  'personaTeardownNoticeEntryText.kill-failure': {
    args: ['name', 'session', 'description'],
    print: async ([name, session, description]) => {
      const key = (await fn<(n: string) => string>('persona-identity.ts', 'personaKey'))(name)
      const instanceId = (await fn<(k: string) => string>('persona-identity.ts', 'personaInstanceId'))(key)
      const context = await value('kill-failure-alert.ts', 'KILL_FAILURE_CONTEXT_PERSONA_TEARDOWN')
      const route = await ordinaryRoute(context, false)
      const alert = await alertText(await ordinaryContent(instanceId, session, description), route.closing, false)
      // The persona notifier's teardown window writes the text with Slack's
      // control-character escapes undone (src/persona-notifier.ts writeTeardownNotice).
      const unescaped = (await fn<(t: string) => string>('slack-text-escape.ts', 'unescapeSlackControlCharacters'))(alert)
      const ref = (await fn<(n: string, k: string) => string>('persona-identity.ts', 'renderPersonaRef'))(name, key)
      const entry = await fn<(personaRef: string, text: string) => string>('persona-notifier.ts', 'personaTeardownNoticeEntryText')
      // The window's persona reference, `persona <ref>` (src/persona-notifier.ts
      // teardownRef; no exported builder).
      return entry(`persona ${ref}`, unescaped)
    },
  },
  // Scenario 6 (test-18; b.jg5 SRJ-1408).
  tmuxUnresponsiveRecoveryText: {
    args: ['key'],
    print: async ([key]) => (await fn<(k: string) => string>('persona-episodes.ts', 'tmuxUnresponsiveRecoveryText'))(key),
  },
  'tmuxUnresponsiveStartedLine.head': {
    args: ['key'],
    print: async ([key]) => {
      const line = (await fn<(k: string, verb: string, d: string) => string>('persona-episodes.ts', 'tmuxUnresponsiveStartedLine'))(key, VERB_STAND_IN, DESCRIPTION_STAND_IN)
      return around(line, VERB_STAND_IN, 'tmuxUnresponsiveStartedLine').head
    },
  },
  'adAlertThresholdMs.default': { args: [], print: async () => String(await defaultAlertThresholdMs()) },
  TMUX_UNRESPONSIVE_ONSET_FLOOR_MS: { args: [], print: () => text('persona-episodes.ts', 'TMUX_UNRESPONSIVE_ONSET_FLOOR_MS') },
  restartRetryCapSkippedLine: {
    args: ['key'],
    print: async ([key]) => (await fn<(k: string) => string>('restart.ts', 'restartRetryCapSkippedLine'))(key),
  },
  UNAVAILABLE_RETRY_STOP_CAPPED: { args: [], print: () => text('unavailable-retry.ts', 'UNAVAILABLE_RETRY_STOP_CAPPED') },
  DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS: { args: [], print: () => text('config.ts', 'DEFAULT_AGENT_DIRECTOR_CALL_TIMEOUT_MS') },
  KILL_RETRY_SPACING_MS: { args: [], print: () => text('kill-retry.ts', 'KILL_RETRY_SPACING_MS') },
  'killRetryTryLine.head': {
    args: ['instance-id', 'try', 'max'],
    print: async ([instanceId, rawTry, rawMax]) => {
      const n = tryNumber(rawTry)
      const max = tryNumber(rawMax)
      const next = await value('kill-retry.ts', 'KILL_RETRY_NEXT_AGAIN')
      return (await killRetryTryLineParts(instanceId, n, max, next)).head
    },
  },
  'killRetryTryLine.tail': {
    args: ['next'],
    print: async ([nextName]) => {
      if (!/^KILL_RETRY_NEXT_[A-Z_]+$/.test(nextName)) throw new PrinterFailure(`next '${nextName}' is not a KILL_RETRY_NEXT_* export's name`, USAGE_EXIT)
      const next = await value('kill-retry.ts', nextName)
      return (await killRetryTryLineParts(DESCRIPTION_STAND_IN.toLowerCase(), 1, 1, next)).tail
    },
  },
  // Scenario 9 (test-21; b.jg5 SRJ-1411).
  CLI_COMMAND_CLEAN_RESTART: { args: [], print: () => cliCommand('CLI_COMMAND_CLEAN_RESTART') },
  CLI_COMMAND_STOP_BOTS: { args: [], print: () => cliCommand('CLI_COMMAND_STOP_BOTS') },
  adErrorClass: { args: ['class'], print: async ([name]) => adErrorClass(name) },
  adErrorName: {
    args: ['error-class'],
    print: async ([name]) => {
      if (!/^Err[A-Za-z]+$/.test(name)) throw new PrinterFailure(`error class '${name}' is not an Err* name`, USAGE_EXIT)
      const errorClass = await value('agent-director-errors.ts', name)
      if (typeof errorClass !== 'function' || errorClass.name !== name) {
        throw new PrinterFailure(`src/agent-director-errors.ts's ${name} is not an error class named ${name}`, PRINTER_FAIL_EXIT)
      }
      return errorClass.name
    },
  },
  'precheckFailureLine.head': {
    args: ['command', 'name', 'class'],
    print: async ([commandName, name, className]) => {
      const line = (await fn<(c: string, p: object, f: object) => string>('cli-teardown.ts', 'precheckFailureLine'))(
        await cliCommand(commandName),
        await cliPersona(name),
        { errorClass: await adErrorClass(className), description: DESCRIPTION_STAND_IN },
      )
      return around(line, DESCRIPTION_STAND_IN, 'precheckFailureLine').head
    },
  },
  precheckNothingStoppedLine: {
    args: ['command'],
    print: async ([commandName]) => (await fn<(c: string) => string>('cli-teardown.ts', 'precheckNothingStoppedLine'))(await cliCommand(commandName)),
  },
  'teardownFailureLine.head': {
    args: ['command', 'name', 'class'],
    print: async ([commandName, name, className]) => {
      const line = (await fn<(c: string, p: object, f: object) => string>('cli-teardown.ts', 'teardownFailureLine'))(
        await cliCommand(commandName),
        await cliPersona(name),
        { errorClass: await adErrorClass(className), description: DESCRIPTION_STAND_IN },
      )
      return around(line, DESCRIPTION_STAND_IN, 'teardownFailureLine').head
    },
  },
  'cliTeardownKillFailed.failure-line': {
    args: ['command', 'name', 'description'],
    print: async ([commandName, name, description]) => (await cliTeardownKillFailedReport(commandName, name, description)).printed[0],
  },
  'cliTeardownKillFailed.alert-line': {
    args: ['command', 'name', 'description'],
    print: async ([commandName, name, description]) => (await cliTeardownKillFailedReport(commandName, name, description)).printed[1],
  },
  'cliTeardownKillFailed.entry-class': {
    args: ['command', 'name', 'description'],
    print: async ([commandName, name, description]) => (await cliTeardownKillFailedReport(commandName, name, description)).entry!.classLabel,
  },
  'cliTeardownKillFailed.entry-message': {
    args: ['command', 'name', 'description'],
    print: async ([commandName, name, description]) => (await cliTeardownKillFailedReport(commandName, name, description)).entry!.message,
  },
  teardownNotStoppedLine: {
    args: ['command', 'count'],
    print: async ([commandName, raw]) => (await fn<(c: string, n: number) => string>('cli-teardown.ts', 'teardownNotStoppedLine'))(await cliCommand(commandName), count(raw)),
  },
  PERSONA_KILL_FAILED_LABEL: { args: [], print: () => text('kill-failure-alert.ts', 'PERSONA_KILL_FAILED_LABEL') },
  CLEAN_RESTART_NOT_RESTARTED_LABEL: { args: [], print: () => text('cli-teardown.ts', 'CLEAN_RESTART_NOT_RESTARTED_LABEL') },
  cleanRestartNotRestartedAlert: {
    args: ['class', 'names'],
    print: async ([className, names]) => {
      const errorClass = await adErrorClass(className)
      const list = names.split(',')
      if (list.some((n) => n === '')) throw new PrinterFailure(`names '${names}' holds an empty name`, USAGE_EXIT)
      const failures = await Promise.all(list.map(async (n) => ({ persona: await cliPersona(n), errorClass })))
      return (await fn<(f: readonly object[]) => string>('cli-teardown.ts', 'cleanRestartNotRestartedAlert'))(failures)
    },
  },
  'answerCheckFailedTryLine.head': {
    args: ['try'],
    print: async ([raw]) => {
      const line = (await fn<(n: number, r: object) => string>('cli-teardown.ts', 'answerCheckFailedTryLine'))(tryNumber(raw), {
        errorClass: CLASS_STAND_IN,
        description: DESCRIPTION_STAND_IN,
      })
      return around(line, CLASS_STAND_IN, 'answerCheckFailedTryLine').head
    },
  },
  'adGraceMs.default': {
    args: [],
    print: async () => {
      const defaults = await value('ad-settings.ts', 'DEFAULT_AD_SETTINGS_IN_EFFECT')
      return String((await fn<(values: unknown) => number>('ad-settings.ts', 'adGraceMs'))(defaults))
    },
  },
  // Scenario 7 (test-19; b.jg5 SRJ-1409).
  personaPreTrustLogLine: {
    args: ['name', 'verb', 'value'],
    print: async ([name, verbName, preTrust]) => {
      if (!/^LAUNCH_VERB_[A-Z_]+$/.test(verbName)) throw new PrinterFailure(`verb '${verbName}' is not a LAUNCH_VERB_* export's name`, USAGE_EXIT)
      const verb = await text('session-manager.ts', verbName)
      const ref = (await fn<(n: string) => string>('persona-identity.ts', 'renderPersonaRef'))(name)
      return (await fn<(r: string, v: string, p: string) => string>('session-manager.ts', 'preTrustLogLine'))(ref, verb, preTrust)
    },
  },
  JSONL_DIAGNOSIS_REUSE_WORDING: { args: [], print: () => text('session-manager.ts', 'JSONL_DIAGNOSIS_REUSE_WORDING') },
  JSONL_DIAGNOSIS_INCONCLUSIVE_ENTRY_CLASS: { args: [], print: () => text('session-manager.ts', 'JSONL_DIAGNOSIS_INCONCLUSIVE_ENTRY_CLASS') },
  JSONL_TRANSCRIPT_LOST_ENTRY_CLASS: { args: [], print: () => text('session-manager.ts', 'JSONL_TRANSCRIPT_LOST_ENTRY_CLASS') },
  // Scenario 12 (test-19; b.jg5 SRJ-1414).
  classifyAdError: {
    args: ['error-class'],
    print: async ([name]) => {
      if (!/^Err[A-Za-z]+$/.test(name)) throw new PrinterFailure(`error class '${name}' is not an Err* name`, USAGE_EXIT)
      const errorClass = (await packageModule('agent-director-errors.ts'))[name]
      if (typeof errorClass !== 'function' || errorClass.name !== name) {
        throw new PrinterFailure(`src/agent-director-errors.ts re-exports no error class named ${name}`, PRINTER_FAIL_EXIT)
      }
      const thrown = new (errorClass as new (verb: string, errName: string, errDescription: string) => Error)('spawn', name, '')
      const classify = await fn<(v: unknown) => { readonly errorClass: string }>('ad-error-class.ts', 'classifyAdError')
      return classify(thrown).errorClass
    },
  },
  // Scenario 18 (test-19; b.jg5 SRJ-1419).
  RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY: { args: [], print: () => text('retired-keys.ts', 'RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY') },
  reloadAppliedLogLine: {
    args: ['added', 'removed', 'destructive', 'in-place', 'credentials', 'settings', 'config-path'],
    print: async ([added, removed, destructive, inPlace, credentials, settings, configPath]) => {
      // Stand-in entries, each with its own key: the counts read only how
      // many each class holds (`inPlace` and `nextLaunch` by distinct key).
      const standIns = (raw: string, what: string) => Array.from({ length: count(raw) }, (_, i) => ({ key: `${what}${i}`, name: `${what}${i}` }))
      const plan = {
        added: standIns(added, 'added'),
        removed: standIns(removed, 'removed'),
        destructive: standIns(destructive, 'destructive'),
        inPlace: standIns(inPlace, 'inplace'),
        nextLaunch: [],
        credentials: standIns(credentials, 'credentials'),
        settings: standIns(settings, 'setting'),
      }
      const paths = (await fn<(p: string) => { readonly lastApplied: string }>('reload.ts', 'reloadFilePaths'))(configPath)
      return (await fn<(p: object, recordPath: string) => string>('reload-apply.ts', 'renderAppliedLogLine'))(plan, paths.lastApplied)
    },
  },
}

/** `table`'s fixed-argument entries as entries: a wrong argument count is a usage failure. */
function argsEntries(table: Readonly<Record<string, ArgsEntry>>): Record<string, Entry> {
  return Object.fromEntries(
    Object.entries(table).map(([name, { args: names, print }]) => [
      name,
      {
        synopsis: names.map((n) => `<${n}>`).join(' '),
        async print(args) {
          if (args.length !== names.length) {
            usageFail(`${name} takes ${names.length} argument(s) (${names.map((a) => `<${a}>`).join(' ') || 'none'}), got ${args.length}`)
          }
          return await print(args)
        },
      } satisfies Entry,
    ]),
  )
}

/** The entry tables joined; a name in more than one is a printer failure. */
function joinEntryTables(...tables: readonly Readonly<Record<string, Entry>>[]): Record<string, Entry> {
  const joined: Record<string, Entry> = {}
  for (const table of tables) {
    for (const [name, entry] of Object.entries(table)) {
      if (Object.hasOwn(joined, name)) fail(PRINTER_FAIL_EXIT, `the entry ${name} is defined twice; each name has one entry`)
      joined[name] = entry
    }
  }
  return joined
}

// ---------------------------------------------------------------------------
// The one-function entries (scenarios 5, 11, 13, 21 and 22)
// ---------------------------------------------------------------------------

/** Imports the installed package's `src/<relPath>`. */
async function importPackageModule(relPath: string): Promise<Record<string, unknown>> {
  return (await import(join(PKG_DIR, 'src', relPath))) as Record<string, unknown>
}

/** Export `name` of the package module `relPath`, which must be defined. */
async function exportOf(relPath: string, name: string): Promise<unknown> {
  const mod = await importPackageModule(relPath)
  const value = mod[name]
  if (value === undefined) throw new PrinterFailure(`the installed package's src/${relPath} exports no ${name}`, PRINTER_FAIL_EXIT)
  return value
}

/** Export `name` of `relPath`, which must be a string; printed as it is. */
async function stringExport(relPath: string, name: string): Promise<string> {
  const value = await exportOf(relPath, name)
  if (typeof value !== 'string') throw new PrinterFailure(`the installed package's src/${relPath} ${name} is not a string`, PRINTER_FAIL_EXIT)
  return value
}

/** Export `name` of `relPath`, or the value at `path` inside it, which must be a whole number (a bigint or an integer); printed in decimal. */
async function wholeNumberAt(relPath: string, name: string, path: readonly string[]): Promise<string> {
  let value: unknown = await exportOf(relPath, name)
  for (const key of path) {
    value = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
  }
  const at = [name, ...path].join('.')
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number' && Number.isInteger(value)) return String(value)
  throw new PrinterFailure(`the installed package's src/${relPath} ${at} is not a whole number`, PRINTER_FAIL_EXIT)
}

/** One entry: prints its value for its arguments. */
type FnEntry = (args: readonly string[]) => Promise<string>

/** An entry that takes no argument and prints `read()`. */
function noArguments(name: string, read: () => Promise<string>): FnEntry {
  return async (args) => {
    if (args.length > 0) throw new PrinterFailure(`${name} takes no argument (got ${args.length})`, USAGE_EXIT)
    return await read()
  }
}

/** An entry that takes exactly one argument, named `argName` in its usage error, and prints `read(arg)`. */
function oneArgument(name: string, argName: string, read: (arg: string) => Promise<string>): FnEntry {
  return async (args) => {
    if (args.length !== 1) throw new PrinterFailure(`${name} takes one argument, <${argName}> (got ${args.length})`, USAGE_EXIT)
    return await read(args[0]!)
  }
}

/**
 * Every ended line of persona `key`'s tmux-unresponsive condition: the
 * package's `tmuxUnresponsiveEndedLine(key, reason)` for each reason its
 * `TMUX_UNRESPONSIVE_END_TEXT` names, in that order, joined by newlines.
 */
async function tmuxUnresponsiveEndedLines(key: string): Promise<string> {
  const build = await exportOf('persona-episodes.ts', 'tmuxUnresponsiveEndedLine')
  const texts = await exportOf('persona-episodes.ts', 'TMUX_UNRESPONSIVE_END_TEXT')
  if (typeof build !== 'function') throw new PrinterFailure("the installed package's src/persona-episodes.ts tmuxUnresponsiveEndedLine is not a function", PRINTER_FAIL_EXIT)
  if (typeof texts !== 'object' || texts === null) {
    throw new PrinterFailure("the installed package's src/persona-episodes.ts TMUX_UNRESPONSIVE_END_TEXT is not an object", PRINTER_FAIL_EXIT)
  }
  const reasons = Object.keys(texts)
  if (reasons.length === 0) throw new PrinterFailure("the installed package's src/persona-episodes.ts TMUX_UNRESPONSIVE_END_TEXT names no end reason", PRINTER_FAIL_EXIT)
  const lines = reasons.map((reason) => {
    const line: unknown = (build as (key: string, reason: unknown) => unknown)(key, reason)
    if (typeof line !== 'string' || line.includes('\n')) {
      throw new PrinterFailure(`the installed package's src/persona-episodes.ts tmuxUnresponsiveEndedLine gave no one-line text for reason ${reason}`, PRINTER_FAIL_EXIT)
    }
    return line
  })
  return lines.join('\n')
}


/** An agent-director error name: `Err`, then letters and digits. */
const ERROR_NAME_RE = /^Err[A-Za-z0-9]+$/

/** The description the notice is built with; cut off with all that follows it. */
const DESCRIPTION_MARK = 'fmk texts description mark'

/**
 * The spawn-failure notice's head for an error named `errorName`: the
 * package's `spawnFailureNoticeText` for an `AgentDirectorError` of that name
 * whose description is {@link DESCRIPTION_MARK}, up to where the mark begins.
 */
async function spawnFailureNoticeHead(errorName: string): Promise<string> {
  if (!ERROR_NAME_RE.test(errorName)) {
    throw new PrinterFailure(`spawnFailureNoticeHead: '${errorName}' is not an agent-director error name (Err, then letters and digits)`, USAGE_EXIT)
  }
  const build = await exportOf('session-manager.ts', 'spawnFailureNoticeText')
  const errorClass = await exportOf('agent-director-errors.ts', 'AgentDirectorError')
  if (typeof build !== 'function') throw new PrinterFailure("the installed package's src/session-manager.ts spawnFailureNoticeText is not a function", PRINTER_FAIL_EXIT)
  if (typeof errorClass !== 'function') throw new PrinterFailure("the installed package's src/agent-director-errors.ts AgentDirectorError is not a class", PRINTER_FAIL_EXIT)
  const error: unknown = new (errorClass as new (verb: string, name: string, description: string) => unknown)('spawn', errorName, DESCRIPTION_MARK)
  const text: unknown = (build as (error: unknown) => unknown)(error)
  const at = typeof text === 'string' ? text.indexOf(DESCRIPTION_MARK) : -1
  if (typeof text !== 'string' || at <= 0) {
    throw new PrinterFailure("the installed package's src/session-manager.ts spawnFailureNoticeText gave no text holding the error's description", PRINTER_FAIL_EXIT)
  }
  return text.slice(0, at)
}

/** An entry that takes exactly the arguments `argNames` names, in its usage error, and prints `read(args)`. */
function exactArguments(name: string, argNames: readonly string[], read: (args: readonly string[]) => Promise<string>): FnEntry {
  return async (args) => {
    if (args.length !== argNames.length) {
      throw new PrinterFailure(`${name} takes ${argNames.map((a) => `<${a}>`).join(' ')} (got ${args.length} argument(s))`, USAGE_EXIT)
    }
    return await read(args)
  }
}

/** Export `name` of `relPath`, which must be a function. */
async function functionExport(relPath: string, name: string): Promise<(...args: unknown[]) => unknown> {
  const value = await exportOf(relPath, name)
  if (typeof value !== 'function') throw new PrinterFailure(`the installed package's src/${relPath} ${name} is not a function`, PRINTER_FAIL_EXIT)
  return value as (...args: unknown[]) => unknown
}

/** A persona key as lib/scenario.sh `persona_key` makes it: lower-case letters, digits and `_`. */
const KEY_RE = /^[a-z0-9_]+$/

/** Fails with a usage error unless `key` is a persona key. */
function checkKey(entry: string, key: string): void {
  if (!KEY_RE.test(key)) throw new PrinterFailure(`${entry}: '${key}' is not a persona key (lower-case letters, digits and _)`, USAGE_EXIT)
}

/** Fails with a usage error when `arg` is empty or holds a newline. */
function checkOneLine(entry: string, argName: string, arg: string): void {
  if (arg === '' || arg.includes('\n')) throw new PrinterFailure(`${entry}: <${argName}> is empty or holds a newline`, USAGE_EXIT)
}

/** The marker a builder's variable part is given; the text is cut where it begins. */
const VALUE_MARK = 'fmk-texts-value-mark'

/** A second marker, for a builder with two variable parts. */
const SECOND_MARK = 'fmk-texts-second-mark'

/** The retry number the retry line is built with; the line is split where it stands. */
const RETRY_MARK = 987654321

/**
 * `text`, the result of the package's `builder`, up to where `mark` begins.
 * The mark must stand once, after at least one character, in a one-line text.
 */
function cutAtMark(builder: string, text: unknown, mark: string): string {
  if (typeof text !== 'string' || text.includes('\n')) {
    throw new PrinterFailure(`the installed package's ${builder} gave no one-line text`, PRINTER_FAIL_EXIT)
  }
  const at = text.indexOf(mark)
  if (at <= 0 || text.indexOf(mark, at + 1) !== -1) {
    throw new PrinterFailure(`the installed package's ${builder} gave a text that does not hold its variable part once, after a head`, PRINTER_FAIL_EXIT)
  }
  return text.slice(0, at)
}

/** The longest text every one of `texts` starts with. */
function commonHead(texts: readonly string[]): string {
  let head = texts[0] ?? ''
  for (const text of texts.slice(1)) {
    let n = 0
    while (n < head.length && n < text.length && head[n] === text[n]) n++
    head = head.slice(0, n)
  }
  return head
}

/** Fails unless `head`, the common head of `builder`'s forms for persona `key`, holds `persona=<key> ` (the key whole). */
function checkKeyHead(builder: string, head: string, key: string): string {
  if (!head.includes(`persona=${key} `)) {
    throw new PrinterFailure(`the installed package's ${builder} forms share no head naming persona=${key}`, PRINTER_FAIL_EXIT)
  }
  return head
}

/**
 * The head every line of persona `key`'s retry timer starts with: the
 * longest text the package's arm, retry, re-armed and stop lines for `key`
 * (src/unavailable-retry.ts `unavailableRetryArmedLine`,
 * `unavailableRetryRetryLine`, `unavailableRetryReArmedLine` and
 * `unavailableRetryStoppedLine`) all start with.
 */
async function unavailableRetryLineHead(key: string): Promise<string> {
  checkKey('unavailableRetryLineHead', key)
  const armed = await functionExport('unavailable-retry.ts', 'unavailableRetryArmedLine')
  const retry = await functionExport('unavailable-retry.ts', 'unavailableRetryRetryLine')
  const reArmed = await functionExport('unavailable-retry.ts', 'unavailableRetryReArmedLine')
  const stopped = await functionExport('unavailable-retry.ts', 'unavailableRetryStoppedLine')
  const builder = 'src/unavailable-retry.ts unavailableRetryArmedLine, unavailableRetryRetryLine, unavailableRetryReArmedLine and unavailableRetryStoppedLine'
  const retryMark = String(RETRY_MARK)
  const heads = [
    cutAtMark(builder, armed(key, false, VALUE_MARK, 1000), VALUE_MARK),
    cutAtMark(builder, retry(key, RETRY_MARK, false), retryMark),
    cutAtMark(builder, reArmed(key, RETRY_MARK, false, VALUE_MARK, undefined, 1000), retryMark),
    cutAtMark(builder, stopped(key, false, undefined, VALUE_MARK), VALUE_MARK),
  ]
  return checkKeyHead(builder, commonHead(heads), key)
}

/**
 * The head of persona `key`'s arm line in either mode: the longest text the
 * package's `unavailableRetryArmedLine` for `key`, in full and in
 * pending-only mode, starts with, each cut where its description begins.
 */
async function unavailableRetryArmedHead(key: string): Promise<string> {
  checkKey('unavailableRetryArmedHead', key)
  const build = await functionExport('unavailable-retry.ts', 'unavailableRetryArmedLine')
  const builder = 'src/unavailable-retry.ts unavailableRetryArmedLine'
  const forms = [false, true].map((pendingOnly) => cutAtMark(builder, build(key, pendingOnly, VALUE_MARK, 1000), VALUE_MARK))
  return checkKeyHead(builder, commonHead(forms), key)
}

/**
 * The head of persona `key`'s stop line in either form: the longest text the
 * package's `unavailableRetryStoppedLine` for `key`, with no mode named and
 * with the pending-only mode and a row read named, starts with, each cut
 * where its reason begins.
 */
async function unavailableRetryStoppedHead(key: string): Promise<string> {
  checkKey('unavailableRetryStoppedHead', key)
  const build = await functionExport('unavailable-retry.ts', 'unavailableRetryStoppedLine')
  const builder = 'src/unavailable-retry.ts unavailableRetryStoppedLine'
  const forms = [
    cutAtMark(builder, build(key, false, undefined, VALUE_MARK), VALUE_MARK),
    cutAtMark(builder, build(key, true, SECOND_MARK, VALUE_MARK), VALUE_MARK),
  ]
  return checkKeyHead(builder, commonHead(forms), key)
}

/**
 * The head of persona `key`'s not-armed line (an arm refused once the
 * controller is closed, the server's shutdown): the package's
 * `unavailableRetryNotArmedClosedLine` for `key`, cut where the refused
 * cause begins.
 */
async function unavailableRetryNotArmedHead(key: string): Promise<string> {
  checkKey('unavailableRetryNotArmedHead', key)
  const build = await functionExport('unavailable-retry.ts', 'unavailableRetryNotArmedClosedLine')
  const builder = 'src/unavailable-retry.ts unavailableRetryNotArmedClosedLine'
  return checkKeyHead(builder, cutAtMark(builder, build(key, VALUE_MARK, SECOND_MARK), VALUE_MARK), key)
}

/**
 * Persona `key`'s retry line in its parts, three lines: the head before the
 * retry number, then the text after the number in full mode, then in
 * pending-only mode (the package's `unavailableRetryRetryLine` for `key`,
 * split where the number stands). A retry line is exactly the head, a
 * number and one of the two tails; the re-armed line, which starts the same
 * way, is neither.
 */
async function unavailableRetryRetryLineParts(key: string): Promise<string> {
  checkKey('unavailableRetryRetryLineParts', key)
  const build = await functionExport('unavailable-retry.ts', 'unavailableRetryRetryLine')
  const builder = 'src/unavailable-retry.ts unavailableRetryRetryLine'
  const mark = String(RETRY_MARK)
  const parts = [false, true].map((pendingOnly) => {
    const line = build(key, RETRY_MARK, pendingOnly)
    const head = cutAtMark(builder, line, mark)
    const tail = (line as string).slice(head.length + mark.length)
    if (tail === '') throw new PrinterFailure(`the installed package's ${builder} gave a line that ends at its retry number`, PRINTER_FAIL_EXIT)
    return { head, tail }
  })
  const [full, pendingOnly] = parts as [{ head: string; tail: string }, { head: string; tail: string }]
  if (full.head !== pendingOnly.head) throw new PrinterFailure(`the installed package's ${builder} gave its two modes different heads`, PRINTER_FAIL_EXIT)
  checkKeyHead(builder, full.head, key)
  return [full.head, full.tail, pendingOnly.tail].join('\n')
}

/**
 * The post-UNAVAILABLE get line's fixed parts for persona reference `ref`,
 * two lines: the text before the call's name (`what`), then the text from
 * after it to the outcome's form (the package's `launchUnavailableGetLine`,
 * src/session-manager.ts, built with markers for the two and cut at them).
 */
async function launchUnavailableGetLineParts(ref: string): Promise<string> {
  checkOneLine('launchUnavailableGetLineParts', 'ref', ref)
  const build = await functionExport('session-manager.ts', 'launchUnavailableGetLine')
  const builder = 'src/session-manager.ts launchUnavailableGetLine'
  const line = build(ref, VALUE_MARK, SECOND_MARK, 'pending', undefined, 'outcome')
  const toWhat = cutAtMark(builder, line, VALUE_MARK)
  const toForm = cutAtMark(builder, line, SECOND_MARK)
  const between = toForm.slice(toWhat.length + VALUE_MARK.length)
  if (toForm.length < toWhat.length + VALUE_MARK.length || !between.includes(ref)) {
    throw new PrinterFailure(`the installed package's ${builder} gave no line naming the call, then ${ref}, then the form`, PRINTER_FAIL_EXIT)
  }
  return [toWhat, between].join('\n')
}

/** An ad-error-class.ts launch-timeout form's export name. */
const LAUNCH_TIMEOUT_FORM_NAME_RE = /^LAUNCH_TIMEOUT_FORM_[A-Z_]+$/

/**
 * How the post-UNAVAILABLE get line names the launch's outcome (the
 * package's `launchUnavailableFormText`, src/session-manager.ts): for
 * `<form>` the name of a src/ad-error-class.ts launch-timeout form export
 * (`LAUNCH_TIMEOUT_FORM_…`), that form's text; for `none` (no launch
 * timeout), the UNAVAILABLE text cut where the rendered failure begins.
 */
async function launchUnavailableFormText(form: string): Promise<string> {
  const build = await functionExport('session-manager.ts', 'launchUnavailableFormText')
  const builder = 'src/session-manager.ts launchUnavailableFormText'
  if (form === 'none') return cutAtMark(builder, build(undefined, VALUE_MARK), VALUE_MARK)
  if (!LAUNCH_TIMEOUT_FORM_NAME_RE.test(form)) {
    throw new PrinterFailure(`launchUnavailableFormText: '${form}' is neither none nor a LAUNCH_TIMEOUT_FORM_ export name`, USAGE_EXIT)
  }
  const value = await stringExport('ad-error-class.ts', form)
  const text = build(value, VALUE_MARK)
  if (typeof text !== 'string' || text === '' || text.includes('\n') || text.includes(VALUE_MARK) || !text.includes(value)) {
    throw new PrinterFailure(`the installed package's ${builder} gave no one-line text naming the form ${value}`, PRINTER_FAIL_EXIT)
  }
  return text
}

/**
 * The head of persona `key`'s tmux-unresponsive lines: the package's
 * `tmuxUnresponsiveLine` (src/persona-episodes.ts) for `key`, cut where its
 * text begins.
 */
async function tmuxUnresponsiveLineHead(key: string): Promise<string> {
  checkKey('tmuxUnresponsiveLineHead', key)
  const build = await functionExport('persona-episodes.ts', 'tmuxUnresponsiveLine')
  const builder = 'src/persona-episodes.ts tmuxUnresponsiveLine'
  return checkKeyHead(builder, cutAtMark(builder, build(key, VALUE_MARK), VALUE_MARK), key)
}

/**
 * The approver's line when shutdown stops it for persona reference `ref`:
 * the package's `approverLogLine(approverStopRequestedMessage(ref,
 * APPROVER_STOP_SHUTDOWN))` (src/session-manager.ts), the line
 * `stopAllDialogApprovers` logs.
 */
async function approverShutdownStopLine(ref: string): Promise<string> {
  checkOneLine('approverShutdownStopLine', 'ref', ref)
  const logLine = await functionExport('session-manager.ts', 'approverLogLine')
  const message = await functionExport('session-manager.ts', 'approverStopRequestedMessage')
  const reason = await stringExport('session-manager.ts', 'APPROVER_STOP_SHUTDOWN')
  const line = logLine(message(ref, reason))
  if (typeof line !== 'string' || line.includes('\n') || !line.includes(ref) || !line.includes(reason)) {
    throw new PrinterFailure("the installed package's src/session-manager.ts approverStopRequestedMessage gave no one-line text naming the reference and the shutdown reason", PRINTER_FAIL_EXIT)
  }
  return line
}

/** A builder's output, which must be a string. */
function builtText(relPath: string, name: string, value: unknown): string {
  if (typeof value !== 'string') throw new PrinterFailure(`the installed package's src/${relPath} ${name} gave no text`, PRINTER_FAIL_EXIT)
  return value
}

/** `arg`, named `argName` in `entry`'s usage error, as a whole number of milliseconds. */
function wholeMsArgument(entry: string, argName: string, arg: string): number {
  if (!/^[0-9]+$/.test(arg)) throw new PrinterFailure(`${entry}: <${argName}> '${arg}' is not a whole number of milliseconds`, USAGE_EXIT)
  return Number(arg)
}

/** `arg`, named `argName` in `entry`'s usage error, as `true` or `false`. */
function booleanArgument(entry: string, argName: string, arg: string): boolean {
  if (arg !== 'true' && arg !== 'false') throw new PrinterFailure(`${entry}: <${argName}> '${arg}' is not true or false`, USAGE_EXIT)
  return arg === 'true'
}

/** `arg`, named `argName` in `entry`'s usage error, which must be one of the string exports `names` of `relPath`. */
async function oneOfExports(entry: string, argName: string, arg: string, relPath: string, names: readonly string[]): Promise<string> {
  const values = await Promise.all(names.map((n) => stringExport(relPath, n)))
  if (!values.includes(arg)) throw new PrinterFailure(`${entry}: <${argName}> '${arg}' is none of ${values.join(', ')}`, USAGE_EXIT)
  return arg
}

/** The posted text of a notice for the persona `name` with key `key`: the persona notifier's `formatPersonaNotice` over `text`. */
async function formattedPersonaNotice(name: string, key: string, text: string): Promise<string> {
  const format = await functionExport('persona-notifier.ts', 'formatPersonaNotice')
  return builtText('persona-notifier.ts', 'formatPersonaNotice', format({ name, key }, text))
}

/** The approver's one line at B measured from the launch start, for `ref` and B `boundMs`. */
async function approverBoundLine(ref: string, boundMs: number): Promise<string> {
  const lineOf = await functionExport('session-manager.ts', 'approverLogLine')
  const messageOf = await functionExport('session-manager.ts', 'approverBoundMessage')
  const from = await stringExport('session-manager.ts', 'APPROVER_BOUND_FROM_LAUNCH_START')
  const message = builtText('session-manager.ts', 'approverBoundMessage', messageOf(ref, boundMs, from))
  return builtText('session-manager.ts', 'approverLogLine', lineOf(message))
}

/** The line of the rule's run at the approver's stop at B that answered the relaunch with the sequence started, for `ref`. */
async function pendingRowRuleApproverStopRelaunchLine(ref: string): Promise<string> {
  const lineOf = await functionExport('session-manager.ts', 'pendingRowRuleApproverStopLine')
  const bound = await stringExport('session-manager.ts', 'APPROVER_STOP_BOUND')
  const relaunch = await stringExport('pending-row.ts', 'PENDING_ROW_RULE_RELAUNCH')
  const started = await stringExport('pending-row.ts', 'PENDING_ROW_RELAUNCH_SEQUENCE_STARTED')
  return builtText('session-manager.ts', 'pendingRowRuleApproverStopLine', lineOf(ref, bound, { kind: relaunch, answer: { kind: started } }))
}

/** The relaunching post for the persona `name` with key `key`, with B `boundMs`. */
async function stuckLaunchRelaunchingPost(name: string, key: string, boundMs: number): Promise<string> {
  const textOf = await functionExport('pending-row.ts', 'stuckLaunchRelaunchingText')
  return await formattedPersonaNotice(name, key, builtText('pending-row.ts', 'stuckLaunchRelaunchingText', textOf(key, boundMs)))
}

/** The held post for the persona `name` with key `key`, its launch start `launchStart` and `metNotInteractive`. */
async function stuckLaunchHeldPost(name: string, key: string, launchStart: string, metNotInteractive: boolean): Promise<string> {
  const textOf = await functionExport('pending-row.ts', 'stuckLaunchHeldText')
  return await formattedPersonaNotice(name, key, builtText('pending-row.ts', 'stuckLaunchHeldText', textOf(key, launchStart, metNotInteractive)))
}

/** What follows the description in the abort kill's line; cut off with all after it. */
const FOLLOWS_MARK = 'fmk texts follows mark'

/** The abort kill's line for a success with `kill_sent` true for persona `key`, up to where what follows begins. */
async function stuckLaunchAbortKillSucceededHead(key: string): Promise<string> {
  const lineOf = await functionExport('pending-row.ts', 'stuckLaunchAbortKillLine')
  const describe = await functionExport('checked-kill.ts', 'describeKillOutcome')
  const succeeded = await stringExport('pending-row.ts', 'STUCK_LAUNCH_ABORT_KILL_SUCCEEDED')
  const killed = await stringExport('checked-kill.ts', 'KILL_OUTCOME_KILLED')
  const description = builtText('checked-kill.ts', 'describeKillOutcome', describe({ kind: killed, killSent: true }))
  const line = builtText('pending-row.ts', 'stuckLaunchAbortKillLine', lineOf(key, { kind: succeeded, killSent: true, description }, FOLLOWS_MARK))
  const at = line.indexOf(FOLLOWS_MARK)
  if (at <= 0) throw new PrinterFailure("the installed package's src/pending-row.ts stuckLaunchAbortKillLine gave no line holding what follows", PRINTER_FAIL_EXIT)
  return line.slice(0, at)
}

/** Every step-3 run line of the live-row sequence for `ref` that marked the row `missing`, one per run number, joined by newlines. */
async function liveRowSequenceStep3MarkedMissingLines(ref: string): Promise<string> {
  const lineOf = await functionExport('live-row-sequence.ts', 'liveRowSequenceRunLine')
  const runs = Number(await wholeNumberAt('live-row-sequence.ts', 'LIVE_ROW_SEQUENCE_STEP3_RUNS', []))
  const marked = await stringExport('live-row-sequence.ts', 'LIVE_ROW_RUN_MARKED_MISSING')
  const lines: string[] = []
  for (let run = 1; run <= runs; run++) lines.push(builtText('live-row-sequence.ts', 'liveRowSequenceRunLine', lineOf(ref, 3, run, marked)))
  if (lines.length === 0) throw new PrinterFailure("the installed package's src/live-row-sequence.ts LIVE_ROW_SEQUENCE_STEP3_RUNS names no run", PRINTER_FAIL_EXIT)
  return lines.join('\n')
}

/** Every line the held text's poster logs for persona `key` with the answer `posted`: both forms of the text, each unmuted and muted, joined by newlines. */
async function stuckLaunchHeldPostedLines(key: string): Promise<string> {
  const lineOf = await functionExport('pending-row.ts', 'stuckLaunchPostLine')
  const held = await stringExport('pending-row.ts', 'STUCK_LAUNCH_MARK_HELD')
  const posted = await stringExport('pending-row.ts', 'STUCK_LAUNCH_POSTED')
  const lines: string[] = []
  for (const metNotInteractive of [false, true]) {
    for (const muted of [false, true]) {
      const line = builtText('pending-row.ts', 'stuckLaunchPostLine', lineOf(key, held, posted, { metNotInteractive, muted }))
      if (line.includes('\n')) throw new PrinterFailure("the installed package's src/pending-row.ts stuckLaunchPostLine gave a line holding a newline", PRINTER_FAIL_EXIT)
      lines.push(line)
    }
  }
  if (new Set(lines).size !== lines.length) {
    throw new PrinterFailure("the installed package's src/pending-row.ts stuckLaunchPostLine gave the same line for two forms of the held text", PRINTER_FAIL_EXIT)
  }
  return lines.join('\n')
}

/** A launch start the round line's head is cut at: 2000-01-01T00:00:00.000Z, in epoch milliseconds. */
const LAUNCH_START_MARK_MS = 946_684_800_000

/** The head of the pending-row rule's round lines for `ref` from `origin`, up to where the launch start's rendering begins. */
async function pendingRowRuleRoundLineHead(ref: string, origin: string): Promise<string> {
  const o = await oneOfExports('pendingRowRuleRoundLineHead', 'origin', origin, 'pending-row.ts', [
    'PENDING_ROW_RULE_ORIGIN_RETRY',
    'PENDING_ROW_RULE_ORIGIN_APPROVER_STOP',
  ])
  const lineOf = await functionExport('pending-row.ts', 'pendingRowRuleRoundLine')
  const render = await functionExport('pending-row.ts', 'describeLaunchStartForLog')
  const rendered = builtText('pending-row.ts', 'describeLaunchStartForLog', render(LAUNCH_START_MARK_MS))
  if (!rendered.startsWith('2000-01-01T')) {
    throw new PrinterFailure(`the installed package's src/pending-row.ts describeLaunchStartForLog rendered ${LAUNCH_START_MARK_MS} as '${rendered}'`, PRINTER_FAIL_EXIT)
  }
  const line = builtText('pending-row.ts', 'pendingRowRuleRoundLine', lineOf(ref, o, LAUNCH_START_MARK_MS, [STEP_MARK], FOLLOWS_MARK))
  return cutAt(line, rendered, 'src/pending-row.ts pendingRowRuleRoundLine')
}

/** Where the case begins in a built line; cut off with all that follows it. */
const CASE_MARK = 'fmk-texts-case-mark'

/** Where the step begins in a built line; cut off with all that follows it. */
const STEP_MARK = 'fmk-texts-step-mark'

/** `line` up to where `mark` begins, which must be inside it; `what` names the builder in the failure. */
function cutAt(line: string, mark: string, what: string): string {
  const at = line.indexOf(mark)
  if (at <= 0) throw new PrinterFailure(`the installed package's ${what} gave no line holding the cut mark`, PRINTER_FAIL_EXIT)
  return line.slice(0, at)
}

/** The abort kill's line for a CONFLICT (`ErrTmuxSessionConflict`) that latched persona `key`, up to where agent-director's description begins. */
async function stuckLaunchAbortKillConflictHead(key: string): Promise<string> {
  const lineOf = await functionExport('pending-row.ts', 'stuckLaunchAbortKillLine')
  const describe = await functionExport('checked-kill.ts', 'describeKillOutcome')
  const outcomeOf = await functionExport('checked-kill.ts', 'killOutcomeOf')
  const latched = await stringExport('pending-row.ts', 'STUCK_LAUNCH_ABORT_KILL_LATCHED')
  const conflictClass = await exportOf('agent-director-errors.ts', 'ErrTmuxSessionConflict')
  if (typeof conflictClass !== 'function') {
    throw new PrinterFailure("the installed package's src/agent-director-errors.ts ErrTmuxSessionConflict is not a class", PRINTER_FAIL_EXIT)
  }
  const ctor = conflictClass as new (verb: string, name: string, description: string) => unknown
  const error: unknown = new ctor('kill', conflictClass.name, DESCRIPTION_MARK)
  const description = builtText('checked-kill.ts', 'describeKillOutcome', describe(outcomeOf({ thrown: error })))
  const line = builtText('pending-row.ts', 'stuckLaunchAbortKillLine', lineOf(key, { kind: latched, description }, FOLLOWS_MARK))
  return cutAt(line, DESCRIPTION_MARK, 'src/pending-row.ts stuckLaunchAbortKillLine over src/checked-kill.ts describeKillOutcome')
}

/** The head of persona `key`'s latch-set lines of the kind `outcome` (a new latch or a relatch), up to and including `case=`. */
async function conflictLatchSetLineHead(key: string, outcome: string): Promise<string> {
  const lineOf = await functionExport('conflict-latch.ts', 'conflictLatchSetLine')
  const relatched = await stringExport('conflict-latch.ts', 'CONFLICT_LATCH_SET_RELATCHED')
  const noRow = await exportOf('conflict-latch.ts', 'LATCH_ROW_STATE_NO_ROW')
  const record = { sessionName: CASE_MARK, latchCase: CASE_MARK, refusedOperation: CASE_MARK, rowState: noRow }
  const line = builtText('conflict-latch.ts', 'conflictLatchSetLine', outcome === relatched ? lineOf(key, record, CASE_MARK) : lineOf(key, record))
  return cutAt(line, CASE_MARK, 'src/conflict-latch.ts conflictLatchSetLine')
}

/**
 * The latch record the abort kill's CONFLICT sets for persona `key` and
 * agent-director's `description`, as src/conflict-latch.ts builds it from a
 * thrown CONFLICT: the case the package recognises in the description, which
 * must be "not this launch's session"; the session `conflictSessionName`
 * gives, rendered; the refused operation "P's next check or recovery"; the
 * row state `pending`; the description rendered.
 */
async function notThisLaunchKillLatchRecord(entry: string, key: string, description: string): Promise<Record<string, unknown>> {
  const phrase = await stringExport('ad-description-phrases.ts', 'CONFLICT_NOT_THIS_LAUNCH_PHRASE')
  if (!description.includes(phrase)) throw new PrinterFailure(`${entry}: <description> '${description}' does not carry '${phrase}'`, USAGE_EXIT)
  const recognise = await functionExport('conflict-latch.ts', 'recogniseConflictCase')
  const notThisLaunch = await stringExport('conflict-latch.ts', 'LATCH_CASE_NOT_THIS_LAUNCH')
  const recognised = recognise(description)
  if (recognised !== notThisLaunch) {
    throw new PrinterFailure(`${entry}: the installed package's src/conflict-latch.ts recogniseConflictCase reads the description as ${String(recognised)}, not ${notThisLaunch}`, PRINTER_FAIL_EXIT)
  }
  const sessionOf = await functionExport('conflict-latch.ts', 'conflictSessionName')
  const render = await functionExport('persona-connection-errors.ts', 'renderLogMessageText')
  const rowStateOf = await functionExport('conflict-latch.ts', 'latchRowStateRead')
  const refused = await stringExport('conflict-latch.ts', 'REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY')
  const pending = await stringExport('liveness-reading.ts', 'AGENT_DIRECTOR_PENDING_STATE')
  const sessionName = builtText('persona-connection-errors.ts', 'renderLogMessageText', render(builtText('conflict-latch.ts', 'conflictSessionName', sessionOf(description, key))))
  const rendered = builtText('persona-connection-errors.ts', 'renderLogMessageText', render(description))
  return {
    sessionName,
    latchCase: notThisLaunch,
    refusedOperation: refused,
    rowState: rowStateOf(pending),
    ...(rendered === '' ? {} : { description: rendered }),
  }
}

/** The latch-set line of the abort kill's "not this launch's session" CONFLICT for persona `key`. */
async function conflictNotThisLaunchLatchedLine(key: string, description: string): Promise<string> {
  const lineOf = await functionExport('conflict-latch.ts', 'conflictLatchSetLine')
  const record = await notThisLaunchKillLatchRecord('conflictNotThisLaunchLatchedLine', key, description)
  return builtText('conflict-latch.ts', 'conflictLatchSetLine', lineOf(key, record))
}

/** The CONFLICT post of that latch for the persona `name` with key `key`. */
async function conflictNotThisLaunchPost(name: string, key: string, description: string): Promise<string> {
  const textOf = await functionExport('conflict-latch.ts', 'conflictNoticeText')
  const record = await notThisLaunchKillLatchRecord('conflictNotThisLaunchPost', key, description)
  const text = builtText('conflict-latch.ts', 'conflictNoticeText', textOf({ sessionName: record['sessionName'], latchCase: record['latchCase'], description: record['description'] }))
  return await formattedPersonaNotice(name, key, text)
}

/** The head of a "not this launch's session" latch's re-check round lines for `ref`, up to and including `step=`. */
async function latchRecheckNotThisLaunchRoundHead(ref: string): Promise<string> {
  const lineOf = await functionExport('conflict-latch.ts', 'latchRecheckRoundLine')
  const notThisLaunch = await stringExport('conflict-latch.ts', 'LATCH_CASE_NOT_THIS_LAUNCH')
  const line = builtText('conflict-latch.ts', 'latchRecheckRoundLine', lineOf(ref, notThisLaunch, STEP_MARK, STEP_MARK, STEP_MARK))
  return cutAt(line, STEP_MARK, 'src/conflict-latch.ts latchRecheckRoundLine')
}

/** The launch verbs a `pre_trust` line names, by their exports in src/session-manager.ts. */
const LAUNCH_VERB_EXPORTS = ['LAUNCH_VERB_SPAWN', 'LAUNCH_VERB_RESUME', 'LAUNCH_VERB_REUSE_SPAWN'] as const

/** `preTrustLogLine(ref, verb, value)` (a present value is built as VALUE_MARK, and the line cut off there with all that follows it), `value` undefined for a result with no `pre_trust` field; `entry` names the entry in a usage error. */
async function preTrustLogLine(entry: string, ref: string, verb: string, value: string | undefined): Promise<string> {
  const lineOf = await functionExport('session-manager.ts', 'preTrustLogLine')
  const v = await oneOfExports(entry, 'verb', verb, 'session-manager.ts', LAUNCH_VERB_EXPORTS)
  return builtText('session-manager.ts', 'preTrustLogLine', lineOf(ref, v, value))
}

/** The labels a spawn of persona `key` with no claude_config_dir carries under `home`, one per line. */
async function personaDefaultConfigDirLabels(key: string, home: string): Promise<string> {
  const service = await stringExport('persona-identity.ts', 'SERVICE_LABEL')
  const personaPrefix = await stringExport('persona-identity.ts', 'PERSONA_LABEL_PREFIX')
  const configDirPrefix = await stringExport('persona-identity.ts', 'CONFIG_DIR_LABEL_PREFIX')
  const labelOf = await functionExport('session-manager.ts', 'personaConfigDirLabelValue')
  const label = builtText('session-manager.ts', 'personaConfigDirLabelValue', labelOf(undefined, home))
  return [service, `${personaPrefix}${key}`, `${configDirPrefix}${label}`].join('\n')
}

/** The one-function entries, by the name a script passes. */
const FN_ENTRIES: Readonly<Record<string, FnEntry>> = {
  APPROVER_LOG_PREFIX: noArguments('APPROVER_LOG_PREFIX', () => stringExport('session-manager.ts', 'APPROVER_LOG_PREFIX')),
  DEV_CHANNELS_DIALOG_NEEDLE: noArguments('DEV_CHANNELS_DIALOG_NEEDLE', () => stringExport('session-manager.ts', 'DEV_CHANNELS_DIALOG_NEEDLE')),
  TRUST_DIALOG_NEEDLE: noArguments('TRUST_DIALOG_NEEDLE', () => stringExport('session-manager.ts', 'TRUST_DIALOG_NEEDLE')),
  DIALOG_POLL_INTERVAL_MS: noArguments('DIALOG_POLL_INTERVAL_MS', () => wholeNumberAt('session-manager.ts', 'DIALOG_POLL_INTERVAL_MS', [])),
  'DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds': noArguments('DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds', () =>
    wholeNumberAt('ad-settings.ts', 'DEFAULT_AD_SETTINGS', ['tmux', 'pending_grace_seconds']),
  ),
  'DEFAULT_AD_SETTINGS.tmux.create_timeout_ms': noArguments('DEFAULT_AD_SETTINGS.tmux.create_timeout_ms', () =>
    wholeNumberAt('ad-settings.ts', 'DEFAULT_AD_SETTINGS', ['tmux', 'create_timeout_ms']),
  ),
  'DEFAULT_AD_SETTINGS.tmux.stopping_window_seconds': noArguments('DEFAULT_AD_SETTINGS.tmux.stopping_window_seconds', () =>
    wholeNumberAt('ad-settings.ts', 'DEFAULT_AD_SETTINGS', ['tmux', 'stopping_window_seconds']),
  ),
  LAUNCH_TIMEOUT_PHRASE: noArguments('LAUNCH_TIMEOUT_PHRASE', () => stringExport('ad-description-phrases.ts', 'LAUNCH_TIMEOUT_PHRASE')),
  LAUNCH_UNAVAILABLE_OUTCOME_APPROVER: noArguments('LAUNCH_UNAVAILABLE_OUTCOME_APPROVER', () =>
    stringExport('session-manager.ts', 'LAUNCH_UNAVAILABLE_OUTCOME_APPROVER'),
  ),
  LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT: noArguments('LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT', () =>
    stringExport('ad-error-class.ts', 'LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT'),
  ),
  PENDING_ROW_RULE_LOG_HEAD: noArguments('PENDING_ROW_RULE_LOG_HEAD', () => stringExport('pending-row.ts', 'PENDING_ROW_RULE_LOG_HEAD')),
  PENDING_ROW_RUN_MARKED_MISSING: noArguments('PENDING_ROW_RUN_MARKED_MISSING', () =>
    stringExport('pending-row.ts', 'PENDING_ROW_RUN_MARKED_MISSING'),
  ),
  tmuxUnresponsiveEndedLines: oneArgument('tmuxUnresponsiveEndedLines', 'key', tmuxUnresponsiveEndedLines),
  spawnFailureNoticeHead: oneArgument('spawnFailureNoticeHead', 'error-name', spawnFailureNoticeHead),
  unavailableRetryLineHead: oneArgument('unavailableRetryLineHead', 'key', unavailableRetryLineHead),
  unavailableRetryArmedHead: oneArgument('unavailableRetryArmedHead', 'key', unavailableRetryArmedHead),
  unavailableRetryStoppedHead: oneArgument('unavailableRetryStoppedHead', 'key', unavailableRetryStoppedHead),
  unavailableRetryNotArmedHead: oneArgument('unavailableRetryNotArmedHead', 'key', unavailableRetryNotArmedHead),
  unavailableRetryRetryLineParts: oneArgument('unavailableRetryRetryLineParts', 'key', unavailableRetryRetryLineParts),
  launchUnavailableGetLineParts: oneArgument('launchUnavailableGetLineParts', 'ref', launchUnavailableGetLineParts),
  launchUnavailableFormText: oneArgument('launchUnavailableFormText', 'form', launchUnavailableFormText),
  tmuxUnresponsiveLineHead: oneArgument('tmuxUnresponsiveLineHead', 'key', tmuxUnresponsiveLineHead),
  approverShutdownStopLine: oneArgument('approverShutdownStopLine', 'ref', approverShutdownStopLine),
  PENDING_ROW_RUN_NOT_JUDGED: noArguments('PENDING_ROW_RUN_NOT_JUDGED', () => stringExport('pending-row.ts', 'PENDING_ROW_RUN_NOT_JUDGED')),
  PENDING_ROW_RULE_ORIGIN_RETRY: noArguments('PENDING_ROW_RULE_ORIGIN_RETRY', () => stringExport('pending-row.ts', 'PENDING_ROW_RULE_ORIGIN_RETRY')),
  PENDING_ROW_RULE_ORIGIN_APPROVER_STOP: noArguments('PENDING_ROW_RULE_ORIGIN_APPROVER_STOP', () =>
    stringExport('pending-row.ts', 'PENDING_ROW_RULE_ORIGIN_APPROVER_STOP'),
  ),
  'adLaunchBoundMs(DEFAULT_AD_SETTINGS_IN_EFFECT)': noArguments('adLaunchBoundMs(DEFAULT_AD_SETTINGS_IN_EFFECT)', async () => {
    const bound = await functionExport('ad-settings.ts', 'adLaunchBoundMs')
    const value: unknown = bound(await exportOf('ad-settings.ts', 'DEFAULT_AD_SETTINGS_IN_EFFECT'))
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new PrinterFailure("the installed package's src/ad-settings.ts adLaunchBoundMs gave no whole number of milliseconds", PRINTER_FAIL_EXIT)
    }
    return String(value)
  }),
  approverBoundLine: exactArguments('approverBoundLine', ['ref', 'bound-ms'], ([ref, ms]) =>
    approverBoundLine(ref!, wholeMsArgument('approverBoundLine', 'bound-ms', ms!)),
  ),
  pendingRowRuleApproverStopRelaunchLine: oneArgument('pendingRowRuleApproverStopRelaunchLine', 'ref', pendingRowRuleApproverStopRelaunchLine),
  stuckLaunchRelaunchingPost: exactArguments('stuckLaunchRelaunchingPost', ['name', 'key', 'bound-ms'], ([name, key, ms]) =>
    stuckLaunchRelaunchingPost(name!, key!, wholeMsArgument('stuckLaunchRelaunchingPost', 'bound-ms', ms!)),
  ),
  stuckLaunchHeldPost: exactArguments('stuckLaunchHeldPost', ['name', 'key', 'launch-start', 'true|false'], ([name, key, start, met]) =>
    stuckLaunchHeldPost(name!, key!, start!, booleanArgument('stuckLaunchHeldPost', 'true|false', met!)),
  ),
  describeLaunchStartForLog: oneArgument('describeLaunchStartForLog', 'launch-start', async (start) => {
    const render = await functionExport('pending-row.ts', 'describeLaunchStartForLog')
    return builtText('pending-row.ts', 'describeLaunchStartForLog', render(start))
  }),
  stuckLaunchPostLine: exactArguments('stuckLaunchPostLine', ['key', 'mark', 'answer'], async ([key, mark, answer]) => {
    const lineOf = await functionExport('pending-row.ts', 'stuckLaunchPostLine')
    const m = await oneOfExports('stuckLaunchPostLine', 'mark', mark!, 'pending-row.ts', ['STUCK_LAUNCH_MARK_RELAUNCHING', 'STUCK_LAUNCH_MARK_HELD'])
    const a = await oneOfExports('stuckLaunchPostLine', 'answer', answer!, 'pending-row.ts', [
      'STUCK_LAUNCH_POSTED',
      'STUCK_LAUNCH_ALREADY_POSTED',
      'STUCK_LAUNCH_SUPPRESSED',
      'STUCK_LAUNCH_NOT_POSTED_CLOSED',
      'STUCK_LAUNCH_POST_FAILED',
    ])
    return builtText('pending-row.ts', 'stuckLaunchPostLine', lineOf(key, m, a))
  }),
  stuckLaunchAbortKillSucceededHead: oneArgument('stuckLaunchAbortKillSucceededHead', 'key', stuckLaunchAbortKillSucceededHead),
  liveRowSequenceStep3MarkedMissingLines: oneArgument('liveRowSequenceStep3MarkedMissingLines', 'ref', liveRowSequenceStep3MarkedMissingLines),
  stuckLaunchHeldPostedLines: oneArgument('stuckLaunchHeldPostedLines', 'key', stuckLaunchHeldPostedLines),
  pendingRowRuleRoundLineHead: exactArguments('pendingRowRuleRoundLineHead', ['ref', 'origin'], ([ref, origin]) =>
    pendingRowRuleRoundLineHead(ref!, origin!),
  ),
  stuckLaunchAbortKillConflictHead: oneArgument('stuckLaunchAbortKillConflictHead', 'key', stuckLaunchAbortKillConflictHead),
  conflictNotThisLaunchLatchedLine: exactArguments('conflictNotThisLaunchLatchedLine', ['key', 'description'], ([key, description]) =>
    conflictNotThisLaunchLatchedLine(key!, description!),
  ),
  conflictNotThisLaunchPost: exactArguments('conflictNotThisLaunchPost', ['name', 'key', 'description'], ([name, key, description]) =>
    conflictNotThisLaunchPost(name!, key!, description!),
  ),
  latchRecheckNotThisLaunchRoundHead: oneArgument('latchRecheckNotThisLaunchRoundHead', 'ref', latchRecheckNotThisLaunchRoundHead),
  LAUNCH_VERB_SPAWN: noArguments('LAUNCH_VERB_SPAWN', () => stringExport('session-manager.ts', 'LAUNCH_VERB_SPAWN')),
  LAUNCH_VERB_RESUME: noArguments('LAUNCH_VERB_RESUME', () => stringExport('session-manager.ts', 'LAUNCH_VERB_RESUME')),
  LAUNCH_VERB_REUSE_SPAWN: noArguments('LAUNCH_VERB_REUSE_SPAWN', () => stringExport('session-manager.ts', 'LAUNCH_VERB_REUSE_SPAWN')),
  preTrustLogLine: async (args) => {
    if (args.length !== 2 && args.length !== 3) {
      throw new PrinterFailure(`preTrustLogLine takes <ref> <verb> [<value>] (got ${args.length} argument(s))`, USAGE_EXIT)
    }
    return await preTrustLogLine('preTrustLogLine', args[0]!, args[1]!, args[2])
  },
  preTrustLogLineHead: exactArguments('preTrustLogLineHead', ['ref', 'verb'], async ([ref, verb]) =>
    cutAt(await preTrustLogLine('preTrustLogLineHead', ref!, verb!, VALUE_MARK), VALUE_MARK, 'src/session-manager.ts preTrustLogLine'),
  ),
  personaDefaultConfigDirLabels: exactArguments('personaDefaultConfigDirLabels', ['key', 'home'], ([key, home]) =>
    personaDefaultConfigDirLabels(key!, home!),
  ),
}

/** `table`'s one-function entries as entries: each checks its own arguments. */
function fnEntries(table: Readonly<Record<string, FnEntry>>): Record<string, Entry> {
  return Object.fromEntries(Object.entries(table).map(([name, print]) => [name, { synopsis: '[<arg>…]', print: async (args) => await print(args) } satisfies Entry]))
}

/** The printer's entries, by the name a script passes. Later scenarios add entries here. */
const ENTRIES: Readonly<Record<string, Entry>> = joinEntryTables({
  // Scenario 8 (test-20-fmk-old-binary.sh).
  PHASE1_FLOOR_VERSION: constantEntry('ad-version-gate.ts', 'PHASE1_FLOOR_VERSION'),
  AD_BELOW_PHASE1_FLOOR: constantEntry('install-check-labels.ts', 'AD_BELOW_PHASE1_FLOOR'),
  buildBelowPhase1FloorMessage: belowPhase1FloorMessage,
  RUNTIME_RECHECK_PHRASE: constantEntry('ad-version-gate.ts', 'RUNTIME_RECHECK_PHRASE'),
  AD_VERSION_RECHECK_INTERVAL_MS: constantEntry('ad-version-gate.ts', 'AD_VERSION_RECHECK_INTERVAL_MS'),
  AD_VERSION_RECHECK_COULD_NOT_RUN_LOG_PREFIX: constantEntry('ad-version-gate.ts', 'AD_VERSION_RECHECK_COULD_NOT_RUN_LOG_PREFIX'),
  INVALID_FLAGS_HOLD_ALERT_TEXT: constantEntry('invalid-flags-hold.ts', 'INVALID_FLAGS_HOLD_ALERT_TEXT'),
  formatPersonaNotice: personaNotice,
  // The latch scenarios, E42–E43 (test-15 onward).
  ...constantEntries('conflict-latch.ts', LATCH_CONSTANT_NAMES),
  ...constantEntries('ad-description-phrases.ts', CASE_PHRASE_NAMES),
  personaNoticePrefix,
  personaInstanceId,
  conflictNoticeText,
  conflictNoticeFirstLine,
  conflictNoticeListLine,
  conflictCaseSentence,
  unusableNameNoticeText,
  launchStartNotRecordedNoticeText,
  conflictRecoveryText,
  holdRecoveryText,
  conflictLatchSetLine,
  latchClearedLine,
  latchRecheckRoundLine,
  // Scenario 19 (test-16-fmk-conflict.sh).
  personaTmuxSessionName,
  LATCH_ROW_STATE_KIND_NO_ROW: constantEntry('conflict-latch.ts', 'LATCH_ROW_STATE_KIND_NO_ROW'),
  adGraceMs: adSettingsDefaultMs('adGraceMs'),
  adLaunchBoundMs: adSettingsDefaultMs('adLaunchBoundMs'),
  // Scenario 25 (test-27-fmk-unusable-name.sh).
  AD_ERROR_CLASS_UNUSABLE_NAME: constantEntry('ad-error-class.ts', 'AD_ERROR_CLASS_UNUSABLE_NAME'),
  // Scenario 10 (test-22-fmk-wrong-server.sh).
  RECHECK_VERDICT_STILL_LATCHED: constantEntry('conflict-latch.ts', 'RECHECK_VERDICT_STILL_LATCHED'),
  conflictLatchSetLineHead: conflictLatchSetHead,
  PROBE_PANE_READ_LINES: constantEntry('pane-read.ts', 'PROBE_PANE_READ_LINES'),
  PANE_READ_PANE: constantEntry('pane-read.ts', 'PANE_READ_PANE'),
  PANE_READ_GONE: constantEntry('pane-read.ts', 'PANE_READ_GONE'),
  STILL_STOPPING_PHRASE: constantEntry('ad-description-phrases.ts', 'STILL_STOPPING_PHRASE'),
  STILL_STARTING_PHRASE: constantEntry('ad-description-phrases.ts', 'STILL_STARTING_PHRASE'),
  AD_SETTINGS_RELATIVE_PATH: constantEntry('ad-settings.ts', 'AD_SETTINGS_RELATIVE_PATH'),
  AD_TMUX_TABLE: constantEntry('ad-settings.ts', 'AD_TMUX_TABLE'),
  AD_PAUSE_TABLE: constantEntry('ad-settings.ts', 'AD_PAUSE_TABLE'),
  AD_PAUSE_TIMEOUT_KEY: constantEntry('ad-settings.ts', 'AD_PAUSE_TIMEOUT_KEY'),
  AD_SETTING_MINIMUMS: adSettingMinimum,
  MAX_AGENT_DIRECTOR_POLL_INTERVAL_MS: constantEntry('config.ts', 'MAX_AGENT_DIRECTOR_POLL_INTERVAL_MS'),
  sessionEndingCommandsIn: sessionEndingForms,
  // Scenario 26 (test-28-fmk-provenance.sh).
  tmuxServerChangedOnset: builderEntry('outage-state.ts', 'tmuxServerChangedOnset', []),
  ONSET_TEMPLATES: onsetTemplate,
  ALL_CLEAR_TEMPLATE: allClear,
  DIFFERENT_TMUX_SERVER_PHRASE: constantEntry('ad-description-phrases.ts', 'DIFFERENT_TMUX_SERVER_PHRASE'),
  UNAVAILABLE_RETRY_BASE_S: constantEntry('unavailable-retry.ts', 'UNAVAILABLE_RETRY_BASE_S'),
  UNAVAILABLE_RETRY_CEILING_S: constantEntry('unavailable-retry.ts', 'UNAVAILABLE_RETRY_CEILING_S'),
  unavailableRetryDueS: unavailableRetryDue,
  waitingRowPaneGoneLineHead: waitingRowPaneGoneHead,
  escalateDeadSweepLineHead: escalateDeadSweepHead,
  reconnectGoneLineHead: reconnectGoneHead,
  relaunchAfterKillLine: relaunchAfterKill,
  relaunchWithoutKillLine: relaunchWithoutKill,
  latchClearRetryAtOnceLineHead: builderEntry('session-manager.ts', 'latchClearRetryAtOnceLineHead', ['ref']),
  DEFAULT_AD_SETTINGS: adSettingDefault,
  tmuxUnresponsiveOnsetText: builderEntry('persona-episodes.ts', 'tmuxUnresponsiveOnsetText', ['key']),
  tmuxUnresponsiveAlertText: unresponsiveAlert,
  restartCapReachedNoticeText: builderEntry('session-manager.ts', 'restartCapReachedNoticeText', []),
  FULL_PANE_READ_LINES: constantEntry('pane-read.ts', 'FULL_PANE_READ_LINES'),
}, argsEntries(ARGS_ENTRIES), fnEntries(FN_ENTRIES))

/** The value entry `name` prints for `args`; a usage failure for no entry or an unknown one. */
async function entryValue(name: string | undefined, args: readonly string[]): Promise<string> {
  if (name === undefined || name === '') usageFail('no entry was named')
  const entry = Object.hasOwn(ENTRIES, name) ? ENTRIES[name] : undefined
  if (entry === undefined) usageFail(`unknown entry '${name}'`)
  return await entry.print(args, context)
}

const context: EntryContext = {
  async importPackageModule(relPath) {
    return await import(join(PKG_DIR, 'src', relPath))
  },
  entryValue,
}

async function main(argv: readonly string[]): Promise<void> {
  const [name, ...args] = argv
  let value: string
  try {
    value = await entryValue(name, args)
  } catch (err) {
    if (err instanceof PrinterFailure) fail(err.exitCode, `${name}: ${err.message}`)
    fail(PRINTER_FAIL_EXIT, `${name} threw: ${err instanceof Error ? err.message : String(err)}`)
  }
  await Bun.write(Bun.stdout, value)
  process.exit(0)
}

await main(process.argv.slice(2))
