/**
 * fmk-texts.ts — the one value printer of the `/ci` scenarios that match
 * texts `src/` exports: every fmk scenario, and the shared-mode
 * test-29-invited-channels.sh (b.jg5 SRJ-1401, SRJ-1306; b.deo SRI-1401,
 * SRI-1404) and test-50-reaction-notices.sh (b.n3k). A scenario script cannot import TypeScript, and a test never
 * retypes a notice text, class label, version or settings value that `src/`
 * exports. So a script asks this printer for the value, and the printer
 * prints the installed package's own export (the tarball under test): a
 * constant as it is, or a builder's output for the script's arguments.
 *
 * Every fmk scenario uses this one printer, and so do test-29 and test-50. A scenario
 * that needs another value adds a named entry to `ENTRIES` here, and never a
 * second printer.
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
 *       buildSystemInstallTooOldMessage "${OLD_VERSION}" "${BIN_PATH}" runtime)" \
 *       || fail "fmk-texts: buildSystemInstallTooOldMessage"
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
 *   sharedChannelSaved <config> <record> <key> <channel>
 *   sharedThreadSince <config> <record> <key> <channel>
 *       Production authority's saved choice / Thread Hybrid Since (empty if absent).
 *   sharedThreadCreated <config> <record> <key>
 *       Production authority's created marker, true/false. Absent persona fails.
 *   sharedChannelEffective <config> <record> <key> <channel> <eligible|membership-reason>
 *       Production currentChannelDeliveryFacts over saved state and the caller's
 *       independently observed LIVE membership; prints effective choice or reason.
 *       Historical membership on disk is never promoted to current membership.
 *   sharedAttemptOrder <config> <record> <key> [channel]
 *       Validated applied attempts as ordered JSONL, including retired incarnations;
 *       startedOrder/resolvedOrder identify durable applications, never revisions.
 *   acceptedQueueItems <journal-path>
 *       Production-validated full accepted records with via, in seq order. Current
 *       journal only; no reconstruction of compacted history. Missing is empty;
 *       a partial tail waits for the next read, any invalid complete line fails.
 *   sharedQueueSnapshot <current-journal> [prior-snapshot...]
 *       Read-only production-parsed union, full JSONL with trailing newline; conflicts fail.
 *       Retains the earliest observed hold form. Rewritten forms require a covering allocation
 *       in the same observation, exact production hold transformation and consistent retained
 *       resolutions. All other acceptance fields remain exact; no discarded body is rebuilt.
 *   sharedQueueReceipts <key> <server-log> <current-journal> <original-snapshot> [prior-snapshot...]
 *       All-part exact own-session receipt completion and fixed-original progress as JSON;
 *       uses transcript-receipts.ts's pure adapter and installed receipt parser/matcher.
 *       Includes reminder completion; neither new work nor duplicate receipts advance progress.
 *   sharedThreadJoins <memory-file> [channel stamp-json]   production-parsed saved joins, JSONL
 *   sharedOwnPostRecords <memory-file>              production-parsed post-intent/outcome JSONL;
 *       discovery only, never proof of a current unresolved operation. Header/digest key omitted.
 *   sharedOwnPostState <memory-file> <operation-id> <channel> <stamp-json> <unresolved|joined|none>
 *       exact intent and optional later outcome as JSON {intent,outcome}; unresolved requires
 *       no outcome. Missing intent/outcome or an incomplete final line exits 75 (pending);
 *       malformed, duplicate/reordered, mismatched channel/stamp or contrary outcome fails.
 *       Reads at most 64 MiB, requires a header, never loads/repairs a store. Missing/unreadable
 *       files fail. Stamp and operation must be retained independently by the consumer; this
 *       observation does not establish current membership, a Slack result or survive compaction.
 *   sharedQueueJoinsSaved <memory-file> <queue-snapshot>... assertion for every carried join
 *   sharedDedupePreserved <before-snapshot> <current-journal> exact keys/allocation after compaction
 *   sharedPersonaFacts <config> <record> <key> [channel]
 *       Safe saved assignments/leaves/incarnation/marker; disk membership explicitly historical.
 *   sharedMembershipEvent <config> <record> <key> <event-id>
 *       The applied membership effect saved under that event identity ({channel, member,
 *       order, boundary}), or null; historical, never current membership.
 *   sharedRecordedButton <stub-record> <label> <channel> <message-ts> <action-id-or-prefix>
 *       Exact unique button in last successful recorded post/update; prints interactive action.
 *   sharedPostMark <stub-record>              last complete monotonic stub record seq
 *   sharedSuccessfulPost <stub-record> <label> <channel> <after-seq> <text-fragment>...
 *       one confirmed top-level post matching ordered literal fragments; metadata only;
 *       missing match exits 75, ambiguous/invalid evidence fails (no Thread Memory read)
 *   sharedMessagesWaitingPost <stub-record> <label> <channel> <after-seq> <name> <key> <count>
 *       same observer, exact production-formatted restarts-off notice except elapsed age
 *   sharedObservedPostEvent <stub-record> <sender-label> <channel> <post-seq> <user-id> <bot-id>
 *       Socket Mode echo built from that exact successful post's actual text/timestamp;
 *       sender IDs come from the stub's installation control, never a fixed other bot
 *   buildMessagesWaitingNotice <persona-ref> <count> <age-ms> <state>
 *       Prints the installed delivery-notices.ts builder's production notice body.
 *   sharedDeliveryExpectation <key> <name> <slack|cron|interject> <channel-or-sender>
 *       <ts> <sender-id> <via-or-dash>   independently specified expected acceptance, JSONL
 *   sharedAssertAccounting [--per-server-run] <expectations-jsonl> <server-log> (<key> <queue-snapshot>)...
 *       Exact full acceptance and received-diagnostic multisets using production text builders;
 *       compares source, sender and reason, including actual bot posts and injected work.
 *       --per-server-run: the received set stays exact, but an identity may repeat in later
 *       server runs (split on the start's `Loaded persona config` line), at most once per run.
 *   sharedExpectedParts <text> <ts> <user-id> <user-name> <channel> <channel-name> <via>
 *       <root-or-dash> <attachment-json-or-dash> independent production-built tag parts, JSON
 *   sharedAssertContent <key> <server-log> <queue-snapshot> <channel> <ts> <text>
 *       <expected-parts-json> <attachment-json-or-dash> asserts queue content, independent fixed
 *       parts and exact transcript take-in; prints receipt metadata, never content.
 *       These observers require evidence, cap regular files at 64 MiB, at most 32 journals/logs
 *       and 256 transcript paths. They ignore incomplete tails, fail on damaged complete lines,
 *       never call a live store's load/recovery/repair and never establish current membership.
 *   sharedInjectedExpectedParts <text> <retained-ts> <sender>
 *       Independent buildTagParts({user: sender, ts, text}), JSON, with no Slack attributes.
 *   sharedAssertInjectedContent <key> <server-log> <queue-snapshot> <cron|interject>
 *       <sender> <retained-ts> <text> <expected-parts-json> exact original source/sender/time,
 *       full fixed parts and own-session transcript receipts; reminders cannot satisfy it.
 *       Snapshot/logs stay below SCENARIO_ROOT; transcripts must be adapter-owned direct
 *       HOME/.claude/projects/<project>/<session>.jsonl files, without symlink traversal.
 *   sharedCronIdentity <crontable-file> <prompt-path-as-written>
 *       Installed parseCrontable identity of exactly one matching schedule; any parse error
 *       or ambiguous/missing match fails. Does not start a schedule or assert its fire.
 *   sharedRecoveryRequest <request-id> <damaged-file> [replacement-input-file]
 *       Production-validated restore/replace request, binding exact raw damaged/replacement
 *       bytes. No healthy-authority read/fallback. Retain output privately, never log it.
 *   sharedRecoveryPending / sharedRecoveryConsumed <config> <record> <retained-request> <review>
 *       Exact request equality plus durable production-parsed recovery/review evidence;
 *       pending also checks the entire production preview and retained prepared input.
 *       Consumed binds active recovery activation to that fingerprint's consumed order.
 *       JSON metadata only; missing, cancelled, stale or mismatched evidence fails.
 *       Recovery and cron file reads require SCENARIO_ROOT, regular nonsymlink files,
 *       resolved paths under that root and at most 64 MiB. No live store mutation.
 *   RELOAD_STALE_CONFIRMATION                  src/reload-apply.ts constant
 *   RELOAD_RECORD_WRITE_FAILED                 src/reload.ts constant
 *   channelDeliveryAttemptStatusText <name> <key> <channel> <status> [rejection]
 *       registry.ts's pending/unresolved/binding-conflict/invalid/inactive status,
 *       or not-applied plus its production rejection reason; no current-facts suffix.
 *       Applied assignment/retry results use channelDeliveryAttemptResultText below.
 *   deliveryReasonText <dm|mention|broadcast|thread|receive_all_shared|receive_all>
 *       The reason description from the installed MCP_INSTRUCTIONS, including thread.
 *   MCP_INSTRUCTIONS / TAG_DESCRIPTION          complete exported agent instruction texts
 *   REVIEW_OMISSION_CLAUSE / REVIEW_FUTURE_CLAUSE / REVIEW_RESET_CLAUSE /
 *   REVIEW_RETENTION_CLAUSE / REVIEW_ABSENCE_REPLACEMENT / RECOVERY_LOSS /
 *   RECOVERY_RESTORE / RECOVERY_THREADS_FORGOTTEN / RECOVERY_CURRENT_MEMBERSHIP /
 *   RECOVERY_PRESERVATION                       src/reload-preview-clauses.ts constants
 *   SHARED_STATE_UNRESOLVED / MEMBERSHIP_EVIDENCE_UNRESOLVED / SHARED_STATE_RECOVERED /
 *   SHARED_STATE_SLACK_RETRY_WARNING / SHARED_STATE_STAGED_SLACK_RETRY_WARNING /
 *   PERSONA_THREAD_STAMP_UNDECIDED               src/persona-diagnostics.ts constants
 *   buildSharedStateUnresolvedNotice <persona-ref> <scope-json> <cause> <path> [failure]
 *   buildSharedStateUnresolvedLine <key> <scope-json> <cause> <path> [failure]
 *   buildSharedStateRecoveredNotice <persona-ref> <scope-json> <state|evidence|repair>
 *   buildSharedStateRecoveredLine <key> <scope-json> <state|evidence|repair> <path> [failure]
 *   buildReloadApplyFailedNotice <persona-ref> <authority|retired-keys> <path> [failure]
 *       Installed shared-state-reports.ts builders. Scope is SharedStateReportScope:
 *       channels: string[], optional all/dm booleans and repairPending {usable,held}
 *       string arrays. Pass independently retained, production-ordered facts;
 *       no sorting, inferred membership or notice-derived scope. Cause is unsynced,
 *       evidence-changed, restoration-staged, retirement-unresolved or not-saved.
 *       RecoveredLine requires path, matching production. Omit absent failure;
 *       configured refs/paths pass unchanged; production owns failure redaction.
 *   sharedRecoveryLine <status> [detail]        src/reload-recovery.ts builder;
 *       omit detail for its exact diagnostic prefix, including terminal period.
 *   MEMBERSHIP_UNRESOLVED / MEMBERSHIP_STORAGE_FAILED  src/channel-membership.ts constants
 *   MEMBERSHIP_INVENTORY_INCOMPLETE             src/channel-membership-scan.ts constant
 *   membershipDiagnostic <key> <channel> <fault>
 *   reviewRecoveryLine <recovered|unresolved>
 *   threadStampUndecidedCause <channel>         the corresponding production builders
 *   reviewedChannelLine <key> <channel> <kind> <saved|-> <reviewed|->
 *       <eligible|ineligible|unresolved> <current-effective> <reviewed-effective>
 *       [replacement=true|false] [inherited=<delivery>] [previousOrder=<integer>]
 *       [activatesInStrict=true|false] [absenceReplacement=<binding>]
 *       Production preview builder over caller-observed review facts, including
 *       same-value/overwrite clauses; this prints text, never computes a plan.
 *   THREAD_REPLY_HOLD_MS / DELIVERY_MAX_AD_CALLS_PER_S  src/delivery-constants.ts
 *   NAME_LOOKUP_TIMEOUT_MS                      src/tag-wrapper.ts
 *   QUEUE_COMPACT_INTERVAL_MS                   src/delivery-queue.ts
 *   TEST_MEASUREMENTS_KEY                       src/config.ts
 *   TEST_MEASUREMENT_TIMINGS_KEY                src/config.ts
 *   TEST_MEASUREMENTS_FILE_NAME                 src/test-measurements.ts
 *   buildTestMeasurementsStartLine <path>        src/test-measurements.ts builder;
 *       prints the loud test-only start line, preserving the configured path.
 *   THREAD_MEMORY_SEAL_FILE                     src/thread-memory-seal.ts
 *   THREAD_MEMORY_NOT_SAVED / THREAD_MEMORY_UNREADABLE / THREAD_MEMORY_JOINS_LOST /
 *   THREAD_MEMORY_CHANGED_WHILE_STOPPED / THREAD_MEMORY_RECOVERED /
 *   THREAD_MEMORY_QUARANTINED / THREAD_MEMORY_COMPACTION_FAILED /
 *   THREAD_MEMORY_REMOVAL_FAILED / THREAD_MEMORY_SEAL_UNREADABLE /
 *   THREAD_MEMORY_SEAL_NOT_SAVED / THREAD_MEMORY_HOLDS_NOT_RESOLVED
 *                                               src/persona-diagnostics.ts constants
 *   THREAD_MEMORY_SLACK_RETRY_WARNING / THREAD_MEMORY_OWN_POST_LOSS_WARNING
 *                                               src/thread-memory-reports.ts constants
 *   The following print src/thread-memory-reports.ts's builders. <channels> is
 *   comma-separated IDs or '-' for none; booleans are true/false. Configured
 *   refs/paths pass through unchanged; production builders redact error text.
 *   buildThreadMemoryNotSavedNotice <ref> <channels> <path> <step> <error>
 *   buildThreadMemoryUnreadableNotice <ref> <channels> <path>
 *   buildThreadMemoryChangedWhileStoppedNotice <ref> <channels> <unclean|changed>
 *   buildThreadMemoryRecoveredNotice <ref> <channels>
 *   buildThreadMemoryNotSavedLine <key> <channels> <path> <step> <error> <notice-only>
 *   buildThreadMemoryUnreadableLine <key> <channels> <path> <error> <missing>
 *   buildThreadMemoryChangedWhileStoppedLine <key> <channels> <case> <unclean|changed>
 *   buildThreadMemoryRecoveredLine <key> <channels>
 *   buildThreadMemoryQuarantinedLine <key> <path> <count> <invalid-final-count>
 *   buildThreadMemoryCompactionFailedLine <key> <path> <step> <error>
 *   buildThreadMemoryRemovalFailedLine <key> <path> <step> <error>
 *   buildThreadMemorySealUnreadableLine <path> <error>
 *   buildThreadMemorySealNotSavedLine <path> <error> <unsynced>
 *   buildThreadMemoryHoldsNotResolvedLine <key> <error>
 *   buildThreadMemoryJoinsLostLine / buildThreadMemoryJoinsLostNotice
 *       <name> <key> <channel/root,...|-> <channel/ts,...|-> <unreadable-count>
 *   buildThreadMemoryOwnPostLostLine / buildThreadMemoryOwnPostLostNotice
 *       <name> <key> <channel> <roots-csv|-> <cause>
 *       Own-post variants call the same JoinsLost builders with ownPosts facts.
 *       Notice entries return the body; capped persona-prefix options are not rendered.
 *   sharedConfigurationMatches <config-path> <record-path> <reviewed|applied>
 *       Validate the whole shared authority and exact reviewed input; applied
 *       also compares resolved applied configuration with that input.
 *   sharedConfigurationValue <config-path> <record-path> <port|resume_enabled|channel_mode>
 *       Print only the named safe applied setting, never pending input;
 *       channel_mode through src/config.ts's channelModeOf.
 *   sharedAuthorityPreserved <config-path> <before-record> <after-record>
 *       Validate preserved choices, identity and reviewed input across fresh discovery.
 *   sharedThreadStamp <config-path> <record-path> <persona-key> <channel>
 *       Print a current hybrid channel's stamp from the validated authority.
 *   sharedApplicationPreserved <config-path> <before-record> <after-record>
 *       Preserve the same applied/source/lifetime facts while operator intent changes.
 *   operatorReviewRequest <config-path> <record-path> <id> <request|revise|refresh|cancel> [name/channel/delivery...]
 *       Print production request bytes with current generation and target identities.
 *   operatorReviewPending <config-path> <record-path> <pending-path> <id>
 *       Require this exact recorded request's current durable review.
 *   operatorReviewCancelled <config-path> <record-path> <submitted-request-json>
 *       Require the exact production-parsed cancel request's current durable
 *       acknowledgement, cleared intent/assignments and no active review.
 *       Absence before processing and an older cancellation never pass.
 *   sharedReviewConsumed <config-path> <record-path> <review-path>
 *       Require the exact review's durable consumed outcome, never inode evidence.
 *   stoppedDowngradeBaseline <config-path> <record-path>
 *       Print applied resume=false config only when no operator intent is outstanding.
 *       Manual stopped fixture transition retains and restores the original authority.
 *   reloadStartRefusalLine <config|record> <config-path> [<setting>]
 *       src/reload.ts createReloadController's start resolution over the files
 *       beside <config-path> (record: <config-path>.last-applied), as the server
 *       resolves them under the same HOME: the one `Fatal: configuration error`
 *       (config) or `Fatal: last-applied record error` (record) line it logs. Fails
 *       unless the start refuses that source; any write, delete or store the start
 *       would reach also fails it. With <setting>, the refusal must name it as its
 *       rule's setting (`: <setting> `). Other start lines (a record refusal's
 *       reload-shared-recovery line) are not printed: see sharedRecoveryLine.
 *   removedKeyRefusal <removed-key>
 *       src/config.ts resolvePersonaConfig's sentence for a removed key, naming its
 *       replacement (`<key> … <replacement>.`), from a candidate holding only that
 *       key at the top level, else in one persona entry. A current setting
 *       (PERSONA_TOP_LEVEL_KEYS, PERSONA_ENTRY_KEYS) is a usage failure; a key whose
 *       rule names no current setting after it fails. Contained in that key's
 *       reloadStartRefusalLine.
 *   earlierQueueRecordUnreadableLine <earlier-package-dir> <persona-name> <key> <line> <quarantine-path>
 *   earlierQueueRecordUnreadableNotice <earlier-package-dir> <persona-name> <key> <count> <quarantine-path>
 *       The earlier release's own exports, imported from <earlier-package-dir> (its
 *       installed package directory, `<install>/node_modules/claude-slack-channel-bots`),
 *       never from CSCB_PKG_DIR. Line: its server-log line for one queue record it sets
 *       aside at start, through its src/delivery-notices.ts createDeliveryReporting
 *       given an alert-free record-unreadable event (0.18.0 exports no builder for the
 *       `line=… path=…` part, nor the quarantine file's name). Notice: the body of its
 *       src/delivery-notices.ts buildQueueRecordUnreadableNotice for
 *       renderPersonaRef(<persona-name>, <key>); its notifier adds the persona prefix.
 *   reloadSharedAuthorityStartLine <config-path> <record-path>
 *       Build the production startup line using the validated record revision.
 *   PHASE1_FLOOR_VERSION                         src/ad-version-gate.ts, the Phase 1 floor
 *   AD_BELOW_PHASE1_FLOOR                        src/install-check-labels.ts, sentinel guard class
 *   AD_SYSTEM_INSTALL_TOO_OLD                   src/install-check-labels.ts, native minimum class
 *   AD_CLIENT_MINIMUM                           src/install-check.ts, installed SDK minimum
 *   buildSystemInstallTooOldMessage <found-version> <binary-path> <startup|runtime>
 *                                               src/ad-version-gate.ts, startup block included
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
 *   classifyAdError <err-name>                   src/ad-error-class.ts: CSCB's class
 *                                                (`errorClass`) for an instance of the
 *                                                installed agent-director client's error
 *                                                class <err-name>, built as the client
 *                                                builds one from an error envelope (verb,
 *                                                name, description); for the classes the
 *                                                client builds from an envelope only
 *   DEFAULT_AD_SETTINGS <table> <key>            src/ad-settings.ts: agent-director's default
 *                                                for `[<table>] <key>` (for example `tmux
 *                                                starting_session_seconds`), in decimal
 *   CLIENT_DEV_SENTINEL_VERSION                  src/ad-version-gate.ts, the client's
 *                                                development sentinel version
 *   AD_SYSTEM_INSTALL_UNREACHABLE                src/install-check-labels.ts, the class label
 *   UNREACHABLE_REASON_UNPARSEABLE_VERSION       src/ad-version-gate.ts, the
 *                                                ErrSystemInstallUnreachable reason of a
 *                                                version that does not parse
 *   meetsPhase1Floor <version>                   src/ad-version-gate.ts: whether <version>
 *                                                meets CSCB's Phase 1 floor, `true` or `false`
 *   AD_SETTINGS_LOG_PREFIX                       src/ad-settings.ts, the prefix of the
 *                                                settings reader's log lines
 *   buildAdSettingsValuesLine <path> [<key>=<integer>…]
 *                                                src/ad-settings.ts: the values line for the
 *                                                settings file <path>, the nine [tmux] values
 *                                                DEFAULT_AD_SETTINGS' own but for each given
 *                                                <key>
 *   AD_SETTINGS_RELATIVE_PATH                    src/ad-settings.ts, the settings file's path
 *                                                relative to a HOME
 *   AD_TMUX_TABLE                                src/ad-settings.ts, the timing keys' table
 *   AD_PAUSE_TABLE                               src/ad-settings.ts, `pause`'s table
 *   AD_PAUSE_TIMEOUT_KEY                         src/ad-settings.ts, `pause`'s wait key
 *   AD_TMUX_KEYS                                 src/ad-settings.ts: the nine [tmux] keys, in
 *                                                order, joined by single spaces
 *   AD_SETTING_MINIMUMS <key> [<part>]           src/ad-settings.ts: agent-director's minimum
 *                                                for [tmux] <key>, in decimal; for a minimum
 *                                                with parts (pending_grace_seconds), the
 *                                                named <part> (`floor` or `addend`)
 *   pendingGraceMinimumSeconds <create-timeout-ms> <pipe-close-wait-ms>
 *                                                src/ad-settings.ts: the grace period's
 *                                                minimum, in decimal
 *   adGraceMs [<key>=<integer>…]                 src/ad-settings.ts: G, in decimal
 *   adAlertThresholdMs [<key>=<integer>…]        src/ad-settings.ts: the alert threshold, in
 *                                                decimal
 *   adLaunchBoundMs [<key>=<integer>…]           src/ad-settings.ts: B, in decimal. These
 *                                                three take an AdSettingsInEffect built from
 *                                                the arguments: the [tmux] values
 *                                                DEFAULT_AD_SETTINGS' own but for each given
 *                                                <key>, and DEFAULT_AD_SETTINGS_IN_EFFECT's
 *                                                pauseTimeout. adLaunchBoundMs also takes
 *                                                dialog_ready_timeout_ms=<integer> (b.2nr: B's
 *                                                floor in milliseconds, as the test-only
 *                                                override sets it; no other override key), the
 *                                                floor otherwise DIALOG_READY_TIMEOUT_MS
 *   testTimerOverridesBlock [<key>=<integer>…]   src/config.ts TEST_TIMER_OVERRIDE_KEYS (b.2nr): the
 *                                                `test_timer_overrides` JSON object of
 *                                                config.json for the given override values,
 *                                                compact, keys in the package's order; each <key>
 *                                                one of latch_recheck_interval_ms,
 *                                                ad_version_recheck_interval_ms,
 *                                                dialog_ready_timeout_ms,
 *                                                delivery_stuck_after_ms,
 *                                                queue_compact_interval_ms (milliseconds),
 *                                                unavailable_retry_base_s,
 *                                                unavailable_retry_ceiling_s (seconds), each
 *                                                <integer> a positive integer within the
 *                                                server's own bound (an unknown or repeated key,
 *                                                a value out of range, only one of the two retry
 *                                                keys, or a ceiling below the base is a usage
 *                                                failure, as the server's loader would refuse
 *                                                it). `{}` for none
 *   buildTestTimerOverridesLine [<key>=<integer>…]
 *                                                src/test-timer-overrides.ts: the loud line the
 *                                                server writes at start naming every overridden
 *                                                value; the empty text for no override
 *   effectiveTestTimer <key> [<key>=<integer>…]  src/test-timer-overrides.ts: the value of timer
 *                                                <key> (an override key, as above) in effect for
 *                                                the given overrides, in decimal: the override,
 *                                                else the production default
 *   wholeMinutes <ms>                            src/ad-settings.ts: <ms> in whole minutes,
 *                                                rounded down, in decimal
 *   STILL_STOPPING_PHRASE                        src/ad-description-phrases.ts
 *   STILL_STARTING_PHRASE                        src/ad-description-phrases.ts
 *   stuckLaunchRelaunchingText <persona-key> <launch-bound-ms>
 *                                                src/pending-row.ts: the stuck-launch post's
 *                                                relaunching text for the persona with key
 *                                                <persona-key> and B <launch-bound-ms>
 *                                                (posted as a persona notice: wrap it in
 *                                                formatPersonaNotice)
 *   STARTUP_ERROR_SPAWN_FAILED                   src/session-manager.ts, the startup-errors
 *                                                label of a launch failure
 *   liveRowSequenceWaitArmedLine <persona-ref> <launch-start-ms> <grace-ms>
 *                                                src/live-row-sequence.ts: the step-2 wait's
 *                                                armed line for the persona <persona-ref> (as
 *                                                the server renders it, `"<name>" (key=<key>)`),
 *                                                a launch start in epoch milliseconds and G
 *   liveRowSequenceWaitEndedLine <persona-ref>   src/live-row-sequence.ts: the step-2 wait's
 *                                                end line
 *   liveRowSequenceRunLine <persona-ref> <step> <run-number> <placement-export>
 *                                                src/live-row-sequence.ts: the live-row
 *                                                sequence's line for one `find-missing` run
 *                                                of the persona <persona-ref> (as the server
 *                                                renders it, `"<name>" (key=<key>)`) at step
 *                                                <step> (3 or 4), run <run-number>, with the
 *                                                placement the package exports as
 *                                                <placement-export> (a `LIVE_ROW_RUN_…`
 *                                                name, for example LIVE_ROW_RUN_NOT_JUDGED)
 *   AD_CONFIG_FILE_DISPLAY_NAME                  src/ad-config-file.ts, the settings file as a
 *                                                notice names it (`~/…`)
 *   adConfigMalformedOnset <description>         src/outage-state.ts: the `ad-config-malformed`
 *                                                onset for agent-director's ErrConfigMalformed
 *                                                answer with <description>, built as the
 *                                                installed client decodes it (the native
 *                                                ErrConfigMalformed class). Given a
 *                                                marker <description>, the text around the
 *                                                marker is the onset's fixed part (posted as a
 *                                                persona notice: wrap it in formatPersonaNotice)
 *   adConfigMalformedRaisedLine <persona-key> <description>
 *                                                src/outage-state.ts: the server-log raise line
 *                                                for that answer (its classification by
 *                                                src/ad-error-class.ts classifyAdError)
 *   adConfigMalformedClearedLine <persona-key>   src/outage-state.ts: the server-log clear line
 *   ALL_CLEAR_TEMPLATE <outage-class>…           src/outage-state.ts: the all-clear for a bad
 *                                                stretch of the given classes (each one of the
 *                                                package's OUTAGE_CLASS_ORDER, given once),
 *                                                none with a detail (posted as a persona
 *                                                notice: wrap it in formatPersonaNotice)
 *   buildAdSettingsRefusedReadLine <path> <reason> <accepted|none>
 *                                                src/ad-settings.ts: the line of a run of
 *                                                refused reads of <path>, `accepted` when a
 *                                                read was accepted before it, `none` when not;
 *                                                given a marker <reason>, the text around the
 *                                                marker is the line's fixed part
 *   UNAVAILABLE_RETRY_BASE_S                     src/unavailable-retry.ts, the retry timer's
 *                                                first wait (its waits double from it), in
 *                                                seconds, in decimal
 *   unavailableRetryRetryLine <persona-key> <retry> <full|pending-only>
 *                                                src/unavailable-retry.ts: the line at the
 *                                                start of retry <retry> of the persona's
 *                                                retry timer, in that mode
 *   unavailableRetryReArmedLine <persona-key> <retry> <full|pending-only> <reason> <wait-ms>
 *                                                src/unavailable-retry.ts: the re-armed line
 *                                                of that retry, answered <reason>, the mode
 *                                                unchanged, the next retry in <wait-ms>; given
 *                                                a marker <reason>, the text before the marker
 *                                                is the line's fixed head for that retry
 *   RESTART_OUTCOME_LIVENESS_UNKNOWN             src/restart.ts, the restart work's outcome
 *                                                (and a retry's again-reason) when the
 *                                                persona's liveness reads unknown
 *   unavailableRetryStoppedLine <persona-key> <full|pending-only> <row|none> <reason>
 *                                                src/unavailable-retry.ts: the line of a stop
 *                                                of the persona's retry timer, in that mode,
 *                                                naming the row read (`none`: no row); given
 *                                                a marker <reason>, the text before it is the
 *                                                line's fixed head
 *   UNAVAILABLE_RETRY_CEILING_S                  src/unavailable-retry.ts, the retry timer's
 *                                                longest wait, in seconds, in decimal
 *   buildAdCallTimeoutWarningLine <call-timeout-ms> [<key>=<integer>…]
 *                                                src/ad-settings.ts: the startup call-timeout
 *                                                warning for the call timeout <call-timeout-ms>
 *                                                and the values in effect built as for
 *                                                adGraceMs; the empty text when the builder
 *                                                gives no line
 *   adCallTimeoutNeed [<key>=<integer>…]         src/ad-settings.ts: `<need-ms> <verb>`, the call
 *                                                timeout's need in decimal and the verb whose
 *                                                ceiling sets it, for the values in effect
 *                                                built as for adGraceMs
 *   LAUNCH_TIMEOUT_PHRASE                        src/ad-description-phrases.ts
 *   AD_VERSION_RECHECK_STOP_EXIT_CODE            src/ad-version-gate.ts, the exit status of the
 *                                                runtime re-check's stop, in decimal
 *   launchUnavailableGetLine <persona-ref> <what> <err-name> <read> <launch-start|no> <outcome-export>
 *                                                src/session-manager.ts: the line of the one get
 *                                                after the <what> of <persona-ref> ended in a
 *                                                launch timeout of the form <err-name> (the
 *                                                value of one of src/ad-error-class.ts's
 *                                                LAUNCH_TIMEOUT_FORM_… exports, named as
 *                                                launchUnavailableFormText names it), the get
 *                                                reading <read>; this launch's row has the
 *                                                launch start <launch-start>, the row's
 *                                                `launch_started_at` as agent-director wrote it,
 *                                                read with src/pending-row.ts parseLaunchStart
 *                                                (`no`: not this launch's row); the outcome the
 *                                                package exports as <outcome-export> (a
 *                                                `LAUNCH_UNAVAILABLE_OUTCOME_…` name)
 *   UNAVAILABLE_RETRY_STOP_ROW_LIVE              src/unavailable-retry.ts, a stop's reason when a
 *                                                pending-only retry reads the row live
 *   UNAVAILABLE_RETRY_STOP_RECOVERED             src/unavailable-retry.ts, a stop's reason when a
 *                                                retry finds nothing left to recover
 *   stuckLaunchAbortStartedLine <persona-key> <persona-ref> <launch-start>
 *                                                src/pending-row.ts: the stuck-launch abort's
 *                                                start line; <launch-start> as a row's
 *                                                `launch_started_at` (the line renders it)
 *   reprobeDeadLine <persona-key>                src/restart.ts: the line of a row the re-probe
 *                                                reads dead
 *   liveRowSequenceStartLine <persona-ref> <entry-step-export> <instance-id> <last-read> <launch|no-launch> <alert-context>
 *                                                src/live-row-sequence.ts: the live-row
 *                                                sequence's start line, entered at the step the
 *                                                package exports as <entry-step-export> (a
 *                                                `LIVE_ROW_SEQUENCE_ENTRY_…` name), ending in a
 *                                                launch or not
 *   RELOAD_APPLIED                               src/reload-apply.ts, the class label of an
 *                                                applied reload's line
 *
 * test-29's entries (test-29-invited-channels.sh, a shared-mode scenario;
 * b.deo SRI-1401, SRI-1404). <channel> is a channel ID, <delivery>, <stored>,
 * <after> and <before> one of src/config.ts DELIVERY_MODES (<before> may also
 * be NO_STORED_CHOICE, below), <name> a persona name and <key> its key:
 *   UNCLAIMED_CHANNEL                            src/persona-diagnostics.ts, the class label
 *   unclaimedChannelCause <channel>              src/persona-diagnostics.ts: the declarative-mode
 *                                                `unclaimed-channel` cause (0.11.1's)
 *   UNCLAIMED_REASON_EXTERNALLY_SHARED           src/persona-diagnostics.ts, the fungible-mode
 *   UNCLAIMED_REASON_FLAG_MISSING                `unclaimed-channel` reasons test-29 meets, each
 *   UNCLAIMED_REASON_FLAG_NOT_BOOLEAN            printed as it is
 *   fungibleUnclaimedChannelCause <channel> <refusal>
 *                                                src/persona-diagnostics.ts: the fungible-mode
 *                                                `unclaimed-channel` cause, <refusal> one of
 *                                                src/delivery-decision.ts FUNGIBLE_REFUSALS
 *   PERSONA_OPEN_CHANNEL                         src/persona-diagnostics.ts, the class label
 *   openChannelCause <channel> <public|private> <delivery>
 *                                                src/persona-diagnostics.ts: its cause
 *   PERSONA_CHANNEL_DELIVERY_SET                 src/persona-diagnostics.ts, the class label
 *   MESSAGE_RECEIVED, MESSAGE_DELIVERED          src/persona-diagnostics.ts, delivery evidence labels
 *   THREAD_MEMORY_LOOKUP_DEADLINE_MS, THREAD_MEMORY_RETRY_MIN_MS, THREAD_MEMORY_RETRY_MAX_MS
 *                                                src/delivery-constants.ts: one metadata
 *                                                attempt's deadline and the local retry
 *                                                spacing's minimum and maximum, in
 *                                                milliseconds
 *   MEMBERSHIP_REQUEST_TIMEOUT_MS, MEMBERSHIP_ATTEMPT_TIMEOUT_MS,
 *   MEMBERSHIP_RETRY_MIN_MS, MEMBERSHIP_RETRY_MAX_MS   src/channel-membership-retry.ts bounds
 *   MEMBERSHIP_PAGE_LIMIT                        src/channel-membership-retry.ts: the channels
 *                                                an inventory request asks for per page
 *   membershipRetryDelay <failures> [retry-after-seconds]  production retry, including Retry-After
 *   channelDeliverySetCause <channel> <before> <after> <delivery>
 *                                                src/persona-diagnostics.ts: its cause; <before>
 *                                                is the package's NO_STORED_CHOICE for no stored
 *                                                choice before the call
 *   NO_STORED_CHOICE                             src/persona-diagnostics.ts, how that line names
 *                                                no stored choice
 *   SET_CHANNEL_DELIVERY_TOOL                    src/channel-delivery.ts, the tool's name
 *   channelDeliveryDeclarativeRefusal <name> <key>
 *   channelDeliveryChannelRefusal <name> <key> <channel>
 *   channelDeliveryValueRefusal <name> <key> <value>
 *                                                src/registry.ts: the tool's refusals in
 *                                                declarative mode, for a channel not known, and
 *                                                for a delivery value it does not take
 *   modeSwitchLine <mode> [<persona-name>…]      src/reload-plan.ts: the switch's preview line
 *                                                turning <mode> (one of src/config.ts
 *                                                CHANNEL_MODES) on, for the personas named, in
 *                                                order, each keyed by the package's personaKey
 *   channelModeOf <true|false>                   src/config.ts: the name of the mode the switch's
 *                                                value picks, keyed by MODE_SWITCH_SETTING
 *   formatPersonaDiagnostic <class> <index> <name> <key> <cause>
 *                                                src/persona-diagnostics.ts: a persona line with
 *                                                no path, <class> one of its
 *                                                PERSONA_DIAGNOSTIC_CLASSES
 *   MODE_SWITCH_SETTING                          src/reload-plan.ts, the switch's key
 *   CHANNEL_DELIVERY_FILE_NAME                   src/channel-delivery.ts, the stored-choice file
 *   CHANNEL_DELIVERY_LOG_PREFIX                  src/channel-delivery.ts, the head of the store's
 *                                                own lines
 *   CHANNEL_DELIVERY_DIAGNOSTIC_CLASSES          src/channel-delivery.ts, the store's class
 *                                                labels, one per line
 *
 * A builder entry given a marker argument (a key, a reference, a state or a
 * description the scenario chooses) prints a line whose text around the
 * marker is the line's fixed part; the scenario splits it there.
 *
 * In every `<key>=<integer>` argument <key> is one of the package's
 * AD_TMUX_KEYS and <integer> an integer in decimal; an unknown key, a key
 * given twice or a value that is not an integer is a usage failure (exit 64).
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
 *   adGraceMs, adLaunchBoundMs                   G and B at agent-director's default settings:
 *                                                the entries above, given no argument
 * Scenario 25's entries (test-27):
 *   AD_ERROR_CLASS_UNUSABLE_NAME                 src/ad-error-class.ts, CSCB's class for an
 *                                                unusable recorded name, as fmk-driver.ts's
 *                                                outcome line gives it (`class=<class>`)
 * Scenario 20's entries (test-23):
 *   DEFAULT_AD_SETTINGS <table> <key>            src/ad-settings.ts, one of agent-director's
 *                                                default settings (for example `tmux
 *                                                starting_session_seconds`), in decimal
 *   RECHECK_VERDICT_STILL_LATCHED                src/conflict-latch.ts, a probe's verdict that
 *                                                keeps the latch (a probe round's answer)
 *   PANE_READ_PANE, PANE_READ_CONFLICT, PANE_READ_GONE
 *                                                src/pane-read.ts, the `read-pane` answer kinds
 *                                                a probe round's answer names
 *   latchClearRetryAtOnceLineHead <persona-name>
 *                                                src/session-manager.ts, the head of the
 *                                                after-clear retry's lines, the reference
 *                                                renderPersonaRef(<persona-name>)
 *   LATCHING_LIVENESS_NOTE                       src/row-read-rules.ts, the liveness note a
 *                                                row's `get` carries that latches its persona
 *                                                with "conflicting labels"
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
 *   unavailableRetryDueS <retry> [unavailable_retry_base_s=<integer> unavailable_retry_ceiling_s=<integer>]
 *                                                when the retry timer's retry <retry> (from 1)
 *                                                falls due after its arm, in seconds, in
 *                                                decimal: the sum of src/backoff.ts
 *                                                doublingBackoffDelay(base, <k>, ceiling), the
 *                                                base and ceiling UNAVAILABLE_RETRY_BASE_S and
 *                                                UNAVAILABLE_RETRY_CEILING_S or, given together
 *                                                (b.2nr), the two override values, for <k> from 0
 *                                                to <retry> - 1, the waits src/unavailable-retry.ts
 *                                                arms (each re-arm is measured from the end of the
 *                                                run before it, so the real due time is no earlier)
 *   escalateDeadSweepLineHead <key>              text the builder (escalateDeadSweepLine,
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
 *   latchClearRetryAtOnceLineHeadForRef <ref>    src/session-manager.ts, the head of the after-clear
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
 *   ENTER_DELAY_MS                              src/delivery-constants.ts, reconnect's delay
 *                                                between text/no_enter and Enter (b.omv SR-5.4)
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
 *   CLEAN_RESTART_SERVER_FLAG        `clean_restart`'s whole-fleet flag
 *                                    (src/cli-teardown.ts; b.ku8)
 *   CLEAN_RESTART_USAGE              `clean_restart`'s usage line, printed
 *                                    with exit 2 (src/cli.ts)
 *   cleanRestartRelaunchWaitMs <delay>
 *                                    how long, in ms, `clean_restart <bot>…`
 *                                    waits for each stopped bot's relaunch
 *                                    under `session_restart_delay` <delay>
 *                                    seconds (src/cli-teardown.ts)
 *   CLEAN_EXIT_RELAUNCH_DELAY        the server's clean-exit check's delay in
 *                                    seconds (src/restart.ts)
 *   cleanExitRelaunchLine <key> <delay>
 *                                    the server's line when the clean-exit
 *                                    check relaunches persona <key> at once
 *                                    instead of after <delay> seconds
 *                                    (src/restart.ts)
 *   CLEAN_RESTART_NAMED_BOTS_LINE    `clean_restart <bot>…`'s progress line
 *                                    (src/cli-teardown.ts)
 *   cleanRestartRelaunchedLine <name>
 *                                    `clean_restart <bot>…`'s line for a bot
 *                                    the server was seen relaunching
 *   cleanRestartNotRelaunchedLine <name> <wait-ms>
 *                                    its line for a bot it stopped but did
 *                                    not see relaunched within <wait-ms>
 *   teardownNextLifeAfterPauseLine.head <name>
 *   teardownNextLifeAfterPauseLine.tail <name>
 *                                    the parts of the teardown's line for a
 *                                    poll read live after a successful pause
 *                                    (the bot's next life) before and after
 *                                    its elapsed milliseconds
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
 *                                    the diagnosis's startup-errors class
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
 *   LAUNCH_UNAVAILABLE_OUTCOME_COVERED_NO_APPROVER
 *                                 src/session-manager.ts
 *                                 LAUNCH_UNAVAILABLE_OUTCOME_COVERED_NO_APPROVER: the outcome the
 *                                 one `get` after a launch timeout logs for a covered
 *                                 `pending` row watched by the retry timer
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
 *   PENDING_ROW_RUN_NOT_JUDGED    src/pending-row.ts PENDING_ROW_RUN_NOT_JUDGED: the
 *                                 placement a pending-row rule round's line gives
 *                                 its bypassing `find-missing` run when the run left
 *                                 the `pending` row in neither list (not judged)
 *   PENDING_ROW_RULE_ORIGIN_RETRY src/pending-row.ts PENDING_ROW_RULE_ORIGIN_RETRY: the
 *                                 origin a rule line names for a run at a retry of
 *                                 the persona's retry timer
 *   adLaunchBoundMs(DEFAULT_AD_SETTINGS_IN_EFFECT)
 *                                 src/ad-settings.ts adLaunchBoundMs over
 *                                 DEFAULT_AD_SETTINGS_IN_EFFECT: B, CSCB's launch
 *                                 bound at agent-director's default settings, in
 *                                 milliseconds
 * None of the above takes an argument.
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
 *   liveRowSequenceStep2GetMissingLine <ref>
 *                                 src/live-row-sequence.ts liveRowSequenceGetLine(<ref>,
 *                                 2, a LIVE_ROW_READ_ROW read of state `missing`): the
 *                                 line the live-row sequence's step-2 `get` logs when
 *                                 it read the row `missing`
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
 *                                 PENDING_ROW_RULE_ORIGIN_RETRY by its value,
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
 * The per-persona model and effort entries (test-49; b.fx2):
 *   MODEL_ARG_PREFIX              src/agent-director-template.ts MODEL_ARG_PREFIX:
 *                                 the start-argument element's text before a
 *                                 persona's `model` value
 *   EFFORT_ARG_PREFIX             src/agent-director-template.ts EFFORT_ARG_PREFIX:
 *                                 the start-argument element's text before a
 *                                 persona's `effort` level
 *   EFFORT_LEVELS                 src/config.ts EFFORT_LEVELS, the levels
 *                                 `effort` accepts, in order, joined by single
 *                                 spaces
 * None of the above takes an argument.
 *   freshStartLine <ref> <key> [<key>]
 *                                 src/live-row-sequence.ts freshStartLine(<ref>,
 *                                 <keys>): the server's line when a persona's
 *                                 relaunch starts a fresh conversation because
 *                                 these start values differ from the ones its
 *                                 conversation started with; each <key> is
 *                                 src/persona-identity.ts MODEL_LABEL_KEY or
 *                                 EFFORT_LABEL_KEY by its value (any other
 *                                 fails), in that order (any other order
 *                                 fails)
 *
 * test-50's entries (test-50-reaction-notices.sh, a shared-mode scenario;
 * b.n3k). <name> is a persona name, <key> its key, <chat> a conversation ID
 * and <message-ts> the reacted message's ts:
 *   REACTION_RECEIVED, REACTION_DROPPED
 *                                 src/reaction-intake-diagnostics.ts, the class
 *                                 labels
 *   REACTION_WITHDRAWN, REACTION_MESSAGE_UNKNOWN
 *                                 src/reaction-preparation-diagnostics.ts, the
 *                                 class labels
 *   buildReactionReceivedLine <name> <key> <chat> <message-ts> <added|removed> <emoji> <user> <seq>
 *                                 src/reaction-intake-diagnostics.ts: the line of
 *                                 a newly stored Reaction Item from user <user>,
 *                                 <seq> its sequence in decimal
 *   buildReactionDroppedLine <name> <key> <reason> <chat> <message-ts> [<refusal>]
 *                                 src/reaction-intake-diagnostics.ts: a logged
 *                                 drop, <reason> one of its
 *                                 REACTION_LOGGED_DROP_REASONS, <refusal> given
 *                                 for `open-refused` and only for it
 *   buildReactionWithdrawnLine <name> <key> <chat> <message-ts> <reason> [<condition>]
 *                                 src/reaction-preparation-diagnostics.ts: a
 *                                 withdrawal's line, <reason> and <condition> as
 *                                 src/delivery-queue.ts's withdrawn record names
 *                                 them
 *   buildReactionMessageUnknownLine <name> <key> <chat> <message-ts>
 *                                 src/reaction-preparation-diagnostics.ts: a
 *                                 notice fixed without `thread_ts`
 *   TAG_SOURCE                    src/tag-wrapper.ts, a typed tag's `source`
 *   SERVER_POST_EVENT_TYPE        src/server-post.ts, a Server Post's metadata
 *                                 event type
 *   encodePermissionActionId <allow|deny> <instance-id> <token>
 *                                 src/permission-action-id.ts: a permission
 *                                 prompt button's action_id
 *   REPLY_REMINDER_TEXT           src/reply-reminder.ts, the reply reminder's text
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
 * opens no socket, reads no token and writes no file but the private copy of
 * the shared record that `readSharedConfiguration` reads and removes.
 */
import { existsSync, readFileSync, openSync, closeSync, fstatSync, readSync, constants, readdirSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'

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
  /** Import the agent-director client the installed package resolves. */
  importAgentDirectorClient(): Promise<Record<string, unknown>>
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

/** The installed client's actual minimum, without running its resolver. */
const clientMinimumVersion: Entry = {
  synopsis: '',
  async print(args, context) {
    expectArguments('AD_CLIENT_MINIMUM', args, [])
    const read = await packageFunction<() => unknown>(context, 'install-check.ts', 'readClientMinVersion')
    return builtString('AD_CLIENT_MINIMUM', read())
  },
}

/** Native too-old refusal, including the startup gate's instruction block. */
const systemInstallTooOldMessage: Entry = {
  synopsis: '<found-version> <binary-path> <startup|runtime>',
  async print(args, context) {
    const entry = 'buildSystemInstallTooOldMessage'
    expectArguments(entry, args, ['found-version', 'binary-path', 'startup|runtime'])
    const [foundVersion, binaryPath, finder] = args
    const foundByExport = Object.hasOwn(FOUND_BY_EXPORTS, finder) ? FOUND_BY_EXPORTS[finder] : undefined
    if (foundByExport === undefined) usageFail(`${entry}: the finder must be startup or runtime (got '${finder}')`)
    const foundBy = await packageString(context, 'ad-version-gate.ts', foundByExport)
    const requiredVersion = await clientMinimumVersion.print([], context)
    const build = await packageFunction<(parts: object, foundBy: string) => unknown>(context, 'ad-version-gate.ts', entry)
    let message = builtString(entry, build({ foundVersion, binaryPath, requiredVersion }, foundBy))
    if (finder === 'startup') {
      const render = await packageFunction<() => unknown>(context, 'install-skill-pointer.ts', 'renderInstallSkillInstructions')
      message += builtString(entry, render())
    }
    return message.replace(/\r?\n/g, ' ').replace(/\r/g, ' ')
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

/** `latchClearRetryAtOnceLineHead(ref)`: the head of the after-clear retry's lines, `ref` the persona reference `renderPersonaRef` gives the name. */
const latchClearRetryAtOnceLineHead: Entry = {
  synopsis: '<persona-name>',
  async print(args, context) {
    const entry = 'latchClearRetryAtOnceLineHead'
    expectArguments(entry, args, ['persona-name'])
    const ref = (await packageFunction<(name: string) => unknown>(context, 'persona-identity.ts', 'renderPersonaRef'))(args[0])
    const build = await packageFunction<(ref: string) => unknown>(context, 'session-manager.ts', entry)
    return builtString(entry, build(builtString(entry, ref)))
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


/** pane-read.ts's `read-pane` answer kinds a probe round's answer names, each printed as it is. */
const PANE_READ_KIND_NAMES: readonly string[] = ['PANE_READ_PANE', 'PANE_READ_CONFLICT', 'PANE_READ_GONE']



/** An entry printing the output of the package builder `name` of `relPath` for its string arguments `argNames`. */
function builderEntry(relPath: string, name: string, argNames: readonly string[],
  kinds: Readonly<Record<string, 'channels' | 'number' | 'boolean'>> = {}): Entry {
  return {
    synopsis: argNames.map((n) => `<${n}>`).join(' '),
    async print(args, context) {
      expectArguments(name, args, argNames)
      const build = await packageFunction<(...parts: unknown[]) => unknown>(context, relPath, name)
      const values = args.map((arg, index) => {
        const kind = kinds[argNames[index]]
        if (kind === 'channels') return arg === '-' ? [] : arg.split(',')
        if (kind === 'number') return Number(integerArgument(name, argNames[index], arg))
        if (kind === 'boolean') {
          if (arg !== 'true' && arg !== 'false') usageFail(`${name}: expected boolean ${argNames[index]}`)
          return arg === 'true'
        }
        return arg
      })
      return builtString(name, build(...values))
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
 * seconds: `doublingBackoffDelay(base, k, ceiling)` summed for k from 0 to
 * <retry> - 1, the waits src/unavailable-retry.ts arms (its first at the base,
 * each later one after k refusals). The base and ceiling are
 * `UNAVAILABLE_RETRY_BASE_S` and `UNAVAILABLE_RETRY_CEILING_S`, or, when the
 * `unavailable_retry_base_s=<integer>` and `unavailable_retry_ceiling_s=<integer>`
 * arguments are given (together, as the server's loader requires: b.2nr), those.
 */
const unavailableRetryDue: Entry = {
  synopsis: '<retry> [unavailable_retry_base_s=<integer> unavailable_retry_ceiling_s=<integer>]',
  async print(args, context) {
    const entry = 'unavailableRetryDueS'
    const [retry, ...pairs] = args
    if (retry === undefined || !/^[1-9][0-9]{0,2}$/.test(retry)) usageFail(`${entry}: <retry> must be a whole number from 1 to 999 (got '${retry ?? ''}')`)
    for (const pair of pairs) {
      if (!/^unavailable_retry_(base|ceiling)_s=/.test(pair)) usageFail(`${entry}: '${pair}' is not unavailable_retry_base_s=<integer> or unavailable_retry_ceiling_s=<integer>`)
    }
    const block = await overrideBlockFrom(entry, pairs, context)
    const base = block['unavailable_retry_base_s'] ?? (await packageExport(context, 'unavailable-retry.ts', 'UNAVAILABLE_RETRY_BASE_S'))
    const ceiling = block['unavailable_retry_ceiling_s'] ?? (await packageExport(context, 'unavailable-retry.ts', 'UNAVAILABLE_RETRY_CEILING_S'))
    if (typeof base !== 'number' || typeof ceiling !== 'number') {
      fail(PRINTER_FAIL_EXIT, "the installed package's src/unavailable-retry.ts UNAVAILABLE_RETRY_BASE_S or UNAVAILABLE_RETRY_CEILING_S is not a number")
    }
    const delay = await packageFunction<(base: number, priorAttempts: number, ceiling: number) => unknown>(context, 'backoff.ts', 'doublingBackoffDelay')
    let due = 0
    for (let k = 0; k < Number(retry); k++) {
      const wait = delay(base, k, ceiling)
      if (typeof wait !== 'number' || !Number.isFinite(wait)) fail(PRINTER_FAIL_EXIT, `${entry}: doublingBackoffDelay gave ${String(wait)}, not a finite number`)
      due += wait
    }
    return decimal(entry, due)
  },
}

// ---------------------------------------------------------------------------
// The entries of scenarios 8, 23 and 24 (test-20, test-26)
// ---------------------------------------------------------------------------


/** An error class's constructor as the client builds an error from an envelope. */
type EnvelopeErrorClass = new (verb: string, errName: string, errDescription: string) => unknown

/**
 * `classifyAdError(<an instance of the client's class <err-name>>).errorClass`:
 * CSCB's class for that agent-director error. The instance is built as the
 * client builds one from an envelope (`spawn`, the name, a description).
 */
const adErrorClass: Entry = {
  synopsis: '<err-name>',
  async print(args, context) {
    const entry = 'classifyAdError'
    expectArguments(entry, args, ['err-name'])
    const [errName] = args
    const client = await context.importAgentDirectorClient()
    const base = client['AgentDirectorError']
    const errorClass = Object.hasOwn(client, errName) ? client[errName] : undefined
    if (typeof base !== 'function' || typeof errorClass !== 'function' || !(errorClass.prototype instanceof base)) {
      fail(PRINTER_FAIL_EXIT, `the installed agent-director client exports no error class ${errName}`)
    }
    const instance = new (errorClass as EnvelopeErrorClass)('spawn', errName, `${PRINTER_NAME}: ${errName}`)
    const classify = await packageFunction<(value: unknown) => { readonly errorClass?: unknown }>(context, 'ad-error-class.ts', entry)
    return builtString(entry, classify(instance).errorClass)
  },
}

/** `meetsPhase1Floor(<version>)`: `true` or `false`. */
const phase1Floor: Entry = {
  synopsis: '<version>',
  async print(args, context) {
    const entry = 'meetsPhase1Floor'
    expectArguments(entry, args, ['version'])
    const [version] = args
    const meets = await packageFunction<(version: string) => unknown>(context, 'ad-version-gate.ts', entry)
    const value = meets(version)
    if (typeof value !== 'boolean') fail(PRINTER_FAIL_EXIT, `${entry} answered a ${typeof value}, not a boolean`)
    return String(value)
  },
}

/** Fails with a usage failure unless `text` is an integer in decimal (an optional `-`, then digits); answers it as a `bigint`. */
function integerArgument(entry: string, name: string, text: string): bigint {
  if (!/^-?[0-9]+$/.test(text)) usageFail(`${entry}: <${name}> '${text}' is not an integer`)
  return BigInt(text)
}

/** The package's `AD_TMUX_KEYS`: the nine `[tmux]` keys, in order. */
async function packageTmuxKeys(context: EntryContext): Promise<readonly string[]> {
  const keys = await packageExport(context, 'ad-settings.ts', 'AD_TMUX_KEYS')
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string' || !/^[a-z_]+$/.test(k))) {
    fail(PRINTER_FAIL_EXIT, "the installed package's src/ad-settings.ts export AD_TMUX_KEYS is not an array of key names")
  }
  return keys as string[]
}

/**
 * The nine `[tmux]` values: `DEFAULT_AD_SETTINGS.tmux`, each key a
 * `<key>=<integer>` argument names taking that value instead. A key not in
 * `AD_TMUX_KEYS`, a key given twice or a value that is not an integer is a
 * usage failure.
 */
async function tmuxValuesFrom(entry: string, pairs: readonly string[], context: EntryContext): Promise<Record<string, bigint>> {
  const keys = await packageTmuxKeys(context)
  const defaults = await packageExport(context, 'ad-settings.ts', 'DEFAULT_AD_SETTINGS')
  const tmux = typeof defaults === 'object' && defaults !== null ? (defaults as Record<string, unknown>)['tmux'] : undefined
  if (typeof tmux !== 'object' || tmux === null) fail(PRINTER_FAIL_EXIT, "the installed package's src/ad-settings.ts export DEFAULT_AD_SETTINGS has no tmux table")
  const values: Record<string, bigint> = {}
  for (const key of keys) {
    const value = (tmux as Record<string, unknown>)[key]
    if (typeof value !== 'bigint') fail(PRINTER_FAIL_EXIT, `the installed package's DEFAULT_AD_SETTINGS.tmux.${key} is a ${typeof value}, not a bigint`)
    values[key] = value
  }
  const given = new Set<string>()
  for (const pair of pairs) {
    const eq = pair.indexOf('=')
    const key = eq < 0 ? pair : pair.slice(0, eq)
    if (eq < 0 || !keys.includes(key)) usageFail(`${entry}: '${pair}' is not <key>=<integer> for a [tmux] key (${keys.join(', ')})`)
    if (given.has(key)) usageFail(`${entry}: ${key} is given twice`)
    given.add(key)
    values[key] = integerArgument(entry, key, pair.slice(eq + 1))
  }
  return values
}

/** The values in effect for `<key>=<integer>` arguments: those `[tmux]` values (`tmuxValuesFrom`) and `DEFAULT_AD_SETTINGS_IN_EFFECT`'s `pauseTimeout`. */
async function settingsInEffectFrom(entry: string, pairs: readonly string[], context: EntryContext): Promise<object> {
  const tmux = await tmuxValuesFrom(entry, pairs, context)
  const inEffect = await packageExport(context, 'ad-settings.ts', 'DEFAULT_AD_SETTINGS_IN_EFFECT')
  const pauseTimeout = typeof inEffect === 'object' && inEffect !== null ? (inEffect as Record<string, unknown>)['pauseTimeout'] : undefined
  if (typeof pauseTimeout !== 'object' || pauseTimeout === null) fail(PRINTER_FAIL_EXIT, "the installed package's src/ad-settings.ts export DEFAULT_AD_SETTINGS_IN_EFFECT has no pauseTimeout")
  return { tmux, pauseTimeout }
}

/** `<name>(<the values in effect for the <key>=<integer> arguments>)` in decimal: a derived wait of `src/ad-settings.ts`. */
function derivedWaitEntry(name: string): Entry {
  return {
    synopsis: '[<key>=<integer>…]',
    async print(args, context) {
      const values = await settingsInEffectFrom(name, args, context)
      const derive = await packageFunction<(values: object) => unknown>(context, 'ad-settings.ts', name)
      return decimal(name, derive(values))
    },
  }
}

// ---------------------------------------------------------------------------
// The test-only timer override block's entries (b.2nr)
// ---------------------------------------------------------------------------

/** The package's `TEST_TIMER_OVERRIDE_KEYS` (src/config.ts): the override block's keys. */
async function packageOverrideKeys(context: EntryContext): Promise<readonly string[]> {
  const keys = await packageExport(context, 'config.ts', 'TEST_TIMER_OVERRIDE_KEYS')
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string' || !/^[a-z_]+$/.test(k))) {
    fail(PRINTER_FAIL_EXIT, "the installed package's src/config.ts export TEST_TIMER_OVERRIDE_KEYS is not an array of key names")
  }
  return keys as string[]
}

/** The package's inclusive upper bound for an override key: `MAX_TEST_TIMER_OVERRIDE_MS` for a `_ms` key, `MAX_TEST_TIMER_OVERRIDE_S` for a `_s` key. */
async function packageOverrideMax(context: EntryContext, key: string): Promise<number> {
  const inMs = key.endsWith('_ms')
  const max = inMs ? await packageExport(context, 'config.ts', 'MAX_TEST_TIMER_OVERRIDE_MS') : await packageExport(context, 'config.ts', 'MAX_TEST_TIMER_OVERRIDE_S')
  if (typeof max !== 'number' || !Number.isSafeInteger(max)) {
    fail(PRINTER_FAIL_EXIT, `the installed package's src/config.ts export ${inMs ? 'MAX_TEST_TIMER_OVERRIDE_MS' : 'MAX_TEST_TIMER_OVERRIDE_S'} is not a whole number`)
  }
  return max
}

/**
 * The override block for the `<key>=<integer>` arguments: each `<key>` one of
 * the package's `TEST_TIMER_OVERRIDE_KEYS`, given once, each `<integer>` a
 * positive integer within the key's bound (the loader's own rule, so the
 * printer refuses what the server would). An unknown key, a repeat, a value
 * out of range, only one of the two retry keys, or a retry ceiling below the
 * retry base is a usage failure.
 */
async function overrideBlockFrom(entry: string, pairs: readonly string[], context: EntryContext): Promise<Record<string, number>> {
  const keys = await packageOverrideKeys(context)
  const block: Record<string, number> = {}
  for (const pair of pairs) {
    const eq = pair.indexOf('=')
    const key = eq < 0 ? pair : pair.slice(0, eq)
    if (eq < 0 || !keys.includes(key)) usageFail(`${entry}: '${pair}' is not <key>=<integer> for a test timer override key (${keys.join(', ')})`)
    if (Object.hasOwn(block, key)) usageFail(`${entry}: ${key} is given twice`)
    const value = integerArgument(entry, key, pair.slice(eq + 1))
    const max = await packageOverrideMax(context, key)
    if (value < 1n || value > BigInt(max)) usageFail(`${entry}: ${key} must be a positive integer in [1, ${max}]`)
    block[key] = Number(value)
  }
  const base = block['unavailable_retry_base_s']
  const ceiling = block['unavailable_retry_ceiling_s']
  if ((base === undefined) !== (ceiling === undefined)) usageFail(`${entry}: unavailable_retry_base_s and unavailable_retry_ceiling_s must be given together`)
  if (base !== undefined && ceiling !== undefined && ceiling < base) usageFail(`${entry}: unavailable_retry_ceiling_s must not be below unavailable_retry_base_s`)
  return block
}

/** `testTimerOverridesBlock [<key>=<integer>…]`: the `test_timer_overrides` JSON object for the arguments, compact, keys in the package's order. */
const testTimerOverridesBlock: Entry = {
  synopsis: '[<key>=<integer>…]',
  async print(args, context) {
    const entry = 'testTimerOverridesBlock'
    const block = await overrideBlockFrom(entry, args, context)
    const ordered: Record<string, number> = {}
    for (const key of await packageOverrideKeys(context)) if (Object.hasOwn(block, key)) ordered[key] = block[key]!
    return JSON.stringify(ordered)
  },
}

/** `buildTestTimerOverridesLine(<the block for the arguments>)`: the loud line the server writes at start; the empty text for no override. */
const testTimerOverridesLine: Entry = {
  synopsis: '[<key>=<integer>…]',
  async print(args, context) {
    const entry = 'buildTestTimerOverridesLine'
    const block = await overrideBlockFrom(entry, args, context)
    const build = await packageFunction<(overrides: object) => unknown>(context, 'test-timer-overrides.ts', entry)
    const line = build(block)
    return line === undefined ? '' : builtString(entry, line)
  },
}

/** `effectiveTestTimer(<key>, <the block for the other arguments>)` in decimal: the timer's value in effect, the override or the production default. */
const effectiveTestTimerEntry: Entry = {
  synopsis: '<key> [<key>=<integer>…]',
  async print(args, context) {
    const entry = 'effectiveTestTimer'
    const [key, ...pairs] = args
    const keys = await packageOverrideKeys(context)
    if (key === undefined || !keys.includes(key)) usageFail(`${entry} takes <key> [<key>=<integer>…], <key> one of ${keys.join(', ')}`)
    const block = await overrideBlockFrom(entry, pairs, context)
    const effective = await packageFunction<(key: string, overrides: object) => unknown>(context, 'test-timer-overrides.ts', entry)
    return decimal(entry, effective(key, block))
  },
}

/**
 * `adLaunchBoundMs(<the values in effect>[, <B's floor in effect>])` in
 * decimal: B. The arguments are `<key>=<integer>` for both kinds of key: a
 * `[tmux]` key sets G's input, `dialog_ready_timeout_ms` (b.2nr: the test-only
 * override of B's floor, milliseconds, within the server's bound) sets B's
 * floor; with no `dialog_ready_timeout_ms` the function's own floor
 * (`DIALOG_READY_TIMEOUT_MS`) applies. Any other override key does not bear on
 * B and is a usage failure here.
 */
const adLaunchBoundEntry: Entry = {
  synopsis: '[<tmux-key>=<integer>|dialog_ready_timeout_ms=<integer>…]',
  async print(args, context) {
    const entry = 'adLaunchBoundMs'
    const floorKey = 'dialog_ready_timeout_ms'
    const floorPairs = args.filter((a) => a.startsWith(`${floorKey}=`))
    const tmuxPairs = args.filter((a) => !a.startsWith(`${floorKey}=`))
    const block = await overrideBlockFrom(entry, floorPairs, context)
    const values = await settingsInEffectFrom(entry, tmuxPairs, context)
    const bound = await packageFunction<(values: object, floorMs?: number) => unknown>(context, 'ad-settings.ts', entry)
    const floorMs = block[floorKey]
    return decimal(entry, floorMs === undefined ? bound(values) : bound(values, floorMs))
  },
}

/** `buildAdSettingsValuesLine(<path>, <the [tmux] values for the <key>=<integer> arguments>)`: the server's values line. */
const adSettingsValuesLine: Entry = {
  synopsis: '<path> [<key>=<integer>…]',
  async print(args, context) {
    const entry = 'buildAdSettingsValuesLine'
    const [path, ...pairs] = args
    if (path === undefined || path === '') usageFail(`${entry} takes <path> [<key>=<integer>…] (no <path> given)`)
    const values = await tmuxValuesFrom(entry, pairs, context)
    const build = await packageFunction<(path: string, values: object) => unknown>(context, 'ad-settings.ts', entry)
    return builtString(entry, build(path, values))
  },
}

/** `AD_TMUX_KEYS`, the nine keys in order, joined by single spaces. */
const adTmuxKeys: Entry = {
  synopsis: '',
  async print(args, context) {
    expectArguments('AD_TMUX_KEYS', args, [])
    return (await packageTmuxKeys(context)).join(' ')
  },
}

/** `pendingGraceMinimumSeconds(<create-timeout-ms>, <pipe-close-wait-ms>)` in decimal. */
const graceMinimum: Entry = {
  synopsis: '<create-timeout-ms> <pipe-close-wait-ms>',
  async print(args, context) {
    const entry = 'pendingGraceMinimumSeconds'
    expectArguments(entry, args, ['create-timeout-ms', 'pipe-close-wait-ms'])
    const [create, pipe] = args
    const minimum = await packageFunction<(create: bigint, pipe: bigint) => unknown>(context, 'ad-settings.ts', entry)
    return decimal(entry, minimum(integerArgument(entry, 'create-timeout-ms', create), integerArgument(entry, 'pipe-close-wait-ms', pipe)))
  },
}

/** `wholeMinutes(<ms>)` in decimal. */
const minutesOf: Entry = {
  synopsis: '<ms>',
  async print(args, context) {
    const entry = 'wholeMinutes'
    expectArguments(entry, args, ['ms'])
    const ms = integerArgument(entry, 'ms', args[0])
    const minutes = await packageFunction<(ms: number) => unknown>(context, 'ad-settings.ts', entry)
    return decimal(entry, minutes(Number(ms)))
  },
}

/** `stuckLaunchRelaunchingText(<persona-key>, <launch-bound-ms>)`: the stuck-launch post's relaunching text. */
const relaunchingText: Entry = {
  synopsis: '<persona-key> <launch-bound-ms>',
  async print(args, context) {
    const entry = 'stuckLaunchRelaunchingText'
    expectArguments(entry, args, ['persona-key', 'launch-bound-ms'])
    const [key, bound] = args
    const ms = integerArgument(entry, 'launch-bound-ms', bound)
    const build = await packageFunction<(key: string, launchBoundMs: number) => unknown>(context, 'pending-row.ts', entry)
    return builtString(entry, build(key, Number(ms)))
  },
}

/** `liveRowSequenceWaitArmedLine(<persona-ref>, <launch-start-ms>, <grace-ms>)`: the step-2 wait's armed line. */
const liveRowWaitArmedLine: Entry = {
  synopsis: '<persona-ref> <launch-start-ms> <grace-ms>',
  async print(args, context) {
    const entry = 'liveRowSequenceWaitArmedLine'
    expectArguments(entry, args, ['persona-ref', 'launch-start-ms', 'grace-ms'])
    const [ref, start, grace] = args
    const startMs = integerArgument(entry, 'launch-start-ms', start)
    const graceMs = integerArgument(entry, 'grace-ms', grace)
    const build = await packageFunction<(ref: string, launchStartMs: number, graceMs: number) => unknown>(context, 'live-row-sequence.ts', entry)
    return builtString(entry, build(ref, Number(startMs), Number(graceMs)))
  },
}

/** `liveRowSequenceWaitEndedLine(<persona-ref>)`: the step-2 wait's end line. */
const liveRowWaitEndedLine: Entry = {
  synopsis: '<persona-ref>',
  async print(args, context) {
    const entry = 'liveRowSequenceWaitEndedLine'
    expectArguments(entry, args, ['persona-ref'])
    const build = await packageFunction<(ref: string) => unknown>(context, 'live-row-sequence.ts', entry)
    return builtString(entry, build(args[0]))
  },
}

/** The released client's native malformed-config error name. */
const CONFIG_MALFORMED_ERR_NAME = 'ErrConfigMalformed'

/** Decode the real 0.12 error envelope rather than inventing an unknown-name error. */
async function configMalformedError(entry: string, description: string, context: EntryContext): Promise<unknown> {
  const client = await context.importAgentDirectorClient()
  const decode = client['errorFromEnvelope']
  const nativeClass = client[CONFIG_MALFORMED_ERR_NAME]
  if (typeof decode !== 'function' || typeof nativeClass !== 'function') {
    fail(PRINTER_FAIL_EXIT, `${entry}: the installed client lacks the native malformed-config decoder or class`)
  }
  const err = (decode as (verb: string, name: string, description: string) => unknown)('status', CONFIG_MALFORMED_ERR_NAME, description)
  if (!(err instanceof (nativeClass as new (...args: never[]) => object))) {
    fail(PRINTER_FAIL_EXIT, `${entry}: malformed-config decoding did not return the native class`)
  }
  return err
}

/** `adConfigMalformedOnset(<agent-director's ErrConfigMalformed with <description>>)`: the `ad-config-malformed` onset. */
const configMalformedOnset: Entry = {
  synopsis: '<description>',
  async print(args, context) {
    const entry = 'adConfigMalformedOnset'
    expectArguments(entry, args, ['description'])
    const err = await configMalformedError(entry, args[0], context)
    const build = await packageFunction<(err: unknown) => unknown>(context, 'outage-state.ts', entry)
    return builtString(entry, build(err))
  },
}

/**
 * `adConfigMalformedRaisedLine(<persona-key>, classifyAdError(<agent-director's
 * ErrConfigMalformed with <description>>))`: the server-log raise line.
 */
const configMalformedRaisedLine: Entry = {
  synopsis: '<persona-key> <description>',
  async print(args, context) {
    const entry = 'adConfigMalformedRaisedLine'
    expectArguments(entry, args, ['persona-key', 'description'])
    const [key, description] = args
    const err = await configMalformedError(entry, description, context)
    const classify = await packageFunction<(value: unknown) => unknown>(context, 'ad-error-class.ts', 'classifyAdError')
    const build = await packageFunction<(key: string, classification: unknown) => unknown>(context, 'outage-state.ts', entry)
    return builtString(entry, build(key, classify(err)))
  },
}

/** `adConfigMalformedClearedLine(<persona-key>)`: the server-log clear line. */
const configMalformedClearedLine: Entry = {
  synopsis: '<persona-key>',
  async print(args, context) {
    const entry = 'adConfigMalformedClearedLine'
    expectArguments(entry, args, ['persona-key'])
    const build = await packageFunction<(key: string) => unknown>(context, 'outage-state.ts', entry)
    return builtString(entry, build(args[0]))
  },
}

/** The printer's words for whether a read was accepted before a refused one. */
const HAD_ACCEPTED_READ: Readonly<Record<string, boolean>> = { accepted: true, none: false }

/** `buildAdSettingsRefusedReadLine(<path>, <reason>, <hadAcceptedRead>)`: the line of a run of refused reads. */
const refusedReadLine: Entry = {
  synopsis: '<path> <reason> <accepted|none>',
  async print(args, context) {
    const entry = 'buildAdSettingsRefusedReadLine'
    expectArguments(entry, args, ['path', 'reason', 'accepted|none'])
    const [path, reason, earlier] = args
    if (!Object.hasOwn(HAD_ACCEPTED_READ, earlier)) usageFail(`${entry}: the earlier read must be accepted or none (got '${earlier}')`)
    const build = await packageFunction<(path: string, reason: string, hadAcceptedRead: boolean) => unknown>(context, 'ad-settings.ts', entry)
    return builtString(entry, build(path, reason, HAD_ACCEPTED_READ[earlier]))
  },
}

/** The printer's words for the mode a retry ran in: `pendingOnly` false or true. */
const RETRY_MODES: Readonly<Record<string, boolean>> = { full: false, 'pending-only': true }

/** A whole number of at least 1, from a decimal argument; a usage failure otherwise. */
function retryNumber(entry: string, text: string): number {
  const n = integerArgument(entry, 'retry', text)
  if (n < 1n || n > BigInt(Number.MAX_SAFE_INTEGER)) usageFail(`${entry}: <retry> must be 1 or more (got '${text}')`)
  return Number(n)
}

/** `unavailableRetryRetryLine(<persona-key>, <retry>, <pendingOnly>)`: the line at the start of a retry. */
const retryLine: Entry = {
  synopsis: '<persona-key> <retry> <full|pending-only>',
  async print(args, context) {
    const entry = 'unavailableRetryRetryLine'
    expectArguments(entry, args, ['persona-key', 'retry', 'full|pending-only'])
    const [key, retryText, mode] = args
    if (!Object.hasOwn(RETRY_MODES, mode)) usageFail(`${entry}: the mode must be full or pending-only (got '${mode}')`)
    const build = await packageFunction<(key: string, retry: number, pendingOnly: boolean) => unknown>(context, 'unavailable-retry.ts', entry)
    return builtString(entry, build(key, retryNumber(entry, retryText), RETRY_MODES[mode]))
  },
}

/**
 * `unavailableRetryReArmedLine(<persona-key>, <retry>, <ranPendingOnly>, <reason>, undefined, <wait-ms>)`:
 * the re-armed line of a retry that left the mode as it was. Given a marker
 * <reason>, the text before the marker is the line's fixed head for that retry.
 */
const reArmedLine: Entry = {
  synopsis: '<persona-key> <retry> <full|pending-only> <reason> <wait-ms>',
  async print(args, context) {
    const entry = 'unavailableRetryReArmedLine'
    expectArguments(entry, args, ['persona-key', 'retry', 'full|pending-only', 'reason', 'wait-ms'])
    const [key, retryText, mode, reason, waitText] = args
    if (!Object.hasOwn(RETRY_MODES, mode)) usageFail(`${entry}: the mode must be full or pending-only (got '${mode}')`)
    const waitMs = integerArgument(entry, 'wait-ms', waitText)
    const build = await packageFunction<(key: string, retry: number, ranPendingOnly: boolean, reason: string, newMode: undefined, waitMs: number) => unknown>(
      context,
      'unavailable-retry.ts',
      entry,
    )
    return builtString(entry, build(key, retryNumber(entry, retryText), RETRY_MODES[mode], reason, undefined, Number(waitMs)))
  },
}

/**
 * `unavailableRetryStoppedLine(<persona-key>, <pendingOnly>, <row>, <reason>)`:
 * the line of a stop of the persona's retry timer; `none` for no row. Given
 * a marker <reason>, the text before ` — <marker>` is the line's fixed head.
 */
const stoppedLine: Entry = {
  synopsis: '<persona-key> <full|pending-only> <row|none> <reason>',
  async print(args, context) {
    const entry = 'unavailableRetryStoppedLine'
    expectArguments(entry, args, ['persona-key', 'full|pending-only', 'row|none', 'reason'])
    const [key, mode, row, reason] = args
    if (!Object.hasOwn(RETRY_MODES, mode)) usageFail(`${entry}: the mode must be full or pending-only (got '${mode}')`)
    const build = await packageFunction<(key: string, pendingOnly: boolean, row: string | undefined, reason: string) => unknown>(context, 'unavailable-retry.ts', entry)
    return builtString(entry, build(key, RETRY_MODES[mode], row === 'none' ? undefined : row, reason))
  },
}

/**
 * `liveRowSequenceRunLine(<persona-ref>, <step>, <run-number>, <the package's <placement-export>>)`:
 * the live-row sequence's line for one `find-missing` run.
 */
const liveRowRunLine: Entry = {
  synopsis: '<persona-ref> <step> <run-number> <placement-export>',
  async print(args, context) {
    const entry = 'liveRowSequenceRunLine'
    expectArguments(entry, args, ['persona-ref', 'step', 'run-number', 'placement-export'])
    const [ref, stepText, runText, placementExport] = args
    const step = integerArgument(entry, 'step', stepText)
    if (step !== 3n && step !== 4n) usageFail(`${entry}: <step> must be 3 or 4 (got '${stepText}')`)
    const run = integerArgument(entry, 'run-number', runText)
    if (!/^LIVE_ROW_RUN_[A-Z_]+$/.test(placementExport)) usageFail(`${entry}: <placement-export> '${placementExport}' is not a LIVE_ROW_RUN_… name`)
    const placement = await packageString(context, 'live-row-sequence.ts', placementExport)
    const build = await packageFunction<(ref: string, step: number, run: number, placement: string) => unknown>(context, 'live-row-sequence.ts', entry)
    return builtString(entry, build(ref, Number(step), Number(run), placement))
  },
}

/**
 * `buildAdCallTimeoutWarningLine(<call-timeout-ms>, <the values in effect for
 * the <key>=<integer> arguments>)`: the startup call-timeout warning, or the
 * empty text when the builder gives no line (the setting is above the need).
 */
const callTimeoutWarningLine: Entry = {
  synopsis: '<call-timeout-ms> [<key>=<integer>…]',
  async print(args, context) {
    const entry = 'buildAdCallTimeoutWarningLine'
    const [timeout, ...pairs] = args
    if (timeout === undefined || timeout === '') usageFail(`${entry} takes <call-timeout-ms> [<key>=<integer>…] (no <call-timeout-ms> given)`)
    const callTimeoutMs = integerArgument(entry, 'call-timeout-ms', timeout)
    const values = await settingsInEffectFrom(entry, pairs, context)
    const build = await packageFunction<(callTimeoutMs: number, values: object) => unknown>(context, 'ad-settings.ts', entry)
    const line = build(Number(callTimeoutMs), values)
    return line === undefined ? '' : builtString(entry, line)
  },
}

/**
 * `adCallTimeoutNeed(<the values in effect for the <key>=<integer>
 * arguments>)`: `<need-ms> <verb>`, the need in decimal and the verb whose
 * ceiling sets it. The values in effect carry DEFAULT_AD_SETTINGS_IN_EFFECT's
 * pauseTimeout, which is used, so a verb always sets the need; any other
 * answer is a failure.
 */
const callTimeoutNeed: Entry = {
  synopsis: '[<key>=<integer>…]',
  async print(args, context) {
    const entry = 'adCallTimeoutNeed'
    const values = await settingsInEffectFrom(entry, args, context)
    const need = await packageFunction<(values: object) => unknown>(context, 'ad-settings.ts', entry)
    const answer = need(values)
    const { needMs, setBy } = (typeof answer === 'object' && answer !== null ? answer : {}) as { needMs?: unknown; setBy?: unknown }
    const by = (typeof setBy === 'object' && setBy !== null ? setBy : {}) as { kind?: unknown; verb?: unknown }
    if (by.kind !== 'verb' || typeof by.verb !== 'string' || !/^[a-z-]+$/.test(by.verb)) {
      fail(PRINTER_FAIL_EXIT, `${entry} answered no verb that sets the need`)
    }
    return `${decimal(entry, needMs)} ${by.verb}`
  },
}

/** The package's launch-timeout forms (src/ad-error-class.ts), by export name. */
const LAUNCH_TIMEOUT_FORM_EXPORTS = ['LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT', 'LAUNCH_TIMEOUT_FORM_TMUX_UNRESPONSIVE'] as const

/**
 * `launchUnavailableFormText(<form>, '')` for entry `entry`: how the
 * launch-timeout get line names a launch timeout of the form `errName`,
 * which must be the value of one of the package's LAUNCH_TIMEOUT_FORM_…
 * exports (a usage failure otherwise).
 */
async function launchTimeoutFormTextOf(entry: string, errName: string, context: EntryContext): Promise<string> {
  const forms: string[] = []
  for (const name of LAUNCH_TIMEOUT_FORM_EXPORTS) forms.push(await packageString(context, 'ad-error-class.ts', name))
  if (!forms.includes(errName)) usageFail(`${entry}: '${errName}' is not one of the package's launch-timeout forms (${forms.join(', ')})`)
  const build = await packageFunction<(form: string, failure: string) => unknown>(context, 'session-manager.ts', 'launchUnavailableFormText')
  return builtString('launchUnavailableFormText', build(errName, ''))
}

/**
 * `launchUnavailableGetLine(<persona-ref>, <what>, <the form text of <err-name>>, <read>,
 * <this launch's row>, <the package's <outcome-export>>)`: the line of the one
 * `get` after a launch timeout. <launch-start> is the row's
 * `launch_started_at` as agent-director wrote it, read as the package reads
 * it (src/pending-row.ts parseLaunchStart), for this launch's row; `no` for
 * none. <outcome-export> is a `LAUNCH_UNAVAILABLE_OUTCOME_…` name of
 * src/session-manager.ts.
 */
const launchUnavailableGetLine: Entry = {
  synopsis: '<persona-ref> <what> <err-name> <read> <launch-start|no> <outcome-export>',
  async print(args, context) {
    const entry = 'launchUnavailableGetLine'
    expectArguments(entry, args, ['persona-ref', 'what', 'err-name', 'read', 'launch-start|no', 'outcome-export'])
    const [ref, what, errName, read, launchStart, outcomeExport] = args
    if (!/^LAUNCH_UNAVAILABLE_OUTCOME_[A-Z_]+$/.test(outcomeExport)) usageFail(`${entry}: <outcome-export> '${outcomeExport}' is not a LAUNCH_UNAVAILABLE_OUTCOME_… name`)
    const form = await launchTimeoutFormTextOf(entry, errName, context)
    const outcome = await packageString(context, 'session-manager.ts', outcomeExport)
    let thisLaunchRow: { readonly launchStartMs: number } | undefined
    if (launchStart !== 'no') {
      const parse = await packageFunction<(raw: unknown) => unknown>(context, 'pending-row.ts', 'parseLaunchStart')
      const launchStartMs = parse(launchStart)
      if (typeof launchStartMs !== 'number' || !Number.isFinite(launchStartMs)) usageFail(`${entry}: <launch-start> '${launchStart}' is not a launch start the package parses`)
      thisLaunchRow = { launchStartMs }
    }
    const build = await packageFunction<(ref: string, what: string, form: string, read: string, row: object | undefined, outcome: string) => unknown>(
      context,
      'session-manager.ts',
      entry,
    )
    return builtString(entry, build(ref, what, form, read, thisLaunchRow, outcome))
  },
}

/** `stuckLaunchAbortStartedLine(<persona-key>, <persona-ref>, <launch-start>)`: the stuck-launch abort's start line. */
const abortStartedLine: Entry = {
  synopsis: '<persona-key> <persona-ref> <launch-start>',
  async print(args, context) {
    const entry = 'stuckLaunchAbortStartedLine'
    expectArguments(entry, args, ['persona-key', 'persona-ref', 'launch-start'])
    const [key, ref, launchStart] = args
    const build = await packageFunction<(key: string, ref: string, launchStart: unknown) => unknown>(context, 'pending-row.ts', entry)
    return builtString(entry, build(key, ref, launchStart))
  },
}

/** `reprobeDeadLine(<persona-key>)`: the re-probe's line of a row that reads dead. */
const deadReprobeLine: Entry = {
  synopsis: '<persona-key>',
  async print(args, context) {
    const entry = 'reprobeDeadLine'
    expectArguments(entry, args, ['persona-key'])
    const build = await packageFunction<(key: string) => unknown>(context, 'restart.ts', entry)
    return builtString(entry, build(args[0]))
  },
}

/** The printer's words for a live-row sequence's launch form: `launches` true or false. */
const SEQUENCE_LAUNCH_FORMS: Readonly<Record<string, boolean>> = { launch: true, 'no-launch': false }

/**
 * `liveRowSequenceStartLine(<persona-ref>, <request>)`: the live-row
 * sequence's start line, the request holding the fields the line names: the
 * entry step the package exports as <entry-step-export> (a
 * `LIVE_ROW_SEQUENCE_ENTRY_…` name), <instance-id>, <last-read>, the launch
 * form and <alert-context>.
 */
const sequenceStartLine: Entry = {
  synopsis: '<persona-ref> <entry-step-export> <instance-id> <last-read> <launch|no-launch> <alert-context>',
  async print(args, context) {
    const entry = 'liveRowSequenceStartLine'
    expectArguments(entry, args, ['persona-ref', 'entry-step-export', 'instance-id', 'last-read', 'launch|no-launch', 'alert-context'])
    const [ref, stepExport, instanceId, lastReadState, form, alertContext] = args
    if (!/^LIVE_ROW_SEQUENCE_ENTRY_[A-Z_]+$/.test(stepExport)) usageFail(`${entry}: <entry-step-export> '${stepExport}' is not a LIVE_ROW_SEQUENCE_ENTRY_… name`)
    if (!Object.hasOwn(SEQUENCE_LAUNCH_FORMS, form)) usageFail(`${entry}: the launch form must be launch or no-launch (got '${form}')`)
    const entryStep = await packageExport(context, 'live-row-sequence.ts', stepExport)
    if (typeof entryStep !== 'number') fail(PRINTER_FAIL_EXIT, `the installed package's src/live-row-sequence.ts export ${stepExport} is a ${typeof entryStep}, not a number`)
    const build = await packageFunction<(ref: string, request: object) => unknown>(context, 'live-row-sequence.ts', entry)
    return builtString(entry, build(ref, { instanceId, lastReadState, entryStep, launches: SEQUENCE_LAUNCH_FORMS[form], alertContext }))
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
async function adErrorClassLabel(name: string): Promise<string> {
  if (!/^AD_ERROR_CLASS_[A-Z_]+$/.test(name)) throw new PrinterFailure(`class '${name}' is not an AD_ERROR_CLASS_* export's name`, USAGE_EXIT)
  return text('ad-error-class.ts', name)
}

/** The persona named `name` as the CLI's lines take it: its name and key (`personaKey`). */
async function cliPersona(name: string): Promise<{ readonly name: string; readonly key: string }> {
  return { name, key: (await fn<(n: string) => string>('persona-identity.ts', 'personaKey'))(name) }
}

/**
 * The teardown's next-life line after a successful pause
 * (`teardownNextLifeAfterPauseLine`, src/cli-teardown.ts) for the persona
 * named `name`, cut around its elapsed milliseconds.
 */
async function teardownNextLifeAfterPauseParts(name: string): Promise<{ readonly head: string; readonly tail: string }> {
  const line = (await fn<(p: object, ms: number) => string>('cli-teardown.ts', 'teardownNextLifeAfterPauseLine'))(await cliPersona(name), COUNT_STAND_IN)
  return around(line, String(COUNT_STAND_IN), 'teardownNextLifeAfterPauseLine')
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
  adErrorClass: { args: ['class'], print: async ([name]) => adErrorClassLabel(name) },
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
        { errorClass: await adErrorClassLabel(className), description: DESCRIPTION_STAND_IN },
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
        { errorClass: await adErrorClassLabel(className), description: DESCRIPTION_STAND_IN },
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
      const errorClass = await adErrorClassLabel(className)
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
  // Scenario 9's clean_restart forms (test-21; b.ku8).
  CLEAN_RESTART_SERVER_FLAG: { args: [], print: () => text('cli-teardown.ts', 'CLEAN_RESTART_SERVER_FLAG') },
  CLEAN_RESTART_USAGE: { args: [], print: () => text('cli.ts', 'CLEAN_RESTART_USAGE') },
  cleanRestartRelaunchWaitMs: {
    args: ['delay'],
    print: async ([raw]) => String((await fn<(s: number) => number>('cli-teardown.ts', 'cleanRestartRelaunchWaitMs'))(count(raw))),
  },
  CLEAN_EXIT_RELAUNCH_DELAY: { args: [], print: () => text('restart.ts', 'CLEAN_EXIT_RELAUNCH_DELAY') },
  cleanExitRelaunchLine: {
    args: ['key', 'delay'],
    print: async ([key, raw]) => (await fn<(k: string, d: number) => string>('restart.ts', 'cleanExitRelaunchLine'))(key, count(raw)),
  },
  CLEAN_RESTART_NAMED_BOTS_LINE: { args: [], print: () => text('cli-teardown.ts', 'CLEAN_RESTART_NAMED_BOTS_LINE') },
  cleanRestartRelaunchedLine: {
    args: ['name'],
    print: async ([name]) => (await fn<(p: object) => string>('cli-teardown.ts', 'cleanRestartRelaunchedLine'))(await cliPersona(name)),
  },
  cleanRestartNotRelaunchedLine: {
    args: ['name', 'wait-ms'],
    print: async ([name, raw]) =>
      (await fn<(p: object, w: number) => string>('cli-teardown.ts', 'cleanRestartNotRelaunchedLine'))(await cliPersona(name), count(raw)),
  },
  'teardownNextLifeAfterPauseLine.head': {
    args: ['name'],
    print: async ([name]) => (await teardownNextLifeAfterPauseParts(name)).head,
  },
  'teardownNextLifeAfterPauseLine.tail': {
    args: ['name'],
    print: async ([name]) => (await teardownNextLifeAfterPauseParts(name)).tail,
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
  // Scenario 12 (test-19; b.jg5 SRJ-1414).
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

/** The live-row sequence's step-2 `get` line for `ref` when it read the row `missing`. */
async function liveRowSequenceStep2GetMissingLine(ref: string): Promise<string> {
  const lineOf = await functionExport('live-row-sequence.ts', 'liveRowSequenceGetLine')
  const row = await stringExport('live-row-sequence.ts', 'LIVE_ROW_READ_ROW')
  return builtText('live-row-sequence.ts', 'liveRowSequenceGetLine', lineOf(ref, 2, { kind: row, row: { state: 'missing' } }))
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
  return [service, 'tag_prompt=1', `${personaPrefix}${key}`, `${configDirPrefix}${label}`].join('\n')
}

/** The one-function entries, by the name a script passes. */
const FN_ENTRIES: Readonly<Record<string, FnEntry>> = {
  'DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds': noArguments('DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds', () =>
    wholeNumberAt('ad-settings.ts', 'DEFAULT_AD_SETTINGS', ['tmux', 'pending_grace_seconds']),
  ),
  'DEFAULT_AD_SETTINGS.tmux.create_timeout_ms': noArguments('DEFAULT_AD_SETTINGS.tmux.create_timeout_ms', () =>
    wholeNumberAt('ad-settings.ts', 'DEFAULT_AD_SETTINGS', ['tmux', 'create_timeout_ms']),
  ),
  'DEFAULT_AD_SETTINGS.tmux.stopping_window_seconds': noArguments('DEFAULT_AD_SETTINGS.tmux.stopping_window_seconds', () =>
    wholeNumberAt('ad-settings.ts', 'DEFAULT_AD_SETTINGS', ['tmux', 'stopping_window_seconds']),
  ),
  LAUNCH_UNAVAILABLE_OUTCOME_COVERED_NO_APPROVER: noArguments('LAUNCH_UNAVAILABLE_OUTCOME_COVERED_NO_APPROVER', () =>
    stringExport('session-manager.ts', 'LAUNCH_UNAVAILABLE_OUTCOME_COVERED_NO_APPROVER'),
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
  PENDING_ROW_RUN_NOT_JUDGED: noArguments('PENDING_ROW_RUN_NOT_JUDGED', () => stringExport('pending-row.ts', 'PENDING_ROW_RUN_NOT_JUDGED')),
  PENDING_ROW_RULE_ORIGIN_RETRY: noArguments('PENDING_ROW_RULE_ORIGIN_RETRY', () => stringExport('pending-row.ts', 'PENDING_ROW_RULE_ORIGIN_RETRY')),
  'adLaunchBoundMs(DEFAULT_AD_SETTINGS_IN_EFFECT)': noArguments('adLaunchBoundMs(DEFAULT_AD_SETTINGS_IN_EFFECT)', async () => {
    const bound = await functionExport('ad-settings.ts', 'adLaunchBoundMs')
    const value: unknown = bound(await exportOf('ad-settings.ts', 'DEFAULT_AD_SETTINGS_IN_EFFECT'))
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new PrinterFailure("the installed package's src/ad-settings.ts adLaunchBoundMs gave no whole number of milliseconds", PRINTER_FAIL_EXIT)
    }
    return String(value)
  }),
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
  liveRowSequenceStep2GetMissingLine: oneArgument('liveRowSequenceStep2GetMissingLine', 'ref', liveRowSequenceStep2GetMissingLine),
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

// ---------------------------------------------------------------------------
// test-29's entries (test-29-invited-channels.sh; b.deo SRI-1401, SRI-1404):
// the invited-channel texts, every one from persona-diagnostics.ts,
// registry.ts, reload-plan.ts, channel-delivery.ts, delivery-decision.ts or
// config.ts.
// ---------------------------------------------------------------------------

/** persona-diagnostics.ts's fungible-mode `unclaimed-channel` reasons test-29 meets, each printed as it is. */
const UNCLAIMED_REASON_NAMES: readonly string[] = [
  'UNCLAIMED_REASON_EXTERNALLY_SHARED',
  'UNCLAIMED_REASON_FLAG_MISSING',
  'UNCLAIMED_REASON_FLAG_NOT_BOOLEAN',
]

/** The package's `DELIVERY_MODES` (config.ts): fails unless it is a list of strings. */
async function deliveryModes(context: EntryContext): Promise<readonly string[]> {
  const modes = await packageExport(context, 'config.ts', 'DELIVERY_MODES')
  if (!Array.isArray(modes) || !modes.every((m) => typeof m === 'string')) {
    fail(PRINTER_FAIL_EXIT, "the installed package's src/config.ts export DELIVERY_MODES is not a list of strings")
  }
  return modes as readonly string[]
}

/** Fails with a usage failure unless `value` is one of the package's `DELIVERY_MODES`. */
async function checkDeliveryArgument(context: EntryContext, entry: string, name: string, value: string): Promise<void> {
  const modes = await deliveryModes(context)
  if (!modes.includes(value)) usageFail(`${entry}: <${name}> must be one of ${modes.join(', ')} (got '${value}')`)
}

/**
 * `channelModeOf({ <MODE_SWITCH_SETTING>: <true|false> })` (config.ts): the
 * name of the mode the switch's value picks, the switch keyed by the
 * package's MODE_SWITCH_SETTING (reload-plan.ts).
 */
const channelModeOfSwitch: Entry = {
  synopsis: '<strict|open>',
  async print(args, context) {
    const entry = 'channelModeOf'
    expectArguments(entry, args, ['strict|open'])
    const [value] = args
    if (value !== 'strict' && value !== 'open') usageFail(`${entry}: the mode must be strict or open`)
    const modeOf = await packageFunction<(config: Record<string, string>) => unknown>(context, 'config.ts', entry)
    return builtString(entry, modeOf({ [await packageString(context, 'reload-plan.ts', 'MODE_SWITCH_SETTING')]: value! }))
  },
}

/**
 * `formatPersonaDiagnostic({ class, index, name, key, cause })`
 * (persona-diagnostics.ts): a persona line with no path, <class> one of the
 * package's PERSONA_DIAGNOSTIC_CLASSES and <index> a whole number in decimal.
 */
const personaDiagnosticLine: Entry = {
  synopsis: '<class> <index> <name> <key> <cause>',
  async print(args, context) {
    const entry = 'formatPersonaDiagnostic'
    expectArguments(entry, args, ['class', 'index', 'name', 'key', 'cause'])
    const [diagnosticClass, index, name, key, cause] = args
    const classes = await packageExport(context, 'persona-diagnostics.ts', 'PERSONA_DIAGNOSTIC_CLASSES')
    if (!Array.isArray(classes) || !classes.includes(diagnosticClass)) usageFail(`${entry}: <class> '${diagnosticClass}' is not one of the package's PERSONA_DIAGNOSTIC_CLASSES`)
    if (!/^(0|[1-9][0-9]{0,8})$/.test(index!)) usageFail(`${entry}: <index> '${index}' is not a whole number in decimal`)
    const format = await packageFunction<(diagnostic: { class: string; index: number; name: string; key: string; cause: string }) => unknown>(
      context,
      'persona-diagnostics.ts',
      entry,
    )
    return builtString(entry, format({ class: diagnosticClass!, index: Number(index), name: name!, key: key!, cause: cause! }))
  },
}

/**
 * `modeSwitchLine(<mode>, <personas>)` (reload-plan.ts): the switch's preview
 * line turning <mode> on, for the personas named, in the order given, each
 * keyed by the package's personaKey, as the config loader derives it.
 */
const modeSwitchLineEntry: Entry = {
  synopsis: '<mode> [<persona-name>…]',
  async print(args, context) {
    const entry = 'modeSwitchLine'
    const [mode, ...names] = args
    if (mode === undefined || mode === '') usageFail(`${entry} takes <mode> [<persona-name>…] (got no mode)`)
    if (names.some((n) => n === '')) usageFail(`${entry}: a <persona-name> is empty`)
    const modes = await packageExport(context, 'config.ts', 'CHANNEL_MODES')
    if (!Array.isArray(modes) || !modes.includes(mode)) usageFail(`${entry}: <mode> '${mode}' is not one of the package's CHANNEL_MODES`)
    const personaKey = await packageFunction<(name: string) => unknown>(context, 'persona-identity.ts', 'personaKey')
    const build = await packageFunction<(mode: string, personas: readonly { name: string; key: unknown }[]) => unknown>(context, 'reload-plan.ts', entry)
    return builtString(entry, build(mode, names.map((name) => ({ name, key: personaKey(name) }))))
  },
}

/**
 * `fungibleUnclaimedChannelCause(<channel>, <refusal>)` (persona-diagnostics.ts),
 * <refusal> one of the package's FUNGIBLE_REFUSALS (delivery-decision.ts).
 */
const fungibleUnclaimedCause: Entry = {
  synopsis: '<channel> <refusal>',
  async print(args, context) {
    const entry = 'fungibleUnclaimedChannelCause'
    expectArguments(entry, args, ['channel', 'refusal'])
    const [channel, refusal] = args
    const refusals = await packageExport(context, 'delivery-decision.ts', 'FUNGIBLE_REFUSALS')
    if (!Array.isArray(refusals) || !refusals.includes(refusal)) usageFail(`${entry}: <refusal> '${refusal}' is not one of the package's FUNGIBLE_REFUSALS`)
    const build = await packageFunction<(channel: string, refusal: string) => unknown>(context, 'persona-diagnostics.ts', entry)
    return builtString(entry, build(channel!, refusal!))
  },
}

/** `openChannelCause(<channel>, <public|private>, <delivery>)` (persona-diagnostics.ts). */
const openCause: Entry = {
  synopsis: '<channel> <public|private> <delivery>',
  async print(args, context) {
    const entry = 'openChannelCause'
    expectArguments(entry, args, ['channel', 'public|private', 'delivery'])
    const [channel, channelType, delivery] = args
    if (channelType !== 'public' && channelType !== 'private') usageFail(`${entry}: the channel type must be public or private (got '${channelType}')`)
    await checkDeliveryArgument(context, entry, 'delivery', delivery!)
    const build = await packageFunction<(channel: string, channelType: string, delivery: string) => unknown>(context, 'persona-diagnostics.ts', entry)
    return builtString(entry, build(channel!, channelType, delivery!))
  },
}

/**
 * `channelDeliverySetCause(<channel>, <before>, <after>, <delivery>)`
 * (persona-diagnostics.ts); <before> is the package's NO_STORED_CHOICE for no
 * stored choice before the call (passed as undefined), else a delivery.
 */
const deliverySetCause: Entry = {
  synopsis: '<channel> <before> <after> <delivery>',
  async print(args, context) {
    const entry = 'channelDeliverySetCause'
    expectArguments(entry, args, ['channel', 'before', 'after', 'delivery'])
    const [channel, before, after, delivery] = args
    const none = await packageString(context, 'persona-diagnostics.ts', 'NO_STORED_CHOICE')
    if (before !== none) await checkDeliveryArgument(context, entry, 'before', before!)
    await checkDeliveryArgument(context, entry, 'after', after!)
    await checkDeliveryArgument(context, entry, 'delivery', delivery!)
    const build = await packageFunction<(channel: string, before: string | undefined, after: string, delivery: string) => unknown>(
      context,
      'persona-diagnostics.ts',
      entry,
    )
    return builtString(entry, build(channel!, before === none ? undefined : before, after!, delivery!))
  },
}

/** Expected result derived from the installed validated attempt evidence after
 * a scenario call. The scenario supplies its independently expected effective
 * choice, or an unavailable reason; this never creates authority or writes. */
const deliveryAttemptResult: Entry = {
  synopsis: '<config> <record> <key> <channel> <delivery> <attempt-id> <new|history> <effective|channel-removed>',
  async print(args, context) {
    const entry = 'channelDeliveryAttemptResultText'
    expectArguments(entry, args, ['config', 'record', 'key', 'channel', 'delivery', 'attempt-id', 'new|history', 'effective|channel-removed'])
    const [configPath, recordPath, key, channel, delivery, attemptId, history, effective] = args
    if (history !== 'new' && history !== 'history') usageFail(`${entry}: expected new or history`)
    const { state } = await readSharedConfiguration(context, configPath!, recordPath!)
    const create = await packageFunction<(path: string, state: object, deps: object) => {
      incarnation(key: string): string | undefined; choice(key: string, channel: string): string | undefined;
      config(): { channel_mode: string; personas: Array<{ key: string; name: string }> };
      lookupBotAttempt(key: string, life: string, request: object): { kind: string; historical?: boolean } | undefined;
    }>(context, 'shared-channels.ts', 'createSharedChannelAuthority')
    const authority = create(recordPath!, state, { sourcePath: configPath! })
    const outcome = authority.lookupBotAttempt(key!, authority.incarnation(key!)!, { channel, delivery, attempt_id: attemptId, intent: 'retry' })
    if (!outcome) throw new PrinterFailure('attempt evidence is absent', PRINTER_FAIL_EXIT)
    if (outcome.kind === 'applied') outcome.historical = history === 'history'
    const config = authority.config(), saved = authority.choice(key!, channel!)
    const unavailable = DELIVERY_UNAVAILABLE_REASONS.includes(effective as typeof DELIVERY_UNAVAILABLE_REASONS[number])
    if (!unavailable) await checkDeliveryArgument(context, entry, 'effective', effective!)
    const current = unavailable ? { kind: 'unavailable', reason: effective, ...(effective === 'channel-removed' ? {} : { saved }) } :
      { kind: 'available', mode: config.channel_mode, facts: { saved, effective } }
    const build = await packageFunction<(name: string, key: string, channel: string, result: object, current: object) => unknown>(context, 'registry.ts', entry)
    return builtString(entry, build(config.personas.find(p => p.key === key)!.name, key!, channel!, outcome, current))
  },
}

/** Read and validate the entire authority with the installed production reader.
 * These entries print only a boolean/number or a production diagnostic, never
 * submitted configuration, credentials, parser errors or arbitrary fields.
 * The reader reads a private copy: CSCB replaces the record by rename, which
 * leaves the copied inode's bytes one committed version, while the reader
 * refuses a live file whose metadata changes during the read. No retry. The
 * parser and projections still take the record's own path. A failure names
 * only its stage and the error's errno-style code.
 */
async function readSharedConfiguration(context: EntryContext, configPath: string, recordPath: string) {
  const read = await packageFunction<(path: string) => Uint8Array>(context, 'config.ts', 'readPersonaConfigBytes')
  const parse = await packageFunction<(bytes: Uint8Array, path: string, deps: { sourcePath: string }) =>
    { sourceBytesBase64: string; revision: number; personas: Record<string, {
      incarnation: string; declaration: unknown;
      assignments: Record<string, { delivery: string; threadHybridSince?: string }>;
      leaves: unknown; removedDestinations: unknown;
      createdAt?: number; resetOrder?: number; resetDestination?: unknown;
      membership: Record<string, { member: boolean; boundary: number; identity: string; isExtSharedChannel?: boolean; channelType?: string }>;
      membershipInventory?: { incarnation: string; identity: string };
    }>; retiredIdentities: unknown; pendingIntent?: unknown } | undefined>(context, 'shared-channels.ts', 'parseSharedChannelState')
  const applied = await packageFunction<(state: object, path: string) => { port: number; resume_enabled: boolean }>(
    context, 'shared-channels.ts', 'sharedAppliedConfig')
  let scratch: string | undefined, stage = 'copy'
  try {
    scratch = mkdtempSync(join(tmpdir(), 'fmk-authority-'))
    const copy = join(scratch, 'record')
    copyFileSync(recordPath, copy)
    stage = 'read'
    const bytes = read(copy)
    stage = 'parse'
    const state = parse(bytes, recordPath, { sourcePath: configPath })
    if (!state) throw new Error()
    return { state, applied: applied(state, configPath), read }
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    const named = typeof code === 'string' && /^E[A-Z0-9]{1,15}$/.test(code) ? ` ${code}` : ''
    throw new PrinterFailure(`shared configuration authority could not be read or validated (${stage}${named})`, PRINTER_FAIL_EXIT)
  } finally {
    try { if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

// sharedConfigurationMatches <config-path> <record-path> <reviewed|applied>:
// both require byte-exact reviewed input; applied additionally requires the
// resolved applied configuration to equal that input. Reviewed-only callers
// may have legitimate automatic channel changes, which the parser validates.
const sharedConfigurationMatches: Entry = {
  synopsis: '<config-path> <record-path> <reviewed|applied>',
  async print(args, context) {
    expectArguments('sharedConfigurationMatches', args, ['config-path', 'record-path', 'comparison'])
    const [configPath, recordPath, comparison] = args
    if (comparison !== 'reviewed' && comparison !== 'applied') usageFail('comparison must be reviewed or applied')
    const { state, applied, read } = await readSharedConfiguration(context, configPath, recordPath)
    const parse = await packageFunction<(bytes: Uint8Array, path: string, dir: string) => unknown>(
      context, 'config.ts', 'parsePersonaConfigBytes')
    try {
      const expected = read(configPath)
      if (!Buffer.from(state.sourceBytesBase64, 'base64').equals(expected)) throw new Error()
      if (comparison === 'applied' && !isDeepStrictEqual(applied, parse(expected, configPath, dirname(configPath)))) throw new Error()
    } catch {
      throw new PrinterFailure('shared configuration does not preserve the expected reviewed input or applied configuration', PRINTER_FAIL_EXIT)
    }
    return ''
  },
}

function preservedAuthorityEntry(includeIntent: boolean): Entry { return {
  synopsis: '<config-path> <before-record> <after-record>',
  async print(args, context) {
    expectArguments('sharedAuthorityPreserved', args, ['config-path', 'before-record', 'after-record'])
    const [configPath, beforePath, afterPath] = args
    const before = await readSharedConfiguration(context, configPath, beforePath)
    const after = await readSharedConfiguration(context, configPath, afterPath)
    const preserved = ({ state, applied }: typeof before) => ({
      sourceBytesBase64: state.sourceBytesBase64, applied, retiredIdentities: state.retiredIdentities, ...(includeIntent ? { pendingIntent: state.pendingIntent } : {}),
      personas: Object.fromEntries(Object.entries(state.personas).map(([key, life]) => [key, {
        incarnation: life.incarnation, declaration: life.declaration, assignments: life.assignments,
        leaves: life.leaves, removedDestinations: life.removedDestinations,
        createdAt: life.createdAt, resetOrder: life.resetOrder, resetDestination: life.resetDestination,
        membership: Object.fromEntries(Object.entries(life.membership).map(([channel, fact]) => [channel, {
          member: fact.member, boundary: fact.boundary, identity: fact.identity,
          isExtSharedChannel: fact.isExtSharedChannel, channelType: fact.channelType,
        }])),
        inventoryIdentity: life.membershipInventory && { incarnation: life.membershipInventory.incarnation, identity: life.membershipInventory.identity },
      }])),
    })
    if (!isDeepStrictEqual(preserved(before), preserved(after))) {
      throw new PrinterFailure('shared authority changed a preserved choice, identity, boundary or reviewed input', PRINTER_FAIL_EXIT)
    }
    return ''
  },
}

}
const sharedAuthorityPreserved = preservedAuthorityEntry(true)
const sharedApplicationPreserved = preservedAuthorityEntry(false)

const sharedThreadStamp: Entry = {
  synopsis: '<config-path> <record-path> <persona-key> <channel>',
  async print(args, context) {
    expectArguments('sharedThreadStamp', args, ['config-path', 'record-path', 'persona-key', 'channel'])
    const [configPath, recordPath, key, channel] = args
    const { state } = await readSharedConfiguration(context, configPath, recordPath)
    const life = Object.hasOwn(state.personas, key) ? state.personas[key] : undefined
    const assignment = life && Object.hasOwn(life.assignments, channel) ? life.assignments[channel] : undefined
    if (!life || assignment?.delivery !== 'thread_hybrid' || !assignment.threadHybridSince) {
      throw new PrinterFailure('expected a current thread_hybrid Channel Stamp', PRINTER_FAIL_EXIT)
    }
    return JSON.stringify({ incarnation: life.incarnation, threadHybridSince: assignment.threadHybridSince })
  },
}

// sharedConfigurationValue <config-path> <record-path> <port|resume_enabled|channel_mode>:
// the applied view only, never the pending input or an arbitrary JSON path.
const sharedConfigurationValue: Entry = {
  synopsis: '<config-path> <record-path> <port|resume_enabled|channel_mode>',
  async print(args, context) {
    expectArguments('sharedConfigurationValue', args, ['config-path', 'record-path', 'setting'])
    const [configPath, recordPath, setting] = args
    if (setting !== 'port' && setting !== 'resume_enabled' && setting !== 'channel_mode') usageFail('setting must be port, resume_enabled or channel_mode')
    const { applied } = await readSharedConfiguration(context, configPath, recordPath)
    if (setting === 'channel_mode') {
      const modeOf = await packageFunction<(config: object) => unknown>(context, 'config.ts', 'channelModeOf')
      const mode = modeOf(applied)
      if (mode !== 'strict' && mode !== 'open') throw new PrinterFailure('shared configuration setting has an unexpected type', PRINTER_FAIL_EXIT)
      return mode
    }
    const value = applied[setting]
    if (setting === 'port' ? !Number.isSafeInteger(value) : typeof value !== 'boolean') {
      throw new PrinterFailure('shared configuration setting has an unexpected type', PRINTER_FAIL_EXIT)
    }
    return String(value)
  },
}

/** The scenario writes this result to config.json.request. All declarations
 * and grammar come from the installed production modules. */
const operatorReviewRequest: Entry = {
  synopsis: '<config-path> <record-path> <request-id> <action> [<persona>/<channel>/<delivery> ...]',
  async print(args, context) {
    if (args.length < 4) usageFail('operatorReviewRequest needs config, record, request id and action')
    const [configPath, recordPath, requestId, action, ...targets] = args
    const { state, read } = await readSharedConfiguration(context, configPath, recordPath)
    const parse = await packageFunction<typeof import('../../../src/config.ts').parsePersonaConfigBytes>(context, 'config.ts', 'parsePersonaConfigBytes')
    const buildAssignment = await packageFunction<typeof import('../../../src/reload-request.ts').buildOperatorAssignment>(context, 'reload-request.ts', 'buildOperatorAssignment')
    const build = await packageFunction<typeof import('../../../src/reload-request.ts').buildReviewRequest>(context, 'reload-request.ts', 'buildReviewRequest')
    const compose = await packageFunction<typeof import('../../../src/reload-request.ts').composeReviewRequest>(context, 'reload-request.ts', 'composeReviewRequest')
    try {
      const candidate = parse(read(configPath), configPath, dirname(configPath))
      const assignments = targets.map(target => {
        const [name, channel, delivery, extra] = target.split('/')
        const persona = candidate.personas.find(p => p.name === name)
        if (!persona || extra !== undefined) throw new Error()
        return buildAssignment(persona, state.personas[persona.key]?.incarnation ?? null, channel, delivery as import('../../../src/config.ts').DeliveryMode)
      })
      const intent = (state.pendingIntent as { operator?: { generation: number } } | undefined)?.operator
      return compose(build(requestId, intent?.generation ?? 0, action as import('../../../src/reload-request.ts').ReviewRequest['action'], assignments)).trimEnd()
    } catch { throw new PrinterFailure('operator request could not be built from the current input and authority', PRINTER_FAIL_EXIT) }
  },
}
const operatorReviewPending: Entry = {
  synopsis: '<config-path> <record-path> <pending-path> <request-id>',
  async print(args, context) {
    expectArguments('operatorReviewPending', args, ['config-path', 'record-path', 'pending-path', 'request-id'])
    const [configPath, recordPath, pendingPath, requestId] = args
    const { state, read } = await readSharedConfiguration(context, configPath, recordPath)
    const ledger = await packageFunction<typeof import('../../../src/reload-review.ts').reviewLedger>(context, 'reload-review.ts', 'reviewLedger')
    const fingerprint = await packageFunction<(text: string) => string | undefined>(context, 'reload-fingerprint.ts', 'parsePendingFingerprint')
    const intent = (state.pendingIntent as import('../../../src/shared-channels.ts').SharedChannelState['pendingIntent'] | undefined)?.operator as import('../../../src/reload-request.ts').OperatorIntent | undefined
    try {
      const active = ledger(state as import('../../../src/shared-channels.ts').SharedChannelState)?.active
      if (!intent?.requests[requestId] || intent.requests[requestId].generation !== intent.generation || !intent.requested || !active || active.intentGeneration !== intent.generation ||
          active.fingerprint !== fingerprint(Buffer.from(read(pendingPath)).toString('utf8'))) throw new Error()
    } catch { throw new PrinterFailure('the request has no current pending review', PRINTER_FAIL_EXIT) }
    return ''
  },
}
const operatorReviewCancelled: Entry = {
  synopsis: '<config-path> <record-path> <submitted-request-json>',
  async print(args, context) {
    expectArguments('operatorReviewCancelled', args, ['config-path', 'record-path', 'submitted-request-json'])
    const [configPath, recordPath, submitted] = args
    const { state } = await readSharedConfiguration(context, configPath, recordPath)
    const parse = await packageFunction<typeof import('../../../src/reload-request.ts').parseReviewRequestBytes>(context, 'reload-request.ts', 'parseReviewRequestBytes')
    const ledger = await packageFunction<typeof import('../../../src/reload-review.ts').reviewLedger>(context, 'reload-review.ts', 'reviewLedger')
    try {
      const request = parse(Buffer.from(submitted, 'utf8'))
      const shared = state as import('../../../src/shared-channels.ts').SharedChannelState
      const intent = shared.pendingIntent.operator as import('../../../src/reload-request.ts').OperatorIntent | undefined
      if (!request || request.action !== 'cancel' || !intent || !Object.hasOwn(intent.requests, request.request_id)) throw new Error()
      const recorded = intent.requests[request.request_id]
      if (!isDeepStrictEqual(recorded.request, request) || recorded.generation !== intent.generation ||
          intent.requested || intent.assignments.length !== 0 || ledger(shared)?.active) throw new Error()
    } catch { throw new PrinterFailure('the exact cancellation is not durably recorded and cleared', PRINTER_FAIL_EXIT) }
    return ''
  },
}
const sharedReviewConsumed: Entry = {
  synopsis: '<config-path> <record-path> <review-path>',
  async print(args, context) {
    expectArguments('sharedReviewConsumed', args, ['config-path', 'record-path', 'review-path'])
    const [configPath, recordPath, reviewPath] = args
    const { state, read } = await readSharedConfiguration(context, configPath, recordPath)
    const ledger = await packageFunction<typeof import('../../../src/reload-review.ts').reviewLedger>(context, 'reload-review.ts', 'reviewLedger')
    const fingerprint = await packageFunction<(text: string) => string | undefined>(context, 'reload-fingerprint.ts', 'parsePendingFingerprint')
    try {
      const fp = fingerprint(Buffer.from(read(reviewPath)).toString('utf8'))
      const outcome = fp && ledger(state as import('../../../src/shared-channels.ts').SharedChannelState)?.outcomes[fp]
      if (!outcome || outcome.status !== 'consumed' || outcome.revision > state.revision) throw new Error()
    } catch { throw new PrinterFailure('the exact reviewed transaction has not been consumed', PRINTER_FAIL_EXIT) }
    return ''
  },
}

/** Exact bytes, including invalid UTF-8 in damaged authority. Read-only,
 * scratch-fenced and capped even when the opened file grows during a read. */
function sharedScratchBytes(path: string): Buffer {
  let fd: number | undefined
  try {
    const root = process.env['SCENARIO_ROOT']
    if (!root || !resolve(path).startsWith(resolve(root) + sep) ||
        !realpathSync(path).startsWith(realpathSync(root) + sep)) throw new Error()
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > SHARED_EVIDENCE_BYTES) throw new Error()
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!count) throw new Error()
      offset += count
    }
    const after = fstatSync(fd)
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error()
    return bytes
  } catch { throw new PrinterFailure('missing, changed, unsafe or oversized scratch evidence', PRINTER_FAIL_EXIT) }
  finally { if (fd !== undefined) closeSync(fd) }
}

/** Same fixture contract as tests/test-helpers/shared-channels.ts, using
 * installed exports: that unit helper's relative src imports are unavailable
 * in /tests in the image. No validation grammar is reimplemented here. */
const sharedRecoveryRequest: Entry = {
  synopsis: '<request-id> <damaged-file> [replacement-input-file]',
  async print(args, context) {
    if (args.length !== 2 && args.length !== 3) usageFail('sharedRecoveryRequest needs id, damaged file and optional replacement input')
    const [id, evidencePath, replacementPath] = args
    const format = await packageExport(context, 'reload-request.ts', 'REVIEW_REQUEST_FORMAT')
    const hash = await packageFunction<typeof import('../../../src/shared-recovery.ts').recoveryHash>(context, 'shared-recovery.ts', 'recoveryHash')
    const parse = await packageFunction<typeof import('../../../src/shared-recovery.ts').parseSharedRecoveryRequest>(context, 'shared-recovery.ts', 'parseSharedRecoveryRequest')
    const evidence = sharedScratchBytes(evidencePath)
    const replacement = replacementPath === undefined ? undefined : sharedScratchBytes(replacementPath)
    const request = parse({ format, request_id: id, evidence_sha256: hash(evidence),
      ...(replacement === undefined ? { action: 'restore' } : { action: 'replace', replacement_source_base64: replacement.toString('base64') }) })
    evidenceAssert(request, 'invalid recovery request arguments')
    return JSON.stringify(request)
  },
}

function sharedRecoveryObservation(consumed: boolean): Entry { return {
  synopsis: '<config-path> <record-path> <retained-request-file> <review-file>',
  async print(args, context) {
    expectArguments('sharedRecoveryObservation', args, ['config', 'record', 'request', 'review'])
    const [config, record, requestPath, reviewPath] = args
    const parse = await packageFunction<typeof import('../../../src/shared-channels.ts').parseSharedChannelState>(context, 'shared-channels.ts', 'parseSharedChannelState')
    const readRequest = await packageFunction<typeof import('../../../src/shared-recovery.ts').readSharedRecoveryRequest>(context, 'shared-recovery.ts', 'readSharedRecoveryRequest')
    const ledgerOf = await packageFunction<typeof import('../../../src/reload-review.ts').reviewLedger>(context, 'reload-review.ts', 'reviewLedger')
    const matches = await packageFunction<typeof import('../../../src/reload-review.ts').reviewMatches>(context, 'reload-review.ts', 'reviewMatches')
    const fingerprint = await packageFunction<typeof import('../../../src/reload-fingerprint.ts').parsePendingFingerprint>(context, 'reload-fingerprint.ts', 'parsePendingFingerprint')
    const compose = await packageFunction<typeof import('../../../src/reload-fingerprint.ts').composePendingFile>(context, 'reload-fingerprint.ts', 'composePendingFile')
    const render = await packageFunction<typeof import('../../../src/reload-recovery.ts').renderSharedRecovery>(context, 'reload-recovery.ts', 'renderSharedRecovery')
    try {
      const request = readRequest(sharedScratchBytes(requestPath))
      const state = parse(sharedScratchBytes(record), record, { sourcePath: config })
      const reviewBytes = sharedScratchBytes(reviewPath)
      const fp = fingerprint(new TextDecoder('utf-8', { fatal: true }).decode(reviewBytes))
      const recovery = state?.recovery
      if (!state || !request || !fp || !recovery) throw new Error()
      const ledger = ledgerOf(state)
      if (consumed) {
        // An activated record keeps only its identity (SR-5.2), so the retained
        // full request matches it by request ID, action and evidence hash.
        const outcome = ledger?.outcomes[fp]
        if (recovery.phase !== 'active' || recovery.activation.fingerprint !== fp ||
            recovery.request.request_id !== request.request_id || recovery.request.action !== request.action ||
            recovery.request.evidence_sha256 !== request.evidence_sha256 ||
            outcome?.status !== 'consumed' || outcome.revision !== recovery.activation.order ||
            outcome.revision > state.revision || ledger?.active || ledger?.retirement) throw new Error()
      } else {
        // A stage keeps the whole request, a replacement's chosen input included.
        const active = ledger?.active
        if (recovery.phase !== 'review' || recovery.cancelled || !isDeepStrictEqual(recovery.request, request) ||
            !active || active.fingerprint !== fp || !matches(state, active) ||
            !reviewBytes.equals(Buffer.from(compose(fp, render(state)))) ||
            !sharedScratchBytes(config).equals(Buffer.from(recovery.preparedBase64, 'base64'))) throw new Error()
      }
      // No damaged/prepared/replacement bytes or credentials are emitted.
      return JSON.stringify({ request_id: request.request_id, action: request.action, boundary: recovery.boundary,
        phase: recovery.phase, fingerprint: fp, revision: state.revision })
    } catch { throw new PrinterFailure(consumed ? 'exact recovery review is not durably consumed' : 'exact recovery request has no current durable preview', PRINTER_FAIL_EXIT) }
  },
} }
const sharedRecoveryPending = sharedRecoveryObservation(false)
const sharedRecoveryConsumed = sharedRecoveryObservation(true)

// Test40's explicit, stopped manual transition. This is a fixture for a
// deliberately limited old-release scenario, never a runtime migration.
const stoppedDowngradeBaseline: Entry = {
  synopsis: '<config-path> <record-path>',
  async print(args, context) {
    expectArguments('stoppedDowngradeBaseline', args, ['config-path', 'record-path'])
    const [configPath, recordPath] = args
    const { state, applied } = await readSharedConfiguration(context, configPath, recordPath)
    if (applied.resume_enabled !== false || (state.pendingIntent as { operator?: { requested?: boolean } } | undefined)?.operator?.requested) {
      throw new PrinterFailure('stopped downgrade requires applied resume=false and no outstanding operator request', PRINTER_FAIL_EXIT)
    }
    // Preserve every applied setting; the previous release validates its own
    // format before the fixture replaces either active file.
    return JSON.stringify((state as import('../../../src/shared-channels.ts').SharedChannelState).applied, null, 2)
  },
}

// test-47's refused starts (t1.tad.5i SR-1.2, SR-2.4, AC-U05, U07, U12, U13).
// The installed reload controller resolves the start over the scenario's own
// files, as the server does. Every write, delete or store it could reach
// fails the entry, so it prints only a refusal that changes nothing.
const reloadStartRefusalLine: Entry = {
  synopsis: '<config|record> <config-path> [<setting>]',
  async print(args, context) {
    const entry = 'reloadStartRefusalLine'
    expectSomeArguments(entry, args, ['config|record', 'config-path', 'setting'], 2)
    const [source, configPath, setting] = args
    if (source !== 'config' && source !== 'record') usageFail(`${entry}: the source must be config or record (got '${source}')`)
    const filePaths = await packageFunction<(configPath: string) => object>(context, 'reload.ts', 'reloadFilePaths')
    const create = await packageFunction<(deps: object) => { resolveStart(): { kind: string; source?: string; line?: string } }>(
      context, 'reload.ts', 'createReloadController')
    const reached: string[] = []
    const refuse = (what: string) => (): never => { reached.push(what); throw new Error(`${PRINTER_NAME} reaches no ${what}`) }
    const forbidden = (what: string) => new Proxy({}, { get: (_target, member) => refuse(`${what}.${String(member)}`)() })
    const logged: string[] = []
    let outcome: { kind: string; source?: string; line?: string }
    try {
      outcome = create({
        paths: filePaths(configPath), log: (line: string) => { logged.push(line) },
        write: refuse('write'), remove: refuse('remove'), applySteps: {},
        lifecycle: forbidden('lifecycle'), retiredKeys: forbidden('retired-key store'), oldLifeHolds: forbidden('old-life hold set'),
        channelDelivery: refuse('stored-choice store'), stopDelivery: refuse('delivery stop'),
      }).resolveStart()
    } catch (err) {
      throw new PrinterFailure(`${entry}: the start resolution threw: ${err instanceof Error ? err.message : String(err)}`, PRINTER_FAIL_EXIT)
    }
    if (reached.length > 0) throw new PrinterFailure(`${entry}: the start would use ${reached.join(', ')}; this entry prints only a refusal that changes nothing`, PRINTER_FAIL_EXIT)
    if (outcome.kind !== 'refused' || typeof outcome.line !== 'string') throw new PrinterFailure(`${entry}: the start does not refuse these files`, PRINTER_FAIL_EXIT)
    if (outcome.source !== source) throw new PrinterFailure(`${entry}: the start refuses the ${outcome.source}, not the ${source}`, PRINTER_FAIL_EXIT)
    if (!logged.includes(outcome.line)) throw new PrinterFailure(`${entry}: the refusal line was not logged`, PRINTER_FAIL_EXIT)
    if (setting !== undefined && !outcome.line.includes(`: ${setting} `)) {
      throw new PrinterFailure(`${entry}: the refusal does not name ${setting} as its rule's setting`, PRINTER_FAIL_EXIT)
    }
    return outcome.line
  },
}

// The loader's sentence for a removed key, naming its replacement, from the
// installed resolvePersonaConfig over a candidate holding only that key: at
// the top level, then in one persona entry. A current setting is refused, and
// a rule naming no current setting after the key is not a removal.
const removedKeyRefusal: Entry = {
  synopsis: '<removed-key>',
  async print(args, context) {
    const entry = 'removedKeyRefusal'
    expectArguments(entry, args, ['removed-key'])
    const [key] = args
    const lists = [await packageExport(context, 'config.ts', 'PERSONA_TOP_LEVEL_KEYS'), await packageExport(context, 'config.ts', 'PERSONA_ENTRY_KEYS')]
    if (lists.some((keys) => !Array.isArray(keys) || keys.some((k) => typeof k !== 'string'))) {
      fail(PRINTER_FAIL_EXIT, `${entry}: the installed package's src/config.ts key lists are not arrays of strings`)
    }
    const current = (lists as string[][]).flat()
    if (current.includes(key)) usageFail(`${entry}: '${key}' is a current setting, not a removed one`)
    const resolveConfig = await packageFunction<(raw: unknown, configDir: string, home: string, options: object) => unknown>(context, 'config.ts', 'resolvePersonaConfig')
    for (const candidate of [{ [key]: true, personas: [] }, { personas: [{ [key]: true }] }]) {
      try {
        resolveConfig(candidate, '/nonexistent-fmk-texts-config-dir', '/nonexistent-fmk-texts-home', { env: {} })
      } catch (err) {
        const message = err instanceof Error ? err.message : ''
        const at = message.indexOf(`: ${key} `)
        if (at < 0) continue
        const sentence = message.slice(at + 2)
        const rest = sentence.slice(key.length)
        if (current.some((replacement) => new RegExp(`\\b${replacement}\\b`).test(rest))) return sentence
      }
    }
    throw new PrinterFailure(`${entry}: the installed loader has no rule removing '${key}' that names a current setting as its replacement`, PRINTER_FAIL_EXIT)
  },
}

// test-40's earlier release (Task t2.yiv.sf.39 Decision 1: the published
// 0.18.0 package). These entries import the earlier install's own modules
// from <earlier-package-dir>, never the package under test.

/** Module `relPath` of the earlier release whose package directory (holding its package.json and src/) is `pkgDir`. */
async function earlierPackageModule(entry: string, pkgDir: string, relPath: string): Promise<Record<string, unknown>> {
  if (!isAbsolute(pkgDir)) usageFail(`${entry}: <earlier-package-dir> must be an absolute path`)
  let name: unknown
  try { name = (JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { name?: unknown }).name } catch { name = undefined }
  if (name !== 'claude-slack-channel-bots') fail(PRINTER_FAIL_EXIT, `${entry}: ${pkgDir} is not an installed claude-slack-channel-bots package`)
  return await import(join(pkgDir, 'src', relPath))
}

/** Function export `name` of the earlier release's `relPath`. */
async function earlierPackageFunction<F>(entry: string, pkgDir: string, relPath: string, name: string): Promise<F> {
  const value = (await earlierPackageModule(entry, pkgDir, relPath))[name]
  if (typeof value !== 'function') fail(PRINTER_FAIL_EXIT, `${entry}: the earlier package's src/${relPath} exports no function ${name}`)
  return value as F
}

// The earlier release's server-log line for one queue record it sets aside at
// start: its own createDeliveryReporting given the record-unreadable event its
// queue raises, with no alert. 0.18.0 exports no builder for the
// `line=… path=…` part, so its reporting writes the whole line.
const earlierQueueRecordUnreadableLine: Entry = {
  synopsis: '<earlier-package-dir> <persona-name> <key> <line> <quarantine-path>',
  async print(args) {
    const entry = 'earlierQueueRecordUnreadableLine'
    expectArguments(entry, args, ['earlier-package-dir', 'persona-name', 'key', 'line', 'quarantine-path'])
    const [pkgDir, name, key, line, quarantinePath] = args
    const lineNumber = Number(integerArgument(entry, 'line', line))
    if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) usageFail(`${entry}: <line> must be a positive line number`)
    const create = await earlierPackageFunction<(deps: object) => { queueEvent(event: object): void }>(entry, pkgDir, 'delivery-notices.ts', 'createDeliveryReporting')
    const unused = new Proxy({}, { get: () => { throw new Error('unused') } })
    const logged: string[] = [], posted: string[] = []
    const reporting = create({
      queue: unused, episodes: unused, state: () => ({ up: false }),
      persona: (k: string) => (k === key ? { name, key } : undefined),
      log: (text: string) => { logged.push(text) }, notify: (_k: string, text: string) => { posted.push(text) },
    })
    reporting.queueEvent({ type: 'record-unreadable', key, line: lineNumber, quarantinePath, alert: false })
    await new Promise((settle) => setTimeout(settle, 0))
    if (logged.length !== 1 || posted.length !== 0) {
      throw new PrinterFailure(`${entry}: the earlier release logged ${logged.length} line(s) and posted ${posted.length} notice(s) for one set-aside record`, PRINTER_FAIL_EXIT)
    }
    return logged[0]
  },
}

// The earlier release's notice body for queue records it could not read at
// start, from its own buildQueueRecordUnreadableNotice and renderPersonaRef.
// Its notifier adds its own persona prefix when it posts.
const earlierQueueRecordUnreadableNotice: Entry = {
  synopsis: '<earlier-package-dir> <persona-name> <key> <count> <quarantine-path>',
  async print(args) {
    const entry = 'earlierQueueRecordUnreadableNotice'
    expectArguments(entry, args, ['earlier-package-dir', 'persona-name', 'key', 'count', 'quarantine-path'])
    const [pkgDir, name, key, count, quarantinePath] = args
    const records = Number(integerArgument(entry, 'count', count))
    if (!Number.isSafeInteger(records) || records < 1) usageFail(`${entry}: <count> must be a positive count`)
    const ref = await earlierPackageFunction<(name: string, key: string) => unknown>(entry, pkgDir, 'persona-identity.ts', 'renderPersonaRef')
    const build = await earlierPackageFunction<(persona: unknown, count: number, path: string) => unknown>(entry, pkgDir, 'delivery-notices.ts', 'buildQueueRecordUnreadableNotice')
    return builtString(entry, build(ref(name, key), records, quarantinePath))
  },
}

const sharedAuthorityStartLine: Entry = {
  synopsis: '<config-path> <record-path>',
  async print(args, context) {
    expectArguments('reloadSharedAuthorityStartLine', args, ['config-path', 'record-path'])
    const [configPath, recordPath] = args
    const { state } = await readSharedConfiguration(context, configPath, recordPath)
    const build = await packageFunction<(path: string, revision: number) => string>(context, 'reload.ts', 'reloadSharedAuthorityStartLine')
    return build(recordPath, state.revision)
  },
}

const DELIVERY_UNAVAILABLE_REASONS = [
  'channel-removed', 'absent', 'external-sharing', 'invalid-channel', 'installation-unverified',
  'current-membership-missing', 'event-order-conflict', 'history-unresolved', 'event-not-durable',
  'shared-state-unreadable', 'eligibility-missing',
] as const

async function readScenarioAuthority(context: EntryContext, config: string, record: string) {
  const { state } = await readSharedConfiguration(context, config, record)
  const create = await packageFunction<typeof import('../../../src/shared-channels.ts').createSharedChannelAuthority>(context, 'shared-channels.ts', 'createSharedChannelAuthority')
  // Only projections are called. No reconciliation, journal load, setter or
  // recovery runs in this read-only printer.
  return create(record, state as import('../../../src/shared-channels.ts').SharedChannelState, { sourcePath: config })
}
function sharedProjection(field: 'saved' | 'since' | 'created' | 'effective'): Entry {
  return {
    synopsis: '<config> <record> <key>' + (field === 'created' ? '' : ' <channel>') + (field === 'effective' ? ' <eligible|unavailable-reason>' : ''),
    async print(args, context) {
      const names = ['config', 'record', 'key', ...(field === 'created' ? [] : ['channel']), ...(field === 'effective' ? ['membership'] : [])]
      expectArguments('shared projection', args, names)
      const [config, record, key, channel, membership] = args
      const authority = await readScenarioAuthority(context, config, record)
      if (!authority.incarnation(key)) throw new PrinterFailure('persona is absent from authority', PRINTER_FAIL_EXIT)
      if (field === 'created') return String(authority.threadMemoryCreated(key))
      if (field === 'saved') return authority.choice(key, channel) ?? ''
      if (field === 'since') {
        const stamp = authority.channelStamp(key, channel)
        return stamp?.kind === 'decided' ? stamp.threadHybridSince ?? '' : ''
      }
      // The caller must establish live membership independently. Never rebuild
      // a current generation from historical disk evidence.
      const current = await packageFunction<typeof import('../../../src/channel-delivery.ts').currentChannelDeliveryFacts>(context, 'channel-delivery.ts', 'currentChannelDeliveryFacts')
      const store = await packageFunction<typeof import('../../../src/channel-delivery.ts').createChannelDeliveryStore>(context, 'channel-delivery.ts', 'createChannelDeliveryStore')
      let reading: import('../../../src/channel-membership.ts').MembershipReading
      if (membership === 'eligible') {
        // currentChannelDeliveryFacts consumes only the discriminant. Do not
        // invent membership identity, lifetime or generation in this projection.
        reading = { kind: 'eligible' } as import('../../../src/channel-membership.ts').MembershipReading
      } else if (membership === 'absent' || membership === 'external-sharing' || membership === 'invalid-channel') {
        reading = { kind: 'ineligible', reason: membership }
      } else if (DELIVERY_UNAVAILABLE_REASONS.includes(membership as typeof DELIVERY_UNAVAILABLE_REASONS[number]) && membership !== 'channel-removed') {
        reading = { kind: 'unresolved', reason: membership as import('../../../src/channel-membership.ts').MembershipFault }
      } else usageFail('effective projection needs eligible or a membership unavailability reason')
      const facts = current(key, channel, authority.config().channel_mode, store(authority), reading)
      return facts.kind === 'available' ? facts.facts.effective : facts.reason
    },
  }
}
const sharedAttemptOrder: Entry = {
  synopsis: '<config> <record> <key> [channel]',
  async print(args, context) {
    if (args.length !== 3 && args.length !== 4) usageFail('sharedAttemptOrder needs config, record, key and optional channel')
    const [config, record, key, channel] = args
    const authority = await readScenarioAuthority(context, config, record)
    const outcomes = Object.values(authority.snapshot().outcomes.botAttempts ?? {})
      .filter((row): row is Extract<import('../../../src/channel-delivery-attempt.ts').SharedBotAttempt, { status: 'applied' }> =>
        row.key === key && row.status === 'applied' && (channel === undefined || row.channel === channel))
      .sort((a, b) => a.resolvedOrder - b.resolvedOrder)
    return outcomes.map(row => JSON.stringify({ key: row.key, incarnation: row.incarnation, channel: row.channel,
      delivery: row.delivery, startedOrder: row.startedOrder, resolvedOrder: row.resolvedOrder })).join('\n')
  },
}
const acceptedQueueItems: Entry = {
  synopsis: '<journal-path>',
  async print(args, context) {
    expectArguments('acceptedQueueItems', args, ['journal-path'])
    const parse = await packageFunction<typeof import('../../../src/delivery-queue.ts').parseQueueRecord>(context, 'delivery-queue.ts', 'parseQueueRecord')
    let bytes: string
    try { bytes = readFileSync(args[0], 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw new PrinterFailure('queue journal cannot be read', PRINTER_FAIL_EXIT)
    }
    const rows: import('../../../src/delivery-queue.ts').AcceptedRecord[] = []
    // Read-only observation of a live append: defer the incomplete last line.
    // Complete damaged records fail; never repair a journal from a helper.
    for (const line of bytes.slice(0, bytes.lastIndexOf('\n') + 1).split('\n').filter(Boolean)) {
      const row = parse(line)
      if (!row) throw new PrinterFailure('queue journal contains an invalid complete record', PRINTER_FAIL_EXIT)
      if (row.kind === 'accepted' && !('compact' in row)) rows.push(row)
    }
    rows.sort((a, b) => a.seq - b.seq)
    return rows.map(row => JSON.stringify(row)).join('\n')
  },
}

// These are observations, never store loads. Cap each regular file and the
// number of inputs; a live append's incomplete final line is deferred. Errors
// name evidence classes only, never include message bodies or file contents.
// A labelled read's failure adds its label, failed stage, errno code, file
// type, size and bytes read: never a path. It is still not retried.
const SHARED_EVIDENCE_BYTES = 64 * 1024 * 1024
function sharedFileType(stat: import('node:fs').Stats): string {
  return stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : stat.isFIFO() ? 'fifo' : stat.isSocket() ? 'socket'
    : stat.isCharacterDevice() ? 'char' : stat.isBlockDevice() ? 'block' : stat.isSymbolicLink() ? 'symlink' : 'other'
}
function sharedEvidenceBytes(path: string, label?: string): string {
  let fd: number | undefined
  let stage = 'open', type = 'unknown', size = 'unknown', read = 0
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    stage = 'stat'
    const stat = fstatSync(fd)
    type = sharedFileType(stat); size = String(stat.size)
    if (!stat.isFile() || stat.size > SHARED_EVIDENCE_BYTES) throw new Error()
    stage = 'read'
    const bytes = Buffer.alloc(stat.size)
    while (read < bytes.length) {
      const count = readSync(fd, bytes, read, bytes.length - read, read)
      if (!count) throw new Error()
      read += count
    }
    return bytes.toString('utf8')
  } catch (error) {
    const code = (error as { code?: unknown } | undefined)?.code
    const errno = typeof code === 'string' && /^E[A-Z0-9]{1,15}$/.test(code) ? code : 'none'
    const facts = label ? ` (${label} stage=${stage} errno=${errno} type=${type} size=${size} read=${read})` : ''
    throw new PrinterFailure('missing, unreadable, oversized or non-regular shared evidence' + facts, PRINTER_FAIL_EXIT)
  }
  finally { if (fd !== undefined) closeSync(fd) }
}
function sharedLines(path: string, label?: string): string[] {
  const bytes = sharedEvidenceBytes(path, label)
  return bytes.slice(0, bytes.lastIndexOf('\n') + 1).split('\n').filter(Boolean)
}
function sharedJSON(path: string): any[] {
  return sharedLines(path).map(sharedParseJSON)
}
function sharedParseJSON(line: string): any {
  try { return JSON.parse(line) }
  catch { throw new PrinterFailure('invalid shared evidence JSON', PRINTER_FAIL_EXIT) }
}
function evidenceAssert(value: unknown, reason: string): asserts value {
  if (!value) throw new PrinterFailure(reason, PRINTER_FAIL_EXIT)
}
type SharedQueueRecord = import('../../../src/delivery-queue.ts').QueueRecord
type SharedAccepted = import('../../../src/delivery-queue.ts').AcceptedRecord
function sharedAccepts(rows: SharedQueueRecord[]): SharedAccepted[] {
  return rows.filter((r): r is SharedAccepted => r.kind === 'accepted' && !('compact' in r))
    .sort((a, b) => a.seq - b.seq)
}
function sharedAcceptanceRank(row: SharedAccepted): number {
  return row.hold?.on === 'post' ? 0 : row.hold?.on === 'memory' ? 1 : 2
}
function sharedAcceptanceBody(row: SharedAccepted) {
  const { hold, released_at, attempt_high_watermark, ...immutable } = row
  return immutable
}
function sharedHoldTransition(before: SharedAccepted, after: SharedAccepted,
  observations: readonly SharedQueueRecord[][]): void {
  evidenceAssert(isDeepStrictEqual(sharedAcceptanceBody(before), sharedAcceptanceBody(after)), 'conflicting acceptance evidence')
  const hold = before.hold
  evidenceAssert(hold && before.released_at === undefined, 'unsupported hold transition')
  // compactOne writes this allocation in the same rewrite as the new acceptance.
  // Snapshots omit attempt_high_watermark, so that field alone is not a witness.
  evidenceAssert(observations.some(rows => rows.some(r => isDeepStrictEqual(r, after)) &&
    rows.some(r => r.kind === 'accepted' && 'compact' in r && r.compact === 'allocation' && r.seq >= after.seq)),
  'hold transition lacks same-observation compaction evidence')
  const resolutions = observations.flat().filter((r): r is import('../../../src/delivery-queue.ts').HoldResolutionRecord =>
    r.seq === before.seq && ['released', 'hold-withdrawn', 'parked'].includes(r.kind))
  const released = new Set(resolutions.filter(r => r.kind === 'released').map(r => r.at))
  const parked = new Set(resolutions.filter(r => r.kind === 'parked').map(r => r.at))
  evidenceAssert(!resolutions.some(r => r.kind === 'hold-withdrawn') && released.size <= 1 && parked.size <= 1,
    'conflicting hold resolution evidence')
  if (after.hold) {
    evidenceAssert(hold.on === 'post' && hold.root_unknown && after.released_at === undefined &&
      isDeepStrictEqual(after.hold, { on: 'memory', thread_ts: hold.thread_ts, stamp: hold.stamp, arrived_at: hold.arrived_at }),
    'unsupported hold parking evidence')
  } else {
    evidenceAssert(after.released_at !== undefined && [...released].every(at => at === after.released_at),
      'conflicting hold release evidence')
  }
  if (hold.on === 'post' && parked.size) evidenceAssert(hold.root_unknown, 'unsupported hold parking evidence')
}
function sharedMergeQueueRecords(observations: readonly SharedQueueRecord[][],
  slackKey: typeof import('../../../src/delivery-queue.ts').slackKeyString): SharedQueueRecord[] {
  const rows = new Map<string, SharedQueueRecord>(), accepted = new Map<number, SharedAccepted[]>()
  const keys = new Map<string, number>()
  for (const observation of observations) for (const row of observation) {
    if (row.kind !== 'accepted' || 'compact' in row) { rows.set(JSON.stringify(row), row); continue }
    const variants = accepted.get(row.seq) ?? []
    if (!variants.some(r => isDeepStrictEqual(r, row))) variants.push(row)
    accepted.set(row.seq, variants)
    if (!rows.has(`accepted:${row.seq}`)) rows.set(`accepted:${row.seq}`, row)
    if (row.key) {
      const key = slackKey(row.key), previous = keys.get(key)
      evidenceAssert(previous === undefined || previous === row.seq, 'acceptance key changed sequence')
      keys.set(key, row.seq)
    }
  }
  for (const variants of accepted.values()) {
    variants.sort((a, b) => sharedAcceptanceRank(a) - sharedAcceptanceRank(b))
    // Check every pair: a later released form must not hide conflicting Post
    // Hold operations, Memory Hold stamps, release times or other metadata.
    for (let i = 0; i < variants.length; i++) for (let j = i + 1; j < variants.length; j++) {
      evidenceAssert(sharedAcceptanceRank(variants[i]) < sharedAcceptanceRank(variants[j]), 'conflicting acceptance evidence')
      sharedHoldTransition(variants[i], variants[j], observations)
    }
    // Keep the most informative observed acceptance, including the original
    // Post Hold's operations. Never synthesize a resolution removed by compaction.
    rows.set(`accepted:${variants[0].seq}`, variants[0])
  }
  return [...rows.values()].sort((a, b) => a.seq - b.seq)
}
async function sharedQueueRecords(context: EntryContext, paths: readonly string[],
  originals?: SharedQueueRecord[]): Promise<SharedQueueRecord[]> {
  evidenceAssert(paths.length > 0 && paths.length <= 32, 'queue evidence needs 1–32 files')
  const parse = await packageFunction<typeof import('../../../src/delivery-queue.ts').parseQueueRecord>(context, 'delivery-queue.ts', 'parseQueueRecord')
  const slackKey = await packageFunction<typeof import('../../../src/delivery-queue.ts').slackKeyString>(context, 'delivery-queue.ts', 'slackKeyString')
  const observations = paths.map((path, i) => {
    const seen = new Set<number>()
    return sharedLines(path, `input=${i + 1} role=${i ? 'prior' : 'current'}`).map(line => {
      const row = parse(line)
      evidenceAssert(row, 'invalid complete queue evidence record')
      // The watermark is compaction bookkeeping, never immutable acceptance.
      if (row.kind === 'accepted' && !('compact' in row)) {
        evidenceAssert(!seen.has(row.seq), 'duplicate acceptance in one journal')
        seen.add(row.seq)
        delete row.attempt_high_watermark
      }
      return row
    })
  })
  const rows = sharedMergeQueueRecords(observations, slackKey)
  if (originals) {
    const expected = sharedAccepts(originals).filter(r => r.reminder_for === undefined)
    const actual = sharedAccepts(rows)
    evidenceAssert(expected.length && expected.every(r => actual.some(a => a.seq === r.seq)), 'original workload unavailable')
    // Compare using exactly the union's validated lifecycle representation.
    // The original supplies no receipt or missing workload to the returned view.
    sharedMergeQueueRecords([...observations, originals], slackKey)
  }
  return rows
}
const sharedQueueSnapshot: Entry = {
  synopsis: '<current-journal> [prior-snapshot...]',
  async print(args, context) {
    return (await sharedQueueRecords(context, args)).map(r => JSON.stringify(r)).join('\n') + '\n'
  },
}
async function sharedMemory(context: EntryContext, path: string) {
  const parse = await packageFunction<typeof import('../../../src/thread-memory.ts').parseThreadMemoryRecord>(context, 'thread-memory.ts', 'parseThreadMemoryRecord')
  return sharedLines(path).map(line => {
    const record = parse(line)
    evidenceAssert(record, 'invalid complete Thread Memory evidence')
    return record
  })
}
const sharedThreadJoins: Entry = {
  synopsis: '<memory-file> [channel stamp-json]',
  async print(args, context) {
    evidenceAssert(args.length === 1 || args.length === 3, 'Thread Memory needs file, optionally channel and stamp')
    const rows = (await sharedMemory(context, args[0])).filter(r => r.kind === 'join')
    const stamp = args.length === 3 ? JSON.parse(args[2]) : undefined
    return rows.filter(r => !stamp || (r.channel === args[1] && isDeepStrictEqual(r.stamp, stamp)))
      .map(r => JSON.stringify(r)).join('\n')
  },
}
type SharedOwnPostRecord = import('../../../src/thread-memory.ts').ThreadPostIntent | import('../../../src/thread-memory.ts').ThreadPostOutcome
async function sharedOwnPostJournal(context: EntryContext, path: string): Promise<SharedOwnPostRecord[]> {
  const parse = await packageFunction<typeof import('../../../src/thread-memory.ts').parseThreadMemoryRecord>(context, 'thread-memory.ts', 'parseThreadMemoryRecord')
  const bytes = sharedEvidenceBytes(path)
  const end = bytes.lastIndexOf('\n') + 1
  const lines = end ? bytes.slice(0, end - 1).split('\n') : []
  const posts: SharedOwnPostRecord[] = []
  const intents = new Set<string>(), outcomes = new Set<string>()
  let header = false, sequence = -1
  for (const line of lines) {
    const row = parse(line)
    evidenceAssert(row, 'invalid complete own-post journal record')
    evidenceAssert(row.seq > sequence, 'duplicate or reordered own-post journal sequence')
    sequence = row.seq
    if (row.kind === 'header') {
      evidenceAssert(!header && line === lines[0], 'duplicate or misplaced own-post journal header')
      header = true
    } else {
      evidenceAssert(header, 'own-post journal has no leading header')
      if (row.kind === 'post-intent') {
        evidenceAssert(!intents.has(row.operationId), 'duplicate own-post intent')
        intents.add(row.operationId)
        posts.push(row)
      } else if (row.kind === 'post-outcome') {
        evidenceAssert(intents.has(row.operationId) && !outcomes.has(row.operationId), 'orphan or duplicate own-post outcome')
        outcomes.add(row.operationId)
        posts.push(row)
      }
    }
  }
  // An unseen tail may be this operation's outcome. Never call its complete
  // intent unresolved while a later record is still being appended.
  if (!header || end !== bytes.length) throw new PrinterFailure('own-post journal append pending', 75)
  return posts
}
const sharedOwnPostRecords: Entry = {
  synopsis: '<memory-file>',
  async print(args, context) {
    expectArguments('sharedOwnPostRecords', args, ['memory-file'])
    return (await sharedOwnPostJournal(context, args[0])).map(row => JSON.stringify(row)).join('\n')
  },
}
const sharedOwnPostState: Entry = {
  synopsis: '<memory-file> <operation-id> <channel> <stamp-json> <unresolved|joined|none>',
  async print(args, context) {
    expectArguments('sharedOwnPostState', args, ['memory-file', 'operation-id', 'channel', 'stamp-json', 'unresolved|joined|none'])
    const [path, operation, channel, stampJSON, expected] = args
    evidenceAssert(['unresolved', 'joined', 'none'].includes(expected), 'invalid own-post expected state')
    evidenceAssert(/^[A-Za-z0-9_-]+$/.test(operation) && /^[CG][A-Z0-9]+$/.test(channel), 'invalid own-post identity')
    const stamp = sharedParseJSON(stampJSON)
    evidenceAssert(stamp && typeof stamp === 'object' && !Array.isArray(stamp) &&
      Object.keys(stamp).length === 2 && typeof stamp.incarnation === 'string' && /^[A-Za-z0-9_-]+$/.test(stamp.incarnation) &&
      typeof stamp.threadHybridSince === 'string' && /^[A-Za-z0-9_-]+$/.test(stamp.threadHybridSince), 'invalid own-post stamp')
    const rows = await sharedOwnPostJournal(context, path)
    const intent = rows.find((row): row is import('../../../src/thread-memory.ts').ThreadPostIntent =>
      row.kind === 'post-intent' && row.operationId === operation)
    if (!intent) throw new PrinterFailure('exact own-post intent not observed', 75)
    evidenceAssert(intent.channel === channel, 'own-post intent belongs to another channel')
    evidenceAssert(isDeepStrictEqual(intent.stamp, stamp), 'own-post intent has a different Channel Stamp')
    const outcome = rows.find((row): row is import('../../../src/thread-memory.ts').ThreadPostOutcome =>
      row.kind === 'post-outcome' && row.operationId === operation) ?? null
    if (expected === 'unresolved') evidenceAssert(!outcome, 'own-post intent already has a durable outcome')
    else {
      if (!outcome) throw new PrinterFailure('exact own-post outcome not observed', 75)
      evidenceAssert(outcome.outcome === expected, 'own-post durable outcome differs from expectation')
    }
    return JSON.stringify({ intent, outcome })
  },
}
const membershipRetryDelay: Entry = {
  synopsis: '<failures> [retry-after-seconds]',
  async print(args, context) {
    evidenceAssert(args.length === 1 || args.length === 2, 'membership retry needs failures and optional Retry-After seconds')
    const failures = Number(args[0]), after = args.length === 2 ? Number(args[1]) : undefined
    evidenceAssert(args[0].trim() !== '' && Number.isSafeInteger(failures) && failures >= 0 &&
      (after === undefined || (args[1].trim() !== '' && Number.isFinite(after) && after >= 0)), 'invalid membership retry arguments')
    const retry = await packageFunction<typeof import('../../../src/channel-membership-retry.ts').membershipRetryDelay>(context, 'channel-membership-retry.ts', 'membershipRetryDelay')
    const value = retry(failures, after)
    evidenceAssert(Number.isFinite(value) && value >= 0, 'invalid production membership retry delay')
    return String(value)
  },
}
const sharedQueueJoinsSaved: Entry = {
  synopsis: '<memory-file> <queue-snapshot>...',
  async print(args, context) {
    const memory = await sharedMemory(context, args[0])
    const joined = sharedAccepts(await sharedQueueRecords(context, args.slice(1))).filter(r => r.thread_join)
    evidenceAssert(joined.length > 0 && joined.every(item => memory.some(r => r.kind === 'join' &&
      r.channel === item.channel && r.root === item.thread_join!.thread_ts &&
      isDeepStrictEqual(r.stamp, item.thread_join!.stamp) && r.at <= item.thread_join!.at)), 'missing saved queue join')
    return ''
  },
}
const sharedDedupePreserved: Entry = {
  synopsis: '<before-snapshot> <current-journal>',
  async print(args, context) {
    expectArguments('sharedDedupePreserved', args, ['before', 'current'])
    const before = sharedAccepts(await sharedQueueRecords(context, [args[0]]))
    const after = await sharedQueueRecords(context, [args[1]])
    evidenceAssert(before.length && !sharedAccepts(after).length, 'compaction missing or no pre-compaction evidence')
    const facts = (rows: SharedQueueRecord[]) => rows.flatMap(r => r.kind === 'accepted' && 'key' in r && r.key ?
      [{ seq: r.seq, key: r.key, received_at: r.received_at }] : []).sort((a, b) => a.seq - b.seq)
    evidenceAssert(isDeepStrictEqual(facts(before), facts(after)), 'dedupe facts changed during compaction')
    const highest = Math.max(...before.map(r => r.seq))
    evidenceAssert(after.some(r => r.kind === 'accepted' && r.seq >= highest), 'allocation evidence lost during compaction')
    return ''
  },
}
function sharedLogPaths(path: string): string[] {
  const paths = readdirSync(dirname(path)).filter(n => /^server\.log(?:\.\d+)?$/.test(n)).map(n => join(dirname(path), n))
  evidenceAssert(paths.length > 0 && paths.length <= 32 && paths.includes(path), 'missing or excessive diagnostic rotations')
  return paths
}
async function sharedReceiptView(context: EntryContext, key: string, log: string, rows: SharedQueueRecord[],
  readTranscript?: (path: string, logs: string[]) => Promise<string>) {
  const adapters = {
    parseDeliveryTranscriptRecord: await packageFunction<typeof import('../../../src/delivery-receipt.ts').parseDeliveryTranscriptRecord>(context, 'delivery-receipt.ts', 'parseDeliveryTranscriptRecord'),
    receiptTextMatches: await packageFunction<typeof import('../../../src/delivery-receipt.ts').receiptTextMatches>(context, 'delivery-receipt.ts', 'receiptTextMatches'),
  }
  const { personaTranscripts } = await import('./transcript-receipts.ts')
  const logs = sharedLogPaths(log).flatMap(path => sharedLines(path))
  const paths = [...new Set(rows.flatMap(r => r.kind === 'sent' && !('unknown_outcome' in r) && r.transcript_path ? [r.transcript_path] : []))]
  // AD can publish a transcript reference after the attempt. The existing
  // adapter independently checks its key/instance/session binding below.
  for (const line of logs) {
    const marker = '[slack] delivery-transcript-reference: ', i = line.indexOf(marker)
    if (i < 0) continue
    const ref = sharedParseJSON(line.slice(i + marker.length))
    if (ref.key === key && ref.instance_id === `cscb_${key}` && typeof ref.jsonl_path === 'string' && !paths.includes(ref.jsonl_path)) paths.push(ref.jsonl_path)
  }
  evidenceAssert(paths.length <= 256, 'excessive transcript paths')
  // Bound the actual reads, not merely a stat before an unbounded second read.
  // Transcript classification/text/UUID stay exclusively with the production
  // parser; the existing evidence adapter supplies persona/session ownership.
  const captured: import('./transcript-receipts.ts').TranscriptEntry[] = []
  for (const path of paths) {
    let offset = 0
    const bytes = readTranscript ? await readTranscript(path, logs) : sharedEvidenceBytes(path)
    for (const line of bytes.slice(0, bytes.lastIndexOf('\n') + 1).split('\n')) {
      if (line) {
        const value = sharedParseJSON(line)
        const parsed = adapters.parseDeliveryTranscriptRecord('claude', value)
        captured.push({ path, offset, value, at: typeof value.timestamp === 'number' ? value.timestamp : Date.parse(value.timestamp ?? ''), ...parsed })
      }
      offset += Buffer.byteLength(line) + 1
    }
  }
  const entries = personaTranscripts(key, rows, logs, captured)
    .filter(r => r.kind === 'take-in' && r.text !== undefined)
  const accepted = sharedAccepts(rows)
  const items = accepted.map(item => {
    const fixed = rows.filter((r): r is import('../../../src/delivery-queue.ts').FixedRecord => r.kind === 'fixed' && r.seq === item.seq)
    evidenceAssert(fixed.length <= 1, 'conflicting fixed parts')
    const parts = fixed[0]?.parts ?? []
    const received = parts.flatMap((text, index) => {
      const matches = rows.filter((r): r is import('../../../src/delivery-queue.ts').DeliveredRecord => r.kind === 'delivered' && r.seq === item.seq && r.part === index + 1)
      const receipt = matches.find(r => r.at >= item.received_at && entries.some(e => e.path === r.receipt.path &&
        e.at >= item.received_at && e.at <= r.at && (r.receipt.uuid ? e.uuid === r.receipt.uuid : e.offset === r.receipt.offset) &&
        adapters.receiptTextMatches(e.text!, text)))
      if (!receipt) return []
      const entry = entries.find(e => e.path === receipt.receipt.path &&
        (receipt.receipt.uuid ? e.uuid === receipt.receipt.uuid : e.offset === receipt.receipt.offset))!
      return [{ part: index + 1, at: receipt.at, receipt: receipt.receipt,
        transcript: { path: entry.path, offset: entry.offset, uuid: entry.uuid, at: entry.at, session_id: entry.value.sessionId } }]
    })
    return { seq: item.seq, received_at: item.received_at, parts: parts.length, receipted_parts: received.length,
      complete: parts.length > 0 && received.length === parts.length, receipts: received,
      recent: rows.filter(r => r.seq === item.seq && ['sent', 'refused', 'delivered'].includes(r.kind)).slice(-8).map(r => ({
        kind: r.kind, ...('part' in r ? { part: r.part } : {}), ...('attempt' in r ? { attempt: r.attempt } : {}),
        ...('at' in r ? { at: r.at } : {}), ...('send_kind' in r ? { send_kind: r.send_kind } : {}),
      })) }
  })
  return { accepted, items }
}
const sharedQueueReceipts: Entry = {
  synopsis: '<key> <server-log> <current-journal> <original-snapshot> [prior-snapshot...]',
  async print(args, context) {
    evidenceAssert(args.length >= 4, 'receipt evidence needs key, log, current and original')
    const [key, log, journal, original, ...history] = args
    const originalRows = await sharedQueueRecords(context, [original])
    const originals = sharedAccepts(originalRows).filter(r => r.reminder_for === undefined)
    const rows = await sharedQueueRecords(context, [journal, ...history], originalRows)
    const { accepted, items } = await sharedReceiptView(context, key, log, rows)
    const current = await sharedQueueRecords(context, [journal])
    const currentSeqs = new Set(sharedAccepts(current).map(r => r.seq))
    const keyKeepMs = await packageExport(context, 'delivery-queue.ts', 'QUEUE_KEY_KEEP_MS')
    evidenceAssert(Number.isSafeInteger(keyKeepMs) && (keyKeepMs as number) > 0, 'invalid production key retention')
    // Archives are observed evidence, not authority to resurrect lost work.
    // Require the live journal's compacted key/allocation and the archived
    // exact receipt proof before allowing a historical item to complete.
    for (const item of accepted) if (!currentSeqs.has(item.seq)) {
      const proof = items.find(r => r.seq === item.seq)!
      evidenceAssert(proof.complete, 'archived item lacks complete observed receipts')
      const marker = current.find(r => r.kind === 'accepted' && 'compact' in r && r.compact === 'key' && r.seq === item.seq)
      const allocated = current.some(r => r.kind === 'accepted' && 'compact' in r && r.compact === 'allocation' && r.seq >= item.seq)
      const deliveredAt = Math.max(...proof.receipts.map(r => r.at))
      // Compaction follows the final receipt and keeps a Slack key only while
      // it is younger than QUEUE_KEY_KEEP_MS, so a key already that old at its
      // final receipt leaves only the allocation (an upgraded 0.18.0 item).
      const retained = item.source !== 'slack' ? allocated
        : deliveredAt - item.received_at >= (keyKeepMs as number) ? !marker && allocated
        : marker && 'key' in marker && 'delivered_at' in marker && isDeepStrictEqual(marker.key, item.key) &&
          marker.received_at === item.received_at && marker.delivered_at === deliveredAt
      evidenceAssert(retained, 'archived item lacks matching live compaction evidence')
    }
    const progress = items.filter(r => originals.some(a => a.seq === r.seq)).reduce((n, r) => n + r.receipted_parts, 0)
    const pending = items.filter(r => !r.complete)
    return JSON.stringify({ accepted: items.length, complete: items.length > 0 && pending.length === 0, progress,
      incomplete: pending.length, first_incomplete: pending.slice(0, 8).map(({ receipts, ...numeric }) => numeric),
      incomplete_items_omitted: Math.max(0, pending.length - 8) })
  },
}
const sharedRecordedButton: Entry = {
  synopsis: '<stub-record> <label> <channel> <message-ts> <action-id-or-prefix>',
  async print(args) {
    expectArguments('sharedRecordedButton', args, ['record', 'label', 'channel', 'ts', 'action'])
    const [path, label, channel, ts, action] = args
    const posts = sharedJSON(path).filter(r => r.event === 'api' && r.label === label &&
      ['chat.postMessage', 'chat.update'].includes(r.method) && r.channel === channel && r.response_ts === ts && r.answer === 'ok')
    evidenceAssert(posts.length > 0, 'recorded prompt missing')
    const latest = posts[posts.length - 1]
    const buttons = (latest.blocks ?? []).flatMap((block: any) => (block.type === 'actions' ? block.elements ?? [] : [])
      .filter((b: any) => b.type === 'button' && typeof b.action_id === 'string' && b.action_id.startsWith(action))
      .map((b: any) => ({ type: 'button', action_id: b.action_id, ...(b.value === undefined ? {} : { value: b.value }),
        ...(block.block_id === undefined ? {} : { block_id: block.block_id }) })))
    evidenceAssert(buttons.length === 1, 'recorded button missing or ambiguous')
    return JSON.stringify(buttons[0])
  },
}
function sharedPostRows(path: string): any[] {
  const rows = sharedJSON(path)
  let previous = 0
  for (const row of rows) {
    evidenceAssert(row && Number.isSafeInteger(row.seq) && row.seq > previous, 'invalid stub record sequence')
    previous = row.seq
  }
  return rows
}
const sharedPostMark: Entry = {
  synopsis: '<stub-record>',
  async print(args) {
    expectArguments('sharedPostMark', args, ['stub-record'])
    return String(sharedPostRows(args[0]).at(-1)?.seq ?? 0)
  },
}
function confirmedRootPost(post: any, label: string, channel: string) {
  evidenceAssert(post?.event === 'api' && post.method === 'chat.postMessage' && post.label === label && post.channel === channel &&
    post.answer === 'ok' && post.status === 200 && typeof post.text === 'string' && typeof post.response_ts === 'string' &&
    /^[0-9]+\.[0-9]+$/.test(post.response_ts) && (post.thread_ts === undefined || post.thread_ts === '') &&
    post.args_token_like === false, 'invalid successful root post evidence')
  return { seq: post.seq, label, channel, ts: post.response_ts }
}
function successfulPost(path: string, label: string, channel: string, after: string, matches: (text: string) => boolean): string {
  evidenceAssert(label && channel && /^(0|[1-9][0-9]*)$/.test(after) && Number.isSafeInteger(Number(after)), 'invalid post query')
  const rows = sharedPostRows(path)
  evidenceAssert(Number(after) <= (rows.at(-1)?.seq ?? 0), 'post record moved behind cursor')
  const posts = rows.filter(r => r.seq > Number(after) && r.event === 'api' && r.method === 'chat.postMessage' &&
    r.label === label && r.channel === channel && r.answer === 'ok' && typeof r.text === 'string' && matches(r.text))
  if (!posts.length) throw new PrinterFailure('successful post not observed yet', 75)
  evidenceAssert(posts.length === 1, 'successful post ambiguous')
  const post = posts[0]
  return JSON.stringify(confirmedRootPost(post, label, channel))
}
const sharedObservedPostEvent: Entry = {
  synopsis: '<stub-record> <sender-label> <channel> <post-seq> <user-id> <bot-id>',
  async print(args) {
    expectArguments('sharedObservedPostEvent', args, ['record', 'label', 'channel', 'seq', 'user-id', 'bot-id'])
    const [path, label, channel, seq, user, bot] = args
    evidenceAssert(/^[1-9][0-9]*$/.test(seq) && Number.isSafeInteger(Number(seq)) &&
      /^[U][A-Z0-9]+$/.test(user) && /^[B][A-Z0-9]+$/.test(bot) && /^[CGD][A-Z0-9]+$/.test(channel), 'invalid observed post identity')
    const post = sharedPostRows(path).find(r => r.seq === Number(seq))
    const identity = confirmedRootPost(post, label, channel)
    return JSON.stringify({ type: 'message', subtype: 'bot_message', channel, channel_type: channel.startsWith('D') ? 'im' : 'channel',
      ts: identity.ts, text: post.text, user, bot_id: bot })
  },
}
const sharedSuccessfulPost: Entry = {
  synopsis: '<stub-record> <label> <channel> <after-seq> <text-fragment>...',
  async print(args) {
    const [path, label, channel, after, ...fragments] = args
    evidenceAssert(args.length >= 5 && fragments.every(s => s.length > 0), 'post query needs nonempty expected text')
    return successfulPost(path, label, channel, after, text => {
      let offset = 0
      for (const fragment of fragments) {
        const at = text.indexOf(fragment, offset)
        if (at < 0) return false
        offset = at + fragment.length
      }
      return true
    })
  },
}
const sharedMessagesWaitingPost: Entry = {
  synopsis: '<stub-record> <label> <channel> <after-seq> <name> <key> <count>',
  async print(args, context) {
    expectArguments('sharedMessagesWaitingPost', args, ['record', 'label', 'channel', 'after', 'name', 'key', 'count'])
    const [path, label, channel, after, name, key, count] = args
    evidenceAssert(/^[1-9][0-9]*$/.test(count) && Number.isSafeInteger(Number(count)), 'invalid waiting notice count')
    const build = await packageFunction<typeof import('../../../src/delivery-notices.ts').buildMessagesWaitingNotice>(context, 'delivery-notices.ts', 'buildMessagesWaitingNotice')
    const age = await packageFunction<typeof import('../../../src/delivery-notices.ts').deliveryAge>(context, 'delivery-notices.ts', 'deliveryAge')
    const ref = await packageFunction<typeof import('../../../src/persona-identity.ts').renderPersonaRef>(context, 'persona-identity.ts', 'renderPersonaRef')
    const format = await packageFunction<typeof import('../../../src/persona-notifier.ts').formatPersonaNotice>(context, 'persona-notifier.ts', 'formatPersonaNotice')
    const expected = (ms: number) => format({ name, key }, build(ref(name, key), Number(count), ms, 'down with automatic restarts off'))
    // Derive the changing age span from two production renderings. Every other
    // byte, including both persona references, count and remedy, must match.
    const zero = expected(0), minute = expected(60000)
    let head = 0, tail = 0
    while (zero[head] === minute[head] && head < Math.min(zero.length, minute.length)) head++
    while (zero[zero.length - tail - 1] === minute[minute.length - tail - 1] && tail < zero.length - head) tail++
    const prefix = zero.slice(0, head), suffix = zero.slice(zero.length - tail)
    evidenceAssert(prefix && suffix, 'notice age span unavailable')
    return successfulPost(path, label, channel, after, text => {
      if (!text.startsWith(prefix) || !text.endsWith(suffix)) return false
      const value = text.slice(prefix.length, text.length - suffix.length)
      const parts = /^(?:(\d+)s|(\d+)m|(\d+)h (\d+)m)$/.exec(value)
      if (!parts) return false
      const ms = parts[1] !== undefined ? Number(parts[1]) * 1000 : parts[2] !== undefined ? Number(parts[2]) * 60000 :
        (Number(parts[3]) * 60 + Number(parts[4])) * 60000
      return Number.isSafeInteger(ms) && age(ms) === value
    })
  },
}
interface SharedExpected {
  key: string; name: string; source: 'slack' | 'cron' | 'interject'; channel?: string; sender?: string; ts: string; user?: string; via?: string
}
const sharedDeliveryExpectation: Entry = {
  synopsis: '<key> <name> <slack|cron|interject> <channel-or-sender> <ts> <sender-id> <via-or-dash>',
  async print(args) {
    expectArguments('sharedDeliveryExpectation', args, ['key', 'name', 'source', 'context', 'ts', 'sender-id', 'via'])
    const [key, name, source, target, ts, sender, via] = args
    evidenceAssert(['slack', 'cron', 'interject'].includes(source) && key && name && target && ts && sender, 'invalid expected delivery identity')
    evidenceAssert(source === 'slack' || target === sender, 'injected sender identity differs')
    return JSON.stringify({ key, name, source, ...(source === 'slack' ? { channel: target, user: sender } : { sender: target }), ts,
      ...(via === '-' ? {} : { via }) }) + '\n'
  },
}
// src/server.ts main() logs this once per start, before it creates the
// delivery reporting that writes every message-received line, the
// start-time releases of recovered holds included.
const SHARED_SERVER_START_RE = /^(?:\[\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\] )?\[slack\] Loaded persona config: (?:0|[1-9][0-9]*) persona\(s\)$/
// Oldest first: the rotations `.K` … `.1` (src/logging.ts shifts each one
// up), then the active file. Within a file, lines are in write order.
function sharedLogsInOrder(path: string): string[] {
  const rotated = sharedLogPaths(path).filter(p => p !== path)
    .map(p => ({ p, n: Number(/\.([0-9]+)$/.exec(p)?.[1]) })).sort((a, b) => b.n - a.n)
  evidenceAssert(rotated.every((r, i) => r.n === rotated.length - i), 'server log rotations are not contiguous')
  return [...rotated.map(r => r.p), path]
}
const sharedAssertAccounting: Entry = {
  synopsis: '[--per-server-run] <expectations-jsonl> <server-log> (<key> <queue-snapshot>)...',
  async print(input, context) {
    // message-received is deduplicated for one server run
    // (src/delivery-notices.ts), so an item still queued at a stop is logged
    // again when the next start recovers it. --per-server-run keeps the exact
    // accepted and received sets, allowing each identity at most once per run.
    const perRun = input[0] === '--per-server-run', args = perRun ? input.slice(1) : input
    evidenceAssert(args.length >= 4 && args.length % 2 === 0, 'accounting needs expectations, log and key/snapshot pairs')
    const expected: SharedExpected[] = sharedJSON(args[0])
    evidenceAssert(expected.length > 0, 'empty expected acceptance set')
    const identity = await packageFunction<typeof import('../../../src/persona-diagnostics.ts').deliveryIdentity>(context, 'persona-diagnostics.ts', 'deliveryIdentity')
    const diagnostic = await packageFunction<typeof import('../../../src/persona-diagnostics.ts').buildDeliveryDiagnostic>(context, 'persona-diagnostics.ts', 'buildDeliveryDiagnostic')
    const ref = await packageFunction<typeof import('../../../src/persona-identity.ts').renderPersonaRef>(context, 'persona-identity.ts', 'renderPersonaRef')
    const label = await packageString(context, 'persona-diagnostics.ts', 'MESSAGE_RECEIVED') as import('../../../src/persona-diagnostics.ts').DeliveryDiagnosticClass
    const wanted = expected.map(e => diagnostic(label, ref(e.name, e.key), identity(e)))
    evidenceAssert(new Set(wanted).size === wanted.length, 'duplicate expected identity')
    const actual: string[] = [], accepts: string[] = []
    for (let i = 2; i < args.length; i += 2) {
      const key = args[i], rows = sharedAccepts(await sharedQueueRecords(context, [args[i + 1]]))
      for (const row of rows.filter(r => r.reminder_for === undefined)) {
        const e = expected.find(e => e.key === key && identity(e) === identity(row) && e.via === row.via)
        evidenceAssert(e, 'unexpected accepted identity or delivery reason')
        accepts.push(diagnostic(label, ref(e.name, key), identity(row)))
      }
    }
    let run = 0
    const runs = new Map<string, number[]>()
    for (const path of perRun ? sharedLogsInOrder(args[1]) : sharedLogPaths(args[1])) for (const line of sharedLines(path)) {
      if (perRun && SHARED_SERVER_START_RE.test(line)) { run++; continue }
      const marker = `[slack] ${label}: `, i = line.indexOf(marker)
      if (i < 0) continue
      const received = line.slice(i)
      actual.push(received)
      if (!perRun) continue
      evidenceAssert(run > 0, 'received diagnostic before any server start')
      runs.set(received, [...runs.get(received) ?? [], run])
    }
    evidenceAssert(isDeepStrictEqual(accepts.sort(), [...wanted].sort()), 'exact accepted set mismatch')
    if (!perRun) {
      evidenceAssert(isDeepStrictEqual(actual.sort(), [...wanted].sort()), 'exact received diagnostic set mismatch')
      return JSON.stringify({ accepted: accepts.length, received: actual.length })
    }
    const wantedSet = new Set(wanted)
    const missing = wanted.filter(w => !runs.has(w)).length, extra = [...runs.keys()].filter(r => !wantedSet.has(r)).length
    evidenceAssert(!missing && !extra, `exact received diagnostic set mismatch (missing=${missing} extra=${extra})`)
    // Lines are read in write order, so a repeat in a run after the first
    // line's run is a strictly later run; equal runs are a same-run repeat.
    const repeated = [...runs.values()].filter(r => r.length > 1)
    const sameRun = repeated.filter(r => r.some((n, j) => j > 0 && n <= r[j - 1]!)).length
    evidenceAssert(!sameRun, `received diagnostic repeated within one server run (identities=${sameRun})`)
    return JSON.stringify({ accepted: accepts.length, received: actual.length, runs: run, repeated: repeated.length })
  },
}
const sharedExpectedParts: Entry = {
  synopsis: '<text> <ts> <user-id> <user-name> <channel> <channel-name> <via> <root-or-dash> <attachment-json-or-dash>',
  async print(args, context) {
    expectArguments('sharedExpectedParts', args, ['text', 'ts', 'user-id', 'user-name', 'channel', 'channel-name', 'via', 'root', 'attachment'])
    const [text, ts, user_id, user, chat_id, channel_name, via, root, fixture] = args
    const build = await packageFunction<typeof import('../../../src/tag-wrapper.ts').buildTagParts>(context, 'tag-wrapper.ts', 'buildTagParts')
    return JSON.stringify(build({ text, ts, user_id, user, chat_id, channel_name, message_id: ts, via,
      ...(root === '-' ? {} : { thread_ts: root }), ...(fixture === '-' ? {} : JSON.parse(fixture).attributes) }))
  },
}
const sharedAssertContent: Entry = {
  synopsis: '<key> <server-log> <queue-snapshot> <channel> <ts> <original-text> <expected-parts-json> <attachment-json-or-dash>',
  async print(args, context) {
    expectArguments('sharedAssertContent', args, ['key', 'log', 'snapshot', 'channel', 'ts', 'text', 'parts', 'attachment'])
    const [key, log, path, channel, ts, text, expectedParts, fixture] = args
    const rows = await sharedQueueRecords(context, [path])
    const matches = sharedAccepts(rows).filter(r => r.channel === channel && r.ts === ts)
    evidenceAssert(matches.length === 1, 'content needs exactly one acceptance')
    const item = matches[0], fixed = rows.find(r => r.seq === item.seq && r.kind === 'fixed')
    evidenceAssert(item.text === text && isDeepStrictEqual(item.files ?? [], fixture === '-' ? [] : [JSON.parse(fixture).queue]), 'accepted text or attachment changed')
    evidenceAssert(fixed?.kind === 'fixed' && isDeepStrictEqual(fixed.parts, JSON.parse(expectedParts)), 'delivered content differs from independent expectation')
    const view = await sharedReceiptView(context, key, log, rows)
    const receipt = view.items.find(r => r.seq === item.seq)
    evidenceAssert(receipt?.complete, 'expected content lacks exact transcript receipts')
    // Metadata only; original/fixed/transcript text is never emitted.
    return JSON.stringify({ channel, ts, source: item.source, via: item.via, ...receipt })
  },
}

const sharedInjectedExpectedParts: Entry = {
  synopsis: '<text> <retained-ts> <sender>',
  async print(args, context) {
    expectArguments('sharedInjectedExpectedParts', args, ['text', 'ts', 'sender'])
    const [text, ts, user] = args
    const build = await packageFunction<typeof import('../../../src/tag-wrapper.ts').buildTagParts>(context, 'tag-wrapper.ts', 'buildTagParts')
    return JSON.stringify(build({ user, ts, text }))
  },
}
/** Shared-mode stubs keep transcripts in the container HOME, separate from
 * SCENARIO_ROOT. The existing adapter owns project/session identity; this
 * reader adds the exact HOME layout and descriptor safety before reading. */
async function sharedInjectedTranscriptBytes(path: string, key: string, rows: SharedQueueRecord[], logs: string[]): Promise<string> {
  let fd: number | undefined
  try {
    const home = process.env['HOME']
    if (!home) throw new Error()
    const root = resolve(home, '.claude', 'projects'), project = dirname(path)
    if (path !== resolve(path) || dirname(project) !== root || !path.endsWith('.jsonl') ||
        realpathSync(path) !== join(realpathSync(home), '.claude', 'projects', basename(project), basename(path))) throw new Error()
    const { personaTranscripts } = await import('./transcript-receipts.ts')
    // A metadata-only candidate uses the adapter's established attempt/log
    // binding. The actual parsed record still passes that adapter below.
    if (personaTranscripts(key, rows, logs, [{ path, offset: 0, at: 0, kind: 'other', value: {} }]).length !== 1) throw new Error()
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > SHARED_EVIDENCE_BYTES) throw new Error()
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!count) throw new Error()
      offset += count
    }
    const after = fstatSync(fd)
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error()
    return bytes.toString('utf8')
  } catch { throw new PrinterFailure('missing, changed, unsafe, foreign or oversized transcript evidence', PRINTER_FAIL_EXIT) }
  finally { if (fd !== undefined) closeSync(fd) }
}
const sharedAssertInjectedContent: Entry = {
  synopsis: '<key> <server-log> <queue-snapshot> <cron|interject> <sender> <retained-ts> <text> <expected-parts-json>',
  async print(args, context) {
    expectArguments('sharedAssertInjectedContent', args, ['key', 'log', 'snapshot', 'source', 'sender', 'ts', 'text', 'parts'])
    const [key, log, path, source, sender, ts, text, expectedParts] = args
    evidenceAssert(source === 'cron' || source === 'interject', 'injected source must be cron or interject')
    sharedScratchBytes(path)
    sharedScratchBytes(log)
    const rows = await sharedQueueRecords(context, [path])
    const selected = sharedAccepts(rows).filter(r => r.source === source && r.sender === sender && r.ts === ts && r.reminder_for === undefined)
    evidenceAssert(selected.length === 1, 'injected content needs exactly one original acceptance')
    const item = selected[0], fixed = rows.filter(r => r.seq === item.seq && r.kind === 'fixed')
    evidenceAssert(item.text === text && item.channel === undefined && item.via === undefined && item.user === undefined &&
      item.thread_ts === undefined && item.key === undefined && (item.files?.length ?? 0) === 0, 'injected original content or identity changed')
    evidenceAssert(fixed.length === 1 && fixed[0].kind === 'fixed' && isDeepStrictEqual(fixed[0].parts, sharedParseJSON(expectedParts)),
      'injected fixed content differs from independent expectation')
    for (const file of sharedLogPaths(log)) sharedScratchBytes(file)
    // Fence the actual transcript read, including late references discovered
    // by the receipt view. Do not widen the request/state/log scratch reader.
    const receipt = (await sharedReceiptView(context, key, log, rows,
      (file, logs) => sharedInjectedTranscriptBytes(file, key, rows, logs))).items.find(r => r.seq === item.seq)
    evidenceAssert(receipt?.complete, 'injected content lacks exact transcript receipts')
    return JSON.stringify({ source, sender, ts, ...receipt })
  },
}
const sharedCronIdentity: Entry = {
  synopsis: '<crontable-file> <prompt-path-as-written>',
  async print(args, context) {
    expectArguments('sharedCronIdentity', args, ['crontable', 'prompt-path'])
    const parse = await packageFunction<typeof import('../../../src/crontable.ts').parseCrontable>(context, 'crontable.ts', 'parseCrontable')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(sharedScratchBytes(args[0])) }
    catch { throw new PrinterFailure('crontable evidence is not readable UTF-8', PRINTER_FAIL_EXIT) }
    const result = parse(text), selected = result.schedules.filter(r => r.promptPath === args[1])
    evidenceAssert(!result.errors.length && selected.length === 1, 'crontable needs exactly one matching valid schedule and no parse errors')
    return selected[0].identity
  },
}
const sharedPersonaFacts: Entry = {
  synopsis: '<config> <record> <key> [channel]',
  async print(args, context) {
    evidenceAssert(args.length === 3 || args.length === 4, 'persona facts need config, record, key and optional channel')
    const [config, record, key, channel] = args
    const authority = await readScenarioAuthority(context, config, record)
    const p = authority.snapshot().personas[key]
    evidenceAssert(p, 'persona absent from shared authority')
    const select = <T>(values: Record<string, T>) => channel === undefined ? values : { [channel]: values[channel] ?? null }
    return JSON.stringify({ mode: authority.config().channel_mode, key, incarnation: p.incarnation,
      assignments: select(p.assignments), leaves: select(p.leaves), removedDestinations: select(p.removedDestinations),
      historicalMembership: select(p.membership), threadMemoryCreated: authority.threadMemoryCreated(key) })
  },
}
const sharedMembershipEvent: Entry = {
  synopsis: '<config> <record> <key> <event-id>',
  async print(args, context) {
    expectArguments('sharedMembershipEvent', args, ['config', 'record', 'key', 'event-id'])
    const [config, record, key, event] = args
    const p = (await readScenarioAuthority(context, config, record)).snapshot().personas[key]
    evidenceAssert(p, 'persona absent from shared authority')
    const applied = Object.hasOwn(p.membershipEvents, event) ? p.membershipEvents[event] : undefined
    return JSON.stringify(applied ? { channel: applied.channel, member: applied.member, order: applied.order, boundary: applied.boundary } : null)
  },
}
const deliveryAttemptStatus: Entry = {
  synopsis: '<name> <key> <channel> <pending|unresolved|binding-conflict|invalid|inactive|not-applied> [rejection]',
  async print(args, context) {
    if (args.length !== 4 && args.length !== 5) usageFail('attempt status needs name, key, channel, status and optional rejection')
    const [name, key, channel, kind, reason] = args
    let result: import('../../../src/channel-delivery-attempt.ts').BotAttemptResult
    if (kind === 'not-applied') {
      const reasons = await packageExport(context, 'channel-delivery-attempt.ts', 'BOT_ATTEMPT_REJECTIONS')
      if (!Array.isArray(reasons) || !reasons.includes(reason)) usageFail('invalid attempt rejection')
      result = { kind, reason: reason as import('../../../src/channel-delivery-attempt.ts').BotAttemptRejection }
    } else if (['pending', 'unresolved', 'binding-conflict', 'invalid', 'inactive'].includes(kind) && reason === undefined) {
      result = { kind } as import('../../../src/channel-delivery-attempt.ts').BotAttemptResult
    } else usageFail('invalid attempt status')
    const build = await packageFunction<typeof import('../../../src/registry.ts').channelDeliveryAttemptResultText>(context, 'registry.ts', 'channelDeliveryAttemptResultText')
    return build(name, key, channel, result)
  },
}
const deliveryReasonText: Entry = {
  synopsis: '<dm|mention|broadcast|thread|receive_all_shared|receive_all>',
  async print(args, context) {
    expectArguments('deliveryReasonText', args, ['via'])
    // These are the installed MCP instruction's own descriptions, including
    // the thread wording. No expected sentence is copied into the fixture.
    const instructions = await packageString(context, 'registry.ts', 'MCP_INSTRUCTIONS')
    const reasons = instructions.split('\n').find(line => line.startsWith('via: '))?.slice('via: '.length).split('; ')
    const prefix = `${args[0]} = `
    const reason = reasons?.find(part => part.startsWith(prefix))?.slice(prefix.length).replace(/\.$/, '')
    if (!reason) usageFail('unknown delivery reason or missing instruction entry')
    return reason
  },
}
const reviewedChannelText: Entry = {
  synopsis: '<key> <channel> <kind> <saved|-> <reviewed|-> <membership-kind> <current-effective> <reviewed-effective> [field=value...]',
  async print(args, context) {
    if (args.length < 8) usageFail('reviewedChannelLine needs eight facts before optional fields')
    const [key, channel, kind, savedText, reviewedText, membershipKind, currentEffective, effective, ...extra] = args
    if (!['declared', 'edited', 'copied', 'omitted', 'automatic', 'reset'].includes(kind) ||
        !['eligible', 'ineligible', 'unresolved'].includes(membershipKind)) usageFail('invalid review kind or membership')
    const choice = async (raw: string) => {
      if (raw === '-') return undefined
      await checkDeliveryArgument(context, 'reviewedChannelLine', 'delivery', raw)
      return raw as import('../../../src/config.ts').DeliveryMode
    }
    const view: import('../../../src/reload-plan.ts').ReviewedChannelView = {
      key, channel, kind: kind as import('../../../src/shared-channels.ts').ReviewedChannelEffect['kind'],
      saved: await choice(savedText), reviewed: await choice(reviewedText), replacement: false,
      membership: { kind: membershipKind } as import('../../../src/channel-membership.ts').MembershipReading,
      currentEffective, effective, activatesInStrict: false,
    }
    const seen = new Set<string>()
    for (const pair of extra) {
      const i = pair.indexOf('='), field = pair.slice(0, i), value = pair.slice(i + 1)
      if (i <= 0 || seen.has(field)) usageFail('review option needs one unique field=value')
      seen.add(field)
      if (field === 'replacement' || field === 'activatesInStrict') {
        if (value !== 'true' && value !== 'false') usageFail('review option needs a boolean')
        view[field] = value === 'true'
      } else if (field === 'previousOrder') view.previousOrder = Number(integerArgument('reviewedChannelLine', field, value))
      else if (field === 'inherited') view.inherited = await choice(value)
      else if (field === 'absenceReplacement' && value) view.absenceReplacement = value
      else usageFail('unknown review option')
    }
    const build = await packageFunction<typeof import('../../../src/reload-plan.ts').reviewedChannelLine>(context, 'reload-plan.ts', 'reviewedChannelLine')
    return build(view)
  },
}
function threadLossEntry(notice: boolean, ownPost: boolean): Entry {
  return {
    synopsis: ownPost ? '<name> <key> <channel> <roots-csv|-> <cause>' : '<name> <key> <channel/root,...|-> <channel/ts,...|-> <unreadable-count>',
    async print(args, context) {
      expectArguments('thread loss', args, ['name', 'key', 'threads-or-channel', 'messages-or-roots', 'count-or-cause'])
      const [name, key, a, b, c] = args
      const pairs = (raw: string) => raw === '-' ? [] : raw.split(',').map(pair => {
        const fields = pair.split('/')
        if (fields.length !== 2 || fields.some(value => !value)) usageFail('thread loss pair must be channel/timestamp')
        return fields
      })
      const loss: import('../../../src/thread-memory-reports.ts').ThreadMemoryLoss = ownPost
        ? { threads: [], messages: [], ownPosts: [{ channel: a, threads: b === '-' ? [] : b.split(','), cause: c }] }
        : { threads: pairs(a).map(([channel, root]) => ({ channel, root })),
          messages: pairs(b).map(([channel, ts]) => ({ channel, ts })), unreadableLines: Number(integerArgument('thread loss', 'count', c)) }
      if (notice) {
        const build = await packageFunction<typeof import('../../../src/thread-memory-reports.ts').buildThreadMemoryJoinsLostNotice>(context, 'thread-memory-reports.ts', 'buildThreadMemoryJoinsLostNotice')
        return build({ name, key }, loss).text
      }
      const build = await packageFunction<typeof import('../../../src/thread-memory-reports.ts').buildThreadMemoryJoinsLostLine>(context, 'thread-memory-reports.ts', 'buildThreadMemoryJoinsLostLine')
      return build({ name, key }, loss)
    },
  }
}

/** Validate CLI facts without changing their order or deriving them from a report. */
function sharedReportScopeArgument(entry: string, raw: string): import('../../../src/shared-state-reports.ts').SharedStateReportScope {
  let scope: import('../../../src/shared-state-reports.ts').SharedStateReportScope
  try { scope = JSON.parse(raw) } catch { usageFail(`${entry}: scope-json must be JSON`) }
  const strings = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(item => typeof item === 'string')
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) || !strings(scope.channels) ||
    (scope.all !== undefined && typeof scope.all !== 'boolean') ||
    (scope.dm !== undefined && typeof scope.dm !== 'boolean') ||
    (scope.repairPending !== undefined && (!scope.repairPending || typeof scope.repairPending !== 'object' ||
      Array.isArray(scope.repairPending) || !strings(scope.repairPending.usable) || !strings(scope.repairPending.held)))) {
    usageFail(`${entry}: scope-json must be SharedStateReportScope`)
  }
  return scope
}
function sharedReportChoice<T extends string>(entry: string, name: string, raw: string, choices: readonly T[]): T {
  const choice = choices.find(value => value === raw)
  if (choice === undefined) usageFail(`${entry}: ${name} must be ${choices.join('|')}`)
  return choice
}
const buildSharedStateUnresolvedNotice: Entry = {
  synopsis: '<persona-ref> <scope-json> <cause> <path> [failure]',
  async print(args, context) {
    const entry = 'buildSharedStateUnresolvedNotice'
    expectSomeArguments(entry, args, ['persona-ref', 'scope-json', 'cause', 'path', 'failure'], 4)
    const scope = sharedReportScopeArgument(entry, args[1])
    const cause = sharedReportChoice<import('../../../src/shared-state-reports.ts').SharedStateCause>(entry, 'cause', args[2],
      ['unsynced', 'evidence-changed', 'restoration-staged', 'retirement-unresolved', 'not-saved'])
    const build = await packageFunction<typeof import('../../../src/shared-state-reports.ts').buildSharedStateUnresolvedNotice>(context, 'shared-state-reports.ts', 'buildSharedStateUnresolvedNotice')
    return build(args[0], scope, cause, args[3], args[4])
  },
}
const buildSharedStateUnresolvedLine: Entry = {
  synopsis: '<key> <scope-json> <cause> <path> [failure]',
  async print(args, context) {
    const entry = 'buildSharedStateUnresolvedLine'
    expectSomeArguments(entry, args, ['key', 'scope-json', 'cause', 'path', 'failure'], 4)
    const scope = sharedReportScopeArgument(entry, args[1])
    const cause = sharedReportChoice<import('../../../src/shared-state-reports.ts').SharedStateCause>(entry, 'cause', args[2],
      ['unsynced', 'evidence-changed', 'restoration-staged', 'retirement-unresolved', 'not-saved'])
    const build = await packageFunction<typeof import('../../../src/shared-state-reports.ts').buildSharedStateUnresolvedLine>(context, 'shared-state-reports.ts', 'buildSharedStateUnresolvedLine')
    return build(args[0], scope, cause, args[3], args[4])
  },
}
const buildSharedStateRecoveredNotice: Entry = {
  synopsis: '<persona-ref> <scope-json> <state|evidence|repair>',
  async print(args, context) {
    const entry = 'buildSharedStateRecoveredNotice'
    expectArguments(entry, args, ['persona-ref', 'scope-json', 'closing'])
    const scope = sharedReportScopeArgument(entry, args[1])
    const closing = sharedReportChoice<import('../../../src/shared-state-reports.ts').SharedStateClosing>(entry, 'closing', args[2], ['state', 'evidence', 'repair'])
    const build = await packageFunction<typeof import('../../../src/shared-state-reports.ts').buildSharedStateRecoveredNotice>(context, 'shared-state-reports.ts', 'buildSharedStateRecoveredNotice')
    return build(args[0], scope, closing)
  },
}
const buildSharedStateRecoveredLine: Entry = {
  synopsis: '<key> <scope-json> <state|evidence|repair> <path> [failure]',
  async print(args, context) {
    const entry = 'buildSharedStateRecoveredLine'
    expectSomeArguments(entry, args, ['key', 'scope-json', 'closing', 'path', 'failure'], 4)
    const scope = sharedReportScopeArgument(entry, args[1])
    const closing = sharedReportChoice<import('../../../src/shared-state-reports.ts').SharedStateClosing>(entry, 'closing', args[2], ['state', 'evidence', 'repair'])
    const build = await packageFunction<typeof import('../../../src/shared-state-reports.ts').buildSharedStateRecoveredLine>(context, 'shared-state-reports.ts', 'buildSharedStateRecoveredLine')
    return build(args[0], scope, closing, args[3], args[4])
  },
}
const buildReloadApplyFailedNotice: Entry = {
  synopsis: '<persona-ref> <authority|retired-keys> <path> [failure]',
  async print(args, context) {
    const entry = 'buildReloadApplyFailedNotice'
    expectSomeArguments(entry, args, ['persona-ref', 'record', 'path', 'failure'], 3)
    const record = sharedReportChoice<import('../../../src/reload.ts').ReloadApplyFailure['record']>(entry, 'record', args[1], ['authority', 'retired-keys'])
    const build = await packageFunction<typeof import('../../../src/shared-state-reports.ts').buildReloadApplyFailedNotice>(context, 'shared-state-reports.ts', 'buildReloadApplyFailedNotice')
    return build(args[0], { record, path: args[2], failure: args[3] ?? '' })
  },
}
const sharedRecoveryLine: Entry = {
  synopsis: '<status> [detail]',
  async print(args, context) {
    expectSomeArguments('sharedRecoveryLine', args, ['status', 'detail'], 1)
    const build = await packageFunction<typeof import('../../../src/reload-recovery.ts').sharedRecoveryLine>(context, 'reload-recovery.ts', 'sharedRecoveryLine')
    return build(args[0], args[1])
  },
}

const SHARED_PREVIEW_NAMES = [
  'REVIEW_OMISSION_CLAUSE', 'REVIEW_FUTURE_CLAUSE', 'REVIEW_RESET_CLAUSE', 'REVIEW_RETENTION_CLAUSE',
  'REVIEW_ABSENCE_REPLACEMENT', 'RECOVERY_LOSS', 'RECOVERY_RESTORE', 'RECOVERY_THREADS_FORGOTTEN',
  'RECOVERY_CURRENT_MEMBERSHIP', 'RECOVERY_PRESERVATION',
] as const
const SHARED_DIAGNOSTIC_NAMES = [
  'SHARED_STATE_UNRESOLVED', 'MEMBERSHIP_EVIDENCE_UNRESOLVED', 'SHARED_STATE_RECOVERED',
  'SHARED_STATE_SLACK_RETRY_WARNING', 'SHARED_STATE_STAGED_SLACK_RETRY_WARNING',
  'PERSONA_THREAD_STAMP_UNDECIDED', 'THREAD_MEMORY_NOT_SAVED', 'THREAD_MEMORY_UNREADABLE',
  'THREAD_MEMORY_JOINS_LOST', 'THREAD_MEMORY_CHANGED_WHILE_STOPPED', 'THREAD_MEMORY_RECOVERED',
  'THREAD_MEMORY_QUARANTINED', 'THREAD_MEMORY_COMPACTION_FAILED', 'THREAD_MEMORY_REMOVAL_FAILED',
  'THREAD_MEMORY_SEAL_UNREADABLE', 'THREAD_MEMORY_SEAL_NOT_SAVED', 'THREAD_MEMORY_HOLDS_NOT_RESOLVED',
] as const

/** `EFFORT_LEVELS` (src/config.ts), the levels in order, joined by single spaces. */
const effortLevels: Entry = {
  synopsis: '',
  async print(args, context) {
    const entry = 'EFFORT_LEVELS'
    expectArguments(entry, args, [])
    const levels = await packageExport(context, 'config.ts', entry)
    if (!Array.isArray(levels) || levels.length === 0 || levels.some((l) => typeof l !== 'string' || !/^[a-z]+$/.test(l))) {
      fail(PRINTER_FAIL_EXIT, `the installed package's src/config.ts export ${entry} is not an array of level names`)
    }
    return (levels as string[]).join(' ')
  },
}

/** `freshStartLine(<ref>, <keys>)` (src/live-row-sequence.ts), each key MODEL_LABEL_KEY or EFFORT_LABEL_KEY by its value. */
const freshStartLine: Entry = {
  synopsis: '<ref> <key> [<key>]',
  async print(args, context) {
    const entry = 'freshStartLine'
    expectSomeArguments(entry, args, ['ref', 'key', 'key'], 2)
    const [ref, ...keys] = args
    const known = [
      await packageString(context, 'persona-identity.ts', 'MODEL_LABEL_KEY'),
      await packageString(context, 'persona-identity.ts', 'EFFORT_LABEL_KEY'),
    ]
    for (const key of keys) {
      if (!known.includes(key)) usageFail(`${entry}: <key> must be one of ${known.join(', ')} (got '${key}')`)
    }
    if (new Set(keys).size !== keys.length) usageFail(`${entry}: <key> '${keys[0]}' is given twice`)
    if (keys.some((key, i) => i > 0 && known.indexOf(keys[i - 1]) > known.indexOf(key))) {
      usageFail(`${entry}: the <key>s must come in the order ${known.join(', ')} (got ${keys.join(', ')})`)
    }
    const build = await packageFunction<(ref: string, differing: readonly string[]) => unknown>(context, 'live-row-sequence.ts', entry)
    return builtString(entry, build(ref, keys))
  },
}

// ---------------------------------------------------------------------------
// test-50's Reaction Notice texts (test-50-reaction-notices.sh, a shared-mode
// scenario), every one from reaction-intake-diagnostics.ts,
// reaction-preparation-diagnostics.ts, tag-wrapper.ts, server-post.ts,
// permission-action-id.ts or reply-reminder.ts.
// ---------------------------------------------------------------------------

/** The changes a reaction event names, as a Reaction Notice's `reaction` attribute carries them. */
const REACTION_CHANGES: readonly string[] = ['added', 'removed']

/** The withdrawal reasons and fungible conditions a queue's withdrawn record names (src/delivery-queue.ts's types; the package exports no list). */
const REACTION_WITHDRAWAL_REASONS: readonly string[] = ['server-post', 'conversation-unknown', 'group-dm', 'open-refused']
const REACTION_FUNGIBLE_CONDITIONS: readonly string[] = ['not-a-channel', 'externally-shared', 'not_in_channel', 'channel_not_found']

/** Fails with a usage failure unless `value` is one of `allowed`. */
function checkOneOf(entry: string, name: string, value: string, allowed: readonly string[]): void {
  if (!allowed.includes(value)) usageFail(`${entry}: <${name}> must be one of ${allowed.join(', ')} (got '${value}')`)
}

/**
 * `buildReactionReceivedLine({ key, name }, record)` (reaction-intake-diagnostics.ts)
 * for a user reactor: the line of a newly stored Reaction Item, <seq> its
 * sequence in decimal.
 */
const reactionReceivedLine: Entry = {
  synopsis: '<name> <key> <chat> <message-ts> <added|removed> <emoji> <user> <seq>',
  async print(args, context) {
    const entry = 'buildReactionReceivedLine'
    expectArguments(entry, args, ['name', 'key', 'chat', 'message-ts', 'added|removed', 'emoji', 'user', 'seq'])
    const [name, key, channel, messageTs, change, emoji, user, seq] = args
    checkOneOf(entry, 'added|removed', change!, REACTION_CHANGES)
    if (!/^[1-9][0-9]{0,8}$/.test(seq!)) usageFail(`${entry}: <seq> '${seq}' is not a positive whole number in decimal`)
    const build = await packageFunction<(p: { key: string; name: string }, record: Record<string, unknown>) => unknown>(
      context,
      'reaction-intake-diagnostics.ts',
      entry,
    )
    return builtString(entry, build({ key: key!, name: name! }, { channel, message_ts: messageTs, change, emoji, user, seq: Number(seq) }))
  },
}

/**
 * `buildReactionDroppedLine({ key, name }, { reason, chat_id, message_ts, refusal })`
 * (reaction-intake-diagnostics.ts): <reason> one of the package's
 * REACTION_LOGGED_DROP_REASONS, <refusal> given for `open-refused` only.
 */
const reactionDroppedLine: Entry = {
  synopsis: '<name> <key> <reason> <chat> <message-ts> [<refusal>]',
  async print(args, context) {
    const entry = 'buildReactionDroppedLine'
    expectSomeArguments(entry, args, ['name', 'key', 'reason', 'chat', 'message-ts', 'refusal'], 5)
    const [name, key, reason, channel, messageTs, refusal] = args
    const reasons = await packageExport(context, 'reaction-intake-diagnostics.ts', 'REACTION_LOGGED_DROP_REASONS')
    if (!Array.isArray(reasons) || !reasons.includes(reason)) usageFail(`${entry}: <reason> '${reason}' is not one of the package's REACTION_LOGGED_DROP_REASONS`)
    if ((reason === 'open-refused') !== (refusal !== undefined)) usageFail(`${entry}: <refusal> is given for open-refused and only for it`)
    const build = await packageFunction<(p: { key: string; name: string }, drop: Record<string, unknown>) => unknown>(
      context,
      'reaction-intake-diagnostics.ts',
      entry,
    )
    const drop: Record<string, unknown> = { reason, chat_id: channel, message_ts: messageTs }
    if (refusal !== undefined) drop.refusal = refusal
    return builtString(entry, build({ key: key!, name: name! }, drop))
  },
}

/**
 * `buildReactionWithdrawnLine({ key, name, chat_id, message_ts }, <reason>, <condition>)`
 * (reaction-preparation-diagnostics.ts), <condition> given or not.
 */
const reactionWithdrawnLine: Entry = {
  synopsis: '<name> <key> <chat> <message-ts> <reason> [<condition>]',
  async print(args, context) {
    const entry = 'buildReactionWithdrawnLine'
    expectSomeArguments(entry, args, ['name', 'key', 'chat', 'message-ts', 'reason', 'condition'], 5)
    const [name, key, channel, messageTs, reason, condition] = args
    checkOneOf(entry, 'reason', reason!, REACTION_WITHDRAWAL_REASONS)
    if (condition !== undefined) checkOneOf(entry, 'condition', condition, REACTION_FUNGIBLE_CONDITIONS)
    const build = await packageFunction<(s: Record<string, string>, reason: string, condition?: string) => unknown>(
      context,
      'reaction-preparation-diagnostics.ts',
      entry,
    )
    return builtString(entry, build({ key: key!, name: name!, chat_id: channel!, message_ts: messageTs! }, reason!, condition))
  },
}

/** `buildReactionMessageUnknownLine({ key, name, chat_id, message_ts })` (reaction-preparation-diagnostics.ts). */
const reactionMessageUnknownLine: Entry = {
  synopsis: '<name> <key> <chat> <message-ts>',
  async print(args, context) {
    const entry = 'buildReactionMessageUnknownLine'
    expectArguments(entry, args, ['name', 'key', 'chat', 'message-ts'])
    const [name, key, channel, messageTs] = args
    const build = await packageFunction<(s: Record<string, string>) => unknown>(context, 'reaction-preparation-diagnostics.ts', entry)
    return builtString(entry, build({ key: key!, name: name!, chat_id: channel!, message_ts: messageTs! }))
  },
}

/** The printer's entries, by the name a script passes. Later scenarios add entries here. */
const ENTRIES: Readonly<Record<string, Entry>> = joinEntryTables({
  buildSharedStateUnresolvedNotice,
  buildSharedStateUnresolvedLine,
  buildSharedStateRecoveredNotice,
  buildSharedStateRecoveredLine,
  buildReloadApplyFailedNotice,
  sharedRecoveryLine,
  sharedChannelSaved: sharedProjection('saved'),
  sharedChannelEffective: sharedProjection('effective'),
  sharedThreadSince: sharedProjection('since'),
  sharedThreadCreated: sharedProjection('created'),
  sharedAttemptOrder,
  acceptedQueueItems,
  sharedQueueSnapshot,
  sharedThreadJoins,
  sharedOwnPostRecords,
  sharedOwnPostState,
  membershipRetryDelay,
  sharedQueueJoinsSaved,
  sharedDedupePreserved,
  sharedQueueReceipts,
  sharedRecordedButton,
  sharedPostMark,
  sharedSuccessfulPost,
  sharedMessagesWaitingPost,
  sharedObservedPostEvent,
  buildMessagesWaitingNotice: builderEntry('delivery-notices.ts', 'buildMessagesWaitingNotice', ['persona-ref', 'count', 'age-ms', 'state'], { count: 'number', 'age-ms': 'number' }),
  sharedDeliveryExpectation,
  sharedAssertAccounting,
  sharedExpectedParts,
  sharedAssertContent,
  sharedInjectedExpectedParts,
  sharedAssertInjectedContent,
  sharedCronIdentity,
  sharedPersonaFacts,
  sharedMembershipEvent,
  channelDeliveryAttemptStatusText: deliveryAttemptStatus,
  deliveryReasonText,
  reviewedChannelLine: reviewedChannelText,
  TAG_DESCRIPTION: constantEntry('tag-description.ts', 'TAG_DESCRIPTION'),
  MCP_INSTRUCTIONS: constantEntry('registry.ts', 'MCP_INSTRUCTIONS'),
  ...constantEntries('reload-preview-clauses.ts', SHARED_PREVIEW_NAMES),
  ...constantEntries('persona-diagnostics.ts', SHARED_DIAGNOSTIC_NAMES),
  MEMBERSHIP_UNRESOLVED: constantEntry('channel-membership.ts', 'MEMBERSHIP_UNRESOLVED'),
  MEMBERSHIP_STORAGE_FAILED: constantEntry('channel-membership.ts', 'MEMBERSHIP_STORAGE_FAILED'),
  MEMBERSHIP_INVENTORY_INCOMPLETE: constantEntry('channel-membership-scan.ts', 'MEMBERSHIP_INVENTORY_INCOMPLETE'),
  membershipDiagnostic: builderEntry('channel-membership.ts', 'membershipDiagnostic', ['key', 'channel', 'fault']),
  reviewRecoveryLine: builderEntry('reload-review.ts', 'reviewRecoveryLine', ['recovered|unresolved']),
  threadStampUndecidedCause: builderEntry('persona-diagnostics.ts', 'threadStampUndecidedCause', ['channel']),
  THREAD_MEMORY_SLACK_RETRY_WARNING: constantEntry('thread-memory-reports.ts', 'THREAD_MEMORY_SLACK_RETRY_WARNING'),
  THREAD_MEMORY_OWN_POST_LOSS_WARNING: constantEntry('thread-memory-reports.ts', 'THREAD_MEMORY_OWN_POST_LOSS_WARNING'),
  THREAD_REPLY_HOLD_MS: constantEntry('delivery-constants.ts', 'THREAD_REPLY_HOLD_MS'),
  DELIVERY_MAX_AD_CALLS_PER_S: constantEntry('delivery-constants.ts', 'DELIVERY_MAX_AD_CALLS_PER_S'),
  NAME_LOOKUP_TIMEOUT_MS: constantEntry('tag-wrapper.ts', 'NAME_LOOKUP_TIMEOUT_MS'),
  QUEUE_COMPACT_INTERVAL_MS: constantEntry('delivery-queue.ts', 'QUEUE_COMPACT_INTERVAL_MS'),
  TEST_MEASUREMENTS_KEY: constantEntry('config.ts', 'TEST_MEASUREMENTS_KEY'),
  TEST_MEASUREMENT_TIMINGS_KEY: constantEntry('config.ts', 'TEST_MEASUREMENT_TIMINGS_KEY'),
  TEST_MEASUREMENTS_FILE_NAME: constantEntry('test-measurements.ts', 'TEST_MEASUREMENTS_FILE_NAME'),
  buildTestMeasurementsStartLine: builderEntry('test-measurements.ts', 'buildTestMeasurementsStartLine', ['path']),
  THREAD_MEMORY_SEAL_FILE: constantEntry('thread-memory-seal.ts', 'THREAD_MEMORY_SEAL_FILE'),
  buildThreadMemoryNotSavedNotice: builderEntry('thread-memory-reports.ts', 'buildThreadMemoryNotSavedNotice', ['ref', 'channels', 'path', 'step', 'error'], { channels: 'channels' }),
  buildThreadMemoryUnreadableNotice: builderEntry('thread-memory-reports.ts', 'buildThreadMemoryUnreadableNotice', ['ref', 'channels', 'path'], { channels: 'channels' }),
  buildThreadMemoryChangedWhileStoppedNotice: builderEntry('thread-memory-reports.ts', 'buildThreadMemoryChangedWhileStoppedNotice', ['ref', 'channels', 'wording'], { channels: 'channels' }),
  buildThreadMemoryRecoveredNotice: builderEntry('thread-memory-reports.ts', 'buildThreadMemoryRecoveredNotice', ['ref', 'channels'], { channels: 'channels' }),
  buildThreadMemoryNotSavedLine: builderEntry('thread-memory-reports.ts', 'buildThreadMemoryNotSavedLine', ['key', 'channels', 'path', 'step', 'error', 'notice-only'], { channels: 'channels', 'notice-only': 'boolean' }),
  buildThreadMemoryUnreadableLine: builderEntry('thread-memory-reports.ts', 'buildThreadMemoryUnreadableLine', ['key', 'channels', 'path', 'error', 'missing'], { channels: 'channels', missing: 'boolean' }),
  buildThreadMemoryChangedWhileStoppedLine: builderEntry('thread-memory-reports.ts', 'buildThreadMemoryChangedWhileStoppedLine', ['key', 'channels', 'case', 'wording'], { channels: 'channels' }),
  buildThreadMemoryRecoveredLine: builderEntry('thread-memory-reports.ts', 'buildThreadMemoryRecoveredLine', ['key', 'channels'], { channels: 'channels' }),
  buildThreadMemoryQuarantinedLine: builderEntry('thread-memory-reports.ts', 'buildThreadMemoryQuarantinedLine', ['key', 'path', 'count', 'invalid-final'], { count: 'number', 'invalid-final': 'number' }),
  buildThreadMemoryCompactionFailedLine: builderEntry('thread-memory-reports.ts', 'buildThreadMemoryCompactionFailedLine', ['key', 'path', 'step', 'error']),
  buildThreadMemoryRemovalFailedLine: builderEntry('thread-memory-reports.ts', 'buildThreadMemoryRemovalFailedLine', ['key', 'path', 'step', 'error']),
  buildThreadMemorySealUnreadableLine: builderEntry('thread-memory-reports.ts', 'buildThreadMemorySealUnreadableLine', ['path', 'error']),
  buildThreadMemorySealNotSavedLine: builderEntry('thread-memory-reports.ts', 'buildThreadMemorySealNotSavedLine', ['path', 'error', 'unsynced'], { unsynced: 'boolean' }),
  buildThreadMemoryHoldsNotResolvedLine: builderEntry('thread-memory-reports.ts', 'buildThreadMemoryHoldsNotResolvedLine', ['key', 'error']),
  buildThreadMemoryJoinsLostLine: threadLossEntry(false, false),
  buildThreadMemoryJoinsLostNotice: threadLossEntry(true, false),
  buildThreadMemoryOwnPostLostLine: threadLossEntry(false, true),
  buildThreadMemoryOwnPostLostNotice: threadLossEntry(true, true),
  stoppedDowngradeBaseline,
  // test-47 (test-47-shared-channel-upgrade.sh) and test-40's earlier release.
  reloadStartRefusalLine,
  removedKeyRefusal,
  earlierQueueRecordUnreadableLine,
  earlierQueueRecordUnreadableNotice,
  operatorReviewRequest,
  operatorReviewPending,
  operatorReviewCancelled,
  sharedReviewConsumed,
  sharedRecoveryRequest,
  sharedRecoveryPending,
  sharedRecoveryConsumed,
  RELOAD_STALE_CONFIRMATION: constantEntry('reload-apply.ts', 'RELOAD_STALE_CONFIRMATION'),
  RELOAD_RECORD_WRITE_FAILED: constantEntry('reload.ts', 'RELOAD_RECORD_WRITE_FAILED'),
  sharedConfigurationMatches,
  sharedAuthorityPreserved,
  sharedThreadStamp,
  sharedApplicationPreserved,
  reviewOutcomeLine: builderEntry('reload-review.ts', 'reviewOutcomeLine', ['status']),
  sharedConfigurationValue,
  reloadSharedAuthorityStartLine: sharedAuthorityStartLine,
  // Scenario 8 (test-20-fmk-old-binary.sh).
  PHASE1_FLOOR_VERSION: constantEntry('ad-version-gate.ts', 'PHASE1_FLOOR_VERSION'),
  AD_BELOW_PHASE1_FLOOR: constantEntry('install-check-labels.ts', 'AD_BELOW_PHASE1_FLOOR'),
  buildBelowPhase1FloorMessage: belowPhase1FloorMessage,
  AD_SYSTEM_INSTALL_TOO_OLD: constantEntry('install-check-labels.ts', 'AD_SYSTEM_INSTALL_TOO_OLD'),
  AD_CLIENT_MINIMUM: clientMinimumVersion,
  buildSystemInstallTooOldMessage: systemInstallTooOldMessage,
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
  adGraceMs: derivedWaitEntry('adGraceMs'),
  adLaunchBoundMs: adLaunchBoundEntry,
  testTimerOverridesBlock,
  buildTestTimerOverridesLine: testTimerOverridesLine,
  effectiveTestTimer: effectiveTestTimerEntry,
  // Scenario 25 (test-27-fmk-unusable-name.sh).
  AD_ERROR_CLASS_UNUSABLE_NAME: constantEntry('ad-error-class.ts', 'AD_ERROR_CLASS_UNUSABLE_NAME'),
  // Scenario 20 (test-23-fmk-latch-recheck.sh); its DEFAULT_AD_SETTINGS and
  // RECHECK_VERDICT_STILL_LATCHED are the entries below.
  ...constantEntries('pane-read.ts', PANE_READ_KIND_NAMES),
  latchClearRetryAtOnceLineHead,
  LATCHING_LIVENESS_NOTE: constantEntry('row-read-rules.ts', 'LATCHING_LIVENESS_NOTE'),
  // Scenario 10 (test-22-fmk-wrong-server.sh).
  RECHECK_VERDICT_STILL_LATCHED: constantEntry('conflict-latch.ts', 'RECHECK_VERDICT_STILL_LATCHED'),
  conflictLatchSetLineHead: conflictLatchSetHead,
  PROBE_PANE_READ_LINES: constantEntry('pane-read.ts', 'PROBE_PANE_READ_LINES'),
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
  escalateDeadSweepLineHead: escalateDeadSweepHead,
  reconnectGoneLineHead: reconnectGoneHead,
  relaunchAfterKillLine: relaunchAfterKill,
  relaunchWithoutKillLine: relaunchWithoutKill,
  latchClearRetryAtOnceLineHeadForRef: builderEntry('session-manager.ts', 'latchClearRetryAtOnceLineHead', ['ref']),
  DEFAULT_AD_SETTINGS: adSettingDefault,
  tmuxUnresponsiveOnsetText: builderEntry('persona-episodes.ts', 'tmuxUnresponsiveOnsetText', ['key']),
  tmuxUnresponsiveAlertText: unresponsiveAlert,
  restartCapReachedNoticeText: builderEntry('session-manager.ts', 'restartCapReachedNoticeText', []),
  // b.omv SR-5.4: reconnect's text and Enter use the production delay.
  ENTER_DELAY_MS: constantEntry('delivery-constants.ts', 'ENTER_DELAY_MS'),
  // Scenario 8 (test-20-fmk-old-binary.sh).
  classifyAdError: adErrorClass,
  // Scenario 23 (test-20-fmk-old-binary.sh).
  CLIENT_DEV_SENTINEL_VERSION: constantEntry('ad-version-gate.ts', 'CLIENT_DEV_SENTINEL_VERSION'),
  AD_SYSTEM_INSTALL_UNREACHABLE: constantEntry('install-check-labels.ts', 'AD_SYSTEM_INSTALL_UNREACHABLE'),
  UNREACHABLE_REASON_UNPARSEABLE_VERSION: constantEntry('ad-version-gate.ts', 'UNREACHABLE_REASON_UNPARSEABLE_VERSION'),
  meetsPhase1Floor: phase1Floor,
  // Scenario 24 (test-26-fmk-timing-settings.sh).
  AD_SETTINGS_LOG_PREFIX: constantEntry('ad-settings.ts', 'AD_SETTINGS_LOG_PREFIX'),
  buildAdSettingsValuesLine: adSettingsValuesLine,
  AD_TMUX_KEYS: adTmuxKeys,
  pendingGraceMinimumSeconds: graceMinimum,
  adAlertThresholdMs: derivedWaitEntry('adAlertThresholdMs'),
  wholeMinutes: minutesOf,
  stuckLaunchRelaunchingText: relaunchingText,
  STARTUP_ERROR_SPAWN_FAILED: constantEntry('session-manager.ts', 'STARTUP_ERROR_SPAWN_FAILED'),
  liveRowSequenceWaitArmedLine: liveRowWaitArmedLine,
  liveRowSequenceWaitEndedLine: liveRowWaitEndedLine,
  liveRowSequenceRunLine: liveRowRunLine,
  // Scenario 24's refused values (test-26-fmk-timing-settings.sh).
  AD_CONFIG_FILE_DISPLAY_NAME: constantEntry('ad-config-file.ts', 'AD_CONFIG_FILE_DISPLAY_NAME'),
  adConfigMalformedOnset: configMalformedOnset,
  adConfigMalformedRaisedLine: configMalformedRaisedLine,
  adConfigMalformedClearedLine: configMalformedClearedLine,
  buildAdSettingsRefusedReadLine: refusedReadLine,
  unavailableRetryRetryLine: retryLine,
  unavailableRetryReArmedLine: reArmedLine,
  RESTART_OUTCOME_LIVENESS_UNKNOWN: constantEntry('restart.ts', 'RESTART_OUTCOME_LIVENESS_UNKNOWN'),
  unavailableRetryStoppedLine: stoppedLine,
  // Scenario 24's call timeout (test-26-fmk-timing-settings.sh).
  buildAdCallTimeoutWarningLine: callTimeoutWarningLine,
  adCallTimeoutNeed: callTimeoutNeed,
  LAUNCH_TIMEOUT_PHRASE: constantEntry('ad-description-phrases.ts', 'LAUNCH_TIMEOUT_PHRASE'),
  // Scenario 8's re-check stop (test-20-fmk-old-binary.sh).
  AD_VERSION_RECHECK_STOP_EXIT_CODE: constantEntry('ad-version-gate.ts', 'AD_VERSION_RECHECK_STOP_EXIT_CODE'),
  // Scenario 24's lines with exported builders (test-26-fmk-timing-settings.sh).
  launchUnavailableGetLine: launchUnavailableGetLine,
  UNAVAILABLE_RETRY_STOP_ROW_LIVE: constantEntry('unavailable-retry.ts', 'UNAVAILABLE_RETRY_STOP_ROW_LIVE'),
  UNAVAILABLE_RETRY_STOP_RECOVERED: constantEntry('unavailable-retry.ts', 'UNAVAILABLE_RETRY_STOP_RECOVERED'),
  stuckLaunchAbortStartedLine: abortStartedLine,
  reprobeDeadLine: deadReprobeLine,
  liveRowSequenceStartLine: sequenceStartLine,
  RELOAD_APPLIED: constantEntry('reload-apply.ts', 'RELOAD_APPLIED'),
  // test-29 (test-29-invited-channels.sh), a shared-mode scenario.
  MEMBERSHIP_READINESS_ROUTE: constantEntry('channel-membership-readiness.ts', 'MEMBERSHIP_READINESS_ROUTE'),
  MEMBERSHIP_INVENTORY_COMPLETE: constantEntry('channel-membership-scan.ts', 'MEMBERSHIP_INVENTORY_COMPLETE'),
  UNCLAIMED_CHANNEL: constantEntry('persona-diagnostics.ts', 'UNCLAIMED_CHANNEL'),
  unclaimedChannelCause: builderEntry('persona-diagnostics.ts', 'unclaimedChannelCause', ['channel']),
  ...constantEntries('persona-diagnostics.ts', UNCLAIMED_REASON_NAMES),
  fungibleUnclaimedChannelCause: fungibleUnclaimedCause,
  PERSONA_OPEN_CHANNEL: constantEntry('persona-diagnostics.ts', 'PERSONA_OPEN_CHANNEL'),
  openChannelCause: openCause,
  PERSONA_CHANNEL_DELIVERY_SET: constantEntry('persona-diagnostics.ts', 'PERSONA_CHANNEL_DELIVERY_SET'),
  MESSAGE_RECEIVED: constantEntry('persona-diagnostics.ts', 'MESSAGE_RECEIVED'),
  MESSAGE_DELIVERED: constantEntry('persona-diagnostics.ts', 'MESSAGE_DELIVERED'),
  THREAD_MEMORY_LOOKUP_DEADLINE_MS: constantEntry('delivery-constants.ts', 'THREAD_MEMORY_LOOKUP_DEADLINE_MS'),
  THREAD_MEMORY_RETRY_MIN_MS: constantEntry('delivery-constants.ts', 'THREAD_MEMORY_RETRY_MIN_MS'),
  THREAD_MEMORY_RETRY_MAX_MS: constantEntry('delivery-constants.ts', 'THREAD_MEMORY_RETRY_MAX_MS'),
  MEMBERSHIP_REQUEST_TIMEOUT_MS: constantEntry('channel-membership-retry.ts', 'MEMBERSHIP_REQUEST_TIMEOUT_MS'),
  MEMBERSHIP_ATTEMPT_TIMEOUT_MS: constantEntry('channel-membership-retry.ts', 'MEMBERSHIP_ATTEMPT_TIMEOUT_MS'),
  MEMBERSHIP_RETRY_MIN_MS: constantEntry('channel-membership-retry.ts', 'MEMBERSHIP_RETRY_MIN_MS'),
  MEMBERSHIP_RETRY_MAX_MS: constantEntry('channel-membership-retry.ts', 'MEMBERSHIP_RETRY_MAX_MS'),
  MEMBERSHIP_PAGE_LIMIT: constantEntry('channel-membership-retry.ts', 'MEMBERSHIP_PAGE_LIMIT'),
  DEFAULT_QUEUED_ACK_REACTION: constantEntry('config.ts', 'DEFAULT_QUEUED_ACK_REACTION'),
  DEFAULT_ACK_REACTION: constantEntry('config.ts', 'DEFAULT_ACK_REACTION'),
  channelDeliverySetCause: deliverySetCause,
  NO_STORED_CHOICE: constantEntry('persona-diagnostics.ts', 'NO_STORED_CHOICE'),
  SET_CHANNEL_DELIVERY_TOOL: constantEntry('channel-delivery.ts', 'SET_CHANNEL_DELIVERY_TOOL'),
  channelDeliveryDeclarativeRefusal: builderEntry('registry.ts', 'channelDeliveryDeclarativeRefusal', ['name', 'key']),
  channelDeliveryChannelRefusal: builderEntry('registry.ts', 'channelDeliveryChannelRefusal', ['name', 'key', 'channel']),
  channelDeliveryValueRefusal: builderEntry('registry.ts', 'channelDeliveryValueRefusal', ['name', 'key', 'value']),
  channelDeliveryAttemptResultText: deliveryAttemptResult,
  channelDeliveryAttemptInputRefusal: builderEntry('registry.ts', 'channelDeliveryAttemptInputRefusal', ['name', 'key']),
  channelDeliveryDryRunRefusal: builderEntry('registry.ts', 'channelDeliveryDryRunRefusal', ['name', 'key']),
  modeSwitchLine: modeSwitchLineEntry,
  channelModeOf: channelModeOfSwitch,
  MODE_SWITCH_SETTING: constantEntry('reload-plan.ts', 'MODE_SWITCH_SETTING'),
  CHANNEL_DELIVERY_FILE_NAME: constantEntry('channel-delivery.ts', 'CHANNEL_DELIVERY_FILE_NAME'),
  formatPersonaDiagnostic: personaDiagnosticLine,
  // Per-persona model and effort (test-49-fmk-model-effort.sh; b.fx2).
  MODEL_ARG_PREFIX: constantEntry('agent-director-template.ts', 'MODEL_ARG_PREFIX'),
  EFFORT_ARG_PREFIX: constantEntry('agent-director-template.ts', 'EFFORT_ARG_PREFIX'),
  EFFORT_LEVELS: effortLevels,
  freshStartLine,
  // test-50 (test-50-reaction-notices.sh), a shared-mode scenario.
  REACTION_RECEIVED: constantEntry('reaction-intake-diagnostics.ts', 'REACTION_RECEIVED'),
  REACTION_DROPPED: constantEntry('reaction-intake-diagnostics.ts', 'REACTION_DROPPED'),
  REACTION_WITHDRAWN: constantEntry('reaction-preparation-diagnostics.ts', 'REACTION_WITHDRAWN'),
  REACTION_MESSAGE_UNKNOWN: constantEntry('reaction-preparation-diagnostics.ts', 'REACTION_MESSAGE_UNKNOWN'),
  buildReactionReceivedLine: reactionReceivedLine,
  buildReactionDroppedLine: reactionDroppedLine,
  buildReactionWithdrawnLine: reactionWithdrawnLine,
  buildReactionMessageUnknownLine: reactionMessageUnknownLine,
  TAG_SOURCE: constantEntry('tag-wrapper.ts', 'TAG_SOURCE'),
  SERVER_POST_EVENT_TYPE: constantEntry('server-post.ts', 'SERVER_POST_EVENT_TYPE'),
  encodePermissionActionId: builderEntry('permission-action-id.ts', 'encodePermissionActionId', ['allow|deny', 'instance-id', 'token']),
  REPLY_REMINDER_TEXT: constantEntry('reply-reminder.ts', 'REPLY_REMINDER_TEXT'),
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
  async importAgentDirectorClient() {
    return await import(Bun.resolveSync('agent-director', join(PKG_DIR, 'src')))
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
