/**
 * test-helpers/conflict-cases.ts — The table of CONFLICT latch cases for
 * `test.each` (b.jg5 SRJ-1304; cases per SRJ-501, SRJ-505 and SRJ-507).
 *
 * One row per refusal CSCB can meet: the stub's `errTmuxSessionConflict`
 * description from the verb (and option) that gives it, and what latching a
 * persona on it records. Every entry of the stub's `CONFLICT_CASES` appears
 * in at least one row.
 *
 * Columns filled here (E13, the latch record):
 *   - `name`: a readable row name, built from the site kind, the stub's case
 *     identifier and the option set;
 *   - `site`: the site kind that meets the refusal ({@link ConflictCaseSite}):
 *     a plain spawn, a reuse spawn, a `resume`, a pane verb or a kill (named
 *     by its verb), one of the dialog approver's calls
 *     ({@link ApproverSite}, `approver <verb>`; select those rows with
 *     {@link isApproverSite} or take {@link APPROVER_CONFLICT_CASE_ROWS}),
 *     or one of the liveness checks' `read-pane` sites
 *     ({@link LivenessPaneSite}; select those rows with
 *     {@link isLivenessPaneSite} or take {@link LIVENESS_PANE_CONFLICT_CASE_ROWS});
 *   - `verb`, `stubCase`, `options`, `sessionName`, and `build`, a thunk that
 *     builds the error through the stub's `errTmuxSessionConflict` with them;
 *   - `latchCase`: the case `src/conflict-latch.ts` recognises (SRJ-507);
 *   - `refusedOperation`: what that verb's refusal refused (SRJ-501): a plain
 *     spawn, a spawn with `--reuse-finished`, a `resume`, or, for a pane verb
 *     or a kill, P's next check or recovery;
 *   - `rowState`: the row state the latch records on that path (SRJ-501): no
 *     row after the pre-spawn scan's refusal, `ended` after a plain spawn's
 *     "duplicate session" answer and on the finished-row path, the state the
 *     path last read for a pane verb or a kill, unreadable where the path
 *     could not read it;
 *   - `rowAfter`, on the plain spawn's rows only (E28 T4; b.jg5 SRJ-111,
 *     {@link PLAIN_SPAWN_CONFLICT_CASE_ROWS}): the row agent-director leaves,
 *     none after the pre-spawn scan's refusal and `ended` after a "duplicate
 *     session" answer, so a case scripts the reads after the refusal from it.
 *
 * Columns filled here (E13 T2, the CONFLICT notice, SRJ-1004):
 *   - `notice`: the {@link ExpectedConflictNotice} for the row's case, quoted
 *     session and description: its `lines` in SRJ-1004's order, its `text`
 *     (the lines joined), and `carries`, the flags for the lines it must
 *     carry: the pointer to "Operator actions", the must-not-be-ended line
 *     (`row` for "a different instance id", `store` for "another
 *     agent-director store", `none` otherwise), the `list` line and the
 *     human-only line.
 *
 * Unrecognised text and "never reported in", which carry no case sentence,
 * are rows of the table (a `resume`'s unrecognised answer and a `kill`'s
 * never-reported-in answer); every `ConflictLatchCase` has at least one row.
 *
 * The dialog approver's CONFLICT rows (E17; b.jg5 SRJ-117, SRJ-118, SRJ-404,
 * SRJ-501), {@link APPROVER_CONFLICT_CASE_ROWS}: one row per stub CONFLICT
 * case its `read-pane` and its `send-keys` can answer on a `pending` row (HO
 * rev 27; agent-director's pane verbs): "the agent's pane was not found",
 * with and without "the agent's pane was not adopted" (a lost create reply),
 * and "conflicting labels" from both; "not this launch's session" from
 * `read-pane` only (more than one leftover session), since `send-keys` on a
 * `pending` row answers a leftover with `ErrSpawnNotInteractive`, not
 * CONFLICT. Each records the refused operation "P's next check or recovery"
 * and the state `pending`, which the lap's `status` read gave before the
 * pane verb. The approver's `status` reads only the store and answers no
 * CONFLICT, so it has no CONFLICT row.
 *
 * The liveness checks' `read-pane` CONFLICT rows (E18; b.jg5 SRJ-117,
 * SRJ-501), {@link LIVENESS_PANE_CONFLICT_CASE_ROWS}: three site kinds
 * ({@link LivenessPaneSite}, {@link LIVENESS_PANE_SITES}; select their rows
 * with {@link isLivenessPaneSite} or {@link livenessPaneConflictRowsAt}):
 * b.d61's working-row verdict, b.f2b's waiting-row check and the launch
 * wait's evidence read, each reading P's own row through the shared reader.
 * Each site has one row per stub CONFLICT case the approver's `read-pane`
 * rows cover (built from those rows, so the two stay in step): "the agent's
 * pane was not found", with and without "the agent's pane was not adopted",
 * "not this launch's session" and "conflicting labels". Each records the
 * refused operation "P's next check or recovery" and the state the site's
 * path last read ({@link LIVENESS_PANE_SITE_ROW_STATE}): `working` at the
 * working-row verdict and at the launch wait's evidence read (the wait's
 * poll read `working`), `waiting` at the waiting-row check.
 *
 * The reconnect's `send-keys` CONFLICT rows (E19 T1; b.jg5 SRJ-118, SRJ-501,
 * SRJ-505, SRJ-613), {@link RECONNECT_CONFLICT_CASE_ROWS}: the site kind
 * {@link RECONNECT_SITE} (`reconnectMcpWithCause`'s one `send-keys` of
 * `/mcp reconnect`; select its rows with {@link isReconnectSite} or
 * {@link reconnectConflictRowsAt}). One row per stub CONFLICT case that
 * `send-keys` can answer on a live row that is not `pending`: the cases the
 * approver's `send-keys` rows cover ("the agent's pane was not found", with
 * and without "the agent's pane was not adopted", and "conflicting labels")
 * and "not this launch's session", which on such a row is a CONFLICT (the
 * approver's `pending` row answers it with `ErrSpawnNotInteractive`
 * instead): the same set the approver's `read-pane` rows cover. Each case
 * has a row for each state the reconnect's caller last read
 * ({@link RECONNECT_ROW_STATES}): `waiting` (the ladder's `waiting` branch,
 * the restart adapter's `waiting` row, the launch wait's poll) and `working`
 * (the adapter's stale `working` row, the launch wait's positive-idle
 * reconnect). Each records the refused operation "P's next check or
 * recovery". The "not this launch's session" rows carry
 * `leftoverOfEarlierLaunch` (SRJ-613's leftover case: a leftover of an
 * earlier launch holds the persona's session), so a test can select them.
 *
 * b.jdc's prompt-row `read-pane` CONFLICT rows (E19 T2; b.jg5 SRJ-117,
 * SRJ-501, SRJ-606, SRJ-607), {@link PROMPT_ROW_PANE_CONFLICT_CASE_ROWS}: two
 * site kinds ({@link PromptRowPaneSite}, {@link PROMPT_ROW_PANE_SITES};
 * select their rows with {@link isPromptRowPaneSite} or
 * {@link promptRowPaneConflictRowsAt}): b.jdc's reconnect verdict
 * (`promptRowReconnectVerdict`) and b.jdc's ladder action
 * (`launchOnPromptRow`), each reading P's own row through the shared reader.
 * Each site has one row per stub CONFLICT case the liveness checks'
 * `read-pane` rows cover (built from the approver's `read-pane` rows, as
 * theirs are), for each prompt state (`PROMPT_ROW_STATES` of
 * `src/session-manager.ts`: the state the path last read, `ask_user` or
 * `check_permission`), each refusing P's next check or recovery. The row
 * name carries the state (`<site> (<state>): <stub case>`).
 *
 * The checked kill's rows (E20; b.jg5 SRJ-110, SRJ-501, SRJ-512, the E13, E16
 * and E19 hatch notes): the restart path's kill before a relaunch
 * ({@link RESTART_KILL_SITE}, `_buildKillSessionAdapter`) and the live-row
 * sequence's two kills (below), the kinds of {@link KillSite}. The collision
 * ladder makes no kill and no delete (E22): a live row's kills are the
 * sequence's. The restart kill has one CONFLICT row per stub case `kill`
 * answers ("not this launch's session", "never reported in", "conflicting
 * labels"), each refusing P's next check or recovery and recording the state
 * the restart run last read, carried by the `dead` reading handed to the
 * kill (`ended`, with no latch-time `status` read: `latchTimeRead` false;
 * b.jg5 SRJ-501; {@link RESTART_KILL_CONFLICT_CASE_ROWS}). Its UNUSABLE NAME
 * rows: {@link RESTART_KILL_UNUSABLE_NAME_CASE_ROWS}, one per fault, refused
 * operation none, their state the one the run's `dead` reading carries.
 *
 * The live-row sequence's kill rows (E21; b.jg5 SRJ-110, SRJ-501, SRJ-512,
 * SRJ-613, SRJ-705; the E13 and E20 hatch notes): two site kinds
 * ({@link SequenceKillSite}, {@link SEQUENCE_KILL_SITES}; select their rows
 * with {@link isSequenceKillSite} or {@link sequenceKillConflictRowsAt}):
 * {@link SEQUENCE_STEP1_KILL_SITE} (step 1's kill, seeded with the state its
 * starter last read) and {@link SEQUENCE_STEP4_KILL_SITE} (step 4's, seeded
 * with the state step 3's last `get` read); {@link SEQUENCE_KILL_STEP} gives
 * each its step. For each, and for each state the sequence last read before
 * the kill ({@link SEQUENCE_KILL_ROW_STATES}, keyed by
 * {@link SequenceKillLastRead}: `pending`, and `waiting`, a live state other
 * than `pending`), one CONFLICT row per stub case `kill` answers, each
 * refusing P's next check or recovery and recording that state, with no
 * latch-time `status` read (`latchTimeRead` false: the sequence hands the
 * latch the state it last read), named `<site> (<state>): <stub case>`
 * ({@link SEQUENCE_KILL_CONFLICT_CASE_ROWS}). The step-1 kill's "not this
 * launch's session" row on a `pending` seed is SRJ-613's kill backstop
 * (`killBackstop`). The UNUSABLE NAME rows: one per fault for each sequence
 * kill and each of those states, refused operation none
 * ({@link SEQUENCE_KILL_UNUSABLE_NAME_CASE_ROWS},
 * {@link sequenceKillUnusableNameRowsAt}).
 *
 * The reuse spawn's rows (E22; b.jg5 SRJ-112, SRJ-501, SRJ-507, SRJ-512;
 * HO rev 15, rev 20): the site kind {@link REUSE_SPAWN_SITE}
 * (`reuseSpawnForPersona`; {@link REUSE_SPAWN_CONFLICT_CASE_ROWS}), one
 * CONFLICT row per stub case a spawn can answer, each refusing the reuse
 * spawn (`REFUSED_OPERATION_REUSE_SPAWN`). A reuse of an id with no row is an
 * ordinary fresh spawn, which the pre-spawn scan refuses with nothing
 * written: its rows (`scan-leftover`, and `conflicting-labels` in its scan
 * form) record no row and carry `noRowWritten`, so a test selects them for
 * the no-row cases ({@link reuseSpawnScanRows}). A reuse of a finished row
 * records the state its path last read, `ended`: `no-valid-id`,
 * `different-id` and `another-store` (each with and without the stub's
 * "duplicate session" extras, its `plainSpawn` option), `own-id`,
 * `leftover`, `duplicate-session-leftover`, `conflicting-labels` in its
 * "duplicate session" form and `unrecognised`. The UNUSABLE NAME rows: one
 * per fault at the reuse spawn, refused operation none, recording `ended`
 * ({@link REUSE_SPAWN_UNUSABLE_NAME_CASE_ROWS}).
 *
 * The stuck-launch abort's kill rows (E29; b.jg5 SRJ-412, SRJ-110, SRJ-501,
 * SRJ-512, SRJ-613): the site kind {@link STUCK_LAUNCH_ABORT_SITE}, the
 * abort kill's own site (`abortKillOwnStuckLaunch`, re-exported from
 * `src/session-manager.ts`, so the kind is the head of its log lines; select
 * its rows with {@link isStuckLaunchAbortSite}). The abort kills only a
 * covered row read `pending` at B, so every row records `pending`, the state
 * the rule's `get` last read, with no latch-time `status` read
 * (`latchTimeRead` false). One CONFLICT row per stub case `kill` answers,
 * each refusing P's next check or recovery
 * ({@link STUCK_LAUNCH_ABORT_CONFLICT_CASE_ROWS}); its "not this launch's
 * session" row is SRJ-613's kill backstop (`killBackstop`: the abort's kill
 * on a `pending` row answering it latches the persona with nothing sent).
 * Its UNUSABLE NAME rows: one per fault, refused operation none, recording
 * `pending` ({@link STUCK_LAUNCH_ABORT_UNUSABLE_NAME_CASE_ROWS}). The latch
 * re-check's columns are E30's.
 *
 * The `resume` rows (b.jg5 SRJ-113, SRJ-501, SRJ-507; HO rev 15, rev 20):
 * the site kind `resume`, each refusing the `resume`
 * (`REFUSED_OPERATION_RESUME`) and recording `ended`, the state the
 * finished-row path last read, or unreadable for unrecognised text.
 * "another agent-director store" is there in its "duplicate session" form
 * (the stub's `plainSpawn` extras) beside its plain form; "conflicting
 * labels" is a duplicate label's, its "duplicate session" form (the scan's
 * form is a plain spawn's only). The same rows at the live-row sequence's
 * step-6 `resume`: the site kind {@link SEQUENCE_RESUME_SITE}, for each
 * state the sequence's last `get` read before it
 * ({@link SEQUENCE_RESUME_ROW_STATES}: `ended`, `missing`), recording that
 * state ({@link SEQUENCE_RESUME_CONFLICT_CASE_ROWS},
 * {@link sequenceResumeConflictRowsAt}; not in {@link CONFLICT_CASE_ROWS},
 * since only the recorded state differs).
 *
 * Other exports (E13 T2):
 *   - {@link expectedConflictNotice}: the expected notice for any case,
 *     session and description (none: no description line), assembled from
 *     the fixed lines and the case sentences `src/conflict-latch.ts` exports
 *     (`CONFLICT_NOTICE_*`, `CONFLICT_CASE_SENTENCES`), with the description
 *     rendered as a record holds it (`renderLogMessageText`) and both it and
 *     the session name escaped once for Slack (`escapeSlackControlCharacters`).
 *     It never calls `conflictNoticeText`, so it is an independent check of it;
 *   - {@link SESSION_ENDING_COMMAND_FORMS} and {@link sessionEndingCommandsIn}:
 *     the session-ending command forms of ADSRD SR-1.4 that SRJ-1001 lists
 *     (`kill` named as a command to run, `pause`, `--include-finished`,
 *     `tmux kill-session`, `tmux kill-server`), as patterns, and the names of
 *     the forms a text matches. None matches agent-director's own "no kill was
 *     sent", "retry kill later" or "never delete this row". E16's, E29's and
 *     E36's text checks reuse them;
 *   - {@link CSCB_OWN_LINE_FORBIDDEN} and {@link cscbOwnLineForbiddenIn}: what
 *     CSCB's own lines never spell beyond those five forms (`kill-pane`,
 *     `set-option`, `agent-director delete`, the latch-clearing command,
 *     `has-session`, either label option's name), and each entry a line
 *     matches. The CONFLICT notice's and the stuck-launch post's checks reuse
 *     them;
 *   - {@link cscbOwnLines}: a notice's lines with agent-director's quoted
 *     description taken out, so a check over CSCB's own words lets the quoted
 *     description through. Two forms: a CONFLICT notice's description line
 *     (SRJ-1004; the line that opens with `CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD`)
 *     is dropped whole; a description quoted inside a sentence (SRJ-1019's
 *     one-line notice) is cut out of its line, its frame and every CSCB word
 *     kept ({@link withoutInlineDescription}). {@link cscbOwnText} joins the
 *     lines back.
 *
 * Unusable-name rows (E16 T1 and E17, SRJ-512 and SRJ-1019), {@link UNUSABLE_NAME_CASE_ROWS}:
 * one row per fault in the stub's `UNUSABLE_NAME_FAULTS` for each verb site
 * kind ({@link UNUSABLE_NAME_SITES}): those E16 T1 wires (`resume`, a plain
 * spawn, `read-pane`, `status`, `get`), then the dialog approver's `status`, `read-pane` and `send-keys`
 * (E17, {@link APPROVER_SITES}; {@link APPROVER_UNUSABLE_NAME_CASE_ROWS}),
 * and the reuse spawn's (E22, {@link REUSE_SPAWN_UNUSABLE_NAME_CASE_ROWS},
 * recording `ended`, the state its path last read).
 * Columns ({@link UnusableNameCaseRow}):
 *   - `name` (`<site>: <fault>`), `site`, `verb` (the agent-director verb
 *     that answers), `fault`, and `build`, a thunk building the stub's
 *     `errUnusableName(fault)`;
 *   - `latchCase` and `refusedOperation`: "unusable recorded name" and
 *     "none" (`LATCH_CASE_UNUSABLE_RECORDED_NAME`, `REFUSED_OPERATION_NONE`);
 *   - `rowState`: the row state the path records. A `status` or a `get`
 *     that itself answers UNUSABLE NAME records unreadable, the approver's
 *     `status` included (its read goes through the own-row `status` step).
 *     The others record the state the path last read: `ended` for `resume`
 *     (the finished-row path), `working` for
 *     `read-pane` (the launch wait's evidence read and
 *     `checkWorkingRowPane`), `pending` for the approver's `read-pane` and
 *     `send-keys` (the lap's `status` read before them). The plain spawn
 *     is the first spawn, which read nothing before it, so its state comes
 *     from the one latch-time `status` read (`latchTimeRead: true`); the row
 *     expects no row, so a case arranges that read to answer
 *     `ErrSpawnNotFound`;
 *   - `latchTimeRead`: true when the recorded state comes from the latch-time
 *     `status` read rather than from a read the path made before the call;
 *   - `description`: the classification's message (`classifyAdError(...)
 *     .message`: redacted, on one line, capped), which the record holds;
 *   - `notice(key)`: the SRJ-1019 notice for persona `key`, built by
 *     `unusableNameNoticeText(key, description)` (its instance id from
 *     `personaInstanceId`); `sessionName(key)`: the session the record holds,
 *     `personaTmuxSessionName(key)` (the stub's descriptions quote none);
 *   - `record(key)`: the whole latch record (`ConflictLatchRecord`) a latch
 *     of persona `key` from the row holds (the case, "none", `rowState`, the
 *     quoted session and the description), {@link expectedLatchRecord} of
 *     `src/conflict-latch.ts`'s `unusableNameSetInput(key, build(), rowState)`.
 *     Compare a latch's `record(key)` with it whole (`toEqual`).
 * The dialog approver's rows land here (E17). The reconnect's `send-keys`
 * (E19 T1, {@link RECONNECT_SITE}; {@link RECONNECT_UNUSABLE_NAME_CASE_ROWS})
 * has one row per fault for each state in {@link RECONNECT_ROW_STATES}
 * (`waiting`, `working`), each recording the state its caller last read;
 * its row names carry the state (`reconnect send-keys (waiting): <fault>`).
 * The live-row sequence's two kills (E21, {@link SEQUENCE_KILL_SITES};
 * {@link SEQUENCE_KILL_UNUSABLE_NAME_CASE_ROWS}) have one row per fault for
 * each state in {@link SEQUENCE_KILL_ROW_STATES} (`pending`, `waiting`), each
 * recording the state the sequence last read, named
 * `sequence step-1 kill (pending): <fault>`. The stuck-launch abort's kill
 * (E29, {@link STUCK_LAUNCH_ABORT_SITE};
 * {@link STUCK_LAUNCH_ABORT_UNUSABLE_NAME_CASE_ROWS}) has one row per fault,
 * each recording `pending`.
 *
 * The expected latch records (SRJ-501), for any test that checks what a
 * hold-case latch holds (the server, restart, health-check, unavailable-retry
 * and session-manager tests included), so no test types a record by hand:
 *   - {@link expectedLatchRecord}`(key, input)`: the record a latch holds for
 *     a set input (the session and description rendered by
 *     `renderLogMessageText`, the session `slack_bot_<key>` when empty, no
 *     description when empty);
 *   - an unusable-name row's `record(key)` (above);
 *   - {@link launchStartRecord}`(key)`: the "launch start not recorded"
 *     record, from `launchStartNotRecordedSetInput(key, pending)`: the case
 *     "launch start not recorded", the refused operation "none", the state
 *     `pending`, the session `slack_bot_<key>` and no description; also every
 *     latching launch-start row's `record(key)`.
 *
 * The tmux-touching verbs (SRJ-502), {@link TMUX_TOUCHING_STUB_VERBS} and
 * {@link tmuxTouchingCallsIn}: `resume`, `spawn` in both forms (plain and
 * `--reuse-finished`, both logged in `spawnCalls`), `read-pane`, `send-keys`,
 * `kill` and `pause`, each with its stub call-log list, and the calls a stub
 * log holds for them ({@link tmuxTouchingCallCounts} takes the log's lengths
 * first, so a case can ask only for the calls made since). A test filters
 * the stub's call log through these and never types the list itself.
 *
 * Per-persona CONFLICT helpers (shared by the recovery-harness cases, so no
 * test file keeps its own copy):
 *   - {@link conflictForPersona}: a plain spawn's CONFLICT for persona `key`,
 *     its session left over from an earlier life ("duplicate session"): the
 *     stub's `errTmuxSessionConflict('spawn', 'duplicate-session-leftover',
 *     personaTmuxSessionName(key))`;
 *   - {@link conflictNoticeForPersona}: the CONFLICT notice that error posts
 *     to persona `key`'s destination, `{ key, text }`, the text
 *     {@link expectedConflictNotice} gives for `LATCH_CASE_LEFTOVER`, the
 *     persona's session name and the error's description.
 *
 * Launch-start rows (E16 T2, SRJ-513, SRJ-408 and SRJ-1020): a configured
 * persona P's own row read `pending` with no launch start, and the rows that
 * latch nothing beside it. Every row is built for P (a `CannedRowPersona`)
 * and a `home` with the stub's canned builders in their persona form
 * (`cannedStatusResult`, `cannedGetResult`, `cannedListRow`), each launch
 * start given explicitly, since the builders give a `pending` row a sample
 * launch start when the case gives none. Columns common to both kinds
 * ({@link LaunchStartCaseRowOf}, {@link LaunchStartNonLatchingRowOf}):
 *   - `name`, `shape` (the read: `status`, `get` or `list`,
 *     {@link LAUNCH_START_READ_SHAPES}; narrow a row on it for the read's own
 *     answer type, {@link LaunchStartReadResults}) and `launchStart` (the raw
 *     value; `undefined` for absent);
 *   - `build(persona, home)`: the read's answer as the stub gives it. A
 *     `status` result carries only `state` and `launch_started_at`, so a
 *     row's `cwd`, labels and id are the row behind it and do not show;
 *   - `readKey(persona)` (the key the read is made for: P's own, or the key
 *     the row's id stands for) and `configured` (whether that key is a
 *     configured persona's when P is the one configured persona);
 *   - `readRow(persona, home)`: the row as `decideOwnRowRead` reads it, a
 *     `status` result given its row's id as the own-row `status` step gives
 *     it; `decisionInput(persona, home)`: the decision's whole input.
 * The latching rows, {@link LAUNCH_START_CASE_ROWS}: each read shape × each
 * row variant ({@link LAUNCH_START_ROW_VARIANTS}: P's current life, a `cwd`
 * other than P's, a `config_dir` label other than P's) × each form of "no
 * launch start" ({@link NO_LAUNCH_START_FORMS}: absent, i.e. the stub's
 * `SAMPLE_LAUNCH_START_NONE`; `null`; {@link UNPARSEABLE_LAUNCH_START}, the
 * stub's whole-second sample with its zone dropped). Their own columns:
 * `variant`, `form`, `livenessNote`; `latchCase`, `refusedOperation` and
 * `rowState`: "launch start not recorded", "none" and `pending`
 * (`LATCH_CASE_LAUNCH_START_NOT_RECORDED`, `REFUSED_OPERATION_NONE`,
 * `latchRowStateRead('pending')`); `sessionName(key)`, the quoted session
 * the record holds (`personaTmuxSessionName(key)`); `notice(key)`, the
 * SRJ-1020 notice built by `launchStartNotRecordedNoticeText(key)`; and
 * `record(key)`, the whole latch record, {@link launchStartRecord}`(key)`.
 * {@link LAUNCH_START_AND_NOTE_ROW} is one more such row (P's current-life
 * `get`, launch start absent) that also carries the stub's `provenanceNote`:
 * it expects the launch-start decision only (SRJ-513's precedence).
 * The non-latching rows, {@link LAUNCH_START_NON_LATCHING_ROWS}, per read
 * shape, each with its `kind` and `state`: P's `pending` row with each
 * non-none form of the stub's `SAMPLE_LAUNCH_STARTS` ("launch start
 * recorded"); P's row in every other state with no launch start ("not
 * pending"); and the no-launch-start `pending` row under a key outside the
 * configured set: an absent persona's `cscb_<key>`
 * ({@link LAUNCH_START_ABSENT_PERSONA_KEY}, not configured), another
 * caller's id ({@link LAUNCH_START_ANOTHER_CALLERS_ID}, read for P), and a
 * pre-persona row (`cscb_<key>` of {@link LAUNCH_START_PRE_PERSONA_KEY},
 * labelled `service=cscb` only, not configured). Whether P's row is
 * "covered" (SRJ-409, E28) is no column: the decision never asks.
 *
 * There is no "no pane 0.0" row: that case is withdrawn (rev 17; SRJ-507).
 *
 * No case word, notice text, latch record or session name is written here:
 * the words reach a row only through the stub, the notice's texts and the
 * hold records' fields only through `src/conflict-latch.ts`'s exports, and
 * the session name is the stub's
 * `STUB_TMUX_SESSION_NAME` or, for a persona, `personaTmuxSessionName(key)`
 * (its instance id `personaInstanceId(key)`). No timestamp is written here:
 * launch starts come from the stub's `SAMPLE_LAUNCH_START*` constants, the
 * unparseable one derived from a sample (and checked at import, through
 * `parseLaunchStart`, not to parse).
 * No Phase-1-only export
 * is named, and no `mock.module()` is used.
 *
 * SPDX-License-Identifier: MIT
 */

import type { Phase1GetResult, Phase1ListRow, Phase1StatusResult } from '../../src/ad-phase1-types.ts'
import {
  AGENT_DIRECTOR_DEAD_STATES,
  AGENT_DIRECTOR_LIVE_STATES,
  AGENT_DIRECTOR_PENDING_STATE,
  LIVENESS_DEAD_ROW_ENDED,
  LIVENESS_DEAD_ROW_MISSING,
} from '../../src/liveness-reading.ts'
import { parseLaunchStart } from '../../src/pending-row.ts'
import type { OwnRowReadInput, RowReadRow } from '../../src/row-read-rules.ts'
import {
  CONFLICT_CASE_SENTENCES,
  CONFLICT_NOTICE_ANOTHER_STORE_MUST_NOT_END_LINE,
  CONFLICT_NOTICE_CASE_SENTENCE_LEAD,
  CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD,
  CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL,
  CONFLICT_NOTICE_DIFFERENT_ID_MUST_NOT_END_LINE,
  CONFLICT_NOTICE_FIRST_LINE_HEAD,
  CONFLICT_NOTICE_FIRST_LINE_TAIL,
  CONFLICT_NOTICE_HUMAN_ONLY_LINE,
  CONFLICT_NOTICE_LINE_SEPARATOR,
  CONFLICT_NOTICE_LIST_LINE_HEAD,
  CONFLICT_NOTICE_LIST_LINE_TAIL,
  CONFLICT_NOTICE_POINTER_LINE,
  LATCH_CASE_ANOTHER_STORE,
  LATCH_CASE_CONFLICTING_LABELS,
  LATCH_CASE_DIFFERENT_ID,
  LATCH_CASE_LAUNCH_START_NOT_RECORDED,
  LATCH_CASE_LEFTOVER,
  LATCH_CASE_NEVER_REPORTED_IN,
  LATCH_CASE_NO_VALID_ID,
  LATCH_CASE_NOT_THIS_LAUNCH,
  LATCH_CASE_OWN_ID,
  LATCH_CASE_PANE_NOT_FOUND,
  LATCH_CASE_UNRECOGNISED,
  LATCH_CASE_UNUSABLE_RECORDED_NAME,
  LATCH_ROW_STATE_KIND_READ,
  LATCH_ROW_STATE_NO_ROW,
  LATCH_ROW_STATE_UNREADABLE,
  REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY,
  REFUSED_OPERATION_NONE,
  REFUSED_OPERATION_PLAIN_SPAWN,
  REFUSED_OPERATION_RESUME,
  REFUSED_OPERATION_REUSE_SPAWN,
  UNUSABLE_NAME_NOTICE_DESCRIPTION_END,
  UNUSABLE_NAME_NOTICE_POINTER,
  UNUSABLE_NAME_NOTICE_REASON,
  UNUSABLE_NAME_NOTICE_SEPARATOR,
  latchRowStateRead,
  launchStartNotRecordedNoticeText,
  launchStartNotRecordedSetInput,
  takesUnrecognisedHandling,
  unusableNameNoticeText,
  unusableNameSetInput,
  type ConflictCaseWithSentence,
  type ConflictLatchCase,
  type ConflictLatchRecord,
  type ConflictLatchSetInput,
  type LatchRowState,
  type RefusedOperation,
} from '../../src/conflict-latch.ts'
import { classifyAdError } from '../../src/ad-error-class.ts'
import { renderLogMessageText } from '../../src/persona-connection-errors.ts'
import { personaInstanceId, personaTmuxSessionName } from '../../src/persona-identity.ts'
import { PROMPT_ROW_STATES, STUCK_LAUNCH_ABORT_SITE, type ApproverVerb } from '../../src/session-manager.ts'
import { escapeSlackControlCharacters } from '../../src/slack-text-escape.ts'
import {
  SAMPLE_LAUNCH_START_NONE,
  SAMPLE_LAUNCH_START_WHOLE,
  SAMPLE_LAUNCH_STARTS,
  STUB_TMUX_SESSION_NAME,
  UNUSABLE_NAME_FAULTS,
  cannedGetResult,
  cannedListRow,
  cannedStatusResult,
  errTmuxSessionConflict,
  errUnusableName,
  provenanceNote,
  type CannedGetResult,
  type CannedRowPersona,
  type ConflictCase,
  type ConflictOptions,
  type StubCallLog,
  type UnusableNameFault,
} from './agent-director-stub.ts'

// ---------------------------------------------------------------------------
// Site kinds
// ---------------------------------------------------------------------------

/** One of the dialog approver's calls as a site kind: `approver <verb>` (b.jg5 SRJ-117, SRJ-118, SRJ-402). */
export type ApproverSite = `approver ${ApproverVerb}`

/** The verb each approver site kind calls, in the order a lap calls them. */
const APPROVER_SITE_VERB: Readonly<Record<ApproverSite, ApproverVerb>> = Object.freeze({
  'approver status': 'status',
  'approver read-pane': 'read-pane',
  'approver send-keys': 'send-keys',
})

/** Every approver site kind, in lap order: `status`, `read-pane`, `send-keys`. */
export const APPROVER_SITES: readonly ApproverSite[] = Object.freeze(Object.keys(APPROVER_SITE_VERB) as ApproverSite[])

/** The stub call list (`StubCallLog`) each approver verb is counted in, in lap order. */
export const APPROVER_VERB_CALLS: Readonly<Record<ApproverVerb, 'statusCalls' | 'readPaneCalls' | 'sendKeysCalls'>> = Object.freeze({
  'status': 'statusCalls',
  'read-pane': 'readPaneCalls',
  'send-keys': 'sendKeysCalls',
})

/** Whether `site` is one of the dialog approver's site kinds. */
export function isApproverSite(site: string): site is ApproverSite {
  return Object.hasOwn(APPROVER_SITE_VERB, site)
}

/**
 * One of the liveness checks' `read-pane` sites of persona P's own row as a
 * site kind (b.jg5 SRJ-117's E18 columns): b.d61's working-row verdict
 * (`checkWorkingRowPane`), b.f2b's waiting-row check (`checkWaitingRowPane`)
 * and the launch wait's evidence read (`staleWorkingRowIsIdle`), each through
 * the shared reader of P's own row (`readPersonaOwnPane`).
 */
export type LivenessPaneSite = 'working-row verdict' | 'waiting-row check' | 'launch wait evidence read'

const WORKING = latchRowStateRead('working')
const WAITING = latchRowStateRead('waiting')

/**
 * The row state each liveness pane site records for a CONFLICT (b.jg5
 * SRJ-501: the state the calling path last read): `working` for the
 * working-row verdict and the launch wait's evidence read (the wait's poll
 * read `working`), `waiting` for the waiting-row check.
 */
export const LIVENESS_PANE_SITE_ROW_STATE: Readonly<Record<LivenessPaneSite, LatchRowState>> = Object.freeze({
  'working-row verdict': WORKING,
  'waiting-row check': WAITING,
  'launch wait evidence read': WORKING,
})

/** Every liveness pane site kind, in SRJ-117's column order. */
export const LIVENESS_PANE_SITES: readonly LivenessPaneSite[] = Object.freeze(
  Object.keys(LIVENESS_PANE_SITE_ROW_STATE) as LivenessPaneSite[],
)

/** Whether `site` is one of the liveness checks' `read-pane` site kinds. */
export function isLivenessPaneSite(site: string): site is LivenessPaneSite {
  return Object.hasOwn(LIVENESS_PANE_SITE_ROW_STATE, site)
}

/** A pane verb or a kill whose CONFLICT refuses P's next check or recovery, as a site kind. */
type PaneOrKillSite = 'kill' | 'read-pane' | 'send-keys' | 'pause'

/**
 * The reconnect's one `send-keys` of `/mcp reconnect` as a site kind
 * (`reconnectMcpWithCause`, b.jg5 SRJ-118's reconnect row).
 */
export const RECONNECT_SITE = 'reconnect send-keys'

/** The reconnect's site kind ({@link RECONNECT_SITE}). */
export type ReconnectSite = typeof RECONNECT_SITE

/** Whether `site` is the reconnect's site kind. */
export function isReconnectSite(site: string): site is ReconnectSite {
  return site === RECONNECT_SITE
}

/**
 * One of b.jdc's `read-pane` sites of persona P's own `ask_user` or
 * `check_permission` row as a site kind (b.jg5 SRJ-117's two b.jdc columns,
 * SRJ-606, SRJ-607): the reconnect verdict (`promptRowReconnectVerdict`) and
 * the ladder action (`launchOnPromptRow`), each one one-line read through the
 * shared reader of P's own row (`readPersonaOwnPane`).
 */
export type PromptRowPaneSite = 'prompt-row reconnect verdict' | 'prompt-row ladder action'

/** Every prompt-row pane site kind, in SRJ-117's column order: the reconnect verdict, then the ladder action. */
export const PROMPT_ROW_PANE_SITES: readonly PromptRowPaneSite[] = Object.freeze([
  'prompt-row reconnect verdict',
  'prompt-row ladder action',
] as const)

/** Whether `site` is one of b.jdc's prompt-row `read-pane` site kinds. */
export function isPromptRowPaneSite(site: string): site is PromptRowPaneSite {
  return (PROMPT_ROW_PANE_SITES as readonly string[]).includes(site)
}

/**
 * The restart path's kill before a relaunch as a site kind
 * (`_buildKillSessionAdapter`, `src/server.ts`; b.jg5 SRJ-110, E20).
 */
export const RESTART_KILL_SITE = 'restart kill'

/** The reuse spawn as a site kind (`reuseSpawnForPersona`, b.jg5 SRJ-112, SRJ-708; E22). */
export const REUSE_SPAWN_SITE = 'reuse spawn'

/** The live-row sequence's step-1 kill as a site kind (b.jg5 SRJ-705 step 1, SRJ-110; E21). */
export const SEQUENCE_STEP1_KILL_SITE = 'sequence step-1 kill'

/** The live-row sequence's step-4 kill as a site kind (b.jg5 SRJ-705 step 4, SRJ-110; E21). */
export const SEQUENCE_STEP4_KILL_SITE = 'sequence step-4 kill'

/**
 * The live-row sequence's step-6 `resume` as a site kind: the sequence-launch
 * entry's `resume` leg (`launchForLiveRowSequence`; b.jg5 SRJ-705 step 6,
 * SRJ-113).
 */
export const SEQUENCE_RESUME_SITE = 'sequence resume'

/** One of the live-row sequence's two kills as a site kind. */
export type SequenceKillSite = typeof SEQUENCE_STEP1_KILL_SITE | typeof SEQUENCE_STEP4_KILL_SITE

/** Each sequence kill site's step in the sequence. */
export const SEQUENCE_KILL_STEP: Readonly<Record<SequenceKillSite, 1 | 4>> = Object.freeze({
  [SEQUENCE_STEP1_KILL_SITE]: 1,
  [SEQUENCE_STEP4_KILL_SITE]: 4,
})

/** Every sequence kill site kind, in step order. */
export const SEQUENCE_KILL_SITES: readonly SequenceKillSite[] = Object.freeze(Object.keys(SEQUENCE_KILL_STEP) as SequenceKillSite[])

/** Whether `site` is one of the live-row sequence's kill site kinds. */
export function isSequenceKillSite(site: string): site is SequenceKillSite {
  return Object.hasOwn(SEQUENCE_KILL_STEP, site)
}

/**
 * The stuck-launch abort's kill as a site kind (b.jg5 SRJ-412, SRJ-110; E29):
 * `src/session-manager.ts`'s `STUCK_LAUNCH_ABORT_SITE`, the abort kill's own
 * site (`abortKillOwnStuckLaunch`) and the head of its tries', reads' and
 * latch lines, re-exported here.
 */
export { STUCK_LAUNCH_ABORT_SITE }

/** The stuck-launch abort's kill site kind ({@link STUCK_LAUNCH_ABORT_SITE}). */
export type StuckLaunchAbortSite = typeof STUCK_LAUNCH_ABORT_SITE

/** Whether `site` is the stuck-launch abort's kill site kind. */
export function isStuckLaunchAbortSite(site: string): site is StuckLaunchAbortSite {
  return site === STUCK_LAUNCH_ABORT_SITE
}

/**
 * One of the checked kill's site kinds: the restart path's kill (E20), one
 * of the live-row sequence's two kills (E21), or the stuck-launch abort's
 * kill (E29). The collision ladder makes no kill (E22).
 */
export type KillSite = typeof RESTART_KILL_SITE | SequenceKillSite | StuckLaunchAbortSite

/**
 * The site kind that meets a CONFLICT row's refusal: a plain spawn, a reuse
 * spawn, a `resume`, a pane verb or a kill (by its verb), one of the dialog
 * approver's pane verbs, one of the liveness checks' `read-pane` sites, the
 * reconnect's `send-keys`, one of b.jdc's prompt-row `read-pane` sites, or
 * one of the checked kill's sites (the restart path's kill, the live-row
 * sequence's two kills, the stuck-launch abort's kill).
 */
export type ConflictCaseSite =
  | 'plain spawn'
  | typeof REUSE_SPAWN_SITE
  | 'resume'
  | PaneOrKillSite
  | ApproverSite
  | LivenessPaneSite
  | ReconnectSite
  | PromptRowPaneSite
  | KillSite
  | typeof SEQUENCE_RESUME_SITE

/** One refusal and what latching a persona on it records. */
export interface ConflictCaseRow {
  /** Readable row name for `test.each`: `<site>: <stub case>`, with the option set. */
  readonly name: string
  /** The site kind that meets the refusal. */
  readonly site: ConflictCaseSite
  /** The verb the stub's error carries. */
  readonly verb: string
  /** The stub's case identifier. */
  readonly stubCase: ConflictCase
  /** The stub's variant options, when the row needs one. */
  readonly options: ConflictOptions
  /** The session the description quotes (and the latch records). */
  readonly sessionName: string
  /** Builds the error through `errTmuxSessionConflict`. */
  readonly build: () => ReturnType<typeof errTmuxSessionConflict>
  /** The case `recogniseConflictCase` gives the description. */
  readonly latchCase: ConflictLatchCase
  /** The refused operation the latch records for this verb. */
  readonly refusedOperation: RefusedOperation
  /** The row state the latch records on this path. */
  readonly rowState: LatchRowState
  /** The CONFLICT notice for the row's case, quoted session and description (SRJ-1004). */
  readonly notice: ExpectedConflictNotice
  /**
   * Set on the reconnect's "not this launch's session" rows only: SRJ-613's
   * leftover case (on a live row that is not `pending`, a leftover of an
   * earlier launch holds the persona's session).
   */
  readonly leftoverOfEarlierLaunch?: true
  /**
   * Set on the restart kill's, the live-row sequence's and the stuck-launch
   * abort's kill rows only, false: the recorded state is the one the path
   * hands the kill, so no latch-time `status` read is made. At the restart
   * kill it is the state the run's `dead` reading carries (`ended`, `missing`
   * or no row; b.jg5 SRJ-501), and `rowState` is that of the `dead` reading a
   * case hands the kill (`ended`, `LIVENESS_READING_DEAD_ENDED`); at a
   * sequence kill it is the state the sequence last read; at the abort's kill
   * it is `pending`, the state the pending-row rule's `get` last read.
   */
  readonly latchTimeRead?: false
  /**
   * Set on the "not this launch's session" row of the sequence step-1 kill on
   * a `pending` seed and of the stuck-launch abort's kill only: SRJ-613's
   * kill backstop (a kill on a live row, `pending` included, answering "not
   * this launch's session" latches the persona with nothing sent; E19 and
   * E20 hatch notes).
   */
  readonly killBackstop?: true
  /**
   * Set on the reuse spawn's pre-spawn scan rows only: a reuse of an id with
   * no row is an ordinary fresh spawn, whose scan refused it with nothing
   * written and no row created (HO rev 15); the latch records no row.
   */
  readonly noRowWritten?: true
  /**
   * Set on the plain spawn's rows only (b.jg5 SRJ-111; HO rev 15, rev 20):
   * the row agent-director leaves for the persona's id after the refusal, so
   * a case scripts the stub's reads of it after the refusal: `none` after the
   * pre-spawn scan's refusal (nothing written, no row created), `ended` after
   * a "duplicate session" answer (the new row was ended). At the first spawn,
   * which read nothing before it, the latch-time `status` read reads this
   * row, so the row's `rowState` is its reading (no row, or `ended`).
   */
  readonly rowAfter?: PlainSpawnRowAfter
}

/** The row a plain spawn's CONFLICT leaves (`ConflictCaseRow.rowAfter`): none after the pre-spawn scan's refusal, `ended` after "duplicate session". */
export type PlainSpawnRowAfter = 'none' | typeof LIVENESS_DEAD_ROW_ENDED

// ---------------------------------------------------------------------------
// The expected CONFLICT notice (b.jg5 SRJ-1004)
// ---------------------------------------------------------------------------

/** Which must-not-be-ended line a notice carries: another row's, another store's, or none. */
export type MustNotEndLine = 'row' | 'store' | 'none'

/** The lines a CONFLICT notice must carry besides its first line and its description line. */
export interface ConflictNoticeCarries {
  /** The pointer to agent-director's README "Operator actions": every case but "a different instance id". */
  readonly pointer: boolean
  /** "a different instance id": `row`, in place of the pointer; "another agent-director store": `store`, before the pointer. */
  readonly mustNotEnd: MustNotEndLine
  /** The `list` line: every case. */
  readonly list: boolean
  /** The human-only line: every case. */
  readonly humanOnly: boolean
}

/** One expected CONFLICT notice body (the persona notifier adds the prefix). */
export interface ExpectedConflictNotice {
  /** Its lines, in SRJ-1004's order. */
  readonly lines: readonly string[]
  /** The lines joined by `CONFLICT_NOTICE_LINE_SEPARATOR`. */
  readonly text: string
  /** The flags for the lines it must carry. */
  readonly carries: ConflictNoticeCarries
  /** The case sentence in its first line; `undefined` for unrecognised text and "never reported in". */
  readonly caseSentence: string | undefined
  /** Its description line; `undefined` when there is no description. */
  readonly descriptionLine: string | undefined
}

/** What an expected notice is built from: a CONFLICT latch's case, its quoted session (as the record holds it) and its description, if any. */
export interface ExpectedConflictNoticeSource {
  readonly latchCase: ConflictLatchCase
  readonly sessionName: string
  readonly description?: string
}

/** The flags SRJ-1004 sets for a case. */
function carriesFor(latchCase: ConflictLatchCase): ConflictNoticeCarries {
  const mustNotEnd: MustNotEndLine =
    latchCase === LATCH_CASE_DIFFERENT_ID ? 'row' : latchCase === LATCH_CASE_ANOTHER_STORE ? 'store' : 'none'
  return Object.freeze({ pointer: latchCase !== LATCH_CASE_DIFFERENT_ID, mustNotEnd, list: true, humanOnly: true })
}

/**
 * The CONFLICT notice SRJ-1004 gives for `source`, assembled line by line
 * from `src/conflict-latch.ts`'s exported fixed lines and case sentences:
 * the first line (`"<session>"`, with the case sentence unless the case takes
 * the unrecognised-text wording), the description line (left out when the
 * rendered description is empty), the must-not-be-ended line and the pointer
 * as `carries` says, the `list` line (`<name>` without quotes) and the
 * human-only line. The session name and the rendered description are escaped
 * once for Slack.
 */
export function expectedConflictNotice(source: ExpectedConflictNoticeSource): ExpectedConflictNotice {
  const name = escapeSlackControlCharacters(source.sessionName)
  const caseSentence = takesUnrecognisedHandling(source.latchCase)
    ? undefined
    : CONFLICT_CASE_SENTENCES[source.latchCase as ConflictCaseWithSentence]
  const rendered = renderLogMessageText(source.description)
  const descriptionLine =
    rendered === ''
      ? undefined
      : CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD + escapeSlackControlCharacters(rendered) + CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL
  const carries = carriesFor(source.latchCase)
  const lines = [
    CONFLICT_NOTICE_FIRST_LINE_HEAD +
      `"${name}"` +
      (caseSentence === undefined ? '' : CONFLICT_NOTICE_CASE_SENTENCE_LEAD + caseSentence) +
      CONFLICT_NOTICE_FIRST_LINE_TAIL,
    ...(descriptionLine === undefined ? [] : [descriptionLine]),
    ...(carries.mustNotEnd === 'row' ? [CONFLICT_NOTICE_DIFFERENT_ID_MUST_NOT_END_LINE] : []),
    ...(carries.mustNotEnd === 'store' ? [CONFLICT_NOTICE_ANOTHER_STORE_MUST_NOT_END_LINE] : []),
    ...(carries.pointer ? [CONFLICT_NOTICE_POINTER_LINE] : []),
    CONFLICT_NOTICE_LIST_LINE_HEAD + name + CONFLICT_NOTICE_LIST_LINE_TAIL,
    CONFLICT_NOTICE_HUMAN_ONLY_LINE,
  ]
  return Object.freeze({
    lines: Object.freeze(lines),
    text: lines.join(CONFLICT_NOTICE_LINE_SEPARATOR),
    carries,
    caseSentence,
    descriptionLine,
  })
}

/**
 * Where SRJ-1019's notice opens its quoted description, inside its first
 * sentence: the reason, then `agent-director said: "`.
 */
const INLINE_DESCRIPTION_OPEN = UNUSABLE_NAME_NOTICE_REASON + CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD

/**
 * Where SRJ-1019's notice closes its quoted description: the closing quote,
 * the sentence's end, the separator and the pointer sentence.
 */
const INLINE_DESCRIPTION_CLOSE =
  CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL +
  UNUSABLE_NAME_NOTICE_DESCRIPTION_END +
  UNUSABLE_NAME_NOTICE_SEPARATOR +
  UNUSABLE_NAME_NOTICE_POINTER

/**
 * `line` with a description quoted inside a sentence cut out (SRJ-1019's
 * form): everything between the first {@link INLINE_DESCRIPTION_OPEN} and
 * the last {@link INLINE_DESCRIPTION_CLOSE} after it is removed, the frame
 * itself and every other word kept. A line without that frame is returned
 * as it is.
 */
export function withoutInlineDescription(line: string): string {
  const open = line.indexOf(INLINE_DESCRIPTION_OPEN)
  if (open === -1) return line
  const start = open + INLINE_DESCRIPTION_OPEN.length
  const close = line.lastIndexOf(INLINE_DESCRIPTION_CLOSE)
  if (close < start) return line
  return line.slice(0, start) + line.slice(close)
}

/**
 * CSCB's own lines of a notice: its lines without agent-director's quoted
 * description. A CONFLICT notice's description line (the one that opens with
 * `CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD`) is dropped; a description quoted
 * inside a sentence (SRJ-1019) is cut out of its line
 * ({@link withoutInlineDescription}).
 */
export function cscbOwnLines(notice: string): string[] {
  return notice
    .split(CONFLICT_NOTICE_LINE_SEPARATOR)
    .filter((line) => !line.startsWith(CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD))
    .map(withoutInlineDescription)
}

/** {@link cscbOwnLines} joined back by `CONFLICT_NOTICE_LINE_SEPARATOR`: CSCB's own text of a notice. */
export function cscbOwnText(notice: string): string {
  return cscbOwnLines(notice).join(CONFLICT_NOTICE_LINE_SEPARATOR)
}

// ---------------------------------------------------------------------------
// Per-persona CONFLICT error and notice
// ---------------------------------------------------------------------------

/** A plain spawn's CONFLICT for persona `key`: its session left over from an earlier life ("duplicate session"). */
export function conflictForPersona(key: string): ReturnType<typeof errTmuxSessionConflict> {
  return errTmuxSessionConflict(SPAWN_VERB, 'duplicate-session-leftover', personaTmuxSessionName(key))
}

/** The CONFLICT notice `err` (a {@link conflictForPersona} error) posts to persona `key`'s destination. */
export function conflictNoticeForPersona(key: string, err: ReturnType<typeof conflictForPersona>): { key: string; text: string } {
  const notice = expectedConflictNotice({ latchCase: LATCH_CASE_LEFTOVER, sessionName: personaTmuxSessionName(key), description: err.errDescription })
  return { key, text: notice.text }
}

// ---------------------------------------------------------------------------
// Session-ending command forms (ADSRD SR-1.4; b.jg5 SRJ-1001)
// ---------------------------------------------------------------------------

/** One session-ending command form: what it names and the pattern that finds it. */
export interface SessionEndingCommandForm {
  readonly name: string
  /** Not global, so it keeps no `lastIndex` between tests. */
  readonly pattern: RegExp
}

/** Imperative verbs that put a command to run after them. */
const RUN_VERBS = String.raw`(?:run|use|type|execute|issue|invoke)`

/** `verb` named as a command: `agent-director <verb>`, a code span opening with it, `<verb>` with an option or a pid, or a run verb before it. */
function commandFormOf(verb: string): RegExp {
  return new RegExp(
    String.raw`\bagent-director\s+${verb}\b|\x60\s*${verb}\b|\b${verb}\s+(?:-|\d)|\b${RUN_VERBS}\s+(?:the\s+|a\s+)?\x60?\s*${verb}\b`,
    'i',
  )
}

/**
 * The commands that end a session as ADSRD SR-1.4 defines one, as SRJ-1001
 * lists them for the CONFLICT, unusable-name, launch-start and stuck-launch
 * posts: `kill` named as a command to run (so agent-director's "no kill was
 * sent" and "retry kill later" are no hit), `pause` in any form,
 * `--include-finished` (with or without its dashes), `tmux kill-session` and
 * `tmux kill-server`.
 */
export const SESSION_ENDING_COMMAND_FORMS: readonly SessionEndingCommandForm[] = Object.freeze([
  Object.freeze({ name: 'kill as a command', pattern: commandFormOf('kill') }),
  Object.freeze({ name: 'pause', pattern: /\bpause\b/i }),
  Object.freeze({ name: '--include-finished', pattern: /include-finished/i }),
  Object.freeze({ name: 'tmux kill-session', pattern: /\bkill-session\b/i }),
  Object.freeze({ name: 'tmux kill-server', pattern: /\bkill-server\b/i }),
])

/** The names of the session-ending command forms `text` matches, in table order; empty when none does. */
export function sessionEndingCommandsIn(text: string): string[] {
  return SESSION_ENDING_COMMAND_FORMS.filter((form) => form.pattern.test(text)).map((form) => form.name)
}

/**
 * What CSCB's own notice and recovery lines never spell, beyond SR-1.4's five
 * session-ending forms (b.jg5 SRJ-1001; SRJ-716's label option names): a pane
 * kill, a tmux option write, an agent-director row delete, the latch-clearing
 * command, a session probe, and either label option's name. Not global, so
 * no pattern keeps a `lastIndex` between tests.
 */
export const CSCB_OWN_LINE_FORBIDDEN: readonly RegExp[] = Object.freeze([
  /kill-pane/i,
  /set-option/i,
  /agent-director\s+delete/i,
  /clear-latch|clear_latch|clearLatch/,
  /has-session/i,
  /ad_owner|ad_pane/,
])

/** Each {@link CSCB_OWN_LINE_FORBIDDEN} entry `line` matches, with the line, so a failure names both; empty when none does. */
export function cscbOwnLineForbiddenIn(line: string): string[] {
  return CSCB_OWN_LINE_FORBIDDEN.filter((pattern) => pattern.test(line)).map((pattern) => `${pattern} in ${JSON.stringify(line)}`)
}

/** The verb of a spawn, plain or with `--reuse-finished`. */
const SPAWN_VERB = 'spawn'

const ENDED = latchRowStateRead('ended')
const PENDING = latchRowStateRead(AGENT_DIRECTOR_PENDING_STATE)
const ASK_USER = latchRowStateRead('ask_user')
const CHECK_PERMISSION = latchRowStateRead('check_permission')

function row(
  site: ConflictCaseSite,
  refusedOperation: RefusedOperation,
  verb: string,
  stubCase: ConflictCase,
  latchCase: ConflictLatchCase,
  rowState: LatchRowState,
  options: ConflictOptions = {},
): ConflictCaseRow {
  const variant = Object.keys(options).filter((key) => options[key as keyof ConflictOptions] === true)
  const sessionName = STUB_TMUX_SESSION_NAME
  const build = () => errTmuxSessionConflict(verb, stubCase, sessionName, options)
  return Object.freeze({
    name: `${site}: ${stubCase}${variant.length === 0 ? '' : ` (${variant.join(', ')})`}`,
    site,
    verb,
    stubCase,
    options,
    sessionName,
    build,
    latchCase,
    refusedOperation,
    rowState,
    notice: expectedConflictNotice({ latchCase, sessionName, description: build().errDescription }),
  })
}

/**
 * A plain spawn's CONFLICT row, with the row agent-director leaves after it
 * (`rowAfter`), which the first spawn's latch-time `status` read reads: no
 * row, or `ended`.
 */
const plainSpawn = (c: ConflictCase, l: ConflictLatchCase, rowAfter: PlainSpawnRowAfter, o?: ConflictOptions): ConflictCaseRow =>
  Object.freeze({
    ...row('plain spawn', REFUSED_OPERATION_PLAIN_SPAWN, SPAWN_VERB, c, l, rowAfter === 'none' ? LATCH_ROW_STATE_NO_ROW : ENDED, o),
    rowAfter,
  })
const reuseSpawn = (c: ConflictCase, l: ConflictLatchCase, s: LatchRowState, o?: ConflictOptions): ConflictCaseRow =>
  row(REUSE_SPAWN_SITE, REFUSED_OPERATION_REUSE_SPAWN, SPAWN_VERB, c, l, s, o)
/** The reuse spawn of an id with no row, refused by the pre-spawn scan: no row recorded, none written (HO rev 15). */
const reuseSpawnScan = (c: ConflictCase, l: ConflictLatchCase, o?: ConflictOptions): ConflictCaseRow =>
  Object.freeze({ ...reuseSpawn(c, l, LATCH_ROW_STATE_NO_ROW, o), noRowWritten: true as const })
const resume = (c: ConflictCase, l: ConflictLatchCase, s: LatchRowState, o?: ConflictOptions): ConflictCaseRow =>
  row('resume', REFUSED_OPERATION_RESUME, 'resume', c, l, s, o)
const paneOrKill = (
  verb: PaneOrKillSite,
  c: ConflictCase,
  l: ConflictLatchCase,
  s: LatchRowState,
  o?: ConflictOptions,
): ConflictCaseRow => row(verb, REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY, verb, c, l, s, o)
/**
 * The dialog approver's CONFLICT from its pane verb `verb` (b.jg5 SRJ-501):
 * P's next check or recovery, recorded `pending`, the state the lap's
 * `status` read gave before the pane verb.
 */
const approverPane = (
  verb: Exclude<ApproverVerb, 'status'>,
  c: ConflictCase,
  l: ConflictLatchCase,
  o?: ConflictOptions,
): ConflictCaseRow => row(`approver ${verb}`, REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY, verb, c, l, PENDING, o)

/**
 * The dialog approver's pane verbs on a `pending` row (E17): P's next check
 * or recovery, recorded `pending`. `send-keys` on a `pending` row answers a
 * leftover with `ErrSpawnNotInteractive`, so only `read-pane` (more than one
 * leftover) has a not-this-launch row.
 */
const APPROVER_ROWS: readonly ConflictCaseRow[] = [
  approverPane('read-pane', 'pane-not-found', LATCH_CASE_PANE_NOT_FOUND),
  approverPane('read-pane', 'pane-not-found', LATCH_CASE_PANE_NOT_FOUND, { notAdopted: true }),
  approverPane('read-pane', 'not-this-launch', LATCH_CASE_NOT_THIS_LAUNCH),
  approverPane('read-pane', 'conflicting-labels', LATCH_CASE_CONFLICTING_LABELS),
  approverPane('send-keys', 'pane-not-found', LATCH_CASE_PANE_NOT_FOUND),
  approverPane('send-keys', 'pane-not-found', LATCH_CASE_PANE_NOT_FOUND, { notAdopted: true }),
  approverPane('send-keys', 'conflicting-labels', LATCH_CASE_CONFLICTING_LABELS),
]

/**
 * The liveness checks' `read-pane` CONFLICT rows (E18; b.jg5 SRJ-117,
 * SRJ-501): for each liveness pane site, one row per stub CONFLICT case the
 * approver's `read-pane` rows cover (the same case, option set and latch
 * case), each refusing P's next check or recovery and recording the state
 * the site's path last read ({@link LIVENESS_PANE_SITE_ROW_STATE}).
 */
const LIVENESS_PANE_ROWS: readonly ConflictCaseRow[] = LIVENESS_PANE_SITES.flatMap((site) =>
  APPROVER_ROWS.filter((approverRow) => approverRow.verb === 'read-pane').map((approverRow) =>
    row(
      site,
      REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY,
      'read-pane',
      approverRow.stubCase,
      approverRow.latchCase,
      LIVENESS_PANE_SITE_ROW_STATE[site],
      approverRow.options,
    ),
  ),
)

/** A state the reconnect's caller last read before its `send-keys`: `waiting`, or `working` (a stale row). */
export type ReconnectLastRead = 'waiting' | 'working'

/**
 * The latch row state the reconnect's rows record for each state its caller
 * last read (b.jg5 SRJ-501), in row order: `waiting`, then `working`.
 */
export const RECONNECT_ROW_STATES: Readonly<Record<ReconnectLastRead, LatchRowState>> = Object.freeze({
  waiting: WAITING,
  working: WORKING,
})

/** Every {@link ReconnectLastRead}, in row order. */
const RECONNECT_LAST_READS = Object.keys(RECONNECT_ROW_STATES) as ReconnectLastRead[]

/**
 * The reconnect's `send-keys` CONFLICT rows (E19 T1; b.jg5 SRJ-118, SRJ-501):
 * for each state in {@link RECONNECT_ROW_STATES}, one row per stub CONFLICT
 * case the approver's `read-pane` rows cover (the approver's `send-keys`
 * cases and "not this launch's session"), each refusing P's next check or
 * recovery. The row name carries the state; the "not this launch's session"
 * rows carry `leftoverOfEarlierLaunch` (SRJ-613).
 */
const RECONNECT_ROWS: readonly ConflictCaseRow[] = RECONNECT_LAST_READS.flatMap((lastRead) =>
  APPROVER_ROWS.filter((approverRow) => approverRow.verb === 'read-pane').map((approverRow) => {
    const caseRow = row(
      RECONNECT_SITE,
      REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY,
      'send-keys',
      approverRow.stubCase,
      approverRow.latchCase,
      RECONNECT_ROW_STATES[lastRead],
      approverRow.options,
    )
    return Object.freeze({
      ...caseRow,
      name: caseRow.name.replace(RECONNECT_SITE, `${RECONNECT_SITE} (${lastRead})`),
      ...(caseRow.latchCase === LATCH_CASE_NOT_THIS_LAUNCH ? { leftoverOfEarlierLaunch: true as const } : {}),
    })
  }),
)

/**
 * b.jdc's prompt-row `read-pane` CONFLICT rows (E19 T2; b.jg5 SRJ-117,
 * SRJ-501): for each prompt-row pane site and each prompt state the path
 * last read (`PROMPT_ROW_STATES`), one row per stub CONFLICT case the
 * approver's `read-pane` rows cover (as the liveness checks' rows), each
 * refusing P's next check or recovery and recording that state. The row
 * name carries the state.
 */
const PROMPT_ROW_PANE_ROWS: readonly ConflictCaseRow[] = PROMPT_ROW_PANE_SITES.flatMap((site) =>
  [...PROMPT_ROW_STATES].flatMap((state) =>
    APPROVER_ROWS.filter((approverRow) => approverRow.verb === 'read-pane').map((approverRow) => {
      const caseRow = row(
        site,
        REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY,
        'read-pane',
        approverRow.stubCase,
        approverRow.latchCase,
        latchRowStateRead(state),
        approverRow.options,
      )
      return Object.freeze({ ...caseRow, name: caseRow.name.replace(site, `${site} (${state})`) })
    }),
  ),
)

/**
 * The stub CONFLICT cases `kill` answers, as the table's `kill` rows give
 * them (each with its latch case): "not this launch's session", "never
 * reported in" and "conflicting labels".
 */
const KILL_CASES: readonly (readonly [ConflictCase, ConflictLatchCase])[] = [
  ['not-this-launch', LATCH_CASE_NOT_THIS_LAUNCH],
  ['never-reported-in', LATCH_CASE_NEVER_REPORTED_IN],
  ['conflicting-labels', LATCH_CASE_CONFLICTING_LABELS],
]

/**
 * The restart path's kill CONFLICT rows (E20; b.jg5 SRJ-110, SRJ-501, the E13
 * hatch note): one row per case `kill` answers, each refusing P's next check
 * or recovery and recording the state the run's `dead` reading carries
 * (`ended`), with no latch-time `status` read (`latchTimeRead` false, b.jg5
 * SRJ-501): the restart path kills only after a `dead` reading.
 */
const RESTART_KILL_ROWS: readonly ConflictCaseRow[] = KILL_CASES.map(([stubCase, latchCase]) =>
  Object.freeze({
    ...row(RESTART_KILL_SITE, REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY, 'kill', stubCase, latchCase, ENDED),
    latchTimeRead: false as const,
  }),
)

/** A state the live-row sequence last read before a kill: `pending`, or `waiting` (a live state other than `pending`). */
export type SequenceKillLastRead = 'pending' | 'waiting'

/** The latch row state each sequence kill row records for the state the sequence last read, in row order. */
export const SEQUENCE_KILL_ROW_STATES: Readonly<Record<SequenceKillLastRead, LatchRowState>> = Object.freeze({
  pending: PENDING,
  waiting: WAITING,
})

/** Every {@link SequenceKillLastRead}, in row order. */
const SEQUENCE_KILL_LAST_READS = Object.keys(SEQUENCE_KILL_ROW_STATES) as SequenceKillLastRead[]

/**
 * The live-row sequence's kill CONFLICT rows (E21; b.jg5 SRJ-110, SRJ-501,
 * SRJ-705): for each sequence kill and each state the sequence last read,
 * one row per case `kill` answers, each refusing P's next check or recovery
 * and recording that state with no latch-time `status` read. The step-1
 * kill's "not this launch's session" row on a `pending` seed is SRJ-613's
 * kill backstop (`killBackstop`).
 */
const SEQUENCE_KILL_ROWS: readonly ConflictCaseRow[] = SEQUENCE_KILL_SITES.flatMap((site) =>
  SEQUENCE_KILL_LAST_READS.flatMap((lastRead) =>
    KILL_CASES.map(([stubCase, latchCase]) => {
      const caseRow = row(site, REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY, 'kill', stubCase, latchCase, SEQUENCE_KILL_ROW_STATES[lastRead])
      const backstop = site === SEQUENCE_STEP1_KILL_SITE && SEQUENCE_KILL_ROW_STATES[lastRead] === PENDING && latchCase === LATCH_CASE_NOT_THIS_LAUNCH
      return Object.freeze({
        ...caseRow,
        name: caseRow.name.replace(site, `${site} (${lastRead})`),
        latchTimeRead: false as const,
        ...(backstop ? { killBackstop: true as const } : {}),
      })
    }),
  ),
)

/**
 * The stuck-launch abort's kill CONFLICT rows (E29; b.jg5 SRJ-412, SRJ-110,
 * SRJ-501, SRJ-613): one row per case `kill` answers, each refusing P's next
 * check or recovery and recording `pending` (the abort kills only a row the
 * rule's `get` read `pending`) with no latch-time `status` read. The "not
 * this launch's session" row is SRJ-613's kill backstop (`killBackstop`).
 */
const STUCK_LAUNCH_ABORT_ROWS: readonly ConflictCaseRow[] = KILL_CASES.map(([stubCase, latchCase]) =>
  Object.freeze({
    ...row(STUCK_LAUNCH_ABORT_SITE, REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY, 'kill', stubCase, latchCase, PENDING),
    latchTimeRead: false as const,
    ...(latchCase === LATCH_CASE_NOT_THIS_LAUNCH ? { killBackstop: true as const } : {}),
  }),
)

/**
 * The plain spawn's CONFLICT rows (b.jg5 SRJ-111, SRJ-501, SRJ-507; HO rev
 * 15, rev 20), each refusing the plain spawn and carrying the row
 * agent-director leaves (`rowAfter`): none after the pre-spawn scan's
 * refusals ("left over from an earlier life", and "conflicting labels" in its
 * scan form: nothing written, no row created); `ended` after each "duplicate
 * session" answer (the new row was ended). For `test.each` over the plain
 * spawn's sites; they open {@link CONFLICT_CASE_ROWS}.
 */
export const PLAIN_SPAWN_CONFLICT_CASE_ROWS: readonly ConflictCaseRow[] = Object.freeze([
  // The pre-spawn scan's refusals (nothing written, no row).
  plainSpawn('scan-leftover', LATCH_CASE_LEFTOVER, 'none'),
  plainSpawn('conflicting-labels', LATCH_CASE_CONFLICTING_LABELS, 'none', { scan: true }),
  // The "duplicate session" answers (the new row was ended).
  plainSpawn('duplicate-session-leftover', LATCH_CASE_LEFTOVER, LIVENESS_DEAD_ROW_ENDED),
  plainSpawn('no-valid-id', LATCH_CASE_NO_VALID_ID, LIVENESS_DEAD_ROW_ENDED),
  plainSpawn('different-id', LATCH_CASE_DIFFERENT_ID, LIVENESS_DEAD_ROW_ENDED, { plainSpawn: true }),
  plainSpawn('another-store', LATCH_CASE_ANOTHER_STORE, LIVENESS_DEAD_ROW_ENDED, { plainSpawn: true }),
  plainSpawn('conflicting-labels', LATCH_CASE_CONFLICTING_LABELS, LIVENESS_DEAD_ROW_ENDED),
])

/**
 * The reuse spawn's CONFLICT rows (E22; b.jg5 SRJ-112, SRJ-501, SRJ-507; HO
 * rev 15, rev 20): one row per stub case a spawn can answer, each refusing
 * the reuse spawn. A reuse of an id with no row is an ordinary fresh spawn:
 * its pre-spawn scan's refusals record no row and are marked `noRowWritten`.
 * A reuse of a finished row records `ended`, the state its path last read.
 */
const REUSE_SPAWN_ROWS: readonly ConflictCaseRow[] = [
  reuseSpawnScan('scan-leftover', LATCH_CASE_LEFTOVER),
  reuseSpawnScan('conflicting-labels', LATCH_CASE_CONFLICTING_LABELS, { scan: true }),
  reuseSpawn('no-valid-id', LATCH_CASE_NO_VALID_ID, ENDED),
  reuseSpawn('different-id', LATCH_CASE_DIFFERENT_ID, ENDED),
  reuseSpawn('different-id', LATCH_CASE_DIFFERENT_ID, ENDED, { plainSpawn: true }),
  reuseSpawn('another-store', LATCH_CASE_ANOTHER_STORE, ENDED),
  reuseSpawn('another-store', LATCH_CASE_ANOTHER_STORE, ENDED, { plainSpawn: true }),
  reuseSpawn('own-id', LATCH_CASE_OWN_ID, ENDED),
  reuseSpawn('leftover', LATCH_CASE_LEFTOVER, ENDED),
  reuseSpawn('duplicate-session-leftover', LATCH_CASE_LEFTOVER, ENDED),
  reuseSpawn('conflicting-labels', LATCH_CASE_CONFLICTING_LABELS, ENDED),
  reuseSpawn('unrecognised', LATCH_CASE_UNRECOGNISED, ENDED),
]

/**
 * The `resume` CONFLICT rows (b.jg5 SRJ-113, SRJ-501; HO rev 15, rev 20):
 * a `resume` on the finished-row path records `ended`, the state its path
 * last read; unrecognised text records unreadable, where the path could not
 * read the row's state. "another agent-director store" in both its forms
 * (plain, and with the stub's "duplicate session" extras, its `plainSpawn`
 * option), and "conflicting labels" in its "duplicate session" form (a
 * duplicate label; the scan's form is a plain spawn's only, since a `resume`
 * makes no pre-spawn scan).
 */
const RESUME_ROWS: readonly ConflictCaseRow[] = [
  resume('no-valid-id', LATCH_CASE_NO_VALID_ID, ENDED),
  resume('different-id', LATCH_CASE_DIFFERENT_ID, ENDED),
  resume('another-store', LATCH_CASE_ANOTHER_STORE, ENDED),
  resume('another-store', LATCH_CASE_ANOTHER_STORE, ENDED, { plainSpawn: true }),
  resume('own-id', LATCH_CASE_OWN_ID, ENDED),
  resume('leftover', LATCH_CASE_LEFTOVER, ENDED),
  resume('conflicting-labels', LATCH_CASE_CONFLICTING_LABELS, ENDED),
  resume('unrecognised', LATCH_CASE_UNRECOGNISED, LATCH_ROW_STATE_UNREADABLE),
]

/** A finished state the live-row sequence's last `get` read before a step-6 `resume`: `ended` or `missing`. */
export type SequenceResumeLastRead = typeof LIVENESS_DEAD_ROW_ENDED | typeof LIVENESS_DEAD_ROW_MISSING

/**
 * The latch row state the sequence `resume` rows record for each state the
 * sequence's last `get` read before its step-6 `resume` (b.jg5 SRJ-501,
 * SRJ-705 step 3), in row order. A row read with no row has no session id,
 * so its step 6 is a reuse, never a `resume`.
 */
export const SEQUENCE_RESUME_ROW_STATES: Readonly<Record<SequenceResumeLastRead, LatchRowState>> = Object.freeze({
  [LIVENESS_DEAD_ROW_ENDED]: ENDED,
  [LIVENESS_DEAD_ROW_MISSING]: latchRowStateRead(LIVENESS_DEAD_ROW_MISSING),
})

/**
 * The live-row sequence's step-6 `resume` CONFLICT rows (b.jg5 SRJ-113,
 * SRJ-501, SRJ-705): for each state in
 * {@link SEQUENCE_RESUME_ROW_STATES}, one row per `resume` row (the same
 * case, option set and latch case), each refusing the `resume` and
 * recording the state the sequence's last `get` read, named
 * `sequence resume (<state>): <stub case>`. They are not in
 * {@link CONFLICT_CASE_ROWS}: the errors are the `resume` rows', and only
 * the recorded state differs.
 */
export const SEQUENCE_RESUME_CONFLICT_CASE_ROWS: readonly ConflictCaseRow[] = Object.freeze(
  (Object.keys(SEQUENCE_RESUME_ROW_STATES) as SequenceResumeLastRead[]).flatMap((lastRead) =>
    RESUME_ROWS.map((resumeRow) => {
      const caseRow = row(
        SEQUENCE_RESUME_SITE,
        REFUSED_OPERATION_RESUME,
        'resume',
        resumeRow.stubCase,
        resumeRow.latchCase,
        SEQUENCE_RESUME_ROW_STATES[lastRead],
        resumeRow.options,
      )
      return Object.freeze({ ...caseRow, name: caseRow.name.replace(SEQUENCE_RESUME_SITE, `${SEQUENCE_RESUME_SITE} (${lastRead})`) })
    }),
  ),
)

/** The sequence `resume` CONFLICT rows whose sequence last read `lastRead`, for `test.each`. */
export function sequenceResumeConflictRowsAt(lastRead: SequenceResumeLastRead): readonly ConflictCaseRow[] {
  return SEQUENCE_RESUME_CONFLICT_CASE_ROWS.filter((caseRow) => caseRow.rowState === SEQUENCE_RESUME_ROW_STATES[lastRead])
}

/** Every CONFLICT latch row, for `test.each`. */
export const CONFLICT_CASE_ROWS: readonly ConflictCaseRow[] = Object.freeze([
  // A plain spawn: the pre-spawn scan's refusals (no row after), then the
  // "duplicate session" answers (the row `ended` after).
  ...PLAIN_SPAWN_CONFLICT_CASE_ROWS,
  // A spawn with `--reuse-finished` (E22): of a finished row, and of an id
  // with no row (an ordinary fresh spawn, which the pre-spawn scan refuses).
  ...REUSE_SPAWN_ROWS,
  // A `resume` on the finished-row path; unrecognised text where the path
  // could not read the row's state.
  ...RESUME_ROWS,
  // Pane verbs and kills: P's next check or recovery, the state last read.
  paneOrKill('kill', 'not-this-launch', LATCH_CASE_NOT_THIS_LAUNCH, WAITING),
  paneOrKill('send-keys', 'not-this-launch', LATCH_CASE_NOT_THIS_LAUNCH, WORKING),
  paneOrKill('pause', 'not-this-launch', LATCH_CASE_NOT_THIS_LAUNCH, CHECK_PERMISSION),
  paneOrKill('read-pane', 'pane-not-found', LATCH_CASE_PANE_NOT_FOUND, WAITING),
  paneOrKill('send-keys', 'pane-not-found', LATCH_CASE_PANE_NOT_FOUND, ASK_USER),
  paneOrKill('read-pane', 'pane-not-found', LATCH_CASE_PANE_NOT_FOUND, PENDING, { notAdopted: true }),
  paneOrKill('read-pane', 'conflicting-labels', LATCH_CASE_CONFLICTING_LABELS, PENDING),
  paneOrKill('kill', 'never-reported-in', LATCH_CASE_NEVER_REPORTED_IN, PENDING),
  paneOrKill('kill', 'conflicting-labels', LATCH_CASE_CONFLICTING_LABELS, WORKING),
  // The dialog approver's pane verbs on a `pending` row (E17).
  ...APPROVER_ROWS,
  // The liveness checks' `read-pane` sites (E18).
  ...LIVENESS_PANE_ROWS,
  // The reconnect's `send-keys` (E19 T1).
  ...RECONNECT_ROWS,
  // b.jdc's prompt-row `read-pane` sites (E19 T2).
  ...PROMPT_ROW_PANE_ROWS,
  // The checked kill's sites (E20): the restart path's kill.
  ...RESTART_KILL_ROWS,
  // The live-row sequence's two kills (E21).
  ...SEQUENCE_KILL_ROWS,
  // The stuck-launch abort's kill (E29).
  ...STUCK_LAUNCH_ABORT_ROWS,
])

/** The dialog approver's CONFLICT rows of {@link CONFLICT_CASE_ROWS} (its `read-pane` and `send-keys`), for `test.each`. */
export const APPROVER_CONFLICT_CASE_ROWS: readonly ConflictCaseRow[] = Object.freeze(
  CONFLICT_CASE_ROWS.filter((caseRow) => isApproverSite(caseRow.site)),
)

/** The liveness checks' `read-pane` CONFLICT rows of {@link CONFLICT_CASE_ROWS} (E18), for `test.each`. */
export const LIVENESS_PANE_CONFLICT_CASE_ROWS: readonly ConflictCaseRow[] = Object.freeze(
  CONFLICT_CASE_ROWS.filter((caseRow) => isLivenessPaneSite(caseRow.site)),
)

/** The liveness pane CONFLICT rows of one site kind, for `test.each`. */
export function livenessPaneConflictRowsAt(site: LivenessPaneSite): readonly ConflictCaseRow[] {
  return LIVENESS_PANE_CONFLICT_CASE_ROWS.filter((caseRow) => caseRow.site === site)
}

/** The reconnect's `send-keys` CONFLICT rows of {@link CONFLICT_CASE_ROWS} (E19 T1), for `test.each`. */
export const RECONNECT_CONFLICT_CASE_ROWS: readonly ConflictCaseRow[] = Object.freeze(
  CONFLICT_CASE_ROWS.filter((caseRow) => isReconnectSite(caseRow.site)),
)

/** The reconnect's CONFLICT rows for a caller that last read `lastRead`, for `test.each`. */
export function reconnectConflictRowsAt(lastRead: ReconnectLastRead): readonly ConflictCaseRow[] {
  return RECONNECT_CONFLICT_CASE_ROWS.filter((caseRow) => caseRow.rowState === RECONNECT_ROW_STATES[lastRead])
}

/** b.jdc's prompt-row `read-pane` CONFLICT rows of {@link CONFLICT_CASE_ROWS} (E19 T2), for `test.each`. */
export const PROMPT_ROW_PANE_CONFLICT_CASE_ROWS: readonly ConflictCaseRow[] = Object.freeze(
  CONFLICT_CASE_ROWS.filter((caseRow) => isPromptRowPaneSite(caseRow.site)),
)

/**
 * The prompt-row pane CONFLICT rows of one site kind whose path last read
 * prompt state `state` (`ask_user` or `check_permission`), for `test.each`.
 */
export function promptRowPaneConflictRowsAt(site: PromptRowPaneSite, state: string): readonly ConflictCaseRow[] {
  return PROMPT_ROW_PANE_CONFLICT_CASE_ROWS.filter(
    (caseRow) => caseRow.site === site && caseRow.rowState.kind === LATCH_ROW_STATE_KIND_READ && caseRow.rowState.state === state,
  )
}

/** The reuse spawn's CONFLICT rows of {@link CONFLICT_CASE_ROWS} (E22), for `test.each`. */
export const REUSE_SPAWN_CONFLICT_CASE_ROWS: readonly ConflictCaseRow[] = Object.freeze(
  CONFLICT_CASE_ROWS.filter((caseRow) => caseRow.site === REUSE_SPAWN_SITE),
)

/** The reuse spawn's pre-spawn scan rows (a reuse of an id with no row; `noRowWritten`), for `test.each`. */
export function reuseSpawnScanRows(): readonly ConflictCaseRow[] {
  return REUSE_SPAWN_CONFLICT_CASE_ROWS.filter((caseRow) => caseRow.noRowWritten === true)
}

/** The restart path's kill CONFLICT rows of {@link CONFLICT_CASE_ROWS} (E20), for `test.each`. */
export const RESTART_KILL_CONFLICT_CASE_ROWS: readonly ConflictCaseRow[] = Object.freeze(
  CONFLICT_CASE_ROWS.filter((caseRow) => caseRow.site === RESTART_KILL_SITE),
)

/** The live-row sequence's kill CONFLICT rows of {@link CONFLICT_CASE_ROWS} (E21), for `test.each`. */
export const SEQUENCE_KILL_CONFLICT_CASE_ROWS: readonly ConflictCaseRow[] = Object.freeze(
  CONFLICT_CASE_ROWS.filter((caseRow) => isSequenceKillSite(caseRow.site)),
)

/** The sequence kill CONFLICT rows of one site kind whose sequence last read `lastRead`, for `test.each`. */
export function sequenceKillConflictRowsAt(site: SequenceKillSite, lastRead: SequenceKillLastRead): readonly ConflictCaseRow[] {
  return SEQUENCE_KILL_CONFLICT_CASE_ROWS.filter((caseRow) => caseRow.site === site && caseRow.rowState === SEQUENCE_KILL_ROW_STATES[lastRead])
}

/**
 * The stuck-launch abort's kill CONFLICT rows of {@link CONFLICT_CASE_ROWS}
 * (E29; one per case `kill` answers, each recording `pending`; the "not this
 * launch's session" row carries `killBackstop`), for `test.each`.
 */
export const STUCK_LAUNCH_ABORT_CONFLICT_CASE_ROWS: readonly ConflictCaseRow[] = Object.freeze(
  CONFLICT_CASE_ROWS.filter((caseRow) => isStuckLaunchAbortSite(caseRow.site)),
)

// ---------------------------------------------------------------------------
// The expected latch record of a hold case (b.jg5 SRJ-501)
// ---------------------------------------------------------------------------

/**
 * The record a latch of persona `key` holds for the set input `input`, as
 * SRJ-501 says a record holds it: the case, the refused operation and the
 * row state as given; the session and the description rendered by
 * `renderLogMessageText` (redacted, on one line, capped), the session
 * `slack_bot_<key>` (`personaTmuxSessionName`) when that is empty, and no
 * description when that is empty. The hold rows build their `input` with
 * `src/conflict-latch.ts`'s own set-input builders, so no field is typed here.
 */
export function expectedLatchRecord(key: string, input: ConflictLatchSetInput): ConflictLatchRecord {
  const sessionName = renderLogMessageText(input.sessionName)
  const description = renderLogMessageText(input.description)
  return Object.freeze({
    sessionName: sessionName === '' ? personaTmuxSessionName(key) : sessionName,
    latchCase: input.latchCase,
    refusedOperation: input.refusedOperation,
    rowState: input.rowState,
    ...(description === '' ? {} : { description }),
  })
}

// ---------------------------------------------------------------------------
// The unusable recorded name (b.jg5 SRJ-512, SRJ-1019)
// ---------------------------------------------------------------------------

/** A verb site kind wired for an UNUSABLE NAME answer: E16 T1's, then the dialog approver's (E17). */
export type UnusableNameSite =
  | 'resume'
  | 'plain spawn'
  | 'read-pane'
  | 'status'
  | 'get'
  | ApproverSite
  | ReconnectSite
  | typeof RESTART_KILL_SITE
  | SequenceKillSite
  | typeof REUSE_SPAWN_SITE
  | StuckLaunchAbortSite

/** The agent-director verb each site kind calls. */
const UNUSABLE_NAME_SITE_VERB: Readonly<Record<UnusableNameSite, string>> = Object.freeze({
  'resume': 'resume',
  'plain spawn': SPAWN_VERB,
  'read-pane': 'read-pane',
  'status': 'status',
  'get': 'get',
  ...APPROVER_SITE_VERB,
  [RECONNECT_SITE]: 'send-keys',
  [RESTART_KILL_SITE]: 'kill',
  [SEQUENCE_STEP1_KILL_SITE]: 'kill',
  [SEQUENCE_STEP4_KILL_SITE]: 'kill',
  [REUSE_SPAWN_SITE]: SPAWN_VERB,
  [STUCK_LAUNCH_ABORT_SITE]: 'kill',
})

/** Every site kind of {@link UnusableNameSite}, in row order. */
export const UNUSABLE_NAME_SITES: readonly UnusableNameSite[] = Object.freeze(
  Object.keys(UNUSABLE_NAME_SITE_VERB) as UnusableNameSite[],
)

/** One UNUSABLE NAME answer at one site kind and what latching a persona on it records and posts. */
export interface UnusableNameCaseRow {
  /** Readable row name for `test.each`: `<site>: <fault>`. */
  readonly name: string
  /** The verb site kind that meets the answer. */
  readonly site: UnusableNameSite
  /** The agent-director verb that answers. */
  readonly verb: string
  /** The stub's recorded-name fault. */
  readonly fault: UnusableNameFault
  /** Builds the error through the stub's `errUnusableName(fault)`. */
  readonly build: () => ReturnType<typeof errUnusableName>
  /** "unusable recorded name". */
  readonly latchCase: typeof LATCH_CASE_UNUSABLE_RECORDED_NAME
  /** "none": the re-check reads only `status`. */
  readonly refusedOperation: typeof REFUSED_OPERATION_NONE
  /** The row state the latch records on this path. */
  readonly rowState: LatchRowState
  /** True when `rowState` comes from the one latch-time `status` read (the path read nothing before its call). */
  readonly latchTimeRead: boolean
  /** The classification's message (redacted, one line, capped): the record's description. */
  readonly description: string
  /** The session the record holds for persona `key`. */
  readonly sessionName: (key: string) => string
  /** The SRJ-1019 notice body for persona `key` (the persona notifier adds the prefix). */
  readonly notice: (key: string) => string
  /** The whole latch record a latch of persona `key` from this row holds ({@link expectedLatchRecord} of `unusableNameSetInput`). */
  readonly record: (key: string) => ConflictLatchRecord
}

/**
 * The state each non-read site kind's path last read before its call (see the
 * header). The reconnect's rows take each state of {@link RECONNECT_ROW_STATES}
 * instead, and the sequence kills' each state of {@link SEQUENCE_KILL_ROW_STATES}.
 */
const UNUSABLE_NAME_LAST_READ: Readonly<Record<Exclude<UnusableNameSite, ReconnectSite | SequenceKillSite>, LatchRowState>> = Object.freeze({
  'resume': ENDED,
  'plain spawn': LATCH_ROW_STATE_NO_ROW,
  'read-pane': WORKING,
  'status': LATCH_ROW_STATE_UNREADABLE,
  'get': LATCH_ROW_STATE_UNREADABLE,
  // The approver's `status` goes through the own-row `status` step, which
  // read no state; its pane verbs follow the lap's `pending` read.
  'approver status': LATCH_ROW_STATE_UNREADABLE,
  'approver read-pane': PENDING,
  'approver send-keys': PENDING,
  // The restart path's kill records the state its run's `dead` reading
  // carries (b.jg5 SRJ-501), with no latch-time `status` read: `ended` here.
  [RESTART_KILL_SITE]: ENDED,
  // The reuse spawn records the state its path last read (b.jg5 SRJ-501),
  // with no latch-time `status` read: `ended` here, a finished row.
  [REUSE_SPAWN_SITE]: ENDED,
  // The stuck-launch abort's kill records `pending`, the state the
  // pending-row rule's `get` last read (b.jg5 SRJ-412, SRJ-501), with no
  // latch-time `status` read.
  [STUCK_LAUNCH_ABORT_SITE]: PENDING,
})

function unusableNameRow(
  site: UnusableNameSite,
  fault: UnusableNameFault,
  rowState: LatchRowState,
  lastRead?: ReconnectLastRead | SequenceKillLastRead,
): UnusableNameCaseRow {
  const build = () => errUnusableName(fault)
  const message = classifyAdError(build()).message
  if (message === undefined) throw new Error(`conflict-cases: errUnusableName('${fault}') has no classification message`)
  const record = (key: string): ConflictLatchRecord => {
    const input = unusableNameSetInput(key, build(), rowState)
    if (input === undefined) throw new Error(`conflict-cases: errUnusableName('${fault}') gives no unusable-name set input`)
    return expectedLatchRecord(key, input)
  }
  return Object.freeze({
    name: lastRead === undefined ? `${site}: ${fault}` : `${site} (${lastRead}): ${fault}`,
    site,
    verb: UNUSABLE_NAME_SITE_VERB[site],
    fault,
    build,
    latchCase: LATCH_CASE_UNUSABLE_RECORDED_NAME,
    refusedOperation: REFUSED_OPERATION_NONE,
    rowState,
    latchTimeRead: site === 'plain spawn',
    description: message,
    sessionName: (key: string) => personaTmuxSessionName(key),
    notice: (key: string) => unusableNameNoticeText(key, message),
    record,
  })
}

/**
 * Every UNUSABLE NAME row: each fault of `UNUSABLE_NAME_FAULTS` at each site
 * kind (the reconnect's for each state in {@link RECONNECT_ROW_STATES}, the
 * sequence kills' for each state in {@link SEQUENCE_KILL_ROW_STATES}), for
 * `test.each`.
 */
export const UNUSABLE_NAME_CASE_ROWS: readonly UnusableNameCaseRow[] = Object.freeze(
  UNUSABLE_NAME_SITES.flatMap((site) =>
    isReconnectSite(site)
      ? RECONNECT_LAST_READS.flatMap((lastRead) =>
          UNUSABLE_NAME_FAULTS.map((fault) => unusableNameRow(site, fault, RECONNECT_ROW_STATES[lastRead], lastRead)),
        )
      : isSequenceKillSite(site)
        ? SEQUENCE_KILL_LAST_READS.flatMap((lastRead) =>
            UNUSABLE_NAME_FAULTS.map((fault) => unusableNameRow(site, fault, SEQUENCE_KILL_ROW_STATES[lastRead], lastRead)),
          )
        : UNUSABLE_NAME_FAULTS.map((fault) => unusableNameRow(site, fault, UNUSABLE_NAME_LAST_READ[site])),
  ),
)

/** The dialog approver's UNUSABLE NAME rows of {@link UNUSABLE_NAME_CASE_ROWS} (its `status`, `read-pane` and `send-keys`), for `test.each`. */
export const APPROVER_UNUSABLE_NAME_CASE_ROWS: readonly UnusableNameCaseRow[] = Object.freeze(
  UNUSABLE_NAME_CASE_ROWS.filter((caseRow) => isApproverSite(caseRow.site)),
)

/** The reconnect's `send-keys` UNUSABLE NAME rows of {@link UNUSABLE_NAME_CASE_ROWS} (E19 T1), for `test.each`. */
export const RECONNECT_UNUSABLE_NAME_CASE_ROWS: readonly UnusableNameCaseRow[] = Object.freeze(
  UNUSABLE_NAME_CASE_ROWS.filter((caseRow) => isReconnectSite(caseRow.site)),
)

/** The restart path's kill UNUSABLE NAME rows of {@link UNUSABLE_NAME_CASE_ROWS} (E20), for `test.each`. */
export const RESTART_KILL_UNUSABLE_NAME_CASE_ROWS: readonly UnusableNameCaseRow[] = Object.freeze(
  UNUSABLE_NAME_CASE_ROWS.filter((caseRow) => caseRow.site === RESTART_KILL_SITE),
)

/** The live-row sequence's kill UNUSABLE NAME rows of {@link UNUSABLE_NAME_CASE_ROWS} (E21), for `test.each`. */
export const SEQUENCE_KILL_UNUSABLE_NAME_CASE_ROWS: readonly UnusableNameCaseRow[] = Object.freeze(
  UNUSABLE_NAME_CASE_ROWS.filter((caseRow) => isSequenceKillSite(caseRow.site)),
)

/** The reuse spawn's UNUSABLE NAME rows of {@link UNUSABLE_NAME_CASE_ROWS} (E22), for `test.each`. */
export const REUSE_SPAWN_UNUSABLE_NAME_CASE_ROWS: readonly UnusableNameCaseRow[] = Object.freeze(
  UNUSABLE_NAME_CASE_ROWS.filter((caseRow) => caseRow.site === REUSE_SPAWN_SITE),
)

/** The stuck-launch abort's kill UNUSABLE NAME rows of {@link UNUSABLE_NAME_CASE_ROWS} (E29; one per fault, each recording `pending`), for `test.each`. */
export const STUCK_LAUNCH_ABORT_UNUSABLE_NAME_CASE_ROWS: readonly UnusableNameCaseRow[] = Object.freeze(
  UNUSABLE_NAME_CASE_ROWS.filter((caseRow) => isStuckLaunchAbortSite(caseRow.site)),
)

/** The sequence kill UNUSABLE NAME rows of one site kind whose sequence last read `lastRead`, for `test.each`. */
export function sequenceKillUnusableNameRowsAt(site: SequenceKillSite, lastRead: SequenceKillLastRead): readonly UnusableNameCaseRow[] {
  return SEQUENCE_KILL_UNUSABLE_NAME_CASE_ROWS.filter((caseRow) => caseRow.site === site && caseRow.rowState === SEQUENCE_KILL_ROW_STATES[lastRead])
}

/** The reconnect's UNUSABLE NAME rows for a caller that last read `lastRead`, for `test.each`. */
export function reconnectUnusableNameRowsAt(lastRead: ReconnectLastRead): readonly UnusableNameCaseRow[] {
  return RECONNECT_UNUSABLE_NAME_CASE_ROWS.filter((caseRow) => caseRow.rowState === RECONNECT_ROW_STATES[lastRead])
}

// ---------------------------------------------------------------------------
// The launch start not recorded (b.jg5 SRJ-513, SRJ-408, SRJ-1020)
// ---------------------------------------------------------------------------

/** What each read shape answers, as the stub's canned builders build it. */
export interface LaunchStartReadResults {
  readonly status: Phase1StatusResult
  readonly get: CannedGetResult
  readonly list: Phase1ListRow
}

/** A read the server makes of a row: `status`, `get` or `list`. */
export type LaunchStartReadShape = keyof LaunchStartReadResults

/** Every read shape, in row order. */
export const LAUNCH_START_READ_SHAPES: readonly LaunchStartReadShape[] = Object.freeze(['status', 'get', 'list'] as const)

/**
 * Which of persona P's rows a latching row is (SRJ-513: "whether or not it is
 * P's current life"): P's current life, or P's own row with a `cwd` or a
 * `config_dir` label other than P's.
 */
export type LaunchStartRowVariant = 'current life' | 'other cwd' | 'other config_dir'

/** Every row variant, in row order. */
export const LAUNCH_START_ROW_VARIANTS: readonly LaunchStartRowVariant[] = Object.freeze([
  'current life',
  'other cwd',
  'other config_dir',
] as const)

/** A form of "no launch start" (SRJ-408): the field absent, `null`, or a value that does not parse. */
export type NoLaunchStartForm = 'absent' | 'null' | 'unparseable'

/**
 * An unparseable launch start: the stub's whole-second sample with its zone
 * dropped, which RFC 3339 requires. No timestamp is typed here.
 */
export const UNPARSEABLE_LAUNCH_START: string = SAMPLE_LAUNCH_START_WHOLE.replace(/(?:[Zz]|[+-]\d{2}:\d{2})$/, '')
if (UNPARSEABLE_LAUNCH_START === SAMPLE_LAUNCH_START_WHOLE || parseLaunchStart(UNPARSEABLE_LAUNCH_START) !== undefined) {
  throw new Error('conflict-cases: UNPARSEABLE_LAUNCH_START must not parse as a launch start')
}

/**
 * Each form of "no launch start" as a builder override: `SAMPLE_LAUNCH_START_NONE`
 * (the key left out of the row), `null`, and {@link UNPARSEABLE_LAUNCH_START}.
 * Each is passed explicitly, since the canned builders give a `pending` row a
 * sample launch start when the override has no `launch_started_at` key.
 */
export const NO_LAUNCH_START_FORMS: Readonly<Record<NoLaunchStartForm, string | null | undefined>> = Object.freeze({
  absent: SAMPLE_LAUNCH_START_NONE,
  null: null,
  unparseable: UNPARSEABLE_LAUNCH_START,
})

/** Every form of "no launch start", in row order. */
export const NO_LAUNCH_START_FORM_NAMES: readonly NoLaunchStartForm[] = Object.freeze(['absent', 'null', 'unparseable'] as const)

/** The instance id of a caller that is not CSCB: no persona's `cscb_<key>`. */
export const LAUNCH_START_ANOTHER_CALLERS_ID = 'another-caller-instance'
/** A key no configured persona uses: an absent persona's. */
export const LAUNCH_START_ABSENT_PERSONA_KEY = 'absent_persona'
/** The key of a pre-persona row's id (`cscb_<key>`, labelled `service=cscb` only, b.1ix). */
export const LAUNCH_START_PRE_PERSONA_KEY = 'legacy'

/** The fields a row variant or kind overrides: those every read shape's builder takes. */
interface LaunchStartRowOverrides {
  readonly state: string
  readonly launch_started_at: string | null | undefined
  readonly liveness_note?: Phase1GetResult['liveness_note']
  readonly cwd?: string
  readonly labels?: Record<string, string>
  readonly claude_instance_id?: string
}

/** What a row is built from for persona P: the persona the persona-form builder takes, and the overrides. */
interface LaunchStartRowSpec {
  readonly rowPersona: CannedRowPersona
  readonly overrides: LaunchStartRowOverrides
}

/**
 * The read answer `shape` gives for `spec`, through the stub's canned
 * builders in their persona form (`home`: the directory the `config_dir`
 * label is computed against). A `status` result carries only `state` and
 * `launch_started_at`, so a variant's `cwd`, labels and note are the row
 * behind it and do not show in the result.
 */
function buildLaunchStartRead<S extends LaunchStartReadShape>(
  shape: S,
  spec: LaunchStartRowSpec,
  home: string,
): LaunchStartReadResults[S] {
  const { state, launch_started_at } = spec.overrides
  const result =
    shape === 'status'
      ? cannedStatusResult({ state, launch_started_at })
      : shape === 'get'
        ? cannedGetResult({ ...spec.overrides }, spec.rowPersona, home)
        : cannedListRow({ ...spec.overrides }, spec.rowPersona, home)
  return result as LaunchStartReadResults[S]
}

/**
 * The row as `decideOwnRowRead` reads it: a `get` or `list` row as built; a
 * `status` result with the id of the row the read addressed, as the own-row
 * `status` step gives it (`applyOwnRowStatusStep`).
 */
function launchStartReadRow(shape: LaunchStartReadShape, read: LaunchStartReadResults[LaunchStartReadShape], rowId: string): RowReadRow {
  return shape === 'status' ? { ...read, claude_instance_id: rowId } : (read as RowReadRow)
}

/** The labels a spawn of `persona` writes, read off the stub's persona-form row. */
function personaLabels(persona: CannedRowPersona, home: string): Record<string, string> {
  return cannedGetResult({}, persona, home).labels
}

/** The columns every launch-start row carries, for one read shape. */
interface LaunchStartRowColumns<S extends LaunchStartReadShape> {
  /** Readable row name for `test.each`. */
  readonly name: string
  /** The read that gives the row. */
  readonly shape: S
  /** The raw launch start the row carries (absent when `undefined`). */
  readonly launchStart: string | null | undefined
  /** Builds the read's answer for persona P with the stub's canned builders in their persona form. */
  readonly build: (persona: CannedRowPersona, home: string) => LaunchStartReadResults[S]
  /** The key the read is made for: P's own, or the key the row's id stands for. */
  readonly readKey: (persona: CannedRowPersona) => string
  /** Whether {@link readKey} is a configured persona's when P is the one configured persona. */
  readonly configured: boolean
  /** The row as `decideOwnRowRead` reads it (a `status` result given its row's id). */
  readonly readRow: (persona: CannedRowPersona, home: string) => RowReadRow
  /** `decideOwnRowRead`'s input for this row: {@link readKey}, {@link readRow} and {@link configured}. */
  readonly decisionInput: (persona: CannedRowPersona, home: string) => OwnRowReadInput
}

function launchStartColumns<S extends LaunchStartReadShape>(
  name: string,
  shape: S,
  specOf: (persona: CannedRowPersona, home: string) => LaunchStartRowSpec,
  readKey: (persona: CannedRowPersona) => string,
  configured: boolean,
): LaunchStartRowColumns<S> {
  const build = (persona: CannedRowPersona, home: string) => buildLaunchStartRead(shape, specOf(persona, home), home)
  const readRow = (persona: CannedRowPersona, home: string): RowReadRow => {
    const spec = specOf(persona, home)
    return launchStartReadRow(shape, buildLaunchStartRead(shape, spec, home), spec.overrides.claude_instance_id ?? personaInstanceId(spec.rowPersona.key))
  }
  return {
    name,
    shape,
    launchStart: undefined,
    build,
    readKey,
    configured,
    readRow,
    decisionInput: (persona, home) => ({ key: readKey(persona), row: readRow(persona, home), configured }),
  }
}

/** One latching launch-start row for one read shape. */
export interface LaunchStartCaseRowOf<S extends LaunchStartReadShape> extends LaunchStartRowColumns<S> {
  /** Which of P's rows it is. */
  readonly variant: LaunchStartRowVariant
  /** Its form of "no launch start". */
  readonly form: NoLaunchStartForm
  /** The `liveness_note` the row also carries (`provenanceNote` on {@link LAUNCH_START_AND_NOTE_ROW} only). */
  readonly livenessNote: Phase1GetResult['liveness_note'] | undefined
  /** "launch start not recorded". */
  readonly latchCase: typeof LATCH_CASE_LAUNCH_START_NOT_RECORDED
  /** "none": the re-check reads only `status`. */
  readonly refusedOperation: typeof REFUSED_OPERATION_NONE
  /** `pending`, the state the read gave. */
  readonly rowState: LatchRowState
  /** The session the record holds for persona `key`: `personaTmuxSessionName(key)`. */
  readonly sessionName: (key: string) => string
  /** The SRJ-1020 notice body for persona `key` (the persona notifier adds the prefix). */
  readonly notice: (key: string) => string
  /** The whole latch record a latch of persona `key` from this row holds: {@link launchStartRecord}. */
  readonly record: (key: string) => ConflictLatchRecord
}

/**
 * The record a "launch start not recorded" latch of persona `key` holds
 * (SRJ-501, SRJ-513): {@link expectedLatchRecord} of `src/conflict-latch.ts`'s
 * `launchStartNotRecordedSetInput(key, pending)`: the case "launch start not
 * recorded", the refused operation "none", the state `pending`, the session
 * `slack_bot_<key>` as the record stores it, and no description.
 */
export function launchStartRecord(key: string): ConflictLatchRecord {
  return expectedLatchRecord(key, launchStartNotRecordedSetInput(key, PENDING))
}

/** One latching launch-start row: narrow on `shape` for the read's own answer type. */
export type LaunchStartCaseRow = { [S in LaunchStartReadShape]: LaunchStartCaseRowOf<S> }[LaunchStartReadShape]

/** P's own row in `variant`, reading `pending` with `launchStart` (and `note`, if any). */
function ownRowSpec(
  variant: LaunchStartRowVariant,
  launchStart: string | null | undefined,
  note: Phase1GetResult['liveness_note'] | undefined,
): (persona: CannedRowPersona, home: string) => LaunchStartRowSpec {
  return (persona, home) => {
    const base: LaunchStartRowOverrides = {
      state: AGENT_DIRECTOR_PENDING_STATE,
      launch_started_at: launchStart,
      ...(note === undefined ? {} : { liveness_note: note }),
    }
    if (variant === 'other cwd') return { rowPersona: persona, overrides: { ...base, cwd: `${persona.working_directory}_elsewhere` } }
    if (variant === 'other config_dir') {
      const labels = personaLabels(persona, home)
      return { rowPersona: persona, overrides: { ...base, labels: { ...labels, config_dir: `${labels['config_dir']}_elsewhere` } } }
    }
    return { rowPersona: persona, overrides: base }
  }
}

function launchStartRow<S extends LaunchStartReadShape>(
  shape: S,
  variant: LaunchStartRowVariant,
  form: NoLaunchStartForm,
  note?: Phase1GetResult['liveness_note'],
): LaunchStartCaseRowOf<S> {
  const launchStart = NO_LAUNCH_START_FORMS[form]
  const noteLabel = note === undefined ? '' : `, ${note} note`
  return Object.freeze({
    ...launchStartColumns(
      `${shape}: ${variant}, pending with launch start ${form}${noteLabel}`,
      shape,
      ownRowSpec(variant, launchStart, note),
      (persona) => persona.key,
      true,
    ),
    launchStart,
    variant,
    form,
    livenessNote: note,
    latchCase: LATCH_CASE_LAUNCH_START_NOT_RECORDED,
    refusedOperation: REFUSED_OPERATION_NONE,
    rowState: PENDING,
    sessionName: (key: string) => personaTmuxSessionName(key),
    notice: (key: string) => launchStartNotRecordedNoticeText(key),
    record: launchStartRecord,
  })
}

/**
 * Every latching launch-start row: each read shape × each row variant × each
 * form of "no launch start", for `test.each`.
 */
export const LAUNCH_START_CASE_ROWS: readonly LaunchStartCaseRow[] = Object.freeze(
  LAUNCH_START_READ_SHAPES.flatMap((shape) =>
    LAUNCH_START_ROW_VARIANTS.flatMap((variant) =>
      // `shape` spans the union here; each row is one shape's row.
      NO_LAUNCH_START_FORM_NAMES.map((form) => launchStartRow(shape, variant, form) as LaunchStartCaseRow),
    ),
  ),
)

/**
 * P's current-life `get` row reading `pending` with no launch start (absent)
 * and carrying `provenanceNote`: the launch-start decision only, never the
 * note's "conflicting labels" (SRJ-513's precedence).
 */
export const LAUNCH_START_AND_NOTE_ROW: LaunchStartCaseRowOf<'get'> = launchStartRow('get', 'current life', 'absent', provenanceNote)

/**
 * Why a non-latching row latches nothing: a `pending` row with a launch
 * start, a row in another state, or a no-launch-start `pending` row that is
 * no configured persona's own (an absent persona's `cscb_<key>`, another
 * caller's id, a pre-persona row).
 */
export type LaunchStartNonLatchingKind =
  | 'launch start recorded'
  | 'not pending'
  | 'absent persona'
  | 'another caller'
  | 'pre-persona'

/** One read of a row that latches nothing. */
export interface LaunchStartNonLatchingRowOf<S extends LaunchStartReadShape> extends LaunchStartRowColumns<S> {
  readonly kind: LaunchStartNonLatchingKind
  /** The row's state. */
  readonly state: string
}

/** One non-latching launch-start row: narrow on `shape` for the read's own answer type. */
export type LaunchStartNonLatchingRow = { [S in LaunchStartReadShape]: LaunchStartNonLatchingRowOf<S> }[LaunchStartReadShape]

function nonLatchingRow<S extends LaunchStartReadShape>(
  shape: S,
  kind: LaunchStartNonLatchingKind,
  detail: string,
  state: string,
  launchStart: string | null | undefined,
  specOf: (persona: CannedRowPersona, home: string) => LaunchStartRowSpec,
  readKey: (persona: CannedRowPersona) => string,
  configured: boolean,
): LaunchStartNonLatchingRowOf<S> {
  return Object.freeze({
    ...launchStartColumns(`${shape}: ${kind}${detail}`, shape, specOf, readKey, configured),
    launchStart,
    kind,
    state,
  })
}

/** Every state but `pending` (the live and the terminal states). */
const NOT_PENDING_STATES: readonly string[] = Object.freeze(
  [...AGENT_DIRECTOR_LIVE_STATES, ...AGENT_DIRECTOR_DEAD_STATES].filter((state) => state !== AGENT_DIRECTOR_PENDING_STATE),
)

/** The non-none sample launch starts, by form name. */
const RECORDED_LAUNCH_STARTS: readonly (readonly [string, string])[] = Object.freeze(
  Object.entries(SAMPLE_LAUNCH_STARTS).flatMap(([form, value]) => (value === undefined ? [] : [[form, value] as const])),
)

function nonLatchingRowsFor<S extends LaunchStartReadShape>(shape: S): LaunchStartNonLatchingRowOf<S>[] {
  const own = (persona: CannedRowPersona) => persona.key
  const noLaunchStart = NO_LAUNCH_START_FORMS.absent
  const pendingNone: LaunchStartRowOverrides = { state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: noLaunchStart }
  const absentPersona = (persona: CannedRowPersona): CannedRowPersona => ({ ...persona, key: LAUNCH_START_ABSENT_PERSONA_KEY })
  const prePersona = (persona: CannedRowPersona): CannedRowPersona => ({ ...persona, key: LAUNCH_START_PRE_PERSONA_KEY })
  return [
    // A `pending` row with a launch start: each non-none sample form.
    ...RECORDED_LAUNCH_STARTS.map(([form, value]) =>
      nonLatchingRow(shape, 'launch start recorded', ` (${form})`, AGENT_DIRECTOR_PENDING_STATE, value,
        (persona) => ({ rowPersona: persona, overrides: { state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: value } }), own, true),
    ),
    // Every other state, with no launch start.
    ...NOT_PENDING_STATES.map((state) =>
      nonLatchingRow(shape, 'not pending', ` (${state})`, state, noLaunchStart,
        (persona) => ({ rowPersona: persona, overrides: { state, launch_started_at: noLaunchStart } }), own, true),
    ),
    // A no-launch-start `pending` row under a key outside the configured set.
    nonLatchingRow(shape, 'absent persona', '', AGENT_DIRECTOR_PENDING_STATE, noLaunchStart,
      (persona) => ({ rowPersona: absentPersona(persona), overrides: pendingNone }), () => LAUNCH_START_ABSENT_PERSONA_KEY, false),
    nonLatchingRow(shape, 'another caller', '', AGENT_DIRECTOR_PENDING_STATE, noLaunchStart,
      (persona) => ({ rowPersona: persona, overrides: { ...pendingNone, claude_instance_id: LAUNCH_START_ANOTHER_CALLERS_ID, labels: {} } }), own, true),
    nonLatchingRow(shape, 'pre-persona', '', AGENT_DIRECTOR_PENDING_STATE, noLaunchStart,
      (persona, home) => {
        const { persona: _persona, config_dir: _configDir, ...labels } = personaLabels(persona, home)
        return { rowPersona: prePersona(persona), overrides: { ...pendingNone, labels } }
      }, () => LAUNCH_START_PRE_PERSONA_KEY, false),
  ]
}

/**
 * Every non-latching launch-start row, per read shape: `pending` with each
 * non-none form in `SAMPLE_LAUNCH_STARTS`; every other state with no launch
 * start; and the no-launch-start `pending` row under a key outside the
 * configured set (an absent persona's `cscb_<key>`, another caller's id, a
 * pre-persona row). Each decides nothing.
 */
export const LAUNCH_START_NON_LATCHING_ROWS: readonly LaunchStartNonLatchingRow[] = Object.freeze(
  // `shape` spans the union here; each row is one shape's row.
  LAUNCH_START_READ_SHAPES.flatMap((shape) => nonLatchingRowsFor(shape) as LaunchStartNonLatchingRow[]),
)

// ---------------------------------------------------------------------------
// The tmux-touching verbs (HO C24; ADSRD SR-1.4; b.jg5 SRJ-502)
// ---------------------------------------------------------------------------

/** One tmux-touching verb and the stub call-log list that records its calls. */
export interface TmuxTouchingStubVerb {
  readonly verb: string
  readonly log: keyof StubCallLog
}

/**
 * The agent-director verbs that touch tmux, with the stub's call-log list of
 * each: `resume`, `spawn` in both forms (plain and `--reuse-finished`, both
 * in `spawnCalls`), `read-pane`, `send-keys`, `kill` and `pause`. HO C24
 * says no tmux-touching call is made for an unusable recorded name, and
 * ADSRD SR-1.4 is where agent-director names these verbs as the ones that
 * reach tmux; a `kill` counts here whatever row it was declared for, so a
 * test's "no tmux-touching call" check is never weaker than SRJ-502's.
 */
export const TMUX_TOUCHING_STUB_VERBS: readonly TmuxTouchingStubVerb[] = Object.freeze([
  Object.freeze({ verb: 'resume', log: 'resumeCalls' }),
  Object.freeze({ verb: SPAWN_VERB, log: 'spawnCalls' }),
  Object.freeze({ verb: 'read-pane', log: 'readPaneCalls' }),
  Object.freeze({ verb: 'send-keys', log: 'sendKeysCalls' }),
  Object.freeze({ verb: 'kill', log: 'killCalls' }),
  Object.freeze({ verb: 'pause', log: 'pauseCalls' }),
] as const)

/** One tmux-touching call a stub log recorded: its verb and the params it was given. */
export interface TmuxTouchingCall {
  readonly verb: string
  readonly params: unknown
}

/**
 * The tmux-touching calls `log` recorded, verb by verb in
 * {@link TMUX_TOUCHING_STUB_VERBS}' order (each verb's calls in call order);
 * empty when there is none. Pass `from`, the log's lengths taken earlier with
 * {@link tmuxTouchingCallCounts}, to get only the calls made since.
 */
export function tmuxTouchingCallsIn(
  log: StubCallLog,
  from?: Readonly<Partial<Record<keyof StubCallLog, number>>>,
): TmuxTouchingCall[] {
  return TMUX_TOUCHING_STUB_VERBS.flatMap(({ verb, log: list }) =>
    (log[list] as readonly unknown[]).slice(from?.[list] ?? 0).map((params) => ({ verb, params })),
  )
}

/** How many calls each tmux-touching verb's list in `log` holds now, for {@link tmuxTouchingCallsIn}'s `from`. */
export function tmuxTouchingCallCounts(log: StubCallLog): Partial<Record<keyof StubCallLog, number>> {
  return Object.fromEntries(
    TMUX_TOUCHING_STUB_VERBS.map(({ log: list }) => [list, (log[list] as readonly unknown[]).length]),
  )
}
