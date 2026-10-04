/**
 * conflict-latch.test.ts — CONFLICT case recognition (b.jg5 SRJ-507), the
 * `tests/conflict-latch.test.ts` half of SRJ-1303, and the latch record
 * (SRJ-501, with SRJ-506's same-case rule) over `createConflictLatch`.
 *
 * Recognition: every row of the case table (`tests/test-helpers/conflict-cases.ts`)
 * resolves to its case; a description carrying several case phrases takes the
 * first in `CONFLICT_CASE_ORDER`, and so does a description built from any two
 * phrase constants, in either textual order; the plain spawn's label wordings
 * and the other words beside a case phrase are no case; one pin case (the
 * file's only literal block) checks the exported order against SRJ-507's,
 * with "no pane 0.0" absent. The `different-id` and `another-store`
 * descriptions carry no "Operator actions" section title, which is read from
 * the stub's own descriptions, never typed.
 *
 * Record: latching a persona on each row's error records the quoted session,
 * the case, the refused operation and the row state; a description with no
 * quoted name records `slack_bot_<key>`; an empty or multi-line quoted span
 * is skipped whole (quotes pair left to right), so a later name is taken, and
 * a description with only such spans records `slack_bot_<key>`; a `waiting` state and an unreadable
 * state count as live, `pending`, `ended`, `missing` and no row do not; the
 * description is kept redacted, on one line and capped. A different case
 * relatches (the record replaced), the same case keeps the record unchanged
 * (SRJ-506, hatch A3), and `set` answers which. One latch per persona, a new
 * instance holds none, and `forget` is silent and per key. Set observers see
 * every set; a throwing or rejecting observer, and a throwing log, are
 * swallowed.
 *
 * The CONFLICT notice (SRJ-1004), its episode (SRJ-508, SRJ-1016) and the
 * recovery texts (SRJ-1005). One pin case (the file's only literal block for
 * these texts) checks every case's notice, every fixed line and both recovery
 * templates with each reason against SRJ-1004's and SRJ-1005's words. Every
 * other case compares with the helper's `expectedConflictNotice`, assembled
 * from the exported constants: per row, the post a real latch bound to real
 * notice episodes makes is the row's expected notice, its lines in SRJ-1004's
 * order ("a different instance id": its must-not-be-ended line in place of
 * the pointer and no "Operator actions"; "another agent-director store": its
 * must-not-be-ended line, then the pointer, then the `list` line); CSCB's own
 * lines (`cscbOwnLines`) match none of `SESSION_ENDING_COMMAND_FORMS` and none
 * of the helper's `CSCB_OWN_LINE_FORBIDDEN` (kill-pane, set-option,
 * agent-director delete, clear-latch, has-session, a label option name), while
 * the quoted "no kill was sent" is let through; the description is redacted,
 * capped and escaped once for Slack (the log line stays unescaped), and a
 * record with none has no description line. Episode: a latch posts once, a
 * same-case set posts nothing, a new case posts once more, another persona
 * posts only for itself, a hold case, a closed instance and an unbound
 * observer post nothing, and a b.f2b `unproven-idle` or `blocked-on-prompt`
 * notice already raised for the persona suppresses nothing (AC 41). A hold
 * case opens no CONFLICT episode and posts no CONFLICT notice: each hold
 * opens its own episode kind, and the unusable-name hold posts SRJ-1019.
 *
 * The unusable recorded name (SRJ-512, SRJ-1019, SRJ-508, SRJ-1016; AC 77,
 * AC 85), over the helper's `UNUSABLE_NAME_CASE_ROWS`. One pin case (the
 * file's only literal block for this text) checks SRJ-1019 word for word
 * against the builder; every other case compares with the rows' `notice`.
 * Per fault: the latch posts the row's notice once, with the instance id,
 * the description rendered (redacted, capped) and quoted, the "Operator
 * actions" title (read from the stub) and the human-only sentence; CSCB's
 * own text (`cscbOwnText`) names no session-ending command and nothing of
 * `CSCB_OWN_LINE_FORBIDDEN`. A sentinel-bearing description is redacted and
 * an overlong one capped; through `makeNotifierHarness` the persona's own
 * stub gets `formatPersonaNotice(persona, notice)` at its destination. Per
 * row: the record (the case, "none", the row's state, `slack_bot_<key>`, the
 * description) and the matching set input; a quoted session is recorded by
 * SRJ-501's rule; an `ErrInternal` without the phrase, and other values,
 * latch nothing. Episode: the first latch posts once under the unusable-name
 * kind, a second UNUSABLE NAME posts nothing, a relatch from a CONFLICT posts
 * once and a relatch back posts SRJ-1004 once (each ending the other kind's
 * episode silently), and a not-connected notice suppresses nothing.
 *
 * SRJ-512's automated half (SRJ-502, on `makeRecoveryHarness`, both settings
 * 0): P latches from `resume`'s UNUSABLE NAME, and in a second harness from
 * the working-row evidence `read-pane`; then a new launch, the retry entry,
 * a scheduled and a human-triggered restart and the retry timer make no
 * tmux-touching call (`tmuxTouchingCallsIn`) or delete for P's instance,
 * count nothing, and leave exactly one post, SRJ-1019; Q's paths reach the
 * stub as before. A message lost for P so latched reports `held-for-human`
 * with no call and no restart; Q's reports its own state. The UNCLASSIFIED
 * control: an `ErrInternal` without the phrase at the same `resume` latches nothing,
 * posts no hold notice and takes E12's handling (the unclassified episode,
 * the UNCLASSIFIED cause armed, nothing counted).
 *
 * The reconnect as a latch site (SRJ-118, SRJ-505, on `makeRecoveryHarness`,
 * both settings 0): P launches onto a colliding `waiting` row whose
 * reconnect's one `send-keys` answers CONFLICT (a case-table reconnect row)
 * or UNUSABLE NAME; P latches once with one post, and the same paths plus a
 * health tick make no further `send-keys`, other tmux-touching call or
 * delete for P and count nothing, the retry timer stopping latched;
 * Q launches and reconnects as before.
 * The kill as a latch site (SRJ-110, SRJ-505, AC 9; E20): P's restart run's
 * kill after a liveness read of ErrSystemInstallDisappeared (a row read
 * `ended` launches with no kill, SRJ-314), or the step-1 kill of the
 * live-row sequence P's
 * launch starts at a collision ladder replacement site over a row read
 * `waiting` in another directory (the ladder makes
 * no kill of its own, b.jg5 SRJ-707), answers CONFLICT "not this launch's
 * session" (the case table's restart-kill and sequence-kill rows), or
 * the restart run's kill answers UNUSABLE NAME; P latches once with one
 * post, its armed retry timer stops latched, and the same paths plus a health
 * tick make no further `kill`, delete, spawn, resume or other tmux-touching
 * call for P: exactly one `kill` of P; Q's paths go on.
 * The live-row sequence's own latches (SRJ-110, SRJ-501, SRJ-512, SRJ-513,
 * SRJ-114, SRJ-613; E21, on `makeRecoveryHarness`'s sequence driver): over
 * the case table's sequence-kill rows (`SEQUENCE_KILL_CONFLICT_CASE_ROWS`,
 * `SEQUENCE_KILL_UNUSABLE_NAME_CASE_ROWS`: the step-1 and step-4 kills, on a
 * row last read `pending` or `waiting`, SRJ-613's kill backstop among them),
 * P latches once with the row's record and one post, the kill is sent once
 * and is P's sequence's last call, and P's armed retry timer stops latched;
 * a `provenance_conflict` note at the step-2 `get` or a confirming `get`
 * latches "conflicting labels" with the note latch's refused operation, one
 * post; P's own `pending` row with no launch start at the step-2 `get`
 * latches "launch start not recorded" with one post and no wait armed (each
 * such read ends the sequence stopped for the latch, with no further call
 * and nothing armed), and the same row under an old key latches no one; Q's
 * sequence, run beside P's, is not latched and launches. A running sequence
 * whose first run is held stops when P latches from another path's own-row
 * read: no further call for P, one post, no alert or timer left, while Q's
 * sequence beside it runs on to its launch.
 * The reuse spawn's latches (SRJ-112, SRJ-501, SRJ-507, SRJ-512; HO rev 15,
 * rev 20; AC 77, AC 85; E22, on `makeRecoveryHarness`'s sequence driver
 * ending in a reuse): over the case table's reuse rows
 * (`REUSE_SPAWN_CONFLICT_CASE_ROWS`, every CONFLICT case a spawn can answer,
 * "another agent-director store" in both forms and "conflicting labels"
 * after "duplicate session" among them, and
 * `REUSE_SPAWN_UNUSABLE_NAME_CASE_ROWS`), on a finished row and, for the
 * pre-spawn scan's rows, on an id with no row (step 3's `get` reading none),
 * P latches once with the reuse spawn's refused operation (none for UNUSABLE
 * NAME) and the state the sequence last read ("no row" for the scan's), one
 * post, the reuse is P's last call, nothing is counted and P's armed retry
 * timer stops latched; SRJ-512's reuse case: the post points to "Operator
 * actions" and CSCB's own words name no session-ending command, and a message
 * lost then reports `held-for-human` with no call and no restart; Q's
 * sequence, run beside P's, is not latched and launches its own reuse.
 * The not-resumable step's re-read (SRJ-710, SRJ-114, SRJ-513, on
 * `makeRecoveryHarness`): after `resume`'s ErrSpawnNotResumable on a path
 * holding dead evidence, a re-read carrying a `provenance_conflict` note or
 * reading P's own `pending` row with no launch start latches P once with its
 * record and one post, and nothing follows (no sequence, kill, delete or
 * launch; nothing counted); Q untouched. `resume`'s CONFLICT rows at both
 * `resume` sites are tests/session-manager.test.ts's.
 * Recovery: each reason ("row reads" over every live and dead state) under
 * both latch kinds, with no line matching either list.
 *
 * AC 46's automated half (SRJ-502, on `makeRecoveryHarness` with both
 * settings 0): P latches through the launch driver at a plain-spawn row and
 * at a `resume` row; then a new launch, the retry entry, a scheduled restart,
 * a human-triggered restart request, the retry timer (armed after the latch,
 * over several waits) and a health tick with the latched query bound make no
 * kill, spawn, resume or delete for P (the tick reads its liveness only), and
 * the latch posts exactly one CONFLICT notice and no spawn-failure notice;
 * Q's run of each path is asserted call for call. The restart module's delay
 * accessor answers a non-zero delay (the setting 0 arms no restart timer), and
 * the restart timer and the health interval, which take no clock, are fired
 * by hand from a captured callback, so no real timer runs. A failing
 * latch-time `status` read (UNAVAILABLE, and UNCLASSIFIED) proves the order:
 * the read before any set, then the set, the three holds in order and the
 * notice, by which P's timer, `tmux-unresponsive` condition and
 * unclassified episode are all closed, and nothing fires for P afterwards.
 *
 * The holds' set observer (SRJ-502, SRJ-610, SRJ-1016), pure: on a set the
 * four holds (the timer's stop, the condition's end, the unclassified end and
 * the slow-recovery end) run for the persona in that order, before a notice
 * observer bound after them; a hold that throws is logged and the next still
 * runs; holds with no slow-recovery end run the other three. With the
 * stuck-launch end bound it runs fifth, after the slow-recovery end, on a
 * latch, a relatch and a same-case set alike, and still runs when an
 * earlier hold throws; one that throws is logged under its name. The latch's
 * slow-recovery end on `makeRecoveryHarness` (SRJ-610, SRJ-1016, SRJ-502):
 * P's and Q's rows read `working` with their panes gone, so three restart
 * runs each escalate dead with a live re-probe and open both slow-recovery
 * episodes (one `slowRecoveryText` post each); P's next run meets the
 * working-row verdict's `read-pane` CONFLICT and latches; by the CONFLICT
 * notice P's count is 0 and its episode ended, with the latched reason's
 * lines and no slow-recovery post, exactly one CONFLICT post follows, later
 * runs for P are latched and post nothing, and Q keeps its count and open
 * episode; the harness's cleanup leaves no count or episode behind.
 *
 * The latch's stuck-launch end on `makeRecoveryHarness` (SRJ-1016, SRJ-502):
 * P's and Q's stuck-launch posts (`postStuckLaunchHeld`,
 * `postStuckLaunchRelaunching` over the harness's episodes) open both
 * episodes; P's latch (a plain-spawn `scan-leftover` CONFLICT, whose
 * latch-time read finds no row), and separately P's relatch with a new case
 * (a `provenance_conflict` note on its own `ended` row, after a first latch),
 * end P's episode by the CONFLICT notice, with one line carrying the latched
 * reason and no post from the end; Q's episode stays open; a later post of
 * the same text for P posts again.
 *
 * A lost message while latched (SRJ-502, SRJ-1011, AC 68, on
 * `makeRecoveryHarness` with both settings 0): P latches through the launch
 * driver at a plain-spawn `scan-leftover` row; a message lost for P through
 * the harness's lost-message driver (the real routing's no-session branch,
 * its latched query the harness's latch, as `main()` binds it) reports
 * `held-for-human` with the exported wording, posted at P's destination, asks
 * the restart module for no restart and makes no call, and nothing fires for
 * P afterwards; Q's lost message reports its own state.
 *
 * SRJ-504's restart legs (AC 45, on `makeRecoveryHarness`): a server restart
 * is two harness lifetimes, the first cleaned up before the second is built,
 * each over a stub answering the same condition. In each lifetime P's
 * bring-up latches it with the one fresh latch reaction (set latched, the
 * three holds, one CONFLICT post), no spawn-failure notice and only the leg's
 * calls; before the second lifetime's first attempt P is unlatched, with no
 * record, event, post or call. The scan leg: the plain first spawn meets
 * `scan-leftover`, recorded "plain spawn" with no row (the latch-time `status`
 * read answers `ErrSpawnNotFound`). The "no valid label" leg, in its reuse
 * form (b.jg5 SRJ-707): collision, `get` reading `ended` with no session id,
 * `resume` answering `ErrNoSessionId`, then the reuse spawn of the same id
 * answering `no-valid-id`, recorded "reuse spawn" with the collision `get`'s
 * `ended`; no delete in either lifetime. At that same reuse site the stub's
 * another-store description, in both forms, latches P with "another
 * agent-director store" and "reuse spawn" (SRJ-507), its one post carrying
 * the another-store line.
 *
 * The note rules (SRJ-114; SRJ-501's note trigger and its Test half;
 * SRJ-1004's note notice, hatch A2). The pure decision
 * (`decideOwnRowRead`): a configured persona's own row carrying the stub's
 * `provenanceNote`, in every state, decides a latch with "conflicting
 * labels", P's bring-up and the state read (a `waiting` state counts as
 * live); every other note agent-director names (`nonLatchingNotes`), the
 * stub's `unknownNote` (a prefix of it is the latching note), the latching
 * note case-folded or inside other text, and no note decide nothing; so does
 * the latching note on an unconfigured key's row, another caller's row,
 * another persona's row read for P and an id that only starts with P's.
 * Through the shared own-row read (`readPersonaOwnRow`) on
 * `makeRecoveryHarness`, its real latch and notice episodes: a note latch
 * once (the record is `slack_bot_<key>`, "conflicting labels", P's bring-up
 * and the live `waiting` state, with no description; one CONFLICT post; a
 * second read posts nothing; Q is neither latched nor called); the notice,
 * line by line from the exported constants and the case-sentence table, with
 * no "agent-director said" line; P latched first with another case relatches
 * on the note with one new post; a configured Q's own row latches Q alone;
 * and `tmux_server_changed`, `process_not_seen_session_present` (standing
 * for every other listed note), the unknown note, no note, and the latching
 * note on another caller's row, on a key outside the configuration and on a
 * removed persona's row latch no one and post nothing.
 *
 * A `pending` row with no launch start (SRJ-513, SRJ-1020, SRJ-508,
 * SRJ-1016; AC 8, AC 68, AC 86), over the helper's launch-start rows. The
 * decision: every latching row (a `status`, a `get` and a `list` read; P's
 * current life, another `cwd` and another `config_dir` label, covered or
 * not by construction; the launch start absent, `null` or unparseable)
 * decides "launch start not recorded", "none" and `pending`, and latched
 * from it P records that with `slack_bot_<key>` and posts the row's notice
 * once; every non-latching row (a launch start recorded, another state, an
 * absent persona's, another caller's or a pre-persona row) decides nothing;
 * a row with both the note and no launch start decides the launch-start case
 * only. One pin case (the file's only literal block for this text) checks
 * SRJ-1020 word for word against the builder; the notice quotes the session,
 * points to "Operator actions", and names no session-ending command and
 * nothing of `CSCB_OWN_LINE_FORBIDDEN`; through `makeNotifierHarness` it is
 * posted as `formatPersonaNotice(persona, notice)`. Episode: three more
 * reads post nothing; P latched first on a CONFLICT, on "unusable recorded
 * name" or on a note relatches with one new post, the record replaced; a
 * not-connected notice suppresses nothing. On `makeRecoveryHarness` (both
 * settings 0), with P's row read `pending` with no launch start
 * (`readPendingNoLaunchStart`): P latches once from the collision `get` (in
 * P's `cwd` and in another), a scheduled restart's liveness read, the retry
 * timer's pending-only row read and the lost-message read; then every
 * automated path (`driveEveryPath`) makes no call for P's instance, no
 * find-missing, counts nothing and leaves no timer armed, with one SRJ-1020
 * post; such a row under a key outside the configuration latches no one.
 * The start sweep's `list` of P's own such row (in P's `cwd`, carrying the
 * note too, or in another `cwd`) latches P with the launch-start case and
 * one post, and neither the sweep nor the start pass after it makes any
 * call of P's row; a lost message then reports `held-for-human` (SRJ-116,
 * SRJ-714). A
 * CONFLICT or an UNUSABLE NAME whose latch-time `status` read finds such a
 * row leaves P latched with the launch-start case alone, one post (hatch
 * A2). A relatch through a real read (the shared own-row `status` read,
 * `readPersonaOwnRowStatus`): P latched first on a CONFLICT (at its launch)
 * or on "unusable recorded name" (at a `status` read) relatches on a read
 * of its own `pending` row with no launch start, the record replaced
 * (`launchStartRecord`), the first episode ended, one SRJ-1020 post and the
 * step's "the persona relatched" line; and P latched on the launch-start
 * case relatches on a read answering UNUSABLE NAME with one SRJ-1019 post.
 * Expected hold records come from the helper (an unusable-name row's
 * `record(key)`, `launchStartRecord(key)`), never typed here. A lost
 * message: its read of such a row latches P and reports
 * `held-for-human` with no restart; its read answering UNUSABLE NAME does
 * the same with SRJ-1019; with a launch start it reports `session-starting`;
 * with P already latched on either hold it reports `held-for-human` with no
 * read; Q reports its own state.
 *
 * The dialog approver's latches (SRJ-404, SRJ-501, SRJ-502, SRJ-512, SRJ-513;
 * SRJ-117 and SRJ-118's approver rows), on `makeRecoveryHarness` with both
 * settings 0, P's and Q's rows read `pending` with a launch start and every
 * pane showing the folder-trust dialog. Its own answer, per approver row of
 * the helper's tables (`APPROVER_CONFLICT_CASE_ROWS`: each CONFLICT its
 * `read-pane` and `send-keys` can meet, recording P's next check or recovery
 * and `pending`; `APPROVER_UNUSABLE_NAME_CASE_ROWS`: UNUSABLE NAME at its
 * `status`, `read-pane` and `send-keys`, refused operation none): the
 * approver stops `latched` with its lap's calls up to the refused one and
 * none after, P latches once through the latch's set entry (the set, the
 * three holds, one post), nothing is armed, counted or noticed, and Q's
 * approver presses Enter on its own dialog and runs on to its cap; then every
 * automated path (`driveEveryPath`) makes no call for P, tmux-touching or
 * not, with still one post, while Q's paths reach the stub as before. A latch
 * from another path (an own-row `get` of a `provenance_conflict` note, an
 * own-row `status` of a `pending` row with no launch start, a CONFLICT at a
 * new launch's plain spawn), set while P's approver sleeps between laps or
 * while its `read-pane` showing the dialog is awaited: the approver stops
 * `latched` before the clock moves (its cap is past the laps driven), no
 * Enter reaches P after the latch and no call follows over three more laps,
 * with one post; Q, unlatched, presses Enter at each of its laps.
 *
 * The latch re-check (SRJ-505; E30 T1; AC 2, 5, 7, 8, 44, 46, 71). Pure:
 * for every row of the case table (`RECHECK_TABLE`: every site kind's
 * CONFLICT rows, the live-row sequence's step-6 `resume` rows and the plain
 * spawn's rows recorded unreadable or live included, the resume and reuse
 * "this row's own id" rows once their probe is dropped, the UNUSABLE NAME,
 * launch-start and note rows),
 * `decideLatchRecheck` gives each step-1 reading's whole decision as the
 * row's `recheck` columns say, and a retired key's call; each finished-row
 * retry entry's launch is `decideFinishedRowLaunch`'s; the table holds every
 * row once and no description names "no pane 0.0". SRJ-1304's audit (E30
 * T3): every site kind has its rows and every row every re-check column;
 * every `resume` and reuse row has its `pending` (no probe, no retry, no
 * post; "conflicting labels": the one-line `read-pane`, no launch), `ended`
 * (its probe or retry) and absent (a `resume` cleared, a reuse retried)
 * entries; the plain spawn's rows, from the scan and from "duplicate
 * session", give no row the plain spawn, a finished row the reuse,
 * `pending` no retry, and another live state no retry when recorded
 * unreadable or live. On `makeRecoveryHarness`
 * with the re-check bound (`latchRecheck`), `health_check_interval` 0 and P's
 * row on the row model, one case per row: P latched by the row's `latchOn`,
 * then one round per still-latched reading and answer, each one interval
 * after the previous, makes step 1's read and exactly the row's call (the
 * probe and the lap read-pane with `n_lines` 1, the lap's with
 * `allow_pending`; the reuse with `reuse_finished`, the plain spawn without),
 * keeps the record with no post and makes no call between rounds; a last
 * round (the row's run of the restart path's decision, else its first step-1
 * clear) ends the latch and stops the timer. Named cases: the timer
 * (nothing before 120 s, one round per 120 s with the health check off, and
 * on, its ticks every 30 s between the rounds reading P only and scheduling
 * nothing; a relatch adding no timer, a fire waiting for P's serializer
 * turn, the stop at a teardown, the teardown dependencies' forget and
 * shutdown); HO rev 28
 * (a resume or reuse latch's row left `pending` by a stays-pending refusal
 * gets status only, round after round, and its probe or retry once it reads
 * `ended`; for every resume and reuse row, a gone row clears a resume latch,
 * P's next launch being the plain spawn, and retries a reuse as a fresh
 * spawn; a finished-row get reading
 * `pending` launches nothing); a round's read of a marked key's live row
 * drops its entry (E24; a retired key's retry being the reuse is
 * tests/session-manager.test.ts's); "not
 * this launch's session" from a kill, a reconnect send-keys and a read-pane
 * (status only while live, never the refused call; on `missing` the
 * finished-row resume, a no-information answer keeping the latch and the
 * leftover relatching with one post; with no row the plain first spawn,
 * whose scan refusal relatches as a plain-spawn latch); "conflicting labels"
 * (the note on a connected live row: get only; a pending row: the one-line
 * read-pane, typing nothing); a different case relatching with one post and
 * the next round following it; a latch matching no table row ("left over
 * from an earlier life" at P's next check or recovery): step 1 only, pure
 * and in one round, with one line naming the pair; a round's launch behind
 * the gates every launch path asks (b.av2 SR-6.4, SRJ-207, SRJ-810): not
 * up, held after its reuse retry met ErrInvalidFlags, or held back for an
 * old life (sequence-waiting, no timer armed), each with its line, no launch,
 * P latched and no post; AC 71 at every call kind and each finished-row
 * retry launch (each no-information
 * answer: latched, nothing started, raised, armed, fed or posted; CONFIG: one
 * `ad-config-malformed` onset; UNUSABLE NAME: a relatch with SRJ-1019's
 * post), and a step-1 read of a `pending` row with no launch start
 * relatching with SRJ-1020's post; AC 46 with the re-check bound (P's only
 * calls are its rounds' status reads, 120 s apart).
 *
 * The clear (SRJ-506, SRJ-1005, SRJ-1016, SRJ-120; E30 T2; AC 8, 42, 43, 77,
 * 85, 86). Pure: the one clear entry (`createLatchClear`) over a real latch
 * and real notice episodes, for a CONFLICT, an unusable-name and a
 * launch-start latch and every reason: one recovery post from the builders
 * (`latchRecoveryText` for the record's kind, reason and session), every
 * latch-kind episode ended (a later latch posts again), the timer stopped
 * once and one line (`latchClearedLine`, pinned once); an unlatched persona
 * and a second clear do nothing; after the episodes close nothing is posted
 * and the line says so; a throwing step is logged and the rest still runs.
 * `decideClearedProbeRetry` over every refused operation and reading, and
 * the clears that launched nothing. On `makeRecoveryHarness` with the
 * re-check bound: every step-1 clear and every launch-start finished-row
 * clear of the case table posts once with the column's reason, then (step 1
 * only) one bypassing find-missing before the next read, then the retry at
 * once, P held active meanwhile; AC 42 (a latch set live stays latched with
 * one post over every live reading) and AC 43 (the approver's "conflicting
 * labels" latch clears once the row reports in); every cadence retry that is
 * not refused, and every finished-row retry, posts nothing before it, clears
 * with one post with its reason, makes no find-missing and no second launch;
 * every cleared probe of the table is followed by one find-missing and
 * exactly one retry with P still latched, which clears with one post, but
 * for a run of the restart path's decision over a row step 1 read `pending`,
 * which leaves P latched; the find-missing refused (UNAVAILABLE, UNCLASSIFIED, CONFIG,
 * ENVIRONMENT) holds the retry back with no post, the latched answer and
 * another failure go on, a collision gives no information, a "this row's own
 * id" retry refused again drops the probe (AC 8), and a pending own-id or
 * pane-not-found resume or reuse gets nothing until its row reads ended; after
 * a step-1 clear a note the find-missing removes does not relatch, one still
 * there relatches with one post, and a refused find-missing launches nothing
 * and arms P's retry timer; a "conflicting labels" pending read-pane's GONE
 * or pane clears and arms the pending-only watch; the holds' clears (AC 77,
 * 85, 86); E18's slow-recovery episode posting again after a clear; the
 * after-clear job's ordering in P's serializer turn (a queued operation runs
 * after it, a health tick at its find-missing reads nothing of P, and P
 * latched again between the round's clear and the run it owes gets no call
 * and keeps its new latch); and
 * `runLatchClearSequence` and the builder's `clear` and `clearAndRecover`
 * (not latched, the clear before it returns, its outcomes and lines).
 *
 * The recovery harness's own overlap rule (SRJ-1304; E30 T3): two or three
 * harnesses built before any is cleaned up, cleaned up in creation order,
 * newest first or in a mixed order, leave `SLACK_STATE_DIR` and
 * `console.error` the newest live harness's after each cleanup, and what
 * was in effect before the first build once all are cleaned up.
 *
 * The lines (b.jg5 SRJ-1014), each from its exported builder: the latch-set
 * and relatch lines (`conflictLatchSetLine`, its words pinned once in the
 * relatch case); the latched gate's line at a new launch of a latched P
 * (`latchedLaunchSkipLine`); the re-check round's line naming step 1's
 * outcome and the call (`latchRecheckRoundLine`: a spawn latch's retry after
 * step 1 found no row, `step=spawn-retry`; a "not this launch's session"
 * latch's finished-row retry, `step=finished-row-retry`, HO rev 15; a read
 * with no information; a read that relatched, `step=not-decided`; a table
 * decision); the `latch-recheck:` lines (not up, a launch in flight, an
 * unresolvable claude_config_dir, a probe dropped, a collision that gives no
 * information); the `latch-clear:` lines and the cleared line, "cleared by
 * hand" among its reasons. SRJ-1002: a CONFLICT or an UNUSABLE NAME met at
 * the restart path's kill or the shared read-pane for a persona removed from
 * the applied configuration sets no latch, posts nothing, writes no
 * startup-errors entry and logs one line with `notConfiguredLatchOutcome`,
 * while a configured persona beside it latches; with no configured-persona
 * query installed, or one that throws, the removed persona latches as before.
 *
 * Pure module under test, except the recovery-harness cases: one
 * `createConflictLatch` per test over a line capture and a recording
 * observer; `afterEach` runs `assertNoLeak` over every line, event and record
 * captured, over every notice post and over each harness's `captured()`,
 * then cleans the harness up (which throws on a pending timer, or on a
 * re-check round or after-clear job still in flight) and resets the
 * health check. The notice cases build `createPersonaEpisodes` over
 * `createFakeClock` with a recording sink; `afterEach` checks no timer is
 * pending and clears the session-manager notifier and its not-connected
 * latch. No `mock.module()`.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  UNUSABLE_RECORDED_NAME_PHRASE,
  CONFLICT_ANOTHER_STORE_PHRASE,
  CONFLICT_CONFLICTING_LABELS_PHRASE,
  CONFLICT_DIFFERENT_ID_PHRASE,
  CONFLICT_LEFTOVER_PHRASE,
  CONFLICT_NEVER_REPORTED_IN_PHRASE,
  CONFLICT_NO_VALID_ID_PHRASE,
  CONFLICT_NOT_THIS_LAUNCH_PHRASE,
  CONFLICT_OWN_ID_PHRASE,
  CONFLICT_PANE_NOT_FOUND_PHRASE,
  NEVER_DELETE_ROW_PHRASE,
  NEW_ROW_ENDED_PHRASE,
  NO_KILL_SENT_PHRASE,
  NOTHING_WRITTEN_PHRASE,
  PANE_NOT_ADOPTED_PHRASE,
  PLAIN_SPAWN_LABEL_NAMES_THIS_ID_PHRASE,
  PLAIN_SPAWN_LABEL_NOT_THIS_ID_PHRASE,
  RETRY_KILL_LATER_PHRASE,
} from '../src/ad-description-phrases.ts'
import { adAlertThresholdMsInEffect, adLaunchBoundMsInEffect } from '../src/ad-settings.ts'
import type { Phase1GetResult, Phase1ListRow } from '../src/ad-phase1-types.ts'
import { ERR_TMUX_SESSION_CONFLICT_NAME } from '../src/agent-director-errors.ts'
import {
  CONFLICT_CASE_ORDER,
  CONFLICT_CASE_SENTENCES,
  CONFLICT_LATCH_SET_LATCHED,
  CONFLICT_LATCH_SET_RELATCHED,
  CONFLICT_LATCH_SET_SAME_CASE,
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
  CONFLICT_RECOVERY_HEAD,
  CONFLICT_RECOVERY_REASON_LEAD,
  HOLD_LATCH_CASES,
  HOLD_RECOVERY_HEAD,
  LATCH_CASES,
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
  LATCH_KIND_CONFLICT,
  LATCH_KIND_HOLD,
  LATCH_RECOVERY_REASON_CLEARED_BY_HAND,
  LATCH_RECOVERY_REASON_KIND_CLEARED_BY_HAND,
  LATCH_RECOVERY_REASON_KIND_ROW_READS,
  LATCH_NOTICE_EPISODE_KINDS,
  LATCH_RECOVERY_REASON_RELAUNCH_NOT_REFUSED,
  LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED,
  LATCH_RECOVERY_REASON_ROW_GONE,
  LATCH_RECOVERY_REASON_ROW_READS_HEAD,
  LATCH_RECOVERY_REASON_TEXTS,
  LATCH_RECOVERY_TAIL,
  LATCH_ROW_STATE_KIND_READ,
  LAUNCH_START_NOTICE_POINTER,
  LATCH_ROW_STATE_KIND_NO_ROW,
  LATCH_ROW_STATE_NO_ROW,
  LATCH_ROW_STATE_UNREADABLE,
  REFUSED_OPERATION_BRING_UP,
  REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY,
  REFUSED_OPERATION_NONE,
  REFUSED_OPERATION_PLAIN_SPAWN,
  REFUSED_OPERATION_RESUME,
  REFUSED_OPERATION_REUSE_SPAWN,
  LATCH_RECHECK_INTERVAL_MS,
  RECHECK_CALL_FINISHED_ROW,
  RECHECK_CALL_NONE,
  RECHECK_CALL_PENDING_READ_PANE,
  RECHECK_CALL_PLAIN_SPAWN,
  RECHECK_CALL_PROBE,
  RECHECK_CALL_RESTART_DECISION,
  RECHECK_CALL_RESUME,
  RECHECK_CALL_REUSE_SPAWN,
  RECHECK_CLEARED_BY_FINISHED_ROW_RETRY,
  RECHECK_CLEARED_BY_LAUNCH_START_FINISHED,
  RECHECK_CLEARED_BY_PENDING_READ_PANE,
  RECHECK_CLEARED_BY_RESTART_DECISION,
  RECHECK_CLEARED_BY_RETRY,
  RECHECK_CLEARED_BY_STEP_1,
  RECHECK_CLEARS_THAT_LAUNCHED_NOTHING,
  RECHECK_ACTION_NONE,
  RECHECK_READING_FAILED_VALUE,
  RECHECK_READING_NO_ROW_VALUE,
  RECHECK_READING_STATE,
  RECHECK_LINE_STEP_NOT_DECIDED,
  RECHECK_STEP_CLEAR_GONE,
  RECHECK_STEP_FINISHED_ROW_RETRY,
  RECHECK_STEP_NO_INFORMATION,
  RECHECK_STEP_SPAWN_RETRY,
  RECHECK_STEP_TABLE,
  conflictLatchSetLine,
  createLatchClear,
  latchRecheckRoundLine,
  notConfiguredLatchOutcome,
  type LatchRecheckLineStep,
  decideClearedProbeRetry,
  latchClearedLine,
  type LatchClear,
  type LatchRecheckReading,
  decideFinishedRowLaunch,
  decideLatchRecheck,
  type LatchRecheckCall,
  UNUSABLE_NAME_NOTICE_HEAD,
  UNUSABLE_NAME_NOTICE_REASON,
  bindConflictLatchHolds,
  bindConflictNotice,
  conflictCaseSentence,
  conflictNoticeText,
  conflictRecoveryText,
  conflictSessionName,
  createConflictLatch,
  holdRecoveryText,
  isHoldLatchCase,
  latchKindOf,
  latchRecoveryReasonRowReads,
  latchRecoveryReasonText,
  latchRecoveryText,
  latchRowStateRead,
  launchStartNotRecordedNoticeText,
  launchStartNotRecordedSetInput,
  recogniseConflictCase,
  rowStateCountsAsLive,
  takesUnrecognisedHandling,
  isUnusableNameError,
  unusableNameNoticeText,
  unusableNameSetInput,
  type ConflictLatch,
  type ConflictLatchCase,
  type ConflictLatchConflictFields,
  type ConflictLatchHolds,
  type ConflictLatchRecord,
  type ConflictLatchSetEvent,
  type ConflictLatchSetInput,
  type LatchCase,
  type LatchKind,
  type LatchRecoveryReason,
  type LatchRowState,
} from '../src/conflict-latch.ts'
import { invalidFlagsHeldNoLaunchLine } from '../src/invalid-flags-hold.ts'
import {
  LIVE_ROW_OUTCOME_ABORTED,
  LIVE_ROW_OUTCOME_LAUNCHED,
  LIVE_ROW_OUTCOME_STOPPED,
  LIVE_ROW_SEQUENCE_ENTRY_GET,
  LIVE_ROW_START_STARTED,
  LIVE_ROW_SEQUENCE_LOG_PREFIX,
  LIVE_ROW_STOP_LATCHED,
  liveRowSequenceStopAskedLine,
} from '../src/live-row-sequence.ts'
import {
  AGENT_DIRECTOR_DEAD_STATES,
  AGENT_DIRECTOR_LIVE_STATES,
  AGENT_DIRECTOR_PENDING_STATE,
  LIVENESS_DEAD_ROW_ENDED,
  LIVENESS_DEAD_ROW_MISSING,
  LIVENESS_READING_DEAD_ENDED,
} from '../src/liveness-reading.ts'
import { killOutcomeOf } from '../src/checked-kill.ts'
import { describeThrownValue, MAX_LOGGED_MESSAGE_LENGTH, renderLogMessageText } from '../src/persona-connection-errors.ts'
import { adConfigMalformedOnset, getOutageFlags, type OutageClass } from '../src/outage-state.ts'
import { classifyAdError } from '../src/ad-error-class.ts'
import { CLEAR_LATCH_ROUTE, handleClearLatch } from '../src/clear-latch.ts'
import {
  STUCK_LAUNCH_ALREADY_POSTED,
  STUCK_LAUNCH_END_LATCHED,
  STUCK_LAUNCH_POSTED,
  parseLaunchStart,
  postStuckLaunchHeld,
  postStuckLaunchRelaunching,
  stuckLaunchEpisodeEndedLine,
  stuckLaunchHeldText,
  stuckLaunchRelaunchingText,
  type StuckLaunchPosterDeps,
} from '../src/pending-row.ts'
import { formatPersonaNotice } from '../src/persona-notifier.ts'
import {
  createPersonaEpisodes,
  PERSONA_EPISODE_KIND_CONFLICT,
  PERSONA_EPISODE_KIND_LAUNCH_START_NOT_RECORDED,
  PERSONA_EPISODE_KIND_SLOW_DEAD_SESSION_RECOVERY,
  PERSONA_EPISODE_KIND_STUCK_LAUNCH,
  PERSONA_EPISODE_KIND_UNUSABLE_RECORDED_NAME,
  TMUX_UNRESPONSIVE_END_LATCHED,
  UNCLASSIFIED_ERROR_END_LATCHED,
  type PersonaEpisodeKind,
  type PersonaEpisodes,
} from '../src/persona-episodes.ts'
import { personaInstanceId, personaTmuxSessionName, renderPersonaRef } from '../src/persona-identity.ts'
import type { PersonaSerialize, PersonaSerializer } from '../src/persona-serializer.ts'
import { forgetFailures, getFailureCount, isAtCap } from '../src/backoff.ts'
import { _resetHealthCheckState, initHealthCheck, startHealthCheck, stopHealthCheck } from '../src/health-check.ts'
import {
  holdRestartActive,
  isRestartPendingOrActive,
  RESTART_FAILURE_CAP,
  RESTART_OUTCOME_CAPPED,
  RESTART_OUTCOME_LATCHED,
  RESTART_OUTCOME_LAUNCHED,
  RESTART_OUTCOME_PENDING_DEFERRED,
  RESTART_OUTCOME_RECONNECT_DEFERRED,
  restartRetryCapSkippedLine,
  runRestartRetry,
  scheduleRestart,
} from '../src/restart.ts'
import {
  SLOW_RECOVERY_POST_THRESHOLD,
  SLOW_RECOVERY_RESET_LATCHED,
  slowRecoveryCountResetLine,
  slowRecoveryEpisodeEndedLine,
  slowRecoveryText,
} from '../src/slow-recovery.ts'
import { _buildIsSessionAliveAdapter } from '../src/server.ts'
import { decideOwnRowRead, ROW_READ_LAUNCH_START_NOT_RECORDED, ROW_READ_NO_DECISION, type RowReadRow } from '../src/row-read-rules.ts'
import {
  APPROVER_STOP_CAP,
  APPROVER_STOP_LATCHED,
  DIALOG_POLL_INTERVAL_MS,
  TRUST_DIALOG_NEEDLE,
  _resetNotConnectedEpisodes,
  isLaunchInFlight,
  notifyPersonaNotConnected,
  OWN_ROW_READ_ROW,
  OWN_ROW_STATUS_LATCHED,
  OWN_ROW_STATUS_STATE,
  latchedNoArmPendingRowLine,
  readPersonaOwnRow,
  readPersonaOwnRowStatus,
  reconcileOrphans,
  setSessionNotifier,
  SPAWN_ACTION_RETRYING,
  LATCH_CLEAR_SEQUENCE_FIND_MISSING_REFUSED,
  LATCH_CLEAR_SEQUENCE_NOT_APPLIED,
  LATCH_CLEAR_SEQUENCE_NOT_LATCHED,
  LATCH_CLEAR_SEQUENCE_RETRIED,
  LATCH_CLEAR_SEQUENCE_RETRY_FAILED,
  latchClearClearFailedLine,
  latchClearFindMissingRefusedLine,
  latchClearNotAppliedLine,
  latchClearNotRunInTurnLine,
  latchClearRelatchedAfterFindMissingLine,
  latchClearRelatchedBeforeRunLine,
  latchClearRetryAnsweredLine,
  latchClearRetryAtOnceLineHead,
  latchClearRetryFailedLine,
  latchClearRunFailedLine,
  LATCH_RECHECK_AT_CAP,
  latchRecheckAtCapLine,
  latchRecheckCollisionNoInformationLine,
  latchRecheckConfigDirLine,
  latchRecheckLaunchInFlightLine,
  latchRecheckNotUpLine,
  latchRecheckProbeDroppedLine,
  latchRecheckUnmatchedLine,
  latchedLaunchSkipLine,
  latchOnRestartKillOutcome,
  latchEntryQueryFailedLine,
  readPersonaOwnPane,
  setStuckLaunchEpisodes,
  COLLISION_GET_SITE,
  _resetConfigDirFs,
  _resetConfiguredPersonaQuery,
  _setConfigDirFs,
  setConfiguredPersonaQuery,
  oldLifeHoldLaunchLine,
  runLatchClearSequence,
  sweepDeadTmuxChannel,
  ESCALATE_DEAD_WAITING_ROW_PANE_GONE,
  type LatchClearSequenceDeps,
  type ApproverVerb,
  type NotConnectedNotice,
  type OwnRowReadSite,
} from '../src/session-manager.ts'
import {
  UNAVAILABLE_RETRY_CAUSE_PENDING_ROW,
  UNAVAILABLE_RETRY_CAUSE_READ_ERROR,
  UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE,
  UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED,
  UNAVAILABLE_RETRY_CEILING_S,
  UNAVAILABLE_RETRY_MODE_PENDING_ONLY,
  UNAVAILABLE_RETRY_STOP_LATCHED,
} from '../src/unavailable-retry.ts'
import { REDACTED_TOKEN_PLACEHOLDER } from '../src/slack-log-redaction.ts'
import { escapeSlackControlCharacters } from '../src/slack-text-escape.ts'
import {
  CONFLICT_CASES,
  cannedFindMissing,
  cannedGetResult,
  cannedListRow,
  cannedOk,
  cannedStatusResult,
  errGeneric,
  errCallTimeout,
  errInvalidFlags,
  errConfigMalformed,
  errInstanceIdCollision,
  errTmuxNotAvailable,
  errInternal,
  errNoSessionId,
  errSpawnNotFound,
  errSpawnNotResumable,
  errSystemInstallDisappeared,
  errTmuxCaptureFailed,
  errTmuxSendKeys,
  errTmuxSessionConflict,
  errTmuxUnresponsive,
  errUnknownErrorName,
  nonLatchingNotes,
  provenanceNote,
  SAMPLE_LAUNCH_START_DEFAULT,
  SAMPLE_LAUNCH_START_NONE,
  SAMPLE_LAUNCH_START_WHOLE,
  STUB_TMUX_SESSION_NAME,
  UNUSABLE_NAME_FAULTS,
  errUnusableName,
  holdFindMissing,
  holdSpawns,
  unknownNote,
  type CannedRowPersona,
  type UnusableNameFault,
} from './test-helpers/agent-director-stub.ts'
import {
  APPROVER_CONFLICT_CASE_ROWS,
  APPROVER_SITES,
  APPROVER_UNUSABLE_NAME_CASE_ROWS,
  APPROVER_VERB_CALLS,
  CONFLICT_CASE_ROWS,
  FINISHED_ROW_RETRY_ENTRIES,
  NOTE_LATCH_CASE_ROWS,
  PLAIN_SPAWN_CONFLICT_CASE_ROWS,
  PLAIN_SPAWN_LATCH_TIME_ROW_STATES,
  PLAIN_SPAWN_RECORDED_LIVE_CASE_ROWS,
  SEQUENCE_RESUME_CONFLICT_CASE_ROWS,
  SEQUENCE_RESUME_SITE,
  LIVENESS_PANE_SITES,
  PROMPT_ROW_PANE_SITES,
  RECONNECT_SITE,
  RESTART_KILL_SITE,
  REUSE_SPAWN_SITE,
  SEQUENCE_KILL_SITES,
  STUCK_LAUNCH_ABORT_SITE,
  UNUSABLE_NAME_SITES,
  recheckEntryAt,
  recheckNoInformationAnswers,
  RECHECK_CONFIG_ANSWER,
  RECHECK_GONE_ANSWER,
  RECHECK_PANE_ANSWER,
  RECHECK_UNUSABLE_NAME_ANSWER,
  recheckPaneConflictAnswer,
  type FinishedRowRetryEntry,
  type RecheckReadingName,
  type RecheckAnswer,
  type RecheckColumns,
  type RecheckEntry,
  type RecheckLatchEntries,
  LAUNCH_START_ABSENT_PERSONA_KEY,
  LAUNCH_START_AND_NOTE_ROW,
  LAUNCH_START_ANOTHER_CALLERS_ID,
  LAUNCH_START_CASE_ROWS,
  LAUNCH_START_NON_LATCHING_ROWS,
  SEQUENCE_STEP1_KILL_SITE,
  RESTART_KILL_CONFLICT_CASE_ROWS,
  RESTART_KILL_UNUSABLE_NAME_CASE_ROWS,
  REUSE_SPAWN_CONFLICT_CASE_ROWS,
  REUSE_SPAWN_UNUSABLE_NAME_CASE_ROWS,
  SEQUENCE_KILL_CONFLICT_CASE_ROWS,
  SEQUENCE_KILL_STEP,
  SEQUENCE_KILL_UNUSABLE_NAME_CASE_ROWS,
  sequenceKillConflictRowsAt,
  SESSION_ENDING_COMMAND_FORMS,
  UNPARSEABLE_LAUNCH_START,
  UNUSABLE_NAME_CASE_ROWS,
  cscbOwnLineForbiddenIn,
  cscbOwnLines,
  cscbOwnText,
  expectedConflictNotice,
  expectedLatchRecord,
  isApproverSite,
  launchStartRecord,
  livenessPaneConflictRowsAt,
  reconnectConflictRowsAt,
  reconnectUnusableNameRowsAt,
  sessionEndingCommandsIn,
  tmuxTouchingCallCounts,
  tmuxTouchingCallsIn,
  type ConflictCaseRow,
  type LaunchStartCaseRow,
  type SequenceKillSite,
  type UnusableNameCaseRow,
  type UnusableNameSite,
} from './test-helpers/conflict-cases.ts'
import {
  BOT_TOKEN_PREFIX,
  LEAK_SENTINEL,
  REDACTED_SENTINEL_TAIL,
  assertNoLeak,
  fakeToken,
  sentinelInMessage,
} from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { builtAround, lineParts } from './test-helpers/line-parts.ts'
import { PRE_PERSONA_ID, PRE_PERSONA_LABELS, holdOldAt } from './test-helpers/old-life.ts'
import { posts } from './test-helpers/permission-relay-harness.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { makeNotifierHarness } from './test-helpers/persona-notifier.ts'
import {
  callCounts,
  callCountsSince,
  callsBeforeSequenceKill,
  collided,
  conditionEndedLine,
  conditionRecoveryLine,
  expectLostMessageReports,
  expectPendingOnlyWatch,
  killFailureLines,
  makeRecoveryHarness,
  pastSampleGrace,
  personaCallCounts,
  personaOf,
  personaRow,
  putAtRestartCap,
  recheckAtCapLinesOf,
  recordCallOrder,
  reuseSpawnOf,
  retryNow,
  scriptSequenceKillFailure,
  startSequenceHeldAtRun,
  unclassifiedEndedLine,
  unclassifiedLines,
  unclassifiedStartedLine,
  type RecoveryHarness,
  type RecoveryHarnessOptions,
  type RecoveryStubScript,
  type RecoveryStubVerb,
  type RecoveryTimedCall,
} from './test-helpers/recovery-harness.ts'
import {
  makePendingRowModel,
  pendingRowOfRecheckReading,
  restoreRefusal,
  scanRefusal,
  PENDING_ROW_DIALOG_NONE,
  PENDING_ROW_DIALOG_TRUST,
  PENDING_ROW_FIND_MISSING_REMOVES_NOTE,
  PENDING_ROW_FIND_MISSING_REMOVES_NOTHING,
  PENDING_ROW_MODEL_NO_ROW,
  PENDING_ROW_RESTORE_STAYS_PENDING,
  type PendingRowLaunchAnswer,
  type PendingRowModel,
  type PendingRowModelOptions,
} from './test-helpers/pending-row-model.ts'
import { PROBE_PANE_READ_LINES } from '../src/pane-read.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The persona latched in most cases; its own session differs from the stub's quoted one. */
const KEY = 'alpha'
/** A second persona. */
const OTHER = 'beta'

interface LatchRun {
  readonly latch: ConflictLatch
  readonly lines: string[]
  readonly events: ConflictLatchSetEvent[]
}

/** Every run of this test, leak-checked in `afterEach`. */
let runs: LatchRun[] = []

/** One latch over a line capture and a recording set observer. */
function makeLatchRun(): LatchRun {
  const lines: string[] = []
  const events: ConflictLatchSetEvent[] = []
  const latch = createConflictLatch({ log: (line) => lines.push(line) })
  latch.addSetObserver((event) => {
    events.push(event)
  })
  const run = { latch, lines, events }
  runs.push(run)
  return run
}

afterEach(() => {
  const captured = runs.map((run) => ({
    lines: run.lines,
    events: run.events,
    records: [KEY, OTHER].map((key) => run.latch.record(key)),
  }))
  runs = []
  assertNoLeak(captured)
})

/** `test.each` rows over the case table: the row name, then the row. */
const ROWS = CONFLICT_CASE_ROWS.map((row) => [row.name, row] as const)

/** The `ended` row state. */
const ENDED = latchRowStateRead('ended')

/** A row's description, as the stub builds it. */
const descriptionOf = (row: ConflictCaseRow): string => row.build().errDescription

/** Latch `key` on a row's error with the row's refused operation and row state. */
function latchOnRow(latch: ConflictLatch, key: string, row: ConflictCaseRow, rowState: LatchRowState = row.rowState) {
  return latch.setFromConflict(key, row.build(), { refusedOperation: row.refusedOperation, rowState })
}

/** The first table row matching `pred`; throws when none does, so a case never runs on nothing. */
function rowWhere(pred: (row: ConflictCaseRow) => boolean): ConflictCaseRow {
  const found = CONFLICT_CASE_ROWS.find(pred)
  if (found === undefined) throw new Error('no case-table row matches')
  return found
}

/**
 * The first table row matching `pred` (`rowWhere`), looked up when a case
 * first asks for it, never at collection: a lookup that matches nothing
 * fails only the cases that use it, not the whole file.
 */
function lazyRow(pred: (row: ConflictCaseRow) => boolean): () => ConflictCaseRow {
  let found: ConflictCaseRow | undefined
  return () => (found ??= rowWhere(pred))
}

/** The case-phrase entries of `CONFLICT_CASE_ORDER` a description carries, in that order. */
const casePhrasesIn = (description: string) => CONFLICT_CASE_ORDER.filter((entry) => description.includes(entry.phrase))

/** The two cases whose description points to no "Operator actions" (ADSRD SR-1.4; SRJ-1004). */
const NO_POINTER_CASES: ReadonlySet<string> = new Set([LATCH_CASE_DIFFERENT_ID, LATCH_CASE_ANOTHER_STORE])

/**
 * The "Operator actions" section title, read from the stub: the one quoted
 * text, other than the session, that every pointing description carries.
 */
function operatorActionsTitle(): string {
  const quotedTexts = (row: ConflictCaseRow): Set<string> =>
    new Set(Array.from(descriptionOf(row).matchAll(/"([^"]+)"/g), (m) => m[1]).filter((t) => t !== row.sessionName))
  const pointing = CONFLICT_CASE_ROWS.filter((row) => !NO_POINTER_CASES.has(row.latchCase)).map(quotedTexts)
  const common = [...pointing[0]].filter((text) => pointing.every((texts) => texts.has(text)))
  if (common.length !== 1) throw new Error(`expected one shared quoted title, found ${common.length}`)
  return common[0]
}

// ---------------------------------------------------------------------------
// Recognition (SRJ-507, SRJ-1303)
// ---------------------------------------------------------------------------

describe('case recognition', () => {
  test('the case table covers every stub CONFLICT case', () => {
    expect(new Set(CONFLICT_CASE_ROWS.map((row) => row.stubCase))).toEqual(new Set(CONFLICT_CASES))
  })

  test.each(ROWS)('%s resolves to its case', (_name, row) => {
    expect(recogniseConflictCase(descriptionOf(row))).toBe(row.latchCase)
  })

  test('each description carrying two or three case phrases takes the first in the order', () => {
    const multi = CONFLICT_CASE_ROWS.filter((row) => casePhrasesIn(descriptionOf(row)).length >= 2)
    expect(new Set(multi.map((row) => row.latchCase))).toEqual(
      new Set([LATCH_CASE_PANE_NOT_FOUND, LATCH_CASE_NOT_THIS_LAUNCH, LATCH_CASE_NEVER_REPORTED_IN]),
    )
    for (const row of multi) {
      const carried = casePhrasesIn(descriptionOf(row))
      expect(recogniseConflictCase(descriptionOf(row))).toBe(carried[0].latchCase)
      expect(carried.map((entry) => entry.latchCase)).toContain(LATCH_CASE_OWN_ID)
    }
  })

  test('the scan\'s and the duplicate-session leftover descriptions both resolve to the leftover case; only the latter carries the label wording', () => {
    const plainLeftover = (scanned: boolean) =>
      descriptionOf(rowWhere((row) =>
        row.refusedOperation === REFUSED_OPERATION_PLAIN_SPAWN &&
        row.latchCase === LATCH_CASE_LEFTOVER &&
        (row.rowState === LATCH_ROW_STATE_NO_ROW) === scanned))
    const duplicate = plainLeftover(false)
    const scan = plainLeftover(true)
    expect(duplicate.includes(PLAIN_SPAWN_LABEL_NAMES_THIS_ID_PHRASE)).toBe(true)
    expect(scan.includes(PLAIN_SPAWN_LABEL_NAMES_THIS_ID_PHRASE)).toBe(false)
    expect([recogniseConflictCase(duplicate), recogniseConflictCase(scan)]).toEqual([LATCH_CASE_LEFTOVER, LATCH_CASE_LEFTOVER])
  })

  test('the another-store descriptions from a resume, a reuse and a plain spawn resolve to the another-store case', () => {
    const rows = CONFLICT_CASE_ROWS.filter((row) => descriptionOf(row).includes(CONFLICT_ANOTHER_STORE_PHRASE))
    expect(new Set(rows.map((row) => row.refusedOperation))).toEqual(
      new Set([REFUSED_OPERATION_RESUME, REFUSED_OPERATION_REUSE_SPAWN, REFUSED_OPERATION_PLAIN_SPAWN]),
    )
    expect(rows.map((row) => recogniseConflictCase(descriptionOf(row)))).toEqual(rows.map(() => LATCH_CASE_ANOTHER_STORE))
  })

  test('the never-reported-in description, which also carries the own-id phrase, resolves to its own case and takes unrecognised handling', () => {
    const description = descriptionOf(rowWhere((row) => row.latchCase === LATCH_CASE_NEVER_REPORTED_IN))
    expect(description.includes(CONFLICT_OWN_ID_PHRASE)).toBe(true)
    expect(recogniseConflictCase(description)).toBe(LATCH_CASE_NEVER_REPORTED_IN)
    expect(takesUnrecognisedHandling(LATCH_CASE_NEVER_REPORTED_IN)).toBe(true)
  })

  const PAIRS = CONFLICT_CASE_ORDER.flatMap((first, i) =>
    CONFLICT_CASE_ORDER.slice(i + 1).map((later) => [first.latchCase, later.latchCase, first.phrase, later.phrase] as const),
  )

  test.each(PAIRS)('%s wins over %s in either textual order', (firstCase, _laterCase, firstPhrase, laterPhrase) => {
    expect(recogniseConflictCase(`${firstPhrase}; ${laterPhrase}`)).toBe(firstCase)
    expect(recogniseConflictCase(`${laterPhrase}; ${firstPhrase}`)).toBe(firstCase)
  })

  test('the exported order is SRJ-507\'s, each case on its own phrase, with "no pane 0.0" absent', () => {
    // The file's only literal block: SRJ-507's case words, in its order.
    expect(CONFLICT_CASE_ORDER.map((entry) => entry.phrase)).toEqual([
      'conflicting labels',
      "the agent's pane was not found",
      "not this launch's session",
      'left over from an earlier life',
      'never reported in',
      "this row's own id",
      'no valid instance id',
      'a different instance id',
      'another agent-director store',
    ])
    expect(recogniseConflictCase('no pane 0.0')).toBe(LATCH_CASE_UNRECOGNISED)
    expect(CONFLICT_CASE_ORDER.map((entry) => [entry.latchCase, entry.phrase])).toEqual([
      [LATCH_CASE_CONFLICTING_LABELS, CONFLICT_CONFLICTING_LABELS_PHRASE],
      [LATCH_CASE_PANE_NOT_FOUND, CONFLICT_PANE_NOT_FOUND_PHRASE],
      [LATCH_CASE_NOT_THIS_LAUNCH, CONFLICT_NOT_THIS_LAUNCH_PHRASE],
      [LATCH_CASE_LEFTOVER, CONFLICT_LEFTOVER_PHRASE],
      [LATCH_CASE_NEVER_REPORTED_IN, CONFLICT_NEVER_REPORTED_IN_PHRASE],
      [LATCH_CASE_OWN_ID, CONFLICT_OWN_ID_PHRASE],
      [LATCH_CASE_NO_VALID_ID, CONFLICT_NO_VALID_ID_PHRASE],
      [LATCH_CASE_DIFFERENT_ID, CONFLICT_DIFFERENT_ID_PHRASE],
      [LATCH_CASE_ANOTHER_STORE, CONFLICT_ANOTHER_STORE_PHRASE],
    ])
  })

  test.each([
    [PLAIN_SPAWN_LABEL_NAMES_THIS_ID_PHRASE],
    [PLAIN_SPAWN_LABEL_NOT_THIS_ID_PHRASE],
    [NEW_ROW_ENDED_PHRASE],
    [NOTHING_WRITTEN_PHRASE],
    [PANE_NOT_ADOPTED_PHRASE],
    [NO_KILL_SENT_PHRASE],
    [''],
    [undefined],
  ] as const)('%p alone is no case: unrecognised text', (text) => {
    expect(recogniseConflictCase(text)).toBe(LATCH_CASE_UNRECOGNISED)
  })

  test('no different-id or another-store description, in any variant, carries the Operator actions section title', () => {
    const title = operatorActionsTitle()
    const noPointer = CONFLICT_CASE_ROWS.filter((row) => NO_POINTER_CASES.has(row.latchCase))
    expect(new Set(noPointer.map((row) => row.refusedOperation))).toEqual(
      new Set([REFUSED_OPERATION_RESUME, REFUSED_OPERATION_REUSE_SPAWN, REFUSED_OPERATION_PLAIN_SPAWN]),
    )
    expect(noPointer.filter((row) => descriptionOf(row).includes(title)).map((row) => row.name)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The record (SRJ-501)
// ---------------------------------------------------------------------------

describe('the latch record', () => {
  test.each(ROWS)('%s: latching records the quoted session, the case, the refused operation and the row state', (_name, row) => {
    const run = makeLatchRun()
    expect(latchOnRow(run.latch, KEY, row)).toBe(CONFLICT_LATCH_SET_LATCHED)
    expect(run.latch.isLatched(KEY)).toBe(true)
    expect(run.latch.record(KEY)).toMatchObject({
      sessionName: row.sessionName,
      latchCase: row.latchCase,
      refusedOperation: row.refusedOperation,
      rowState: row.rowState,
    })
    expect(run.events.map((event): unknown[] => [event.key, event.outcome, event.record])).toEqual([
      [KEY, CONFLICT_LATCH_SET_LATCHED, run.latch.record(KEY)],
    ])
  })

  test('the quoted session is the first double-quoted name; with none it is the persona\'s own slack_bot_<key>', () => {
    const quoted = personaTmuxSessionName(OTHER)
    const second = STUB_TMUX_SESSION_NAME
    expect(conflictSessionName(`${JSON.stringify(quoted)} then ${JSON.stringify(second)}`, KEY)).toBe(quoted)
    expect(conflictSessionName(CONFLICT_OWN_ID_PHRASE, KEY)).toBe(personaTmuxSessionName(KEY))
    expect(conflictSessionName(undefined, KEY)).toBe(personaTmuxSessionName(KEY))

    const run = makeLatchRun()
    const noName = errGeneric('resume', ERR_TMUX_SESSION_CONFLICT_NAME, CONFLICT_OWN_ID_PHRASE)
    run.latch.setFromConflict(KEY, noName, { refusedOperation: REFUSED_OPERATION_RESUME, rowState: LATCH_ROW_STATE_NO_ROW })
    expect(run.latch.record(KEY)?.sessionName).toBe(personaTmuxSessionName(KEY))
    run.latch.set(OTHER, { latchCase: LATCH_CASE_OWN_ID, refusedOperation: REFUSED_OPERATION_RESUME, rowState: LATCH_ROW_STATE_NO_ROW })
    expect(run.latch.record(OTHER)?.sessionName).toBe(personaTmuxSessionName(OTHER))
  })

  test('an empty quoted span is skipped whole: its closing quote never opens the next span', () => {
    const name = STUB_TMUX_SESSION_NAME
    expect(conflictSessionName(`a "" then ${JSON.stringify(name)}`, KEY)).toBe(name)
    expect(conflictSessionName(`"" "" then ${JSON.stringify(name)}`, KEY)).toBe(name)
    expect(conflictSessionName(`a "" then ""`, KEY)).toBe(personaTmuxSessionName(KEY))

    const run = makeLatchRun()
    const description = `${CONFLICT_OWN_ID_PHRASE} "" then ${JSON.stringify(name)}`
    run.latch.setFromConflict(KEY, errGeneric('resume', ERR_TMUX_SESSION_CONFLICT_NAME, description), {
      refusedOperation: REFUSED_OPERATION_RESUME,
      rowState: LATCH_ROW_STATE_NO_ROW,
    })
    expect(run.latch.record(KEY)?.sessionName).toBe(name)
  })

  test.each([
    ['a newline', '\n'],
    ['a carriage return', '\r'],
    ['a CRLF', '\r\n'],
    ['a line separator', '\u2028'],
    ['a paragraph separator', '\u2029'],
  ])('a quoted span broken by %s is skipped whole: its closing quote never opens the next span', (_name, lineBreak) => {
    const name = STUB_TMUX_SESSION_NAME
    const broken = `"${personaTmuxSessionName(OTHER)}${lineBreak}${name}"`
    expect(conflictSessionName(`a ${broken} then ${JSON.stringify(name)}`, KEY)).toBe(name)
    expect(conflictSessionName(`a ${broken} then "" then ${JSON.stringify(name)}`, KEY)).toBe(name)
    expect(conflictSessionName(`a ${broken} then ${broken}`, KEY)).toBe(personaTmuxSessionName(KEY))
    expect(conflictSessionName(`a ${broken} then ""`, KEY)).toBe(personaTmuxSessionName(KEY))
  })

  test.each([
    ['waiting', latchRowStateRead('waiting'), true],
    ['unreadable', LATCH_ROW_STATE_UNREADABLE, true],
    ['an unsafe state (recorded unreadable)', latchRowStateRead(`waiting ${CONFLICT_OWN_ID_PHRASE}`), true],
    ['pending', latchRowStateRead(AGENT_DIRECTOR_PENDING_STATE), false],
    ['ended', ENDED, false],
    ['no row', LATCH_ROW_STATE_NO_ROW, false],
  ] as const)('a latch met with the row %s records a state that counts as live: %p', (_label, rowState, live) => {
    const run = makeLatchRun()
    latchOnRow(run.latch, KEY, rowWhere((row) => row.verb === 'kill' && row.latchCase === LATCH_CASE_NOT_THIS_LAUNCH), rowState)
    const recorded = run.latch.record(KEY)?.rowState
    expect(recorded).toBeDefined()
    expect(rowStateCountsAsLive(recorded as LatchRowState)).toBe(live)
  })

  test('every live state but pending, and any state CSCB does not know, counts as live; pending and the dead states do not', () => {
    const live = [...AGENT_DIRECTOR_LIVE_STATES].filter((state) => state !== AGENT_DIRECTOR_PENDING_STATE)
    const notLive = [AGENT_DIRECTOR_PENDING_STATE, ...AGENT_DIRECTOR_DEAD_STATES]
    expect(live.map((state) => rowStateCountsAsLive(latchRowStateRead(state)))).toEqual(live.map(() => true))
    expect(notLive.map((state) => rowStateCountsAsLive(latchRowStateRead(state)))).toEqual(notLive.map(() => false))
    expect(rowStateCountsAsLive(latchRowStateRead('stopping'))).toBe(true)
    expect(latchRowStateRead(42)).toBe(LATCH_ROW_STATE_UNREADABLE)
  })

  test('the description is kept redacted, on one line and capped; a token-shaped quoted name is redacted', () => {
    const run = makeLatchRun()
    const long = `${CONFLICT_OWN_ID_PHRASE} (${sentinelInMessage('d')})\n${NO_KILL_SENT_PHRASE} ${'x'.repeat(MAX_LOGGED_MESSAGE_LENGTH)}`
    run.latch.setFromConflict(KEY, errGeneric('resume', ERR_TMUX_SESSION_CONFLICT_NAME, long), {
      refusedOperation: REFUSED_OPERATION_RESUME,
      rowState: LATCH_ROW_STATE_NO_ROW,
    })
    const description = run.latch.record(KEY)?.description ?? ''
    expect(description.startsWith(`${CONFLICT_OWN_ID_PHRASE} (${REDACTED_SENTINEL_TAIL}) ${NO_KILL_SENT_PHRASE}`)).toBe(true)
    expect(description.length).toBeLessThanOrEqual(MAX_LOGGED_MESSAGE_LENGTH)

    const ownId = rowWhere((row) => row.latchCase === LATCH_CASE_OWN_ID)
    const tokenSession = errTmuxSessionConflict(ownId.verb, ownId.stubCase, fakeToken(BOT_TOKEN_PREFIX, 's'), ownId.options)
    run.latch.setFromConflict(OTHER, tokenSession, { refusedOperation: REFUSED_OPERATION_RESUME, rowState: LATCH_ROW_STATE_NO_ROW })
    expect(run.latch.record(OTHER)?.sessionName).toBe(REDACTED_TOKEN_PLACEHOLDER)
  })

  test('a set with no description records none, and its line has no message', () => {
    const run = makeLatchRun()
    run.latch.set(KEY, { latchCase: LATCH_CASE_OWN_ID, refusedOperation: REFUSED_OPERATION_RESUME, rowState: ENDED })
    expect(run.latch.record(KEY)).toEqual({
      sessionName: personaTmuxSessionName(KEY),
      latchCase: LATCH_CASE_OWN_ID,
      refusedOperation: REFUSED_OPERATION_RESUME,
      rowState: ENDED,
    })
    expect(run.lines).toEqual([conflictLatchSetLine(KEY, run.latch.record(KEY)!)])
  })

  test('the hold cases are recorded with the refused operation none', () => {
    const run = makeLatchRun()
    for (const [key, latchCase] of [[KEY, LATCH_CASE_UNUSABLE_RECORDED_NAME], [OTHER, LATCH_CASE_LAUNCH_START_NOT_RECORDED]] as const) {
      const rowState = latchRowStateRead(AGENT_DIRECTOR_PENDING_STATE)
      expect(run.latch.set(key, { latchCase, refusedOperation: REFUSED_OPERATION_NONE, rowState })).toBe(CONFLICT_LATCH_SET_LATCHED)
      expect(run.latch.record(key)).toMatchObject({ latchCase, refusedOperation: REFUSED_OPERATION_NONE, rowState })
    }
  })

  test.each(LATCH_CASES.map((latchCase) => [latchCase]))('case %s: hold and unrecognised-handling marks', (latchCase) => {
    expect(isHoldLatchCase(latchCase)).toBe((HOLD_LATCH_CASES as readonly string[]).includes(latchCase))
    expect(takesUnrecognisedHandling(latchCase)).toBe(
      latchCase === LATCH_CASE_UNRECOGNISED || latchCase === LATCH_CASE_NEVER_REPORTED_IN,
    )
  })

  test.each([
    ['ErrSpawnNotFound', (): unknown => errSpawnNotFound()],
    ['ErrTmuxUnresponsive', (): unknown => errTmuxUnresponsive()],
    ['an ErrUnknownErrorName naming the conflict', (): unknown => errUnknownErrorName(ERR_TMUX_SESSION_CONFLICT_NAME, CONFLICT_OWN_ID_PHRASE)],
    ['a plain Error', (): unknown => new Error(CONFLICT_OWN_ID_PHRASE)],
    ['undefined', (): unknown => undefined],
  ] as const)('setFromConflict on %s latches nothing, changes nothing and is silent', (_label, build) => {
    const run = makeLatchRun()
    const row = rowWhere((r) => r.latchCase === LATCH_CASE_LEFTOVER)
    latchOnRow(run.latch, OTHER, row)
    const before = run.latch.record(OTHER)
    const fields: ConflictLatchConflictFields = { refusedOperation: REFUSED_OPERATION_RESUME, rowState: LATCH_ROW_STATE_NO_ROW }
    expect(run.latch.setFromConflict(KEY, build(), fields)).toBeUndefined()
    expect(run.latch.setFromConflict(OTHER, build(), fields)).toBeUndefined()
    expect(run.latch.isLatched(KEY)).toBe(false)
    expect(run.latch.record(OTHER)).toBe(before)
    expect(run.lines.length).toBe(1)
    expect(run.events.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Relatch and same case (SRJ-501, SRJ-506)
// ---------------------------------------------------------------------------

describe('relatch', () => {
  const first: ConflictLatchSetInput = {
    latchCase: LATCH_CASE_OWN_ID,
    refusedOperation: REFUSED_OPERATION_RESUME,
    rowState: ENDED,
    description: CONFLICT_OWN_ID_PHRASE,
  }

  test('a different case relatches: the case, the refused operation, the recorded state and the session are replaced', () => {
    const run = makeLatchRun()
    run.latch.set(KEY, first)
    const previous = run.latch.record(KEY)
    const second: ConflictLatchSetInput = {
      latchCase: LATCH_CASE_LEFTOVER,
      refusedOperation: REFUSED_OPERATION_PLAIN_SPAWN,
      rowState: LATCH_ROW_STATE_NO_ROW,
      sessionName: STUB_TMUX_SESSION_NAME,
      description: CONFLICT_LEFTOVER_PHRASE,
    }
    expect(run.latch.set(KEY, second)).toBe(CONFLICT_LATCH_SET_RELATCHED)
    expect<unknown>(run.latch.record(KEY)).toEqual(second)
    expect(run.events.map((event): unknown[] => [event.outcome, event.record, event.previous])).toEqual([
      [CONFLICT_LATCH_SET_LATCHED, previous, undefined],
      [CONFLICT_LATCH_SET_RELATCHED, second, previous],
    ])
    expect(run.lines).toEqual([conflictLatchSetLine(KEY, previous!), conflictLatchSetLine(KEY, run.latch.record(KEY)!, LATCH_CASE_OWN_ID)])
    // The pin (SRJ-1014): the set and relatch lines' words, with the case, the session, the refused operation, the state and the description.
    expect(run.lines).toEqual([
      `[slack] conflict-latch: persona=${KEY} latched — case=${LATCH_CASE_OWN_ID} session=${JSON.stringify(personaTmuxSessionName(KEY))} refused=${REFUSED_OPERATION_RESUME} state=ended message=${JSON.stringify(CONFLICT_OWN_ID_PHRASE)}`,
      `[slack] conflict-latch: persona=${KEY} relatched — case=${LATCH_CASE_LEFTOVER} (was ${LATCH_CASE_OWN_ID}) session=${JSON.stringify(STUB_TMUX_SESSION_NAME)} refused=${REFUSED_OPERATION_PLAIN_SPAWN} state=${LATCH_ROW_STATE_KIND_NO_ROW} message=${JSON.stringify(CONFLICT_LEFTOVER_PHRASE)}`,
    ])
  })

  test('a relatch through setFromConflict takes the new error\'s case and the retry\'s fields', () => {
    const run = makeLatchRun()
    const scan = rowWhere(
      (row) => row.refusedOperation === REFUSED_OPERATION_PLAIN_SPAWN && row.latchCase === LATCH_CASE_LEFTOVER && row.rowState === LATCH_ROW_STATE_NO_ROW,
    )
    const killed = rowWhere((row) => row.verb === 'kill' && row.latchCase === LATCH_CASE_NOT_THIS_LAUNCH)
    latchOnRow(run.latch, KEY, killed)
    expect(latchOnRow(run.latch, KEY, scan)).toBe(CONFLICT_LATCH_SET_RELATCHED)
    expect(run.latch.record(KEY)).toMatchObject({
      latchCase: LATCH_CASE_LEFTOVER,
      refusedOperation: REFUSED_OPERATION_PLAIN_SPAWN,
      rowState: LATCH_ROW_STATE_NO_ROW,
    })
  })

  test('the same case keeps the persona latched with the record unchanged, logs nothing and reports same case', () => {
    const run = makeLatchRun()
    run.latch.set(KEY, first)
    const kept = run.latch.record(KEY)
    const again: ConflictLatchSetInput = {
      latchCase: LATCH_CASE_OWN_ID,
      refusedOperation: REFUSED_OPERATION_REUSE_SPAWN,
      rowState: LATCH_ROW_STATE_UNREADABLE,
      sessionName: STUB_TMUX_SESSION_NAME,
      description: CONFLICT_NO_VALID_ID_PHRASE,
    }
    expect(run.latch.set(KEY, again)).toBe(CONFLICT_LATCH_SET_SAME_CASE)
    expect(run.latch.record(KEY)).toBe(kept)
    expect(run.lines.length).toBe(1)
    expect(run.events.map((event): unknown[] => [event.outcome, event.record, event.previous])).toEqual([
      [CONFLICT_LATCH_SET_LATCHED, kept, undefined],
      [CONFLICT_LATCH_SET_SAME_CASE, kept, kept],
    ])
  })

  test('a relatch back to an earlier case is a relatch: the case is compared with the one now held', () => {
    const run = makeLatchRun()
    run.latch.set(KEY, first)
    run.latch.set(KEY, { ...first, latchCase: LATCH_CASE_LEFTOVER })
    expect(run.latch.set(KEY, first)).toBe(CONFLICT_LATCH_SET_RELATCHED)
    expect(run.latch.record(KEY)?.latchCase).toBe(LATCH_CASE_OWN_ID)
  })
})

// ---------------------------------------------------------------------------
// Scope, forget and observers
// ---------------------------------------------------------------------------

describe('scope', () => {
  const ownId = rowWhere((row) => row.latchCase === LATCH_CASE_OWN_ID)
  const leftover = rowWhere((row) => row.latchCase === LATCH_CASE_LEFTOVER)

  test('one latch per persona: another persona is unaffected by a latch, a relatch and a forget', () => {
    const run = makeLatchRun()
    latchOnRow(run.latch, KEY, ownId)
    expect([run.latch.isLatched(OTHER), run.latch.record(OTHER)]).toEqual([false, undefined])

    expect(latchOnRow(run.latch, OTHER, ownId)).toBe(CONFLICT_LATCH_SET_LATCHED)
    const other = run.latch.record(OTHER)
    expect(latchOnRow(run.latch, KEY, leftover)).toBe(CONFLICT_LATCH_SET_RELATCHED)
    expect(run.latch.record(OTHER)).toBe(other)
    expect(run.latch.forget(KEY)).toBe(true)
    expect(run.latch.record(OTHER)).toBe(other)
  })

  test('a new instance holds no latch', () => {
    const one = makeLatchRun()
    latchOnRow(one.latch, KEY, ownId)
    const two = makeLatchRun()
    expect([two.latch.isLatched(KEY), two.latch.record(KEY)]).toEqual([false, undefined])
  })

  test('forget is silent and per key; a later set latches afresh', () => {
    const run = makeLatchRun()
    latchOnRow(run.latch, KEY, ownId)
    const lines = run.lines.length
    const events = run.events.length
    expect(run.latch.forget(KEY)).toBe(true)
    expect(run.latch.forget(KEY)).toBe(false)
    expect([run.latch.isLatched(KEY), run.latch.record(KEY)]).toEqual([false, undefined])
    expect([run.lines.length, run.events.length]).toEqual([lines, events])
    expect(latchOnRow(run.latch, KEY, ownId)).toBe(CONFLICT_LATCH_SET_LATCHED)
  })
})

describe('set observers', () => {
  const ownId = rowWhere((row) => row.latchCase === LATCH_CASE_OWN_ID)

  test('a removed observer is not called again', () => {
    const run = makeLatchRun()
    const seen: string[] = []
    const remove = run.latch.addSetObserver((event) => {
      seen.push(event.outcome)
    })
    latchOnRow(run.latch, KEY, ownId)
    remove()
    latchOnRow(run.latch, KEY, ownId)
    expect(seen).toEqual([CONFLICT_LATCH_SET_LATCHED])
    expect(run.events.map((event) => event.outcome)).toEqual([CONFLICT_LATCH_SET_LATCHED, CONFLICT_LATCH_SET_SAME_CASE])
  })

  test('a throwing and a rejecting observer are logged redacted and swallowed; the set still holds and others are called', async () => {
    const run = makeLatchRun()
    run.latch.addSetObserver(() => {
      throw new Error(`observer (${sentinelInMessage('t')})`)
    })
    run.latch.addSetObserver(() => Promise.reject(new Error(`observer (${sentinelInMessage('r')})`)))
    const seen: string[] = []
    run.latch.addSetObserver((event) => {
      seen.push(event.key)
    })
    expect(latchOnRow(run.latch, KEY, ownId)).toBe(CONFLICT_LATCH_SET_LATCHED)
    await Promise.resolve()
    await Promise.resolve()
    expect(run.latch.isLatched(KEY)).toBe(true)
    expect(seen).toEqual([KEY])
    const failed = run.lines.filter((line) => line.startsWith(`[slack] conflict-latch: persona=${KEY} set observer failed: `))
    expect(failed.length).toBe(2)
    for (const line of failed) expect(line.includes(`(${REDACTED_SENTINEL_TAIL})`)).toBe(true)
  })

  test('a throwing log breaks no set', () => {
    const latch = createConflictLatch({
      log: () => {
        throw new Error('log down')
      },
    })
    expect(latchOnRow(latch, KEY, ownId)).toBe(CONFLICT_LATCH_SET_LATCHED)
    expect(latch.isLatched(KEY)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The CONFLICT notice and its episode: fixtures (SRJ-1004, SRJ-508, SRJ-1016)
// ---------------------------------------------------------------------------

interface NoticeRun extends LatchRun {
  readonly clock: FakeClock
  readonly episodes: PersonaEpisodes
  /** Every notice the episodes' sink received: the key and the body. */
  readonly posts: Array<readonly [string, string]>
  /** Removes the notice reaction from the latch. */
  readonly unbind: () => void
}

/** Every notice run of this test, checked in `afterEach`. */
let noticeRuns: NoticeRun[] = []

/**
 * One latch with the latch notices bound to a real episodes instance over a
 * fake clock and a recording sink, which also hands each post to `forward`
 * when given (a case's persona notifier).
 */
function makeNoticeRun(forward?: (key: string, text: string) => void): NoticeRun {
  const run = makeLatchRun()
  const clock = createFakeClock()
  const posts: Array<readonly [string, string]> = []
  const episodes = createPersonaEpisodes({
    sink: (key, text) => {
      posts.push([key, text])
      forward?.(key, text)
    },
    log: (line) => run.lines.push(line),
    clock,
  })
  const unbind = bindConflictNotice(run.latch, episodes)
  const noticeRun = { ...run, clock, episodes, posts, unbind }
  noticeRuns.push(noticeRun)
  return noticeRun
}

afterEach(() => {
  const pending = noticeRuns.map((run) => run.clock.pendingCount())
  const posts = noticeRuns.map((run) => run.posts)
  noticeRuns = []
  setSessionNotifier(undefined)
  _resetNotConnectedEpisodes()
  expect(pending).toEqual(pending.map(() => 0))
  assertNoLeak(posts, 'posts')
})

/** A CONFLICT error carrying `description`, as agent-director throws it. */
const conflictError = (description: string) => errGeneric('resume', ERR_TMUX_SESSION_CONFLICT_NAME, description)

/** Latch `key` on a CONFLICT error carrying `description`. */
function latchOnDescription(latch: ConflictLatch, key: string, description: string) {
  return latch.setFromConflict(key, conflictError(description), { refusedOperation: REFUSED_OPERATION_RESUME, rowState: ENDED })
}

/** Every CONFLICT latch case: the nine recognised cases, then unrecognised text. */
const CONFLICT_LATCH_CASES: readonly ConflictLatchCase[] = [...CONFLICT_CASE_ORDER.map((entry) => entry.latchCase), LATCH_CASE_UNRECOGNISED]

/**
 * The recovery reasons, by name, for `test.each`: "row reads" over every dead
 * state and every live state (`waiting` among them), then the fixed reasons.
 */
const RECOVERY_REASONS: ReadonlyArray<readonly [string, LatchRecoveryReason]> = [
  ...[...AGENT_DIRECTOR_DEAD_STATES, ...AGENT_DIRECTOR_LIVE_STATES].map(
    (state) => [`row reads ${state}`, latchRecoveryReasonRowReads(state)] as const,
  ),
  ['row gone', LATCH_RECOVERY_REASON_ROW_GONE],
  ['retry not refused', LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED],
  ['relaunch not refused', LATCH_RECOVERY_REASON_RELAUNCH_NOT_REFUSED],
  ['cleared by hand', LATCH_RECOVERY_REASON_CLEARED_BY_HAND],
]

// ---------------------------------------------------------------------------
// Pin: SRJ-1004's and SRJ-1005's texts
// ---------------------------------------------------------------------------

describe('notice texts: pin', () => {
  test('every case\'s CONFLICT notice, every fixed line and both recovery templates with each reason are SRJ-1004\'s and SRJ-1005\'s words', () => {
    // The file's only literal block for these texts: SRJ-1004 and SRJ-1005 as written.
    const FIRST_WITH_CASE =
      ":no_entry: *Held: tmux session conflict* — agent-director will not act on this persona's tmux session <session>: <case sentence>. CSCB takes no action for this persona until the conflict clears, and messages sent to it meanwhile are lost."
    const FIRST_WITHOUT_CASE =
      ":no_entry: *Held: tmux session conflict* — agent-director will not act on this persona's tmux session <session>. CSCB takes no action for this persona until the conflict clears, and messages sent to it meanwhile are lost."
    const DESCRIPTION = 'agent-director said: "<its description, redacted>"'
    const POINTER = 'What to do: a human follows the "Operator actions" section of agent-director\'s README for this session.'
    const ANOTHER_ROW = 'This session belongs to another agent-director row and must not be ended.'
    const ANOTHER_STORE = 'This session belongs to another agent-director store and must not be ended.'
    const LIST =
      'To see which agent-director rows record the session name, run `agent-director list --tmux-session-name <name>` on the command line (over MCP, list ignores that filter).'
    const HUMAN_ONLY = 'This is for a human only: no bot, including any persona that sees this post, may act on it.'
    const CASE_SENTENCES: Record<string, string> = {
      [LATCH_CASE_OWN_ID]:
        "this persona's own session still runs on its finished agent-director row past agent-director's stopping window and starting-session bound, or its worker process still runs after that session has gone; the worker may be hung or running on a row wrongly marked finished, and the conversation stays resumable",
      [LATCH_CASE_LEFTOVER]:
        "a session left over from an earlier launch of this persona holds the name or, renamed, still carries this persona's agent-director label, and ending it is a human's decision",
      [LATCH_CASE_NOT_THIS_LAUNCH]:
        "a session left over from an earlier launch of this persona is there; CSCB will not act on it, and ending it is a human's decision",
      [LATCH_CASE_NO_VALID_ID]: 'a session with no valid agent-director label holds the name; CSCB never touches it',
      [LATCH_CASE_DIFFERENT_ID]: "another agent-director row's session holds the name; CSCB never touches it",
      [LATCH_CASE_PANE_NOT_FOUND]:
        "the worker's recorded pane is not there (it is gone, it was respawned with another program, or it could not be adopted), or the one session left over from an earlier launch of this persona has no pane agent-director can find, and a human should look",
      [LATCH_CASE_CONFLICTING_LABELS]:
        "two sessions carry this launch's agent-director label, or an agent-director label value is set at the server, global or global-window scope; nothing automatic is safe, and a human must look",
      [LATCH_CASE_ANOTHER_STORE]:
        'a worker of another agent-director store sharing this tmux server holds the name; CSCB never touches it',
    }
    const CONFLICT_RECOVERY =
      ":white_check_mark: *Conflict cleared* — the hold on this persona's tmux session <session> is cleared (<reason>). CSCB is recovering this persona again."
    const HOLD_RECOVERY =
      ":white_check_mark: *Hold cleared* — the hold on this persona's agent-director row is cleared (<reason>). CSCB is recovering this persona again."
    const REASONS: ReadonlyArray<readonly [LatchRecoveryReason, string]> = [
      [latchRecoveryReasonRowReads('ended'), 'its agent-director row reads ended'],
      [LATCH_RECOVERY_REASON_ROW_GONE, 'its agent-director row is gone'],
      [LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED, 'a retry of the refused operation was not refused'],
      [LATCH_RECOVERY_REASON_RELAUNCH_NOT_REFUSED, 'its row finished and a relaunch was not refused'],
      [LATCH_RECOVERY_REASON_CLEARED_BY_HAND, 'cleared by hand'],
    ]

    const name = personaTmuxSessionName(KEY)
    const session = JSON.stringify(name)
    const description = NO_KILL_SENT_PHRASE
    const fill = (template: string, values: Record<string, string>) =>
      Object.entries(values).reduce((text, [slot, value]) => text.replace(slot, () => value), template)

    expect<unknown>(CONFLICT_CASE_SENTENCES).toEqual(CASE_SENTENCES)
    expect([
      CONFLICT_NOTICE_POINTER_LINE,
      CONFLICT_NOTICE_DIFFERENT_ID_MUST_NOT_END_LINE,
      CONFLICT_NOTICE_ANOTHER_STORE_MUST_NOT_END_LINE,
      CONFLICT_NOTICE_HUMAN_ONLY_LINE,
      CONFLICT_NOTICE_LINE_SEPARATOR,
    ]).toEqual([POINTER, ANOTHER_ROW, ANOTHER_STORE, HUMAN_ONLY, '\n'])

    for (const latchCase of CONFLICT_LATCH_CASES) {
      const sentence = CASE_SENTENCES[latchCase]
      const first =
        sentence === undefined
          ? fill(FIRST_WITHOUT_CASE, { '<session>': session })
          : fill(FIRST_WITH_CASE, { '<session>': session, '<case sentence>': sentence })
      const middle =
        latchCase === LATCH_CASE_DIFFERENT_ID ? [ANOTHER_ROW] : latchCase === LATCH_CASE_ANOTHER_STORE ? [ANOTHER_STORE, POINTER] : [POINTER]
      const lines = [
        first,
        fill(DESCRIPTION, { '<its description, redacted>': description }),
        ...middle,
        fill(LIST, { '<name>': name }),
        HUMAN_ONLY,
      ]
      expect([latchCase, conflictNoticeText({ sessionName: name, latchCase, description }).split('\n')]).toEqual([latchCase, lines])
      expect([latchCase, expectedConflictNotice({ sessionName: name, latchCase, description }).lines]).toEqual([latchCase, lines])
    }
    expect(CASE_SENTENCES[LATCH_CASE_NEVER_REPORTED_IN]).toBeUndefined()
    expect(CASE_SENTENCES[LATCH_CASE_UNRECOGNISED]).toBeUndefined()

    for (const [reason, reasonText] of REASONS) {
      expect(latchRecoveryReasonText(reason)).toBe(reasonText)
      const conflict = fill(CONFLICT_RECOVERY, { '<session>': session, '<reason>': reasonText })
      const hold = fill(HOLD_RECOVERY, { '<reason>': reasonText })
      expect([conflictRecoveryText(name, reason), latchRecoveryText(LATCH_KIND_CONFLICT, reason, name)]).toEqual([conflict, conflict])
      expect([holdRecoveryText(reason), latchRecoveryText(LATCH_KIND_HOLD, reason, name)]).toEqual([hold, hold])
    }
  })
})

// ---------------------------------------------------------------------------
// The CONFLICT notice by row (SRJ-1004, SRJ-508; AC 40, AC 77)
// ---------------------------------------------------------------------------

describe('the CONFLICT notice by row', () => {
  test('every CONFLICT latch case has a row, unrecognised text and "never reported in" included, and only those two carry no case sentence', () => {
    expect(new Set(CONFLICT_CASE_ROWS.map((row) => row.latchCase))).toEqual(new Set(CONFLICT_LATCH_CASES))
    const noSentence = CONFLICT_CASE_ROWS.filter((row) => row.notice.caseSentence === undefined)
    expect(new Set(noSentence.map((row) => row.latchCase))).toEqual(new Set([LATCH_CASE_UNRECOGNISED, LATCH_CASE_NEVER_REPORTED_IN]))
    expect(CONFLICT_LATCH_CASES.filter((latchCase) => conflictCaseSentence(latchCase) === undefined)).toEqual([
      LATCH_CASE_NEVER_REPORTED_IN,
      LATCH_CASE_UNRECOGNISED,
    ])
    for (const latchCase of HOLD_LATCH_CASES) expect(conflictCaseSentence(latchCase)).toBeUndefined()
  })

  test.each(ROWS)('%s: the latch posts the row\'s notice once to the persona, its lines in SRJ-1004\'s order', (_name, row) => {
    const run = makeNoticeRun()
    expect(latchOnRow(run.latch, KEY, row)).toBe(CONFLICT_LATCH_SET_LATCHED)
    expect(run.posts).toEqual([[KEY, row.notice.text]])

    const lines = run.posts[0][1].split(CONFLICT_NOTICE_LINE_SEPARATOR)
    const at = (line: string) => lines.indexOf(line)
    const listLine = CONFLICT_NOTICE_LIST_LINE_HEAD + row.sessionName + CONFLICT_NOTICE_LIST_LINE_TAIL
    expect(lines[0].startsWith(CONFLICT_NOTICE_FIRST_LINE_HEAD + JSON.stringify(row.sessionName))).toBe(true)
    expect(lines[1]).toBe(row.notice.descriptionLine as string)
    expect(lines.slice(-2)).toEqual([listLine, CONFLICT_NOTICE_HUMAN_ONLY_LINE])
    expect(at(CONFLICT_NOTICE_POINTER_LINE) >= 0).toBe(row.notice.carries.pointer)
    expect(at(CONFLICT_NOTICE_DIFFERENT_ID_MUST_NOT_END_LINE) >= 0).toBe(row.notice.carries.mustNotEnd === 'row')
    expect(at(CONFLICT_NOTICE_ANOTHER_STORE_MUST_NOT_END_LINE) >= 0).toBe(row.notice.carries.mustNotEnd === 'store')
    if (row.latchCase === LATCH_CASE_DIFFERENT_ID) {
      expect(at(CONFLICT_NOTICE_DIFFERENT_ID_MUST_NOT_END_LINE)).toBe(2)
      expect(run.posts[0][1].includes(operatorActionsTitle())).toBe(false)
    } else if (row.latchCase === LATCH_CASE_ANOTHER_STORE) {
      expect([at(CONFLICT_NOTICE_ANOTHER_STORE_MUST_NOT_END_LINE), at(CONFLICT_NOTICE_POINTER_LINE), at(listLine)]).toEqual([2, 3, 4])
    } else {
      expect(at(CONFLICT_NOTICE_POINTER_LINE)).toBe(2)
    }
  })

  test('the scan\'s and the duplicate-session leftover descriptions both get the "left over from an earlier life" wording', () => {
    const leftovers = CONFLICT_CASE_ROWS.filter((row) => row.refusedOperation === REFUSED_OPERATION_PLAIN_SPAWN && row.latchCase === LATCH_CASE_LEFTOVER)
    expect(leftovers.map((row) => descriptionOf(row).includes(PLAIN_SPAWN_LABEL_NAMES_THIS_ID_PHRASE)).sort()).toEqual([false, true])
    for (const row of leftovers) {
      const run = makeNoticeRun()
      latchOnRow(run.latch, KEY, row)
      expect(run.posts[0][1].split(CONFLICT_NOTICE_LINE_SEPARATOR)[0].includes(CONFLICT_CASE_SENTENCES[LATCH_CASE_LEFTOVER])).toBe(true)
    }
  })

  test('a record with no description gives no description line (the note latch\'s form)', () => {
    const run = makeNoticeRun()
    run.latch.set(KEY, { latchCase: LATCH_CASE_CONFLICTING_LABELS, refusedOperation: REFUSED_OPERATION_RESUME, rowState: ENDED })
    const expected = expectedConflictNotice({ latchCase: LATCH_CASE_CONFLICTING_LABELS, sessionName: personaTmuxSessionName(KEY) })
    expect(expected.descriptionLine).toBeUndefined()
    expect(run.posts).toEqual([[KEY, expected.text]])
    expect(run.posts[0][1].includes(CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// No session-ending command in CSCB's own lines (SRJ-1001, SRJ-1004; AC 40)
// ---------------------------------------------------------------------------

describe('no session-ending command', () => {
  test.each(ROWS)('%s: CSCB\'s own lines name no session-ending command, no --include-finished, and no kill-pane, set-option, agent-director delete, clear-latch, has-session or label option', (_name, row) => {
    const own = cscbOwnLines(conflictNoticeText({ sessionName: row.sessionName, latchCase: row.latchCase, description: descriptionOf(row) }))
    expect(own.length).toBe(row.notice.lines.length - 1)
    expect(own.flatMap(sessionEndingCommandsIn)).toEqual([])
    expect(own.flatMap(cscbOwnLineForbiddenIn)).toEqual([])
  })

  /** One sample per spelling the forbidden list names; each matches exactly one entry. */
  const FORBIDDEN_SAMPLES = [
    'tmux kill-pane -t =slack_bot_alpha',
    'tmux set-option -t =slack_bot_alpha',
    'run agent-director  delete --claude-instance-id cscb_alpha',
    'cscb clear-latch alpha',
    'the clear_latch tool',
    'call clearLatch()',
    'tmux has-session -t =slack_bot_alpha',
    'the @ad_owner option',
    'the @ad_pane option',
  ]

  test.each(FORBIDDEN_SAMPLES.map((sample) => [sample]))('%p in a line of CSCB\'s own is caught; in the quoted description it is let through', (sample) => {
    const notice = conflictNoticeText({ sessionName: STUB_TMUX_SESSION_NAME, latchCase: LATCH_CASE_OWN_ID, description: sample })
    expect(cscbOwnLines(notice).flatMap(cscbOwnLineForbiddenIn)).toEqual([])
    expect(cscbOwnLines(`${notice}${CONFLICT_NOTICE_LINE_SEPARATOR}${sample}`).flatMap(cscbOwnLineForbiddenIn).length).toBe(1)
  })

  test('the never-reported-in and not-this-launch kill rows quote "no kill was sent", and the check lets it through', () => {
    const killRows = CONFLICT_CASE_ROWS.filter(
      (row) => row.verb === 'kill' && (row.latchCase === LATCH_CASE_NEVER_REPORTED_IN || row.latchCase === LATCH_CASE_NOT_THIS_LAUNCH),
    )
    expect(new Set(killRows.map((row) => row.latchCase))).toEqual(new Set([LATCH_CASE_NEVER_REPORTED_IN, LATCH_CASE_NOT_THIS_LAUNCH]))
    for (const row of killRows) {
      expect(row.notice.text.includes(NO_KILL_SENT_PHRASE)).toBe(true)
      expect(cscbOwnLines(row.notice.text).some((line) => line.includes(NO_KILL_SENT_PHRASE))).toBe(false)
      expect(cscbOwnLines(row.notice.text).flatMap(sessionEndingCommandsIn)).toEqual([])
    }
  })

  test('a session-ending command in a line of CSCB\'s own is caught; the same words in the quoted description are let through', () => {
    const named = 'run `agent-director kill --claude-instance-id cscb_alpha` now'
    const notice = conflictNoticeText({ sessionName: STUB_TMUX_SESSION_NAME, latchCase: LATCH_CASE_OWN_ID, description: named })
    expect(cscbOwnLines(notice).flatMap(sessionEndingCommandsIn)).toEqual([])
    expect(sessionEndingCommandsIn(notice)).toEqual(['kill as a command'])
    expect(cscbOwnLines(`${notice}${CONFLICT_NOTICE_LINE_SEPARATOR}${named}`).flatMap(sessionEndingCommandsIn)).toEqual(['kill as a command'])
  })

  test.each([
    ['kill as a command', 'run `agent-director kill --claude-instance-id cscb_alpha`'],
    ['kill as a command', 'agent-director kill'],
    ['kill as a command', 'then kill -9 4242'],
    ['kill as a command', 'run kill on that pane'],
    ['kill as a command', 'type `kill 4242`'],
    ['pause', 'run `agent-director pause --claude-instance-id cscb_alpha`'],
    ['pause', 'pause the session'],
    ['--include-finished', 'agent-director kill --include-finished'],
    ['--include-finished', 'the include-finished option'],
    ['tmux kill-session', 'tmux kill-session -t =slack_bot_alpha'],
    ['tmux kill-server', 'tmux kill-server'],
  ])('the form %p catches %p', (form, text) => {
    expect(sessionEndingCommandsIn(text)).toContain(form)
  })

  test('the forms cover SRJ-1001\'s five commands, and none matches agent-director\'s own words or any stub description', () => {
    expect(SESSION_ENDING_COMMAND_FORMS.map((form) => form.name)).toEqual([
      'kill as a command',
      'pause',
      '--include-finished',
      'tmux kill-session',
      'tmux kill-server',
    ])
    expect([NO_KILL_SENT_PHRASE, RETRY_KILL_LATER_PHRASE, NEVER_DELETE_ROW_PHRASE].flatMap(sessionEndingCommandsIn)).toEqual([])
    expect(CONFLICT_CASE_ROWS.flatMap((row) => sessionEndingCommandsIn(descriptionOf(row)))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Redaction, the cap and Slack escaping (SRJ-1001, SRJ-508; E12 hatch note)
// ---------------------------------------------------------------------------

describe('the quoted description and session in the notice', () => {
  test('a token-bearing description is redacted in the description line and the post passes assertNoLeak', () => {
    const run = makeNoticeRun()
    const description = `${CONFLICT_OWN_ID_PHRASE} (${sentinelInMessage('n')})`
    latchOnDescription(run.latch, KEY, description)
    const descriptionLine = run.posts[0][1].split(CONFLICT_NOTICE_LINE_SEPARATOR)[1]
    expect(descriptionLine).toBe(expectedConflictNotice({ latchCase: LATCH_CASE_OWN_ID, sessionName: personaTmuxSessionName(KEY), description }).descriptionLine as string)
    expect(descriptionLine.includes(escapeSlackControlCharacters(`(${REDACTED_SENTINEL_TAIL})`))).toBe(true)
    assertNoLeak(run.posts)
  })

  test('an overlong description is capped at MAX_LOGGED_MESSAGE_LENGTH before it is quoted', () => {
    const run = makeNoticeRun()
    const description = `${CONFLICT_OWN_ID_PHRASE} ${'x'.repeat(2 * MAX_LOGGED_MESSAGE_LENGTH)}`
    latchOnDescription(run.latch, KEY, description)
    const descriptionLine = run.posts[0][1].split(CONFLICT_NOTICE_LINE_SEPARATOR)[1]
    const quoted = descriptionLine.slice(CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD.length, -CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL.length)
    expect(quoted).toBe(renderLogMessageText(description))
    expect(quoted.length).toBe(MAX_LOGGED_MESSAGE_LENGTH)
  })

  test('Slack control characters in the description and the session name are escaped once in the post; the log line keeps them as written', () => {
    const run = makeNoticeRun()
    const sessionName = 'ses<s>&n'
    const controls = '<!channel> & <@U0ALERT>'
    const description = `tmux session ${JSON.stringify(sessionName)}: ${CONFLICT_OWN_ID_PHRASE} ${controls}`
    latchOnDescription(run.latch, KEY, description)
    const notice = run.posts[0][1]
    expect(notice).toBe(expectedConflictNotice({ latchCase: LATCH_CASE_OWN_ID, sessionName, description }).text)
    const lines = notice.split(CONFLICT_NOTICE_LINE_SEPARATOR)
    expect(lines[0].includes(JSON.stringify(escapeSlackControlCharacters(sessionName)))).toBe(true)
    expect(lines.at(-2)).toBe(CONFLICT_NOTICE_LIST_LINE_HEAD + escapeSlackControlCharacters(sessionName) + CONFLICT_NOTICE_LIST_LINE_TAIL)
    expect(lines[1]).toBe(CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD + escapeSlackControlCharacters(description) + CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL)
    expect(/[<>]/.test(notice)).toBe(false)
    expect(notice.includes(escapeSlackControlCharacters(escapeSlackControlCharacters('<')))).toBe(false)
    expect(run.lines.filter((line) => line.includes(controls) && line.includes(JSON.stringify(sessionName))).length).toBe(1)
  })

  test('a token-shaped quoted session is redacted in the first line and the list line', () => {
    const run = makeNoticeRun()
    const ownId = rowWhere((row) => row.latchCase === LATCH_CASE_OWN_ID)
    run.latch.setFromConflict(KEY, errTmuxSessionConflict(ownId.verb, ownId.stubCase, fakeToken(BOT_TOKEN_PREFIX, 'q'), ownId.options), {
      refusedOperation: REFUSED_OPERATION_RESUME,
      rowState: ENDED,
    })
    const lines = run.posts[0][1].split(CONFLICT_NOTICE_LINE_SEPARATOR)
    const placeholder = escapeSlackControlCharacters(REDACTED_TOKEN_PLACEHOLDER)
    expect(lines[0].includes(JSON.stringify(placeholder))).toBe(true)
    expect(lines.at(-2)).toBe(CONFLICT_NOTICE_LIST_LINE_HEAD + placeholder + CONFLICT_NOTICE_LIST_LINE_TAIL)
  })
})

// ---------------------------------------------------------------------------
// The episode: once per latch episode (SRJ-508, SRJ-1016; AC 41)
// ---------------------------------------------------------------------------

describe('the CONFLICT notice\'s episode', () => {
  const ownId = rowWhere((row) => row.latchCase === LATCH_CASE_OWN_ID)
  const ownIdAgain = rowWhere((row) => row.latchCase === LATCH_CASE_OWN_ID && row !== ownId)
  const leftover = rowWhere((row) => row.latchCase === LATCH_CASE_LEFTOVER)

  test('a latch posts once; a same-case set posts nothing; a new case posts once more; a return to the first case is a new case too', () => {
    const run = makeNoticeRun()
    latchOnRow(run.latch, KEY, ownId)
    const firstEpisode = run.episodes.view(KEY, PERSONA_EPISODE_KIND_CONFLICT)
    expect(firstEpisode?.caseLabel).toBe(LATCH_CASE_OWN_ID)

    expect(latchOnRow(run.latch, KEY, ownIdAgain)).toBe(CONFLICT_LATCH_SET_SAME_CASE)
    expect(latchOnRow(run.latch, KEY, ownId)).toBe(CONFLICT_LATCH_SET_SAME_CASE)
    expect(run.posts).toEqual([[KEY, ownId.notice.text]])
    expect(run.episodes.view(KEY, PERSONA_EPISODE_KIND_CONFLICT)?.episode).toBe(firstEpisode?.episode)

    expect(latchOnRow(run.latch, KEY, leftover)).toBe(CONFLICT_LATCH_SET_RELATCHED)
    expect(latchOnRow(run.latch, KEY, leftover)).toBe(CONFLICT_LATCH_SET_SAME_CASE)
    expect(latchOnRow(run.latch, KEY, ownId)).toBe(CONFLICT_LATCH_SET_RELATCHED)
    expect(run.posts).toEqual([
      [KEY, ownId.notice.text],
      [KEY, leftover.notice.text],
      [KEY, ownId.notice.text],
    ])
    expect(run.episodes.view(KEY, PERSONA_EPISODE_KIND_CONFLICT)?.caseLabel).toBe(LATCH_CASE_OWN_ID)
  })

  test('a second persona\'s latch posts only for itself and leaves the first persona\'s episode as it was', () => {
    const run = makeNoticeRun()
    latchOnRow(run.latch, KEY, ownId)
    const first = run.episodes.view(KEY, PERSONA_EPISODE_KIND_CONFLICT)
    latchOnRow(run.latch, OTHER, leftover)
    latchOnRow(run.latch, OTHER, leftover)
    expect(run.posts).toEqual([
      [KEY, ownId.notice.text],
      [OTHER, leftover.notice.text],
    ])
    expect(run.episodes.view(KEY, PERSONA_EPISODE_KIND_CONFLICT)).toEqual(first)
  })

  test.each([
    ['unproven-idle', { reason: 'unproven-idle', autoRestartDisabled: false, heldMs: 600_000 }],
    ['blocked-on-prompt', { reason: 'blocked-on-prompt', autoRestartDisabled: false }],
  ] as const)('a persona already given the %s not-connected notice still gets the CONFLICT post once', (_reason, notConnected: NotConnectedNotice) => {
    const notConnectedPosts: Array<readonly [string, string]> = []
    setSessionNotifier((key, text) => {
      notConnectedPosts.push([key, text])
    })
    expect(notifyPersonaNotConnected(KEY, notConnected)).toBe(true)
    expect(notConnectedPosts.map(([key]) => key)).toEqual([KEY])

    const run = makeNoticeRun()
    latchOnRow(run.latch, KEY, ownId)
    latchOnRow(run.latch, KEY, ownId)
    expect(run.posts).toEqual([[KEY, ownId.notice.text]])
    expect(notifyPersonaNotConnected(KEY, notConnected)).toBe(false)
    expect(notConnectedPosts.length).toBe(1)
    assertNoLeak(notConnectedPosts)
  })

  test('a hold case opens no CONFLICT episode and posts no CONFLICT notice: each hold opens its own kind, and the unusable-name hold posts SRJ-1019', () => {
    const run = makeNoticeRun()
    const description = UNUSABLE_NAME_CASE_ROWS[0]!.description
    const holds = [
      [KEY, LATCH_CASE_UNUSABLE_RECORDED_NAME, PERSONA_EPISODE_KIND_UNUSABLE_RECORDED_NAME],
      [OTHER, LATCH_CASE_LAUNCH_START_NOT_RECORDED, PERSONA_EPISODE_KIND_LAUNCH_START_NOT_RECORDED],
    ] as const
    expect(new Set(holds.map(([, latchCase]) => latchCase))).toEqual(new Set(HOLD_LATCH_CASES))
    for (const [key, latchCase] of holds) {
      run.latch.set(key, { latchCase, refusedOperation: REFUSED_OPERATION_NONE, rowState: LATCH_ROW_STATE_UNREADABLE, description })
    }
    for (const [key, , kind] of holds) {
      expect([key, run.episodes.isOpen(key, PERSONA_EPISODE_KIND_CONFLICT), run.episodes.isOpen(key, kind)]).toEqual([key, false, true])
    }
    expect(run.posts.filter(([key]) => key === KEY)).toEqual([[KEY, unusableNameNoticeText(KEY, description)]])
    expect(run.posts.filter(([, text]) => text.startsWith(CONFLICT_NOTICE_FIRST_LINE_HEAD))).toEqual([])
  })

  test('after the episodes close (shutdown) a latch opens and posts nothing; an unbound reaction posts nothing', () => {
    const closed = makeNoticeRun()
    closed.episodes.close()
    latchOnRow(closed.latch, KEY, ownId)
    expect([closed.posts, closed.episodes.isOpen(KEY, PERSONA_EPISODE_KIND_CONFLICT)]).toEqual([[], false])

    const unbound = makeNoticeRun()
    unbound.unbind()
    latchOnRow(unbound.latch, KEY, ownId)
    expect([unbound.posts, unbound.episodes.isOpen(KEY, PERSONA_EPISODE_KIND_CONFLICT)]).toEqual([[], false])
  })

  test('after a teardown forgets the latch and the episodes, a new latch with the same case posts again', () => {
    const run = makeNoticeRun()
    latchOnRow(run.latch, KEY, ownId)
    run.latch.forget(KEY)
    run.episodes.forget(KEY)
    expect(latchOnRow(run.latch, KEY, ownId)).toBe(CONFLICT_LATCH_SET_LATCHED)
    expect(run.posts).toEqual([
      [KEY, ownId.notice.text],
      [KEY, ownId.notice.text],
    ])
  })
})

// ---------------------------------------------------------------------------
// The recovery notice (SRJ-1005)
// ---------------------------------------------------------------------------

describe('the recovery notice', () => {
  const KINDS: ReadonlyArray<readonly [string, LatchKind]> = [
    ['conflict', LATCH_KIND_CONFLICT],
    ['hold', LATCH_KIND_HOLD],
  ]
  const CASES = RECOVERY_REASONS.flatMap(([reasonName, reason]) => KINDS.map(([kindName, kind]) => [kindName, reasonName, kind, reason] as const))

  test.each(CASES)('a %s latch cleared for %s: the heading for its kind, the quoted session only for a CONFLICT latch, and the reason', (_k, _r, kind, reason) => {
    const name = STUB_TMUX_SESSION_NAME
    const reasonText =
      reason.kind === LATCH_RECOVERY_REASON_KIND_ROW_READS
        ? LATCH_RECOVERY_REASON_ROW_READS_HEAD + reason.state
        : LATCH_RECOVERY_REASON_TEXTS[reason.kind]
    const text = latchRecoveryText(kind, reason, name)
    expect(text).toBe(
      kind === LATCH_KIND_CONFLICT
        ? `${CONFLICT_RECOVERY_HEAD}${JSON.stringify(name)}${CONFLICT_RECOVERY_REASON_LEAD}${reasonText}${LATCH_RECOVERY_TAIL}`
        : `${HOLD_RECOVERY_HEAD}${reasonText}${LATCH_RECOVERY_TAIL}`,
    )
    expect(text.includes(name)).toBe(kind === LATCH_KIND_CONFLICT)
    expect(sessionEndingCommandsIn(text)).toEqual([])
    expect(text.split(CONFLICT_NOTICE_LINE_SEPARATOR).flatMap(cscbOwnLineForbiddenIn)).toEqual([])
  })

  test('each case maps to its latch kind: the two hold cases to hold, every other case to conflict', () => {
    expect(LATCH_CASES.map((latchCase) => [latchCase, latchKindOf(latchCase)])).toEqual(
      LATCH_CASES.map((latchCase) => [latchCase, isHoldLatchCase(latchCase) ? LATCH_KIND_HOLD : LATCH_KIND_CONFLICT]),
    )
  })

  test('a row state and a session name are redacted and escaped in the recovery text', () => {
    const state = `<!here> ${sentinelInMessage('state')}`
    const reasonText = latchRecoveryReasonText(latchRecoveryReasonRowReads(state))
    expect(reasonText).toBe(LATCH_RECOVERY_REASON_ROW_READS_HEAD + escapeSlackControlCharacters(renderLogMessageText(state)))
    const sessionName = 'ses<s>&n'
    expect(conflictRecoveryText(sessionName, LATCH_RECOVERY_REASON_ROW_GONE).includes(JSON.stringify(escapeSlackControlCharacters(sessionName)))).toBe(true)
    assertNoLeak([reasonText])
  })
})

// ---------------------------------------------------------------------------
// The unusable recorded name: trigger, record, SRJ-1019's notice and its
// episode (SRJ-512, SRJ-1019, SRJ-508, SRJ-1016; AC 77, AC 85)
// ---------------------------------------------------------------------------

/** The unusable-name row of the helper's table at `site` for `fault`; throws when there is none. */
function unusableRow(site: UnusableNameSite, fault: UnusableNameFault): UnusableNameCaseRow {
  const found = UNUSABLE_NAME_CASE_ROWS.find((row) => row.site === site && row.fault === fault)
  if (found === undefined) throw new Error(`no unusable-name row for ${site}: ${fault}`)
  return found
}

/** `test.each` rows over the unusable-name table: the row name, then the row. */
const UNUSABLE_ROWS = UNUSABLE_NAME_CASE_ROWS.map((row) => [row.name, row] as const)

/** Latch `key` on a row's UNUSABLE NAME with the row's row state. */
const latchUnusable = (latch: ConflictLatch, key: string, row: UnusableNameCaseRow, rowState: LatchRowState = row.rowState) =>
  latch.setFromUnusableName(key, row.build(), rowState)

/** The description agent-director's envelope carries, before the classifier renders it. */
const envelopeDescriptionOf = (err: unknown): string =>
  String((err as { envelope?: { err_description?: unknown } }).envelope?.err_description)

describe('the unusable-recorded-name hold: SRJ-1019\'s notice, the record and the episode (SRJ-512, SRJ-1019)', () => {
  test('SRJ-1019\'s text for one persona: the builder gives it word for word, on one line', () => {
    // The file's only literal block for this text: SRJ-1019 as written.
    const TEMPLATE =
      ':no_entry: *Held: unusable tmux session name* — agent-director will not act on this persona\'s row <instance id>, because its recorded tmux session name cannot be used. agent-director said: "<its description, redacted>". What to do: a human follows the "Operator actions" section of agent-director\'s README for this row. CSCB takes no action for this persona until the row is removed, and messages sent to it meanwhile are lost. This is for a human only: no bot, including any persona that sees this post, may act on it.'
    const row = unusableRow('resume', 'empty')
    const expected = TEMPLATE.replace('<instance id>', () => `cscb_${KEY}`).replace('<its description, redacted>', () => row.description)
    expect(unusableNameNoticeText(KEY, row.description)).toBe(expected)
    expect(expected.includes(CONFLICT_NOTICE_LINE_SEPARATOR)).toBe(false)
  })

  test.each(UNUSABLE_NAME_FAULTS.map((fault) => [fault]))('fault %s: the latch posts the row\'s notice once, with the instance id, the quoted rendered description, "Operator actions" and the human-only sentence; CSCB\'s own words name no command', (fault) => {
    const row = unusableRow('resume', fault)
    const run = makeNoticeRun()
    expect(latchUnusable(run.latch, KEY, row)).toBe(CONFLICT_LATCH_SET_LATCHED)
    expect(run.posts).toEqual([[KEY, row.notice(KEY)]])

    const notice = run.posts[0]![1]
    const quoted = escapeSlackControlCharacters(renderLogMessageText(envelopeDescriptionOf(row.build())))
    expect(row.description).toBe(renderLogMessageText(envelopeDescriptionOf(row.build())))
    expect(notice.startsWith(UNUSABLE_NAME_NOTICE_HEAD + personaInstanceId(KEY) + UNUSABLE_NAME_NOTICE_REASON)).toBe(true)
    expect(notice.includes(CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD + quoted + CONFLICT_NOTICE_DESCRIPTION_LINE_TAIL)).toBe(true)
    expect(notice.includes(JSON.stringify(operatorActionsTitle()))).toBe(true)
    expect(notice.endsWith(CONFLICT_NOTICE_HUMAN_ONLY_LINE)).toBe(true)

    // CSCB's own words: the description cut out, every other word kept.
    const own = cscbOwnText(notice)
    expect(own.includes(row.description)).toBe(false)
    expect(own.includes(personaInstanceId(KEY))).toBe(true)
    expect(sessionEndingCommandsIn(own)).toEqual([])
    expect(own.split(CONFLICT_NOTICE_LINE_SEPARATOR).flatMap(cscbOwnLineForbiddenIn)).toEqual([])
  })

  test('a token-bearing description is redacted in the notice and the post passes assertNoLeak; an overlong one is capped at MAX_LOGGED_MESSAGE_LENGTH before it is quoted', () => {
    const run = makeNoticeRun()
    const secret = `${UNUSABLE_RECORDED_NAME_PHRASE} is empty (${sentinelInMessage('u')}); nothing was done`
    expect(run.latch.setFromUnusableName(KEY, errInternal(secret), ENDED)).toBe(CONFLICT_LATCH_SET_LATCHED)
    expect(run.posts.map(([, text]) => text.includes(escapeSlackControlCharacters(`(${REDACTED_SENTINEL_TAIL})`)))).toEqual([true])
    assertNoLeak(run.posts)

    const long = `${UNUSABLE_RECORDED_NAME_PHRASE} is empty ${'x'.repeat(2 * MAX_LOGGED_MESSAGE_LENGTH)}`
    run.latch.setFromUnusableName(OTHER, errInternal(long), ENDED)
    const capped = renderLogMessageText(long)
    expect(capped.length).toBe(MAX_LOGGED_MESSAGE_LENGTH)
    expect(run.latch.record(OTHER)?.description).toBe(capped)
    expect(run.posts[1]).toEqual([OTHER, unusableNameNoticeText(OTHER, capped)])
    expect(run.posts[1]![1].includes(long)).toBe(false)
  })

  test('posted through the persona notifier, the persona\'s own stub receives the notice under the persona prefix at its destination; the other persona\'s stub receives nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conflict-latch-notifier-'))
    try {
      const config = makeMultiPersonaConfig([{}, {}], dir)
      const [persona, other] = config.personas as [(typeof config.personas)[number], (typeof config.personas)[number]]
      const notifier = makeNotifierHarness(config, { leakMarker: LEAK_SENTINEL })
      const sent: Array<Promise<void>> = []
      const run = makeNoticeRun((key, text) => {
        sent.push(notifier.notifier.notify(key, text))
      })
      const row = unusableRow('read-pane', 'stored-differently')
      latchUnusable(run.latch, persona.key, row)
      await Promise.all(sent)
      expect(notifier.posts(persona.key)).toEqual([
        { channel: persona.permission_prompts, text: formatPersonaNotice(persona, unusableNameNoticeText(persona.key, row.description)) },
      ])
      expect(notifier.posts(other.key)).toEqual([])
      expect(notifier.clock.pendingCount()).toBe(0)
      assertNoLeak([notifier.allPosts(), notifier.logs])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test.each(UNUSABLE_ROWS)('%s: the set input is the case, "none", the path\'s row state, slack_bot_<key> and the rendered description; the latch records the row\'s record; a second persona reads not latched', (_name, row) => {
    const run = makeLatchRun()
    expect(isUnusableNameError(row.build())).toBe(true)
    expect(unusableNameSetInput(KEY, row.build(), row.rowState)).toEqual({
      latchCase: row.latchCase,
      refusedOperation: row.refusedOperation,
      rowState: row.rowState,
      sessionName: row.sessionName(KEY),
      description: row.description,
    })
    expect(latchUnusable(run.latch, KEY, row)).toBe(CONFLICT_LATCH_SET_LATCHED)
    expect(run.latch.record(KEY)).toEqual(row.record(KEY))
    expect([run.latch.isLatched(OTHER), run.latch.record(OTHER)]).toEqual([false, undefined])
  })

  test('a description that quotes a session records that session (SRJ-501\'s rule)', () => {
    const run = makeLatchRun()
    const quoted = personaTmuxSessionName(OTHER)
    const err = errInternal(`${UNUSABLE_RECORDED_NAME_PHRASE} ${JSON.stringify(quoted)} is empty; nothing was done`)
    run.latch.setFromUnusableName(KEY, err, ENDED)
    expect(run.latch.record(KEY)?.sessionName).toBe(quoted)
  })

  test.each([
    ['an ErrInternal without the phrase', (): unknown => errInternal()],
    ['the phrase in another error name', (): unknown => errUnknownErrorName('ErrFromALaterBinary', `${UNUSABLE_RECORDED_NAME_PHRASE} is empty`)],
    ['a CONFLICT', (): unknown => rowWhere((row) => row.latchCase === LATCH_CASE_OWN_ID).build()],
    ['a plain Error carrying the phrase', (): unknown => new Error(`${UNUSABLE_RECORDED_NAME_PHRASE} is empty`)],
  ] as const)('%s is no UNUSABLE NAME: setFromUnusableName latches nothing, posts nothing and is silent', (_label, build) => {
    const run = makeNoticeRun()
    expect(isUnusableNameError(build())).toBe(false)
    expect(unusableNameSetInput(KEY, build(), ENDED)).toBeUndefined()
    expect(run.latch.setFromUnusableName(KEY, build(), ENDED)).toBeUndefined()
    expect([run.latch.isLatched(KEY), run.lines, run.events, run.posts]).toEqual([false, [], [], []])
  })
})

describe('the unusable-recorded-name notice\'s episode (SRJ-508, SRJ-1016)', () => {
  const first = unusableRow('resume', 'empty')
  const second = unusableRow('read-pane', 'control-character')
  const conflictRow = rowWhere((row) => row.latchCase === LATCH_CASE_OWN_ID)
  const kindsOpen = (run: NoticeRun, key: string) => [
    run.episodes.isOpen(key, PERSONA_EPISODE_KIND_CONFLICT),
    run.episodes.isOpen(key, PERSONA_EPISODE_KIND_UNUSABLE_RECORDED_NAME),
  ]

  test('the first latch posts once under the unusable-name kind; a second UNUSABLE NAME for P posts nothing and keeps the record; another persona posts for itself', () => {
    const run = makeNoticeRun()
    expect(latchUnusable(run.latch, KEY, first)).toBe(CONFLICT_LATCH_SET_LATCHED)
    const record = run.latch.record(KEY)
    const episode = run.episodes.view(KEY, PERSONA_EPISODE_KIND_UNUSABLE_RECORDED_NAME)
    expect(episode?.caseLabel).toBe(LATCH_CASE_UNUSABLE_RECORDED_NAME)
    expect(kindsOpen(run, KEY)).toEqual([false, true])

    expect(latchUnusable(run.latch, KEY, second)).toBe(CONFLICT_LATCH_SET_SAME_CASE)
    expect(run.latch.record(KEY)).toBe(record)
    expect(run.episodes.view(KEY, PERSONA_EPISODE_KIND_UNUSABLE_RECORDED_NAME)?.episode).toBe(episode?.episode)

    latchUnusable(run.latch, OTHER, second)
    expect(run.posts).toEqual([
      [KEY, first.notice(KEY)],
      [OTHER, second.notice(OTHER)],
    ])
  })

  test('P latched on a CONFLICT relatches on an UNUSABLE NAME with one new post, the record replaced; a relatch back to that CONFLICT posts SRJ-1004 once more; each relatch ends the other kind\'s episode silently', () => {
    const run = makeNoticeRun()
    expect(latchOnRow(run.latch, KEY, conflictRow)).toBe(CONFLICT_LATCH_SET_LATCHED)
    expect(kindsOpen(run, KEY)).toEqual([true, false])

    expect(latchUnusable(run.latch, KEY, first)).toBe(CONFLICT_LATCH_SET_RELATCHED)
    expect(run.latch.record(KEY)).toEqual(first.record(KEY))
    expect(kindsOpen(run, KEY)).toEqual([false, true])
    expect(run.posts).toEqual([
      [KEY, conflictRow.notice.text],
      [KEY, first.notice(KEY)],
    ])

    expect(latchOnRow(run.latch, KEY, conflictRow)).toBe(CONFLICT_LATCH_SET_RELATCHED)
    expect(kindsOpen(run, KEY)).toEqual([true, false])
    expect(latchUnusable(run.latch, KEY, first)).toBe(CONFLICT_LATCH_SET_RELATCHED)
    expect(run.posts).toEqual([
      [KEY, conflictRow.notice.text],
      [KEY, first.notice(KEY)],
      [KEY, conflictRow.notice.text],
      [KEY, first.notice(KEY)],
    ])
  })

  test.each([
    ['unproven-idle', { reason: 'unproven-idle', autoRestartDisabled: false, heldMs: 600_000 }],
    ['blocked-on-prompt', { reason: 'blocked-on-prompt', autoRestartDisabled: false }],
  ] as const)('a persona already given the %s not-connected notice still gets the unusable-name post once', (_reason, notConnected: NotConnectedNotice) => {
    const notConnectedPosts: Array<readonly [string, string]> = []
    setSessionNotifier((key, text) => {
      notConnectedPosts.push([key, text])
    })
    expect(notifyPersonaNotConnected(KEY, notConnected)).toBe(true)

    const run = makeNoticeRun()
    latchUnusable(run.latch, KEY, first)
    latchUnusable(run.latch, KEY, second)
    expect(run.posts).toEqual([[KEY, first.notice(KEY)]])
    expect(notConnectedPosts.map(([key]) => key)).toEqual([KEY])
    assertNoLeak(notConnectedPosts)
  })
})

// ---------------------------------------------------------------------------
// The holds' set observer (SRJ-502; SRJ-610 and SRJ-1016's slow-recovery end)
// ---------------------------------------------------------------------------

/**
 * The holds as `bindConflictLatchHolds` takes them, each recording `[hold, key]` in `calls`;
 * `slowRecovery: false` leaves the optional slow-recovery end out, and `stuckLaunch: true` adds the optional stuck-launch end.
 */
function recordingHolds(
  calls: Array<readonly [string, string]>,
  opts: { slowRecovery?: boolean; stuckLaunch?: boolean; throwAt?: keyof ConflictLatchHolds } = {},
): ConflictLatchHolds {
  const hold = (name: keyof ConflictLatchHolds) => (key: string): void => {
    calls.push([name, key])
    if (opts.throwAt === name) throw new Error(`${name} failed`)
  }
  return {
    stopRetryTimer: hold('stopRetryTimer'),
    endTmuxUnresponsive: hold('endTmuxUnresponsive'),
    endUnclassifiedError: hold('endUnclassifiedError'),
    ...(opts.slowRecovery === false ? {} : { endSlowRecovery: hold('endSlowRecovery') }),
    ...(opts.stuckLaunch === true ? { endStuckLaunch: hold('endStuckLaunch') } : {}),
  }
}

describe('the holds\' set observer: the slow-recovery end is the fourth hold (SRJ-502, SRJ-610, SRJ-1016)', () => {
  test('on a set the four holds run for the persona in order, before a notice observer bound after them; a hold that throws is logged and the slow-recovery end still runs', () => {
    const { latch, lines } = makeLatchRun()
    const calls: Array<readonly [string, string]> = []
    bindConflictLatchHolds(latch, recordingHolds(calls, { throwAt: 'endUnclassifiedError' }), (line) => lines.push(line))
    latch.addSetObserver(({ key }) => {
      calls.push(['notice', key])
    })
    latchOnRow(latch, KEY, ROWS[0]![1])
    expect(calls).toEqual([
      ['stopRetryTimer', KEY],
      ['endTmuxUnresponsive', KEY],
      ['endUnclassifiedError', KEY],
      ['endSlowRecovery', KEY],
      ['notice', KEY],
    ])
    expect(lines.filter((line) => line.includes(' hold failed '))).toEqual([expect.stringContaining(`persona=${KEY} hold failed (unclassified-error end): `)])
  })

  test('holds with no slow-recovery end run the other three and log no failure', () => {
    const { latch, lines } = makeLatchRun()
    const calls: Array<readonly [string, string]> = []
    bindConflictLatchHolds(latch, recordingHolds(calls, { slowRecovery: false }), (line) => lines.push(line))
    latchOnRow(latch, KEY, ROWS[0]![1])
    expect(calls.map(([name]) => name)).toEqual(['stopRetryTimer', 'endTmuxUnresponsive', 'endUnclassifiedError'])
    expect(lines.filter((line) => line.includes(' hold failed '))).toEqual([])
  })
})

describe('the holds\' set observer: the stuck-launch end is the fifth hold (SRJ-502, SRJ-1016)', () => {
  test('on a latch, a relatch and a same-case set the five holds run for the persona in order, the stuck-launch end last, before a notice observer bound after them; a throwing slow-recovery end is logged and the stuck-launch end still runs', () => {
    const { latch, lines } = makeLatchRun()
    const calls: Array<readonly [string, string]> = []
    bindConflictLatchHolds(latch, recordingHolds(calls, { stuckLaunch: true, throwAt: 'endSlowRecovery' }), (line) => lines.push(line))
    latch.addSetObserver(({ key }) => {
      calls.push(['notice', key])
    })
    const first = ROWS[0]![1]
    const other = rowWhere((row) => row.latchCase !== first.latchCase)
    const fiveHolds: Array<readonly [string, string]> = [
      ['stopRetryTimer', KEY],
      ['endTmuxUnresponsive', KEY],
      ['endUnclassifiedError', KEY],
      ['endSlowRecovery', KEY],
      ['endStuckLaunch', KEY],
      ['notice', KEY],
    ]
    expect([latchOnRow(latch, KEY, first), latchOnRow(latch, KEY, other), latchOnRow(latch, KEY, other)]).toEqual([
      CONFLICT_LATCH_SET_LATCHED,
      CONFLICT_LATCH_SET_RELATCHED,
      CONFLICT_LATCH_SET_SAME_CASE,
    ])
    expect(calls).toEqual([...fiveHolds, ...fiveHolds, ...fiveHolds])
    expect(lines.filter((line) => line.includes(' hold failed '))).toEqual(
      [1, 2, 3].map(() => expect.stringContaining(`persona=${KEY} hold failed (slow-recovery end): `)),
    )
  })

  test('a stuck-launch end that throws is logged under its name and the next set still runs every hold', () => {
    const { latch, lines } = makeLatchRun()
    const calls: Array<readonly [string, string]> = []
    bindConflictLatchHolds(latch, recordingHolds(calls, { stuckLaunch: true, throwAt: 'endStuckLaunch' }), (line) => lines.push(line))
    latchOnRow(latch, KEY, ROWS[0]![1])
    latchOnRow(latch, OTHER, ROWS[0]![1])
    expect(calls.filter(([name]) => name === 'endStuckLaunch')).toEqual([['endStuckLaunch', KEY], ['endStuckLaunch', OTHER]])
    expect(lines.filter((line) => line.includes(' hold failed '))).toEqual([
      expect.stringContaining(`persona=${KEY} hold failed (stuck-launch end): `),
      expect.stringContaining(`persona=${OTHER} hold failed (stuck-launch end): `),
    ])
  })
})

// ---------------------------------------------------------------------------
// AC 46's automated half, on the recovery harness (SRJ-502, SRJ-501, SRJ-508)
// ---------------------------------------------------------------------------

/** Every recovery harness of this test, leak-checked and cleaned up in `afterEach`. */
let harnesses: RecoveryHarness[] = []

afterEach(() => {
  const built = harnesses
  harnesses = []
  _resetHealthCheckState()
  for (const h of built) {
    try {
      assertNoLeak(h.captured())
    } finally {
      h.cleanup()
    }
  }
})

/** The restart delay the restart module reads; never waited out: a case fires the restart timer by hand. */
const RESTART_DELAY_S = 1

interface AutomatedPathsRun {
  readonly h: RecoveryHarness
  /** Each restart work's outcome, as its serialized turn answered it, in order. */
  readonly outcomes: Array<readonly [string, unknown]>
  /** Mark persona `key`'s row dead: its `status` reads `ended` until its next spawn resolves, then `waiting`. */
  readonly killRow: (key: string) => void
  /** Persona `key`'s row reads `working` from now on, whatever its spawns answer. */
  readonly readWorking: (key: string) => void
  /** Persona `key`'s row reads `pending` with no launch start from now on, whatever its spawns answer (b.jg5 SRJ-513). */
  readonly readPendingNoLaunchStart: (key: string) => void
  /**
   * Persona `key`'s row reads `pending` with the stub's launch start while
   * `pending` is true (the default), whatever its spawns answer; false puts
   * back the reads above.
   */
  readonly readPending: (key: string, pending?: boolean) => void
  /** Persona `key`'s `status` answers `err` from now on. */
  readonly failStatus: (key: string, err: Error) => void
  /** Persona `key`'s next `status` answers `err`; the reads above follow it. */
  readonly failStatusOnce: (key: string, err: Error) => void
}

/**
 * A recovery harness with both settings 0, every persona's row read `ended`
 * until a spawn of it resolves (`waiting` from then on), and the restart
 * module's serialized turns recorded. The restart module's delay accessor
 * answers `RESTART_DELAY_S`, so `scheduleRestart` arms its timer (with the
 * setting 0 it arms none); the configuration keeps `session_restart_delay` 0.
 * `options` go to the harness (the approver's cap, for instance).
 */
function makeAutomatedPathsRun(options: Omit<RecoveryHarnessOptions, 'restartDeps'> = {}): AutomatedPathsRun {
  const outcomes: Array<readonly [string, unknown]> = []
  let serializer: PersonaSerializer | undefined
  const serialize: PersonaSerialize = (key, operation) =>
    serializer!.run(key, async () => {
      const outcome = await operation()
      outcomes.push([key, outcome])
      return outcome
    })
  const h = makeRecoveryHarness({ ...options, restartDeps: { getRestartDelay: () => RESTART_DELAY_S, serialize } })
  harnesses.push(h)
  serializer = h.serializer
  const live = new Set<string>()
  const working = new Set<string>()
  const noLaunchStart = new Set<string>()
  const pending = new Set<string>()
  const statusErrors = new Map<string, Error>()
  const statusErrorsOnce = new Map<string, Error>()
  const spawn = h.stub.client.spawn.bind(h.stub.client)
  h.stub.client.spawn = async (params) => {
    const result = await spawn(params)
    live.add(String(params.claude_instance_id))
    return result
  }
  h.script({
    statusFn: (params) => {
      const id = String(params.claude_instance_id)
      const once = statusErrorsOnce.get(id)
      if (once !== undefined) {
        statusErrorsOnce.delete(id)
        return once
      }
      const err = statusErrors.get(id)
      if (err !== undefined) return err
      if (noLaunchStart.has(id)) return cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_NONE })
      if (pending.has(id)) return cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE })
      return cannedStatusResult({ state: working.has(id) ? 'working' : live.has(id) ? 'waiting' : 'ended' })
    },
  })
  return {
    h,
    outcomes,
    killRow: (key) => live.delete(personaInstanceId(key)),
    readWorking: (key) => working.add(personaInstanceId(key)),
    readPendingNoLaunchStart: (key) => noLaunchStart.add(personaInstanceId(key)),
    readPending: (key, isPending = true) => {
      if (isPending) pending.add(personaInstanceId(key))
      else pending.delete(personaInstanceId(key))
    },
    failStatus: (key, err) => statusErrors.set(personaInstanceId(key), err),
    failStatusOnce: (key, err) => statusErrorsOnce.set(personaInstanceId(key), err),
  }
}

/**
 * Run `arm` with the global `kind` swapped for a recorder and answer the
 * callbacks it set, never scheduled: the restart timer and the health
 * interval take no clock, so a case fires them by hand and no real timer runs.
 */
function armedTimers(kind: 'setTimeout' | 'setInterval', arm: () => void): Array<() => unknown> {
  const g = globalThis as unknown as Record<string, unknown>
  const saved = g[kind]
  const callbacks: Array<() => unknown> = []
  g[kind] = (callback: () => unknown) => {
    callbacks.push(callback)
    return 0
  }
  try {
    arm()
  } finally {
    g[kind] = saved
  }
  return callbacks
}

/** Run `arm`, which sets exactly one timer through the global `kind` (`armedTimers`), and answer that timer's callback. */
function captureTimer(kind: 'setTimeout' | 'setInterval', arm: () => void): () => Promise<void> {
  const callbacks = armedTimers(kind, arm)
  if (callbacks.length !== 1) throw new Error(`expected one ${kind}, got ${callbacks.length}`)
  return async () => {
    await callbacks[0]()
  }
}

/** The stub's launch answers back to their defaults (the row reads stay). */
const CLEARED: RecoveryStubScript = { spawnError: undefined, spawnQueue: undefined, getResult: undefined, resumeError: undefined, readPaneError: undefined }

/**
 * One relaunch of a row read `ended`: its liveness read, the spawn and the
 * launch's own read. No kill: the liveness read read the row finished, and
 * no automated path kills a row it has just read `ended` (b.jg5 SRJ-110,
 * SRJ-314, option A).
 */
const RELAUNCH = { statusCalls: 2, spawnCalls: 1 }

/** The latch's reaction to one set of P, as `latchSteps` reads it: the set, the three holds in order, then the notice. */
const oneLatch = (key: string) => [
  ['set', key],
  ['hold', key, 'retry timer stop'],
  ['hold', key, 'tmux-unresponsive end'],
  ['hold', key, 'unclassified-error end'],
  ['notice', key],
]
const latchSteps = (h: RecoveryHarness) =>
  h.latchEvents.map((event) => (event.step === 'hold' ? [event.step, event.key, event.hold] : [event.step, event.key]))

/** The one line a restart request for latched persona `key` logs instead of arming a timer. */
const notSchedulingLine = (key: string) =>
  `[slack] Not scheduling restart for persona=${key} — the persona is latched; no timer armed (b.jg5 SRJ-502)`

/** What `driveEveryPath` saw. */
interface EveryPathRun {
  /** Each new launch's answer: P's, then Q's. */
  readonly launched: unknown[]
  /** What Q's run of each path called, by path name. */
  readonly qCalls: Array<readonly [string, Record<string, number>]>
  /** The lines naming P that each restart request for P logged. */
  readonly notScheduledLines: string[][]
  /** How many retry attempts were recorded before the retry timer's path. */
  readonly attemptsBefore: number
}

/**
 * Drive, for latched P and then for Q with its row dead, a new launch, the
 * retry entry, a scheduled restart, a human-triggered restart request and
 * the retry timer (armed, then over several waits), recording what Q's run
 * of each path called. A restart request for P arms no timer; Q's one timer
 * is fired by hand.
 */
async function driveEveryPath({ h, killRow }: AutomatedPathsRun): Promise<EveryPathRun> {
  const [p, q] = h.keys as [string, string]
  const cwdOf = (key: string): string => personaOf(h, key).working_directory
  const qCalls: Array<readonly [string, Record<string, number>]> = []
  /** Drive `path` for P, then for Q with its row dead, recording what Q's run called. */
  async function drive(name: string, path: (key: string) => Promise<unknown>): Promise<void> {
    await path(p)
    await h.settle()
    killRow(q)
    const before = personaCallCounts(h, q)
    await path(q)
    await h.settle()
    qCalls.push([name, callCountsSince(personaCallCounts(h, q), before)])
  }

  /**
   * Schedule a restart for `key` (`opts` as given): for latched P, no timer is
   * armed and the one line saying so is logged; for Q, its one timer is fired.
   */
  const notScheduledLines: string[][] = []
  async function scheduleFor(key: string, opts?: { humanTrigger: true }): Promise<void> {
    const from = h.errors.length
    const timers = armedTimers('setTimeout', () => scheduleRestart(key, cwdOf(key), undefined, opts))
    if (key !== p) {
      expect(timers).toHaveLength(1)
      await timers[0]!()
      return
    }
    expect(timers).toEqual([])
    expect(isRestartPendingOrActive(p)).toBe(false)
    notScheduledLines.push(h.errors.slice(from).filter((line) => line.includes(`persona=${p}`)))
  }

  const launched: unknown[] = []
  await drive('a new launch', async (key) => launched.push(await h.launch(key)))
  await drive('the retry entry', (key) => runRestartRetry(key, cwdOf(key), isLaunchInFlight))
  await drive('a scheduled restart', (key) => scheduleFor(key))
  await drive('a human-triggered restart', (key) => scheduleFor(key, { humanTrigger: true }))
  const attemptsBefore = h.attempts.length
  await drive('the retry timer', async (key) => {
    h.controller.arm(key, { kind: UNAVAILABLE_RETRY_CAUSE_READ_ERROR })
    await h.advance(4 * UNAVAILABLE_RETRY_CEILING_S * 1000)
  })
  return { launched, qCalls, notScheduledLines, attemptsBefore }
}

/**
 * One health tick, its latched query bound as `main()` binds it, with Q's row
 * read dead first; answers the keys it scheduled a restart for and what Q's
 * part of the tick called.
 */
async function runHealthTick({ h, killRow }: AutomatedPathsRun): Promise<{ scheduled: string[]; qCalls: Record<string, number> }> {
  const q = h.keys[1]!
  const scheduled: string[] = []
  initHealthCheck({
    isSessionAlive: _buildIsSessionAliveAdapter(() => h.config),
    isSessionConnected: () => false,
    hasSessionStream: () => false,
    isRestartPendingOrActive,
    isLaunchInFlight,
    isLatched: (key) => h.latch.isLatched(key),
    isAtCap: (key) => isAtCap(key, RESTART_FAILURE_CAP),
    statRoute: async () => true,
    scheduleRestart: (key) => {
      scheduled.push(key)
    },
    isShuttingDown: () => false,
    getPersonas: () => Object.fromEntries(h.keys.map((key) => [key, personaOf(h, key).working_directory])),
    endTmuxUnresponsive: (key) => {
      h.tickEnd(key)
    },
    onTickEnd: (startedAt) => h.tickOnset(startedAt),
    now: h.clock.now,
  })
  killRow(q)
  const qBeforeTick = personaCallCounts(h, q)
  await captureTimer('setInterval', () => startHealthCheck(1))()
  stopHealthCheck()
  return { scheduled, qCalls: callCountsSince(personaCallCounts(h, q), qBeforeTick) }
}

/** What Q's run of each `driveEveryPath` path calls: Q is unlatched, so each reaches the stub. */
const Q_CALLS_ON_EVERY_PATH = [
  ['a new launch', { spawnCalls: 1, statusCalls: 1 }],
  ['the retry entry', RELAUNCH],
  ['a scheduled restart', RELAUNCH],
  ['a human-triggered restart', RELAUNCH],
  ['the retry timer', { ...RELAUNCH, statusCalls: RELAUNCH.statusCalls + 1 }],
] as const

/**
 * The retry timer path's attempts after `attemptsBefore`, as `[key, retry]`
 * (b.jg5 SRJ-301, SRJ-409): Q's successful launches on the earlier paths left
 * its timer armed in pending-only mode, so it fires first while P's timer is
 * driven, reads Q's row live out of pending and stops; P's timer fires once
 * and stops latched, with no call; then Q's own timer runs its relaunch,
 * whose success arms pending-only again, and reads its row live out of
 * pending.
 */
const retryTimerAttempts = (p: string, q: string): Array<[string, number]> => [[q, 1], [p, 1], [q, 1], [q, 2]]

describe('AC 46: no automated path kills, launches or recovers a latched persona (recovery harness)', () => {
  const plainSpawnRow = rowWhere(
    (row) => row.refusedOperation === REFUSED_OPERATION_PLAIN_SPAWN && row.latchCase === LATCH_CASE_LEFTOVER && row.rowState !== LATCH_ROW_STATE_NO_ROW,
  )
  const resumeRow = rowWhere((row) => row.refusedOperation === REFUSED_OPERATION_RESUME && row.latchCase === LATCH_CASE_OWN_ID)
  /** How each row latches P through the launch driver: its first spawn refused, or the resume of its `ended` row. */
  const LATCH_ROWS: ReadonlyArray<readonly [string, ConflictCaseRow, (h: RecoveryHarness, key: string) => RecoveryStubScript]> = [
    ['a plain spawn', plainSpawnRow, () => ({ spawnError: plainSpawnRow.build() })],
    ['a resume', resumeRow, (h, key) => ({ ...collided(h, personaOf(h, key), { state: 'ended' }), resumeError: resumeRow.build() })],
  ]
  test.each(LATCH_ROWS)('P latched at %s: a new launch, the retry entry, a scheduled restart, a human-triggered restart, the retry timer and the health tick make no kill, spawn, resume or delete for P; one CONFLICT post; Q\'s paths reach the stub as before', async (_label, row, latchScript) => {
    const run = makeAutomatedPathsRun()
    const { h, outcomes } = run
    const [p, q] = h.keys as [string, string]

    h.script(latchScript(h, p))
    expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })
    expect(h.latch.record(p)).toMatchObject({
      sessionName: row.sessionName,
      latchCase: row.latchCase,
      refusedOperation: row.refusedOperation,
      rowState: row.rowState,
    })
    h.script(CLEARED)
    const pAtLatch = personaCallCounts(h, p)
    const { launched, qCalls, notScheduledLines, attemptsBefore } = await driveEveryPath(run)
    // Each request for P logged the not-scheduling line once, and nothing else naming P.
    expect(notScheduledLines).toEqual([[notSchedulingLine(p)], [notSchedulingLine(p)]])
    // The new launch met the latched gate: its one line, naming P and the latch's case (SRJ-502, SRJ-1014).
    expect(h.errors.filter((line) => line === latchedLaunchSkipLine(`[slack] ${COLLISION_GET_SITE.site}:`, personaRefOf(h, p), row.latchCase))).toHaveLength(1)

    const { scheduled, qCalls: qTickCalls } = await runHealthTick(run)
    qCalls.push(['the health tick', qTickCalls])

    // P: since the latch, only the tick's liveness read; never a kill of its instance.
    expect(callCountsSince(personaCallCounts(h, p), pAtLatch)).toEqual({ statusCalls: 1 })
    expect(h.stub.calls.killCalls.filter((call) => call.claude_instance_id === personaInstanceId(p))).toEqual([])
    expect(launched).toEqual([{ key: p, action: 'latched' }, { key: q, action: 'spawned' }])
    // P's only serialized work is the retry entry's, answered latched; neither restart request armed a timer for it.
    expect(outcomes).toEqual([
      [p, RESTART_OUTCOME_LATCHED],
      ...[1, 2, 3, 4].map(() => [q, RESTART_OUTCOME_LAUNCHED] as const),
    ])
    expect(isRestartPendingOrActive(p)).toBe(false)
    // P's timer fired once and stopped as latched, with no call (Q's pending-only watch and relaunch around it: retryTimerAttempts).
    expect(h.attempts.slice(attemptsBefore).map((a) => [a.key, a.retry])).toEqual(retryTimerAttempts(p, q))
    expect(h.stops.filter((stop) => stop.key === p)).toEqual([{ key: p, reason: UNAVAILABLE_RETRY_STOP_LATCHED }])
    expect(h.controller.armedKeys()).toEqual([])
    expect(scheduled).toEqual([q])
    expect([getFailureCount(p), getFailureCount(q)]).toEqual([0, 0])

    // One latch, one CONFLICT post, no spawn-failure notice or spawn-failed entry.
    expect(latchSteps(h)).toEqual(oneLatch(p))
    expect(h.episodeNotices).toEqual([{ key: p, text: row.notice.text }])
    expect(h.notices).toEqual([])
    expect(h.startupErrors()).toEqual([])
    expect(h.latch.isLatched(q)).toBe(false)

    // Q, beside it, still reaches the stub on every path.
    expect(qCalls).toEqual([...Q_CALLS_ON_EVERY_PATH, ['the health tick', { statusCalls: 1 }]])
  })

  test.each([
    ['UNAVAILABLE (ErrTmuxUnresponsive)', (): Error => errTmuxUnresponsive('status'), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE, false],
    ['UNAVAILABLE (ErrCallTimeout)', (): Error => errCallTimeout('status'), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE, false],
    // A read verb's UNCLASSIFIED answer arms with the read-error cause.
    ['UNCLASSIFIED (ErrInternal)', (): Error => errInternal(), UNAVAILABLE_RETRY_CAUSE_READ_ERROR, true],
  ] as const)('a latch-time status read answering %s: read, then set, then the holds, then the notice; no retry timer, tmux-unresponsive condition or unclassified episode is left open for P', async (_label, readError, cause, opensEpisode) => {
    const { h } = makeAutomatedPathsRun()
    const [p, q] = h.keys as [string, string]

    // P's condition holds and its timer is armed: a launch whose spawn tmux did not answer.
    h.script({ spawnError: errTmuxUnresponsive('spawn') })
    expect((await h.launch(p)).action).toBe(SPAWN_ACTION_RETRYING)
    expect([h.tmuxUnresponsive.holds(p), h.controller.isArmed(p)]).toEqual([true, true])

    // Then a launch whose first spawn answers a CONFLICT; nothing was read before it, so one status read follows.
    const err = readError()
    const atRead: unknown[] = []
    h.script({
      spawnError: plainSpawnRow.build(),
      statusFn: () => {
        atRead.push({ latchSteps: h.latchEvents.length, latched: h.latch.isLatched(p) })
        return err
      },
    })
    const atNotice: unknown[] = []
    const post = h.episodeNotices.push.bind(h.episodeNotices)
    h.episodeNotices.push = (...notices) => {
      atNotice.push({
        armed: h.controller.isArmed(p),
        conditionHolds: h.tmuxUnresponsive.holds(p),
        episodeOpen: h.unclassifiedErrorOpen(p),
        latched: h.latch.isLatched(p),
      })
      return post(...notices)
    }
    const triggersBefore = h.triggers.length

    expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })

    // Read: before any set, and its error reached the timer and (UNCLASSIFIED) the episode, which the latch ended.
    expect(atRead).toEqual([{ latchSteps: 0, latched: false }])
    expect(h.triggers.slice(triggersBefore)).toEqual([{ key: p, kind: cause }])
    const episodeLines = opensEpisode ? [unclassifiedStartedLine(p, err), unclassifiedEndedLine(p, UNCLASSIFIED_ERROR_END_LATCHED)] : []
    expect(unclassifiedLines(h, p)).toEqual(episodeLines)
    // Set, with the read's state (unreadable), then the holds in order, then the notice.
    expect(h.latch.record(p)).toMatchObject({ refusedOperation: REFUSED_OPERATION_PLAIN_SPAWN, rowState: LATCH_ROW_STATE_UNREADABLE })
    expect(latchSteps(h)).toEqual(oneLatch(p))
    expect(h.stops).toEqual([{ key: p, reason: UNAVAILABLE_RETRY_STOP_LATCHED }])
    expect(h.lines.includes(conditionEndedLine(p, TMUX_UNRESPONSIVE_END_LATCHED))).toBe(true)
    expect(h.lines.includes(conditionRecoveryLine(p))).toBe(false)
    // By the notice every hold had run.
    expect(atNotice).toEqual([{ armed: false, conditionHolds: false, episodeOpen: false, latched: true }])
    expect(h.episodeNotices).toEqual([{ key: p, text: plainSpawnRow.notice.text }])

    // Nothing is left to fire for P: several waits on, then past twice the alert threshold in effect, no attempt, no call and no unclassified alert.
    const pCalls = personaCallCounts(h, p)
    await h.advance(4 * UNAVAILABLE_RETRY_CEILING_S * 1000)
    await h.advance(2 * adAlertThresholdMsInEffect())
    expect([h.attempts, personaCallCounts(h, p), h.controller.armedKeys(), h.clock.pendingCount()]).toEqual([[], pCalls, [], 0])
    expect(unclassifiedLines(h, p)).toEqual(episodeLines)
    expect(h.episodeNotices).toEqual([{ key: p, text: plainSpawnRow.notice.text }])
    expect(h.notices).toEqual([])
    expect(personaCallCounts(h, q)).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-1002 (SRJ-501, SRJ-512): a CONFLICT or an UNUSABLE NAME met for a
// persona no longer in the applied configuration latches nothing, on the
// recovery harness (its configured-persona query over the live applied set)
// ---------------------------------------------------------------------------

/** The site labels the not-configured cases give the shared read-pane and the restart path's kill latch. */
const NOT_CONFIGURED_PANE_SITE = 'notConfiguredPaneRead'
const NOT_CONFIGURED_KILL_SITE = 'notConfiguredKill'

/** A latch entry run for persona `key` of `h` meeting the answer `err`. */
type LatchEntryRun = (h: RecoveryHarness, key: string, err: Error) => Promise<unknown>

/**
 * The latch entries a CONFLICT or an UNUSABLE NAME reaches, each with a
 * CONFLICT row and an UNUSABLE NAME row of its site: the restart path's kill
 * (`latchOnRestartKillOutcome`: the CONFLICT and unusable-name entries with
 * the state the run read, `ended`) and the shared read-pane
 * (`readPersonaOwnPane`: the latch-on-answer entries). The launch site's guard
 * is tests/session-manager.test.ts's.
 */
const NOT_CONFIGURED_ENTRIES: ReadonlyArray<readonly [string, LatchEntryRun, () => ConflictCaseRow, () => UnusableNameCaseRow]> = [
  [
    'the restart path\'s kill',
    (_h, key, err) => latchOnRestartKillOutcome(key, killOutcomeOf({ thrown: err }), NOT_CONFIGURED_KILL_SITE, LIVENESS_READING_DEAD_ENDED),
    () => RESTART_KILL_CONFLICT_CASE_ROWS[0]!,
    () => RESTART_KILL_UNUSABLE_NAME_CASE_ROWS[0]!,
  ],
  [
    'the shared read-pane',
    (h, key, err) => {
      h.script({ readPaneError: err })
      return readPersonaOwnPane(key, { nLines: PROBE_PANE_READ_LINES, lastRead: ENDED, site: NOT_CONFIGURED_PANE_SITE })
    },
    () => livenessPaneConflictRowsAt('working-row verdict')[0]!,
    () => UNUSABLE_NAME_CASE_ROWS.find((row) => row.site === 'read-pane')!,
  ],
]

describe('SRJ-1002: a CONFLICT or an UNUSABLE NAME met for a persona no longer in the applied configuration sets no latch, posts nothing and writes no startup-errors entry, with one line naming the persona, the case and the refused operation; a configured persona beside it latches (recovery harness; SRJ-501, SRJ-512, SRJ-1002, SRJ-1014)', () => {
  const CASES = NOT_CONFIGURED_ENTRIES.flatMap(([entry, run, conflictRow, unusableRow]) => [
    [entry, 'a CONFLICT', run, (): Error => conflictRow().build(), (): LatchCase => conflictRow().latchCase, REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY],
    [entry, 'an UNUSABLE NAME', run, (): Error => unusableRow().build(), (): LatchCase => LATCH_CASE_UNUSABLE_RECORDED_NAME, REFUSED_OPERATION_NONE],
  ] as const)

  test.each(CASES)('%s meeting %s: P, removed, is not latched and gets no post or entry, its one line carrying the not-configured outcome; Q, applied, latches with one post', async (_entry, _answer, run, build, latchCaseOf, operation) => {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    const [p, q] = h.keys as [string, string]
    h.remove(p)

    await run(h, p, build())
    await run(h, q, build())

    const outcome = notConfiguredLatchOutcome(latchCaseOf(), operation)
    const outcomeLines = h.errors.filter((line) => line.includes(outcome))
    expect(outcomeLines).toHaveLength(1)
    expect([outcomeLines[0]!.includes(p), outcomeLines[0]!.includes(q)]).toEqual([true, false])
    // Latches nothing: no latch entry, no latch event and no post for P.
    expect([h.latch.isLatched(p), h.latch.record(p), h.latchEvents.filter((event) => event.key === p)]).toEqual([false, undefined, []])
    expect(h.episodeNotices.map((notice) => notice.key)).toEqual([q])
    expect(h.latch.record(q)?.latchCase).toBe(latchCaseOf())
    expect([h.notices, h.startupErrors()]).toEqual([[], []])
  })

  // b.jg5 SRJ-1002: a throwing query latches as a configured persona, with
  // one line naming the persona and the thrown value (`latchEntryQueryFailedLine`).
  const QUERY_BROKE = new Error('the query broke')
  test.each(NOT_CONFIGURED_ENTRIES.flatMap(([entry, run, conflictRow, unusableRow]) => [
    [entry, 'a CONFLICT', 'no configured-persona query installed', run, conflictRow, () => _resetConfiguredPersonaQuery(), 0],
    [entry, 'a CONFLICT', 'a configured-persona query that throws', run, conflictRow, () => setConfiguredPersonaQuery(() => { throw QUERY_BROKE }), 1],
    [entry, 'an UNUSABLE NAME', 'a configured-persona query that throws', run, unusableRow, () => setConfiguredPersonaQuery(() => { throw QUERY_BROKE }), 1],
  ] as const))('%s meeting %s with %s: a removed P latches as a configured persona would, with one post and no not-configured line; a throwing query logs its one query-failed line', async (_entry, _answer, _query, run, row, install, queryFailedLines) => {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    const [p] = h.keys as [string]
    h.remove(p)
    install()

    await run(h, p, row().build())

    expect(h.latch.record(p)?.latchCase).toBe(row().latchCase)
    expect(h.episodeNotices.map((notice) => notice.key)).toEqual([p])
    expect(h.errors.filter((line) => line.includes(notConfiguredLatchOutcome(row().latchCase, row().refusedOperation)))).toEqual([])
    expect(h.errors.filter((line) => line === latchEntryQueryFailedLine(p, describeThrownValue(QUERY_BROKE)))).toHaveLength(queryFailedLines)
  })

  // b.jg5 SRJ-1002, SRJ-1003: the guard reads P's teardown window through the
  // installed notice episodes (`setStuckLaunchEpisodes`; here real episodes
  // whose teardown query answers `window`). Inside an open window a removed P
  // latches as a configured persona (its notice goes through the latch's
  // episodes; the persona notifier's window routing is
  // tests/persona-lifecycle.test.ts's); a window only `submitted` is not
  // open, so P is routed log-only as with none.
  test.each(NOT_CONFIGURED_ENTRIES.flatMap(([entry, run, conflictRow, unusableRow]) =>
    (['open', 'submitted'] as const).flatMap((window) => [
      [entry, 'a CONFLICT', window, run, conflictRow],
      [entry, 'an UNUSABLE NAME', window, run, unusableRow],
    ] as const),
  ))('%s meeting %s for a removed P whose teardown window is %s: latched with one post only while the window is open, else the one not-configured line', async (_entry, _answer, window, run, row) => {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    const [p] = h.keys as [string]
    h.remove(p)
    const windowSinkPosts: string[] = []
    const windowClock = createFakeClock()
    setStuckLaunchEpisodes(createPersonaEpisodes({ sink: (key) => void windowSinkPosts.push(key), log: () => {}, clock: windowClock, teardownWindow: () => window }))

    await run(h, p, row().build())

    const open = window === 'open'
    expect(h.latch.record(p)?.latchCase).toBe(open ? row().latchCase : undefined)
    expect(h.episodeNotices.map((notice) => notice.key)).toEqual(open ? [p] : [])
    expect(h.errors.filter((line) => line.includes(notConfiguredLatchOutcome(row().latchCase, row().refusedOperation)))).toHaveLength(open ? 0 : 1)
    expect([windowSinkPosts, windowClock.pendingCount(), h.startupErrors()]).toEqual([[], 0, []])
  })
})

// ---------------------------------------------------------------------------
// SRJ-610, SRJ-1016, SRJ-502: a latch ends P's open slow-recovery episode
// silently and resets its count, through the harness's hold observer as
// main() binds it; Q's episode is left as it is
// ---------------------------------------------------------------------------

describe('SRJ-610, SRJ-1016, SRJ-502: P\'s latch ends its open slow-recovery episode silently and resets its count; Q\'s is untouched (recovery harness)', () => {
  /** The working-row verdict's `read-pane` CONFLICT row: P's next run latches P through the latch's set entry. */
  const workingRowConflict = livenessPaneConflictRowsAt('working-row verdict')[0]!
  const SLOW = PERSONA_EPISODE_KIND_SLOW_DEAD_SESSION_RECOVERY
  /** `key`'s slow-recovery lines among `lines`. */
  const slowLinesOf = (lines: readonly string[], key: string): string[] =>
    lines.filter((line) => line.startsWith(`[slack] slow-recovery: persona=${key} `))

  test('P\'s and Q\'s episodes open after three escalate-dead runs each whose re-probe reads the row live; P\'s CONFLICT latches it: by the CONFLICT notice its count is 0 and its episode ended, with the latched reason and no slow-recovery post; exactly one CONFLICT post; later runs for P post nothing; Q keeps its count and open episode; cleanup leaves no count or episode', async () => {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    const [p, q] = h.keys as [string, string]
    const cwdOf = (key: string): string => personaOf(h, key).working_directory
    const run = (key: string) => runRestartRetry(key, cwdOf(key), isLaunchInFlight)

    // Both rows read `working` and each pane read answers GONE: every run's
    // working-row verdict sweeps and escalates dead, and its re-probe still
    // reads the row live, so each run is one of the tracker's notes.
    h.script({ statusResult: cannedStatusResult({ state: 'working' }), readPaneError: errTmuxCaptureFailed() })
    for (let tick = 0; tick < SLOW_RECOVERY_POST_THRESHOLD; tick++) {
      expect([await run(p), await run(q)]).toEqual([RESTART_OUTCOME_RECONNECT_DEFERRED, RESTART_OUTCOME_RECONNECT_DEFERRED])
    }
    await h.settle()
    // Open, through the tracker and through the harness's episodes view.
    for (const key of [p, q]) {
      expect([key, h.slowRecovery.count(key), h.slowRecovery.isOpen(key), h.episodes.count(key, SLOW), h.episodes.isOpen(key, SLOW)])
        .toEqual([key, SLOW_RECOVERY_POST_THRESHOLD, true, SLOW_RECOVERY_POST_THRESHOLD, true])
    }
    expect(h.episodeNotices).toEqual([{ key: p, text: slowRecoveryText(p) }, { key: q, text: slowRecoveryText(q) }])
    expect([h.latchEvents, h.stub.calls.killCalls, h.stub.calls.spawnCalls]).toEqual([[], [], []])

    // What P's and Q's slow-recovery state is when the CONFLICT notice is posted.
    const atNotice: unknown[] = []
    const post = h.episodeNotices.push.bind(h.episodeNotices)
    h.episodeNotices.push = (...notices) => {
      atNotice.push([h.slowRecovery.count(p), h.slowRecovery.isOpen(p), h.slowRecovery.count(q), h.slowRecovery.isOpen(q)])
      return post(...notices)
    }

    // P's next run: its working-row read-pane answers a CONFLICT, which latches P.
    const linesBefore = h.lines.length
    h.script({ readPaneError: workingRowConflict.build() })
    await run(p)
    await h.settle()
    expect(h.latch.record(p)).toMatchObject({
      sessionName: workingRowConflict.sessionName,
      latchCase: workingRowConflict.latchCase,
      refusedOperation: workingRowConflict.refusedOperation,
      rowState: workingRowConflict.rowState,
    })
    expect(latchSteps(h)).toEqual(oneLatch(p))
    // By the notice the latch's hold had reset P's count and ended its episode; Q's were as before.
    expect(atNotice).toEqual([[0, false, SLOW_RECOVERY_POST_THRESHOLD, true]])
    // Silently: no slow-recovery post, exactly one CONFLICT post; the ended lines carry the latched reason.
    expect(h.episodeNotices).toEqual([
      { key: p, text: slowRecoveryText(p) },
      { key: q, text: slowRecoveryText(q) },
      { key: p, text: workingRowConflict.notice.text },
    ])
    const latchRunLines = h.lines.slice(linesBefore)
    expect(slowLinesOf(latchRunLines, p)).toEqual([
      slowRecoveryCountResetLine(p, SLOW_RECOVERY_POST_THRESHOLD, SLOW_RECOVERY_RESET_LATCHED),
      slowRecoveryEpisodeEndedLine(p, SLOW_RECOVERY_RESET_LATCHED),
    ])
    expect(slowLinesOf(latchRunLines, q)).toEqual([])

    // Later runs for P are latched: no call, no count, no slow-recovery post.
    const pCalls = personaCallCounts(h, p)
    for (let tick = 0; tick < SLOW_RECOVERY_POST_THRESHOLD; tick++) expect(await run(p)).toBe(RESTART_OUTCOME_LATCHED)
    expect([personaCallCounts(h, p), h.slowRecovery.count(p), h.slowRecovery.isOpen(p), h.episodes.isOpen(p, SLOW)]).toEqual([pCalls, 0, false, false])
    expect(h.episodeNotices).toHaveLength(3)
    // Q, not latched, keeps its count and its open episode.
    expect([h.latch.isLatched(q), h.slowRecovery.count(q), h.slowRecovery.isOpen(q)]).toEqual([false, SLOW_RECOVERY_POST_THRESHOLD, true])
    expect(h.clock.pendingCount()).toBe(0)

    // Cleanup leaves no count or open episode behind: Q's are gone with it.
    harnesses = harnesses.filter((built) => built !== h)
    try {
      assertNoLeak(h.captured())
    } finally {
      h.cleanup()
    }
    expect([h.slowRecovery.count(q), h.slowRecovery.isOpen(q), h.clock.pendingCount()]).toEqual([0, false, 0])
  })
})

// ---------------------------------------------------------------------------
// SRJ-1016, SRJ-502: a latch, and a relatch with a new case, end P's open
// stuck-launch episode silently, through the harness's hold observer as
// main() binds it; a later post of the same text posts again; Q's episode is
// left as it is
// ---------------------------------------------------------------------------

describe('SRJ-1016, SRJ-502: P\'s latch and relatch end its open stuck-launch episode silently; a later post posts again; Q\'s is untouched (recovery harness)', () => {
  const STUCK = PERSONA_EPISODE_KIND_STUCK_LAUNCH
  /** P's first latch: the plain first spawn meets the pre-spawn scan's leftover. */
  const leftoverRow = rowWhere(
    (row) => row.refusedOperation === REFUSED_OPERATION_PLAIN_SPAWN && row.stubCase === 'scan-leftover' && row.rowState === LATCH_ROW_STATE_NO_ROW,
  )
  /** The leftover's script: the latch-time `status` read finds no row, as after the scan's refusal, so no read ends a stuck-launch episode and the end is the latch's. */
  const leftoverLatch = (): RecoveryStubScript => ({ spawnError: leftoverRow.build(), statusError: errSpawnNotFound() })
  /** The reading site the own-row read's lines name. */
  const SITE: OwnRowReadSite = { site: 'conflict-latch.test', what: 'own-row get' }

  /** A recovery harness, cleaned up and leak-checked in `afterEach`, and the posters' dependencies over its episodes, as the rule binds them. */
  function makeStuckRun(): { h: RecoveryHarness; p: string; q: string; deps: StuckLaunchPosterDeps } {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    const [p, q] = h.keys as [string, string]
    const deps: StuckLaunchPosterDeps = {
      episodes: h.episodes,
      tmuxUnavailableRaised: (key) => getOutageFlags(key).has('tmux-unavailable'),
      log: (line) => h.lines.push(line),
    }
    return { h, p, q, deps }
  }

  /** `key`'s held post for the stub's launch start, in the attach-line form. */
  const heldPost = (key: string) => ({ key, text: stuckLaunchHeldText(key, SAMPLE_LAUNCH_START_DEFAULT, false) })
  /** `key`'s stuck-launch episode-end lines among `lines`, whatever the reason. */
  const endedLinesOf = (lines: readonly string[], key: string): string[] =>
    lines.filter((line) => line.startsWith(stuckLaunchEpisodeEndedLine(key, '')))
  /** Record P's and Q's episode state when the next episode notice is posted (the CONFLICT notice, after every hold). */
  function stateAtNotice(h: RecoveryHarness, p: string, q: string): unknown[] {
    const atNotice: unknown[] = []
    const post = h.episodeNotices.push.bind(h.episodeNotices)
    h.episodeNotices.push = (...notices) => {
      atNotice.push([h.episodes.isOpen(p, STUCK), h.episodes.isOpen(q, STUCK)])
      return post(...notices)
    }
    return atNotice
  }

  test('a latch: P\'s and Q\'s held posts open their episodes; P\'s CONFLICT latches it, and by the CONFLICT notice P\'s episode is closed with one latched-reason line and no post from the end; Q\'s stays open; P\'s later held post posts again', async () => {
    const { h, p, q, deps } = makeStuckRun()
    expect([postStuckLaunchHeld(deps, p, SAMPLE_LAUNCH_START_DEFAULT, false), postStuckLaunchHeld(deps, q, SAMPLE_LAUNCH_START_DEFAULT, false)]).toEqual([
      STUCK_LAUNCH_POSTED,
      STUCK_LAUNCH_POSTED,
    ])
    expect([h.episodes.isOpen(p, STUCK), h.episodes.isOpen(q, STUCK)]).toEqual([true, true])
    // Once per episode: the same text again posts nothing.
    expect(postStuckLaunchHeld(deps, p, SAMPLE_LAUNCH_START_DEFAULT, false)).toBe(STUCK_LAUNCH_ALREADY_POSTED)
    expect(h.episodeNotices).toEqual([heldPost(p), heldPost(q)])

    const atNotice = stateAtNotice(h, p, q)
    const linesBefore = h.lines.length
    h.script(leftoverLatch())
    expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })
    expect(h.latch.record(p)).toMatchObject({ latchCase: leftoverRow.latchCase, rowState: LATCH_ROW_STATE_NO_ROW })
    // The hold is not recorded in latchEvents: one latch is still the set, three holds and the notice.
    expect(latchSteps(h)).toEqual(oneLatch(p))
    // By the notice P's episode was ended; Q's was not.
    expect(atNotice).toEqual([[false, true]])
    // Silently: the only new post is the CONFLICT notice; one ended line, with the latched reason.
    expect(h.episodeNotices).toEqual([heldPost(p), heldPost(q), { key: p, text: leftoverRow.notice.text }])
    expect(endedLinesOf(h.lines.slice(linesBefore), p)).toEqual([stuckLaunchEpisodeEndedLine(p, STUCK_LAUNCH_END_LATCHED)])
    expect(endedLinesOf(h.lines, q)).toEqual([])
    expect([h.episodes.isOpen(p, STUCK), h.episodes.isOpen(q, STUCK)]).toEqual([false, true])

    // A later post of the same text begins a new episode and posts again; Q's episode still holds its post.
    expect(postStuckLaunchHeld(deps, p, SAMPLE_LAUNCH_START_DEFAULT, false)).toBe(STUCK_LAUNCH_POSTED)
    expect(postStuckLaunchHeld(deps, q, SAMPLE_LAUNCH_START_DEFAULT, false)).toBe(STUCK_LAUNCH_ALREADY_POSTED)
    expect(h.episodeNotices).toEqual([heldPost(p), heldPost(q), { key: p, text: leftoverRow.notice.text }, heldPost(p)])
    expect(h.episodes.isOpen(p, STUCK)).toBe(true)
  })

  test('a relatch with a new case: P latched first, then its held post opens an episode; a provenance_conflict note on P\'s own ended row relatches it, and by the new CONFLICT notice P\'s episode is closed with one latched-reason line and no post from the end; Q\'s stays open; P\'s later held post posts again', async () => {
    const { h, p, q, deps } = makeStuckRun()
    h.script(leftoverLatch())
    expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })
    // The first latch ended no stuck-launch episode: none was open.
    expect(endedLinesOf(h.lines, p)).toEqual([])

    // P's own stuck launch gets the relaunching text; Q's row the held text.
    const relaunchingPost = { key: p, text: stuckLaunchRelaunchingText(p, adLaunchBoundMsInEffect()) }
    expect([postStuckLaunchRelaunching(deps, p, adLaunchBoundMsInEffect()), postStuckLaunchHeld(deps, q, SAMPLE_LAUNCH_START_DEFAULT, false)]).toEqual([
      STUCK_LAUNCH_POSTED,
      STUCK_LAUNCH_POSTED,
    ])
    expect([h.episodes.isOpen(p, STUCK), h.episodes.isOpen(q, STUCK)]).toEqual([true, true])

    // An `ended` read ends no stuck-launch episode by itself (SRJ-1016), so the end below is the relatch's.
    const atNotice = stateAtNotice(h, p, q)
    const linesBefore = h.lines.length
    h.script({ spawnError: undefined, getResult: cannedGetResult({ state: 'ended', liveness_note: provenanceNote }, personaOf(h, p), h.home) })
    expect(await readPersonaOwnRow(p, SITE)).toMatchObject({ kind: OWN_ROW_READ_ROW, latched: true })
    expect(h.latch.record(p)?.latchCase).toBe(LATCH_CASE_CONFLICTING_LABELS)
    expect(h.latchEvents.flatMap((event) => (event.step === 'set' ? [event.outcome] : []))).toEqual([CONFLICT_LATCH_SET_LATCHED, CONFLICT_LATCH_SET_RELATCHED])
    expect(atNotice).toEqual([[false, true]])
    const noteNotice = expectedConflictNotice({ latchCase: LATCH_CASE_CONFLICTING_LABELS, sessionName: personaTmuxSessionName(p) }).text
    expect(h.episodeNotices).toEqual([{ key: p, text: leftoverRow.notice.text }, relaunchingPost, heldPost(q), { key: p, text: noteNotice }])
    expect(endedLinesOf(h.lines.slice(linesBefore), p)).toEqual([stuckLaunchEpisodeEndedLine(p, STUCK_LAUNCH_END_LATCHED)])
    expect(endedLinesOf(h.lines, q)).toEqual([])
    expect([h.episodes.isOpen(p, STUCK), h.episodes.isOpen(q, STUCK)]).toEqual([false, true])

    // A later post of the same text posts again.
    expect(postStuckLaunchRelaunching(deps, p, adLaunchBoundMsInEffect())).toBe(STUCK_LAUNCH_POSTED)
    expect(h.episodeNotices.slice(-1)).toEqual([relaunchingPost])
  })
})

// ---------------------------------------------------------------------------
// SRJ-502, SRJ-1011: a message lost while P is latched reports held for a
// human, and no restart fires (AC 68), through the recovery harness's
// lost-message driver: the real routing's no-session branch with the
// harness's latch's latched query bound as `main()` binds it
// ---------------------------------------------------------------------------

describe('SRJ-502, SRJ-1011: a message lost while P is latched reports held for a human and fires no restart (recovery harness)', () => {
  const leftoverRow = rowWhere(
    (row) => row.refusedOperation === REFUSED_OPERATION_PLAIN_SPAWN && row.stubCase === 'scan-leftover' && row.rowState === LATCH_ROW_STATE_NO_ROW,
  )

  test('a CONFLICT at P’s spawn latches P; a message lost then reports held for a human with its exported wording at P’s destination, asks for no restart and makes no call, and nothing fires for P afterwards; Q’s lost message reports its own state after its one row read', async () => {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    expect(h.config.session_restart_delay).toBe(0)
    const [p, q] = h.keys as [string, string]
    h.script({ spawnError: leftoverRow.build(), statusError: errSpawnNotFound() })
    expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })
    expect(h.latch.isLatched(p)).toBe(true)
    const afterLatch = callCounts(h)
    const personaCountsAfterLatch = personaCallCounts(h, p)

    // Ignoring the latch would report the delay 0's auto-restart disabled; a
    // restart request is seen even though the latched restart module arms none.
    const lost = await expectLostMessageReports(h, p, 'held-for-human')
    const persona = personaOf(h, p)
    expect(posts(h.slack(p)).map((post) => [post.channel, post.text])).toEqual([
      [persona.permission_prompts, formatPersonaNotice(persona, lost.notice)],
    ])
    expect(h.lostMessageNotices).toEqual([{ key: p, text: lost.notice }])
    expect(h.episodeNotices).toEqual([{ key: p, text: leftoverRow.notice.text }])

    // Nothing fires for P afterwards: several retry waits on, no attempt, no call, nothing pending.
    await h.advance(4 * UNAVAILABLE_RETRY_CEILING_S * 1000)
    expect([h.attempts, callCounts(h), h.clock.pendingCount(), isRestartPendingOrActive(p)]).toEqual([[], afterLatch, 0, false])

    // Q is not latched: its message reports the state that applies to it at
    // the delay 0. States 1 to 5 are clear for Q and nothing is in flight, so
    // its message makes the routing's one row read (SRJ-1011), a `status` of
    // Q's instance, which reads no row (dead), not `pending`.
    await expectLostMessageReports(h, q, 'auto-restart-disabled')
    expect(h.slack(q).calls.postMessage).toHaveLength(1)
    expect(h.slack(p).calls.postMessage).toHaveLength(1)
    expect(h.latch.isLatched(q)).toBe(false)
    expect(personaCallCounts(h, q)).toEqual({ statusCalls: 1 })
    // The latched P's own calls are still those of its launch.
    expect(personaCallCounts(h, p)).toEqual(personaCountsAfterLatch)
  })
})

// ---------------------------------------------------------------------------
// SRJ-512, SRJ-502: an UNUSABLE NAME from `resume` and from the working-row
// evidence `read-pane` latches P once, posts SRJ-1019 once, and is followed
// by no tmux-touching call, delete or counted failure on any
// automated path; a lost message then reports held for a human (AC 68, AC 77)
// ---------------------------------------------------------------------------

/** The instance id a stub call's params name, if any. */
const instanceOf = (params: unknown): unknown => (params as { claude_instance_id?: unknown } | undefined)?.claude_instance_id

/**
 * Each way an UNUSABLE NAME latches P through the launch driver: the row
 * whose answer it is, and the stub answers that bring P's launch there.
 * `resume`: the optimistic spawn collides, the collision `get` reads `ended`
 * and the `resume` answers it. The working-row evidence `read-pane`: the
 * optimistic spawn collides, the collision `get` reads a live `working` row,
 * so the launch waits for it; the wait's `status` reads `working` (the case
 * makes P's row read so) and its evidence read, the pane read, answers it.
 */
const UNUSABLE_LATCH_WAYS: ReadonlyArray<readonly [string, UnusableNameCaseRow, (h: RecoveryHarness, key: string) => RecoveryStubScript]> = [
  ['resume', unusableRow('resume', 'empty'), (h, key) => ({ ...collided(h, personaOf(h, key), { state: 'ended' }), resumeError: unusableRow('resume', 'empty').build() })],
  [
    'the working-row evidence read-pane',
    unusableRow('read-pane', 'control-character'),
    (h, key) => ({ ...collided(h, personaOf(h, key), { state: 'working' }), readPaneError: unusableRow('read-pane', 'control-character').build() }),
  ],
]

describe('SRJ-512: an UNUSABLE NAME from resume and from the working-row read-pane holds P for a human on every automated path (recovery harness)', () => {
  test.each(UNUSABLE_LATCH_WAYS)('P latched by %s: one SRJ-1019 post; then a new launch, the retry entry, a scheduled and a human-triggered restart and the retry timer make no tmux-touching call or delete for P and count nothing; Q\'s paths reach the stub as before', async (_label, row, latchScript) => {
    const run = makeAutomatedPathsRun()
    const { h, outcomes } = run
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [p, q] = h.keys as [string, string]
    run.readWorking(p)

    h.script(latchScript(h, p))
    expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })
    expect(h.latch.record(p)).toEqual(row.record(p))
    h.script(CLEARED)
    const touchingAtLatch = tmuxTouchingCallCounts(h.stub.calls)

    const { launched, qCalls, notScheduledLines, attemptsBefore } = await driveEveryPath(run)

    // Nothing tmux-touching or deleting reached P after the latch.
    expect(tmuxTouchingCallsIn(h.stub.calls, touchingAtLatch).filter((call) => instanceOf(call.params) === personaInstanceId(p))).toEqual([])
    expect(h.stub.calls.deleteCalls.filter((call) => instanceOf(call) === personaInstanceId(p))).toEqual([])
    // Each path stopped for P: the launch and the retry entry answered latched, no restart timer, the retry timer stopped latched.
    expect(launched).toEqual([{ key: p, action: 'latched' }, { key: q, action: 'spawned' }])
    expect(outcomes).toEqual([
      [p, RESTART_OUTCOME_LATCHED],
      ...[1, 2, 3, 4].map(() => [q, RESTART_OUTCOME_LAUNCHED] as const),
    ])
    expect(notScheduledLines).toEqual([[notSchedulingLine(p)], [notSchedulingLine(p)]])
    expect(h.attempts.slice(attemptsBefore).map((a) => [a.key, a.retry])).toEqual(retryTimerAttempts(p, q))
    expect(h.stops.filter((stop) => stop.key === p)).toEqual([{ key: p, reason: UNAVAILABLE_RETRY_STOP_LATCHED }])
    expect([h.controller.armedKeys(), isRestartPendingOrActive(p)]).toEqual([[], false])
    // Nothing counted, no spawn-failure notice or spawn-failed entry, one latch and exactly one post: SRJ-1019.
    expect([getFailureCount(p), getFailureCount(q)]).toEqual([0, 0])
    expect(h.notices).toEqual([])
    expect(h.startupErrors()).toEqual([])
    expect(latchSteps(h)).toEqual(oneLatch(p))
    expect(h.episodeNotices).toEqual([{ key: p, text: row.notice(p) }])
    expect(h.latch.isLatched(q)).toBe(false)
    // Q, beside it, still reaches the stub on every path.
    expect(qCalls).toEqual([...Q_CALLS_ON_EVERY_PATH])
  })

  test.each(UNUSABLE_LATCH_WAYS)('P latched by %s: a message lost then reports held for a human with its exported wording at P\'s destination, with no status read and no restart; Q\'s lost message reports its own state', async (_label, row, latchScript) => {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    expect(h.config.session_restart_delay).toBe(0)
    const [p, q] = h.keys as [string, string]
    // P's row reads working (the read-pane way's evidence read is then made); Q's reads no row.
    h.script({
      ...latchScript(h, p),
      statusFn: (params) => (params.claude_instance_id === personaInstanceId(p) ? cannedStatusResult({ state: 'working' }) : errSpawnNotFound()),
    })
    expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })
    expect(h.latch.record(p)).toEqual(row.record(p))
    const pCallsAtLatch = personaCallCounts(h, p)

    const lost = await expectLostMessageReports(h, p, 'held-for-human')
    const persona = personaOf(h, p)
    expect(posts(h.slack(p)).map((post) => [post.channel, post.text])).toEqual([[persona.permission_prompts, formatPersonaNotice(persona, lost.notice)]])
    expect(h.restartAsks.filter((key) => key === p)).toEqual([])
    expect([isRestartPendingOrActive(p), personaCallCounts(h, p)]).toEqual([false, pCallsAtLatch])
    expect(h.episodeNotices).toEqual([{ key: p, text: row.notice(p) }])

    await expectLostMessageReports(h, q, 'auto-restart-disabled')
    expect(h.latch.isLatched(q)).toBe(false)
  })

  test('UNCLASSIFIED control: an ErrInternal without the phrase from the same resume latches nothing, posts no hold notice and takes the unclassified handling', async () => {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    const [p] = h.keys as [string]
    const err = errInternal()
    h.script({ ...collided(h, personaOf(h, p), { state: 'ended' }), resumeError: err })

    expect(await h.launch(p)).toEqual({ key: p, action: SPAWN_ACTION_RETRYING })

    // No latch and no hold notice.
    expect([h.latch.isLatched(p), h.latchEvents, h.episodeNotices]).toEqual([false, [], []])
    // E12's handling: the unclassified episode opens, the timer is armed with the UNCLASSIFIED cause, nothing is counted or noticed, and nothing more is called.
    expect(unclassifiedLines(h, p)).toEqual([unclassifiedStartedLine(p, err)])
    expect(h.unclassifiedErrorOpen(p)).toBe(true)
    expect(h.triggers).toEqual([{ key: p, kind: UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED }])
    expect([getFailureCount(p), h.notices, h.startupErrors()]).toEqual([0, [], []])
    expect(personaCallCounts(h, p)).toEqual({ spawnCalls: 1, getCalls: 1, resumeCalls: 1 })
  })
})

// ---------------------------------------------------------------------------
// SRJ-118, SRJ-505, SRJ-502, SRJ-512: the reconnect is a latch site. P
// launches onto a colliding `waiting` row and its reconnect's one `send-keys`
// answers CONFLICT (a case-table reconnect row for `waiting`) or UNUSABLE
// NAME: P latches once with one post, and no path that could retry it (a new
// launch, the retry entry, a scheduled and a human-triggered restart, the
// retry timer, the health tick) makes another `send-keys` or any other
// tmux-touching call for P, or counts anything; Q's
// launch and reconnect go on.
// ---------------------------------------------------------------------------

/** How P's reconnect latches: [label, P's expected record, P's one post, the stub answers of the launch]. */
const RECONNECT_LATCH_WAYS: ReadonlyArray<
  readonly [string, (key: string) => ConflictLatchRecord, (key: string) => string, (h: RecoveryHarness, key: string) => RecoveryStubScript]
> = [
  ...[reconnectConflictRowsAt('waiting')[0]!].map((row) => [
    `CONFLICT (${row.name})`,
    (key: string) =>
      expectedLatchRecord(key, {
        latchCase: row.latchCase,
        refusedOperation: row.refusedOperation,
        rowState: row.rowState,
        sessionName: row.sessionName,
        description: row.build().errDescription,
      }),
    () => row.notice.text,
    (h: RecoveryHarness, key: string) => ({ ...collided(h, personaOf(h, key), { state: 'waiting' }), sendKeysError: row.build() }),
  ] as const),
  ...[reconnectUnusableNameRowsAt('waiting')[0]!].map((row) => [
    `UNUSABLE NAME (${row.name})`,
    (key: string) => row.record(key),
    (key: string) => row.notice(key),
    (h: RecoveryHarness, key: string) => ({ ...collided(h, personaOf(h, key), { state: 'waiting' }), sendKeysError: row.build() }),
  ] as const),
]

describe('SRJ-118, SRJ-505: a CONFLICT or UNUSABLE NAME at the reconnect\'s send-keys holds P, and no automated path retries it (recovery harness)', () => {
  test.each(RECONNECT_LATCH_WAYS)('P latched by its reconnect\'s %s: one post; then a new launch, the retry entry, a scheduled and a human-triggered restart, the retry timer and the health tick make no send-keys, other tmux-touching call or delete for P and count nothing; the retry timer is stopped; Q launches and reconnects as before', async (_label, record, notice, latchScript) => {
    const run = makeAutomatedPathsRun()
    const { h, outcomes } = run
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [p, q] = h.keys as [string, string]

    h.script(latchScript(h, p))
    expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })
    expect(h.latch.record(p)).toEqual(record(p))
    expect(h.stub.calls.sendKeysCalls.map((call) => call.claude_instance_id)).toEqual([personaInstanceId(p)])
    h.script({ ...CLEARED, sendKeysError: undefined })
    const touchingAtLatch = tmuxTouchingCallCounts(h.stub.calls)

    const { launched, qCalls, notScheduledLines, attemptsBefore } = await driveEveryPath(run)
    const tick = await runHealthTick(run)

    // Nothing tmux-touching (the send-keys included) or deleting reached P after the latch.
    expect(tmuxTouchingCallsIn(h.stub.calls, touchingAtLatch).filter((call) => instanceOf(call.params) === personaInstanceId(p))).toEqual([])
    expect(h.stub.calls.sendKeysCalls.filter((call) => call.claude_instance_id === personaInstanceId(p))).toHaveLength(1)
    expect(h.stub.calls.deleteCalls.filter((call) => instanceOf(call) === personaInstanceId(p))).toEqual([])
    // Each path stopped for P: the launch and the retry entry answered latched, no restart timer, the retry timer stopped latched, the tick scheduled nothing for it.
    expect(launched).toEqual([{ key: p, action: 'latched' }, { key: q, action: 'spawned' }])
    expect(outcomes).toEqual([
      [p, RESTART_OUTCOME_LATCHED],
      ...[1, 2, 3, 4].map(() => [q, RESTART_OUTCOME_LAUNCHED] as const),
    ])
    expect(notScheduledLines).toEqual([[notSchedulingLine(p)], [notSchedulingLine(p)]])
    expect(h.attempts.slice(attemptsBefore).map((a) => [a.key, a.retry])).toEqual(retryTimerAttempts(p, q))
    expect(h.stops.filter((stop) => stop.key === p)).toEqual([{ key: p, reason: UNAVAILABLE_RETRY_STOP_LATCHED }])
    expect([h.controller.armedKeys(), isRestartPendingOrActive(p)]).toEqual([[], false])
    expect(tick.scheduled).toEqual([q])
    // Nothing counted, no spawn-failure notice or spawn-failed entry, one latch and exactly one post.
    expect([getFailureCount(p), getFailureCount(q)]).toEqual([0, 0])
    expect(h.notices).toEqual([])
    expect(h.startupErrors()).toEqual([])
    expect(latchSteps(h)).toEqual(oneLatch(p))
    expect(h.episodeNotices).toEqual([{ key: p, text: notice(p) }])
    expect(h.latch.isLatched(q)).toBe(false)
    // Q, beside it, reaches the stub on every path, and its own reconnect on a waiting row is typed.
    expect(qCalls).toEqual([...Q_CALLS_ON_EVERY_PATH])
    expect(tick.qCalls).toEqual({ statusCalls: 1 })
    h.script(collided(h, personaOf(h, q), { state: 'waiting' }))
    expect(await h.launch(q)).toEqual({ key: q, action: 'reconnected' })
    expect(h.stub.calls.sendKeysCalls.filter((call) => call.claude_instance_id === personaInstanceId(q))).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-110, SRJ-505 (AC 9), SRJ-501, SRJ-502, SRJ-512, SRJ-613: a kill is
// a latch site (E20; the E13, E16 and E19 hatch notes). P's restart run kills
// after its liveness read answers ErrSystemInstallDisappeared (the one `dead`
// reading that reads no row, and so the only one its kill follows: SRJ-110,
// SRJ-314), or the live-row sequence P's launch starts at a collision
// ladder replacement site (a row of P's read `waiting` in another directory;
// b.jg5 SRJ-707) kills it at its step 1, and the
// kill answers CONFLICT
// "not this launch's session"; or the restart run's kill answers UNUSABLE
// NAME. P latches once with one post, P's retry timer (armed before) stops
// latched, and no path that could retry the kill (a new launch, the retry
// entry, a scheduled and a human-triggered restart, the retry timer, the
// health tick) makes a `kill`, `delete`, `spawn`, `resume` or any other
// tmux-touching call for P: the stub records exactly one `kill` of P. Q's
// paths go on.
// ---------------------------------------------------------------------------

/**
 * The restart run's checked kill for P: P's next liveness read answers
 * ErrSystemInstallDisappeared, the only `dead` reading the restart path kills
 * after (a row read `ended` launches with no kill), and the kill answers `err`.
 */
async function restartRunKillAnswering({ h, failStatusOnce }: AutomatedPathsRun, key: string, err: Error): Promise<void> {
  failStatusOnce(key, errSystemInstallDisappeared('status'))
  h.script({ killError: err })
  expect(await runRestartRetry(key, personaOf(h, key).working_directory, isLaunchInFlight)).toBe(RESTART_OUTCOME_LATCHED)
}

/** How P's kill latches: [label, P's expected record, P's one post, the latching call (P's retry timer armed before it)]. */
const KILL_LATCH_WAYS: ReadonlyArray<
  readonly [string, (key: string) => ConflictLatchRecord, (key: string) => string, (run: AutomatedPathsRun, key: string) => Promise<void>]
> = [
  ...RESTART_KILL_CONFLICT_CASE_ROWS.filter((row) => row.latchCase === LATCH_CASE_NOT_THIS_LAUNCH).map((row) => [
    `the restart run's kill: CONFLICT (${row.name})`,
    (key: string) =>
      expectedLatchRecord(key, {
        latchCase: row.latchCase,
        refusedOperation: REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY,
        rowState: row.rowState,
        sessionName: row.sessionName,
        description: row.build().errDescription,
      }),
    () => row.notice.text,
    (run: AutomatedPathsRun, key: string) => restartRunKillAnswering(run, key, row.build()),
  ] as const),
  ...sequenceKillConflictRowsAt(SEQUENCE_STEP1_KILL_SITE, 'waiting').filter((row) => row.latchCase === LATCH_CASE_NOT_THIS_LAUNCH).map((row) => [
    `the step-1 kill of the live-row sequence P's launch starts over a row read waiting in another directory: CONFLICT (${row.name})`,
    (key: string) =>
      expectedLatchRecord(key, {
        latchCase: row.latchCase,
        refusedOperation: REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY,
        rowState: row.rowState,
        sessionName: row.sessionName,
        description: row.build().errDescription,
      }),
    () => row.notice.text,
    async ({ h }: AutomatedPathsRun, key: string) => {
      h.script({ ...collided(h, personaOf(h, key), { cwd: h.home, state: 'waiting' }), killError: row.build() })
      expect(await h.launch(key)).toEqual({ key, action: 'sequence-waiting' })
      expect(await h.driveSequence(h.sequenceSettled(key))).toMatchObject({ kind: LIVE_ROW_OUTCOME_ABORTED, latched: true })
      // Nothing sent: no send-keys, delete or reuse spawn followed the kill.
      expect([h.stub.calls.sendKeysCalls, h.stub.calls.deleteCalls, h.stub.calls.spawnCalls.length]).toEqual([[], [], 1])
    },
  ] as const),
  ...RESTART_KILL_UNUSABLE_NAME_CASE_ROWS.slice(0, 1).map((row) => [
    `the restart run's kill: UNUSABLE NAME (${row.name})`,
    (key: string) => row.record(key),
    (key: string) => row.notice(key),
    (run: AutomatedPathsRun, key: string) => restartRunKillAnswering(run, key, row.build()),
  ] as const),
]

describe('SRJ-110, SRJ-505 (AC 9): a CONFLICT or UNUSABLE NAME at P\'s kill holds P, and no automated path sends the kill again (recovery harness)', () => {
  test.each(KILL_LATCH_WAYS)('P latched by %s: one post; P\'s retry timer stops; then a new launch, the retry entry, a scheduled and a human-triggered restart, the retry timer and the health tick make no kill, delete, spawn, resume or other tmux-touching call for P and count nothing: exactly one kill of P; Q goes on as before', async (_label, record, notice, latch) => {
    const run = makeAutomatedPathsRun()
    const { h, outcomes } = run
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [p, q] = h.keys as [string, string]
    h.controller.arm(p, { kind: UNAVAILABLE_RETRY_CAUSE_READ_ERROR })

    await latch(run, p)
    await h.settle()

    expect(h.latch.record(p)).toEqual(record(p))
    expect(h.stops.filter((stop) => stop.key === p)).toEqual([{ key: p, reason: UNAVAILABLE_RETRY_STOP_LATCHED }])
    expect(h.controller.isArmed(p)).toBe(false)
    h.script({ ...CLEARED, killError: undefined })
    const touchingAtLatch = tmuxTouchingCallCounts(h.stub.calls)
    const outcomesAtLatch = outcomes.length

    const { launched, qCalls, notScheduledLines } = await driveEveryPath(run)
    const tick = await runHealthTick(run)

    // Nothing tmux-touching or deleting reached P after the latch; the kill was sent once.
    expect(tmuxTouchingCallsIn(h.stub.calls, touchingAtLatch).filter((call) => instanceOf(call.params) === personaInstanceId(p))).toEqual([])
    expect(h.stub.calls.killCalls.filter((call) => call.claude_instance_id === personaInstanceId(p))).toHaveLength(1)
    expect(h.stub.calls.deleteCalls.filter((call) => instanceOf(call) === personaInstanceId(p))).toEqual([])
    // Each path stopped for P.
    expect(launched).toEqual([{ key: p, action: 'latched' }, { key: q, action: 'spawned' }])
    expect(outcomes.slice(outcomesAtLatch)).toEqual([
      [p, RESTART_OUTCOME_LATCHED],
      ...[1, 2, 3, 4].map(() => [q, RESTART_OUTCOME_LAUNCHED] as const),
    ])
    expect(notScheduledLines).toEqual([[notSchedulingLine(p)], [notSchedulingLine(p)]])
    // The latch stopped the timer armed before it; the retry timer's path arms it again, and its first retry stops it latched.
    expect(h.stops.filter((stop) => stop.key === p)).toEqual([
      { key: p, reason: UNAVAILABLE_RETRY_STOP_LATCHED },
      { key: p, reason: UNAVAILABLE_RETRY_STOP_LATCHED },
    ])
    expect([h.controller.armedKeys(), isRestartPendingOrActive(p)]).toEqual([[], false])
    expect(tick.scheduled).toEqual([q])
    expect(h.clock.pendingCount()).toBe(0)
    // Nothing counted, no spawn-failure notice or spawn-failed entry, one latch and exactly one post.
    expect([getFailureCount(p), getFailureCount(q)]).toEqual([0, 0])
    expect(h.notices).toEqual([])
    expect(h.startupErrors()).toEqual([])
    expect(latchSteps(h)).toEqual(oneLatch(p))
    expect(h.episodeNotices).toEqual([{ key: p, text: notice(p) }])
    expect(h.latch.isLatched(q)).toBe(false)
    // Q, beside it, reaches the stub on every path.
    expect(qCalls).toEqual([...Q_CALLS_ON_EVERY_PATH])
  })
})

// ---------------------------------------------------------------------------
// SRJ-504: a server restart drops every latch; the next attempt meeting the
// same condition latches again with exactly one post (AC 45)
// ---------------------------------------------------------------------------

describe('SRJ-504: after a server restart a persona that was latched latches again with exactly one post (recovery harness)', () => {
  const scanRow = rowWhere(
    (row) => row.refusedOperation === REFUSED_OPERATION_PLAIN_SPAWN && row.stubCase === 'scan-leftover' && row.rowState === LATCH_ROW_STATE_NO_ROW,
  )
  // The reuse spawn of a finished row meeting a session with no valid label at "duplicate session".
  const noValidIdReuseRow = rowWhere((row) => row.refusedOperation === REFUSED_OPERATION_REUSE_SPAWN && row.latchCase === LATCH_CASE_NO_VALID_ID)

  /**
   * Each leg: the row its refusal is (whose refused operation the latch
   * records), the stub's answers (the same in both lifetimes: the condition
   * still holds after the restart), the row state the latch records by T3's
   * rule, and the calls the bring-up's launch makes.
   */
  const RESTART_LEGS: ReadonlyArray<
    readonly [string, ConflictCaseRow, (h: RecoveryHarness, key: string) => RecoveryStubScript, LatchRowState, readonly string[]]
  > = [
    [
      // The scan's refusal wrote no row, so the bring-up's plain first spawn
      // meets the scan again; the latch-time status read finds no row (HO rev 15).
      'the scan leg: the bring-up\'s plain first spawn meets scan-leftover again',
      scanRow,
      () => ({ spawnError: scanRow.build(), statusError: errSpawnNotFound() }),
      LATCH_ROW_STATE_NO_ROW,
      ['spawn', 'status'],
    ],
    [
      // b.jg5 SRJ-504, SRJ-707: the row reads ended with no session id, so the
      // resume answers ErrNoSessionId and the bring-up's reuse spawn of the
      // same id meets the session with no valid label; nothing is deleted, and
      // the collision get's ended is the last read before the reuse (no
      // diagnosis get for ErrNoSessionId).
      'the "no valid label" leg: collision, get ended with no session id, resume ErrNoSessionId, then the reuse spawn answering no-valid-id',
      noValidIdReuseRow,
      (h, key) => ({
        ...collided(h, personaOf(h, key), { state: 'ended', claude_session_id: '' }, noValidIdReuseRow.build()),
        resumeError: errNoSessionId(),
      }),
      ENDED,
      ['spawn', 'get', 'resume', 'spawn'],
    ],
  ]

  /** The reaction to one fresh latch of `key`: the set (latched, not relatched), the three holds, the one notice. */
  const freshLatch = (key: string, text: string) => [
    ['set', key, CONFLICT_LATCH_SET_LATCHED],
    ['hold', key, 'retry timer stop'],
    ['hold', key, 'tmux-unresponsive end'],
    ['hold', key, 'unclassified-error end'],
    ['notice', key, text],
  ]
  const latchReaction = (h: RecoveryHarness) =>
    h.latchEvents.map((event) =>
      event.step === 'set' ? [event.step, event.key, event.outcome] : event.step === 'hold' ? [event.step, event.key, event.hold] : [event.step, event.key, event.text],
    )

  /**
   * One server lifetime's bring-up of P against the condition: the launch
   * answers latched with the leg's record (its row's refused operation), the
   * one fresh latch reaction and exactly one CONFLICT post, no spawn-failure
   * notice and no spawn-failed entry, and only the leg's calls: no delete,
   * and a spawn with the reuse flag only at the reuse leg.
   */
  async function bringUpLatches(
    h: RecoveryHarness,
    row: ConflictCaseRow,
    script: (h: RecoveryHarness, key: string) => RecoveryStubScript,
    rowState: LatchRowState,
    calls: readonly string[],
  ): Promise<void> {
    const [p, q] = h.keys as [string, string]
    h.script(script(h, p))
    const order = recordCallOrder(h)
    expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })
    expect(h.latch.isLatched(p)).toBe(true)
    expect(h.latch.record(p)).toMatchObject({
      sessionName: row.sessionName,
      latchCase: row.latchCase,
      refusedOperation: row.refusedOperation,
      rowState,
    })
    expect(order).toEqual([...calls])
    // The reuse leg's last spawn is P's one reuse spawn; the scan leg's spawn is plain. No delete in either.
    expect(h.reuseSpawns()).toEqual(row.refusedOperation === REFUSED_OPERATION_REUSE_SPAWN ? [reuseSpawnOf(h, p)] : [])
    expect(h.stub.calls.deleteCalls).toEqual([])
    expect(latchReaction(h)).toEqual(freshLatch(p, row.notice.text))
    expect(h.episodeNotices).toEqual([{ key: p, text: row.notice.text }])
    expect(h.notices).toEqual([])
    expect(h.startupErrors()).toEqual([])
    expect(h.latch.isLatched(q)).toBe(false)
  }

  test.each(RESTART_LEGS)('%s: P latches in the first lifetime; the second starts with P unlatched and latches it again with one post', async (_label, row, script, rowState, calls) => {
    // The first server lifetime: P latches at its bring-up.
    const h1 = makeRecoveryHarness()
    harnesses.push(h1)
    const p = h1.keys[0]!
    await bringUpLatches(h1, row, script, rowState, calls)
    // The restart: leak-checked as afterEach would and cleaned up here, even when the check fails; only then out of the afterEach list.
    try {
      assertNoLeak(h1.captured())
    } finally {
      h1.cleanup()
    }
    harnesses = harnesses.filter((h) => h !== h1)

    // The second lifetime, over a stub still answering the same condition.
    const h2 = makeRecoveryHarness()
    harnesses.push(h2)
    expect(h2.keys[0]).toBe(p)
    // Nothing carried over: before its first attempt P is unlatched, with no record, no latch event and no post.
    expect([h2.latch.isLatched(p), h2.latch.record(p)]).toEqual([false, undefined])
    expect([h2.latchEvents, h2.episodeNotices, callCounts(h2)]).toEqual([[], [], {}])

    await bringUpLatches(h2, row, script, rowState, calls)
  })
})

// ---------------------------------------------------------------------------
// SRJ-507 at a real reuse site (the E13 hatch note; b.jg5 SRJ-707): the
// collision ladder's reuse spawn after `resume`'s `ErrNoSessionId`, on
// `makeRecoveryHarness`. The reuse meets another agent-director store's
// session at "duplicate session", in both forms of the stub's description.
// ---------------------------------------------------------------------------

describe('SRJ-507: the another-store description at the ladder\'s ErrNoSessionId reuse site latches P with "another agent-director store" and "reuse spawn" (recovery harness)', () => {
  /** Both forms of the another-store description, each a reuse row: the reuse's own wording, then the plain spawn's. */
  const ANOTHER_STORE_REUSE_ROWS = [false, true].map((plainSpawn) =>
    REUSE_SPAWN_CONFLICT_CASE_ROWS.find((row) => row.latchCase === LATCH_CASE_ANOTHER_STORE && (row.options.plainSpawn === true) === plainSpawn)!,
  )

  test.each(ANOTHER_STORE_REUSE_ROWS.map((row) => [row.name, row] as const))('%s: P latches once with "another agent-director store", "reuse spawn" and the collision get\'s ended; one post carrying the another-store line; the reuse spawn is the last call; no delete, kill or count; Q is not latched', async (_name, row) => {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    const [p, q] = h.keys as [string, string]
    h.script({ ...collided(h, personaOf(h, p), { state: 'ended', claude_session_id: '' }, row.build()), resumeError: errNoSessionId() })
    const order = recordCallOrder(h)

    expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })

    expect(order).toEqual(['spawn', 'get', 'resume', 'spawn'])
    expect(h.reuseSpawns()).toEqual([reuseSpawnOf(h, p)])
    expect(h.latch.record(p)).toEqual(
      expectedLatchRecord(p, {
        latchCase: LATCH_CASE_ANOTHER_STORE,
        refusedOperation: REFUSED_OPERATION_REUSE_SPAWN,
        rowState: ENDED,
        sessionName: row.sessionName,
        description: row.build().errDescription,
      }),
    )
    expect(row.build().errDescription).toContain(CONFLICT_ANOTHER_STORE_PHRASE)
    expect(latchSteps(h)).toEqual(oneLatch(p))
    expect(h.episodeNotices).toEqual([{ key: p, text: row.notice.text }])
    expect(row.notice.text).toContain(CONFLICT_NOTICE_ANOTHER_STORE_MUST_NOT_END_LINE)
    expect([h.stub.calls.deleteCalls, h.stub.calls.killCalls, getFailureCount(p), h.notices, h.startupErrors()]).toEqual([[], [], 0, [], []])
    expect(h.latch.isLatched(q)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The note rules (SRJ-114; SRJ-501's note trigger; SRJ-1004's note notice;
// AC 40, AC 45, AC 85)
// ---------------------------------------------------------------------------

/**
 * One row read as `decideOwnRowRead` takes it. A `pending` row shows the
 * stub's default launch start, as the canned builders give one, so the note
 * is what decides; the other states show none.
 */
const rowRead = (claudeInstanceId: string, note: string | null | undefined, state = 'waiting'): RowReadRow => ({
  claude_instance_id: claudeInstanceId,
  state,
  liveness_note: note,
  ...(state === AGENT_DIRECTOR_PENDING_STATE ? { launch_started_at: SAMPLE_LAUNCH_START_DEFAULT } : {}),
})

/** Every state agent-director reports, by name: the live states (`pending` and `waiting` among them), then the dead ones. */
const ROW_STATES = [...AGENT_DIRECTOR_LIVE_STATES, ...AGENT_DIRECTOR_DEAD_STATES].map((state) => [state] as const)

/**
 * The notes that latch no one, by name: every other note agent-director
 * names, a note CSCB does not know (which starts with the latching note's
 * spelling, so a prefix match catches it), the latching note case-folded and
 * inside other text (no case-folded or substring match), and no note.
 */
const NON_LATCHING_NOTES: ReadonlyArray<readonly [string, string | null | undefined]> = [
  ...nonLatchingNotes.map((note) => [`the ${note} note`, note] as const),
  [`the unknown note ${unknownNote}`, unknownNote],
  ['the latching note case-folded', provenanceNote.toUpperCase()],
  ['the latching note inside other text', ` ${provenanceNote} `],
  ['no note (absent)', undefined],
  ['no note (null)', null],
  ['an empty note', ''],
]

describe('the note rules: the pure decision over one read of a persona\'s own row (SRJ-114)', () => {
  test.each(ROW_STATES)('a configured persona\'s own row in state %s with the latching note decides a latch: conflicting labels, P\'s bring-up and the state read', (state) => {
    expect(decideOwnRowRead({ key: KEY, row: rowRead(personaInstanceId(KEY), provenanceNote, state), configured: true })).toEqual({
      latch: { latchCase: LATCH_CASE_CONFLICTING_LABELS, refusedOperation: REFUSED_OPERATION_BRING_UP, rowState: latchRowStateRead(state) },
    })
  })

  test('a waiting row\'s decided state counts as live', () => {
    const decision = decideOwnRowRead({ key: KEY, row: rowRead(personaInstanceId(KEY), provenanceNote, 'waiting'), configured: true })
    expect(decision.latch).toBeDefined()
    expect(rowStateCountsAsLive(decision.latch!.rowState)).toBe(true)
  })

  test.each(NON_LATCHING_NOTES)('%s on a configured persona\'s own row decides nothing', (_name, note) => {
    expect(decideOwnRowRead({ key: KEY, row: rowRead(personaInstanceId(KEY), note), configured: true })).toEqual(ROW_READ_NO_DECISION)
  })

  test.each([
    ['the row of a key not configured (an absent persona\'s own row)', personaInstanceId(KEY), false],
    ['another caller\'s row', LAUNCH_START_ANOTHER_CALLERS_ID, true],
    ['another persona\'s own row, read for P', personaInstanceId(OTHER), true],
    ['a row whose id only starts with P\'s own', `${personaInstanceId(KEY)}_x`, true],
  ] as const)('the latching note on %s decides nothing', (_name, claudeInstanceId, configured) => {
    expect(decideOwnRowRead({ key: KEY, row: rowRead(claudeInstanceId, provenanceNote), configured })).toEqual(ROW_READ_NO_DECISION)
  })
})

describe('the note latch through the own-row read: record, notice, relatch and who latches (recovery harness; SRJ-114, SRJ-501, SRJ-1004)', () => {
  /** The reading site the log lines name; any site reads the same way. */
  const SITE: OwnRowReadSite = { site: 'conflict-latch.test', what: 'own-row get' }

  /** A recovery harness, cleaned up and leak-checked in `afterEach`, with its two configured personas. */
  function makeNoteRun(): { h: RecoveryHarness; p: string; q: string } {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    const [p, q] = h.keys as [string, string]
    return { h, p, q }
  }

  /** The stub's `get` answer: configured persona `key`'s own row in `state`, carrying `note` (none when undefined). */
  const ownRowAnswer = (h: RecoveryHarness, key: string, note: string | undefined, state = 'waiting'): RecoveryStubScript => ({
    getResult: cannedGetResult({ state, liveness_note: note }, personaOf(h, key), h.home),
  })

  /** Each latch set as the observers saw it: the key and the outcome. */
  const setOutcomes = (h: RecoveryHarness) => h.latchEvents.flatMap((event) => (event.step === 'set' ? [[event.key, event.outcome]] : []))

  /** The note latch's notice for `key`, as the shared helper builds it: "conflicting labels", `slack_bot_<key>`, no description. */
  const noteNotice = (key: string) => expectedConflictNotice({ latchCase: LATCH_CASE_CONFLICTING_LABELS, sessionName: personaTmuxSessionName(key) }).text

  test('a note latch once: a provenance_conflict note on P\'s own waiting row latches P with slack_bot_<key>, conflicting labels, P\'s bring-up and a live waiting state; one CONFLICT post; a second read posts nothing; Q stays unlatched', async () => {
    const { h, p, q } = makeNoteRun()
    h.script(ownRowAnswer(h, p, provenanceNote))

    expect(await readPersonaOwnRow(p, SITE)).toMatchObject({ kind: OWN_ROW_READ_ROW, latched: true })
    const record = h.latch.record(p)
    expect(record).toEqual({
      sessionName: personaTmuxSessionName(p),
      latchCase: LATCH_CASE_CONFLICTING_LABELS,
      refusedOperation: REFUSED_OPERATION_BRING_UP,
      rowState: latchRowStateRead('waiting'),
    })
    expect(rowStateCountsAsLive(record!.rowState)).toBe(true)
    expect(h.episodeNotices).toEqual([{ key: p, text: noteNotice(p) }])

    // The same note read again: still latched with the record unchanged, and nothing more posted.
    expect(await readPersonaOwnRow(p, SITE)).toMatchObject({ kind: OWN_ROW_READ_ROW, latched: true })
    expect(h.latch.record(p)).toBe(record)
    expect(setOutcomes(h)).toEqual([[p, CONFLICT_LATCH_SET_LATCHED], [p, CONFLICT_LATCH_SET_SAME_CASE]])
    expect(h.episodeNotices).toEqual([{ key: p, text: noteNotice(p) }])
    expect(h.notices).toEqual([])

    // Q, configured beside P, is neither latched nor called.
    expect([h.latch.isLatched(q), h.latch.record(q)]).toEqual([false, undefined])
    expect(personaCallCounts(h, q)).toEqual({})
    expect(personaCallCounts(h, p)).toEqual({ getCalls: 2 })
  })

  test('the note latch\'s notice is SRJ-1004\'s conflicting-labels notice for slack_bot_<key>: the first line with the case sentence, the pointer, the list and the human-only lines, and no "agent-director said" line', async () => {
    const { h, p } = makeNoteRun()
    h.script(ownRowAnswer(h, p, provenanceNote))
    await readPersonaOwnRow(p, SITE)

    const session = personaTmuxSessionName(p)
    expect(h.episodeNotices.map((notice) => notice.key)).toEqual([p])
    const lines = h.episodeNotices[0]!.text.split(CONFLICT_NOTICE_LINE_SEPARATOR)
    expect(lines).toEqual([
      CONFLICT_NOTICE_FIRST_LINE_HEAD +
        JSON.stringify(session) +
        CONFLICT_NOTICE_CASE_SENTENCE_LEAD +
        CONFLICT_CASE_SENTENCES[LATCH_CASE_CONFLICTING_LABELS] +
        CONFLICT_NOTICE_FIRST_LINE_TAIL,
      CONFLICT_NOTICE_POINTER_LINE,
      CONFLICT_NOTICE_LIST_LINE_HEAD + session + CONFLICT_NOTICE_LIST_LINE_TAIL,
      CONFLICT_NOTICE_HUMAN_ONLY_LINE,
    ])
    expect(lines.filter((line) => line.startsWith(CONFLICT_NOTICE_DESCRIPTION_LINE_HEAD))).toEqual([])
  })

  test('P latched first with another case relatches on the note with conflicting labels, P\'s bring-up and the state read, and exactly one new post', async () => {
    const { h, p, q } = makeNoteRun()
    const first = rowWhere(
      (row) => row.refusedOperation === REFUSED_OPERATION_PLAIN_SPAWN && row.latchCase === LATCH_CASE_LEFTOVER && row.rowState !== LATCH_ROW_STATE_NO_ROW,
    )
    h.script({ spawnError: first.build() })
    expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })
    expect(h.latch.record(p)?.latchCase).toBe(LATCH_CASE_LEFTOVER)

    h.script({ spawnError: undefined, ...ownRowAnswer(h, p, provenanceNote, 'ended') })
    expect(await readPersonaOwnRow(p, SITE)).toMatchObject({ kind: OWN_ROW_READ_ROW, latched: true })
    expect(h.latch.record(p)).toEqual({
      sessionName: personaTmuxSessionName(p),
      latchCase: LATCH_CASE_CONFLICTING_LABELS,
      refusedOperation: REFUSED_OPERATION_BRING_UP,
      rowState: ENDED,
    })
    expect(setOutcomes(h)).toEqual([[p, CONFLICT_LATCH_SET_LATCHED], [p, CONFLICT_LATCH_SET_RELATCHED]])
    expect(h.episodeNotices).toEqual([
      { key: p, text: first.notice.text },
      { key: p, text: noteNotice(p) },
    ])
    expect(h.latch.isLatched(q)).toBe(false)
  })

  test('a configured second persona\'s own row with the note latches that persona alone, with its own session', async () => {
    const { h, p, q } = makeNoteRun()
    h.script(ownRowAnswer(h, q, provenanceNote))
    expect(await readPersonaOwnRow(q, SITE)).toMatchObject({ kind: OWN_ROW_READ_ROW, latched: true })
    expect(h.latch.record(q)?.sessionName).toBe(personaTmuxSessionName(q))
    expect([h.latch.isLatched(p), h.latch.record(p)]).toEqual([false, undefined])
    expect(setOutcomes(h)).toEqual([[q, CONFLICT_LATCH_SET_LATCHED]])
    expect(h.episodeNotices).toEqual([{ key: q, text: noteNotice(q) }])
  })

  /**
   * The reads that latch no one, by name: the key read and the stub's `get`
   * answer for it. Two listed notes stand for the rest (the pure decision
   * above covers every note). An absent persona is a key outside the
   * harness's personas, or one removed from the applied configuration.
   */
  const NO_LATCH_READS: ReadonlyArray<readonly [string, (h: RecoveryHarness, p: string) => { key: string; script: RecoveryStubScript }]> = [
    ...(['tmux_server_changed', 'process_not_seen_session_present'] as const).map(
      (note) => [`a ${note} note on P's own row`, (h: RecoveryHarness, p: string) => ({ key: p, script: ownRowAnswer(h, p, note) })] as const,
    ),
    [`an unknown note (${unknownNote}) on P's own row`, (h, p) => ({ key: p, script: ownRowAnswer(h, p, unknownNote) })],
    ['no note on P\'s own row', (h, p) => ({ key: p, script: ownRowAnswer(h, p, undefined) })],
    [
      `a ${provenanceNote} note on another caller's row`,
      (_h, p) => ({ key: p, script: { getResult: cannedGetResult({ claude_instance_id: LAUNCH_START_ANOTHER_CALLERS_ID, liveness_note: provenanceNote }) } }),
    ],
    [
      `a ${provenanceNote} note on the own row of a key outside the configuration (an absent persona)`,
      (h) => {
        expect(h.keys).not.toContain(LAUNCH_START_ABSENT_PERSONA_KEY)
        return { key: LAUNCH_START_ABSENT_PERSONA_KEY, script: { getResult: cannedGetResult({ claude_instance_id: personaInstanceId(LAUNCH_START_ABSENT_PERSONA_KEY), liveness_note: provenanceNote }) } }
      },
    ],
    [
      `a ${provenanceNote} note on the own row of a persona removed from the applied configuration`,
      (h, p) => {
        const script = ownRowAnswer(h, p, provenanceNote)
        h.remove(p)
        return { key: p, script }
      },
    ],
  ]

  test.each(NO_LATCH_READS)('%s latches no one and posts nothing', async (_name, read) => {
    const { h, p } = makeNoteRun()
    const { key, script } = read(h, p)
    h.script(script)
    expect(await readPersonaOwnRow(key, SITE)).toMatchObject({ kind: OWN_ROW_READ_ROW, latched: false })
    expect([...h.keys, LAUNCH_START_ABSENT_PERSONA_KEY].filter((k) => h.latch.isLatched(k))).toEqual([])
    expect([h.latchEvents, h.episodeNotices, h.notices]).toEqual([[], [], []])
  })
})

// ---------------------------------------------------------------------------
// A `pending` row with no launch start (SRJ-513, SRJ-1020, SRJ-508, SRJ-1016;
// AC 8, AC 68, AC 86): the decision, the notice, the record and episode, the
// hold on every automated path, the latch-time read's precedence and the
// lost message
// ---------------------------------------------------------------------------

/**
 * The directory the decision cases' persona labels are computed against: its
 * `claude_config_dir` sits under it (not created; the label follows the
 * nearest existing ancestor's real path). Nothing is written there. Made by
 * the first case that asks for it (`mkdtempSync`) and removed in `afterEach`.
 */
let launchStartHomeDir: string | undefined

/** This case's launch-start home: made on first use, removed in `afterEach`. */
function launchStartHome(): string {
  launchStartHomeDir ??= mkdtempSync(join(tmpdir(), 'conflict-latch-launch-start-'))
  return launchStartHomeDir
}

afterEach(() => {
  const dir = launchStartHomeDir
  launchStartHomeDir = undefined
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
})

/** A persona the launch-start rows are built for, its directories under `launchStartHome()`. */
const launchStartPersona = (key: string): CannedRowPersona => ({
  key,
  working_directory: join(launchStartHome(), key, 'work'),
  claude_config_dir: join(launchStartHome(), key, 'claude'),
})

/** `test.each` rows over the latching launch-start rows: the row name, then the row. */
const LAUNCH_START_ROWS = LAUNCH_START_CASE_ROWS.map((row) => [row.name, row] as const)

/** The `pending` row state a launch-start latch records. */
const PENDING = latchRowStateRead(AGENT_DIRECTOR_PENDING_STATE)

/** The launch-start decision over `row` read for persona `key` (the one configured persona). */
const launchStartDecision = (row: LaunchStartCaseRow, key = KEY) => decideOwnRowRead(row.decisionInput(launchStartPersona(key), launchStartHome()))

/** The latching row of `shape` for P's current life, its launch start absent. */
function currentLifeRow(shape: LaunchStartCaseRow['shape']): LaunchStartCaseRow {
  const found = LAUNCH_START_CASE_ROWS.find((row) => row.shape === shape && row.variant === 'current life' && row.form === 'absent')
  if (found === undefined) throw new Error(`no current-life launch-start row for ${shape}`)
  return found
}

/** Latch `key` from one read of `row`, as the shared reads do: the decision, then the latch with its row state. */
function latchFromLaunchStartRead(latch: ConflictLatch, key: string, row: LaunchStartCaseRow) {
  const decision = launchStartDecision(row, key)
  if (decision.latch === undefined) throw new Error(`${row.name} decided nothing`)
  return latch.setLaunchStartNotRecorded(key, decision.latch.rowState)
}

describe('the launch-start decision over one read of a persona\'s own row (SRJ-513, SRJ-408)', () => {
  test.each(LAUNCH_START_ROWS)('%s: the decision latches with "launch start not recorded", "none" and pending; latched from it, P records that with slack_bot_<key> and the post is the row\'s notice, once', (_name, row) => {
    expect(launchStartDecision(row)).toEqual({
      latch: { latchCase: row.latchCase, refusedOperation: row.refusedOperation, rowState: row.rowState },
    })
    const run = makeNoticeRun()
    expect(latchFromLaunchStartRead(run.latch, KEY, row)).toBe(CONFLICT_LATCH_SET_LATCHED)
    expect(run.latch.record(KEY)).toEqual(row.record(KEY))
    expect(run.posts).toEqual([[KEY, row.notice(KEY)]])
  })

  test('the unparseable launch start the rows use is the stub\'s sample with its zone dropped, and does not parse', () => {
    expect([UNPARSEABLE_LAUNCH_START === SAMPLE_LAUNCH_START_WHOLE, parseLaunchStart(UNPARSEABLE_LAUNCH_START)]).toEqual([false, undefined])
  })

  test.each(LAUNCH_START_NON_LATCHING_ROWS.map((row) => [row.name, row] as const))('%s decides nothing', (_name, row) => {
    expect(decideOwnRowRead(row.decisionInput(launchStartPersona(KEY), launchStartHome()))).toEqual(ROW_READ_NO_DECISION)
  })

  test('a row carrying both the provenance_conflict note and no launch start decides "launch start not recorded" only, never "conflicting labels"', () => {
    const row = LAUNCH_START_AND_NOTE_ROW
    expect(row.readRow(launchStartPersona(KEY), launchStartHome()).liveness_note).toBe(provenanceNote)
    expect(launchStartDecision(row)).toEqual(ROW_READ_LAUNCH_START_NOT_RECORDED)
    expect(launchStartDecision(row).latch?.latchCase).toBe(LATCH_CASE_LAUNCH_START_NOT_RECORDED)
  })
})

describe('SRJ-1020\'s notice for a launch start not recorded', () => {
  test('SRJ-1020\'s text for one persona: the builder gives it word for word, on one line', () => {
    // The file's only literal block for this text: SRJ-1020 as written.
    const TEMPLATE =
      ':no_entry: *Held: launch start not recorded* — this persona\'s agent-director row reads pending but records no launch start, so it was written by an agent-director process older than the install, and agent-director will not act on its session <session>. A human should look: follow the "Operator actions" section of agent-director\'s README. CSCB takes no action for this persona until the row reads ended or missing, or is removed, and messages sent to it meanwhile are lost. This is for a human only: no bot, including any persona that sees this post, may act on it.'
    const expected = TEMPLATE.replace('<session>', () => JSON.stringify(`slack_bot_${KEY}`))
    expect(launchStartNotRecordedNoticeText(KEY)).toBe(expected)
    expect(expected.includes(CONFLICT_NOTICE_LINE_SEPARATOR)).toBe(false)
  })

  test('the notice quotes the persona\'s session, points to "Operator actions" for a human only, and CSCB\'s words name no session-ending command, include-finished, kill-pane, set-option, agent-director delete or clear-latch', () => {
    const notice = launchStartNotRecordedNoticeText(KEY)
    expect(notice.includes(JSON.stringify(personaTmuxSessionName(KEY)))).toBe(true)
    expect(notice.includes(LAUNCH_START_NOTICE_POINTER)).toBe(true)
    expect(notice.includes(JSON.stringify(operatorActionsTitle()))).toBe(true)
    expect(notice.endsWith(CONFLICT_NOTICE_HUMAN_ONLY_LINE)).toBe(true)

    // No description is quoted, so the whole notice is CSCB's own text.
    const own = cscbOwnText(notice)
    expect(own).toBe(notice)
    expect(sessionEndingCommandsIn(own)).toEqual([])
    expect(own.split(CONFLICT_NOTICE_LINE_SEPARATOR).flatMap(cscbOwnLineForbiddenIn)).toEqual([])
    assertNoLeak([notice])
  })

  test('a persona key with Slack control characters is escaped once in the quoted session', () => {
    const key = 'p<q>&r'
    const notice = launchStartNotRecordedNoticeText(key)
    expect(notice.includes(JSON.stringify(escapeSlackControlCharacters(personaTmuxSessionName(key))))).toBe(true)
    expect(/[<>]/.test(notice)).toBe(false)
  })

  test('posted through the persona notifier, the persona\'s own stub receives formatPersonaNotice(persona, notice) at its destination; the other persona\'s stub receives nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conflict-latch-launch-start-notifier-'))
    try {
      const config = makeMultiPersonaConfig([{}, {}], dir)
      const [persona, other] = config.personas as [(typeof config.personas)[number], (typeof config.personas)[number]]
      const notifier = makeNotifierHarness(config, { leakMarker: LEAK_SENTINEL })
      const sent: Array<Promise<void>> = []
      const run = makeNoticeRun((key, text) => {
        sent.push(notifier.notifier.notify(key, text))
      })
      expect(run.latch.setLaunchStartNotRecorded(persona.key, PENDING)).toBe(CONFLICT_LATCH_SET_LATCHED)
      await Promise.all(sent)
      expect(notifier.posts(persona.key)).toEqual([
        { channel: persona.permission_prompts, text: formatPersonaNotice(persona, launchStartNotRecordedNoticeText(persona.key)) },
      ])
      expect(notifier.posts(other.key)).toEqual([])
      expect(notifier.clock.pendingCount()).toBe(0)
      assertNoLeak([notifier.allPosts(), notifier.logs])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the launch-start latch\'s record and episode (SRJ-513, SRJ-508, SRJ-1016)', () => {
  const kindsOpen = (run: NoticeRun, key: string) => [
    run.episodes.isOpen(key, PERSONA_EPISODE_KIND_CONFLICT),
    run.episodes.isOpen(key, PERSONA_EPISODE_KIND_UNUSABLE_RECORDED_NAME),
    run.episodes.isOpen(key, PERSONA_EPISODE_KIND_LAUNCH_START_NOT_RECORDED),
  ]

  test('the first read latches P with the case, "none", pending and the quoted slack_bot_<key> and posts once; three more reads of the same row (status, list, get) post nothing and keep the record; a second persona stays unlatched', () => {
    const run = makeNoticeRun()
    const get = currentLifeRow('get')
    expect(latchFromLaunchStartRead(run.latch, KEY, get)).toBe(CONFLICT_LATCH_SET_LATCHED)
    const record = run.latch.record(KEY)
    expect(record).toEqual(launchStartRecord(KEY))
    expect(launchStartNotRecordedSetInput(KEY, PENDING)).toEqual({
      latchCase: LATCH_CASE_LAUNCH_START_NOT_RECORDED,
      refusedOperation: REFUSED_OPERATION_NONE,
      rowState: PENDING,
      sessionName: personaTmuxSessionName(KEY),
    })
    const episode = run.episodes.view(KEY, PERSONA_EPISODE_KIND_LAUNCH_START_NOT_RECORDED)
    expect(episode?.caseLabel).toBe(LATCH_CASE_LAUNCH_START_NOT_RECORDED)
    expect(kindsOpen(run, KEY)).toEqual([false, false, true])

    for (const row of [currentLifeRow('status'), currentLifeRow('list'), get]) {
      expect(latchFromLaunchStartRead(run.latch, KEY, row)).toBe(CONFLICT_LATCH_SET_SAME_CASE)
    }
    expect(run.latch.record(KEY)).toBe(record)
    expect(run.episodes.view(KEY, PERSONA_EPISODE_KIND_LAUNCH_START_NOT_RECORDED)?.episode).toBe(episode?.episode)
    expect(run.posts).toEqual([[KEY, launchStartNotRecordedNoticeText(KEY)]])
    expect([run.latch.isLatched(OTHER), run.latch.record(OTHER)]).toEqual([false, undefined])
  })

  /** Each way P is latched first, the post it made, and the episode kind it opened. */
  const FIRST_LATCHES: ReadonlyArray<readonly [string, (latch: ConflictLatch) => unknown, string, PersonaEpisodeKind]> = [
    (() => {
      const row = rowWhere((r) => r.latchCase === LATCH_CASE_OWN_ID)
      return ['a CONFLICT (a case-table row)', (latch: ConflictLatch) => latchOnRow(latch, KEY, row), row.notice.text, PERSONA_EPISODE_KIND_CONFLICT] as const
    })(),
    (() => {
      const row = unusableRow('resume', 'empty')
      return ['"unusable recorded name"', (latch: ConflictLatch) => latchUnusable(latch, KEY, row), row.notice(KEY), PERSONA_EPISODE_KIND_UNUSABLE_RECORDED_NAME] as const
    })(),
    [
      'a provenance_conflict note',
      (latch: ConflictLatch) =>
        latch.set(KEY, {
          latchCase: LATCH_CASE_CONFLICTING_LABELS,
          refusedOperation: REFUSED_OPERATION_BRING_UP,
          rowState: latchRowStateRead('waiting'),
          sessionName: personaTmuxSessionName(KEY),
        }),
      expectedConflictNotice({ latchCase: LATCH_CASE_CONFLICTING_LABELS, sessionName: personaTmuxSessionName(KEY) }).text,
      PERSONA_EPISODE_KIND_CONFLICT,
    ],
  ]

  test.each(FIRST_LATCHES)('P latched first on %s relatches on a no-launch-start read with exactly one new post, the record replaced and the first kind\'s episode ended', (_label, latchFirst, firstPost, firstKind) => {
    const run = makeNoticeRun()
    expect(latchFirst(run.latch)).toBe(CONFLICT_LATCH_SET_LATCHED)
    expect(run.episodes.isOpen(KEY, firstKind)).toBe(true)

    expect(latchFromLaunchStartRead(run.latch, KEY, currentLifeRow('status'))).toBe(CONFLICT_LATCH_SET_RELATCHED)
    expect(run.latch.record(KEY)).toEqual(launchStartRecord(KEY))
    expect(kindsOpen(run, KEY)).toEqual([false, false, true])
    expect(latchFromLaunchStartRead(run.latch, KEY, currentLifeRow('get'))).toBe(CONFLICT_LATCH_SET_SAME_CASE)
    expect(run.posts).toEqual([
      [KEY, firstPost],
      [KEY, launchStartNotRecordedNoticeText(KEY)],
    ])
    expect(run.latch.isLatched(OTHER)).toBe(false)
  })

  test.each([
    ['unproven-idle', { reason: 'unproven-idle', autoRestartDisabled: false, heldMs: 600_000 }],
    ['blocked-on-prompt', { reason: 'blocked-on-prompt', autoRestartDisabled: false }],
  ] as const)('a persona already given the %s not-connected notice still gets the launch-start post once', (_reason, notConnected: NotConnectedNotice) => {
    const notConnectedPosts: Array<readonly [string, string]> = []
    setSessionNotifier((key, text) => {
      notConnectedPosts.push([key, text])
    })
    expect(notifyPersonaNotConnected(KEY, notConnected)).toBe(true)

    const run = makeNoticeRun()
    latchFromLaunchStartRead(run.latch, KEY, currentLifeRow('get'))
    latchFromLaunchStartRead(run.latch, KEY, currentLifeRow('list'))
    expect(run.posts).toEqual([[KEY, launchStartNotRecordedNoticeText(KEY)]])
    expect(notConnectedPosts.map(([key]) => key)).toEqual([KEY])
    assertNoLeak(notConnectedPosts)
  })
})

/** Each latch set the harness's observers saw: the key and the outcome. */
const harnessSetOutcomes = (h: RecoveryHarness) => h.latchEvents.flatMap((event) => (event.step === 'set' ? [[event.key, event.outcome]] : []))

/** A `status` answer: persona `p`'s own row reads `pending` with no launch start; every other persona's row is gone. */
const pNoLaunchStartStatus = (p: string): RecoveryStubScript => ({
  statusFn: (params) =>
    params.claude_instance_id === personaInstanceId(p)
      ? cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_NONE })
      : errSpawnNotFound(),
})

/**
 * Each origin of P's launch-start latch on `makeAutomatedPathsRun`'s harness,
 * where P's row reads `pending` with no launch start. Each runs the origin
 * and checks only that it latched P.
 */
const LAUNCH_START_ORIGINS: ReadonlyArray<readonly [string, (run: AutomatedPathsRun, p: string) => Promise<void>]> = [
  [
    'the collision get after P\'s launch collided, the row in P\'s cwd',
    async ({ h }, p) => {
      h.script(collided(h, personaOf(h, p), { state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_NONE }))
      expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })
    },
  ],
  [
    'the collision get after P\'s launch collided, the row in another existing cwd',
    async ({ h }, p) => {
      h.script(collided(h, personaOf(h, p), { state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_NONE, cwd: h.home }))
      expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })
    },
  ],
  [
    'a scheduled restart\'s liveness read',
    async ({ h, outcomes }, p) => {
      const fire = captureTimer('setTimeout', () => scheduleRestart(p, personaOf(h, p).working_directory))
      await fire()
      await h.settle()
      expect(outcomes).toEqual([[p, RESTART_OUTCOME_LATCHED]])
    },
  ],
  [
    'the retry timer\'s row read in pending-only mode',
    async ({ h }, p) => {
      h.controller.armPendingOnly(p)
      await retryNow(h, p)
      expect(h.attempts.map((a) => [a.key, a.mode])).toEqual([[p, UNAVAILABLE_RETRY_MODE_PENDING_ONLY]])
    },
  ],
  [
    'the lost-message read',
    async ({ h }, p) => {
      await expectLostMessageReports(h, p, 'held-for-human', { calls: { statusCalls: 1 } })
    },
  ],
]

describe('SRJ-513: a pending row with no launch start holds P for a human on every automated path (recovery harness)', () => {
  test.each(LAUNCH_START_ORIGINS)('P latched by %s: then the retry timer over several waits, a scheduled and a human-triggered restart, the retry entry and a new launch make no send-keys, kill, read-pane, find-missing, spawn or resume for P, count nothing and leave no timer armed; one SRJ-1020 post; Q\'s paths reach the stub as before', async (_label, origin) => {
    const run = makeAutomatedPathsRun()
    const { h, outcomes } = run
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [p, q] = h.keys as [string, string]
    run.readPendingNoLaunchStart(p)

    await origin(run, p)
    expect(h.latch.record(p)).toEqual(launchStartRecord(p))
    h.script(CLEARED)
    const pAtLatch = personaCallCounts(h, p)
    const touchingAtLatch = tmuxTouchingCallCounts(h.stub.calls)
    const findMissingAtLatch = h.stub.calls.findMissingCalls.length
    // An origin may itself have run restart work or stopped P's timer; only what the paths below add is checked.
    const outcomesAtLatch = outcomes.length
    const pStopsAtLatch = h.stops.filter((stop) => stop.key === p).length

    const { launched, qCalls, notScheduledLines, attemptsBefore } = await driveEveryPath(run)

    // Since the latch, no call of any verb for P's instance, no tmux-touching call for it, and no find-missing sweep.
    expect(callCountsSince(personaCallCounts(h, p), pAtLatch)).toEqual({})
    expect(tmuxTouchingCallsIn(h.stub.calls, touchingAtLatch).filter((call) => instanceOf(call.params) === personaInstanceId(p))).toEqual([])
    expect(h.stub.calls.findMissingCalls.length).toBe(findMissingAtLatch)
    // Never, before the latch or after it, a send-keys or a kill for P.
    expect(tmuxTouchingCallsIn(h.stub.calls).filter((call) => (call.verb === 'send-keys' || call.verb === 'kill') && instanceOf(call.params) === personaInstanceId(p))).toEqual([])
    // Each path stopped for P: the launch and the retry entry answered latched, no restart timer, the retry timer stopped latched.
    expect(launched).toEqual([{ key: p, action: 'latched' }, { key: q, action: 'spawned' }])
    expect(outcomes.slice(outcomesAtLatch)).toEqual([
      [p, RESTART_OUTCOME_LATCHED],
      ...[1, 2, 3, 4].map(() => [q, RESTART_OUTCOME_LAUNCHED] as const),
    ])
    expect(notScheduledLines).toEqual([[notSchedulingLine(p)], [notSchedulingLine(p)]])
    expect(h.attempts.slice(attemptsBefore).map((a) => [a.key, a.retry])).toEqual(retryTimerAttempts(p, q))
    expect(h.stops.filter((stop) => stop.key === p).slice(pStopsAtLatch)).toEqual([{ key: p, reason: UNAVAILABLE_RETRY_STOP_LATCHED }])
    expect([h.controller.isArmed(p), h.controller.armedKeys(), isRestartPendingOrActive(p)]).toEqual([false, [], false])
    // Nothing counted, no spawn-failure notice or spawn-failed entry, one latch and exactly one post: SRJ-1020.
    expect([getFailureCount(p), getFailureCount(q)]).toEqual([0, 0])
    expect(h.notices).toEqual([])
    expect(h.startupErrors()).toEqual([])
    expect(harnessSetOutcomes(h)).toEqual([[p, CONFLICT_LATCH_SET_LATCHED]])
    expect(h.episodeNotices).toEqual([{ key: p, text: launchStartNotRecordedNoticeText(p) }])
    expect(h.latch.isLatched(q)).toBe(false)
    // Q, beside it, still reaches the stub on every path.
    expect(qCalls).toEqual([...Q_CALLS_ON_EVERY_PATH])
  })

  // SRJ-513's list leg at the real start sweep (SRJ-116, SRJ-714; the E16
  // hatch note): the sweep lists P's own row reading pending with no launch
  // start, as `main()` runs it before the start pass. Another existing cwd
  // is a row the sweep kills when P is not latched.
  const LISTED_NO_LAUNCH_START: ReadonlyArray<readonly [string, (h: RecoveryHarness) => Partial<Phase1ListRow>]> = [
    ['in P\'s working directory', () => ({})],
    ['also carrying the provenance_conflict note (the launch-start case only)', () => ({ liveness_note: provenanceNote })],
    ['in another existing cwd', (h) => ({ cwd: h.home })],
  ]

  test.each(LISTED_NO_LAUNCH_START)('the start sweep lists P\'s own pending row with no launch start %s: P latches with "launch start not recorded" and one SRJ-1020 post; no kill, send-keys or delete of P\'s row follows from the sweep or the start pass after it; a lost message for P reports held for a human', async (_label, overrides) => {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    const [p, q] = h.keys as [string, string]
    const row = cannedListRow({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_NONE, ...overrides(h) }, personaOf(h, p), h.home)
    h.script({ listResult: { spawns: [row] } })

    const result = await h.drive(reconcileOrphans(h.config, h.killRetryClock))

    expect(h.latch.record(p)).toEqual(launchStartRecord(p))
    expect(harnessSetOutcomes(h)).toEqual([[p, CONFLICT_LATCH_SET_LATCHED]])
    expect(latchSteps(h)).toEqual(oneLatch(p))
    expect(result.leftForLatch).toBe(1)

    expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })
    await expectLostMessageReports(h, p, 'held-for-human')

    // Neither the sweep nor the start pass nor the lost message made any call of P's instance, a kill, send-keys or delete included.
    expect(personaCallCounts(h, p)).toEqual({})
    expect(tmuxTouchingCallsIn(h.stub.calls)).toEqual([])
    expect(h.stub.calls.deleteCalls).toEqual([])
    expect(h.episodeNotices).toEqual([{ key: p, text: launchStartNotRecordedNoticeText(p) }])
    expect([h.notices, h.latch.isLatched(q)]).toEqual([[], false])
  })

  // b.jg5 SRJ-305, SRJ-301: a launch that returned success arms P's
  // pending-only watch, but never for a latched persona. P latches while its
  // spawn is in flight (an own-row read of its pending row with no launch
  // start); the spawn then returns: no pending-only arm, one line saying why.
  test('P latched while its launch\'s spawn is in flight: the spawn\'s success arms no pending-only watch for P, with one not-arming line; Q\'s launch beside it arms its own', async () => {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    const [p, q] = h.keys as [string, string]
    const hold = holdSpawns(h.stub.client, (id) => id === personaInstanceId(p))
    const launch = h.launch(p)
    await hold.entered(personaInstanceId(p))

    h.script({ getResult: cannedGetResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_NONE }, personaOf(h, p), h.home) })
    expect(await readPersonaOwnRow(p, { site: 'conflict-latch.test', what: 'own-row read' })).toMatchObject({ latched: true })
    expect(h.latch.record(p)).toEqual(launchStartRecord(p))
    hold.release(personaInstanceId(p))
    await launch
    await h.settle()

    expect(h.triggers.filter((trigger) => trigger.key === p)).toEqual([])
    expect(h.controller.isArmed(p)).toBe(false)
    expect(h.errors.filter((line) => line === latchedNoArmPendingRowLine(renderPersonaRef(personaOf(h, p).name, p)))).toHaveLength(1)
    expect(await h.launch(q)).toEqual({ key: q, action: 'spawned' })
    expect(h.triggers).toEqual([{ key: q, kind: UNAVAILABLE_RETRY_CAUSE_PENDING_ROW }])
    await h.runApproverToStop(q)
  })

  /** A key outside the harness's personas, or a persona removed from the applied configuration, whose row reads `pending` with no launch start. */
  const UNCONFIGURED_KEYS: ReadonlyArray<readonly [string, (h: RecoveryHarness, p: string) => string]> = [
    ['a key outside the harness\'s personas', (h) => {
      expect(h.keys).not.toContain(LAUNCH_START_ABSENT_PERSONA_KEY)
      return LAUNCH_START_ABSENT_PERSONA_KEY
    }],
    ['a persona removed from the applied configuration', (h, p) => {
      h.remove(p)
      return p
    }],
  ]

  test.each(UNCONFIGURED_KEYS)('a no-launch-start pending row under %s latches no one and posts nothing, at a get and at a status read', async (_label, keyOf) => {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    const [p] = h.keys as [string]
    const persona = personaOf(h, p)
    const key = keyOf(h, p)
    const row = { state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_NONE }
    h.script({
      getResult: cannedGetResult(row, { ...persona, key }, h.home),
      statusResult: cannedStatusResult(row),
    })
    const site: OwnRowReadSite = { site: 'conflict-latch.test', what: 'own-row read' }

    expect(await readPersonaOwnRow(key, site)).toMatchObject({ kind: OWN_ROW_READ_ROW, latched: false })
    expect(await readPersonaOwnRowStatus(key, site)).toMatchObject({ kind: OWN_ROW_STATUS_STATE, state: AGENT_DIRECTOR_PENDING_STATE })
    expect([...h.keys, LAUNCH_START_ABSENT_PERSONA_KEY].filter((k) => h.latch.isLatched(k))).toEqual([])
    expect([h.latchEvents, h.episodeNotices, h.notices]).toEqual([[], [], []])
  })
})

describe('SRJ-513, A2: a CONFLICT or an UNUSABLE NAME whose latch-time status read finds P\'s own row pending with no launch start leaves P latched with "launch start not recorded" alone, with one post (recovery harness)', () => {
  const plainSpawnConflict = rowWhere(
    (row) => row.refusedOperation === REFUSED_OPERATION_PLAIN_SPAWN && row.latchCase === LATCH_CASE_LEFTOVER && row.rowState !== LATCH_ROW_STATE_NO_ROW,
  )
  const plainSpawnUnusable = unusableRow('plain spawn', 'empty')

  test.each([
    ['a CONFLICT (a case-table row)', (): Error => plainSpawnConflict.build()],
    ['an UNUSABLE NAME', (): Error => plainSpawnUnusable.build()],
  ] as const)('P\'s first spawn refused with %s: the latch-time read latches P with the launch-start case, no other case is set on top, and the one post is SRJ-1020\'s', async (_label, spawnError) => {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    const [p, q] = h.keys as [string, string]
    h.script({ spawnError: spawnError(), ...pNoLaunchStartStatus(p) })

    expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })
    expect(h.latch.record(p)).toEqual(launchStartRecord(p))
    expect(harnessSetOutcomes(h)).toEqual([[p, CONFLICT_LATCH_SET_LATCHED]])
    expect(latchSteps(h)).toEqual(oneLatch(p))
    expect(h.episodeNotices).toEqual([{ key: p, text: launchStartNotRecordedNoticeText(p) }])
    expect(personaCallCounts(h, p)).toEqual({ spawnCalls: 1, statusCalls: 1 })
    expect([h.notices, getFailureCount(p), h.latch.isLatched(q)]).toEqual([[], 0, false])
  })
})

describe('SRJ-513, SRJ-512: P latched on another case relatches through a real own-row status read with one new post (recovery harness)', () => {
  /** The reading site the step's lines name. */
  const SITE: OwnRowReadSite = { site: 'conflict-latch.test', what: 'own-row status read' }
  const conflictRow = rowWhere(
    (row) => row.refusedOperation === REFUSED_OPERATION_PLAIN_SPAWN && row.latchCase === LATCH_CASE_LEFTOVER && row.rowState !== LATCH_ROW_STATE_NO_ROW,
  )
  const unusable = unusableRow('status', 'empty')

  /** `[slack] <site>: <what> for persona=<key>`: the head of every line the step logs for `key` at `SITE`. */
  const stepHead = (key: string) => `[slack] ${SITE.site}: ${SITE.what} for persona=${key}`
  /** The lines the step logged at `SITE` for `key` since `from` (an index into `h.errors`). */
  const stepLinesSince = (h: RecoveryHarness, key: string, from: number) => h.errors.slice(from).filter((line) => line.startsWith(`${stepHead(key)}:`))

  /** A `status` answer: persona `p`'s own row answers UNUSABLE NAME; every other persona's row is gone. */
  const pUnusableStatus = (p: string): RecoveryStubScript => ({
    statusFn: (params) => (params.claude_instance_id === personaInstanceId(p) ? unusable.build() : errSpawnNotFound()),
  })

  /** Each way P is latched first through a real path: the case it holds, its one post and the episode kind it opened. */
  const FIRST_LATCHES: ReadonlyArray<readonly [string, (h: RecoveryHarness, p: string) => Promise<unknown>, LatchCase, (p: string) => string, PersonaEpisodeKind]> = [
    [
      'a CONFLICT (a case-table row) at P\'s launch',
      async (h, p) => {
        h.script({ spawnError: conflictRow.build() })
        expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })
        h.script({ spawnError: undefined })
      },
      LATCH_CASE_LEFTOVER,
      () => conflictRow.notice.text,
      PERSONA_EPISODE_KIND_CONFLICT,
    ],
    [
      '"unusable recorded name" at a status read',
      async (h, p) => {
        h.script(pUnusableStatus(p))
        expect(await readPersonaOwnRowStatus(p, SITE)).toEqual({ kind: OWN_ROW_STATUS_LATCHED, rowState: LATCH_ROW_STATE_UNREADABLE })
        expect(h.latch.record(p)).toEqual(unusable.record(p))
      },
      LATCH_CASE_UNUSABLE_RECORDED_NAME,
      (p) => unusable.notice(p),
      PERSONA_EPISODE_KIND_UNUSABLE_RECORDED_NAME,
    ],
  ]

  test.each(FIRST_LATCHES)('P latched first on %s: a status read of P\'s own pending row with no launch start relatches it with "launch start not recorded", ends the first episode, posts SRJ-1020 once and logs the relatched line', async (_label, latchFirst, firstCase, firstPost, firstKind) => {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    const [p, q] = h.keys as [string, string]
    await latchFirst(h, p)
    expect(h.latch.record(p)?.latchCase).toBe(firstCase)
    expect(h.episodes.isOpen(p, firstKind)).toBe(true)

    h.script(pNoLaunchStartStatus(p))
    const from = h.errors.length
    expect(await readPersonaOwnRowStatus(p, SITE)).toEqual({ kind: OWN_ROW_STATUS_LATCHED, rowState: PENDING })

    expect(h.latch.record(p)).toEqual(launchStartRecord(p))
    expect(harnessSetOutcomes(h)).toEqual([[p, CONFLICT_LATCH_SET_LATCHED], [p, CONFLICT_LATCH_SET_RELATCHED]])
    expect([h.episodes.isOpen(p, firstKind), h.episodes.isOpen(p, PERSONA_EPISODE_KIND_LAUNCH_START_NOT_RECORDED)]).toEqual([false, true])
    expect(h.episodeNotices).toEqual([
      { key: p, text: firstPost(p) },
      { key: p, text: launchStartNotRecordedNoticeText(p) },
    ])
    expect(stepLinesSince(h, p, from)).toEqual([
      `${stepHead(p)}: its row read latches the persona (case=${LATCH_CASE_LAUNCH_START_NOT_RECORDED}, state=${AGENT_DIRECTOR_PENDING_STATE}) — the persona relatched; nothing more is called for it (b.jg5 SRJ-115, SRJ-501)`,
    ])
    expect([h.notices, h.latch.isLatched(q)]).toEqual([[], false])
  })

  test('P latched on "launch start not recorded" by a status read: a status read answering UNUSABLE NAME relatches it with "unusable recorded name", ends the launch-start episode, posts SRJ-1019 once and logs the relatched line', async () => {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    const [p, q] = h.keys as [string, string]
    h.script(pNoLaunchStartStatus(p))
    expect(await readPersonaOwnRowStatus(p, SITE)).toEqual({ kind: OWN_ROW_STATUS_LATCHED, rowState: PENDING })
    expect(h.latch.record(p)).toEqual(launchStartRecord(p))
    expect(h.episodes.isOpen(p, PERSONA_EPISODE_KIND_LAUNCH_START_NOT_RECORDED)).toBe(true)

    h.script(pUnusableStatus(p))
    const from = h.errors.length
    expect(await readPersonaOwnRowStatus(p, SITE)).toEqual({ kind: OWN_ROW_STATUS_LATCHED, rowState: LATCH_ROW_STATE_UNREADABLE })

    expect(h.latch.record(p)).toEqual(unusable.record(p))
    expect(harnessSetOutcomes(h)).toEqual([[p, CONFLICT_LATCH_SET_LATCHED], [p, CONFLICT_LATCH_SET_RELATCHED]])
    expect([
      h.episodes.isOpen(p, PERSONA_EPISODE_KIND_LAUNCH_START_NOT_RECORDED),
      h.episodes.isOpen(p, PERSONA_EPISODE_KIND_UNUSABLE_RECORDED_NAME),
    ]).toEqual([false, true])
    expect(h.episodeNotices).toEqual([
      { key: p, text: launchStartNotRecordedNoticeText(p) },
      { key: p, text: unusable.notice(p) },
    ])
    // The answer is rendered by the redacting describer between the head and the outcome.
    const lines = stepLinesSince(h, p, from)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.endsWith(' — UNUSABLE NAME: the persona relatched; nothing more is called for it (b.jg5 SRJ-105, SRJ-512)')).toBe(true)
    expect([h.notices, h.latch.isLatched(q)]).toEqual([[], false])
  })
})

describe('SRJ-513, SRJ-1011: a message lost for P whose row reads pending with no launch start (AC 68, recovery harness)', () => {
  /** A harness (both settings 0) whose `status` answers `script`, with its two personas. */
  function makeLostRun(script: (p: string) => RecoveryStubScript): { h: RecoveryHarness; p: string; q: string } {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [p, q] = h.keys as [string, string]
    h.script(script(p))
    return { h, p, q }
  }

  /** No restart was asked for P, none is pending or running, and nothing is counted for it. */
  function expectNoRestartFor(h: RecoveryHarness, p: string): void {
    expect(h.restartAsks.filter((key) => key === p)).toEqual([])
    expect(isRestartPendingOrActive(p)).toBe(false)
    expect(getFailureCount(p)).toBe(0)
  }

  test('with nothing latched, the message\'s one status read latches P and the message reports held for a human at P\'s destination, with no restart; one SRJ-1020 post; Q reports its own state', async () => {
    const { h, p, q } = makeLostRun(pNoLaunchStartStatus)
    const lost = await expectLostMessageReports(h, p, 'held-for-human', { calls: { statusCalls: 1 } })
    const persona = personaOf(h, p)
    expect(posts(h.slack(p)).map((post) => [post.channel, post.text])).toEqual([[persona.permission_prompts, formatPersonaNotice(persona, lost.notice)]])
    expect(h.latch.record(p)).toEqual(launchStartRecord(p))
    expect(h.episodeNotices).toEqual([{ key: p, text: launchStartNotRecordedNoticeText(p) }])
    expectNoRestartFor(h, p)

    await expectLostMessageReports(h, q, 'auto-restart-disabled')
    expect(h.latch.isLatched(q)).toBe(false)
  })

  test('the same lost-message read answering UNUSABLE NAME latches P with "unusable recorded name"; the message reports held for a human, with no restart; one SRJ-1019 post', async () => {
    const row = unusableRow('status', 'empty')
    const { h, p, q } = makeLostRun((key) => ({
      statusFn: (params) => (params.claude_instance_id === personaInstanceId(key) ? errUnusableName('empty') : errSpawnNotFound()),
    }))
    await expectLostMessageReports(h, p, 'held-for-human', { calls: { statusCalls: 1 } })
    expect(h.latch.record(p)).toEqual(row.record(p))
    expect(h.episodeNotices).toEqual([{ key: p, text: row.notice(p) }])
    expectNoRestartFor(h, p)
    expect(h.latch.isLatched(q)).toBe(false)
  })

  test('the same row with a launch start reports the session starting and latches nothing', async () => {
    const { h, p } = makeLostRun((key) => ({
      statusFn: (params) =>
        params.claude_instance_id === personaInstanceId(key) ? cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE }) : errSpawnNotFound(),
    }))
    await expectLostMessageReports(h, p, 'session-starting')
    expect([h.latch.isLatched(p), h.latchEvents, h.episodeNotices]).toEqual([false, [], []])
    expectNoRestartFor(h, p)
  })

  /** Each way P is already latched by an own-row status read before the message: its record, and its post. */
  const ALREADY_LATCHED: ReadonlyArray<readonly [string, (p: string) => RecoveryStubScript, (p: string) => ConflictLatchRecord, (p: string) => string]> = [
    ['on this case', pNoLaunchStartStatus, launchStartRecord, launchStartNotRecordedNoticeText],
    [
      'on "unusable recorded name"',
      () => ({ statusError: errUnusableName('empty') }),
      (p) => unusableRow('status', 'empty').record(p),
      (p) => unusableRow('status', 'empty').notice(p),
    ],
  ]

  test.each(ALREADY_LATCHED)('with P already latched %s, a lost message reports held for a human with no status read and no restart; Q reports its own state', async (_label, latchScript, record, notice) => {
    const { h, p, q } = makeLostRun(latchScript)
    const site: OwnRowReadSite = { site: 'conflict-latch.test', what: 'own-row status read' }
    expect(await readPersonaOwnRowStatus(p, site)).toMatchObject({ kind: OWN_ROW_STATUS_LATCHED })
    expect(h.latch.record(p)).toEqual(record(p))
    h.script({ statusError: undefined, ...pNoLaunchStartStatus(p) })
    const pCalls = personaCallCounts(h, p)

    await expectLostMessageReports(h, p, 'held-for-human')
    expect(personaCallCounts(h, p)).toEqual(pCalls)
    expectNoRestartFor(h, p)
    expect(h.episodeNotices).toEqual([{ key: p, text: notice(p) }])

    await expectLostMessageReports(h, q, 'auto-restart-disabled')
    expect(h.latch.isLatched(q)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The dialog approver's latches (b.jg5 SRJ-404, SRJ-501, SRJ-502, SRJ-512,
// SRJ-513; SRJ-117 and SRJ-118's approver rows), on the recovery harness
// ---------------------------------------------------------------------------

/** The approver verb of one of its site kinds; throws for any other site, so a case never runs on a wrong row. */
function approverVerbOf(site: string): ApproverVerb {
  if (!isApproverSite(site)) throw new Error(`not an approver site: ${site}`)
  return site.slice('approver '.length) as ApproverVerb
}

/** The calls one approver lap makes up to and including its call at `verb`, by verb (one each). */
function lapCallsThrough(verb: ApproverVerb): Record<string, number> {
  const verbs = APPROVER_SITES.map(approverVerbOf)
  return Object.fromEntries(verbs.slice(0, verbs.indexOf(verb) + 1).map((v) => [APPROVER_VERB_CALLS[v], 1]))
}

/** One answer to the approver that latches P: the verb that meets it, the answer, and what the latch holds and posts for persona `key`. */
interface ApproverLatchCase {
  readonly verb: ApproverVerb
  readonly build: () => Error
  readonly record: (key: string) => ConflictLatchRecord
  readonly notice: (key: string) => string
}

/**
 * Every approver row of the helper's tables: each CONFLICT its `read-pane`
 * and `send-keys` can meet on a `pending` row records P's next check or
 * recovery and `pending` (b.jg5 SRJ-501, typed here from the SRD, not read
 * from the row) beside the row's quoted session and description, as a whole
 * record; each UNUSABLE NAME at its `status`, `read-pane` and `send-keys`
 * holds the row's whole record (refused operation none).
 */
const APPROVER_LATCH_CASES: ReadonlyArray<readonly [string, ApproverLatchCase]> = [
  ...APPROVER_CONFLICT_CASE_ROWS.map((row): readonly [string, ApproverLatchCase] => [
    `CONFLICT at ${row.name}`,
    {
      verb: approverVerbOf(row.site),
      build: row.build,
      record: (key) =>
        expectedLatchRecord(key, {
          sessionName: row.sessionName,
          latchCase: row.latchCase,
          refusedOperation: REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY,
          rowState: latchRowStateRead(AGENT_DIRECTOR_PENDING_STATE),
          description: row.build().errDescription,
        }),
      notice: () => row.notice.text,
    },
  ]),
  ...APPROVER_UNUSABLE_NAME_CASE_ROWS.map((row): readonly [string, ApproverLatchCase] => [
    `UNUSABLE NAME at ${row.name}`,
    { verb: approverVerbOf(row.site), build: row.build, record: row.record, notice: row.notice },
  ]),
]

/**
 * Every pane shows the folder-trust dialog, and persona `key`'s approver
 * call at `verb` answers `err`: its `status` through the run's row reads, a
 * pane verb by wrapping the stub client's verb, which records the call
 * before it answers.
 */
function approverMeets(run: AutomatedPathsRun, key: string, verb: ApproverVerb, err: Error): void {
  const { h } = run
  h.script({ readPaneResults: [{ pane: TRUST_DIALOG_NEEDLE }] })
  const id = personaInstanceId(key)
  const client = h.stub.client
  if (verb === 'status') {
    run.failStatus(key, err)
  } else if (verb === 'read-pane') {
    const readPane = client.readPane.bind(client)
    client.readPane = async (params) => {
      const result = await readPane(params)
      if (params.claude_instance_id === id) throw err
      return result
    }
  } else {
    const sendKeys = client.sendKeys.bind(client)
    client.sendKeys = async (params) => {
      const result = await sendKeys(params)
      if (params.claude_instance_id === id) throw err
      return result
    }
  }
}

/** The calls of persona `key`'s instance in one stub call list. */
const callsOf = (calls: readonly unknown[], key: string): unknown[] => calls.filter((params) => instanceOf(params) === personaInstanceId(key))

/** The approver's cap in the cases where P latches from another path: past the laps the case drives, so only a stop ends P's approver. */
const OTHER_PATH_CAP_MS = 10 * DIALOG_POLL_INTERVAL_MS

/** The reading site the other paths' own-row reads name. */
const OTHER_PATH_SITE: OwnRowReadSite = { site: 'conflict-latch.test', what: 'another path\'s own-row read' }

/** A plain spawn's CONFLICT whose row state comes from the latch-time `status` read. */
const ladderSpawnRow = lazyRow(
  (row) => row.refusedOperation === REFUSED_OPERATION_PLAIN_SPAWN && row.latchCase === LATCH_CASE_LEFTOVER && row.rowState !== LATCH_ROW_STATE_NO_ROW,
)

/** Each other path that latches P while its approver runs, and the case it records. */
const OTHER_LATCH_PATHS: ReadonlyArray<readonly [string, (run: AutomatedPathsRun, p: string) => Promise<void>, LatchCase]> = [
  [
    'an own-row get read of a provenance_conflict note',
    async ({ h }, p) => {
      h.script({ getResult: cannedGetResult({ state: AGENT_DIRECTOR_PENDING_STATE, liveness_note: provenanceNote }, personaOf(h, p), h.home) })
      expect(await readPersonaOwnRow(p, OTHER_PATH_SITE)).toMatchObject({ latched: true })
    },
    LATCH_CASE_CONFLICTING_LABELS,
  ],
  [
    'an own-row status read of its pending row with no launch start',
    async (run, p) => {
      run.readPendingNoLaunchStart(p)
      expect(await readPersonaOwnRowStatus(p, OTHER_PATH_SITE)).toMatchObject({ kind: OWN_ROW_STATUS_LATCHED })
    },
    LATCH_CASE_LAUNCH_START_NOT_RECORDED,
  ],
  [
    'a CONFLICT at a new launch\'s plain spawn',
    async ({ h }, p) => {
      h.script({ spawnError: ladderSpawnRow().build() })
      expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })
    },
    // The row's case, by its lookup.
    LATCH_CASE_LEFTOVER,
  ],
]

/** When the other path latches P: while its approver sleeps between laps, or while its first `read-pane` (showing the dialog) is awaited. */
const LATCH_TIMES = ['between its laps', 'while its read-pane is awaited'] as const

describe('the dialog approver\'s latches: its own CONFLICT or UNUSABLE NAME latches P once, and a latch from any path stops it (recovery harness; SRJ-404, SRJ-501, SRJ-502, SRJ-512, SRJ-513)', () => {
  test.each(APPROVER_LATCH_CASES)('%s: P latches once with its record and one post, its approver stops latched with nothing typed after it, and no automated path calls P while it is latched; Q\'s approver clears its own dialog', async (_name, c) => {
    const run = makeAutomatedPathsRun()
    const { h } = run
    const [p, q] = h.keys as [string, string]
    run.readPending(p)
    run.readPending(q)
    approverMeets(run, p, c.verb, c.build())

    expect(await h.launch(p)).toEqual({ key: p, action: 'spawned' })
    expect(await h.launch(q)).toEqual({ key: q, action: 'spawned' })
    await h.settle()

    // P: its lap's calls up to the refused one and none after; one latch through the latch's set entry, one post; nothing counted or noticed.
    // Each launch armed its persona's timer pending-only (b.jg5 SRJ-301, SRJ-409); the latch's hold stopped P's, Q's stays armed.
    expect((await h.runApproverToStop(p))?.reason).toBe(APPROVER_STOP_LATCHED)
    expect(personaCallCounts(h, p)).toEqual({ spawnCalls: 1, ...lapCallsThrough(c.verb) })
    expect(h.latch.record(p)).toEqual(c.record(p))
    expect(latchSteps(h)).toEqual(oneLatch(p))
    expect(h.episodeNotices).toEqual([{ key: p, text: c.notice(p) }])
    expect([h.triggers, h.controller.armedKeys(), getFailureCount(p), h.notices]).toEqual([
      [{ key: p, kind: UNAVAILABLE_RETRY_CAUSE_PENDING_ROW }, { key: q, kind: UNAVAILABLE_RETRY_CAUSE_PENDING_ROW }],
      [q],
      0,
      [],
    ])
    expect(h.stops.filter((stop) => stop.key === p)).toEqual([{ key: p, reason: UNAVAILABLE_RETRY_STOP_LATCHED }])
    // The approver's latched stop arms nothing (b.jg5 SRJ-404).
    expect(h.controller.isArmed(p)).toBe(false)

    // Q, beside it: its approver pressed Enter on its dialog and ran on until its cap; Q is not latched.
    expect(personaCallCounts(h, q)).toEqual({ spawnCalls: 1, ...lapCallsThrough('send-keys') })
    expect(h.approverRunning(q)).toBe(true)
    expect((await h.runApproverToStop(q))?.reason).toBe(APPROVER_STOP_CAP)
    expect(h.latch.isLatched(q)).toBe(false)

    // While P is latched no automated path calls it, tmux-touching or not; Q's paths reach the stub as before.
    run.readPending(q, false)
    const pAtLatch = personaCallCounts(h, p)
    const touchingAtLatch = tmuxTouchingCallCounts(h.stub.calls)
    const { launched, qCalls, attemptsBefore } = await driveEveryPath(run)
    expect(callCountsSince(personaCallCounts(h, p), pAtLatch)).toEqual({})
    expect(tmuxTouchingCallsIn(h.stub.calls, touchingAtLatch).filter((call) => instanceOf(call.params) === personaInstanceId(p))).toEqual([])
    expect(launched).toEqual([{ key: p, action: 'latched' }, { key: q, action: 'spawned' }])
    expect(h.attempts.slice(attemptsBefore).map((a) => [a.key, a.retry])).toEqual(retryTimerAttempts(p, q))
    // The latch's hold stopped the pending-only timer P's launch armed; the retry timer path's arm then fired once and stopped latched.
    expect(h.stops.filter((stop) => stop.key === p)).toEqual([
      { key: p, reason: UNAVAILABLE_RETRY_STOP_LATCHED },
      { key: p, reason: UNAVAILABLE_RETRY_STOP_LATCHED },
    ])
    expect(qCalls).toEqual([...Q_CALLS_ON_EVERY_PATH])
    // Still the one latch and the one post.
    expect(latchSteps(h)).toEqual(oneLatch(p))
    expect(h.episodeNotices).toEqual([{ key: p, text: c.notice(p) }])
    expect([getFailureCount(p), h.clock.pendingCount()]).toEqual([0, 0])
  })

  test.each(OTHER_LATCH_PATHS.flatMap(([name, latchP, latchCase]) => LATCH_TIMES.map((when) => [name, when, latchP, latchCase] as const)))('P latched by %s %s: its running approver stops latched and makes no further call, so no Enter reaches P after the latch; one post; Q\'s approver runs on and keeps clearing its dialog', async (_name, when, latchP, latchCase) => {
    const run = makeAutomatedPathsRun({ approverCapMs: OTHER_PATH_CAP_MS })
    const { h } = run
    const [p, q] = h.keys as [string, string]
    run.readPending(p)
    run.readPending(q)
    h.script({ readPaneResults: [{ pane: TRUST_DIALOG_NEEDLE }] })
    let pAtLatch: Record<string, number> | undefined
    const latchNow = async (): Promise<void> => {
      await latchP(run, p)
      pAtLatch = personaCallCounts(h, p)
    }
    if (when === 'while its read-pane is awaited') {
      // P's first pane read is made and shows the dialog; P latches before the approver gets its answer.
      const client = h.stub.client
      const readPane = client.readPane.bind(client)
      client.readPane = async (params) => {
        const result = await readPane(params)
        if (params.claude_instance_id === personaInstanceId(p) && pAtLatch === undefined) await latchNow()
        return result
      }
    }

    expect(await h.launch(p)).toEqual({ key: p, action: 'spawned' })
    expect(await h.launch(q)).toEqual({ key: q, action: 'spawned' })
    await h.settle()
    if (when === 'between its laps') {
      // P's first lap pressed Enter, and its approver sleeps until its next lap.
      expect(h.approverRunning(p)).toBe(true)
      await latchNow()
    }
    await h.settle()

    // Stopped by the latch, not by its cap: no longer running before the clock moves.
    expect(h.approverRunning(p)).toBe(false)
    expect((await h.runApproverToStop(p))?.reason).toBe(APPROVER_STOP_LATCHED)
    expect(callsOf(h.stub.calls.sendKeysCalls, p)).toHaveLength(when === 'between its laps' ? 1 : 0)
    expect(h.latch.record(p)?.latchCase).toBe(latchCase)
    expect(latchSteps(h)).toEqual(oneLatch(p))
    expect(h.episodeNotices.map((notice) => notice.key)).toEqual([p])

    // Three laps of Q later: no call for P, and Q, unlatched, pressed Enter at each.
    expect(h.approverRunning(q)).toBe(true)
    const qEnters = callsOf(h.stub.calls.sendKeysCalls, q).length
    await h.advance(3 * DIALOG_POLL_INTERVAL_MS)
    expect(callCountsSince(personaCallCounts(h, p), pAtLatch!)).toEqual({})
    expect(callsOf(h.stub.calls.sendKeysCalls, q)).toHaveLength(qEnters + 3)
    expect([h.latch.isLatched(q), h.approverRunning(q)]).toEqual([false, true])
    expect(h.episodeNotices.map((notice) => notice.key)).toEqual([p])
    expect((await h.runApproverToStop(q))?.reason).toBe(APPROVER_STOP_CAP)
    // Q's launch left its timer armed pending-only (b.jg5 SRJ-301, SRJ-409); P's was stopped by the latch's hold.
    // Once Q's is stopped, nothing else is pending.
    expectPendingOnlyWatch(h, q)
    expect(h.controller.armedKeys()).toEqual([q])
    expect(h.stops.filter((stop) => stop.key === p)).toEqual([{ key: p, reason: UNAVAILABLE_RETRY_STOP_LATCHED }])
    h.controller.stop(q, 'the case is over')
    expect(h.clock.pendingCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The live-row sequence's own latches (E21; b.jg5 SRJ-110, SRJ-501, SRJ-512,
// SRJ-513, SRJ-114, SRJ-613; the E13, E14, E16 and E20 hatch notes)
//
// On `makeRecoveryHarness` with its sequence driver (`runSequence`): P's
// sequence meets each of the case table's sequence-kill rows at its step-1 or
// step-4 kill (the state the sequence last read: a `pending` seed or `get`,
// or a live `waiting` one), a `provenance_conflict` note at a `get`, or P's
// own `pending` row with no launch start at its step-2 `get`. Each latches P
// once through the latch's entries with one post, and the sequence makes no
// further call; a latching read's outcome (stopped for the latch, nothing
// armed) is asserted here too, a kill's is tests/live-row-sequence.test.ts's.
// ---------------------------------------------------------------------------

/** The live-row sequence's own latch: how P's sequence meets it, and what it records and posts. */
interface SequenceLatchWay {
  /** The kill site whose kill answers `error`. */
  readonly site: SequenceKillSite
  /** The state the sequence last read before that kill. */
  readonly state: string
  readonly error: () => Error
  readonly record: (key: string) => ConflictLatchRecord
  readonly notice: (key: string) => string
}

/** The state a sequence-kill row records, as read. */
function stateReadOf(rowState: LatchRowState): string {
  if (rowState.kind !== LATCH_ROW_STATE_KIND_READ) throw new Error('a sequence-kill row records a state the sequence read')
  return rowState.state
}

const SEQUENCE_LATCH_WAYS: ReadonlyArray<readonly [string, SequenceLatchWay]> = [
  ...SEQUENCE_KILL_CONFLICT_CASE_ROWS.map((row) => [
    `CONFLICT (${row.name}${row.killBackstop === true ? ", SRJ-613's kill backstop" : ''})`,
    {
      site: row.site as SequenceKillSite,
      state: stateReadOf(row.rowState),
      error: row.build,
      record: (key: string) =>
        expectedLatchRecord(key, {
          latchCase: row.latchCase,
          refusedOperation: row.refusedOperation,
          rowState: row.rowState,
          sessionName: row.sessionName,
          description: row.build().errDescription,
        }),
      notice: () => row.notice.text,
    },
  ] as const),
  ...SEQUENCE_KILL_UNUSABLE_NAME_CASE_ROWS.map((row) => [
    `UNUSABLE NAME (${row.name})`,
    { site: row.site as SequenceKillSite, state: stateReadOf(row.rowState), error: row.build, record: row.record, notice: row.notice },
  ] as const),
]

/**
 * Script P's sequence to reach `site`'s kill having last read `state`, and
 * that kill to answer `error` (`scriptSequenceKillFailure`): every `get`
 * reads P's own row in `state`, every run judges it and leaves it live, and
 * an earlier kill succeeds. The clock is past G from the stub's sample launch
 * start (`pastSampleGrace`), so a `pending` row is waited on no longer.
 * Answers the calls the sequence makes before that kill
 * (`callsBeforeSequenceKill`).
 */
async function scriptSequenceKill(h: RecoveryHarness, key: string, site: SequenceKillSite, state: string, error: () => Error): Promise<string[]> {
  await pastSampleGrace(h)
  const step = SEQUENCE_KILL_STEP[site]
  h.script({ getResult: personaRow(h, key, { state }), findMissingResult: cannedFindMissing({ rows: { [personaInstanceId(key)]: 'unverified_ids' } }) })
  scriptSequenceKillFailure(h, step, error)
  return callsBeforeSequenceKill(step)
}

describe('the live-row sequence\'s own latches: a kill CONFLICT or UNUSABLE NAME, a note at a get, a pending row with no launch start (recovery harness; SRJ-110, SRJ-501, SRJ-512, SRJ-513, SRJ-114, SRJ-613)', () => {
  /** A recovery harness, cleaned up and leak-checked in `afterEach`. */
  function makeSequenceRun(): { h: RecoveryHarness; p: string; q: string } {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    const [p, q] = h.keys as [string, string]
    return { h, p, q }
  }

  test.each(SEQUENCE_LATCH_WAYS)('%s: P latches once with the row\'s record and one post; the kill is sent once and nothing follows it; P\'s retry timer stops', async (_label, way) => {
    const { h, p } = makeSequenceRun()
    const before = await scriptSequenceKill(h, p, way.site, way.state, way.error)
    h.controller.arm(p, { kind: UNAVAILABLE_RETRY_CAUSE_READ_ERROR })
    const order = recordCallOrder(h)

    await h.runSequence(p, { lastReadState: way.state })

    // The latching kill is the last call: never retried, and no find-missing, get, kill, launch or other tmux-touching call after it.
    expect(order).toEqual([...before, 'kill'])
    expect(h.latch.record(p)).toEqual(way.record(p))
    expect(latchSteps(h)).toEqual(oneLatch(p))
    expect(h.episodeNotices).toEqual([{ key: p, text: way.notice(p) }])
    expect(h.stops).toEqual([{ key: p, reason: UNAVAILABLE_RETRY_STOP_LATCHED }])
    expect(h.controller.isArmed(p)).toBe(false)
    expect(getFailureCount(p)).toBe(0)
  })

  test('Q\'s sequence, run beside P\'s, is unaffected: Q is not latched and goes on to its launch', async () => {
    const { h, p, q } = makeSequenceRun()
    const [row] = SEQUENCE_KILL_CONFLICT_CASE_ROWS
    const client = h.stub.client
    const kill = client.kill.bind(client)
    client.kill = async (params) => {
      if (params.claude_instance_id === personaInstanceId(p)) throw row!.build()
      return kill(params)
    }
    h.script({
      getFn: (params) =>
        params.claude_instance_id === personaInstanceId(q)
          ? cannedGetResult({ state: LIVENESS_DEAD_ROW_ENDED }, personaOf(h, q), h.home)
          : cannedGetResult({}, personaOf(h, p), h.home),
    })
    const lastRead = cannedStatusResult().state

    const [pOutcome, qOutcome] = await h.driveSequence(
      Promise.all([h.startSequence(p, { lastReadState: lastRead }).outcome, h.startSequence(q, { lastReadState: lastRead }).outcome]),
    )

    expect(pOutcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_ABORTED, latched: true })
    expect(qOutcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED })
    expect([h.latch.isLatched(p), h.latch.isLatched(q)]).toEqual([true, false])
    expect(h.episodeNotices.map((notice) => notice.key)).toEqual([p])
    expect(h.reuseSpawns().map((reuse) => reuse.claude_instance_id)).toEqual([personaInstanceId(q)])
  })

  test.each([
    ['the step-2 get', 0, ['kill', 'get']],
    ['a confirming get', 1, ['kill', 'get', 'findMissing', 'get']],
  ] as const)('a provenance_conflict note at %s: P latches "conflicting labels" with the note latch\'s refused operation, one post; the sequence stops for the latch with no further call and nothing armed', async (_label, before, calls) => {
    const { h, p } = makeSequenceRun()
    h.script({
      getQueue: [
        ...Array.from({ length: before }, () => cannedOk<Phase1GetResult>(personaRow(h, p))),
        cannedOk<Phase1GetResult>(personaRow(h, p, { liveness_note: provenanceNote })),
      ],
    })
    const order = recordCallOrder(h)

    const outcome = await h.runSequence(p, { lastReadState: cannedStatusResult().state })

    expect(order).toEqual([...calls])
    expect(outcome).toEqual({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_LATCHED, runs: before, kills: 1, judgedRuns: before })
    expect(h.controller.isArmed(p)).toBe(false)

    expect(h.latch.record(p)).toEqual(
      expectedLatchRecord(p, {
        latchCase: LATCH_CASE_CONFLICTING_LABELS,
        refusedOperation: REFUSED_OPERATION_BRING_UP,
        rowState: latchRowStateRead(cannedStatusResult().state),
        sessionName: personaTmuxSessionName(p),
      }),
    )
    expect(latchSteps(h)).toEqual(oneLatch(p))
    expect(h.episodeNotices).toEqual([
      { key: p, text: expectedConflictNotice({ latchCase: LATCH_CASE_CONFLICTING_LABELS, sessionName: personaTmuxSessionName(p) }).text },
    ])
  })

  test('a configured persona\'s own pending row with no launch start at the step-2 get: P latches "launch start not recorded" with one post, and no wait is armed; the sequence stops for the latch with no wait, run or other call', async () => {
    const { h, p } = makeSequenceRun()
    h.script({ getResult: personaRow(h, p, { state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_NONE }) })
    const order = recordCallOrder(h)

    const outcome = await h.runSequence(p, { lastReadState: AGENT_DIRECTOR_PENDING_STATE, entryStep: LIVE_ROW_SEQUENCE_ENTRY_GET })

    expect(order).toEqual(['get'])
    expect(outcome).toEqual({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_LATCHED, runs: 0, kills: 0, judgedRuns: 0 })
    // No wait was armed: no timer fired or is pending on the clock.
    expect([h.clock.firedCount(), h.clock.pendingCount()]).toEqual([0, 0])
    expect(h.latch.record(p)).toEqual(launchStartRecord(p))
    expect(latchSteps(h)).toEqual(oneLatch(p))
    expect(h.episodeNotices).toEqual([{ key: p, text: launchStartNotRecordedNoticeText(p) }])
    expect(h.stub.calls.findMissingCalls).toEqual([])
  })

  test('the same row under an old key that no configured persona uses latches no one', async () => {
    const { h, p } = makeSequenceRun()
    h.remove(p)
    h.script({ getResult: cannedGetResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_NONE }, personaOf(h, p), h.home) })

    await h.runSequence(p, { lastReadState: AGENT_DIRECTOR_PENDING_STATE, entryStep: LIVE_ROW_SEQUENCE_ENTRY_GET })

    expect(h.latch.isLatched(p)).toBe(false)
    expect([h.latchEvents, h.episodeNotices]).toEqual([[], []])
    expect(h.stub.calls.findMissingCalls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// The reuse spawn's latches at the live-row sequence's final launch (E22;
// b.jg5 SRJ-112, SRJ-501, SRJ-507, SRJ-512; HO rev 15, rev 20; AC 77, AC 85)
//
// On `makeRecoveryHarness`, P's sequence ending in the session manager's
// reuse spawn: step 3's `get` reads P's row `ended` (a reuse of a finished
// row) or, for the pre-spawn scan's rows, no row (a reuse of an id with no
// row, an ordinary fresh spawn). The reuse at the collision ladder's
// no-transcript site is tests/session-manager.test.ts's CONFLICT site table,
// with SRJ-504's restart leg and SRJ-507's another-store case above.
// ---------------------------------------------------------------------------

/** How a reuse meets its latch: whether its id has no row, its answer, and what it records and posts. */
interface ReuseLatchWay {
  readonly noRow: boolean
  readonly error: () => Error
  readonly record: (key: string) => ConflictLatchRecord
  readonly notice: (key: string) => string
}

const REUSE_LATCH_WAYS: ReadonlyArray<readonly [string, ReuseLatchWay]> = [
  ...REUSE_SPAWN_CONFLICT_CASE_ROWS.map((row) => [
    `CONFLICT (${row.name}${row.noRowWritten === true ? ', an id with no row' : ''})`,
    {
      noRow: row.noRowWritten === true,
      error: row.build,
      record: (key: string) =>
        expectedLatchRecord(key, {
          latchCase: row.latchCase,
          refusedOperation: row.refusedOperation,
          rowState: row.rowState,
          sessionName: row.sessionName,
          description: row.build().errDescription,
        }),
      notice: () => row.notice.text,
    },
  ] as const),
  ...REUSE_SPAWN_UNUSABLE_NAME_CASE_ROWS.map((row) => [
    `UNUSABLE NAME (${row.name})`,
    { noRow: false, error: row.build, record: row.record, notice: row.notice },
  ] as const),
]

/** P's own row as step 3's `get` reads it: `ended`, or no row (`ErrSpawnNotFound`) for a reuse of an id with no row. */
function reuseRowRead(h: RecoveryHarness, key: string, noRow: boolean): RecoveryStubScript {
  return noRow ? { getError: errSpawnNotFound() } : { getResult: cannedGetResult({ state: LIVENESS_DEAD_ROW_ENDED }, personaOf(h, key), h.home) }
}

describe('the reuse spawn\'s latches at the sequence\'s final launch: CONFLICT with the reuse spawn refused, UNUSABLE NAME with none (recovery harness; SRJ-112, SRJ-501, SRJ-507, SRJ-512; AC 77, AC 85)', () => {
  /** A recovery harness, cleaned up and leak-checked in `afterEach`. */
  function makeReuseRun(): { h: RecoveryHarness; p: string; q: string } {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    const [p, q] = h.keys as [string, string]
    return { h, p, q }
  }

  test.each(REUSE_LATCH_WAYS)('%s: P latches once with the row\'s record and one post; the reuse is P\'s last call (no kill, delete or launch after it); nothing counted; P\'s retry timer stops', async (_label, way) => {
    const { h, p } = makeReuseRun()
    h.script({ ...reuseRowRead(h, p, way.noRow), spawnError: way.error() })
    h.controller.arm(p, { kind: UNAVAILABLE_RETRY_CAUSE_READ_ERROR })
    const order = recordCallOrder(h)

    const outcome = await h.runSequence(p, { lastReadState: cannedStatusResult().state })

    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, result: { key: p, action: 'latched' } })
    // No latch-time status read and no call of any verb after the reuse.
    expect(order).toEqual(['kill', 'get', 'findMissing', 'get', 'spawn'])
    expect(h.reuseSpawns()).toEqual([reuseSpawnOf(h, p)])
    expect(h.latch.record(p)).toEqual(way.record(p))
    expect(latchSteps(h)).toEqual(oneLatch(p))
    expect(h.episodeNotices).toEqual([{ key: p, text: way.notice(p) }])
    expect(h.stops).toEqual([{ key: p, reason: UNAVAILABLE_RETRY_STOP_LATCHED }])
    expect(h.controller.isArmed(p)).toBe(false)
    expect([getFailureCount(p), h.notices, h.startupErrors()]).toEqual([0, [], []])
  })

  test.each(REUSE_SPAWN_UNUSABLE_NAME_CASE_ROWS.map((row) => [row.name, row] as const))('SRJ-512\'s reuse case (%s): the one post points to "Operator actions" and CSCB\'s own words name no session-ending command; a message lost then reports held for a human with no call and no restart', async (_name, row) => {
    const { h, p, q } = makeReuseRun()
    h.script({ ...reuseRowRead(h, p, false), spawnError: row.build() })
    await h.runSequence(p, { lastReadState: cannedStatusResult().state })
    const pCallsAtLatch = personaCallCounts(h, p)

    const [post] = h.episodeNotices
    expect(post).toEqual({ key: p, text: row.notice(p) })
    expect(post!.text.includes(JSON.stringify(operatorActionsTitle()))).toBe(true)
    const own = cscbOwnText(post!.text)
    expect(sessionEndingCommandsIn(own)).toEqual([])
    expect(own.split(CONFLICT_NOTICE_LINE_SEPARATOR).flatMap(cscbOwnLineForbiddenIn)).toEqual([])

    await expectLostMessageReports(h, p, 'held-for-human')
    expect([h.restartAsks.filter((key) => key === p), isRestartPendingOrActive(p), personaCallCounts(h, p)]).toEqual([[], false, pCallsAtLatch])
    expect(h.stub.calls.deleteCalls).toEqual([])
    expect(h.latch.isLatched(q)).toBe(false)
  })

  test('Q\'s sequence, run beside P\'s, is unaffected: P\'s reuse latches it, while Q is not latched and its own reuse launches it', async () => {
    const { h, p, q } = makeReuseRun()
    const [row] = REUSE_SPAWN_CONFLICT_CASE_ROWS
    const client = h.stub.client
    const spawn = client.spawn.bind(client)
    client.spawn = async (params) => {
      if (params.claude_instance_id === personaInstanceId(p)) throw row!.build()
      return spawn(params)
    }
    h.script({ getFn: (params) => cannedGetResult({ state: LIVENESS_DEAD_ROW_ENDED }, personaOf(h, params.claude_instance_id === personaInstanceId(p) ? p : q), h.home) })
    const lastRead = cannedStatusResult().state

    const [pOutcome, qOutcome] = await h.driveSequence(
      Promise.all([h.startSequence(p, { lastReadState: lastRead }).outcome, h.startSequence(q, { lastReadState: lastRead }).outcome]),
    )

    expect(pOutcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, result: { key: p, action: 'latched' } })
    expect(qOutcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, result: { key: q, action: 'spawned' } })
    expect([h.latch.isLatched(p), h.latch.isLatched(q)]).toEqual([true, false])
    expect(h.episodeNotices.map((notice) => notice.key)).toEqual([p])
    expect(h.reuseSpawns().map((reuse) => reuse.claude_instance_id)).toEqual([personaInstanceId(q)])
  })
})

// ---------------------------------------------------------------------------
// A running live-row sequence stops when P latches from another path (E21
// T2; b.jg5 SRJ-502, SRJ-706; the E13 hatch note)
//
// On `makeAutomatedPathsRun`'s recovery harness, whose registry is installed
// after the latch as main() installs it, with P's and Q's sequences started
// through the registry and each first run held. P latches through the other
// paths' own-row reads (a `get` noting `provenance_conflict`, and the tick's
// and retry's `status` read of P's own `pending` row with no launch start):
// the latch's set observer stops P's sequence, so once its run is released
// it makes no further `get`, kill or launch, and no kill of `cscb_<key>`
// follows the latch (AC 46); Q's sequence, not latched, runs on to its
// launch. A start of a latched P's sequence (no call at all) is
// tests/live-row-sequence.test.ts's; a latch installed after the registry,
// tests/session-manager.test.ts's.
// ---------------------------------------------------------------------------

describe('a running live-row sequence stops when P latches from another path: no further get, kill or launch for P, and one post (recovery harness; SRJ-502, SRJ-706, AC 46)', () => {
  test.each(OTHER_LATCH_PATHS.filter(([name]) => name.startsWith('an own-row')))('P latched by %s while its first run is held: a launch of P meanwhile answers latched; once the run is released the sequence ends stopped for the latch and makes no further call for P, with only the latch\'s own post and no alert or timer left; Q\'s sequence beside it runs on to its launch', async (_name, latchP, latchCase) => {
    const run = makeAutomatedPathsRun()
    const { h } = run
    const [p, q] = h.keys as [string, string]
    const hold = holdFindMissing(h.stub.client)
    const sequence = await startSequenceHeldAtRun(h, p, hold)
    const qSequence = await startSequenceHeldAtRun(h, q, hold)
    expect(personaCallCounts(h, p)).toEqual({ killCalls: 1, getCalls: 1 })

    await latchP(run, p)
    const pAtLatch = personaCallCounts(h, p)
    // Only P's sequence was asked to stop.
    expect(h.lines.filter((line) => line.startsWith(LIVE_ROW_SEQUENCE_LOG_PREFIX) && line.includes(': stop asked'))).toEqual([
      liveRowSequenceStopAskedLine(`persona=${p}`, LIVE_ROW_STOP_LATCHED),
    ])

    // Stopped but still settling: the gate gives the latched persona the latched answer, with no call.
    expect(h.sequenceRunning(p)).toBe(true)
    expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })
    // Q's next get reads its own row missing, so its released run goes on to its launch.
    h.script({ getResult: personaRow(h, q, { state: LIVENESS_DEAD_ROW_MISSING }) })
    hold.release(cannedFindMissing({ rows: { [personaInstanceId(p)]: 'ids' } }))
    hold.release(cannedFindMissing({ rows: { [personaInstanceId(q)]: 'ids' } }))

    const [pOutcome, qOutcome] = await h.driveSequence(Promise.all([sequence.outcome, qSequence.outcome]))
    expect(pOutcome).toEqual({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_LATCHED, runs: 1, kills: 1, judgedRuns: 0 })
    expect(qOutcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, result: { key: q, action: 'spawned' } })
    expect(callCountsSince(personaCallCounts(h, p), pAtLatch)).toEqual({})
    expect(h.stub.calls.killCalls).toEqual([{ claude_instance_id: personaInstanceId(p) }, { claude_instance_id: personaInstanceId(q) }])
    expect(hold.calls).toHaveLength(2)
    expect(h.reuseSpawns().map((reuse) => reuse.claude_instance_id)).toEqual([personaInstanceId(q)])
    expect(h.latch.record(p)?.latchCase).toBe(latchCase)
    expect([h.latch.isLatched(q), latchSteps(h)]).toEqual([false, oneLatch(p)])
    expect(h.episodeNotices.map((notice) => notice.key)).toEqual([p])
    expect(killFailureLines(h, p)).toEqual([])
    await h.runApproverToStop(q)
    // Q's sequence's launch left Q's timer armed pending-only (b.jg5 SRJ-301, SRJ-409); P has none. Once it is stopped, nothing is pending.
    expectPendingOnlyWatch(h, q)
    expect(h.controller.armedKeys()).toEqual([q])
    h.controller.stop(q, 'the case is over')
    expect([h.sequenceRunning(p), h.sequenceRunning(q), h.clock.pendingCount()]).toEqual([false, false, 0])
  })
})

// ---------------------------------------------------------------------------
// The not-resumable step's re-read latches (b.jg5 SRJ-710, SRJ-114, SRJ-513)
//
// On `makeRecoveryHarness`. The re-read after `resume`'s ErrSpawnNotResumable
// goes through the shared own-row read, so its latch rules apply: P's launch
// reaches its `resume` through the GONE dead-session route of its `waiting`
// row (dead evidence, so a live re-read would start a sequence), and the
// re-read reads P's row carrying a `provenance_conflict` note, or `pending`
// with no launch start: P latches once, with its one post, and nothing
// follows (no sequence, kill, delete or launch; nothing counted); P's timer,
// armed before, stopped. Q is untouched throughout. `resume`'s CONFLICT rows
// at both `resume` sites are tests/session-manager.test.ts's (`LATCH_CROSS`
// and the sequence-launch entry's).
// ---------------------------------------------------------------------------

describe('the not-resumable step\'s re-read latches (recovery harness; SRJ-710, SRJ-114, SRJ-513)', () => {
  /** A recovery harness, cleaned up and leak-checked in `afterEach`, with P's timer armed so its latch's stop shows. */
  function makeRun(): { h: RecoveryHarness; p: string; q: string } {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    const [p, q] = h.keys as [string, string]
    h.controller.arm(p, { kind: UNAVAILABLE_RETRY_CAUSE_READ_ERROR })
    return { h, p, q }
  }

  /** P latched once (`record`, one post `notice`), its timer stopped, nothing counted or posted otherwise, no sequence; Q untouched. */
  function expectLatchedOnce(h: RecoveryHarness, p: string, q: string, record: ConflictLatchRecord, notice: string): void {
    expect(h.latch.record(p)).toEqual(record)
    expect(latchSteps(h)).toEqual(oneLatch(p))
    expect(h.episodeNotices).toEqual([{ key: p, text: notice }])
    expect(h.stops).toEqual([{ key: p, reason: UNAVAILABLE_RETRY_STOP_LATCHED }])
    expect(h.controller.isArmed(p)).toBe(false)
    expect([h.sequenceRunning(p), getFailureCount(p), h.notices, h.startupErrors()]).toEqual([false, 0, [], []])
    expect([h.stub.calls.killCalls, h.stub.calls.deleteCalls]).toEqual([[], []])
    expect([h.latch.isLatched(q), personaCallCounts(h, q)]).toEqual([false, {}])
  }

  /** P's launch: the colliding spawn, the collision `get` reading P's `waiting` row, its reconnect's GONE, the find-missing run, the `resume`'s ErrSpawnNotResumable and its re-read reading `reread`. */
  function scriptReread(h: RecoveryHarness, p: string, reread: Record<string, unknown>): void {
    h.script({
      ...collided(h, personaOf(h, p), { state: 'waiting' }),
      getQueue: [cannedOk(cannedGetResult({ state: 'waiting' }, personaOf(h, p), h.home))],
      getResult: cannedGetResult(reread, personaOf(h, p), h.home),
      sendKeysError: errTmuxSendKeys(),
      resumeError: errSpawnNotResumable(),
    })
  }

  /** The ladder's calls up to the re-read: nothing after it. */
  const LADDER_TO_REREAD = ['spawn', 'get', 'sendKeys', 'findMissing', 'resume', 'get']

  test('the re-read carries a provenance_conflict note: P latches once with the shared own-row read\'s record ("conflicting labels", slack_bot_<key>, no description) and one post; no sequence starts, though the path holds dead evidence; no call after the re-read', async () => {
    const { h, p, q } = makeRun()
    scriptReread(h, p, { state: 'waiting', liveness_note: provenanceNote })
    const order = recordCallOrder(h)

    expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })

    expect(order).toEqual(LADDER_TO_REREAD)
    expectLatchedOnce(
      h,
      p,
      q,
      { sessionName: personaTmuxSessionName(p), latchCase: LATCH_CASE_CONFLICTING_LABELS, refusedOperation: REFUSED_OPERATION_BRING_UP, rowState: latchRowStateRead('waiting') },
      expectedConflictNotice({ latchCase: LATCH_CASE_CONFLICTING_LABELS, sessionName: personaTmuxSessionName(p) }).text,
    )
  })

  test('the re-read reads P\'s own pending row with no launch start: P latches once with "launch start not recorded" and its one post; no call after the re-read', async () => {
    const { h, p, q } = makeRun()
    scriptReread(h, p, { state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_NONE })
    const order = recordCallOrder(h)

    expect(await h.launch(p)).toEqual({ key: p, action: 'latched' })

    expect(order).toEqual(LADDER_TO_REREAD)
    expectLatchedOnce(h, p, q, launchStartRecord(p), launchStartNotRecordedNoticeText(p))
  })
})

// ---------------------------------------------------------------------------
// The latch re-check (b.jg5 SRJ-505; E30 T1). The decision for every row of
// the case table (every site kind's CONFLICT rows, the "this row's own id"
// rows once their probe is dropped, the UNUSABLE NAME rows, the launch-start
// rows and the note rows), against the columns `conflict-cases.ts` writes
// from SRJ-505's text; then, on the recovery harness with the re-check bound
// as main() binds it and `health_check_interval` 0, one case per row: each
// round, one interval apart, makes step 1's read and exactly the call the
// row's columns name, a still-latched answer keeping the record with no
// post and no call between rounds. A clear's recovery post and what follows
// it (SRJ-506) are the cases of "The clear" section below: these assert that
// P is no longer latched and its timer stopped.
// ---------------------------------------------------------------------------

/** One latch the re-check cases run: a case-table row of any site kind, latched as its site latches it, with its re-check columns. */
interface RecheckTableRow {
  readonly name: string
  /** Where the latch comes from: a CONFLICT row, an unusable-name hold, a launch-start hold or the note. */
  readonly source: string
  /** The case the latch records. */
  readonly latchCase: LatchCase
  /** Latch persona `key` as the row's site does, through the latch's own set entry. */
  readonly latchOn: (latch: RecheckLatchEntries, key: string) => unknown
  /** The whole record the latch holds. */
  readonly record: (key: string) => ConflictLatchRecord
  readonly recheck: RecheckColumns
  /** The "this row's own id" rows' second columns: the episode's probe dropped (`setProbeDropped`) after the latch. */
  readonly probeDropped: boolean
  /** A "launch start not recorded" latch: its row reads `pending` with no launch start, as when it latched. */
  readonly noLaunchStart: boolean
}

/**
 * Every CONFLICT row of the case table: {@link CONFLICT_CASE_ROWS}, then the
 * rows kept out of it because only their recorded state differs (the
 * live-row sequence's step-6 `resume`, E21/E23; the plain spawn recorded
 * unreadable or live, hatch A3).
 */
const EVERY_CONFLICT_ROW: readonly ConflictCaseRow[] = [...CONFLICT_CASE_ROWS, ...SEQUENCE_RESUME_CONFLICT_CASE_ROWS, ...PLAIN_SPAWN_RECORDED_LIVE_CASE_ROWS]

/** Every row of the case table with its re-check columns, by site kind. */
const RECHECK_TABLE: readonly RecheckTableRow[] = [
  ...EVERY_CONFLICT_ROW.flatMap((row): RecheckTableRow[] => [
    { name: `CONFLICT ${row.name}`, source: 'CONFLICT', latchCase: row.latchCase, latchOn: row.latchOn, record: row.record, recheck: row.recheck, probeDropped: false, noLaunchStart: false },
    ...(row.probeDroppedRecheck === undefined
      ? []
      : [
          {
            name: `CONFLICT ${row.name}, its probe dropped`,
            source: 'CONFLICT',
            latchCase: row.latchCase,
            latchOn: row.latchOn,
            record: (key: string): ConflictLatchRecord => ({ ...row.record(key), probeDropped: true }),
            recheck: row.probeDroppedRecheck,
            probeDropped: true,
            noLaunchStart: false,
          },
        ]),
  ]),
  ...UNUSABLE_NAME_CASE_ROWS.map((row): RecheckTableRow => ({
    name: `UNUSABLE NAME ${row.name}`,
    source: 'UNUSABLE NAME',
    latchCase: LATCH_CASE_UNUSABLE_RECORDED_NAME,
    latchOn: row.latchOn,
    record: row.record,
    recheck: row.recheck,
    probeDropped: false,
    noLaunchStart: false,
  })),
  ...[...LAUNCH_START_CASE_ROWS, LAUNCH_START_AND_NOTE_ROW].map((row): RecheckTableRow => ({
    name: `launch start not recorded ${row.name}`,
    source: 'launch start not recorded',
    latchCase: LATCH_CASE_LAUNCH_START_NOT_RECORDED,
    latchOn: row.latchOn,
    record: row.record,
    recheck: row.recheck,
    probeDropped: false,
    noLaunchStart: true,
  })),
  ...NOTE_LATCH_CASE_ROWS.map((row): RecheckTableRow => ({
    name: `the provenance_conflict note ${row.name}`,
    source: 'the provenance_conflict note',
    latchCase: LATCH_CASE_CONFLICTING_LABELS,
    latchOn: row.latchOn,
    record: row.record,
    recheck: row.recheck,
    probeDropped: false,
    noLaunchStart: false,
  })),
]

/** `test.each` rows over the re-check table: the row name, then the row. */
const RECHECK_ROWS = RECHECK_TABLE.map((row) => [row.name, row] as const)

describe('the latch re-check\'s decision for every row of the case table (SRJ-505, SRJ-1304; pure)', () => {
  test('the re-check table holds every row of every site kind once, the probe-dropped columns only on the resume and reuse "this row\'s own id" rows, every answer a column scripts builds (a CONFLICT one recognised as its case), and no description names "no pane 0.0"', () => {
    const ownIdLaunchRows = EVERY_CONFLICT_ROW.filter(
      (row) => row.latchCase === LATCH_CASE_OWN_ID && (row.refusedOperation === REFUSED_OPERATION_RESUME || row.refusedOperation === REFUSED_OPERATION_REUSE_SPAWN),
    )
    expect(EVERY_CONFLICT_ROW.filter((row) => row.probeDroppedRecheck !== undefined)).toEqual(ownIdLaunchRows)
    expect(RECHECK_TABLE).toHaveLength(
      EVERY_CONFLICT_ROW.length + ownIdLaunchRows.length + UNUSABLE_NAME_CASE_ROWS.length + LAUNCH_START_CASE_ROWS.length + 1 + NOTE_LATCH_CASE_ROWS.length,
    )
    expect(new Set(RECHECK_TABLE.map((row) => row.name)).size).toBe(RECHECK_TABLE.length)
    // b.jg5 SRJ-507 (rev 17): "no pane 0.0" is withdrawn; no row's description, nor any answer a column scripts, names it.
    const answers = RECHECK_TABLE.flatMap((row) => row.recheck.entries.flatMap((entry) => recheckAnswersOf(entry)))
    const texts = [...CONFLICT_CASE_ROWS.map(descriptionOf), ...UNUSABLE_NAME_CASE_ROWS.map((row) => row.description), ...answers.map((answer) => String(answer.answer()?.message ?? ''))]
    expect(texts.filter((text) => text.includes('pane 0.0'))).toEqual([])
  })

  test.each(RECHECK_ROWS)('%s: every step-1 reading decides SRJ-505\'s step and call, and a retired key\'s resume or plain spawn is the reuse', (_name, row) => {
    const record = row.record(KEY)
    const decided = (retiredKeyRecorded: boolean) =>
      row.recheck.entries.map((entry) => [entry.name, decideLatchRecheck({ record, reading: entry.reading, retiredKeyRecorded })] as const)
    expect(decided(false)).toEqual(row.recheck.entries.map((entry) => [entry.name, entry.decision]))
    expect(decided(true).map(([name, decision]) => [name, decision.call])).toEqual(row.recheck.entries.map((entry) => [entry.name, entry.retiredKeyCall]))
  })

  test.each(FINISHED_ROW_RETRY_ENTRIES.map((entry) => [entry.name, entry] as const))('a "not this launch\'s session" latch\'s finished-row retry whose get reads %s launches as SRJ-505 says (never a kill, never a plain spawn over a row), and the reuse for a retired key', (_name, entry) => {
    expect(decideFinishedRowLaunch(entry.reading, entry.hasSessionId, false)).toBe(entry.call)
    expect(decideFinishedRowLaunch(entry.reading, entry.hasSessionId, true)).toBe(entry.retiredKeyCall)
  })

  test('every site kind has its rows, and every row carries every re-check column: its read, its table action, and one entry per state step 1 can read, each with its decision, its retired-key call and, for a call one verb answers, its answers (SRJ-1304)', () => {
    // E13's ladder and E28's plain spawn, E22's reuse, E23's resume, E17's approver, E18's three read-pane sites,
    // E19's reconnect and prompt rows, E20's restart kill, E21's sequence kills and step-6 resume, E29's abort kill.
    const siteKinds = [
      'plain spawn',
      REUSE_SPAWN_SITE,
      'resume',
      SEQUENCE_RESUME_SITE,
      ...APPROVER_SITES,
      ...LIVENESS_PANE_SITES,
      RECONNECT_SITE,
      ...PROMPT_ROW_PANE_SITES,
      RESTART_KILL_SITE,
      ...SEQUENCE_KILL_SITES,
      STUCK_LAUNCH_ABORT_SITE,
    ]
    // The approver's status answers no CONFLICT, so its rows are UNUSABLE NAME rows only.
    const sitesWithRows = new Set<string>([...EVERY_CONFLICT_ROW, ...UNUSABLE_NAME_CASE_ROWS].map((row) => row.site))
    expect(siteKinds.filter((site) => !sitesWithRows.has(site))).toEqual([])
    // E16's holds: an unusable-name row at every site kind that can answer UNUSABLE NAME, and the launch-start rows.
    expect(UNUSABLE_NAME_SITES.filter((site) => !UNUSABLE_NAME_CASE_ROWS.some((row) => row.site === site))).toEqual([])
    expect(LAUNCH_START_CASE_ROWS.length).toBeGreaterThan(0)
    const statusReadings: RecheckReadingName[] = ['read fails', 'no row', 'pending', 'waiting', 'ended', 'missing']
    const getReadings: RecheckReadingName[] = [...statusReadings, 'pending, with the note', 'waiting, with the note', 'ended, with the note']
    const answered = new Set<string>([RECHECK_CALL_PROBE, RECHECK_CALL_PENDING_READ_PANE, RECHECK_CALL_PLAIN_SPAWN, RECHECK_CALL_REUSE_SPAWN, RECHECK_CALL_RESUME])
    const incomplete = RECHECK_TABLE.flatMap((row) => {
      const { readVerb, action, entries } = row.recheck
      const readings = readVerb === 'get' ? getReadings : statusReadings
      const problems: string[] = []
      if (readVerb !== (row.record(KEY).latchCase === LATCH_CASE_CONFLICTING_LABELS ? 'get' : 'status')) problems.push(`read ${readVerb}`)
      if (typeof action !== 'string') problems.push('no action')
      if (JSON.stringify(entries.map((entry) => entry.name)) !== JSON.stringify(readings)) problems.push(`entries ${entries.map((entry) => entry.name).join('|')}`)
      for (const entry of entries) {
        if (entry.decision === undefined || entry.retiredKeyCall === undefined) problems.push(`${entry.name}: no decision or retired-key call`)
        if ((entry.answers !== undefined) !== answered.has(entry.decision.call)) problems.push(`${entry.name}: answers for ${entry.decision.call}`)
      }
      return problems.map((problem) => `${row.name}: ${problem}`)
    })
    expect(incomplete).toEqual([])
  })

  test('HO rev 28: every resume and reuse row has its pending, ended and absent entries: pending, no probe, no retry and no post (for "conflicting labels" with no note, the one-line read-pane and no launch); ended, the case\'s probe or retry; absent, a resume latch cleared by its gone row and a reuse latch\'s reuse retried', () => {
    const launchRows = RECHECK_TABLE.filter((row) => [REFUSED_OPERATION_RESUME, REFUSED_OPERATION_REUSE_SPAWN].includes(row.record(KEY).refusedOperation))
    expect(launchRows.length).toBe(EVERY_CONFLICT_ROW.filter((row) => [REFUSED_OPERATION_RESUME, REFUSED_OPERATION_REUSE_SPAWN].includes(row.refusedOperation)).length + EVERY_CONFLICT_ROW.filter((row) => row.probeDroppedRecheck !== undefined).length)
    const wrong = launchRows.flatMap((row) => {
      const { latchCase, refusedOperation } = row.record(KEY)
      const launch = refusedOperation === REFUSED_OPERATION_RESUME ? RECHECK_CALL_RESUME : RECHECK_CALL_REUSE_SPAWN
      const pending = recheckEntryAt(row.recheck, 'pending').decision
      const ended = recheckEntryAt(row.recheck, 'ended').decision
      const absent = recheckEntryAt(row.recheck, 'no row').decision
      const problems: string[] = []
      // pending: no probe, no retry, no clear (so no post); "conflicting labels" with no note: the one-line read-pane only.
      const pendingCall = latchCase === LATCH_CASE_CONFLICTING_LABELS ? RECHECK_CALL_PENDING_READ_PANE : RECHECK_CALL_NONE
      if (pending.call !== pendingCall || pending.clear !== undefined) problems.push(`pending: ${pending.call}`)
      // ended: the case's probe or retry (unrecognised text: none, as its table row says), no clear.
      const endedCalls = latchCase === LATCH_CASE_UNRECOGNISED ? [RECHECK_CALL_NONE] : [RECHECK_CALL_PROBE, launch]
      if (!endedCalls.includes(ended.call) || ended.clear !== undefined) problems.push(`ended: ${ended.call}`)
      // absent: a resume latch cleared ("its agent-director row is gone"; P then comes up by the plain spawn); a reuse retried, with no probe.
      if (refusedOperation === REFUSED_OPERATION_RESUME) {
        if (absent.step !== RECHECK_STEP_CLEAR_GONE || absent.call !== RECHECK_CALL_NONE || absent.clear?.reason !== LATCH_RECOVERY_REASON_ROW_GONE) problems.push(`absent: ${absent.step} ${absent.call}`)
      } else if (absent.step !== RECHECK_STEP_SPAWN_RETRY || absent.call !== RECHECK_CALL_REUSE_SPAWN || absent.clear !== undefined) {
        problems.push(`absent: ${absent.step} ${absent.call}`)
      }
      return problems.map((problem) => `${row.name}: ${problem}`)
    })
    expect(wrong).toEqual([])
  })

  test('the plain spawn\'s rows, from the scan\'s refusal and from "duplicate session" ("another agent-director store" among the latter), and again recorded unreadable and live: no row, the plain spawn; ended or missing, a spawn with --reuse-finished; pending, no retry; another live state, no retry for a latch recorded unreadable or live (hatch A3)', () => {
    expect(PLAIN_SPAWN_CONFLICT_CASE_ROWS.map((row) => row.rowAfter)).toEqual(expect.arrayContaining(['none', LIVENESS_DEAD_ROW_ENDED]))
    expect(PLAIN_SPAWN_CONFLICT_CASE_ROWS.some((row) => row.latchCase === LATCH_CASE_ANOTHER_STORE && row.rowAfter === LIVENESS_DEAD_ROW_ENDED)).toBe(true)
    // Each plain spawn row again, once per latch-time reading that shows no row that had not reported in.
    const recordedLive: unknown[] = Object.entries(PLAIN_SPAWN_LATCH_TIME_ROW_STATES).flatMap(([reading, rowState]) =>
      PLAIN_SPAWN_CONFLICT_CASE_ROWS.map((plain) => [reading, plain.stubCase, plain.options, rowState]),
    )
    expect(PLAIN_SPAWN_RECORDED_LIVE_CASE_ROWS.map((row): unknown => [row.latchTimeReading, row.stubCase, row.options, row.rowState])).toEqual(recordedLive)
    const plainRows = [...PLAIN_SPAWN_CONFLICT_CASE_ROWS, ...PLAIN_SPAWN_RECORDED_LIVE_CASE_ROWS]
    const wrong = plainRows.flatMap((row) => {
      const call = (name: RecheckReadingName): string => {
        const { decision } = recheckEntryAt(row.recheck, name)
        return decision.clear === undefined ? decision.call : `cleared (${decision.call})`
      }
      // A live state other than pending clears a latch recorded with no row or ended (the row reported in); one recorded unreadable or live gets no retry.
      const another = row.latchTimeReading === undefined ? `cleared (${RECHECK_CALL_NONE})` : RECHECK_CALL_NONE
      const expected = [RECHECK_CALL_PLAIN_SPAWN, RECHECK_CALL_REUSE_SPAWN, RECHECK_CALL_REUSE_SPAWN, RECHECK_CALL_NONE, another]
      const got = [call('no row'), call('ended'), call('missing'), call('pending'), call('waiting')]
      return JSON.stringify(got) === JSON.stringify(expected) ? [] : [`${row.name}: ${got.join(', ')}`]
    })
    expect(wrong).toEqual([])
    expect(RECHECK_TABLE.filter((row) => plainRows.some((plain) => `CONFLICT ${plain.name}` === row.name))).toHaveLength(plainRows.length)
  })
})

/** Every answer an entry's columns script (for the "no pane 0.0" guard). */
function recheckAnswersOf(entry: RecheckEntry): RecheckAnswer[] {
  const answers = entry.answers
  if (answers === undefined) return []
  return [...answers.stillLatched, ...answers.cleared, ...answers.probeFoundCleared, ...answers.relatches, ...answers.noInformation, answers.config]
}

/** A recovery harness with the latch re-check bound as main() binds it (`latchRecheck`), `health_check_interval` 0 unless given; leak-checked and cleaned up in `afterEach`. */
function makeRecheckHarness(options: Omit<RecoveryHarnessOptions, 'latchRecheck'> = {}): RecoveryHarness {
  const h = makeRecoveryHarness({ ...options, latchRecheck: true })
  harnesses.push(h)
  return h
}

/** Persona `key`'s calls in the harness's timed calls from index `from` on: those naming its instance and the store-wide ones. */
function personaCallsFrom(h: RecoveryHarness, key: string, from: number): RecoveryTimedCall[] {
  const id = personaInstanceId(key)
  return h.timedCalls.slice(from).filter((call) => call.instanceId === id || call.instanceId === undefined)
}

/** What one re-check round did: the clock time its timer fired at and the stub methods persona P's calls named since the previous round, in order. */
interface RecheckRoundRun {
  readonly at: number
  readonly verbs: readonly string[]
}

/**
 * One re-check round of persona `key`: move the clock to its timer, settle
 * the round, and answer when it fired and what P called since `from` (the
 * previous round's end), failing on any call made before the fire (a call
 * between rounds).
 */
async function recheckRound(h: RecoveryHarness, key: string): Promise<RecheckRoundRun> {
  const from = h.timedCalls.length
  const at = await h.advanceToRecheck()
  const calls = personaCallsFrom(h, key, from)
  expect(calls.filter((call) => call.at !== at)).toEqual([])
  return { at, verbs: calls.map((call) => call.verb) }
}

/** The finished-row retry's entry for step 1's reading `name` (a row with a session id, so a finished row gets its `resume`). */
function finishedRowEntryFor(name: string): FinishedRowRetryEntry {
  const entryName = name === 'no row' ? 'no row' : `${name}, with a session id`
  const entry = FINISHED_ROW_RETRY_ENTRIES.find((candidate) => candidate.name === entryName)
  if (entry === undefined) throw new Error(`no finished-row entry ${entryName}`)
  return entry
}

/** The stub method each launch call makes. */
const LAUNCH_CALL_METHOD: Partial<Record<LatchRecheckCall, string>> = {
  [RECHECK_CALL_PLAIN_SPAWN]: 'spawn',
  [RECHECK_CALL_REUSE_SPAWN]: 'spawn',
  [RECHECK_CALL_RESUME]: 'resume',
}

/** The stub methods a re-check call after step 1's read makes (the finished-row retry: its `get`, then the launch its entry decides). */
function recheckCallMethods(entry: RecheckEntry): string[] {
  switch (entry.decision.call) {
    case RECHECK_CALL_NONE:
      return []
    case RECHECK_CALL_PROBE:
    case RECHECK_CALL_PENDING_READ_PANE:
      return ['readPane']
    case RECHECK_CALL_FINISHED_ROW: {
      const launch = LAUNCH_CALL_METHOD[finishedRowEntryFor(entry.name).call]
      return launch === undefined ? ['get'] : ['get', launch]
    }
    case RECHECK_CALL_RESTART_DECISION:
      // The run's first call: the restart path's liveness read of the row.
      return ['status']
    default:
      return [LAUNCH_CALL_METHOD[entry.decision.call]!]
  }
}

/** The parameters persona `key`'s re-check call for `entry` must carry, checked on the row model's record; undefined for a call with none checked here. */
function recheckCallParams(entry: RecheckEntry, key: string): Record<string, unknown> | undefined {
  const claude_instance_id = personaInstanceId(key)
  switch (entry.decision.call) {
    case RECHECK_CALL_PROBE:
      return { claude_instance_id, n_lines: PROBE_PANE_READ_LINES }
    case RECHECK_CALL_PENDING_READ_PANE:
      return { claude_instance_id, n_lines: PROBE_PANE_READ_LINES, allow_pending: true }
    default:
      return undefined
  }
}

/** Make persona P's row read as step 1's `entry` reads it: its state and note, or, for a failed read, the read answering no information once. */
function scriptRecheckReading(model: PendingRowModel, readVerb: RecheckColumns['readVerb'], entry: RecheckEntry): void {
  const row = pendingRowOfRecheckReading(entry.reading)
  if (row === undefined) {
    const failure = recheckNoInformationAnswers(readVerb)[0]!.answer()!
    if (readVerb === 'get') model.scriptGet(failure)
    else model.scriptStatus(failure)
    return
  }
  model.setState(row.state)
  model.setNote(row.note)
}

/** Script a launch call's next answer on the row model: its form's own queue. */
function scriptLaunchAnswer(model: PendingRowModel, call: LatchRecheckCall, answer: PendingRowLaunchAnswer): void {
  if (call === RECHECK_CALL_PLAIN_SPAWN) model.scriptPlainSpawns(answer)
  else if (call === RECHECK_CALL_REUSE_SPAWN) model.scriptReuseSpawns(answer)
  else if (call === RECHECK_CALL_RESUME) model.scriptResumes(answer)
}

/** One still-latched round of the table: step 1's reading and the answer its call gets. */
interface StillLatchedRound {
  readonly entry: RecheckEntry
  readonly answer: RecheckAnswer | undefined
}

/**
 * The still-latched rounds a row's columns give, in entry order: every
 * reading that does not clear, except a run of the restart path's decision
 * (whose own calls are restart.ts's), once per still-latched answer its call
 * has (the finished-row retry's launch: its entry's), or once with no call.
 */
function stillLatchedRounds(row: RecheckTableRow): StillLatchedRound[] {
  return row.recheck.entries
    .filter((entry) => entry.decision.clear === undefined && entry.decision.call !== RECHECK_CALL_RESTART_DECISION)
    .flatMap((entry): StillLatchedRound[] => {
      const answers = entry.decision.call === RECHECK_CALL_FINISHED_ROW ? finishedRowEntryFor(entry.name).answers?.stillLatched : entry.answers?.stillLatched
      return answers === undefined ? [{ entry, answer: undefined }] : answers.map((answer) => ({ entry, answer }))
    })
}

describe('the latch re-check by row of the case table: one read, then exactly the row\'s call, every 120 s (recovery harness, health_check_interval 0; SRJ-505)', () => {
  test.each(RECHECK_ROWS)('%s', async (_name, row) => {
    const rounds = stillLatchedRounds(row)
    const { h, p, q, model } = latchForRecheck(row, row.noLaunchStart ? { launchStartedAt: SAMPLE_LAUNCH_START_NONE } : {})
    if (row.probeDropped) expect(h.latchSet.setProbeDropped(p)).toBe(true)
    const record = row.record(p)
    expect(h.latch.record(p)).toEqual(record)
    const latchedAt = h.clock.now()
    expect(h.latchRecheck.nextDueAt()).toBe(latchedAt + LATCH_RECHECK_INTERVAL_MS)

    let previous = latchedAt
    for (const { entry, answer } of rounds) {
      scriptRecheckReading(model, row.recheck.readVerb, entry)
      const launch = entry.decision.call === RECHECK_CALL_FINISHED_ROW ? finishedRowEntryFor(entry.name).call : entry.decision.call
      if (answer !== undefined && LAUNCH_CALL_METHOD[launch] !== undefined) scriptLaunchAnswer(model, launch, answer.answer())
      // The probe's or the lap's read-pane answer (none: the model's pane).
      if (answer !== undefined && recheckCallMethods(entry).includes('readPane')) model.scriptReadPane(answer.answer())
      const round = await recheckRound(h, p)
      const label = `${entry.name}${answer === undefined ? '' : `, ${answer.name}`}`
      // One interval after the previous round (or the latch); its read, then exactly its call.
      expect([label, round.at - previous, round.verbs]).toEqual([label, LATCH_RECHECK_INTERVAL_MS, [row.recheck.readVerb, ...recheckCallMethods(entry)]])
      const params = recheckCallParams(entry, p)
      if (params !== undefined) expect([label, model.calls.at(-1)?.params]).toEqual([label, params])
      if (launch === RECHECK_CALL_REUSE_SPAWN || launch === RECHECK_CALL_PLAIN_SPAWN) {
        // A spawn with `reuse_finished` for the reuse (never a plain spawn over a finished row), none for the plain spawn.
        expect([label, h.stub.calls.spawnCalls.at(-1)?.reuse_finished === true]).toEqual([label, launch === RECHECK_CALL_REUSE_SPAWN])
      }
      // Still latched: the record as it was, no post, the timer armed for the next round.
      expect([label, h.latch.record(p), h.episodeNotices.length, h.latchRecheck.nextDueAt()]).toEqual([label, record, 1, round.at + LATCH_RECHECK_INTERVAL_MS])
      previous = round.at
    }

    // Last, a reading whose round ends the latch: the row's run of the restart path's decision, else its first step-1 clear.
    const last = row.recheck.entries.find((entry) => entry.decision.call === RECHECK_CALL_RESTART_DECISION) ?? row.recheck.entries.find((entry) => entry.decision.clear !== undefined)
    if (last !== undefined) {
      scriptRecheckReading(model, row.recheck.readVerb, last)
      const round = await recheckRound(h, p)
      expect(round.verbs.slice(0, 1 + recheckCallMethods(last).length)).toEqual([row.recheck.readVerb, ...recheckCallMethods(last)])
      expect([h.latch.isLatched(p), h.latchRecheck.isArmed(p), h.latchRecheck.pendingTimers()]).toEqual([false, false, 0])
    }
    // Q, never latched, is never re-checked.
    expect([h.latch.isLatched(q), personaCallCounts(h, q)]).toEqual([false, {}])
  })
})

/** What a named re-check case latched: the harness, P and Q, P's row model and the record P's latch holds. */
interface LatchedRecheckRun {
  readonly h: RecoveryHarness
  readonly p: string
  readonly q: string
  readonly model: PendingRowModel
  readonly record: ConflictLatchRecord
}

/** A case table row's latch, as `latchForRecheck` sets it. */
type RecheckLatchRow = Pick<RecheckTableRow, 'latchOn'>

/**
 * A re-check harness (`makeRecheckHarness`, `harnessOptions`) with P's row on
 * the row model (`modelOptions`; its row carries a session id) and P latched
 * as `row`'s site latches it: one set, one post, the re-check timer armed.
 */
function latchForRecheck(
  row: RecheckLatchRow,
  modelOptions: PendingRowModelOptions = {},
  harnessOptions: Omit<RecoveryHarnessOptions, 'latchRecheck'> = {},
): LatchedRecheckRun {
  const h = makeRecheckHarness(harnessOptions)
  const [p, q] = h.keys as [string, string]
  const model = makePendingRowModel(h, p, { sessionId: 'session-of-p', ...modelOptions })
  row.latchOn(h.latchSet, p)
  const record = h.latch.record(p)
  if (record === undefined) throw new Error('the row did not latch P')
  expect([h.episodeNotices.length, h.latchRecheck.isArmed(p)]).toEqual([1, true])
  return { h, p, q, model, record }
}

/** The row state step 1 reads for the case-table reading `name` (its `status` entry's): a state, or no row. */
function rowStateOfReading(name: RecheckReadingName): string {
  const row = pendingRowOfRecheckReading(recheckEntryAt(statusOnlyRow().recheck, name).reading)
  if (row === undefined) throw new Error(`no row state for ${name}`)
  return row.state
}

/** A "not this launch's session" latch from a refused kill: `status` only while its row reads live. */
const statusOnlyRow = lazyRow((row) => row.latchCase === LATCH_CASE_NOT_THIS_LAUNCH && row.site === 'kill')

/** The first CONFLICT row refusing `refusedOperation` with `latchCase`, its row recorded `ended` (a `resume`'s or reuse's collision `get`), looked up lazily (`lazyRow`). */
function launchRow(refusedOperation: string, latchCase: LatchCase): () => ConflictCaseRow {
  return lazyRow((row) => row.refusedOperation === refusedOperation && row.latchCase === latchCase && row.rowState.kind === LATCH_ROW_STATE_KIND_READ && row.rowState.state === LIVENESS_DEAD_ROW_ENDED)
}

/** Expect P still latched with `record`, its one post only, and its timer armed one interval after `at`. */
function expectStillLatched(run: LatchedRecheckRun, at: number): void {
  const { h, p, record } = run
  expect([h.latch.record(p), h.episodeNotices.length, h.latchRecheck.nextDueAt()]).toEqual([record, 1, at + LATCH_RECHECK_INTERVAL_MS])
}

describe('the re-check timer: its cadence, P\'s serializer turn and its stops (recovery harness; SRJ-505)', () => {
  // The one pin case: SRJ-505's numbers, as SRJ-1204 bounds them; every other case imports them.
  test('SRJ-1204\'s pin: LATCH_RECHECK_INTERVAL_MS is SRJ-505\'s 120 s and PROBE_PANE_READ_LINES its one-line read-pane', () => {
    expect([LATCH_RECHECK_INTERVAL_MS, PROBE_PANE_READ_LINES]).toEqual([120_000, 1])
  })

  test('health_check_interval 0: no call before 120 s after the latch, then one status read every 120 s over four intervals', async () => {
    const run = latchForRecheck(statusOnlyRow(), { state: rowStateOfReading('waiting') }, { healthCheckInterval: 0 })
    const { h, p } = run
    const from = h.timedCalls.length
    await h.advance(LATCH_RECHECK_INTERVAL_MS - 1)
    expect(personaCallsFrom(h, p, from)).toEqual([])
    const rounds: Array<readonly [number, readonly string[]]> = []
    for (let n = 0; n < 4; n++) {
      const round = await recheckRound(h, p)
      rounds.push([round.at, round.verbs])
    }
    expect(rounds).toEqual([1, 2, 3, 4].map((n) => [n * LATCH_RECHECK_INTERVAL_MS, ['status']]))
    expectStillLatched(run, 4 * LATCH_RECHECK_INTERVAL_MS)
  })

  test('health_check_interval 30: a health tick every 30 s between the rounds reads P\'s liveness only and schedules nothing; the rounds still come every 120 s from the latch, over four intervals, each one status read', async () => {
    const intervalS = 30
    const run = latchForRecheck(statusOnlyRow(), { state: rowStateOfReading('waiting') }, { healthCheckInterval: intervalS })
    const { h, p } = run
    const scheduled: string[] = []
    initHealthCheck({
      isSessionAlive: _buildIsSessionAliveAdapter(() => h.config),
      isSessionConnected: () => false,
      hasSessionStream: () => false,
      isRestartPendingOrActive,
      isLaunchInFlight,
      isLatched: (key) => h.latch.isLatched(key),
      isAtCap: (key) => isAtCap(key, RESTART_FAILURE_CAP),
      statRoute: async () => true,
      scheduleRestart: (key) => {
        scheduled.push(key)
      },
      isShuttingDown: () => false,
      getPersonas: () => ({ [p]: personaOf(h, p).working_directory }),
      endTmuxUnresponsive: () => {},
      onTickEnd: () => {},
      now: h.clock.now,
    })
    const tick = captureTimer('setInterval', () => startHealthCheck(intervalS))
    const latchedAt = h.clock.now()
    const from = h.timedCalls.length
    const expected: Array<[string, number]> = []
    const rounds: number[] = []
    for (let n = 0; n < 4; n++) {
      const roundStart = h.clock.now()
      // The ticks at 30, 60 and 90 s into the interval: P's status read each, before the round is due.
      for (let k = 1; k * intervalS * 1000 < LATCH_RECHECK_INTERVAL_MS; k++) {
        await h.advance(intervalS * 1000)
        await tick()
        expected.push(['status', roundStart + k * intervalS * 1000])
      }
      const round = await recheckRound(h, p)
      expect(round.verbs).toEqual(['status'])
      expected.push(['status', round.at])
      rounds.push(round.at)
    }
    stopHealthCheck()
    expect(rounds).toEqual([1, 2, 3, 4].map((n) => latchedAt + n * LATCH_RECHECK_INTERVAL_MS))
    expect(personaCallsFrom(h, p, from).map((call): [string, number] => [call.verb, call.at])).toEqual(expected)
    expect(scheduled).toEqual([])
    expectStillLatched(run, latchedAt + 4 * LATCH_RECHECK_INTERVAL_MS)
  })

  test('a relatch half an interval after the latch, and a same-case set after it, neither restart the timer nor add one; the round at 120 s follows the new case', async () => {
    const { h, p } = latchForRecheck(statusOnlyRow(), { state: rowStateOfReading('pending') })
    await h.advance(LATCH_RECHECK_INTERVAL_MS / 2)
    const unusable = UNUSABLE_NAME_CASE_ROWS[0]!
    expect(unusable.latchOn(h.latchSet, p)).toBe(CONFLICT_LATCH_SET_RELATCHED)
    expect(unusable.latchOn(h.latchSet, p)).toBe(CONFLICT_LATCH_SET_SAME_CASE)
    expect([h.latchRecheck.pendingTimers(), h.latchRecheck.nextDueAt()]).toEqual([1, LATCH_RECHECK_INTERVAL_MS])
    const round = await recheckRound(h, p)
    expect([round.at, round.verbs, h.latch.record(p)?.latchCase]).toEqual([LATCH_RECHECK_INTERVAL_MS, ['status'], LATCH_CASE_UNUSABLE_RECORDED_NAME])
  })

  test('a fire waits for P\'s serializer turn, and the next round comes 120 s after that round settled', async () => {
    const { h, p } = latchForRecheck(statusOnlyRow(), { state: rowStateOfReading('waiting') })
    let release!: () => void
    const held = h.serializer.run(p, () => new Promise<void>((resolve) => (release = resolve)))
    const from = h.timedCalls.length
    const turnAt = LATCH_RECHECK_INTERVAL_MS + LATCH_RECHECK_INTERVAL_MS / 4
    await h.advance(turnAt)
    expect(personaCallsFrom(h, p, from)).toEqual([])
    release()
    await held
    await h.settle()
    expect(personaCallsFrom(h, p, from).map((call) => [call.verb, call.at])).toEqual([['status', turnAt]])
    expect([h.latchRecheck.pendingTimers(), h.latchRecheck.nextDueAt()]).toEqual([1, turnAt + LATCH_RECHECK_INTERVAL_MS])
  })

  test.each([
    ['P\'s teardown', (h: RecoveryHarness, p: string) => h.teardown(p)],
    ['the teardown dependencies\' latch forget, as main() binds it', (h: RecoveryHarness, p: string) => h.teardownDeps().forgetConflictLatch(p)],
    ['shutdown', (h: RecoveryHarness) => h.shutdown()],
  ] as const)('%s stops P\'s re-check timer: none pending, and no round in the five intervals after', async (_label, stop) => {
    const { h, p } = latchForRecheck(statusOnlyRow(), { state: rowStateOfReading('waiting') })
    expect((await recheckRound(h, p)).verbs).toEqual(['status'])
    stop(h, p)
    expect([h.latchRecheck.isArmed(p), h.latchRecheck.pendingTimers()]).toEqual([false, 0])
    const from = h.timedCalls.length
    await h.advance(5 * LATCH_RECHECK_INTERVAL_MS)
    expect(personaCallsFrom(h, p, from)).toEqual([])
  })
})

describe('HO rev 28: a latched resume or reuse is probed or retried only when step 1 reads its row ended or missing (recovery harness; SRJ-505)', () => {
  /** The resume and reuse latches HO rev 28 gates: "this row's own id" (the probe), "another agent-director store" and "no valid instance id" (the retry). */
  const GATED = [REFUSED_OPERATION_RESUME, REFUSED_OPERATION_REUSE_SPAWN].flatMap((op) =>
    ([LATCH_CASE_OWN_ID, LATCH_CASE_ANOTHER_STORE, LATCH_CASE_NO_VALID_ID] as LatchCase[]).map((latchCase) => [`a ${op} latched on "${latchCase}"`, launchRow(op, latchCase)] as const),
  )

  test.each(GATED)('%s: on its row ended, the probe or retry (a retry refused again, its row left pending); then, while the row reads pending, status only and no post, round after round; once it reads ended, the probe or retry again', async (_name, rowOf) => {
    const row = rowOf()
    const run = latchForRecheck(row, { state: LIVENESS_DEAD_ROW_ENDED })
    const { h, p, model } = run
    const ended = recheckEntryAt(row.recheck, 'ended')
    const callMethods = recheckCallMethods(ended)
    // The probe's pane keeps "this row's own id"; a retry is refused with the latch's case, its description saying the row could not be restored and stays pending.
    if (ended.decision.call !== RECHECK_CALL_PROBE) {
      scriptLaunchAnswer(model, ended.decision.call, restoreRefusal(ended.answers!.stillLatched[0]!.answer() as Parameters<typeof restoreRefusal>[0], PENDING_ROW_RESTORE_STAYS_PENDING))
    }
    let round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status', ...callMethods])
    expectStillLatched(run, round.at)
    if (ended.decision.call === RECHECK_CALL_PROBE) model.setState(AGENT_DIRECTOR_PENDING_STATE)
    expect(model.state()).toBe(AGENT_DIRECTOR_PENDING_STATE)
    for (let n = 0; n < 3; n++) {
      round = await recheckRound(h, p)
      expect(round.verbs).toEqual(['status'])
      expectStillLatched(run, round.at)
    }
    model.setState(LIVENESS_DEAD_ROW_ENDED)
    round = await recheckRound(h, p)
    expect(round.verbs.slice(0, 1 + callMethods.length)).toEqual(['status', ...callMethods])
  })

  // Every resume and reuse case (HO rev 28; SRJ-1304): the resume rows of every site kind, and the reuse rows.
  const launchRowsRefusing = (refusedOperation: string) =>
    EVERY_CONFLICT_ROW.filter((row) => row.refusedOperation === refusedOperation).map((row) => [row.name, row] as const)

  test.each(launchRowsRefusing(REFUSED_OPERATION_RESUME))('%s, its row gone: step 1\'s ErrSpawnNotFound clears the latch, and the retry at once after its find-missing is the plain spawn, never a resume or a reuse (SRJ-506)', async (_name, row) => {
    const { h, p } = latchForRecheck(row, { state: PENDING_ROW_MODEL_NO_ROW })
    const spawnsBefore = h.stub.calls.spawnCalls.length
    const round = await recheckRound(h, p)
    expect(round.verbs.slice(0, 2)).toEqual([row.recheck.readVerb, 'findMissing'])
    expect(round.verbs).not.toContain('resume')
    expect([h.latch.isLatched(p), h.latchRecheck.isArmed(p)]).toEqual([false, false])
    const spawns = h.stub.calls.spawnCalls.slice(spawnsBefore)
    expect([spawns.length, spawns[0]?.reuse_finished, h.stub.calls.resumeCalls]).toEqual([1, undefined, []])
    if (h.approverRunning(p)) await h.runApproverToStop(p)
  })

  test.each(launchRowsRefusing(REFUSED_OPERATION_REUSE_SPAWN))('%s, its row gone: the reuse is retried as an ordinary fresh spawn, with no probe; not refused, it clears the latch', async (_name, row) => {
    const { h, p } = latchForRecheck(row, { state: PENDING_ROW_MODEL_NO_ROW })
    const round = await recheckRound(h, p)
    expect(round.verbs.slice(0, 2)).toEqual([row.recheck.readVerb, 'spawn'])
    expect(h.stub.calls.spawnCalls[0]).toEqual(reuseSpawnOf(h, p))
    expect([h.latch.isLatched(p), h.latchRecheck.isArmed(p)]).toEqual([false, false])
  })

  test('a "not this launch\'s session" latch whose status finds no row and whose finished-row get then reads the row pending makes no launch and posts nothing', async () => {
    const run = latchForRecheck(statusOnlyRow(), { state: AGENT_DIRECTOR_PENDING_STATE })
    const { h, p, model } = run
    model.scriptStatus(errSpawnNotFound())
    const round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status', 'get'])
    expectStillLatched(run, round.at)
  })

  // A retired key's retry being the reuse, never a resume (E24-E25), is tests/session-manager.test.ts's.
  test('E24: a round\'s status read of a recorded, marked key\'s live row clears its retired-key entry', async () => {
    const run = latchForRecheck(statusOnlyRow(), { state: rowStateOfReading('waiting') })
    const { h, p } = run
    h.retireKey(p, { mark: true })
    expect(h.retiredEntry(p).recorded).toBe(true)
    const round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status'])
    expect(h.retiredEntry(p).recorded).toBe(false)
    expectStillLatched(run, round.at)
  })
})

describe('"not this launch\'s session": status only, the refused call never repeated, a live reading never clears; on a finished or gone row one finished-row retry with P still latched (recovery harness; SRJ-505, SRJ-506)', () => {
  /** The latch from a refused kill, a reconnect's send-keys and a read-pane (the waiting-row check's). */
  const SITES = ['kill', 'reconnect send-keys', 'waiting-row check'].map(
    (site) => [site, lazyRow((candidate) => candidate.latchCase === LATCH_CASE_NOT_THIS_LAUNCH && candidate.site === site)] as const,
  )
  /** The calls a "not this launch's session" latch never makes again: the refused kill, send-keys, read-pane or pause, and no delete. */
  const NEVER = ['kill', 'sendKeys', 'readPane', 'pause', 'delete']

  test.each(SITES)('from a refused %s: waiting and pending read status only; missing, a no-information answer keeps the latch and the next finished round retries again, and while the leftover runs the resume relatches with "left over from an earlier life" and one new post', async (_site, rowOf) => {
    const run = latchForRecheck(rowOf(), { state: rowStateOfReading('waiting') })
    const { h, p, model } = run
    const verbs: string[] = []
    for (const name of ['waiting', 'pending'] as const) {
      model.setState(rowStateOfReading(name))
      const round = await recheckRound(h, p)
      expect([name, round.verbs]).toEqual([name, ['status']])
      expectStillLatched(run, round.at)
      verbs.push(...round.verbs)
    }
    // The row reads missing: one get, then the resume its session id gives; tmux does not answer it, so P stays latched with no post.
    const missing = finishedRowEntryFor('missing')
    model.setState(rowStateOfReading('missing'))
    scriptLaunchAnswer(model, RECHECK_CALL_RESUME, missing.answers!.noInformation[0]!.answer())
    let round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status', 'get', 'resume'])
    expectStillLatched(run, round.at)
    // Retried again at the next finished round; the leftover still runs, so it relatches with one new post, its record the resume's and the row the get read.
    const leftover = missing.answers!.relatches.find((answer) => answer.latchCase === LATCH_CASE_LEFTOVER)!
    scriptLaunchAnswer(model, RECHECK_CALL_RESUME, leftover.answer())
    round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status', 'get', 'resume'])
    expect(h.latch.record(p)).toMatchObject({ latchCase: LATCH_CASE_LEFTOVER, refusedOperation: REFUSED_OPERATION_RESUME, rowState: latchRowStateRead(LIVENESS_DEAD_ROW_MISSING) })
    expect([h.episodeNotices.length, h.latchRecheck.pendingTimers(), h.latchRecheck.nextDueAt()]).toEqual([2, 1, round.at + LATCH_RECHECK_INTERVAL_MS])
    verbs.push(...personaCallsFrom(h, p, 0).map((call) => call.verb))
    expect(verbs.filter((verb) => NEVER.includes(verb))).toEqual([])
  })

  test.each(SITES)('from a refused %s, no row left: the finished-row retry is the plain first spawn, whose pre-spawn scan refusal relatches P as a plain-spawn latch with one new post; the next round retries the plain spawn', async (_site, rowOf) => {
    const scanRow = scanLeftoverRow()
    const run = latchForRecheck(rowOf(), { state: PENDING_ROW_MODEL_NO_ROW, plainSpawns: [scanRefusal(scanRow.build()), scanRefusal(scanRow.build())] })
    const { h, p } = run
    let round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status', 'get', 'spawn'])
    expect(h.stub.calls.spawnCalls[0]?.reuse_finished).toBeUndefined()
    expect(h.latch.record(p)).toMatchObject({ latchCase: LATCH_CASE_LEFTOVER, refusedOperation: REFUSED_OPERATION_PLAIN_SPAWN, rowState: LATCH_ROW_STATE_NO_ROW })
    expect(h.episodeNotices).toHaveLength(2)
    // A plain-spawn latch with no row: the plain spawn itself, refused again with its case: no post.
    round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status', 'spawn'])
    expect([h.latch.record(p)?.latchCase, h.episodeNotices.length]).toEqual([LATCH_CASE_LEFTOVER, 2])
  })
})

describe('"conflicting labels": step 1 reads with get; the note keeps the latch with no call; a pending row gets the lap\'s one-line read-pane, typing nothing (recovery harness; SRJ-505, SRJ-410)', () => {
  test('a provenance_conflict note on P\'s live, connected row keeps the latch with no other call and no post, round after round', async () => {
    const noteRow = NOTE_LATCH_CASE_ROWS.find((row) => row.state === rowStateOfReading('waiting'))!
    const run = latchForRecheck(noteRow, { state: noteRow.state, note: true })
    const { h, p } = run
    h.setConnected(p, true)
    for (let n = 0; n < 3; n++) {
      const round = await recheckRound(h, p)
      expect(round.verbs).toEqual(['get'])
      expectStillLatched(run, round.at)
    }
  })

  test('a resume latched on "conflicting labels", its row pending with no note and a startup dialog on its pane: each round one read-pane with n_lines 1 and allow_pending and no resume; the same CONFLICT keeps the latch; nothing is typed, and no lap, run or kill is made while latched', async () => {
    const row = conflictingLabelsResumeRow()
    const sameCase = recheckEntryAt(row.recheck, 'pending').answers!.stillLatched[0]!
    const run = latchForRecheck(row, { state: AGENT_DIRECTOR_PENDING_STATE, dialog: PENDING_ROW_DIALOG_TRUST, readPane: [1, 2, 3].map(() => sameCase.answer()) })
    const { h, p, model } = run
    for (let n = 0; n < 3; n++) {
      const round = await recheckRound(h, p)
      expect(round.verbs).toEqual(['get', 'readPane'])
      expect(model.calls.at(-1)?.params).toEqual({ claude_instance_id: personaInstanceId(p), n_lines: PROBE_PANE_READ_LINES, allow_pending: true })
      expectStillLatched(run, round.at)
    }
    expect([model.state(), model.dialog()]).toEqual([AGENT_DIRECTOR_PENDING_STATE, PENDING_ROW_DIALOG_TRUST])
  })
})

describe('a retry\'s answer: a different case relatches with one new post, and the next round follows the new case (recovery harness; SRJ-505, SRJ-506)', () => {
  test('the lap read-pane of a "conflicting labels" latch\'s pending row answering "the agent\'s pane was not found" relatches with it (one new post), and the next round is that case\'s probe: status, then read-pane with n_lines 1 and no allow_pending', async () => {
    const row = rowWhere((candidate) => candidate.latchCase === LATCH_CASE_CONFLICTING_LABELS && candidate.refusedOperation === REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY && candidate.rowState.kind === LATCH_ROW_STATE_KIND_READ && candidate.rowState.state === AGENT_DIRECTOR_PENDING_STATE)
    const relatch = recheckEntryAt(row.recheck, 'pending').answers!.relatches.find((answer) => answer.latchCase === LATCH_CASE_PANE_NOT_FOUND)!
    const { h, p, model } = latchForRecheck(row, { state: AGENT_DIRECTOR_PENDING_STATE, readPane: [relatch.answer(), recheckPaneConflictAnswer('pane-not-found').answer()] })
    let round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['get', 'readPane'])
    expect(h.latch.record(p)).toMatchObject({ latchCase: LATCH_CASE_PANE_NOT_FOUND, refusedOperation: REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY, rowState: latchRowStateRead(AGENT_DIRECTOR_PENDING_STATE) })
    expect([h.episodeNotices.length, h.latchRecheck.pendingTimers()]).toEqual([2, 1])
    round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status', 'readPane'])
    expect(model.calls.at(-1)?.params).toEqual({ claude_instance_id: personaInstanceId(p), n_lines: PROBE_PANE_READ_LINES })
    expect([h.latch.record(p)?.latchCase, h.episodeNotices.length]).toEqual([LATCH_CASE_PANE_NOT_FOUND, 2])
  })
})

/**
 * A latch whose refused operation and case match no row of SRJ-505's table
 * ("left over from an earlier life" refused at P's next check or recovery,
 * which no latching site records), set through the latch's own `set` entry
 * on a row recorded `waiting`, so step 1 never clears it on a live reading.
 */
const UNMATCHED_LATCH: RecheckLatchRow = {
  latchOn: (latch, key) =>
    latch.set(key, {
      latchCase: LATCH_CASE_LEFTOVER,
      refusedOperation: REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY,
      rowState: latchRowStateRead('waiting'),
      sessionName: personaTmuxSessionName(key),
    }),
}

describe('a latch matching no row of the re-check table gets step 1 only, with one line naming the pair (SRJ-505; hatch A3)', () => {
  test('the decision: every reading of a row decides no call, marked unmatched; a gone row still clears and a failed read gives no information', () => {
    const run = makeLatchRun()
    UNMATCHED_LATCH.latchOn(run.latch, KEY)
    const record = run.latch.record(KEY)!
    const decide = (reading: LatchRecheckReading) => decideLatchRecheck({ record, reading, retiredKeyRecorded: false })
    const states = [AGENT_DIRECTOR_PENDING_STATE, 'waiting', LIVENESS_DEAD_ROW_ENDED, LIVENESS_DEAD_ROW_MISSING]
    expect(states.map((state) => [state, decide({ kind: RECHECK_READING_STATE, state })])).toEqual(
      states.map((state) => [state, { step: RECHECK_STEP_TABLE, action: RECHECK_ACTION_NONE, call: RECHECK_CALL_NONE, unmatched: true }]),
    )
    expect(decide(RECHECK_READING_NO_ROW_VALUE)).toEqual({ step: RECHECK_STEP_CLEAR_GONE, action: RECHECK_ACTION_NONE, call: RECHECK_CALL_NONE, clear: { reason: LATCH_RECOVERY_REASON_ROW_GONE } })
    expect(decide(RECHECK_READING_FAILED_VALUE)).toEqual({ step: RECHECK_STEP_NO_INFORMATION, action: RECHECK_ACTION_NONE, call: RECHECK_CALL_NONE })
  })

  test('a round on the recovery harness: one status read only, P still latched with its one post, and exactly one line naming the pair', async () => {
    const run = latchForRecheck(UNMATCHED_LATCH, { state: 'waiting' })
    const { h, p, record } = run
    const round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status'])
    expectStillLatched(run, round.at)
    expect(h.errors.filter((line) => line === latchRecheckUnmatchedLine(personaRefOf(h, p), record.refusedOperation, record.latchCase))).toHaveLength(1)
  })
})

/**
 * Where a re-check meets an answer: the latch, the row step 1 reads, the
 * verb that answers, the calls the round makes, and how its answer is
 * scripted (on the row model, or at its build for a `read-pane`).
 */
interface RecheckAnswerSite {
  readonly name: string
  /** The latch, looked up when a case asks for it. */
  readonly row: () => RecheckLatchRow
  readonly state: string
  readonly note?: boolean
  readonly verb: string
  readonly verbs: readonly string[]
  /** The site's further model options: a `read-pane`'s queue `answers`, one per round; the finished-row reuse's row has no session id. */
  readonly options?: (answers: Array<Error | undefined>) => PendingRowModelOptions
  /** Script one round's answer on the model (every other verb's). */
  readonly script?: (model: PendingRowModel, answer: Error | undefined) => void
}

// The named latches the cases below share, each looked up when a case first asks for it.
const ownIdResumeRow = launchRow(REFUSED_OPERATION_RESUME, LATCH_CASE_OWN_ID)
const anotherStoreResumeRow = launchRow(REFUSED_OPERATION_RESUME, LATCH_CASE_ANOTHER_STORE)
const anotherStoreReuseRow = launchRow(REFUSED_OPERATION_REUSE_SPAWN, LATCH_CASE_ANOTHER_STORE)
const conflictingLabelsResumeRow = launchRow(REFUSED_OPERATION_RESUME, LATCH_CASE_CONFLICTING_LABELS)
/** A plain spawn the pre-spawn scan refused as "left over from an earlier life": no row. */
const scanLeftoverRow = lazyRow((row) => row.refusedOperation === REFUSED_OPERATION_PLAIN_SPAWN && row.latchCase === LATCH_CASE_LEFTOVER && row.rowState === LATCH_ROW_STATE_NO_ROW)

/** Every kind of call a re-check makes, at one latch each: step 1's two reads, the probe, the lap read-pane, each launch and each finished-row retry launch. */
const RECHECK_ANSWER_SITES: readonly RecheckAnswerSite[] = [
  { name: 'step 1\'s status read', row: statusOnlyRow, state: LIVENESS_DEAD_ROW_ENDED, verb: 'status', verbs: ['status'], script: (model, answer) => model.scriptStatus(answer) },
  { name: 'step 1\'s get read', row: conflictingLabelsResumeRow, state: AGENT_DIRECTOR_PENDING_STATE, verb: 'get', verbs: ['get'], script: (model, answer) => model.scriptGet(answer) },
  { name: 'the probe', row: ownIdResumeRow, state: LIVENESS_DEAD_ROW_ENDED, verb: 'read-pane', verbs: ['status', 'readPane'], options: (answers) => ({ readPane: answers }) },
  { name: 'the lap read-pane', row: conflictingLabelsResumeRow, state: AGENT_DIRECTOR_PENDING_STATE, verb: 'read-pane', verbs: ['get', 'readPane'], options: (answers) => ({ readPane: answers }) },
  { name: 'the plain spawn', row: scanLeftoverRow, state: PENDING_ROW_MODEL_NO_ROW, verb: 'spawn', verbs: ['status', 'spawn'], script: (model, answer) => model.scriptPlainSpawns(answer) },
  { name: 'the reuse', row: anotherStoreReuseRow, state: LIVENESS_DEAD_ROW_ENDED, verb: 'spawn', verbs: ['status', 'spawn'], script: (model, answer) => model.scriptReuseSpawns(answer) },
  { name: 'the resume', row: anotherStoreResumeRow, state: LIVENESS_DEAD_ROW_ENDED, verb: 'resume', verbs: ['status', 'resume'], script: (model, answer) => model.scriptResumes(answer) },
  { name: 'the finished-row retry\'s resume', row: statusOnlyRow, state: LIVENESS_DEAD_ROW_MISSING, verb: 'resume', verbs: ['status', 'get', 'resume'], script: (model, answer) => model.scriptResumes(answer) },
  // Its get finds no row: the plain first spawn.
  { name: 'the finished-row retry\'s plain spawn', row: statusOnlyRow, state: PENDING_ROW_MODEL_NO_ROW, verb: 'spawn', verbs: ['status', 'get', 'spawn'], script: (model, answer) => model.scriptPlainSpawns(answer) },
  // Its get reads ended with no session id: the reuse.
  { name: 'the finished-row retry\'s reuse', row: statusOnlyRow, state: LIVENESS_DEAD_ROW_ENDED, verb: 'spawn', verbs: ['status', 'get', 'spawn'], options: () => ({ sessionId: '' }), script: (model, answer) => model.scriptReuseSpawns(answer) },
]

/** A re-check harness latched at `site`, its answers for `rounds` rounds scripted as `answer` builds them. */
function latchAtSite(site: RecheckAnswerSite, answer: () => Error | undefined, rounds = 1): LatchedRecheckRun {
  const answers = Array.from({ length: rounds }, answer)
  const run = latchForRecheck(site.row(), { state: site.state, ...(site.options?.(answers) ?? {}) })
  for (const each of answers) site.script?.(run.model, each)
  return run
}

/** P's no-information state after a round: no condition, no outage, no retry timer or trigger, no unclassified episode, no spawn-failure notice. */
function noInformationState(h: RecoveryHarness, p: string): unknown {
  return {
    tmuxUnresponsive: h.tmuxUnresponsive.holds(p),
    outages: [...getOutageFlags(p)],
    outageNotices: h.outageNotices,
    armed: h.controller.isArmed(p),
    triggers: h.triggers.filter((trigger) => trigger.key === p),
    unclassifiedOpen: h.unclassifiedErrorOpen(p),
    notices: h.notices,
  }
}

const NO_INFORMATION_STATE = { tmuxUnresponsive: false, outages: [], outageNotices: [], armed: false, triggers: [], unclassifiedOpen: false, notices: [] }

describe('AC 71: an answer that gives a re-check no information keeps the latch and starts, raises, arms and posts nothing; CONFIG keeps it and raises the outage; UNUSABLE NAME relatches (recovery harness; SRJ-505, SRJ-307, SRJ-313, SRJ-316)', () => {
  const NO_INFORMATION = RECHECK_ANSWER_SITES.flatMap((site) =>
    recheckNoInformationAnswers(site.verb).map((answer) => [`${site.name}, ${answer.name}`, site, answer] as const),
  )

  test.each(NO_INFORMATION)('%s: P stays latched with its record and its one post, no tmux-unresponsive condition, no tmux-unavailable outage, no retry-timer arm, no unclassified episode; the next round runs as before', async (_label, site, answer) => {
    const run = latchAtSite(site, answer.answer, 2)
    const { h, p } = run
    for (let n = 0; n < 2; n++) {
      const round = await recheckRound(h, p)
      expect(round.verbs).toEqual([...site.verbs])
      expectStillLatched(run, round.at)
      expect(noInformationState(h, p)).toEqual(NO_INFORMATION_STATE)
    }
  })

  test.each(RECHECK_ANSWER_SITES.map((site) => [site.name, site] as const))('%s answering CONFIG: P stays latched with no post and one ad-config-malformed onset; nothing is armed or started', async (_label, site) => {
    const run = latchAtSite(site, RECHECK_CONFIG_ANSWER.answer)
    const { h, p } = run
    const round = await recheckRound(h, p)
    expect(round.verbs).toEqual([...site.verbs])
    expectStillLatched(run, round.at)
    expect(noInformationState(h, p)).toEqual({
      ...NO_INFORMATION_STATE,
      outages: ['ad-config-malformed'],
      outageNotices: [{ key: p, text: adConfigMalformedOnset(RECHECK_CONFIG_ANSWER.answer()) }],
    })
  })

  test.each(RECHECK_ANSWER_SITES.map((site) => [site.name, site] as const))('%s answering UNUSABLE NAME: P relatches with "unusable recorded name" and one new post; the round makes no further call', async (_label, site) => {
    const { h, p } = latchAtSite(site, RECHECK_UNUSABLE_NAME_ANSWER.answer)
    const round = await recheckRound(h, p)
    expect(round.verbs).toEqual([...site.verbs])
    expect([h.latch.record(p)?.latchCase, h.episodeNotices.length, h.latchRecheck.pendingTimers()]).toEqual([LATCH_CASE_UNUSABLE_RECORDED_NAME, 2, 1])
    expect(h.episodeNotices[1]?.text).toBe(unusableNameNoticeText(p, classifyAdError(RECHECK_UNUSABLE_NAME_ANSWER.answer()).message!))
  })

  test.each([
    ['a CONFLICT latch read with status', statusOnlyRow],
    ['a "conflicting labels" latch read with get', conflictingLabelsResumeRow],
    ['an "unusable recorded name" latch', (): RecheckLatchRow => UNUSABLE_NAME_CASE_ROWS[0]!],
  ] as const)('%s whose step-1 read finds P\'s own row pending with no launch start relatches with "launch start not recorded" and one new post, and that round makes no further call', async (_label, rowOf) => {
    const { h, p } = latchForRecheck(rowOf(), { state: AGENT_DIRECTOR_PENDING_STATE, launchStartedAt: SAMPLE_LAUNCH_START_NONE })
    const readVerb = h.latch.record(p)?.latchCase === LATCH_CASE_CONFLICTING_LABELS ? 'get' : 'status'
    const round = await recheckRound(h, p)
    expect(round.verbs).toEqual([readVerb])
    expect(h.latch.record(p)).toEqual(launchStartRecord(p))
    expect(h.episodeNotices.map((notice) => notice.text).slice(1)).toEqual([launchStartNotRecordedNoticeText(p)])
  })
})

/**
 * The re-check round's site in its lines, cut from its unmatched line's
 * builder (the site itself is not exported).
 */
function recheckSite(): string {
  const probe = latchRecheckUnmatchedLine('REF', 'OP', 'CASE')
  return probe.slice(probe.indexOf(' ') + 1, probe.indexOf(': REF'))
}

/** Persona `key`'s re-check round lines in `h` (`latchRecheckRoundLine`, one per round), in order. */
function roundLinesOf(h: RecoveryHarness, key: string): string[] {
  const [head] = lineParts((hole) => latchRecheckRoundLine(personaRefOf(h, key), hole as LatchCase, RECHECK_STEP_TABLE, RECHECK_CALL_NONE, ''))
  return h.errors.filter((line) => line.startsWith(head))
}

/** The round line's head (`latchRecheckRoundLine` up to its answer) for `key`'s round with `latchCase`, step 1's outcome `step` and the call `call`. */
function roundLineHead(h: RecoveryHarness, key: string, latchCase: LatchCase, step: LatchRecheckLineStep, call: string): string {
  return latchRecheckRoundLine(personaRefOf(h, key), latchCase, step, call, '')
}

describe('the round line names step 1\'s outcome and the call: a spawn latch\'s retry after step 1 found no row and a "not this launch\'s session" latch\'s finished-row retry each say so (HO rev 15), and so do a read that gave no information and one that relatched (recovery harness; SRJ-505, SRJ-1014)', () => {
  test.each([
    ['a reuse spawn latch', anotherStoreReuseRow, RECHECK_CALL_REUSE_SPAWN, (_model: PendingRowModel) => {}],
    // Refused again by the scan: still latched with no post.
    ['a plain spawn latch', scanLeftoverRow, RECHECK_CALL_PLAIN_SPAWN, (model: PendingRowModel) => model.scriptPlainSpawns(scanRefusal(scanLeftoverRow().build()))],
  ] as const)('%s whose step 1 finds no row: one round line, step=spawn-retry, the spawn its call', async (_label, rowOf, call, script) => {
    const row = rowOf()
    expect(recheckEntryAt(row.recheck, 'no row').decision).toMatchObject({ step: RECHECK_STEP_SPAWN_RETRY, call })
    const { h, p, model, record } = latchForRecheck(row, { state: PENDING_ROW_MODEL_NO_ROW })
    script(model)
    const round = await recheckRound(h, p)
    expect(round.verbs.slice(0, 2)).toEqual(['status', 'spawn'])
    const lines = roundLinesOf(h, p)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toStartWith(roundLineHead(h, p, record.latchCase, RECHECK_STEP_SPAWN_RETRY, call))
    await stopApprover(h, p)
  })

  test.each([
    ['missing', RECHECK_CALL_RESUME, ['status', 'get', 'resume']],
    ['no row', RECHECK_CALL_PLAIN_SPAWN, ['status', 'get', 'spawn']],
  ] as const)('a "not this launch\'s session" latch whose step 1 reads %s: one round line, step=finished-row-retry, the finished-row retry and the launch its get decided as its call', async (reading, launch, verbs) => {
    const row = statusOnlyRow()
    expect(recheckEntryAt(row.recheck, reading).decision).toMatchObject({ step: RECHECK_STEP_FINISHED_ROW_RETRY, call: RECHECK_CALL_FINISHED_ROW })
    const entry = finishedRowEntryFor(reading)
    expect(entry.call).toBe(launch)
    const run = latchForRecheck(row, { state: reading === 'no row' ? PENDING_ROW_MODEL_NO_ROW : rowStateOfReading(reading) })
    const { h, p, model, record } = run
    // A launch answer that gives no information: P stays latched with no post.
    scriptLaunchAnswer(model, launch, entry.answers!.noInformation[0]!.answer())
    const round = await recheckRound(h, p)
    expect(round.verbs).toEqual([...verbs])
    expectStillLatched(run, round.at)
    const lines = roundLinesOf(h, p)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toStartWith(roundLineHead(h, p, record.latchCase, RECHECK_STEP_FINISHED_ROW_RETRY, `${RECHECK_CALL_FINISHED_ROW}:${launch}`))
  })

  test('a step-1 read that gives no information: one round line, step=no-information and no call', async () => {
    const run = latchForRecheck(statusOnlyRow(), { state: rowStateOfReading('waiting') })
    const { h, p, model, record } = run
    model.scriptStatus(recheckNoInformationAnswers('status')[0]!.answer()!)
    const round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status'])
    expectStillLatched(run, round.at)
    const lines = roundLinesOf(h, p)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toStartWith(roundLineHead(h, p, record.latchCase, RECHECK_STEP_NO_INFORMATION, RECHECK_CALL_NONE))
  })

  test('a step-1 read that relatches P with another case: one round line naming the case it had, step=not-decided and no call', async () => {
    const { h, p, record } = latchForRecheck(statusOnlyRow(), { state: AGENT_DIRECTOR_PENDING_STATE, launchStartedAt: SAMPLE_LAUNCH_START_NONE })
    const round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status'])
    expect(h.latch.record(p)).toEqual(launchStartRecord(p))
    const lines = roundLinesOf(h, p)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toStartWith(roundLineHead(h, p, record.latchCase, RECHECK_LINE_STEP_NOT_DECIDED, RECHECK_CALL_NONE))
  })

  test('a step-1 read the table decides (a "this row\'s own id" resume on a row read ended): one round line, step=step-2 and the probe its call', async () => {
    const row = ownIdResumeRow()
    const ended = recheckEntryAt(row.recheck, 'ended')
    expect(ended.decision).toMatchObject({ step: RECHECK_STEP_TABLE, call: RECHECK_CALL_PROBE })
    const run = latchForRecheck(row, { state: LIVENESS_DEAD_ROW_ENDED, readPane: [ended.answers!.stillLatched[0]!.answer()] })
    const { h, p, record } = run
    const round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status', 'readPane'])
    expectStillLatched(run, round.at)
    const lines = roundLinesOf(h, p)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toStartWith(roundLineHead(h, p, record.latchCase, RECHECK_STEP_TABLE, RECHECK_CALL_PROBE))
  })
})

describe('a round\'s launch asks the gates every launch path asks: a persona not up, held on ErrInvalidFlags or held back for an old life gets no launch and stays latched with no post (recovery harness; b.av2 SR-6.4; SRJ-505, SRJ-207, SRJ-810)', () => {
  test('not up (its bring-up has not succeeded, the relaunch gate main() passes): its status read and the not-up line, no spawn, P still latched with no post; once up, the next round makes the reuse', async () => {
    const run = latchForRecheck(anotherStoreReuseRow(), { state: LIVENESS_DEAD_ROW_ENDED })
    const { h, p } = run
    h.setUp(p, false)
    let round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status'])
    expectStillLatched(run, round.at)
    expect(h.errors.filter((line) => line === latchRecheckNotUpLine(personaRefOf(h, p), RECHECK_CALL_REUSE_SPAWN))).toHaveLength(1)
    h.setUp(p, true)
    round = await recheckRound(h, p)
    expect(round.verbs.slice(0, 2)).toEqual(['status', 'spawn'])
    expect(h.stub.calls.spawnCalls).toEqual([reuseSpawnOf(h, p)])
    await stopApprover(h, p)
  })

  test('a launch already in flight for P (its spawn held open, P latched meanwhile): the round\'s status read and the in-flight line, no second spawn, P still latched with no post', async () => {
    const h = makeRecheckHarness()
    const [p] = h.keys as [string]
    const model = makePendingRowModel(h, p, { sessionId: 'session-of-p', state: PENDING_ROW_MODEL_NO_ROW })
    const id = personaInstanceId(p)
    const hold = holdSpawns(h.stub.client, (spawned) => spawned === id)
    const launching = h.launch(p)
    await hold.entered(id)
    anotherStoreReuseRow().latchOn(h.latchSet, p)
    const record = h.latch.record(p)
    model.setState(LIVENESS_DEAD_ROW_ENDED)

    // The round, with the launch still held (so no settling of launches).
    await h.advance(h.latchRecheck.nextDueAt()! - h.clock.now())
    await h.latchRecheck.whenRoundSettled(p)

    expect(h.errors.filter((line) => line === latchRecheckLaunchInFlightLine(personaRefOf(h, p), RECHECK_CALL_REUSE_SPAWN))).toHaveLength(1)
    expect(hold.calls).toHaveLength(1)
    expect([h.latch.record(p), h.episodeNotices.length]).toEqual([record, 1])
    hold.release(id)
    await launching
    await h.settle()
    await stopApprover(h, p)
  })

  test('its claude_config_dir unresolvable (bug b.g57): its status read and the config-dir line, no spawn, P still latched with no post; once it resolves, the next round makes the reuse', async () => {
    const run = latchForRecheck(anotherStoreReuseRow(), { state: LIVENESS_DEAD_ROW_ENDED })
    const { h, p } = run
    const gone = (): never => {
      throw Object.assign(new Error('no such directory'), { code: 'ENOENT' })
    }
    _setConfigDirFs({ realpath: gone, lstat: gone })
    let round: RecheckRoundRun
    try {
      round = await recheckRound(h, p)
    } finally {
      _resetConfigDirFs()
    }
    expect(round.verbs).toEqual(['status'])
    expectStillLatched(run, round.at)
    expect(h.errors.filter((line) => line === latchRecheckConfigDirLine(personaRefOf(h, p), RECHECK_CALL_REUSE_SPAWN))).toHaveLength(1)
    round = await recheckRound(h, p)
    expect(round.verbs.slice(0, 2)).toEqual(['status', 'spawn'])
    await stopApprover(h, p)
  })

  test('held: a reuse retry answering ErrInvalidFlags holds P (SRJ-207), and the next round makes no spawn: its status read and the held line, P still latched with no further post', async () => {
    const { h, p, record } = latchForRecheck(anotherStoreReuseRow(), { state: LIVENESS_DEAD_ROW_ENDED, reuseSpawns: [errInvalidFlags('spawn')] })
    let round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status', 'spawn'])
    expect([h.invalidFlagsHold.isHeld(p), h.latch.record(p)]).toEqual([true, record])
    const posts = h.episodeNotices.length
    const errorsFrom = h.errors.length
    round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status'])
    expect(h.stub.calls.spawnCalls).toHaveLength(1)
    expect(h.errors.slice(errorsFrom).filter((line) => line === invalidFlagsHeldNoLaunchLine(recheckSite(), personaRefOf(h, p)))).toHaveLength(1)
    expect([h.latch.record(p), h.episodeNotices.length, h.latchRecheck.nextDueAt()]).toEqual([record, posts, round.at + LATCH_RECHECK_INTERVAL_MS])
  })

  test('held back for an old life: an old row held at P\'s working directory makes the round answer sequence-waiting with no launch, its line saying no retry timer is armed; P still latched with no post, and no timer armed for it', async () => {
    const run = latchForRecheck(anotherStoreReuseRow(), { state: LIVENESS_DEAD_ROW_ENDED })
    const { h, p } = run
    holdOldAt(h, PRE_PERSONA_ID, PRE_PERSONA_ID, p)
    // The old row reads ended at the wait's get, so the wait ends the hold.
    h.script({ getResult: cannedGetResult({ claude_instance_id: PRE_PERSONA_ID, cwd: personaOf(h, p).working_directory, labels: { ...PRE_PERSONA_LABELS }, state: LIVENESS_DEAD_ROW_ENDED }) })
    const round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status'])
    expectStillLatched(run, round.at)
    expect(h.errors.filter((line) => line === oldLifeHoldLaunchLine(recheckSite(), personaRefOf(h, p), realpathSync(personaOf(h, p).working_directory), [{ instanceId: PRE_PERSONA_ID, wait: LIVE_ROW_START_STARTED }], false, true))).toHaveLength(1)
    expect([h.controller.isArmed(p), h.triggers.filter((trigger) => trigger.key === p), h.stub.calls.spawnCalls, h.stub.calls.resumeCalls]).toEqual([false, [], [], []])
    await h.driveSequence(h.oldLifeWaitSettled(PRE_PERSONA_ID))
  })
})

describe('AC 46 with the re-check bound: while P is latched no automated path calls agent-director for it; its only calls are the re-check\'s, one status read per 120 s (recovery harness; SRJ-502, SRJ-505)', () => {
  test('a new launch, the retry entry, a scheduled and a human-triggered restart and the retry timer make no call for P; each of P\'s calls is a round\'s status read, 120 s apart; Q\'s paths reach the stub as before', async () => {
    const run = makeAutomatedPathsRun({ latchRecheck: true })
    const { h } = run
    const [p, q] = h.keys as [string, string]
    run.readWorking(p)
    statusOnlyRow().latchOn(h.latchSet, p)
    const latchedAt = h.clock.now()
    const from = h.timedCalls.length
    const { launched, qCalls } = await driveEveryPath(run)
    // One status read at each round, 120 s apart from the latch on, and nothing else.
    const rounds = Math.floor((h.clock.now() - latchedAt) / LATCH_RECHECK_INTERVAL_MS)
    expect(rounds).toBeGreaterThan(1)
    expect(personaCallsFrom(h, p, from).filter((call) => call.instanceId === personaInstanceId(p)).map((call) => [call.verb, call.at])).toEqual(
      Array.from({ length: rounds }, (_, n) => ['status', latchedAt + (n + 1) * LATCH_RECHECK_INTERVAL_MS]),
    )
    expect(launched).toEqual([{ key: p, action: 'latched' }, { key: q, action: 'spawned' }])
    expect([h.latch.record(p), h.episodeNotices.length]).toEqual([statusOnlyRow().record(p), 1])
    expect(qCalls).toEqual([...Q_CALLS_ON_EVERY_PATH])
  })
})

// ---------------------------------------------------------------------------
// The clear (b.jg5 SRJ-506, SRJ-1005, SRJ-1016; E30 T2). Pure: the one clear
// entry (`createLatchClear`) over a real latch and real notice episodes, its
// line (`latchClearedLine`), the single retry after a cleared probe
// (`decideClearedProbeRetry`) and the clears that launched nothing. Then, on
// the recovery harness with the re-check bound, every clear point of the case
// table: one recovery post with its reason, the episode ended, the timer
// stopped, and what follows (the bypassing `find-missing` and the retry at
// once after a clear that launched nothing; nothing after a retry's clear);
// the cleared probe's `find-missing` and single retry; the holds' clears; the
// after-clear job's ordering in P's serializer turn; and the exported
// after-clear sequence and the builder's clear entries. Recovery texts come
// from the builders with the reason from the case table's columns.
// ---------------------------------------------------------------------------

/** A notice run with the clear entry over its latch and episodes, its timer stops recorded and its line to the run's lines. */
interface ClearRun extends NoticeRun {
  readonly clear: LatchClear
  readonly timerStops: string[]
}

function makeClearRun(): ClearRun {
  const run = makeNoticeRun()
  const timerStops: string[] = []
  const clear = createLatchClear({
    latch: run.latch,
    episodes: run.episodes,
    stopTimer: (key) => {
      timerStops.push(key)
    },
    log: (line) => run.lines.push(line),
  })
  return { ...run, clear, timerStops }
}

/** The recovery post the clear of `record` for `reason` makes for `key`, from the builders. */
function recoveryPost(key: string, record: ConflictLatchRecord, reason: LatchRecoveryReason): { key: string; text: string } {
  return { key, text: latchRecoveryText(latchKindOf(record.latchCase), reason, record.sessionName) }
}

/** The clear-entry lines among `lines` for `key`. */
function clearedLinesIn(lines: readonly string[], key: string): string[] {
  return lines.filter((line) => line.startsWith(`[slack] conflict-latch: persona=${key} cleared — `))
}

/** One latch of each kind the clear entry posts for: a CONFLICT case, the unusable recorded name and the launch start not recorded. */
const CLEAR_KIND_LATCHES: ReadonlyArray<readonly [string, () => Pick<RecheckTableRow, 'latchOn' | 'record'>]> = [
  ['a CONFLICT latch ("this row\'s own id")', lazyRow((row) => row.latchCase === LATCH_CASE_OWN_ID)],
  ['an "unusable recorded name" latch', () => UNUSABLE_NAME_CASE_ROWS[0]!],
  ['a "launch start not recorded" latch', () => LAUNCH_START_CASE_ROWS[0]!],
]

describe('the clear entry: one recovery post with its reason in the episode of the latch\'s kind, every latch episode ended, the timer stopped and one line (SRJ-506, SRJ-1005, SRJ-1016; pure)', () => {
  const CASES = CLEAR_KIND_LATCHES.flatMap(([latchName, row]) => RECOVERY_REASONS.map(([reasonName, reason]) => [latchName, reasonName, row, reason] as const))

  test.each(CASES)('%s cleared for %s: answers true, the record gone, the timer stopped once, exactly one recovery post after the latch\'s own, no latch episode left open and the one cleared line', (_latch, _reason, rowOf, reason) => {
    const run = makeClearRun()
    rowOf().latchOn(run.latch, KEY)
    const record = run.latch.record(KEY)!
    const posts = run.posts.length

    expect(run.clear(KEY, reason)).toBe(true)

    expect(run.latch.record(KEY)).toBeUndefined()
    expect(run.timerStops).toEqual([KEY])
    const post = recoveryPost(KEY, record, reason)
    expect(run.posts.slice(posts)).toEqual([[post.key, post.text]])
    expect(posts).toBe(1)
    expect(LATCH_NOTICE_EPISODE_KINDS.map((kind) => [kind, run.episodes.isOpen(KEY, kind)])).toEqual(LATCH_NOTICE_EPISODE_KINDS.map((kind) => [kind, false]))
    expect(clearedLinesIn(run.lines, KEY)).toEqual([latchClearedLine(KEY, record, reason, true)])
  })

  test('after a clear, a latch with the same case begins a new episode and posts its notice again, and a clear of that latch posts again', () => {
    const run = makeClearRun()
    const ownId = CLEAR_KIND_LATCHES[0]![1]()
    ownId.latchOn(run.latch, KEY)
    const record = run.latch.record(KEY)!
    const firstEpisode = run.episodes.view(KEY, PERSONA_EPISODE_KIND_CONFLICT)?.episode
    expect(run.clear(KEY, LATCH_RECOVERY_REASON_ROW_GONE)).toBe(true)
    expect(ownId.latchOn(run.latch, KEY)).toBe(CONFLICT_LATCH_SET_LATCHED)
    expect(run.episodes.view(KEY, PERSONA_EPISODE_KIND_CONFLICT)?.episode).not.toBe(firstEpisode)
    expect(run.clear(KEY, LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED)).toBe(true)
    const notice = run.posts[0]![1]
    expect(run.posts).toEqual([
      [KEY, notice],
      [KEY, recoveryPost(KEY, record, LATCH_RECOVERY_REASON_ROW_GONE).text],
      [KEY, notice],
      [KEY, recoveryPost(KEY, record, LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED).text],
    ])
  })

  test('a CONFLICT latch relatched as "unusable recorded name" clears with the hold recovery in the hold\'s episode; the next CONFLICT latch and the next hold latch each post their notice again', () => {
    const run = makeClearRun()
    const ownId = CLEAR_KIND_LATCHES[0]![1]()
    const unusable = CLEAR_KIND_LATCHES[1]![1]()
    ownId.latchOn(run.latch, KEY)
    expect(unusable.latchOn(run.latch, KEY)).toBe(CONFLICT_LATCH_SET_RELATCHED)
    const record = run.latch.record(KEY)!
    expect(run.clear(KEY, LATCH_RECOVERY_REASON_ROW_GONE)).toBe(true)
    expect(run.posts.slice(2)).toEqual([[KEY, holdRecoveryText(LATCH_RECOVERY_REASON_ROW_GONE)]])
    ownId.latchOn(run.latch, KEY)
    unusable.latchOn(run.latch, KEY)
    expect(run.posts.slice(3)).toEqual([run.posts[0], run.posts[1]])
    expect(record.latchCase).toBe(LATCH_CASE_UNUSABLE_RECORDED_NAME)
  })

  test('an unlatched persona, and a second clear of the same latch, answer false with no post, no timer stop and no line; another persona\'s latch and episode are untouched', () => {
    const run = makeClearRun()
    expect(run.clear(KEY, LATCH_RECOVERY_REASON_ROW_GONE)).toBe(false)
    expect([run.posts, run.timerStops, clearedLinesIn(run.lines, KEY)]).toEqual([[], [], []])

    const ownId = CLEAR_KIND_LATCHES[0]![1]()
    ownId.latchOn(run.latch, KEY)
    ownId.latchOn(run.latch, OTHER)
    const other = run.latch.record(OTHER)
    expect(run.clear(KEY, LATCH_RECOVERY_REASON_ROW_GONE)).toBe(true)
    expect(run.clear(KEY, LATCH_RECOVERY_REASON_ROW_GONE)).toBe(false)
    expect(run.posts.filter(([key]) => key === KEY)).toHaveLength(2)
    expect([run.timerStops, clearedLinesIn(run.lines, KEY)]).toEqual([[KEY], [latchClearedLine(KEY, ownId.record(KEY), LATCH_RECOVERY_REASON_ROW_GONE, true)]])
    expect([run.latch.record(OTHER), run.episodes.isOpen(OTHER, PERSONA_EPISODE_KIND_CONFLICT), run.posts.filter(([key]) => key === OTHER)]).toEqual([
      other,
      true,
      [[OTHER, run.posts[1]![1]]],
    ])
  })

  test('after the episodes close (shutdown) a clear still drops the latch and stops the timer, posts nothing and says so on its line', () => {
    const run = makeClearRun()
    const ownId = CLEAR_KIND_LATCHES[0]![1]()
    ownId.latchOn(run.latch, KEY)
    const record = run.latch.record(KEY)!
    run.episodes.close()
    expect(run.clear(KEY, LATCH_RECOVERY_REASON_ROW_GONE)).toBe(true)
    expect([run.latch.record(KEY), run.timerStops, run.posts.length]).toEqual([undefined, [KEY], 1])
    expect(clearedLinesIn(run.lines, KEY)).toEqual([latchClearedLine(KEY, record, LATCH_RECOVERY_REASON_ROW_GONE, false)])
  })

  test('a timer stop that throws is logged under its step and the post, the episode end and the line still follow; a throwing log is swallowed', () => {
    const run = makeNoticeRun()
    const ownId = CLEAR_KIND_LATCHES[0]![1]()
    ownId.latchOn(run.latch, KEY)
    const record = run.latch.record(KEY)!
    const clear = createLatchClear({
      latch: run.latch,
      episodes: run.episodes,
      stopTimer: () => {
        throw new Error('stop failed')
      },
      log: (line) => run.lines.push(line),
    })
    expect(clear(KEY, LATCH_RECOVERY_REASON_ROW_GONE)).toBe(true)
    expect(run.lines.filter((line) => line.startsWith(`[slack] conflict-latch: persona=${KEY} clear step failed (timer stop): `))).toHaveLength(1)
    expect(run.posts.slice(1)).toEqual([[KEY, recoveryPost(KEY, record, LATCH_RECOVERY_REASON_ROW_GONE).text]])
    expect([run.episodes.isOpen(KEY, PERSONA_EPISODE_KIND_CONFLICT), clearedLinesIn(run.lines, KEY)]).toEqual([false, [latchClearedLine(KEY, record, LATCH_RECOVERY_REASON_ROW_GONE, true)]])

    ownId.latchOn(run.latch, OTHER)
    const quiet = createLatchClear({
      latch: run.latch,
      episodes: run.episodes,
      stopTimer: () => {},
      log: () => {
        throw new Error('log failed')
      },
    })
    expect(quiet(OTHER, LATCH_RECOVERY_REASON_ROW_GONE)).toBe(true)
    expect(run.latch.record(OTHER)).toBeUndefined()
  })

  test('the cleared line (SRJ-506, SRJ-1014): the persona, the case, the quoted session, the reason unescaped with its state rendered as a description is (redacted, on one line), and whether the notice was posted', () => {
    const record = ownIdRecordFor(KEY)
    const state = `stale\n${sentinelInMessage('state')}`
    const line = latchClearedLine(KEY, record, latchRecoveryReasonRowReads(state), true)
    expect(line).toBe(
      `[slack] conflict-latch: persona=${KEY} cleared — case=${record.latchCase} session=${JSON.stringify(record.sessionName)} ` +
        `reason=${JSON.stringify(LATCH_RECOVERY_REASON_ROW_READS_HEAD + renderLogMessageText(state))}; recovery notice posted`,
    )
    expect(latchClearedLine(KEY, record, LATCH_RECOVERY_REASON_CLEARED_BY_HAND, false)).toBe(
      `[slack] conflict-latch: persona=${KEY} cleared — case=${record.latchCase} session=${JSON.stringify(record.sessionName)} ` +
        `reason=${JSON.stringify(LATCH_RECOVERY_REASON_TEXTS[LATCH_RECOVERY_REASON_KIND_CLEARED_BY_HAND])}; recovery notice not posted (the notice episodes are closed)`,
    )
    assertNoLeak([line])
  })
})

/** The record a "this row's own id" latch holds for `key`. */
function ownIdRecordFor(key: string): ConflictLatchRecord {
  return CLEAR_KIND_LATCHES[0]![1]().record(key)
}

/**
 * The single retry after a cleared probe, written from SRJ-506 (HO rev 28;
 * hatch A3) for the refused operation and step 1's reading: the same
 * `resume` or reuse only on a row read `ended` or `missing`; a plain spawn as
 * the plain-spawn row keys on step 1's row (no row: the plain spawn; `ended`
 * or `missing`: the reuse; live: none); a pane verb's, a kill's, a note's or a
 * bring-up's latch: one run of the restart path's decision; a retired key's
 * `resume` or plain spawn: the reuse.
 */
function expectedClearedProbeRetry(refusedOperation: string, reading: LatchRecheckReading, retired: boolean): LatchRecheckCall {
  const finished = reading.kind === RECHECK_READING_STATE && AGENT_DIRECTOR_DEAD_STATES.has(reading.state)
  const asRetired = (call: LatchRecheckCall): LatchRecheckCall =>
    retired && (call === RECHECK_CALL_RESUME || call === RECHECK_CALL_PLAIN_SPAWN) ? RECHECK_CALL_REUSE_SPAWN : call
  switch (refusedOperation) {
    case REFUSED_OPERATION_RESUME:
      return finished ? asRetired(RECHECK_CALL_RESUME) : RECHECK_CALL_NONE
    case REFUSED_OPERATION_REUSE_SPAWN:
      return finished ? RECHECK_CALL_REUSE_SPAWN : RECHECK_CALL_NONE
    case REFUSED_OPERATION_PLAIN_SPAWN:
      if (reading.kind === RECHECK_READING_NO_ROW_VALUE.kind) return asRetired(RECHECK_CALL_PLAIN_SPAWN)
      return finished ? RECHECK_CALL_REUSE_SPAWN : RECHECK_CALL_NONE
    case REFUSED_OPERATION_BRING_UP:
    case REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY:
      return RECHECK_CALL_RESTART_DECISION
    default:
      return RECHECK_CALL_NONE
  }
}

describe('the single retry after a cleared probe, and the clears that launched nothing (SRJ-506; HO rev 28; hatch A3; pure)', () => {
  const READINGS: ReadonlyArray<readonly [string, LatchRecheckReading]> = [
    ['no row', RECHECK_READING_NO_ROW_VALUE],
    ...[AGENT_DIRECTOR_PENDING_STATE, 'waiting', 'working', LIVENESS_DEAD_ROW_ENDED, LIVENESS_DEAD_ROW_MISSING].map(
      (state) => [state, Object.freeze({ kind: RECHECK_READING_STATE, state }) as LatchRecheckReading] as const,
    ),
  ]
  const OPERATIONS = [
    REFUSED_OPERATION_RESUME,
    REFUSED_OPERATION_REUSE_SPAWN,
    REFUSED_OPERATION_PLAIN_SPAWN,
    REFUSED_OPERATION_BRING_UP,
    REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY,
    REFUSED_OPERATION_NONE,
  ] as const
  const CASES = OPERATIONS.flatMap((op) => READINGS.flatMap(([name, reading]) => [false, true].map((retired) => [op, name, retired, reading] as const)))

  test.each(CASES)('a latch refusing %s, step 1 reading %s, key retired %p: the latched operation as SRJ-506 names it, or none', (op, _name, retired, reading) => {
    expect(decideClearedProbeRetry({ refusedOperation: op }, reading, retired)).toBe(expectedClearedProbeRetry(op, reading, retired))
  })

  test('the clears that launched nothing, after which P is retried at once, are step 1\'s, a launch start not recorded read finished and a "conflicting labels" latch\'s pending read-pane; a retry\'s, a finished-row retry\'s and a run of the restart path\'s decision keep their own outcome', () => {
    const launchedNothing: string[] = [...RECHECK_CLEARS_THAT_LAUNCHED_NOTHING]
    expect(launchedNothing.sort()).toEqual([RECHECK_CLEARED_BY_STEP_1, RECHECK_CLEARED_BY_LAUNCH_START_FINISHED, RECHECK_CLEARED_BY_PENDING_READ_PANE].sort())
    for (const by of [RECHECK_CLEARED_BY_RETRY, RECHECK_CLEARED_BY_FINISHED_ROW_RETRY, RECHECK_CLEARED_BY_RESTART_DECISION] as const) {
      expect([by, RECHECK_CLEARS_THAT_LAUNCHED_NOTHING.has(by)]).toEqual([by, false])
    }
  })
})

/** The stub calls a re-check or its after-clear job launches with. */
const LAUNCH_VERBS: ReadonlySet<string> = new Set(['spawn', 'resume'])

/** One P call the stub client saw, as `watchCalls` records it: the verb, the notice posts made by then and whether P was latched and active. */
interface WatchedCall {
  readonly verb: string
  readonly posts: number
  readonly latched: boolean
  readonly active: boolean
}

/**
 * Record, at each call of `verbs` on the harness's stub client for persona
 * `key` (or naming no instance, as `findMissing`), the verb, the notice posts
 * made by then, and whether P was latched and held active then.
 */
function watchCalls(h: RecoveryHarness, key: string, verbs: readonly RecoveryStubVerb[] = ['status', 'get', 'readPane', 'findMissing', 'spawn', 'resume']): WatchedCall[] {
  const seen: WatchedCall[] = []
  const id = personaInstanceId(key)
  const client = h.stub.client as unknown as Record<string, (params?: { claude_instance_id?: unknown }) => unknown>
  for (const verb of verbs) {
    const original = client[verb]!.bind(client)
    client[verb] = (params) => {
      const named = params?.claude_instance_id
      if (named === undefined || named === id) {
        seen.push({ verb, posts: h.episodeNotices.length, latched: h.latch.isLatched(key), active: isRestartPendingOrActive(key) })
      }
      return original(params)
    }
  }
  return seen
}

/** Persona `key` of `h` as the session manager's lines name it: its name and key. */
function personaRefOf(h: RecoveryHarness, key: string): string {
  return renderPersonaRef(personaOf(h, key).name, key)
}

/** The after-clear sequence's "retry at once" lines for persona `key` of `h`. */
function retryAtOnceLinesOf(h: RecoveryHarness, key: string): string[] {
  const head = latchClearRetryAtOnceLineHead(personaRefOf(h, key))
  return h.errors.filter((line) => line.startsWith(head))
}

/** Stop P's dialog approver when a launch started it, so the harness's cleanup finds no timer. */
async function stopApprover(h: RecoveryHarness, key: string): Promise<void> {
  if (h.approverRunning(key)) await h.runApproverToStop(key)
}

/** P unlatched with its re-check timer stopped and no latch episode open. */
function expectClearedState(h: RecoveryHarness, key: string): void {
  expect([h.latch.isLatched(key), h.latchRecheck.isArmed(key), h.latchRecheck.pendingTimers()]).toEqual([false, false, 0])
  expect(LATCH_NOTICE_EPISODE_KINDS.map((kind) => [kind, h.episodes.isOpen(key, kind)])).toEqual(LATCH_NOTICE_EPISODE_KINDS.map((kind) => [kind, false]))
}

/** Every step-1 clear of the case table (gone, reported in) and every "launch start not recorded" clear on `ended` or `missing`, by row and reading. */
const RECHECK_CLEARS = RECHECK_TABLE.flatMap((row) =>
  row.recheck.entries.filter((entry) => entry.decision.clear !== undefined).map((entry) => [`${row.name}, step 1 reading ${entry.name}`, row, entry] as const),
)

describe('a clear by step 1 or by a "launch start not recorded" row read finished: one recovery post with the column\'s reason, then the retry at once, after one bypassing find-missing for a step-1 clear only (recovery harness; SRJ-505, SRJ-506, SRJ-1005, SRJ-120; AC 43, AC 85, AC 86)', () => {
  test('the table has a step-1 clear for every kind of latch that clears at step 1, and a finished-row clear for every launch-start row', () => {
    expect(RECHECK_CLEARS.length).toBeGreaterThan(RECHECK_TABLE.length / 2)
    const launchStartClears = RECHECK_CLEARS.filter(([, row, entry]) => row.noLaunchStart && entry.decision.step === RECHECK_STEP_TABLE)
    // Every launch-start row, LAUNCH_START_AND_NOTE_ROW included.
    expect(launchStartClears).toHaveLength(2 * (LAUNCH_START_CASE_ROWS.length + 1))
  })

  test.each(RECHECK_CLEARS)('%s', async (_name, row, entry) => {
    const { h, p, q, model } = latchForRecheck(row, row.noLaunchStart ? { launchStartedAt: SAMPLE_LAUNCH_START_NONE } : {})
    if (row.probeDropped) expect(h.latchSet.setProbeDropped(p)).toBe(true)
    const record = h.latch.record(p)!
    scriptRecheckReading(model, row.recheck.readVerb, entry)
    const watched = watchCalls(h, p)
    const from = h.timedCalls.length

    await h.advanceToRecheck()

    const reason = entry.decision.clear!.reason
    const stepOne = entry.decision.step !== RECHECK_STEP_TABLE
    // One recovery post with the column's reason, its line, the episode ended and the timer stopped.
    expect(h.episodeNotices.slice(1)).toEqual([recoveryPost(p, record, reason)])
    expect(clearedLinesIn(h.errors, p)).toEqual([latchClearedLine(p, record, reason, true)])
    expectClearedState(h, p)
    // Step 1's read; after a step-1 clear, one bypassing find-missing before the next read of P's row; then the retry at once.
    const verbs: string[] = personaCallsFrom(h, p, from).map((call) => call.verb)
    expect(verbs[0]).toBe(row.recheck.readVerb)
    expect(verbs.filter((verb) => verb === 'findMissing')).toHaveLength(stepOne ? 1 : 0)
    if (stepOne) expect(verbs[1]).toBe('findMissing')
    // The retry at once launches once over a row gone or finished, and not at all over one that reported in (its run reconnects or defers).
    const read = pendingRowOfRecheckReading(entry.reading)!
    const launches = read.state === PENDING_ROW_MODEL_NO_ROW || AGENT_DIRECTOR_DEAD_STATES.has(read.state) ? 1 : 0
    expect(verbs.filter((verb) => LAUNCH_VERBS.has(verb)).length).toBe(launches)
    expect(retryAtOnceLinesOf(h, p)).toHaveLength(1)
    // The post came between step 1's read and the job's first call, made with P unlatched and held active.
    expect([watched[0]?.posts, watched[0]?.latched]).toEqual([1, true])
    expect([watched[1]?.verb, watched[1]?.posts, watched[1]?.latched, watched[1]?.active]).toEqual([stepOne ? 'findMissing' : 'status', 2, false, true])
    expect(isRestartPendingOrActive(p)).toBe(false)
    await stopApprover(h, p)
    expect([h.latch.isLatched(q), personaCallCounts(h, q)]).toEqual([false, {}])
  })
})

describe('AC 42, AC 43: a latch set while the row read live is not cleared by a live reading and posts nothing more; one set on a pending row clears once the row reports in (recovery harness; SRJ-505, SRJ-506)', () => {
  const LIVE_STATES = ['waiting', 'working', 'ask_user', 'check_permission'] as const
  const SET_LIVE = RECHECK_TABLE.filter((row) => {
    const record = row.record(KEY)
    const waiting = recheckEntryAt(row.recheck, 'waiting')
    return rowStateCountsAsLive(record.rowState) && record.rowState.kind === LATCH_ROW_STATE_KIND_READ && waiting.decision.call === RECHECK_CALL_NONE && waiting.decision.clear === undefined
  }).map((row) => [row.name, row] as const)

  test('every live state a latch of the case table records has its rows in the AC 42 table', () => {
    const liveRecorded = (rows: readonly RecheckTableRow[]): string[] => [
      ...new Set(
        rows.flatMap((row) => {
          const { rowState } = row.record(KEY)
          return rowState.kind === LATCH_ROW_STATE_KIND_READ && rowStateCountsAsLive(rowState) ? [rowState.state] : []
        }),
      ),
    ].sort()
    const recorded = liveRecorded(RECHECK_TABLE)
    expect(recorded.length).toBeGreaterThan(0)
    expect(liveRecorded(SET_LIVE.map(([, row]) => row))).toEqual(recorded)
  })

  test.each(SET_LIVE)('AC 42, %s: rounds reading waiting, working, ask_user and check_permission each read only, keep the record and post nothing; no round clears it', async (_name, row) => {
    const run = latchForRecheck(row, { state: 'waiting' })
    const { h, p, model } = run
    for (const state of LIVE_STATES) {
      model.setState(state)
      const round = await recheckRound(h, p)
      expect([state, round.verbs]).toEqual([state, [row.recheck.readVerb]])
      expectStillLatched(run, round.at)
    }
    expect(clearedLinesIn(h.errors, p)).toEqual([])
  })

  test('AC 43: the approver\'s read-pane meets "conflicting labels" on P\'s pending launch; once a human answers the dialog the row reads waiting, and the next round clears with one "its agent-director row reads waiting" post, then one find-missing and the retry at once', async () => {
    const row = APPROVER_CONFLICT_CASE_ROWS.find((candidate) => candidate.latchCase === LATCH_CASE_CONFLICTING_LABELS && candidate.verb === 'read-pane')!
    expect(row.rowState).toEqual(latchRowStateRead(AGENT_DIRECTOR_PENDING_STATE))
    const { h, p, model, record } = latchForRecheck(row, { state: AGENT_DIRECTOR_PENDING_STATE, dialog: PENDING_ROW_DIALOG_TRUST, readPane: [row.build()] })
    // While pending, the lap's read-pane meets the same case: still latched, no post.
    let round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['get', 'readPane'])
    expect(h.episodeNotices).toHaveLength(1)
    // A human answers the dialog by hand: the row reads waiting.
    model.setDialog(PENDING_ROW_DIALOG_NONE)
    model.setState('waiting')
    round = await recheckRound(h, p)
    expect(round.verbs.slice(0, 2)).toEqual(['get', 'findMissing'])
    expect(h.episodeNotices.slice(1)).toEqual([recoveryPost(p, record, latchRecoveryReasonRowReads('waiting'))])
    expectClearedState(h, p)
    expect(retryAtOnceLinesOf(h, p)).toHaveLength(1)
    await stopApprover(h, p)
  })
})

/** A retry the re-check makes at its cadence, by table row: the first entry whose call is a launch, with each answer that clears. */
const CADENCE_RETRY_CLEARS = RECHECK_TABLE.filter((row) => !row.probeDropped).flatMap((row) => {
  const entry = row.recheck.entries.find(
    (candidate) => candidate.decision.clear === undefined && LAUNCH_CALL_METHOD[candidate.decision.call] !== undefined && (candidate.answers?.cleared.length ?? 0) > 0,
  )
  return entry === undefined ? [] : entry.answers!.cleared.map((answer) => [`${row.name}, step 1 reading ${entry.name}, ${answer.name}`, row, entry, answer] as const)
})

describe('a retry at the cadence that is not refused: no post before it, no find-missing, one recovery post with "a retry of the refused operation was not refused", and no second launch (recovery harness; SRJ-506, SRJ-1005; hatch A3)', () => {
  test.each(CADENCE_RETRY_CLEARS)('%s', async (_name, row, entry, answer) => {
    const { h, p, model, record } = latchForRecheck(row, row.noLaunchStart ? { launchStartedAt: SAMPLE_LAUNCH_START_NONE } : {})
    scriptRecheckReading(model, row.recheck.readVerb, entry)
    scriptLaunchAnswer(model, entry.decision.call, answer.answer())
    const watched = watchCalls(h, p)
    const from = h.timedCalls.length

    await h.advanceToRecheck()

    const verbs: string[] = personaCallsFrom(h, p, from).map((call) => call.verb)
    expect(verbs.slice(0, 2)).toEqual([row.recheck.readVerb, LAUNCH_CALL_METHOD[entry.decision.call]!])
    expect([verbs.filter((verb) => LAUNCH_VERBS.has(verb)).length, verbs.includes('findMissing')]).toEqual([1, false])
    // P was still latched with only its latch post when the retry was made.
    expect(watched.filter((call) => LAUNCH_VERBS.has(call.verb)).map((call) => [call.posts, call.latched])).toEqual([[1, true]])
    expect(answer.reason).toEqual(LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED)
    expect(h.episodeNotices.slice(1)).toEqual([recoveryPost(p, record, answer.reason)])
    expect(clearedLinesIn(h.errors, p)).toEqual([latchClearedLine(p, record, answer.reason, true)])
    expectClearedState(h, p)
    // The retry's outcome stands: no retry at once after it.
    expect(retryAtOnceLinesOf(h, p)).toEqual([])
    await stopApprover(h, p)
  })
})

/** The finished-row retry's launches, with each answer that clears. */
const FINISHED_ROW_CLEARS = FINISHED_ROW_RETRY_ENTRIES.filter((entry) => LAUNCH_CALL_METHOD[entry.call] !== undefined).flatMap((entry) =>
  entry.answers!.cleared.map((answer) => [`get reading ${entry.name}, ${answer.name}`, entry, answer] as const),
)

describe('"not this launch\'s session": no post before its finished-row retry or when that retry relatches; one "its row finished and a relaunch was not refused" post when it clears (recovery harness; SRJ-505, SRJ-506, SRJ-1005)', () => {
  test.each(FINISHED_ROW_CLEARS)('%s', async (_name, entry, answer) => {
    const noRow = entry.reading.kind === RECHECK_READING_NO_ROW_VALUE.kind
    const state = noRow ? PENDING_ROW_MODEL_NO_ROW : (entry.reading as { state: string }).state
    const { h, p, model, record } = latchForRecheck(statusOnlyRow(), { state, ...(entry.hasSessionId ? {} : { row: { claude_session_id: '' } }) })
    scriptLaunchAnswer(model, entry.call, answer.answer())
    const watched = watchCalls(h, p)
    const from = h.timedCalls.length

    await h.advanceToRecheck()

    const verbs: string[] = personaCallsFrom(h, p, from).map((call) => call.verb)
    expect(verbs.slice(0, 3)).toEqual(['status', 'get', LAUNCH_CALL_METHOD[entry.call]!])
    expect([verbs.filter((verb) => LAUNCH_VERBS.has(verb)).length, verbs.includes('findMissing')]).toEqual([1, false])
    expect(watched.filter((call) => call.verb === 'get' || LAUNCH_VERBS.has(call.verb)).map((call) => [call.verb, call.posts, call.latched])).toEqual([
      ['get', 1, true],
      [LAUNCH_CALL_METHOD[entry.call]!, 1, true],
    ])
    expect(answer.reason).toEqual(LATCH_RECOVERY_REASON_RELAUNCH_NOT_REFUSED)
    expect(h.episodeNotices.slice(1)).toEqual([recoveryPost(p, record, answer.reason)])
    expectClearedState(h, p)
    expect(retryAtOnceLinesOf(h, p)).toEqual([])
    await stopApprover(h, p)
  })

  test('while the leftover runs, the finished-row resume relatches with "left over from an earlier life": one CONFLICT post and no recovery post; once it is gone, the next finished round\'s resume clears with one recovery post', async () => {
    const missing = finishedRowEntryFor('missing')
    const leftover = missing.answers!.relatches.find((relatch) => relatch.latchCase === LATCH_CASE_LEFTOVER)!
    const { h, p, model, record } = latchForRecheck(statusOnlyRow(), { state: LIVENESS_DEAD_ROW_MISSING, resumes: [leftover.answer()] })
    let round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status', 'get', 'resume'])
    const relatched = h.latch.record(p)!
    expect(relatched.latchCase).toBe(LATCH_CASE_LEFTOVER)
    expect(h.episodeNotices.map((notice) => notice.text).filter((text) => text.startsWith(CONFLICT_RECOVERY_HEAD) || text.startsWith(HOLD_RECOVERY_HEAD))).toEqual([])
    expect(h.episodeNotices).toHaveLength(2)
    // The resume latch on a row read missing: the next round retries the resume, which is not refused.
    model.setState(LIVENESS_DEAD_ROW_MISSING)
    round = await recheckRound(h, p)
    expect(round.verbs.slice(0, 2)).toEqual(['status', 'resume'])
    expect(h.episodeNotices.slice(2)).toEqual([recoveryPost(p, relatched, LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED)])
    expect(record.latchCase).toBe(LATCH_CASE_NOT_THIS_LAUNCH)
    await stopApprover(h, p)
  })

  test('a plain-spawn latch whose scan refusal wrote no row: a retry refused again posts nothing; one not refused clears with "a retry of the refused operation was not refused", with no find-missing before either', async () => {
    const { h, p, record } = latchForRecheck(scanLeftoverRow(), { state: PENDING_ROW_MODEL_NO_ROW, plainSpawns: [scanRefusal(scanLeftoverRow().build())] })
    let round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status', 'spawn'])
    expect([h.latch.record(p), h.episodeNotices.length]).toEqual([record, 1])
    round = await recheckRound(h, p)
    expect(round.verbs.slice(0, 2)).toEqual(['status', 'spawn'])
    expect(h.episodeNotices.slice(1)).toEqual([recoveryPost(p, record, LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED)])
    expect(personaCallsFrom(h, p, 0).map((call) => call.verb)).not.toContain('findMissing')
    expectClearedState(h, p)
    await stopApprover(h, p)
  })
})

/** Every probe of the case table that finds the condition cleared: a row, a reading whose call is the probe, and the answer. */
const CLEARED_PROBES = RECHECK_TABLE.filter((row) => !row.probeDropped).flatMap((row) =>
  row.recheck.entries
    .filter((entry) => entry.decision.call === RECHECK_CALL_PROBE)
    .flatMap((entry) => entry.answers!.probeFoundCleared.map((answer) => [`${row.name}, step 1 reading ${entry.name}, the probe answering ${answer.name}`, row, entry, answer] as const)),
)

describe('a probe that finds the condition cleared: one bypassing find-missing, then exactly one retry of the latched operation with P still latched; one recovery post only when that retry clears (recovery harness; SRJ-505, SRJ-506, SRJ-120; HO rev 28; hatch A3)', () => {
  test.each(CLEARED_PROBES)('%s', async (_name, row, entry, answer) => {
    const { h, p, model, record } = latchForRecheck(row)
    scriptRecheckReading(model, row.recheck.readVerb, entry)
    model.scriptReadPane(answer.answer())
    const watched = watchCalls(h, p)
    const from = h.timedCalls.length

    await h.advanceToRecheck()

    const retry = expectedClearedProbeRetry(record.refusedOperation, entry.reading, false)
    const verbs: string[] = personaCallsFrom(h, p, from).map((call) => call.verb)
    const first = retry === RECHECK_CALL_RESTART_DECISION ? 'status' : LAUNCH_CALL_METHOD[retry]!
    expect(verbs.slice(0, 4)).toEqual([row.recheck.readVerb, 'readPane', 'findMissing', first])
    // The find-missing and the retry are made with P still latched and only its latch post.
    expect(watched.slice(2, 4).map((call) => [call.verb, call.posts, call.latched])).toEqual([
      ['findMissing', 1, true],
      [first, 1, true],
    ])
    if (retry !== RECHECK_CALL_RESTART_DECISION) {
      expect([verbs.filter((verb) => verb === 'findMissing').length, verbs.filter((verb) => LAUNCH_VERBS.has(verb)).length]).toEqual([1, 1])
    }
    // The retry's outcome by step 1's reading: a run of the restart path's
    // decision over a row read `pending` defers to the pending row, which
    // clears nothing, so P stays latched with its one post; every other
    // retry (a launch, or a run over a row read waiting, ended or missing)
    // completes with no refusal and clears with one recovery post.
    const staysLatched = retry === RECHECK_CALL_RESTART_DECISION && pendingRowOfRecheckReading(entry.reading)?.state === AGENT_DIRECTOR_PENDING_STATE
    if (staysLatched) {
      expect([h.latch.record(p), h.episodeNotices.length, h.latchRecheck.isArmed(p)]).toEqual([record, 1, true])
    } else {
      expect(h.episodeNotices.slice(1)).toEqual([recoveryPost(p, record, LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED)])
      expectClearedState(h, p)
    }
    // A retry's clear keeps its outcome: no retry at once after it.
    expect(retryAtOnceLinesOf(h, p)).toEqual([])
    await stopApprover(h, p)
  })
})

/** A "this row's own id" reuse latch on a row recorded `ended`. */
const ownIdReuseRow = launchRow(REFUSED_OPERATION_REUSE_SPAWN, LATCH_CASE_OWN_ID)

/** Make every `find-missing` answer `err` from now on (the row model no longer answers it). */
function failFindMissing(h: RecoveryHarness, err: Error): void {
  h.script({ findMissingFn: () => err })
}

describe('the cleared probe\'s find-missing and single retry: a refused run holds the retry back, the latched answer goes on, a collision gives no information, and a "this row\'s own id" retry refused again drops the probe (recovery harness; SRJ-505, SRJ-506, SRJ-120; AC 8; E14 build)', () => {
  const REFUSALS: ReadonlyArray<readonly [string, () => Error, readonly OutageClass[]]> = [
    ['UNAVAILABLE (ErrTmuxUnresponsive)', () => errTmuxUnresponsive('find-missing'), []],
    ['UNAVAILABLE (ErrCallTimeout)', () => errCallTimeout('find-missing'), []],
    ['UNCLASSIFIED (ErrInternal)', () => errInternal(), []],
    ['CONFIG (ErrConfigMalformed)', () => errConfigMalformed(), ['ad-config-malformed']],
    ['ENVIRONMENT (ErrTmuxNotAvailable)', () => errTmuxNotAvailable(undefined, 'find-missing'), ['tmux-unavailable']],
  ]

  test.each(REFUSALS)('the find-missing after a cleared probe answering %s: no retry and no post in that round, P latched with its record and its timer armed, the outage its class raises; the next round probes again', async (_label, refusal, outages) => {
    const run = latchForRecheck(ownIdResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED, readPane: [RECHECK_GONE_ANSWER.answer(), RECHECK_GONE_ANSWER.answer()] })
    const { h, p } = run
    failFindMissing(h, refusal())
    let round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status', 'readPane', 'findMissing'])
    expectStillLatched(run, round.at)
    expect([...getOutageFlags(p)]).toEqual([...outages])
    expect([h.controller.isArmed(p), h.triggers.filter((trigger) => trigger.key === p), h.tmuxUnresponsive.holds(p)]).toEqual([false, [], false])
    round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status', 'readPane', 'findMissing'])
    expectStillLatched(run, round.at)
  })

  test('the run answers latched for P, latched before it (FIND_MISSING_LATCHED): the single retry still follows and, not refused, clears with one post', async () => {
    const { h, p, record } = latchForRecheck(ownIdResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED, readPane: [RECHECK_GONE_ANSWER.answer()] })
    const watched = watchCalls(h, p)
    const round = await recheckRound(h, p)
    expect(round.verbs.slice(0, 4)).toEqual(['status', 'readPane', 'findMissing', 'resume'])
    expect(watched.find((call) => call.verb === 'findMissing')?.latched).toBe(true)
    expect(h.episodeNotices.slice(1)).toEqual([recoveryPost(p, record, LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED)])
    await stopApprover(h, p)
  })

  test('the run failing with an answer that is no refusal (ErrSpawnNotFound) lets the single retry go ahead', async () => {
    const { h, p, record } = latchForRecheck(ownIdResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED, readPane: [RECHECK_GONE_ANSWER.answer()] })
    failFindMissing(h, errSpawnNotFound())
    const round = await recheckRound(h, p)
    expect(round.verbs.slice(0, 4)).toEqual(['status', 'readPane', 'findMissing', 'resume'])
    expect(h.episodeNotices.slice(1)).toEqual([recoveryPost(p, record, LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED)])
    await stopApprover(h, p)
  })

  test('the single retry (a reuse) answering ErrInstanceIdCollision gives no information: P stays latched with no post and no further call (no get-then-act), the next round probing again', async () => {
    const run = latchForRecheck(ownIdReuseRow(), { state: LIVENESS_DEAD_ROW_ENDED, readPane: [RECHECK_GONE_ANSWER.answer()], reuseSpawns: [errInstanceIdCollision()] })
    const { h, p } = run
    let round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status', 'readPane', 'findMissing', 'spawn'])
    expectStillLatched(run, round.at)
    expect(noInformationState(h, p)).toEqual(NO_INFORMATION_STATE)
    // Its one line (SRJ-1014), the launch it names left open.
    const collision = builtAround((what) => latchRecheckCollisionNoInformationLine(personaRefOf(h, p), what))
    expect(h.errors.filter((line) => collision.test(line))).toHaveLength(1)
    round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status', 'readPane'])
  })

  test.each([
    ['resume', ownIdResumeRow, 'resume', (model: PendingRowModel, err: Error) => model.scriptResumes(err)],
    ['reuse', ownIdReuseRow, 'spawn', (model: PendingRowModel, err: Error) => model.scriptReuseSpawns(err)],
  ] as const)('AC 8: a "this row\'s own id" %s whose single retry is refused again with that case drops the probe for the episode, with one line and no post; the next rounds retry it directly, only on a row read ended', async (_label, rowOf, verb, refuse) => {
    const row = rowOf()
    const run = latchForRecheck(row, { state: LIVENESS_DEAD_ROW_ENDED, readPane: [RECHECK_GONE_ANSWER.answer()] })
    const { h, p, model, record } = run
    refuse(model, row.build())
    let round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status', 'readPane', 'findMissing', verb])
    expect(h.latch.record(p)).toEqual({ ...record, probeDropped: true })
    expect(h.episodeNotices).toHaveLength(1)
    expect(h.errors.filter((line) => line === latchRecheckProbeDroppedLine(personaRefOf(h, p)))).toHaveLength(1)
    // The probe dropped: the latched operation itself, no read-pane and no find-missing; refused again, still no post.
    refuse(model, row.build())
    round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status', verb])
    expect(h.episodeNotices).toHaveLength(1)
    model.setState(AGENT_DIRECTOR_PENDING_STATE)
    round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status'])
    // Ended again: retried, not refused, it clears with one post.
    model.setState(LIVENESS_DEAD_ROW_ENDED)
    round = await recheckRound(h, p)
    expect(round.verbs.slice(0, 2)).toEqual(['status', verb])
    expect(h.episodeNotices.slice(1)).toEqual([recoveryPost(p, record, LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED)])
    await stopApprover(h, p)
  })

  test('a "this row\'s own id" retry refused with another case relatches with one post and drops no probe', async () => {
    const { h, p, model } = latchForRecheck(ownIdResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED, readPane: [RECHECK_GONE_ANSWER.answer()] })
    model.scriptResumes(anotherStoreResumeRow().build())
    await recheckRound(h, p)
    expect(h.latch.record(p)).toMatchObject({ latchCase: LATCH_CASE_ANOTHER_STORE, refusedOperation: REFUSED_OPERATION_RESUME })
    expect(h.latch.record(p)?.probeDropped).toBeUndefined()
    expect(h.episodeNotices).toHaveLength(2)
  })

  /**
   * The case table has no `resume` or reuse row with "the agent's pane was
   * not found" (agent-director gives that case at a pane verb, not a launch),
   * so that latch is set directly through the latch's `set`: the own-id
   * launch row's record (its operation, its `ended` row state and session)
   * with the pane-not-found case and no description.
   */
  const paneNotFoundOf = (ownId: ConflictCaseRow): RecheckLatchRow & { readonly name: string } => ({
    name: `${ownId.name}, as "the agent's pane was not found"`,
    latchOn: (latch, key) => {
      const { refusedOperation, rowState, sessionName } = ownId.record(key)
      return latch.set(key, { latchCase: LATCH_CASE_PANE_NOT_FOUND, refusedOperation, rowState, sessionName })
    },
  })
  const PENDING_GATED = (
    [
      ['resume', ownIdResumeRow, 'resume'],
      ['reuse', ownIdReuseRow, 'spawn'],
    ] as const
  ).flatMap(([label, ownId, verb]) => [
    [`a ${label} latched on "this row's own id"`, (): RecheckLatchRow => ownId(), verb] as const,
    [`a ${label} latched on "the agent's pane was not found"`, (): RecheckLatchRow => paneNotFoundOf(ownId()), verb] as const,
  ])

  test.each(PENDING_GATED)('HO rev 28, %s: while its row reads pending, no probe, no find-missing and no retry, round after round; once it reads ended, the probe, one find-missing and one retry, which clears with one post', async (_name, rowOf, verb) => {
    const run = latchForRecheck(rowOf(), { state: AGENT_DIRECTOR_PENDING_STATE, readPane: [RECHECK_GONE_ANSWER.answer()] })
    const { h, p, model, record } = run
    for (let n = 0; n < 3; n++) {
      const round = await recheckRound(h, p)
      expect(round.verbs).toEqual(['status'])
      expectStillLatched(run, round.at)
    }
    model.setState(LIVENESS_DEAD_ROW_ENDED)
    const round = await recheckRound(h, p)
    expect(round.verbs.slice(0, 4)).toEqual(['status', 'readPane', 'findMissing', verb])
    expect(round.verbs.filter((v) => v === 'findMissing' || LAUNCH_VERBS.has(v))).toEqual(['findMissing', verb])
    expect(h.episodeNotices.slice(1)).toEqual([recoveryPost(p, record, LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED)])
    await stopApprover(h, p)
  })
})

// Bug b.xkd (b.av2 SR-6.3; SRJ-505, SRJ-506): the restart cap wins over the
// re-check. At the cap a round still reads (step 1, the probe), so a reading
// can still clear the latch, but a probe that finds the condition cleared
// leads to no bypassing find-missing (which serves only the retry) and no
// single retry. The retry sites' launches and the run of the restart path's
// decision at the cap are tests/session-manager.test.ts's.
describe('bug b.xkd: at the restart cap a round still reads, so the latch can still clear, but a cleared probe gets no find-missing and no single retry until the cap resets (recovery harness, the re-check bound with the restart cap as main() binds it; b.av2 SR-6.3, SRJ-505, SRJ-506)', () => {
  /** The single retry a cleared probe of `row` on step 1's `entry` makes. */
  const retryOf = (row: RecheckTableRow, entry: RecheckEntry): LatchRecheckCall => expectedClearedProbeRetry(row.record(KEY).refusedOperation, entry.reading, false)
  // The cap is one gate whatever the row: one cleared probe per retry it
  // would make (the first of CLEARED_PROBES for each), each named in its line.
  const PER_RETRY = CLEARED_PROBES.filter(([, row, entry], index) => CLEARED_PROBES.findIndex(([, other, otherEntry]) => retryOf(other, otherEntry) === retryOf(row, entry)) === index).map(
    ([name, row, entry, answer]) => [retryOf(row, entry), name, row, entry, answer] as const,
  )

  test('the cleared probes below cover every single retry the case table\'s probes make: a resume, a reuse and a run of the restart path\'s decision', () => {
    expect(PER_RETRY.map(([retry]): string => retry).sort()).toEqual([RECHECK_CALL_RESUME, RECHECK_CALL_REUSE_SPAWN, RECHECK_CALL_RESTART_DECISION].sort())
  })

  test.each(PER_RETRY)('a cleared probe whose retry is %s (%s), P at the cap: step 1\'s read and the probe only, one cap line naming the retry, the round line no retry (at-cap), P latched with its one post', async (retry, _name, row, entry, answer) => {
    const run = latchForRecheck(row)
    const { h, p, model, record } = run
    putAtRestartCap(p)
    scriptRecheckReading(model, row.recheck.readVerb, entry)
    model.scriptReadPane(answer.answer())

    const round = await recheckRound(h, p)

    expect(round.verbs).toEqual([row.recheck.readVerb, 'readPane'])
    expect(recheckAtCapLinesOf(h, p)).toEqual([latchRecheckAtCapLine(personaRefOf(h, p), retry)])
    const lines = roundLinesOf(h, p)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toStartWith(roundLineHead(h, p, record.latchCase, entry.decision.step, `${RECHECK_CALL_PROBE}+${RECHECK_CALL_NONE}`))
    expect(lines[0]).toEndWith(`; no retry (${LATCH_RECHECK_AT_CAP})`)
    expectStillLatched(run, round.at)
    expect([h.stub.calls.spawnCalls, h.stub.calls.resumeCalls, getFailureCount(p)]).toEqual([[], [], RESTART_FAILURE_CAP])
  })

  test('the cap resets: the next cleared probe gets its find-missing and its single retry, which clears with one post', async () => {
    const run = latchForRecheck(ownIdResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED, readPane: [RECHECK_GONE_ANSWER.answer(), RECHECK_GONE_ANSWER.answer()] })
    const { h, p, record } = run
    putAtRestartCap(p)
    let round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status', 'readPane'])
    expectStillLatched(run, round.at)

    forgetFailures(p)
    round = await recheckRound(h, p)

    expect(round.verbs.slice(0, 4)).toEqual(['status', 'readPane', 'findMissing', 'resume'])
    expect(recheckAtCapLinesOf(h, p)).toHaveLength(1)
    expect(h.episodeNotices.slice(1)).toEqual([recoveryPost(p, record, LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED)])
    expectClearedState(h, p)
    await stopApprover(h, p)
  })

  test('a step-1 read that clears (its row reported in), P at the cap: the latch clears with its one recovery post and no cap line; the retry at once after the bypassing find-missing meets the restart path\'s own cap, answering capped with nothing launched', async () => {
    const { h, p, model, record } = latchForRecheck(anotherStoreResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED })
    putAtRestartCap(p)
    model.setState('waiting')

    const round = await recheckRound(h, p)

    expect(round.verbs).toEqual(['status', 'findMissing'])
    expect(h.episodeNotices.slice(1)).toEqual([recoveryPost(p, record, latchRecoveryReasonRowReads('waiting'))])
    expectClearedState(h, p)
    expect(recheckAtCapLinesOf(h, p)).toEqual([])
    expect(retryAtOnceLinesOf(h, p)).toEqual([latchClearRetryAnsweredLine(personaRefOf(h, p), RESTART_OUTCOME_CAPPED)])
    expect(h.errors.filter((line) => line === restartRetryCapSkippedLine(p))).toHaveLength(1)
    expect([h.stub.calls.spawnCalls, h.stub.calls.resumeCalls, getFailureCount(p)]).toEqual([[], [], RESTART_FAILURE_CAP])
  })
})

/**
 * P latched on "another agent-director store" at a `resume` of its row read
 * `ended`, which now reads `waiting` and carries the note (a `status` read
 * does not show it); the store-wide find-missing lists P's row in
 * `unverified_ids`, so its post-run `get` reads the row.
 */
function latchWithNote(removes: typeof PENDING_ROW_FIND_MISSING_REMOVES_NOTE | typeof PENDING_ROW_FIND_MISSING_REMOVES_NOTHING): LatchedRecheckRun {
  const h = makeRecheckHarness()
  const [p, q] = h.keys as [string, string]
  h.script({ findMissingFn: () => cannedFindMissing({ rows: { [personaInstanceId(p)]: 'unverified_ids' } }) })
  const model = makePendingRowModel(h, p, { sessionId: 'session-of-p', state: 'waiting', note: true, findMissingRemoves: removes })
  anotherStoreResumeRow().latchOn(h.latchSet, p)
  return { h, p, q, model, record: h.latch.record(p)! }
}

describe('after a clear by step 1: the bypassing find-missing comes before the next read; a note it removes does not relatch P, one still there relatches with one new post; a refused run makes no launch and leaves P to its retry timer (recovery harness; SRJ-506, SRJ-114, SRJ-120; E14 build)', () => {
  test('a note the run removes: the post-run get reads no note, P stays unlatched and is retried at once', async () => {
    const { h, p, model, record } = latchWithNote(PENDING_ROW_FIND_MISSING_REMOVES_NOTE)
    const round = await recheckRound(h, p)
    expect(round.verbs.slice(0, 3)).toEqual(['status', 'findMissing', 'get'])
    expect(model.note()).toBe(false)
    expect(h.episodeNotices.slice(1)).toEqual([recoveryPost(p, record, latchRecoveryReasonRowReads('waiting'))])
    expect(h.latch.isLatched(p)).toBe(false)
    expect(retryAtOnceLinesOf(h, p)).toHaveLength(1)
    await stopApprover(h, p)
  })

  test('a note still there after the run: P latches again on "conflicting labels" with one new post and no retry; its re-check timer is armed anew', async () => {
    const { h, p, record } = latchWithNote(PENDING_ROW_FIND_MISSING_REMOVES_NOTHING)
    const round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status', 'findMissing', 'get'])
    expect(h.latch.record(p)).toMatchObject({ latchCase: LATCH_CASE_CONFLICTING_LABELS })
    expect(h.episodeNotices.slice(1, 2)).toEqual([recoveryPost(p, record, latchRecoveryReasonRowReads('waiting'))])
    expect(h.episodeNotices).toHaveLength(3)
    expect(h.latchRecheck.isArmed(p)).toBe(true)
    expect(retryAtOnceLinesOf(h, p)).toEqual([])
    expect(h.errors.filter((line) => line === latchClearRelatchedAfterFindMissingLine(personaRefOf(h, p)))).toHaveLength(1)
  })

  test.each([
    ['its row gone', PENDING_ROW_MODEL_NO_ROW, LATCH_RECOVERY_REASON_ROW_GONE],
    ['its row reported in', 'waiting', latchRecoveryReasonRowReads('waiting')],
  ] as const)('a clear by step 1 (%s) whose find-missing answers UNAVAILABLE: one recovery post, no launch in that attempt, P unlatched and left to its retry timer', async (_label, state, reason) => {
    const { h, p, model, record } = latchForRecheck(anotherStoreResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED })
    model.setState(state)
    failFindMissing(h, errTmuxUnresponsive('find-missing'))
    const round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status', 'findMissing'])
    expect(h.episodeNotices.slice(1)).toEqual([recoveryPost(p, record, reason)])
    expectClearedState(h, p)
    expect([h.controller.isArmed(p), h.triggers.filter((trigger) => trigger.key === p)]).toEqual([true, [{ key: p, kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE }]])
    expect(h.errors.filter((line) => line === latchClearFindMissingRefusedLine(personaRefOf(h, p)))).toHaveLength(1)
    expect(retryAtOnceLinesOf(h, p)).toEqual([])
  })
})

describe('"conflicting labels" on a pending row: a read-pane answering GONE (or a pane) clears with one recovery post and, with session_restart_delay 0 and health_check_interval 0, the retry at once finds the row pending and arms P\'s retry timer, with no find-missing (recovery harness; SRJ-506, SRJ-409, SRJ-410)', () => {
  const pendingLabelsRow = lazyRow(
    (row) =>
      row.latchCase === LATCH_CASE_CONFLICTING_LABELS &&
      row.refusedOperation === REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY &&
      row.rowState.kind === LATCH_ROW_STATE_KIND_READ &&
      row.rowState.state === AGENT_DIRECTOR_PENDING_STATE,
  )

  test.each([
    ['GONE', RECHECK_GONE_ANSWER],
    ['a pane', RECHECK_PANE_ANSWER],
  ] as const)('the read-pane answering %s', async (_label, answer) => {
    const { h, p, record } = latchForRecheck(pendingLabelsRow(), { state: AGENT_DIRECTOR_PENDING_STATE, readPane: [answer.answer()] }, { sessionRestartDelay: 0, healthCheckInterval: 0 })
    const round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['get', 'readPane', 'status', 'get'])
    expect(h.episodeNotices.slice(1)).toEqual([recoveryPost(p, record, LATCH_RECOVERY_REASON_RETRY_NOT_REFUSED)])
    expectClearedState(h, p)
    expectPendingOnlyWatch(h, p)
    expect(retryAtOnceLinesOf(h, p)).toEqual([latchClearRetryAnsweredLine(personaRefOf(h, p), RESTART_OUTCOME_PENDING_DEFERRED)])
    // The pending-row rule waits the row out: still pending, nothing launched.
    expect([h.stub.calls.spawnCalls, h.stub.calls.resumeCalls]).toEqual([[], []])
  })
})

describe('the holds\' clears: ErrSpawnNotFound clears an unusable-name latch with one "Hold cleared" post and P comes up fresh; a launch-start latch clears on ErrSpawnNotFound, on ended or missing with exactly one bring-up retry, and on a hand-edited waiting row (recovery harness; SRJ-506, SRJ-512, SRJ-513; AC 77, AC 85, AC 86)', () => {
  test.each(UNUSABLE_NAME_CASE_ROWS.map((row) => [row.name, row] as const))('AC 77, AC 85, an unusable-name latch (%s), its row gone: one hold recovery post with "its agent-director row is gone", one find-missing, then the plain first spawn (no resume, no reuse)', async (_name, row) => {
    const { h, p, model } = latchForRecheck(row, { state: 'waiting' })
    model.setState(PENDING_ROW_MODEL_NO_ROW)
    const round = await recheckRound(h, p)
    expect(round.verbs.slice(0, 4)).toEqual(['status', 'findMissing', 'status', 'spawn'])
    expect(h.episodeNotices.slice(1)).toEqual([{ key: p, text: holdRecoveryText(LATCH_RECOVERY_REASON_ROW_GONE) }])
    expect([h.stub.calls.resumeCalls, h.stub.calls.spawnCalls.map((call) => call.reuse_finished)]).toEqual([[], [undefined]])
    expectClearedState(h, p)
    await stopApprover(h, p)
  })

  const LAUNCH_START_ROW = LAUNCH_START_CASE_ROWS[0]!
  test.each([
    ['ErrSpawnNotFound: the row gone', PENDING_ROW_MODEL_NO_ROW, LATCH_RECOVERY_REASON_ROW_GONE, ['status', 'findMissing', 'status', 'spawn']],
    ['ended', LIVENESS_DEAD_ROW_ENDED, latchRecoveryReasonRowReads(LIVENESS_DEAD_ROW_ENDED), ['status', 'status', 'spawn']],
    ['missing', LIVENESS_DEAD_ROW_MISSING, latchRecoveryReasonRowReads(LIVENESS_DEAD_ROW_MISSING), ['status', 'status', 'spawn']],
    ['waiting (edited by hand)', 'waiting', latchRecoveryReasonRowReads('waiting'), ['status', 'findMissing', 'status']],
  ] as const)('AC 86, a launch-start latch whose row reads %s: one hold recovery post with its reason, then its calls (no find-missing before the finished row\'s one bring-up retry)', async (_label, state, reason, verbs) => {
    const { h, p, model } = latchForRecheck(LAUNCH_START_ROW, { launchStartedAt: SAMPLE_LAUNCH_START_NONE })
    model.setState(state)
    const round = await recheckRound(h, p)
    expect(round.verbs.slice(0, verbs.length)).toEqual([...verbs])
    expect(round.verbs.filter((verb) => LAUNCH_VERBS.has(verb)).length).toBe((verbs as readonly string[]).includes('spawn') ? 1 : 0)
    expect(h.episodeNotices.slice(1)).toEqual([{ key: p, text: holdRecoveryText(reason) }])
    expectClearedState(h, p)
    await stopApprover(h, p)
  })
})

describe('E18: after a clear, three escalate-dead runs begin a new slow-recovery episode and post once (recovery harness; SRJ-610, SRJ-1016, SRJ-506)', () => {
  test('P\'s slow-recovery episode ended at its latch; once the latch clears, three escalate-dead runs whose re-probe reads the row live post the slow-recovery notice once more', async () => {
    const h = makeRecoveryHarness()
    harnesses.push(h)
    const [p] = h.keys as [string]
    const run = () => runRestartRetry(p, personaOf(h, p).working_directory, isLaunchInFlight)
    h.script({ statusResult: cannedStatusResult({ state: 'working' }), readPaneError: errTmuxCaptureFailed() })
    for (let tick = 0; tick < SLOW_RECOVERY_POST_THRESHOLD; tick++) expect(await run()).toBe(RESTART_OUTCOME_RECONNECT_DEFERRED)
    const workingRowConflict = livenessPaneConflictRowsAt('working-row verdict')[0]!
    h.script({ readPaneError: workingRowConflict.build() })
    await run()
    await h.settle()
    const record = h.latch.record(p)!
    expect([h.slowRecovery.count(p), h.slowRecovery.isOpen(p)]).toEqual([0, false])

    expect(h.latchRecheck.clear(p, LATCH_RECOVERY_REASON_CLEARED_BY_HAND)).toBe(true)
    h.script({ readPaneError: errTmuxCaptureFailed() })
    for (let tick = 0; tick < SLOW_RECOVERY_POST_THRESHOLD; tick++) expect(await run()).toBe(RESTART_OUTCOME_RECONNECT_DEFERRED)
    await h.settle()

    expect([h.slowRecovery.count(p), h.slowRecovery.isOpen(p)]).toEqual([SLOW_RECOVERY_POST_THRESHOLD, true])
    expect(h.episodeNotices).toEqual([
      { key: p, text: slowRecoveryText(p) },
      { key: p, text: workingRowConflict.notice.text },
      recoveryPost(p, record, LATCH_RECOVERY_REASON_CLEARED_BY_HAND),
      { key: p, text: slowRecoveryText(p) },
    ])
  })
})

describe('the after-clear job runs in P\'s serializer turn right after the round: no other serialized work and no health-tick read of P between the clear and its find-missing, and P is held active until the job ends (recovery harness; SRJ-506)', () => {
  test('P\'s step-1 status is held while another operation for P is queued and a health tick runs at the find-missing: the queued operation runs only after the retry at once, and the tick reads nothing of P', async () => {
    const { h, p, model } = latchForRecheck(anotherStoreResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED })
    model.setState('waiting')
    const order: string[] = []
    const gate = Promise.withResolvers<void>()
    const reached = Promise.withResolvers<void>()
    const id = personaInstanceId(p)
    const status = h.stub.client.status.bind(h.stub.client)
    let held = true
    h.stub.client.status = async (params) => {
      if (params.claude_instance_id === id) {
        order.push('status')
        if (held) {
          held = false
          reached.resolve()
          await gate.promise
        }
      }
      return status(params)
    }
    const scheduled: string[] = []
    initHealthCheck({
      isSessionAlive: _buildIsSessionAliveAdapter(() => h.config),
      isSessionConnected: () => false,
      hasSessionStream: () => false,
      isRestartPendingOrActive,
      isLaunchInFlight,
      isLatched: (key) => h.latch.isLatched(key),
      isAtCap: (key) => isAtCap(key, RESTART_FAILURE_CAP),
      statRoute: async () => true,
      scheduleRestart: (key) => {
        scheduled.push(key)
      },
      isShuttingDown: () => false,
      getPersonas: () => ({ [p]: personaOf(h, p).working_directory }),
      endTmuxUnresponsive: () => {},
      onTickEnd: () => {},
      now: h.clock.now,
    })
    const tick = captureTimer('setInterval', () => startHealthCheck(1))
    const findMissing = h.stub.client.findMissing.bind(h.stub.client)
    h.stub.client.findMissing = async (params) => {
      order.push(`findMissing latched=${h.latch.isLatched(p)} active=${isRestartPendingOrActive(p)}`)
      await tick()
      order.push('tick done')
      return findMissing(params)
    }

    const advancing = h.advance(LATCH_RECHECK_INTERVAL_MS)
    await reached.promise
    expect(order).toEqual(['status'])
    const other = h.serializer.run(p, () => {
      order.push(`other active=${isRestartPendingOrActive(p)}`)
    })
    gate.resolve()
    await advancing
    await other
    await h.settle()
    stopHealthCheck()

    expect(order.slice(0, 3)).toEqual(['status', 'findMissing latched=false active=true', 'tick done'])
    expect(order.at(-1)).toBe('other active=false')
    expect(order.slice(3, -1).every((entry) => entry === 'status')).toBe(true)
    expect(order.slice(3, -1).length).toBeGreaterThan(0)
    expect([scheduled, retryAtOnceLinesOf(h, p).length, isRestartPendingOrActive(p)]).toEqual([[], 1, false])
    await stopApprover(h, p)
  })

  test('P latched again between the round\'s clear and the run it owes: the run calls nothing for P and logs one "latched again" line, and the new latch stays with its one post and its re-check timer', async () => {
    const { h, p, q, model, record } = latchForRecheck(anotherStoreResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED })
    // Step 1 reads the row reported in: a step-1 clear, its run owed to the round.
    model.setState('waiting')
    const reason = latchRecoveryReasonRowReads('waiting')
    const clearedLine = latchClearedLine(p, record, reason, true)
    const relatched: { outcome: unknown; record: ConflictLatchRecord | undefined }[] = []
    // The clear's last step is its cleared line, after which the round hands
    // its run on: relatch P there, once, so the latch is set before the run.
    const logTo = console.error
    console.error = (...args: unknown[]) => {
      logTo(...args)
      if (relatched.length === 0 && args[0] === clearedLine) {
        const outcome = scanLeftoverRow().latchOn(h.latchSet, p)
        relatched.push({ outcome, record: h.latch.record(p) })
      }
    }
    let round: RecheckRoundRun
    try {
      round = await recheckRound(h, p)
    } finally {
      console.error = logTo
    }
    await h.settle()

    expect(relatched.map((entry) => [entry.outcome, entry.record?.latchCase])).toEqual([[CONFLICT_LATCH_SET_LATCHED, LATCH_CASE_LEFTOVER]])
    // Step 1's read only: no find-missing, no retry at once.
    expect(round.verbs).toEqual(['status'])
    expect(retryAtOnceLinesOf(h, p)).toEqual([])
    expect(h.errors.filter((line) => line === latchClearRelatchedBeforeRunLine(personaRefOf(h, p)))).toHaveLength(1)
    // The cleared latch's one recovery post, then the new latch's one post; the new latch kept, its timer armed.
    expect(clearedLinesIn(h.errors, p)).toEqual([clearedLine])
    expect(h.episodeNotices.slice(1)).toEqual([recoveryPost(p, record, reason), { key: p, text: scanLeftoverRow().notice.text }])
    expect([h.latch.record(p), h.latchRecheck.isArmed(p), isRestartPendingOrActive(p)]).toEqual([relatched[0]!.record, true, false])
    expect([h.latch.isLatched(q), personaCallCounts(h, q)]).toEqual([false, {}])
  })
})

describe('the exported after-clear sequence (runLatchClearSequence) and the builder\'s clear entries (buildLatchRecheck\'s clear and clearAndRecover), as a clear by hand uses them (recovery harness; SRJ-506, SRJ-120)', () => {
  /** The sequence's dependencies over the harness: the builder's clear entry, the live configuration and P's serializer. */
  function sequenceDeps(h: RecoveryHarness, overrides: Partial<LatchClearSequenceDeps> = {}): LatchClearSequenceDeps & { readonly submitted: string[] } {
    const submitted: string[] = []
    return {
      clear: h.latchRecheck.clear,
      appliedConfig: () => h.config,
      serialize: (key, operation) => {
        submitted.push(key)
        return h.serializer.run(key, operation)
      },
      log: (line) => console.error(line),
      ...overrides,
      submitted,
    }
  }

  test('for an unlatched P: one submission whose clear answers false, and nothing else: not-latched, no post, no call, no hold', async () => {
    const h = makeRecheckHarness()
    const [p] = h.keys as [string]
    const deps = sequenceDeps(h)
    const calls = h.timedCalls.length
    const answer = runLatchClearSequence(p, LATCH_RECOVERY_REASON_CLEARED_BY_HAND, deps)
    expect(await answer.cleared).toBe(false)
    expect(await answer.done).toEqual({ kind: LATCH_CLEAR_SEQUENCE_NOT_LATCHED })
    expect([deps.submitted, h.episodeNotices, h.timedCalls.length - calls, isRestartPendingOrActive(p)]).toEqual([[p], [], 0, false])
    expect(clearedLinesIn(h.errors, p)).toEqual([])
  })

  test('called directly for a latched P: the clear is made in the submitted job (nothing cleared when it returns; then one post with the given reason, the timer stopped), and the job runs one find-missing before the next read of P\'s row and retries P at once', async () => {
    const { h, p, record } = latchForRecheck(anotherStoreResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED })
    const deps = sequenceDeps(h)
    const from = h.timedCalls.length
    const answer = runLatchClearSequence(p, LATCH_RECOVERY_REASON_CLEARED_BY_HAND, deps)
    // Submitted, and nothing cleared before the job's turn: P latched with its one post, its timer armed.
    expect([deps.submitted, h.latch.record(p), h.episodeNotices.length, h.latchRecheck.isArmed(p)]).toEqual([[p], record, 1, true])
    expect(await answer.cleared).toBe(true)
    expect(h.episodeNotices.slice(1)).toEqual([recoveryPost(p, record, LATCH_RECOVERY_REASON_CLEARED_BY_HAND)])
    expectClearedState(h, p)
    expect(await answer.done).toEqual({ kind: LATCH_CLEAR_SEQUENCE_RETRIED, outcome: RESTART_OUTCOME_LAUNCHED })
    await h.settle()
    const verbs: string[] = personaCallsFrom(h, p, from).map((call) => call.verb)
    expect(verbs.slice(0, 2)).toEqual(['findMissing', 'status'])
    expect([deps.submitted, h.episodeNotices.length, isRestartPendingOrActive(p)]).toEqual([[p], 2, false])
    expect(clearedLinesIn(h.errors, p)).toEqual([latchClearedLine(p, record, LATCH_RECOVERY_REASON_CLEARED_BY_HAND, true)])
    await stopApprover(h, p)
  })

  test('the builder\'s clearAndRecover is the same sequence over its clear entry, with its find-missing first', async () => {
    const { h, p, record } = latchForRecheck(anotherStoreResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED })
    const from = h.timedCalls.length
    const answer = h.latchRecheck.clearAndRecover(p, LATCH_RECOVERY_REASON_CLEARED_BY_HAND)
    expect(await answer.cleared).toBe(true)
    expect(await answer.done).toEqual({ kind: LATCH_CLEAR_SEQUENCE_RETRIED, outcome: RESTART_OUTCOME_LAUNCHED })
    await h.settle()
    expect(personaCallsFrom(h, p, from).map((call) => call.verb).slice(0, 2)).toEqual(['findMissing', 'status'])
    expect(h.episodeNotices.slice(1)).toEqual([recoveryPost(p, record, LATCH_RECOVERY_REASON_CLEARED_BY_HAND)])
    await stopApprover(h, p)
  })

  test('the builder\'s clear alone posts once, stops the timer and calls nothing; a second clear does nothing', () => {
    const { h, p, record } = latchForRecheck(anotherStoreResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED })
    const calls = h.timedCalls.length
    expect(h.latchRecheck.clear(p, LATCH_RECOVERY_REASON_ROW_GONE)).toBe(true)
    expect(h.latchRecheck.clear(p, LATCH_RECOVERY_REASON_ROW_GONE)).toBe(false)
    expectClearedState(h, p)
    expect([h.episodeNotices.slice(1), h.timedCalls.length - calls, isRestartPendingOrActive(p)]).toEqual([[recoveryPost(p, record, LATCH_RECOVERY_REASON_ROW_GONE)], 0, false])
  })

  test('with findMissingFirst false the job makes no find-missing before the retry at once', async () => {
    const { h, p } = latchForRecheck(anotherStoreResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED })
    const from = h.timedCalls.length
    expect(await runLatchClearSequence(p, LATCH_RECOVERY_REASON_CLEARED_BY_HAND, sequenceDeps(h), { findMissingFirst: false }).done).toEqual({
      kind: LATCH_CLEAR_SEQUENCE_RETRIED,
      outcome: RESTART_OUTCOME_LAUNCHED,
    })
    await h.settle()
    expect(personaCallsFrom(h, p, from).map((call) => call.verb)).not.toContain('findMissing')
    await stopApprover(h, p)
  })

  // The sequence's three failure lines, from their builders; `persona=<key>`
  // is the session manager's key-only reference (not exported).
  /** The after-clear sequence's lines: their head is its builders' (`latchClearNotAppliedLine`'s, up to the persona reference). */
  const [latchClearHead] = lineParts((hole) => latchClearNotAppliedLine(hole))
  const latchClearLinesIn = (h: RecoveryHarness): string[] => h.errors.filter((line) => line.startsWith(latchClearHead))
  const notRunInTurnLine = (key: string, thrown: unknown): string => latchClearNotRunInTurnLine(`persona=${key}`, describeThrownValue(thrown))
  const clearFailedLine = (key: string, thrown: unknown): string => latchClearClearFailedLine(`persona=${key}`, describeThrownValue(thrown))
  const runFailedLine = (key: string, thrown: unknown): string => latchClearRunFailedLine(`persona=${key}`, describeThrownValue(thrown))

  const SUBMISSION_ERROR = new Error('serializer closed')
  test.each([
    ['rejects', (): Promise<never> => Promise.reject(SUBMISSION_ERROR)],
    ['throws', (): never => {
      throw SUBMISSION_ERROR
    }],
  ] as const)('a submission that %s: cleared rejects with its error, the run answers retry-failed with the one "could not be run in its serializer turn" line, and nothing is cleared or posted (P latched with its record, its timer armed, no hold)', async (_label, serialize) => {
    const { h, p, record } = latchForRecheck(anotherStoreResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED })
    const from = h.timedCalls.length
    const deps = sequenceDeps(h, { serialize: serialize as LatchClearSequenceDeps['serialize'] })
    const answer = runLatchClearSequence(p, LATCH_RECOVERY_REASON_CLEARED_BY_HAND, deps)
    await expect(answer.cleared).rejects.toBe(SUBMISSION_ERROR)
    expect(await answer.done).toEqual({ kind: LATCH_CLEAR_SEQUENCE_RETRY_FAILED })
    expect(latchClearLinesIn(h)).toEqual([notRunInTurnLine(p, SUBMISSION_ERROR)])
    expect([isRestartPendingOrActive(p), h.latch.record(p), h.latchRecheck.isArmed(p), h.timedCalls.length - from]).toEqual([false, record, true, 0])
    expect([h.episodeNotices.length, clearedLinesIn(h.errors, p)]).toEqual([1, []])
  })

  test('a clear that throws in the job\'s turn: cleared rejects with its error, the run answers retry-failed with the one "clear … failed — nothing runs after it" line, and nothing follows (no hold, no call, no post)', async () => {
    const { h, p, record } = latchForRecheck(anotherStoreResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED })
    const from = h.timedCalls.length
    const clearError = new Error('clear failed')
    const deps = sequenceDeps(h, {
      clear: () => {
        throw clearError
      },
    })
    const answer = runLatchClearSequence(p, LATCH_RECOVERY_REASON_CLEARED_BY_HAND, deps)
    await expect(answer.cleared).rejects.toBe(clearError)
    expect(await answer.done).toEqual({ kind: LATCH_CLEAR_SEQUENCE_RETRY_FAILED })
    expect(latchClearLinesIn(h)).toEqual([clearFailedLine(p, clearError)])
    expect([deps.submitted, isRestartPendingOrActive(p), h.latch.record(p), h.timedCalls.length - from, h.episodeNotices.length]).toEqual([[p], false, record, 0, 1])
  })

  test('a run that throws after the clear answered: cleared stays true, the run answers retry-failed with the one "run after … failed" line, and P\'s active hold is released exactly once', async () => {
    const { h, p, record } = latchForRecheck(anotherStoreResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED })
    const from = h.timedCalls.length
    const nameError = new Error('name unreadable')
    // P as applied, its name unreadable: the run's persona reference throws after the clear.
    const unnamed = Object.defineProperty({ ...personaOf(h, p) }, 'name', {
      get: () => {
        throw nameError
      },
    })
    const deps = sequenceDeps(h, { appliedConfig: () => ({ ...h.config, personas: h.config.personas.map((persona) => (persona.key === p ? unnamed : persona)) }) })
    // An outside hold on P: a second release of the run's hold would end it.
    const outside = holdRestartActive(p)
    try {
      const answer = runLatchClearSequence(p, LATCH_RECOVERY_REASON_CLEARED_BY_HAND, deps)
      expect(await answer.cleared).toBe(true)
      expect(await answer.done).toEqual({ kind: LATCH_CLEAR_SEQUENCE_RETRY_FAILED })
      expect(latchClearLinesIn(h)).toEqual([runFailedLine(p, nameError)])
      expect(h.episodeNotices.slice(1)).toEqual([recoveryPost(p, record, LATCH_RECOVERY_REASON_CLEARED_BY_HAND)])
      expectClearedState(h, p)
      expect([h.timedCalls.length - from, isRestartPendingOrActive(p)]).toEqual([0, true])
    } finally {
      outside()
    }
    expect(isRestartPendingOrActive(p)).toBe(false)
  })

  test('a retry at once that throws answers retry-failed with one line, after the find-missing; P\'s hold is released', async () => {
    const { h, p } = latchForRecheck(anotherStoreResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED })
    const retryError = new Error('retry failed')
    const deps = sequenceDeps(h, {
      retryAtOnce: async () => {
        throw retryError
      },
    })
    expect(await runLatchClearSequence(p, LATCH_RECOVERY_REASON_CLEARED_BY_HAND, deps).done).toEqual({ kind: LATCH_CLEAR_SEQUENCE_RETRY_FAILED })
    expect(retryAtOnceLinesOf(h, p)).toEqual([latchClearRetryFailedLine(personaRefOf(h, p), describeThrownValue(retryError))])
    expect([h.callTimes('findMissing').length, isRestartPendingOrActive(p)]).toEqual([1, false])
  })

  test('P removed from the applied configuration before its job: cleared, then not-applied with one line and no call', async () => {
    const { h, p } = latchForRecheck(anotherStoreResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED })
    const from = h.timedCalls.length
    const deps = sequenceDeps(h, { appliedConfig: () => ({ ...h.config, personas: h.config.personas.filter((persona) => persona.key !== p) }) })
    const answer = runLatchClearSequence(p, LATCH_RECOVERY_REASON_CLEARED_BY_HAND, deps)
    expect(await answer.cleared).toBe(true)
    expect(await answer.done).toEqual({ kind: LATCH_CLEAR_SEQUENCE_NOT_APPLIED })
    expect([h.latch.isLatched(p), h.timedCalls.length - from, isRestartPendingOrActive(p)]).toEqual([false, 0, false])
    expect(h.errors.filter((line) => line === latchClearNotAppliedLine(`persona=${p}`))).toHaveLength(1)
  })

  test('P latched again before its job runs: the job\'s clear clears that new latch with its own one recovery post, then its find-missing and the retry at once', async () => {
    const { h, p } = latchForRecheck(anotherStoreResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED })
    const from = h.timedCalls.length
    const relatched: ConflictLatchRecord[] = []
    const deps = sequenceDeps(h, {
      serialize: (key, operation) => {
        expect(scanLeftoverRow().latchOn(h.latchSet, key)).toBe(CONFLICT_LATCH_SET_RELATCHED)
        relatched.push(h.latch.record(key)!)
        return h.serializer.run(key, operation)
      },
    })
    const answer = runLatchClearSequence(p, LATCH_RECOVERY_REASON_CLEARED_BY_HAND, deps)
    expect(await answer.cleared).toBe(true)
    expect(await answer.done).toEqual({ kind: LATCH_CLEAR_SEQUENCE_RETRIED, outcome: RESTART_OUTCOME_LAUNCHED })
    await h.settle()
    const record = relatched[0]!
    expect(record.latchCase).toBe(LATCH_CASE_LEFTOVER)
    // The latch's post, the relatch's post, then the one recovery post for the latch the job found.
    expect(h.episodeNotices).toHaveLength(3)
    expect(h.episodeNotices.slice(2)).toEqual([recoveryPost(p, record, LATCH_RECOVERY_REASON_CLEARED_BY_HAND)])
    expect(clearedLinesIn(h.errors, p)).toEqual([latchClearedLine(p, record, LATCH_RECOVERY_REASON_CLEARED_BY_HAND, true)])
    expectClearedState(h, p)
    expect(personaCallsFrom(h, p, from).map((call) => call.verb).slice(0, 2)).toEqual(['findMissing', 'status'])
    expect(h.errors.filter((line) => line === latchClearRelatchedBeforeRunLine(personaRefOf(h, p)))).toEqual([])
    await stopApprover(h, p)
  })

  test('its find-missing refused (UNAVAILABLE): find-missing-refused, no launch, P\'s retry timer armed', async () => {
    const { h, p } = latchForRecheck(anotherStoreResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED })
    failFindMissing(h, errTmuxUnresponsive('find-missing'))
    const answer = runLatchClearSequence(p, LATCH_RECOVERY_REASON_CLEARED_BY_HAND, sequenceDeps(h))
    expect(await answer.cleared).toBe(true)
    expect(await answer.done).toEqual({ kind: LATCH_CLEAR_SEQUENCE_FIND_MISSING_REFUSED })
    expect([h.stub.calls.spawnCalls, h.stub.calls.resumeCalls, h.controller.isArmed(p)]).toEqual([[], [], true])
  })
})

// ---------------------------------------------------------------------------
// The clear by hand (E31 T1; b.jg5 SRJ-510, SRJ-506's clear-latch leg,
// SRJ-509's server-side bullets, SRJ-1005, SRJ-120): the `/clear-latch`
// route's clear, `clearByHandOf` over the re-check as `main()` binds it (the
// harness's `latchRecheck.clearByHand`), driven through the real handler
// where the route's answer matters.
// ---------------------------------------------------------------------------

/** A `POST /clear-latch` for one persona, made through the real handler over the harness's clear by hand. */
interface ClearLatchRequest {
  /** Settles once the handler has handed the clear to the clear by hand. */
  readonly submitted: Promise<void>
  /** The route's answer. */
  readonly response: Promise<Response>
  /** How many notices had been posted when the route answered; undefined while it has not. */
  postsWhenAnswered(): number | undefined
}

/**
 * Send `POST /clear-latch` naming persona `key` of `h` from loopback to the
 * real handler (`handleClearLatch`), whose clear is the harness's clear by
 * hand (`clearByHandOf` over its re-check, the binding `main()` routes), its
 * lines to `console.error` (so to `errors`). `signal` is the request's.
 */
function requestClearLatch(h: RecoveryHarness, key: string, signal?: AbortSignal): ClearLatchRequest {
  const submitted = Promise.withResolvers<void>()
  let posts: number | undefined
  const req = new Request(`http://127.0.0.1${CLEAR_LATCH_ROUTE}`, { method: 'POST', body: JSON.stringify({ persona: personaOf(h, key).name }), signal })
  const response = handleClearLatch(req, '127.0.0.1', {
    getPersonaConfig: () => h.config,
    clearByHand: (target) => {
      submitted.resolve()
      return h.latchRecheck.clearByHand(target)
    },
    log: (line) => console.error(line),
  }).then((answer) => {
    posts = h.episodeNotices.length
    return answer
  })
  return { submitted: submitted.promise, response, postsWhenAnswered: () => posts }
}

/** The route's 200 body for persona `key` of `h`. */
const clearLatchBody = (h: RecoveryHarness, key: string, cleared: boolean) => ({ ok: true, persona: personaOf(h, key).name, cleared })

/** Wait until P's clear-by-hand job (and anything else submitted for P before) has ended, then settle the launches it made. */
async function settleClearJob(h: RecoveryHarness, key: string): Promise<void> {
  await h.serializer.whenIdle(key)
  await h.settle()
}

/** Hold P's serializer turn open with an operation of the harness's serializer; `release` ends it. */
function holdTurn(h: RecoveryHarness, key: string): { readonly release: () => Promise<void> } {
  const turn = Promise.withResolvers<void>()
  const held = h.serializer.run(key, () => turn.promise)
  return {
    release: async () => {
      turn.resolve()
      await held
    },
  }
}

/**
 * One row of the case table per latch source and case: the first of each
 * (a clear by hand clears every latch alike, whatever its site; the
 * probe-dropped columns are the same latch).
 */
const CLEAR_BY_HAND_ROWS = RECHECK_TABLE.filter(
  (row, index, table) => !row.probeDropped && table.findIndex((other) => !other.probeDropped && other.source === row.source && other.latchCase === row.latchCase) === index,
).map((row) => [row.name, row] as const)

/** An "another agent-director store" latch at a plain spawn over P's row read `ended`: the launch the retry at once makes over such a row. */
const anotherStorePlainSpawnRow = launchRow(REFUSED_OPERATION_PLAIN_SPAWN, LATCH_CASE_ANOTHER_STORE)

describe('the clear by hand (clear-latch): in P\'s serializer turn, one "cleared by hand" post, one bypassing find-missing before P\'s next row read, P retried at once; the route answers once the clear has run (recovery harness; SRJ-510, SRJ-506, SRJ-509, SRJ-1005, SRJ-120)', () => {
  test('the rows cover every latch kind and case once: every CONFLICT case, unrecognised text included, the "conflicting labels" note latch, the unusable recorded name and the launch start not recorded', () => {
    expect(CLEAR_BY_HAND_ROWS.filter(([, row]) => row.record(KEY).latchCase !== row.latchCase).map(([name]) => name)).toEqual([])
    const cases = new Set(CLEAR_BY_HAND_ROWS.map(([, row]) => row.record(KEY).latchCase))
    expect(LATCH_CASES.filter((latchCase) => latchCase !== LATCH_CASE_NEVER_REPORTED_IN && !cases.has(latchCase))).toEqual([])
    expect(CLEAR_BY_HAND_ROWS.some(([name]) => name.startsWith('the provenance_conflict note '))).toBe(true)
    expect(new Set(CLEAR_BY_HAND_ROWS.map(([, row]) => `${row.source}|${row.latchCase}`)).size).toBe(CLEAR_BY_HAND_ROWS.length)
  })

  test.each(CLEAR_BY_HAND_ROWS)('%s: answers true once its job\'s clear has run, with one "cleared by hand" recovery post of its kind, its line, every latch episode ended and no re-check timer left; then one bypassing find-missing (held open: P unlatched and active, nothing read yet), P\'s next row read and the retry at once', async (_name, row) => {
    const { h, p, q, record } = latchForRecheck(row, { state: LIVENESS_DEAD_ROW_ENDED })
    const hold = holdFindMissing(h.stub.client)
    const watched = watchCalls(h, p)

    const cleared = h.latchRecheck.clearByHand(p)
    expect([h.latch.record(p), h.episodeNotices.length]).toEqual([record, 1])
    expect(await cleared).toBe(true)

    const post = recoveryPost(p, record, LATCH_RECOVERY_REASON_CLEARED_BY_HAND)
    expect(post.text.startsWith(latchKindOf(record.latchCase) === LATCH_KIND_HOLD ? HOLD_RECOVERY_HEAD : CONFLICT_RECOVERY_HEAD)).toBe(true)
    expect(h.episodeNotices.slice(1)).toEqual([post])
    expect(clearedLinesIn(h.errors, p)).toEqual([latchClearedLine(p, record, LATCH_RECOVERY_REASON_CLEARED_BY_HAND, true)])
    expectClearedState(h, p)
    await hold.entered()
    expect(watched.map((call) => [call.verb, call.posts, call.latched, call.active])).toEqual([['findMissing', 2, false, true]])

    hold.release(cannedFindMissing())
    await settleClearJob(h, p)
    expect(watched.map((call) => call.verb).slice(0, 2)).toEqual(['findMissing', 'status'])
    expect([watched.filter((call) => call.verb === 'findMissing').length, h.episodeNotices.length, retryAtOnceLinesOf(h, p).length]).toEqual([1, 2, 1])
    expect([h.latch.isLatched(q), personaCallCounts(h, q)]).toEqual([false, {}])
    await stopApprover(h, p)
  })

  test('order: the recovery post, then one bypassing find-missing (a new call inside the memo window an ordinary run just filled), then P\'s next row read, then its retry at once, all at the clear\'s clock time', async () => {
    const { h, p, q } = latchForRecheck(anotherStoreResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED })
    await sweepDeadTmuxChannel(q, ESCALATE_DEAD_WAITING_ROW_PANE_GONE)
    await sweepDeadTmuxChannel(q, ESCALATE_DEAD_WAITING_ROW_PANE_GONE)
    // The second ordinary run reused the memo: one call so far.
    expect(h.callTimes('findMissing')).toHaveLength(1)
    const watched = watchCalls(h, p)
    const from = h.timedCalls.length
    const at = h.clock.now()

    expect(await h.latchRecheck.clearByHand(p)).toBe(true)
    await settleClearJob(h, p)

    expect(h.callTimes('findMissing')).toHaveLength(2)
    expect(personaCallsFrom(h, p, from).slice(0, 3).map((call) => [call.verb, call.at])).toEqual([
      ['findMissing', at],
      ['status', at],
      ['spawn', at],
    ])
    expect(watched.slice(0, 3).map((call) => [call.verb, call.posts, call.latched])).toEqual([
      ['findMissing', 2, false],
      ['status', 2, false],
      ['spawn', 2, false],
    ])
    expect(retryAtOnceLinesOf(h, p)).toEqual([latchClearRetryAnsweredLine(personaRefOf(h, p), RESTART_OUTCOME_LAUNCHED)])
    await stopApprover(h, p)
  })

  test('in P\'s turn: with P\'s turn held by another operation, the route has not answered, nothing is posted and P is still latched; once the turn is released the clear runs, and only then the route answers 200 with cleared true', async () => {
    const { h, p, record } = latchForRecheck(anotherStoreResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED })
    const turn = holdTurn(h, p)
    const route = requestClearLatch(h, p)
    await route.submitted
    await h.clock.flush()
    expect([route.postsWhenAnswered(), h.latch.record(p), h.episodeNotices.length, h.latchRecheck.isArmed(p), clearedLinesIn(h.errors, p)]).toEqual([undefined, record, 1, true, []])

    await turn.release()
    const response = await route.response
    expect([response.status, await response.json()]).toEqual([200, clearLatchBody(h, p, true)])
    // The clear's post was made before the route answered.
    expect(route.postsWhenAnswered()).toBe(2)
    expect(h.episodeNotices.slice(1)).toEqual([recoveryPost(p, record, LATCH_RECOVERY_REASON_CLEARED_BY_HAND)])
    await settleClearJob(h, p)
    expect([h.callTimes('findMissing').length, retryAtOnceLinesOf(h, p).length]).toEqual([1, 1])
    await stopApprover(h, p)
  })

  test.each([
    ['the round clears P (its row reported in): the clear answers false, with no second post', 'waiting', false],
    ['the round leaves P latched (its row reads pending): the clear answers true with its one post', AGENT_DIRECTOR_PENDING_STATE, true],
  ] as const)('behind a running re-check round, a clear by hand waits for the round and the run it owes; %s', async (_label, state, expected) => {
    const { h, p, model, record } = latchForRecheck(anotherStoreResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED })
    model.setState(state)
    // Hold the round's step-1 status read of P's row.
    const gate = Promise.withResolvers<void>()
    const reached = Promise.withResolvers<void>()
    const id = personaInstanceId(p)
    const status = h.stub.client.status.bind(h.stub.client)
    let held = true
    h.stub.client.status = async (params) => {
      if (held && params.claude_instance_id === id) {
        held = false
        reached.resolve()
        await gate.promise
      }
      return status(params)
    }
    const advancing = h.advance(LATCH_RECHECK_INTERVAL_MS)
    await reached.promise
    /** When the clear answered: its answer, the posts made and the retries at once run by then. */
    const answered: Array<readonly [boolean, number, number]> = []
    const cleared = h.latchRecheck.clearByHand(p).then((value) => {
      answered.push([value, h.episodeNotices.length, retryAtOnceLinesOf(h, p).length])
      return value
    })
    await h.clock.flush()
    expect([answered, h.episodeNotices.length]).toEqual([[], 1])

    gate.resolve()
    await advancing
    expect(await cleared).toBe(expected)
    await settleClearJob(h, p)

    const reason = expected ? LATCH_RECOVERY_REASON_CLEARED_BY_HAND : latchRecoveryReasonRowReads('waiting')
    // The round's owed run (a step-1 clear's) had ended before the clear answered; one clear, one post, one find-missing, one retry at once.
    expect(answered).toEqual([[expected, 2, expected ? 0 : 1]])
    expect(h.episodeNotices.slice(1)).toEqual([recoveryPost(p, record, reason)])
    expect(clearedLinesIn(h.errors, p)).toEqual([latchClearedLine(p, record, reason, true)])
    expect([h.callTimes('findMissing').length, retryAtOnceLinesOf(h, p).length, h.latch.isLatched(p)]).toEqual([1, 1, false])
    await stopApprover(h, p)
  })

  test('the answer before the run: with the bypassing find-missing held open, the route has already answered 200 with cleared true; once it is released, P\'s row read and the retry at once follow in order', async () => {
    const { h, p } = latchForRecheck(anotherStoreResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED })
    const hold = holdFindMissing(h.stub.client)
    const watched = watchCalls(h, p)
    const route = requestClearLatch(h, p)
    await hold.entered()
    await h.clock.flush()
    expect([route.postsWhenAnswered(), hold.heldCount(), watched.map((call) => call.verb), isRestartPendingOrActive(p)]).toEqual([2, 1, ['findMissing'], true])
    const response = await route.response
    expect([response.status, await response.json()]).toEqual([200, clearLatchBody(h, p, true)])

    hold.release(cannedFindMissing())
    await settleClearJob(h, p)
    expect(watched.map((call) => call.verb).slice(0, 3)).toEqual(['findMissing', 'status', 'spawn'])
    expect([retryAtOnceLinesOf(h, p).length, isRestartPendingOrActive(p)]).toEqual([1, false])
    await stopApprover(h, p)
  })

  test.each([
    ['its request aborted once the clear was handed on', true],
    ['its answer never read', false],
  ] as const)('a caller that has gone (%s): the clear still runs once P\'s turn comes, with its one post, its find-missing and its retry at once', async (_label, abort) => {
    const { h, p, record } = latchForRecheck(anotherStoreResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED })
    const turn = holdTurn(h, p)
    const caller = new AbortController()
    const route = requestClearLatch(h, p, caller.signal)
    await route.submitted
    if (abort) caller.abort()

    await turn.release()
    await settleClearJob(h, p)
    expect(h.episodeNotices.slice(1)).toEqual([recoveryPost(p, record, LATCH_RECOVERY_REASON_CLEARED_BY_HAND)])
    expectClearedState(h, p)
    expect([h.callTimes('findMissing').length, retryAtOnceLinesOf(h, p).length]).toEqual([1, 1])
    await stopApprover(h, p)
  })

  test('a provenance_conflict note the bypassing run removes does not relatch P: the post-run get reads no note, one recovery post, and P retried at once', async () => {
    const { h, p, model, record } = latchWithNote(PENDING_ROW_FIND_MISSING_REMOVES_NOTE)
    const from = h.timedCalls.length
    expect(await h.latchRecheck.clearByHand(p)).toBe(true)
    await settleClearJob(h, p)
    expect(personaCallsFrom(h, p, from).map((call) => call.verb).slice(0, 3)).toEqual(['findMissing', 'get', 'status'])
    expect(model.note()).toBe(false)
    expect(h.episodeNotices.slice(1)).toEqual([recoveryPost(p, record, LATCH_RECOVERY_REASON_CLEARED_BY_HAND)])
    expect([h.latch.isLatched(p), retryAtOnceLinesOf(h, p).length]).toEqual([false, 1])
    await stopApprover(h, p)
  })

  test('a provenance_conflict note still there after the bypassing run relatches P on "conflicting labels" with one new post and no second recovery post; no retry, its re-check timer armed', async () => {
    const { h, p, record } = latchWithNote(PENDING_ROW_FIND_MISSING_REMOVES_NOTHING)
    const from = h.timedCalls.length
    expect(await h.latchRecheck.clearByHand(p)).toBe(true)
    await settleClearJob(h, p)
    expect(personaCallsFrom(h, p, from).map((call) => call.verb)).toEqual(['findMissing', 'get'])
    expect(h.latch.record(p)).toMatchObject({ latchCase: LATCH_CASE_CONFLICTING_LABELS })
    expect(h.episodeNotices).toHaveLength(3)
    expect(h.episodeNotices[1]).toEqual(recoveryPost(p, record, LATCH_RECOVERY_REASON_CLEARED_BY_HAND))
    expect([h.latchRecheck.isArmed(p), retryAtOnceLinesOf(h, p)]).toEqual([true, []])
    expect(h.errors.filter((line) => line === latchClearRelatchedAfterFindMissingLine(personaRefOf(h, p)))).toHaveLength(1)
  })

  test.each([
    [
      'a CONFLICT ("another agent-director store") whose retry\'s plain spawn is refused again with that case',
      (): RecheckLatchRow => anotherStorePlainSpawnRow(),
      (): PendingRowModelOptions => ({ state: LIVENESS_DEAD_ROW_ENDED, plainSpawns: [anotherStorePlainSpawnRow().build()] }),
    ],
    [
      'a "launch start not recorded" hold whose retry reads its row still pending with no launch start',
      (): RecheckLatchRow => LAUNCH_START_CASE_ROWS[0]!,
      (): PendingRowModelOptions => ({ launchStartedAt: SAMPLE_LAUNCH_START_NONE }),
    ],
  ] as const)('relatch by hand: %s latches again with one new post after its recovery post, and its re-check timer is armed', async (_label, rowOf, modelOptionsOf) => {
    const { h, p, record } = latchForRecheck(rowOf(), modelOptionsOf())
    const notice = h.episodeNotices[0]!
    expect(await h.latchRecheck.clearByHand(p)).toBe(true)
    await settleClearJob(h, p)
    expect(h.latch.record(p)?.latchCase).toBe(record.latchCase)
    expect(h.episodeNotices).toEqual([notice, recoveryPost(p, record, LATCH_RECOVERY_REASON_CLEARED_BY_HAND), notice])
    expect([h.latchRecheck.isArmed(p), h.latchRecheck.nextDueAt()]).toEqual([true, h.clock.now() + LATCH_RECHECK_INTERVAL_MS])
  })

  test('an unlatched P: cleared false, with no post, no find-missing, no retry, no call for P and no timer', async () => {
    const h = makeRecheckHarness()
    const [p] = h.keys as [string]
    const from = h.timedCalls.length
    expect(await h.latchRecheck.clearByHand(p)).toBe(false)
    await settleClearJob(h, p)
    expect([h.episodeNotices, h.timedCalls.length - from, retryAtOnceLinesOf(h, p), clearedLinesIn(h.errors, p), isRestartPendingOrActive(p), h.latchRecheck.pendingTimers()]).toEqual([
      [],
      0,
      [],
      [],
      false,
      0,
    ])
  })

  test('two concurrent clears by hand for one latched P: the first answers true and the second false; one post, one find-missing and one retry at once', async () => {
    const { h, p, record } = latchForRecheck(anotherStoreResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED })
    expect(await Promise.all([h.latchRecheck.clearByHand(p), h.latchRecheck.clearByHand(p)])).toEqual([true, false])
    await settleClearJob(h, p)
    expect(h.episodeNotices.slice(1)).toEqual([recoveryPost(p, record, LATCH_RECOVERY_REASON_CLEARED_BY_HAND)])
    expect([clearedLinesIn(h.errors, p).length, h.callTimes('findMissing').length, retryAtOnceLinesOf(h, p).length]).toEqual([1, 1, 1])
    await stopApprover(h, p)
  })

  test.each([
    ['not latched', false],
    ['latched', true],
  ] as const)('another persona Q beside P, %s, is untouched by P\'s clear by hand: its latch, posts, timer and calls as they were', async (_label, latchQ) => {
    const { h, p, q } = latchForRecheck(anotherStoreResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED })
    if (latchQ) statusOnlyRow().latchOn(h.latchSet, q)
    const qRecord = h.latch.record(q)
    expect(await h.latchRecheck.clearByHand(p)).toBe(true)
    await settleClearJob(h, p)
    expect(h.latch.isLatched(p)).toBe(false)
    expect([
      h.latch.record(q),
      h.episodeNotices.filter((notice) => notice.key === q).length,
      h.latchRecheck.isArmed(q),
      personaCallCounts(h, q),
      isRestartPendingOrActive(q),
      clearedLinesIn(h.errors, q),
    ]).toEqual([qRecord, latchQ ? 1 : 0, latchQ, {}, false, []])
    await stopApprover(h, p)
  })

  test.each([
    ['UNAVAILABLE (ErrTmuxUnresponsive)', () => errTmuxUnresponsive('find-missing'), []],
    ['CONFIG (ErrConfigMalformed)', () => errConfigMalformed(), ['ad-config-malformed']],
  ] as const)('a refused run (apply21): the bypassing find-missing answering %s; the clear still answers true with its one recovery post, makes no launch in that attempt and leaves P unlatched to its retry timer, armed, with the outage its class raises', async (_label, refusal, outages: readonly OutageClass[]) => {
    const { h, p, record } = latchForRecheck(anotherStoreResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED })
    failFindMissing(h, refusal())
    const from = h.timedCalls.length
    expect(await h.latchRecheck.clearByHand(p)).toBe(true)
    await settleClearJob(h, p)
    expect(personaCallsFrom(h, p, from).map((call) => call.verb)).toEqual(['findMissing'])
    expect(h.episodeNotices.slice(1)).toEqual([recoveryPost(p, record, LATCH_RECOVERY_REASON_CLEARED_BY_HAND)])
    expectClearedState(h, p)
    expect([h.controller.isArmed(p), [...getOutageFlags(p)]]).toEqual([true, [...outages]])
    expect(h.errors.filter((line) => line === latchClearFindMissingRefusedLine(personaRefOf(h, p)))).toHaveLength(1)
    expect(retryAtOnceLinesOf(h, p)).toEqual([])
  })

  // Bug b.xkd: the cap wins over the re-check, which no longer relaunches a
  // capped P, but not over a human: the clear by hand still releases it. It
  // leaves the cap's count alone, so the retry at once meets the restart
  // path's own cap.
  test('bug b.xkd: a P at the restart cap, after a round that made no launch, is still released by hand: 200 with cleared true, one "cleared by hand" post, no re-check timer left; its count is kept, so the retry at once after the bypassing find-missing answers capped, with the restart path\'s cap line and nothing launched', async () => {
    const run = latchForRecheck(anotherStoreResumeRow(), { state: LIVENESS_DEAD_ROW_ENDED })
    const { h, p, record } = run
    putAtRestartCap(p)
    const round = await recheckRound(h, p)
    expect(round.verbs).toEqual(['status'])
    expectStillLatched(run, round.at)
    const from = h.timedCalls.length

    const response = await requestClearLatch(h, p).response
    await settleClearJob(h, p)

    expect([response.status, await response.json()]).toEqual([200, clearLatchBody(h, p, true)])
    expect(h.episodeNotices.slice(1)).toEqual([recoveryPost(p, record, LATCH_RECOVERY_REASON_CLEARED_BY_HAND)])
    expectClearedState(h, p)
    expect(personaCallsFrom(h, p, from).map((call) => call.verb)).toEqual(['findMissing'])
    expect(retryAtOnceLinesOf(h, p)).toEqual([latchClearRetryAnsweredLine(personaRefOf(h, p), RESTART_OUTCOME_CAPPED)])
    expect(h.errors.filter((line) => line === restartRetryCapSkippedLine(p))).toHaveLength(1)
    expect([getFailureCount(p), h.capReached, h.stub.calls.spawnCalls, h.stub.calls.resumeCalls]).toEqual([RESTART_FAILURE_CAP, [], [], []])
  })
})

// ---------------------------------------------------------------------------
// The recovery harness with overlapping lifetimes (E30 T3; SRJ-1304): a case
// that builds a second harness before it cleans the first up, cleaned up in
// any order, leaves SLACK_STATE_DIR and console.error pointing at the newest
// harness still live, and at what was in effect before the first build once
// all are cleaned up, never at an earlier harness's removed directory or
// capture.
// ---------------------------------------------------------------------------

describe('the recovery harness: overlapping harnesses give SLACK_STATE_DIR and console.error up last in, first out, whatever order they are cleaned up in (SRJ-1304)', () => {
  test.each([
    ['two, cleaned up in creation order', 2, [0, 1]],
    ['two, cleaned up newest first', 2, [1, 0]],
    ['three, the middle one first', 3, [1, 0, 2]],
    ['three, the oldest, the newest, then the middle one', 3, [0, 2, 1]],
    ['three, newest first', 3, [2, 1, 0]],
  ] as const)('%s', (_label, count, order) => {
    const before = { stateDir: process.env['SLACK_STATE_DIR'], consoleError: console.error }
    const built: RecoveryHarness[] = []
    const live = new Set<number>()
    /** Where SLACK_STATE_DIR and console.error point now: the index of the harness whose they are, or 'before'. */
    const inEffect = (probe: string): { stateDir: number | 'before' | 'other'; consoleError: number | 'before' | 'other' } => {
      const dir = process.env['SLACK_STATE_DIR']
      const stateDir = dir === before.stateDir ? 'before' : built.findIndex((h) => h.stateDir === dir)
      let consoleError: number | 'before' | 'other' = 'other'
      if (console.error === before.consoleError) consoleError = 'before'
      else {
        console.error(probe)
        consoleError = built.findIndex((h) => h.errors.includes(probe))
      }
      return { stateDir: stateDir === -1 ? 'other' : stateDir, consoleError: consoleError === -1 ? 'other' : consoleError }
    }
    /** The newest harness still live, or 'before' when none is. */
    const newestLive = (): number | 'before' => (live.size === 0 ? 'before' : Math.max(...live))
    try {
      for (let n = 0; n < count; n++) {
        built.push(makeRecoveryHarness())
        live.add(n)
        expect([n, inEffect(`after build ${n}`)]).toEqual([n, { stateDir: n, consoleError: n }])
      }
      for (const index of order) {
        live.delete(index)
        built[index]!.cleanup()
        const expected = newestLive()
        expect([`after cleaning up ${index}`, inEffect(`after cleanup ${index}`)]).toEqual([`after cleaning up ${index}`, { stateDir: expected, consoleError: expected }])
      }
      expect([process.env['SLACK_STATE_DIR'], console.error === before.consoleError]).toEqual([before.stateDir, true])
    } finally {
      // A failed expectation leaves some live: clean them up newest first, which always restores.
      for (const index of [...live].sort((a, b) => b - a)) built[index]!.cleanup()
    }
  })
})
