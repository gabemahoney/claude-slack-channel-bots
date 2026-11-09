/** SR-8 image-side evidence and verdicts. Static imports are node: only. Importing
 * the pure verdicts does no I/O; every CLI command requires /etc/cscb-ci-image.
 * Package modules come from CSCB_PKG_DIR (the installed tarball by default).
 *
 * Common verdict arguments C: <scenario> <strict|open> <0|10000|100000> <1|2>.
 * Commands (all paths are caller-owned CI scratch paths):
 *   combinations
 *     No arguments. Prints sr8Combinations() in its declared order, one TSV line
 *     per combination: population, mode, recipients. No output header or verdict.
 *   envelope-times <ids-file> <frozen-stub-jsonl>
 *     Bulk extraction only (NO C arguments or verdict): one JSONL row per requested
 *     ID, in file order, exactly slack_envelope_times' envelope_id/push/acks shape.
 *     Preserves zero and duplicate ACKs, connection IDs, original/replay IDs, and
 *     repeated requested IDs. Read both inputs once; index the observation once.
 *     Freeze complete stub lines with _scenario_complete_jsonl before invoking.
 *     IDs are one nonempty ID per line; both files must end at complete lines.
 *     Missing/duplicate pushes, malformed input or missing monotonic fields fail
 *     nonzero with a fixed named reason and NO partial output. Never applies N1.
 *     Before-clear and final observations MUST be separate files and calls.
 *   config <mode> <population> <recipients> <root> <port> <compact-ms> [timings]
 *     Whole config; credentials root/<key>.env, work root/<key>. Pipe to write_config.
 *     Compact-ms is a test override, printed/validated by fmk-texts, never a limit.
 *     `timings` adds the server's diagnostic timing switch beside test_measurements;
 *     only test-44's burst case passes it, because its rows add server work.
 *   seed <config-path> <state-dir> <population>
 *     STOPPED server only, BEFORE its first start. If absent, creates the matching
 *     config.json.last-applied using initialSharedChannelState/serializeSharedChannelState.
 *     Uses seedPopulation with packed production memory/authority; never edits the seal.
 *     Population zero is usage error (64): no seed, no first start in that combination.
 *   plan <mode> <population> <recipients> <start-seconds>
 *     TSV: phase, channel, ts, root-or-dash, comma-separated mentioned persona keys.
 *     Build each event OUTSIDE the measured window using scenario.sh's
 *     slack_mention_event/slack_reply_event/slack_message_event (and its text/ID builders).
 *   bodies <label> <events-jsonl>
 *     Wraps already-built events in push bodies; constructs no Slack event. Append its
 *     output for each recipient to roots.batch.jsonl, replies.batch.jsonl, dropped.batch.jsonl.
 *   burst C <batch-dir> <stub-url> <stub-record> <state-dir> <evidence-dir> <wait-ms> [<measurement-file> <byte-mark>]
 *     Concurrent roots, wait for their exact envelope ACKs, then concurrent replies+drops.
 *     With held.batch.jsonl, the last two arguments are REQUIRED: submit held probes
 *     FIRST, wait for their ACKs and their own durable post-hold measurement (key/seq
 *     bound through sharedQueueSnapshot), then start roots/replies/drops. The script
 *     establishes their pending own-posts beforehand through the scenario helpers,
 *     keeping the outcomes unresolved. Runs without held probes keep their old order.
 *     Saves <key>.held-admission.jsonl as a validated union of every poll through
 *     sharedQueueSnapshot, retaining original holds and observed resolutions across
 *     compaction. Include that one archive as a prior shared_queue_snapshot input
 *     along with the caller's other pre-compaction observations.
 *     These probes count as acceptance/ACK/store samples too. No held probe is optional
 *     for a passing Post Hold verdict: zero observed holds is missing evidence.
 *     With probes.batch.jsonl (pending-post's prebuilt other/bot/none replies), those
 *     probes lead the second wave, after every root ACK, as phase probes. They are
 *     not burst samples: check ignores them and pending-post judges them.
 *     Writes burst.jsonl (key/phase/channel/ts/sender/envelope_id, no text) and
 *     compactions.jsonl. Labels MUST equal population persona keys. Bounded wait;
 *     failure still retains submitted identities. HTTP responses are not ACK evidence.
 *     With SR8_PROFILE_DIR set (only test-44's burst case runs burst with it), each wave's name is
 *     appended to <dir>/waves at its start and `end` after the last, as the
 *     phase-cpu readings are taken, for cpu-profile.ts's per-wave profile parts.
 *     Queue compaction proof: two existing queue journal dev:ino identities, both observed
 *     after the first push and before the final ACK. The observer reads the stub record
 *     AFTER stat too; a replacement first seen after completion cannot pass. Creation is
 *     not compaction. Thread Memory compactions are proved by check from the measurement
 *     file's thread-compaction entries, not by file identity (a skip changes no file).
 *   seal <first|measured> C <server-log> <log-byte-mark> <config-path>
 *     First: exactly one printer-built entry-missing report per seeded key. Measured:
 *     no changed-while-stopped OR THREAD_MEMORY_JOINS_LOST report, including any
 *     unseeded/foreign persona. Both markers come from the printer.
 *     Decision 25: no thread-memory-loaded record. Retained loaded field is always 0.
 *   check C <evidence-dir> <measurement-file> <measurement-byte-mark> <start-ms> <ready-ms> [<n2-required> <n2-file>]
 *     Script supplies times.jsonl, one slack_envelope_times output per burst envelope;
 *     <key>.queue.jsonl from shared_queue_snapshot (retain pre-compaction snapshots);
 *     <key>.before.jsonl and <key>.after.jsonl from shared_thread_joins, before the burst
 *     and AFTER a clean restart. Reader failures must fail the script, never become [].
 *     Joins: every seeded identity before the burst, and every pre-burst join and
 *     burst root after the restart (S ⊆ B, B ∪ N ⊆ A). Additional joins (the first
 *     start's seal-report notice's own post, say) are counted, never subtracted,
 *     and printed by count, source and channel (baseline_excess, excess_*).
 *     External start/ready timestamps MUST be from the same clock for the measured start.
 *     Required N2 count defaults to zero for stub-only bursts; test-32 passes >=20.
 *     With held probes, also emits post-hold-overlap and post-hold-overlap-ack:
 *     EVERY declared hold probe for EVERY required persona needs an ordinary store
 *     for that same persona strictly between that probe's
 *     post-hold admission and resolution on the SERVER measurement clock. N1 for
 *     every overlapping item uses its own envelope's STUB push/ACK times. No overlap
 *     or missing endpoints is missing; slow overlapping ACK is fail. Clocks never mix.
 *     Compaction (required at 100000 only), per recipient: the queue by compactions.jsonl's
 *     file identities as burst records them; Thread Memory by that persona's
 *     thread-compaction entries after the byte mark lying WHOLLY inside the burst's
 *     span on the SERVER clock: the first store's start (at_mono_ms - store_ms) to
 *     the last store's at_mono_ms, over the acceptance stores of the burst's own
 *     accepted items (key/seq bound through the queue snapshots). Each store follows
 *     its push and precedes its ACK, so the span lies inside push-to-final-ACK.
 *     Rewritten and skipped-identical entries both count as complete, and at least
 *     one must be rewritten: all skipped fails; none, an incomplete store set or a
 *     malformed entry alone is missing. Startup, bring-up and other entries outside
 *     the span never count. Entry times are never compared with any other clock.
 *   startup-load C <start-ms> <ready-ms>
 *     Standalone startup evidence for test-32; no burst files are needed. Population
 *     is per recipient: samples/joined report population * recipients, as check does.
 *     Decision 25: the script samples outside the packed server, immediately before
 *     launching the measured start and immediately after its readiness wait succeeds.
 *     Both times are milliseconds on the SAME external clock (e.g. Python
 *     time.monotonic_ns() / 1e6 in the same CI container); never mix process-relative
 *     performance.now() clocks, or include the first seed/seal start in this interval.
 *     Prints startup-load and summary; valid times have verdict=recorded, no bound.
 *     Omitted, empty, malformed or reversed times are missing and exit 1; supplied
 *     times must be finite nonnegative numbers. Raw arguments are never printed.
 *   n4 C <measurement-file> <measurement-byte-mark> <key> <queue-snapshot> <times-jsonl> <stub-record> <n2-file> <hung-ts> <hung-user> <delayed-ts> <delayed-user>
 *     n2-file holds transcript-receipts thread-latency output: recorded: sr8 n2-sample
 *     key=<persona> seq=<queue seq> name=<fallback|resolved> (other fields ignored).
 *     Fault lines must be users.info with the sample's sender/label and hang/delay.
 *     Queue samples are production Slack acceptances: source=slack, user=<sender>,
 *     key.chat_id=channel and key.ts=ts, then bound to the stub push's label/channel/ts.
 *     Never add an injected-input sender field to a Slack acceptance.
 *     N4 joins push identity from stub to f6 timing output by envelope_id, never clocks.
 *   windows C <ad-cscb-calls-tsv> <empty-windows-tsv> <active-windows-tsv>
 *     ad_cscb_calls' six columns, time in epoch seconds; every CSCB call counts
 *     conservatively (Decision 9), per instance, in EVERY half-open 10-second window.
 *     Empty windows: instance-id TAB start-seconds TAB end-seconds, at least one.
 *     Active windows: the same three columns, exactly one row per EXPECTED measured
 *     instance, declared from the measured phase's AD identities, never from calls.
 *     Capture start immediately before the phase's AD mark/sample admission loop,
 *     and end at the start of verified queue-empty observation, using the same host
 *     Unix epoch clock as the shim. Read calls from that mark through the empty end.
 *     Use separate files for each mode/phase; each expected instance needs at least
 *     one call inside its active window and a verified empty window outside it.
 *     Every call must belong to a declared active/empty window. Missing active
 *     coverage, foreign instances or out-of-phase calls are missing, not zero-cost
 *     success. Calls in a verified empty window fail. All intervals are half-open.
 *     bun "$E" windows "$TEST_NAME" "$mode" 100000 2 "$out/ad.tsv" "$out/empty.tsv" "$out/active.tsv"
 *   concurrent-overlap C <operations-tsv> <sample-intervals-tsv> <n2-file>
 *     Test-32's thread phase only; collect fresh files per mode/phase. TSV has no
 *     header. ALL endpoints are Unix epoch MILLISECONDS on the SAME CI host clock
 *     (Date.now/time.time_ns()/1e6), never stub/server performance.now/monotonic times.
 *     Operations: kind TAB operation-id TAB start-epoch-ms TAB end-epoch-ms.
 *     Kind is membership or write; ID is the actual membership event identity or
 *     write attempt ID (strict: the write's Slack event_id), unique within that
 *     kind. Prebuild payloads before timing. Membership endpoints bracket its push
 *     invocation through its own ACK wait. Open write endpoints bracket the actual
 *     tool-call invocation through its successful result; strict write endpoints
 *     bracket beta's own leave/rejoin push through its own ACK, which Slack gets
 *     only once the write is durable; both BEFORE expensive result validation.
 *     Capture inside the background worker, immediately around each operation,
 *     NOT around worker launch/join or both operations together. Require the
 *     existing ACK/write-result checks too. Recorded ends are poll-bounded
 *     supersets (ACK poll, request/poll round trip), so for membership and open
 *     write only the START is credited: admission <= start < delivery. That proves
 *     the operation was issued while the sample was in flight, not that the
 *     server's handling of it overlapped (the push/call latency is a known limit).
 *     A strict write is credited only when admission <= start AND end < delivery:
 *     its durable application lies between, so it happened inside the sample.
 *     Samples: persona-key TAB queue-seq TAB admission-epoch-ms TAB delivery-epoch-ms.
 *     Select exactly n2-file's measured key/seq set from real shared_queue_snapshot
 *     observations: admission=the Slack accepted record's received_at; delivery=
 *     max(at) of its completed delivered parts. Preserve pre-compaction records.
 *     The existing receipt audit/thread-latency must succeed and prove all parts
 *     complete; do not substitute a delivery poll's return or infer an endpoint.
 *     n2-file is that same phase's transcript-receipts thread-latency output.
 *     Both membership AND write need at least one operation credited inside at least
 *     one declared measured sample (they may use different samples). A start before
 *     admission (even with a later recorded end) or at/after delivery, a strict
 *     write ending at/after delivery (a slow start alone is not overlap), serial-only
 *     work, absent kinds, incomplete/mismatched samples, malformed or reversed
 *     endpoints are missing, exit 1. No scheduler-start assertion is proof.
 *     bun "$E" concurrent-overlap "$TEST_NAME" "$mode" 100000 2 "$out/operations.tsv" "$out/sample-intervals.tsv" "$out/n2.txt"
 *   conditions <state-dir> <server-pid> [<cpu-mark-file>]
 *     Bun, CPUs, cgroup memory limit, filesystem/mount, server VmHWM (KiB). With a
 *     cpu-mark file, also cgroup cpu_max and the nr_periods/nr_throttled/
 *     throttled_usec deltas since that mark (cpuConditionFields; unknown if unread).
 *   cpu-mark <new-file>
 *     Saves the cgroup cpu.stat counters (empty when unreadable) at a case's start.
 *   observe C <burst-dir> <measurement-file> <byte-mark> <phase-cpu-file>
 *     Test-44's latency observation, never a verdict: exits 0 and prints no summary.
 *     The phase-cpu file is what burst appends when SR8_PHASE_CPU_FILE names it
 *     (SR8_PHASE_CPU_PIDS=server=<pid>,stub=<pid>; the burst process is observer):
 *     one cgroup cpu.stat and /proc/<pid>/stat reading at each wave's start and at
 *     its end. Lines (verdict=recorded): observe-inputs; observe-cpu per wave
 *     (probe, roots, replies-drops); observe-ack per burst phase, both ACK clocks
 *     matched by key and Slack ts (stub push-to-ACK, the server's `acked` row's
 *     receive-to-ACK, and their gap), with suppressed and failed attempts counted
 *     and timed apart; observe-ack-bin, ten push-ordered runs per phase;
 *     observe-append per server phase and journal (group size, append and
 *     file/directory fsync times); observe-saves per server phase (stores, fixed
 *     appends, Thread Memory saves); then observe-ack-event, one line per burst
 *     event (persona, ordinal, push offset, each side's status and duration).
 *     Server phases come from the `acked` rows on the server clock; clocks of
 *     different processes never mix. The server writes `ack`, `append` and
 *     `thread-save` rows only under config's `timings` opt-in.
 *
 * Additional case commands for scripts 44/45 (check, n4 and startup-load keep
 * their outputs). TSV files contain observations/identities, never Slack/control
 * JSON. All JSONL readers below are existing scenario.sh readers; a failed reader
 * must stop the script. Do not replace failed reads with empty arrays/files.
 * Scope every log/stub slice to this case, preserving record seq and timestamps.
 * Each command prints recorded: sr8 <measure> with C, samples, stats, limit,
 * verdict, then summary, and exits 1 on ANY missing/fail after printing ALL lines.
 * Verdict lines never echo supplied text/IDs/errors; the fault identity/body readers
 * below explicitly return their documented data. Per-persona store numbers are 1-based
 * positions in sr8Personas(recipients), the same order as config/burst.
 *
 *   pending-post C <key> <operation-id> <start-ms> <end-ms> <before-posts> <after-posts> <probes-tsv> <queue> <times> <measurements> <byte-mark> <channel> <burst-dir> <start-seq> <end-seq> <compact-ms> <measured-start-ms> <window-end-ms>
 *     before/after: shared_own_post_records for the same key, with the same
 *     unresolved new-channel intent (no root). Take start AFTER the first read,
 *     end BEFORE the second, on one external monotonic clock. Keep the server
 *     running and the post unresolved throughout; no restart/compaction between
 *     reads. Hold/re-hold post/outcome lookup through the existing stub controls.
 *     Probes TSV: parent(other|bot|none), channel, ts, envelope_id. Build those
 *     replies with the corresponding parent_user_id using slack_reply_event;
 *     push them strictly between the two reads. All three classes are required.
 *     queue = shared_queue_snapshot; times = slack_envelope_times for EACH probe;
 *     measurements start at byte-mark, captured before probes. An other-parent
 *     probe may be dropped: require no Post Hold acceptance/store/resolution.
 *     Bot/no-parent need post-hold stores and their own timed resolution appends.
 *     Lines: pending-post(pending_ms,other,held; >=120000), pending-post-ack(max_ms;
 *     N1), post-hold(existing own-append limit/100 ms allowance). Missing intent,
 *     class, acceptance/hold evidence, reader or timestamp is missing; an outcome,
 *     wrong root, duration below 120 s or a held other-parent probe fails.
 *     SR-8.4 measures this case during an SR-8.2 burst (Decision 29 ruling): run
 *     burst between the reads with the probes as probes.batch.jsonl. burst-dir is
 *     its evidence dir, plus times.jsonl for every burst.jsonl envelope (probes
 *     too; pass it as times), final-stub.jsonl, <key>.queue.jsonl for EVERY
 *     population key, and before.journal/after.journal: the key's Thread Memory
 *     journal dev:ino, taken BEFORE the first read and AFTER the second.
 *     start-seq/end-seq: slack_post_mark after the first read and before the
 *     second. compact-ms: the queue_compact_interval_ms in effect, from the
 *     printer. measured-start-ms: check's start-ms; window-end-ms: after the
 *     second read, same clock. Also lines: check's ack-accepted/ack-dropped over
 *     the burst items (ack-dropped is missing without every key's queue), and
 *     pending-post-burst(compact_interval_ms,window_ms,probes_inside,
 *     burst_in_pending,same_journal; window below the interval). Only the
 *     Thread Memory journal's identity is proved, not the delivery queue's.
 *     Stub record order must show start-seq < first burst push, last burst ACK
 *     <= end-seq, and each ledger probe's push strictly inside the burst; else
 *     missing. A changed journal identity or window_ms >= compact-ms fails.
 *     Compaction is never required here: the interval is deliberately long.
 *
 *   shared-list C <directory> <probe-exit-status>
 *     prepared.input: exact config bytes, ordinary.preview: server's ordinary
 *     pending preview BEFORE confirmation (not a rebuilt expected preview).
 *     For applied/restarted/grown/reopened/failed, save <phase>.input (config
 *     bytes) and <phase>.facts.jsonl (one shared_persona_facts per configured key,
 *     NO channel filter). Names must be config's sr8Personas keys. growth.tsv:
 *     key,channel,delivery for every intended new membership, from printer values.
 *     Use live join events for growth/failure; failure.log is the scoped server
 *     log. failure.expected is the complete actionable line from the existing
 *     printer membershipDiagnostic <key> <failed-channel> event-not-durable;
 *     require that line, named by MEMBERSHIP_STORAGE_FAILED for a configured key.
 *     failure-before.state/failure-after.state: exact shared-record bytes around
 *     the failed growth, then successfully read failed.facts after restoring read
 *     permission. Probe exit is the ACTUAL attempted write status; zero fails.
 *     Keep the same separately prepared input throughout these observations.
 *     Lines: shared-list(config_bytes,preview_bytes,initial,grown; channels>=1000,
 *     bytes>65536); shared-list-write-failure(probe_failed,unchanged; preserved).
 *     Missing any phase, growth, readable state, preview or named failure is
 *     missing. Count/choice/input loss, truncation, equal-to-64KiB or a successful
 *     probe fails. Counts apply per persona; preserve each old assignment/stamp.
 *
 *   membership-fault C <hang|transient|scope|denied|rate> <first|later> <key> <stub-slice> <log-slice> <before-facts> <after-facts> <retry-after-seconds> <failure-index>
 *     Stage ONLY this fault/page in the slice. Use users.conversations hang,
 *     error internal_error/missing_scope/invalid_auth, or rate_limit respectively.
 *     Need >=2 fired records and scoped incomplete diagnostics for key; pages=0
 *     for first, >0 for later, except denied later also accepts pages=0 when
 *     every fault's api row carries a non-empty cursor, proving the later page
 *     (the credentials refusal resets scan progress before publishing
 *     reason=authentication slack=invalid_auth). Hang requires reason=deadline with deadline/next
 *     attempt timestamps and each request's own fault-settled/abort. Capture through
 *     the LAST fault's diagnostic/settlement. Each diagnostic is uniquely correlated
 *     to the staged request's arrival interval before the next faulted attempt.
 *     Request duration D-A uses A=arrival_epoch_ms (stub handler entry before control
 *     I/O/body parsing) and D=diagnostic logger ISO time, both on the same container
 *     wall clock. D-A must be <= MEMBERSHIP_REQUEST_TIMEOUT_MS + SR8_DISPATCH_ALLOWANCE_MS
 *     (hang lines print signed excess_ms and allowance_ms), and A/D inside the
 *     attempt interval [deadline_at - MEMBERSHIP_ATTEMPT_TIMEOUT_MS, deadline_at].
 *     Never use the later fault.ts as arrival. D<A or absent endpoints/settlements is
 *     missing; an observed over-bound duration is fail. Wall-clock steps are NOT
 *     independently detected: a step that still yields a valid interval may pass.
 *     Other cases require the published reason/Slack code and correlated API
 *     answer. Before/after are identical shared_persona_facts reads for an omitted
 *     historical channel. failure-index is the first fault's zero-based local
 *     backoff index; retry-after is the injected seconds (0 for non-429).
 *     Lines: membership-fault(case,page,fired,incomplete,max_request_ms,max_attempt_ms,
 *     attempt_limit_ms[,excess_ms,allowance_ms]), membership-retry(case,
 *     page,min_ms,retry_after_ms,after_429_ms). Start gaps use arrival_mono_ms;
 *     after-429 uses the stub API response ISO stamp and next arrival_epoch_ms, not
 *     server clocks. Limits from membershipRetryDelay / MEMBERSHIP_REQUEST_TIMEOUT_MS;
 *     the allowance applies to D-A only. Missing fired/diagnostic/answer/state evidence is missing;
 *     early retry, wrong outcome, false complete or changed state fails.
 *     membership-retry is a RESULT of membership-fault, not a separate CLI command.
 *     When either result is not pass, membership-fault-row lines (membershipFaultRows:
 *     fault, settlement, API answer and scan rows, numbers and code words only)
 *     print before the verdict lines.
 *   membership-repair C <key> <clear-epoch-ms> <log-slice>
 *     Slice contains the last incomplete diagnostic before clear and the first
 *     complete diagnostic afterward, with the logger's ISO timestamps intact.
 *     Sample clear-epoch-ms immediately BEFORE clearing faults, on the container
 *     wall clock (Date.now/Python time.time*1000). Clear between observed retries;
 *     send NO traffic/tool/reconnect until complete. The line records elapsed_ms,
 *     remaining_ms, retry_ms, scan_ms. Published bound = remaining attempt deadline
 *     + max(MEMBERSHIP_RETRY_MAX_MS, Retry-After) + successful scan/persistence time;
 *     scan start is complete.deadline_at - MEMBERSHIP_ATTEMPT_TIMEOUT_MS. After an
 *     access or authentication refusal (no deadline_at) the remaining deadline is 0
 *     and, when the complete line has no deadline_at, scan start is the last
 *     reason=none incomplete line after clear and at/after the refusal's
 *     next_attempt_at. No fixed
 *     extra 30 seconds, rounding tolerance or dispatch allowance. Missing timestamps
 *     or completion is missing, elapsed above the bound or scan above its deadline
 *     fails. This does not claim a constant bound on arbitrary persistence work.
 *   membership-late C <key> <request-id> <stub-slice> <complete-seq-mark> <complete-log> <before-state> <after-state>
 *     Use users.conversations late + printer-built contradictory body. After the
 *     replacement scan's complete diagnostic/readiness succeeds, take slack_post_mark
 *     as complete-seq-mark, then before-state. Wait for this request's settlement,
 *     then take after-state and complete-log through that point (a subsequent
 *     incomplete diagnostic fails). Both state files concatenate the same successful f6
 *     reads (shared_persona_facts, shared_attempt_order, shared_thread_joins).
 *     Need fired late, arrival_mono_ms, exactly one late settlement and its API
 *     record, both seq > complete-seq-mark. The same stub's seq is monotonic record
 *     order. Line: membership-late(fired,late_after_complete,unchanged; unchanged).
 *     Abort always fails. Missing evidence or a settlement before completion is
 *     missing; different state reads fail. Never accept an aborted delay as late.
 *
 *   zero-ack C <key> <envelope-id> <times> <start-ms> <end-ms> <probe-exit> <log-slice>
 *     Attempt the actual write probe while permissions deny writes. Capture start
 *     after pushing the live membership event, end after the observation interval,
 *     then slack_envelope_times; same external clock, no repair/redelivery until
 *     afterward. Require MEMBERSHIP_STORAGE_FAILED for key. Line: zero-ack(acks,
 *     observed_ms,probe_failed; 0). Empty ACK array is evidence; absent push/time,
 *     interval, probe status or diagnostic is missing. ANY ACK or probe success fails.
 *   accounting C <manifest-tsv> <stub-slice> <during-times> <final-times> <queue-dir> <clear-seq-mark>
 *     Manifest: kind(stored|withheld|dropped),key,channel,ts,envelope_id,recovered_id
 *     ('-' unless withheld). Include EVERY push in stub-slice, including drops and
 *     every redelivery. during-times are slack_envelope_times before clearing;
 *     final-times after recovery. Withheld originals stay unacked; replay with
 *     slack_stub_redeliver after clear-seq-mark and record the new envelope id.
 *     Both map to the same exactly-one durable acceptance in <key>.queue.jsonl.
 *     Lines: accounting(expected,stored,withheld; all-pushes), accounting-ack and
 *     recovered-ack (max_ms; N1) for nonempty classes. Recovery latency starts at
 *     the NEW push, never subtracting the fault interval from an original ACK.
 *     Missing push/replay/acceptance/time is missing; duplicate/unlisted pushes,
 *     premature ACKs, wrong replay identity or stored drops fail. No dropped work.
 *     The fault-aware path below also uses refused/refused-dropped (no original
 *     envelope, recorded HTTP refusal) and withheld-dropped (intentional drop whose
 *     original delivery was withheld). Recovery drops must still be ACKed and never
 *     stored; accepted workload recovery must be stored exactly once.
 *   stores C <check-evidence-dir> <measurement-file> <byte-mark>
 *     Same burst.jsonl, queue snapshots and measurements as check. Emits combined
 *     store plus one store persona=<1-based recipient> per configured key. Missing
 *     any acceptance/store or a persona's samples is missing; p99>=50 fails, with
 *     fixed appends excluded. This supplements check/fault-check, never replaces it.
 *   lookup-faults C <probes-tsv> <stub-slice> <times>
 *     TSV: key,method(users.info|conversations.info),outcome(hang|late),match-id,
 *     envelope_id. Use fresh identities and late delay past NAME_LOOKUP_TIMEOUT_MS.
 *     One exact fired line per probe is required; absent/duplicate is missing.
 *     Lines: lookup-faults(fired,required; every-fault), lookup-ack(max_ms; N1).
 *     Every sample ACK must meet N1. The enclosing burst runs check or fault-check.
 *   ordered-writes C <directory> <stub-slice> <submit-seq-mark> <result-seq-mark> <times>
 *     One persona's before/after/reopened.jsonl from shared_attempt_order; all
 *     attempts in these snapshots belong to that incarnation. expected.tsv holds
 *     channel,delivery in submitted serial order; results.jsonl holds each actual
 *     stub_session_result. Submit AFTER a burst push, capture slack_post_mark just
 *     before submission and after result. Preserve preexisting order, require new
 *     outcomes in requested order and exact equality after reopening. The submission
 *     submission AND result marks must precede a burst ACK. Lines: ordered-writes(overlap,retained,ordered,
 *     first/last_push_seq,first/last_ack_seq,submit_seq,result_seq; durable-order), ordered-write-ack(max_ms; N1). Missing evidence is missing;
 *     reordered/lost writes, refused results or lack of overlap fails. Script also
 *     compares each result's text to the existing printer's attempt-result text;
 *     that is exact content checking, not a second numeric/timing oracle.
 *   membership-writes C <directory> <writer-key> <channel> <case-stub-slice> <submit-seq-mark> <result-seq-mark> <times>
 *     Strict refuses bot assignments, so its ordered writes are the writer's live
 *     channel_left then member_joined_channel for one channel outside the burst.
 *     membership.tsv holds kind(leave|join),envelope_id,event_id,stage_seq in push
 *     order: stage_seq is the stub's inventory record from slack_stub_inventory_stage
 *     just before that push, staging the writer's inventory without or with the
 *     channel; each waits for its own ACK, then for a scan. sharedPersonaFacts
 *     JSONL: before/join/reopened.jsonl for every persona, leave.jsonl for the
 *     writer. events.jsonl and events.reopened.jsonl hold {kind,event_id,applied}
 *     per write, applied the sharedMembershipEvent record. Require prior
 *     assignment and membership, then a new leave whose event is the live leave's
 *     (never a scan:), then a fresh mode default at a later order, both applied
 *     by their own events, exact after reopening; all other choices/leaves/identity
 *     unchanged. Same overlap as ordered-writes over the writer's burst pushes;
 *     each write's push/ACK inside the marks, its stage after the previous ACK
 *     and before its push, a first-page inventory request after its push (and
 *     before the next stage), and no control replacement between the marks.
 *     Lines: ordered-writes(overlap,retained,ordered,acked,staged; durable-order),
 *     ordered-write-ack (burst, N1), membership-write-ack (both writes, N1;
 *     membership-times.jsonl in <directory>).
 *
 * Fault-aware load commands (Decision 27). C must use two recipients. All event
 * bodies are prebuilt by scenario.sh OUTSIDE the measured window, as for burst.
 *   fault-plan C <batch-dir> <plan-tsv> <hang|transient|scope|denied|rate|late|lookup> <P-number> <all|none|channel-ordinals> <out>
 *     BEFORE faults/burst: validates every prebuilt root/reply/drop against plan's
 *     phase/channel/ts/root and full per-persona counts. P-number is 1 or 2 in the
 *     population's persona order. Channel ordinals are 1-based comma-separated
 *     indices in the plan's first-seen channel order; never type channel/persona IDs.
 *     Declares P's dependent set; all other items are independent. denied REQUIRES
 *     all (invalid_auth breaks P's connection). For name-only lookup use none.
 *     Writes fault-plan.json and copied payloads.jsonl to a fresh out. Optional held
 *     batch participates too. Prints planned/dependent counts and P's number.
 *   fault-burst C <out> <stub-url> <stub-record> <state-dir> <measurement-file> <byte-mark> <wait-ms> [<tail-release>]
 *     Submit held probes first, admit the independent probes as above; then concurrent
 *     P/Q roots, wait ONLY expected independent ACKs, then concurrent P/Q replies and
 *     drops (including replies to withheld roots). Never await a dependent ACK.
 *     Open mode only (strict refuses it as usage): with tail-release, Q's last
 *     SR8_FAULT_TAIL_ITEMS independent replies wait (within wait-ms) until that
 *     file exists; the script creates it after the ordered writes' result mark,
 *     so Q's burst ACKs overlap both marks. Strict submits its second wave at once.
 *     With SR8_PROFILE_DIR set (test-45's profiled case only), `held` (when there
 *     are held probes), `roots` and `replies-drops` are appended to <dir>/waves as
 *     each wave's sends start; the script marks `end` after its ordered writes.
 *     Appends each original HTTP result to fault-ledger.jsonl by planned ordinal:
 *     envelope_id, or denied-case no-open-socket/send-failed refusal with NO invented
 *     envelope. Unrecognized refusals/timeouts fail and retain the attempted item.
 *     Queue compaction observations cover the Q burst window; keeps compactions.jsonl and
 *     held-admission snapshots. Prints submitted/expected/refused. No HTTP ACK oracle.
 *   fault-ids C <out>
 *     Every original/replay envelope in the ledger, one per line, excluding only
 *     refused attempts that have no envelope. Take during-times.jsonl BEFORE clear;
 *     after recovery take times.jsonl, using envelope-times with separate frozen
 *     before-clear and final observations. No original ID is removed after replay.
 *   fault-recover C <out> <stub-url> <live-stub-record> <wait-ms> <concurrency>
 *     One call after clear/readiness, replacing the per-item pending/body/replayed
 *     loop. Read plan, original ledger and copied payloads once. Refuse a ledger
 *     already containing replays. Concurrency is an integer 1..256; wait-ms is one
 *     overall deadline, not a per-envelope extension or an N1 allowance.
 *     Replay roots with bounded concurrent requests/ACK waits, observe every root's
 *     own ACK, then replay the other dependent items with the same bound. Retain
 *     original/refusal rows; append every attempt and actual returned replay ID.
 *     Refused originals use the copied prebuilt body; other originals use the same
 *     redelivery control as slack_stub_redeliver. Failed attempts remain incomplete
 *     ledger rows and cannot pass accounting. Never retry the driver implicitly.
 *     One incremental stub reader buffers live partial lines and fails on record
 *     replacement/truncation or malformed complete lines. No per-item subprocesses.
 *     Verify replay push identities, exactly one own ACK, root ACK before reply push,
 *     and no new unrecorded push. Failure uses a fixed named reason. Keep the full
 *     final observation and run fault-check/accounting unchanged, including N1.
 *     Prints fault-recover expected/attempted/recorded/completed/concurrency counts;
 *     these are driver counts, never a runtime/performance verdict.
 *   fault-pending C <out>
 *     TSV ordinal,key,original-envelope-or-dash for EVERY dependent planned item,
 *     roots first. After clear/readiness, use slack_stub_redeliver for a real original;
 *     for a refused attempt use slack_stub_push with fault-body's prebuilt event.
 *     Wait for each recovery root ACK before replaying its replies. All dependent
 *     replies were already submitted in the original second wave during the fault.
 *   fault-body C <out> <ordinal>
 *     Prints that already-built dependent event verbatim as JSON; constructs no event.
 *   fault-replayed C <out> <ordinal> <new-envelope-id>
 *     APPENDS the helper's actual new envelope to the ledger; no replacements/deletions.
 *     Duplicate replay IDs/ordinals are usage errors. Final accounting binds each
 *     real redelivery record or refused attempt's fresh push to its planned identity.
 *   fault-check C <out> <stub-slice> <clear-seq-mark> <clear-epoch-ms> <measurement-file> <byte-mark> <start-ms> <ready-ms>
 *     Before clear, capture during/<key>.queue.jsonl for BOTH keys and during-times.
 *     During snapshots must cover the completed original burst while the fault is
 *     still in force. Save final <key>.queue.jsonl, retaining pre-compaction samples,
 *     times.jsonl, and <key>.before/after.jsonl joins as check requires (after restart).
 *     The stub slice includes this case's fired/settled fault and EVERY original,
 *     refused and replay attempt, no setup pushes or unrelated case work. Mark the
 *     last stub seq and container wall time immediately BEFORE clearing the fault.
 *     For denied P, restore its authenticated connection before recovery submissions.
 *     Lines: fault-workload(full original counts/declared dependencies/refusals),
 *     fault-withheld(zero ACK and unstored during the fault), fault-overlap(positive
 *     intersection of fired-to-settled-or-clear with Q's first-push-to-final-ACK wall
 *     window; no overlap is missing), accounting/accounting-ack/recovered-ack,
 *     ordinary ack-accepted/ack-dropped per nonempty independent persona class,
 *     combined/per-persona store, post-hold and overlap, joins, startup and compaction.
 *     Compaction follows check's rule for both P and Q, over Q's ORIGINAL burst
 *     (what fault-burst observes): the span of Q's own acceptance stores, never P's
 *     items or any recovery replay. Only personas with stored burst items there
 *     must rewrite: Q always, P only when the plan has independent accepted P
 *     items (not all). A P with every item withheld has no Thread Memory change in
 *     that span, so any complete in-span entry, rewritten or skipped, proves it;
 *     no in-span entry is still missing (answers28).
 *     Q keeps ALL ordinary counts and limits, P's independent work keeps N1, all
 *     recovery ACKs start at their NEW push and all accepted recoveries store once.
 *     This replaces ordinary check ONLY for this declared fault-aware workload;
 *     membership/repair/late/lookup/ordered-write case verdicts are still required.
 *
 * Exact invocation examples (script variables are observations, paths or plan values):
 * Test-44, with prebuilt held probes:
 *   bun "$E" combinations > "$out/combinations.tsv"
 *   bun "$E" burst "$TEST_NAME" "$mode" "$population" "$recipients" "$batch_dir" "$stub_url" "$stub_record" "$state_dir" "$out" "$wait_ms" "$measurements" "$mark"
 *   jq -er '.envelope_id' "$out/burst.jsonl" > "$out/ids.txt"
 *   _scenario_complete_jsonl "$stub_record" > "$out/final-stub.jsonl"
 *   bun "$E" envelope-times "$out/ids.txt" "$out/final-stub.jsonl" > "$out/times.jsonl"
 *   bun "$E" check "$TEST_NAME" "$mode" "$population" "$recipients" "$out" "$measurements" "$mark" "$start_ms" "$ready_ms"
 * Test-45, P=first population persona, all its planned channels dependent:
 *   bun "$E" fault-plan "$TEST_NAME" "$mode" 100000 2 "$batch_dir" "$plan_tsv" "$kind" 1 all "$out"
 *   bun "$E" fault-burst "$TEST_NAME" "$mode" 100000 2 "$out" "$stub_url" "$stub_record" "$state_dir" "$measurements" "$mark" "$wait_ms"
 *   bun "$E" fault-ids "$TEST_NAME" "$mode" 100000 2 "$out" > "$out/during-ids.txt"
 *   _scenario_complete_jsonl "$stub_record" > "$out/during-stub.jsonl"
 *   bun "$E" envelope-times "$out/during-ids.txt" "$out/during-stub.jsonl" > "$out/during-times.jsonl"
 *   # Capture during queues and clear marks; clear fault, observe repair/readiness.
 *   bun "$E" fault-recover "$TEST_NAME" "$mode" 100000 2 "$out" "$stub_url" "$stub_record" "$recovery_wait_ms" 64
 *   bun "$E" fault-ids "$TEST_NAME" "$mode" 100000 2 "$out" > "$out/all-ids.txt"
 *   _scenario_complete_jsonl "$stub_record" > "$out/final-stub.jsonl"
 *   bun "$E" envelope-times "$out/all-ids.txt" "$out/final-stub.jsonl" > "$out/times.jsonl"
 *   bun "$E" fault-check "$TEST_NAME" "$mode" 100000 2 "$out" "$stub_slice" "$clear_mark" "$clear_epoch_ms" "$measurements" "$mark" "$start_ms" "$ready_ms"
 * For a channel-local case, replace all with plan channel ordinal(s), e.g. 1,2.
 * For lookups, use kind=lookup and none. Scope is declared before any submission.
 *
 * Missing evidence (never pass; check/startup-load/seal/n4/windows exit 1 after ALL result lines):
 * - absent/malformed measurement file, or fewer/mismatched acceptance stores than
 *   accepted burst items (fixed appends are excluded from both the count and p99);
 * - a push without its unique ACK, missing push/timing/accepted/join snapshots;
 * - fewer real-agent N2 samples than required;
 * - either required compaction not proved INSIDE the burst at population 100000
 *   (a persona that must rewrite and whose in-burst Thread Memory compactions all
 *   skipped fails; only fault-check's fully withheld P need not rewrite);
 * - a held reply without its resolution or its OWN key/seq resolution-store append;
 * - absent hung N2 sample or accepted/fixed record of its key/seq;
 * - absent fired fault for either hung or delayed sample;
 * - absent external startup timestamps or N3 idle-window observations.
 * A restart resolution without held_ms is not a timing sample. No in-process
 * thread-memory-loaded record exists or is required (Decision 25).
 *
 * Percentiles: transcript-receipts.percentile (nearest rank), never interpolation.
 * SR8_DISPATCH_ALLOWANCE_MS is the test-method timer-dispatch allowance over the
 * Post Hold and N4 STRICT limits and the membership hang request duration D-A;
 * each prints signed excess and allowance always.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync, statfsSync, openSync, readSync, closeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { cpus } from 'node:os'
import { isDeepStrictEqual } from 'node:util'

export const SR8_DISPATCH_ALLOWANCE_MS = 100
// SRD verification bounds, not configurable production timers.
export const SR8_ACK_LIMIT_MS = 3_000
export const SR8_STORE_LIMIT_MS = 50
/** The server's test-only diagnostic measurement kinds; only `observe` reads them. */
export const SR8_DIAGNOSTIC_KINDS: readonly string[] = ['ack', 'append', 'thread-save']
/** Linux USER_HZ: the tick rate of /proc/<pid>/stat CPU times. */
export const SR8_USER_HZ = 100
export type Verdict = 'pass' | 'fail' | 'missing' | 'recorded'
export interface Context { scenario: string; mode: 'strict' | 'open'; population: number; recipients: number }
export interface Result { measure: string; samples: number; stats: Record<string, string | number>; limit: string | number; verdict: Verdict }
export interface Measurement { v: number; kind: string; key: string; seq?: number; seqs?: number[]; store?: string; at_mono_ms: number; store_ms?: number; held_ms?: number; outcome?: string; cause?: string; start_mono_ms?: number; end_mono_ms?: number }
export interface Accepted { key: string; seq: number }
export interface Times { envelope_id: string; push: { sent_mono_ms: number; connection_id: unknown }; acks: { ack_mono_ms: number; connection_id: unknown }[] }
export interface BurstItem { key: string; phase: string; channel: string; ts: string; sender: string; envelope_id?: string }
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const nonnegative = (n: unknown): n is number => finite(n) && n >= 0
const maximum = (ns: number[]) => ns.length ? Math.max(...ns) : 0
const identity = (r: Accepted) => `${r.key}:${r.seq}`
const result = (measure: string, samples: number, stats: Result['stats'], limit: Result['limit'], verdict: Verdict): Result => ({ measure, samples, stats, limit, verdict })

/** Formatting deliberately has no arbitrary text/error field. */
export function resultLine(c: Context, r: Result): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(c.scenario) || !['strict', 'open'].includes(c.mode)) throw new Error('invalid context')
  return `recorded: sr8 ${r.measure} scenario=${c.scenario} mode=${c.mode} population=${c.population} recipients=${c.recipients} samples=${r.samples} ${Object.entries(r.stats).map(([k, v]) => `${k}=${v}`).join(' ')} limit=${r.limit} verdict=${r.verdict}`
}
export function summary(c: Context, rows: Result[]): string {
  return `recorded: sr8 summary scenario=${c.scenario} measures=${rows.length} pass=${rows.filter(r => r.verdict === 'pass').length} fail=${rows.filter(r => r.verdict === 'fail').length} missing=${rows.filter(r => r.verdict === 'missing').length}`
}
export function evidenceExit(rows: Result[]): number { return rows.some(r => r.verdict === 'fail' || r.verdict === 'missing') ? 1 : 0 }
export function printResults(c: Context, rows: Result[], print: (line: string) => void = console.log): number {
  for (const r of rows) print(resultLine(c, r))
  print(summary(c, rows))
  return evidenceExit(rows)
}
export function ackVerdict(measure: string, ids: (string | undefined)[], times: Times[] | undefined): Result {
  const durations: number[] = []
  let missing = !times || !ids.length, invalid = new Set(ids).size !== ids.length
  for (const id of ids) {
    const found = times?.filter(t => t.envelope_id === id) ?? []
    if (!id || found.length !== 1 || found[0].acks.length === 0) { missing = true; continue }
    const t = found[0], ack = t.acks[0]
    if (t.acks.length !== 1 || ack.connection_id !== t.push.connection_id) invalid = true
    const ms = ack.ack_mono_ms - t.push.sent_mono_ms
    if (!nonnegative(ms)) { missing = true; continue }
    durations.push(ms)
  }
  const max = maximum(durations)
  return result(measure, durations.length, { max_ms: max }, SR8_ACK_LIMIT_MS,
    missing ? 'missing' : invalid || max > SR8_ACK_LIMIT_MS ? 'fail' : 'pass')
}
/** check's ordinary burst ACK verdicts: full per-persona counts, N1, and no stored drop. */
export function burstAckVerdicts(keys: string[], items: BurstItem[] | undefined, times: Times[] | undefined,
  queues: Record<string, any[] | undefined>, counts: { roots: number; replies: number; dropped: number }): Result[] {
  const acceptedItems = items?.filter(i => ['roots', 'replies', 'held'].includes(i.phase)) ?? [], drops = items?.filter(i => i.phase === 'dropped') ?? []
  let droppedStored = 0
  for (const key of keys) for (const dropped of drops.filter(i => i.key === key))
    droppedStored += queues[key]?.filter(r => r.kind === 'accepted' && r.channel === dropped.channel && r.ts === dropped.ts).length ?? 0
  const ackAccepted = ackVerdict('ack-accepted', acceptedItems.map(i => i.envelope_id), times), ackDropped = ackVerdict('ack-dropped', drops.map(i => i.envelope_id), times)
  if (keys.some(key => acceptedItems.filter(i => i.key === key && i.phase === 'roots').length !== counts.roots
    || acceptedItems.filter(i => i.key === key && i.phase === 'replies').length !== counts.replies)) ackAccepted.verdict = 'missing'
  if (keys.some(key => drops.filter(i => i.key === key).length !== counts.dropped)) ackDropped.verdict = 'missing'
  if (ackDropped.verdict !== 'missing' && droppedStored > 0) ackDropped.verdict = 'fail'
  return [ackAccepted, ackDropped]
}
/** An accepted item's own acceptance store; a later `fixed` append is not one. */
const ACCEPTANCE_STORES = ['accepted', 'post-hold', 'memory-hold']
export function storeVerdict(rows: Measurement[] | undefined, accepted: Accepted[], percentile: (values: number[], q: number) => number): Result {
  const stores = rows?.filter(r => r.kind === 'store' && ACCEPTANCE_STORES.includes(r.store!)) ?? []
  const wanted = new Set(accepted.map(identity))
  const samples = stores.filter(r => wanted.has(identity(r as Accepted)))
  const counts = new Map<string, number>()
  for (const s of samples) { const id = identity(s as Accepted); counts.set(id, (counts.get(id) ?? 0) + 1) }
  const complete = rows !== undefined && accepted.length > 0 && wanted.size === accepted.length
    && accepted.every(a => counts.get(identity(a)) === 1)
    && samples.every(s => nonnegative(s.store_ms))
  const p99 = samples.length && samples.every(s => nonnegative(s.store_ms)) ? percentile(samples.map(s => s.store_ms!), .99) : 0
  return result('store', samples.length, { p99_ms: p99, accepted: accepted.length }, SR8_STORE_LIMIT_MS,
    !complete ? 'missing' : p99 < SR8_STORE_LIMIT_MS ? 'pass' : 'fail')
}
export function postHoldVerdict(rows: Measurement[] | undefined, holds: Accepted[], holdMs: number): Result {
  const excess: number[] = [], appends: number[] = [], held: number[] = []
  let missing = rows === undefined || holds.length === 0
  for (const h of holds) {
    const resolutions = rows?.filter(r => r.kind === 'post-hold-resolved' && r.key === h.key && r.seq === h.seq) ?? []
    // Restart release is outside the timed run; it cannot fill a missing live sample.
    const timed = resolutions.filter(r => nonnegative(r.held_ms))
    const stores = (rows?.filter(r => r.kind === 'resolution-store' && r.key === h.key && r.seqs?.includes(h.seq)) ?? [])
      .sort((a, b) => a.at_mono_ms - b.at_mono_ms)
    // The first transition resolves the Post Hold. A parked hold can later have
    // a second (Memory Hold) resolution with the same seq and a different append.
    if (timed.length !== 1 || stores.length === 0 || !nonnegative(stores[0].store_ms)
      || stores[0].at_mono_ms > timed[0].at_mono_ms
      || (stores[1] && stores[0].at_mono_ms === stores[1].at_mono_ms)) { missing = true; continue }
    const append = stores[0].store_ms!, ms = timed[0].held_ms!
    appends.push(append); held.push(ms); excess.push(ms - holdMs - append)
  }
  const max = excess.length ? Math.max(...excess) : 0
  return result('post-hold', excess.length, { hold_ms: holdMs, max_append_ms: maximum(appends), max_held_ms: maximum(held), excess_ms: max, allowance_ms: SR8_DISPATCH_ALLOWANCE_MS }, 'hold_ms+own_append',
    missing ? 'missing' : max <= SR8_DISPATCH_ALLOWANCE_MS ? 'pass' : 'fail')
}
export interface N2Sample { key: string; seq: number; name: string }
export function n2Samples(text: string): N2Sample[] {
  return text.split('\n').filter(l => l.startsWith('recorded: sr8 n2-sample ')).map(line => {
    const fields = Object.fromEntries(line.split(/\s+/).slice(3).map(s => s.split('=')))
    return { key: fields.key, seq: Number(fields.seq), name: fields.name }
  }).filter(s => /^[a-z0-9_]+$/.test(s.key) && Number.isSafeInteger(s.seq) && s.seq > 0)
}
export function n2Verdict(samples: N2Sample[] | undefined, required: number): Result {
  const count = new Set(samples?.map(identity)).size
  return result('n2-samples', count, { required }, required, samples && count >= required ? 'pass' : 'missing')
}
export interface FaultSample extends Accepted { sender: string; envelope_id?: string }
export function n4Verdict(rows: Measurement[] | undefined, hung: FaultSample | undefined, delayed: FaultSample | undefined,
  times: Times[] | undefined, samples: N2Sample[] | undefined, faults: any[] | undefined, timeoutMs: number): Result {
  const accepted = rows?.filter(r => r.kind === 'store' && r.store === 'accepted' && r.key === hung?.key && r.seq === hung?.seq) ?? []
  const fixed = rows?.filter(r => r.kind === 'store' && r.store === 'fixed' && r.key === hung?.key && r.seq === hung?.seq) ?? []
  const n2 = samples?.filter(s => s.key === hung?.key && s.seq === hung?.seq) ?? []
  const ack = ackVerdict('ack', [hung?.envelope_id], times)
  const fired = [hung, delayed].filter((s, i) => s && faults?.filter(f => f.event === 'fault' && f.control === 'faults'
    && f.method === 'users.info' && f.match === s.sender && f.label === s.key && f.outcome === (i === 0 ? 'hang' : 'delay')
    && nonnegative(f.arrival_mono_ms)).length === 1).length
  const fallback = accepted.length === 1 && fixed.length === 1 && nonnegative(fixed[0].store_ms)
    ? fixed[0].at_mono_ms - fixed[0].store_ms! - accepted[0].at_mono_ms : NaN
  const excess = fallback - timeoutMs
  const missing = !hung || !delayed || !rows || n2.length !== 1 || !nonnegative(fallback) || fired !== 2 || ack.verdict === 'missing'
  return result('n4', nonnegative(fallback) ? 1 : 0, { fallback_ms: finite(fallback) ? fallback : 'missing', excess_ms: finite(excess) ? excess : 'missing', allowance_ms: SR8_DISPATCH_ALLOWANCE_MS,
    name: n2[0]?.name === 'fallback' ? 'fallback' : 'resolved', ack_ms: ack.stats.max_ms, ack_limit: SR8_ACK_LIMIT_MS, in_n2: n2.length === 1 ? 'yes' : 'no', fired: `${fired}/2` }, timeoutMs,
  missing ? 'missing' : n2[0].name !== 'fallback' || ack.verdict !== 'pass' || excess > SR8_DISPATCH_ALLOWANCE_MS ? 'fail' : 'pass')
}
export function sealVerdict(phase: string, keys: string[], lines: string[] | undefined, marker: string, expected: string[], lostMarker?: string): Result {
  if (!['first', 'measured'].includes(phase) || (phase === 'first' && keys.length === 0)) throw new Error('usage: first requires seeded personas')
  const reports = lines?.filter(l => l.includes(marker) || (phase === 'measured' && !!lostMarker && l.includes(lostMarker))) ?? []
  const pass = phase === 'measured' ? reports.length === 0 : reports.length === keys.length
    && expected.length === keys.length && expected.every(e => reports.filter(l => l.includes(e)).length === 1)
  return result('seal', keys.length, { phase, personas: keys.length, reports: reports.length, loaded: 0 }, phase === 'first' ? keys.length : 0,
    !lines ? 'missing' : pass ? 'pass' : 'fail')
}
export function requireSeedPopulation(n: number): void { if (![10_000, 100_000].includes(n)) throw new Error('usage: seed requires 10000 or 100000 joins') }
export function startupVerdict(start: number, ready: number, count: number): Result {
  return result('startup-load', count, { joined: count, start_to_ready_ms: nonnegative(ready - start) ? ready - start : 'missing' }, 'none',
    nonnegative(start) && nonnegative(ready) && ready >= start ? 'recorded' : 'missing')
}
export interface Compaction { key: string; kind: string; before: string; after: string; inside: boolean }
/** A span on the server's measurement clock (`performance.now`), ms. */
export interface ServerWindow { start: number; end: number }
/** The measured burst on the server clock, from the burst items' own acceptance
 * stores (by key and seq): the first store's start (`at_mono_ms - store_ms`) to
 * the last store's `at_mono_ms`. Each store follows its item's push and precedes
 * its ACK, so the span lies inside the burst's push-to-final-ACK window. Undefined
 * unless every item has exactly one usable store. Pure. */
export function storeWindow(rows: Measurement[] | undefined, accepted: Accepted[]): ServerWindow | undefined {
  const wanted = new Set(accepted.map(identity))
  const stores = rows?.filter(r => r.kind === 'store' && ACCEPTANCE_STORES.includes(r.store!) && wanted.has(identity(r as Accepted))) ?? []
  // Distinct identities, one store each: every item's own store, none twice.
  if (!rows || !accepted.length || wanted.size !== accepted.length || stores.length !== accepted.length
    || new Set(stores.map(r => identity(r as Accepted))).size !== stores.length) return undefined
  let start = Infinity, end = -Infinity
  for (const s of stores) {
    if (!nonnegative(s.store_ms) || !nonnegative(s.at_mono_ms - s.store_ms)) return undefined
    start = Math.min(start, s.at_mono_ms - s.store_ms); end = Math.max(end, s.at_mono_ms)
  }
  return { start, end }
}
/** A `thread-compaction` entry as the server writes it: start and end on the
 * server clock, end at or after start and equal to `at_mono_ms`, a known outcome. */
const threadCompaction = (r: Measurement) => r.kind === 'thread-compaction' && nonnegative(r.start_mono_ms) && nonnegative(r.end_mono_ms)
  && r.end_mono_ms >= r.start_mono_ms && r.at_mono_ms === r.end_mono_ms && ['rewritten', 'skipped'].includes(r.outcome!)
/** SR-8.2's compaction proof, required only at 100,000. Per recipient: a queue
 * compaction by file identity (`compactions.jsonl`), and that persona's
 * `thread-compaction` entries wholly inside `window`, rewritten and
 * skipped-identical alike complete. Each persona in `rewriters` (every recipient
 * unless fault-check narrows it) needs at least one of them rewritten, and fails
 * when all skipped; any other persona is proved by any such entry. None, or no
 * window, is missing. Entries outside the window (startup and bring-up included)
 * and Thread Memory file identity rows never count. Pure. */
export function compactionVerdict(queue: Compaction[] | undefined, rows: Measurement[] | undefined, window: ServerWindow | undefined,
  keys: string[], required: boolean, rewriters: string[] = keys): Result {
  const entries = rows?.filter(r => keys.includes(r.key) && threadCompaction(r)) ?? []
  const span = window && nonnegative(window.start) && finite(window.end) && window.end >= window.start ? window : undefined
  const inside = span ? entries.filter(r => r.start_mono_ms! >= span.start && r.end_mono_ms! <= span.end) : []
  const queued = keys.filter(key => queue?.some(r => r.key === key && r.kind === 'queue' && r.inside === true && !!r.before && !!r.after && r.before !== r.after))
  const proved = keys.filter(key => inside.some(r => r.key === key && (r.outcome === 'rewritten' || !rewriters.includes(key))))
  const skippedOnly = keys.filter(key => !proved.includes(key) && inside.some(r => r.key === key))
  const missing = queued.length < keys.length || proved.length + skippedOnly.length < keys.length
  return result('compaction', queued.length + proved.length, { required: required ? keys.length * 2 : 0, queue: queued.length, threads: proved.length,
    rewritten: inside.filter(r => r.outcome === 'rewritten').length, skipped: inside.filter(r => r.outcome === 'skipped').length,
    outside: entries.length - inside.length, window_ms: span ? round3(span.end - span.start) : 'missing' }, 'inside-burst',
    !required ? 'pass' : missing ? 'missing' : skippedOnly.length ? 'fail' : 'pass')
}
interface JoinIdentity { channel: string; root: string; source?: unknown }
/** Counts per value, e.g. `own-post:1`; a value that is not one short word counts as `other`. */
function tally(values: unknown[]): string {
  const counts = new Map<string, number>()
  for (const v of values) { const w = typeof v === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(v) ? v : 'other'; counts.set(w, (counts.get(w) ?? 0) + 1) }
  const sorted = [...counts].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).map(([w, n]) => `${w}:${n}`)
  return sorted.length ? sorted.slice(0, 5).join(',') + (sorted.length > 5 ? `,+${sorted.length - 5}` : '') : 'none'
}
/** With S the seeded identities, B the pre-burst snapshot, N the burst roots
 * and A the snapshot after the restart: S ⊆ B and B ∪ N ⊆ A. The baseline
 * excess B \ S (the seal report's own-post join, say) is printed by count,
 * source and channel only. */
export function joinsVerdict(before: JoinIdentity[] | undefined, after: JoinIdentity[] | undefined,
  expected: JoinIdentity[], newJoins: JoinIdentity[], recipients: number): Result {
  const id = (r: JoinIdentity) => `${r.channel}:${r.root}`
  const b = new Set(before?.map(id)), a = new Set(after?.map(id)), old = new Set(expected.map(id)), added = new Set(newJoins.map(id))
  const retained = [...old].filter(k => a.has(k)).length
  const excess = [...new Map((before ?? []).filter(r => !old.has(id(r))).map(r => [id(r), r])).values()]
  const lost = [...b].filter(k => !a.has(k)).length, missingRoots = [...added].filter(k => !a.has(k)).length
  return result('joins', a.size, { before: b.size, after: a.size, oldest_retained: retained, forgotten: old.size - retained,
    baseline_excess: excess.length, excess_sources: tally(excess.map(r => r.source)), excess_channels: tally(excess.map(r => r.channel)),
    baseline_lost: lost, burst_missing: missingRoots }, `>=${(old.size + added.size) * recipients}`,
    !before || !after ? 'missing' : [...old].every(k => b.has(k)) && lost === 0 && missingRoots === 0
      && a.size >= old.size + added.size ? 'pass' : 'fail')
}
export interface ObservationWindow { instance: string; start: number; end: number }
export function windowsVerdict(calls: { instance: string; ms: number }[] | undefined, empty: ObservationWindow[] | undefined,
  rate: number, active: ObservationWindow[] | undefined): Result {
  let max = 0, idle = 0
  for (const instance of new Set(calls?.map(c => c.instance))) {
    const ts = calls!.filter(c => c.instance === instance).map(c => c.ms).sort((a, b) => a - b)
    let end = 0
    for (let start = 0; start < ts.length; start++) {
      while (end < ts.length && ts[end] < ts[start] + 10_000) end++
      max = Math.max(max, end - start)
    }
  }
  for (const c of calls ?? []) if (empty?.some(e => e.instance === c.instance && c.ms >= e.start && c.ms < e.end)) idle++
  const valid = (w: ObservationWindow) => typeof w.instance === 'string' && !!w.instance && nonnegative(w.start) && finite(w.end) && w.end > w.start
  const inside = (c: { instance: string; ms: number }, w: ObservationWindow) => c.instance === w.instance && c.ms >= w.start && c.ms < w.end
  const covered = active?.filter(w => calls?.some(c => inside(c, w))).length ?? 0
  const missing = !calls || !empty?.length || !active?.length || active.some(w => !valid(w)) || empty.some(w => !valid(w))
    || new Set(active.map(w => w.instance)).size !== active.length || covered !== active.length
    || active.some(a => !empty.some(e => e.instance === a.instance)) || empty.some(e => !active.some(a => a.instance === e.instance)
      || active.some(a => a.instance === e.instance && Math.max(a.start, e.start) < Math.min(a.end, e.end)))
    || calls.some(c => !nonnegative(c.ms) || ![...active, ...empty].some(w => inside(c, w)))
  return result('n3', calls?.length ?? 0, { max_10s: max, empty_calls: idle, active_instances: active?.length ?? 0, covered_instances: covered }, rate * 10,
    missing ? 'missing' : max <= rate * 10 && idle === 0 ? 'pass' : 'fail')
}

export interface ConcurrentOperation { kind: string; id: string; start_epoch_ms: number; end_epoch_ms: number }
export interface SampleInterval extends Accepted { start_epoch_ms: number; end_epoch_ms: number }
export function concurrentOverlapVerdicts(operations: ConcurrentOperation[] | undefined, samples: SampleInterval[] | undefined,
  measured: N2Sample[] | undefined, mode = 'open'): Result[] {
  const validInterval = (r: { start_epoch_ms: number; end_epoch_ms: number }) => nonnegative(r.start_epoch_ms)
    && finite(r.end_epoch_ms) && r.end_epoch_ms > r.start_epoch_ms
  const expected = new Set(measured?.map(identity))
  const missing = !operations?.length || !samples?.length || !measured?.length || expected.size !== measured.length
    || samples.length !== expected.size || new Set(samples.map(identity)).size !== samples.length
    || samples.some(s => !expected.has(identity(s)) || !validInterval(s))
    || operations.some(o => !['membership', 'write'].includes(o.kind) || !o.id || !validInterval(o))
    || new Set(operations.map(o => JSON.stringify([o.kind, o.id]))).size !== operations.length
  return ['membership', 'write'].map(kind => {
    const work = operations?.filter(o => o.kind === kind) ?? []
    // Recorded ends are poll-bounded supersets; only the start is credited,
    // except a strict write, whose durable point lies between its start and
    // its observed ACK: the whole operation must lie inside the sample.
    const durable = mode === 'strict' && kind === 'write'
    const overlapping = work.filter(o => samples?.some(s => o.start_epoch_ms >= s.start_epoch_ms && o.start_epoch_ms < s.end_epoch_ms
      && (!durable || o.end_epoch_ms < s.end_epoch_ms))).length
    return result(`thread-${kind}-overlap`, overlapping, { operations: work.length, measured: expected.size },
      durable ? 'durable-inside-measured-sample' : 'start-inside-measured-sample', missing || !overlapping ? 'missing' : 'pass')
  })
}

// Additional case verdicts deliberately do not alter check/n4/startup-load.
export const SR8_PENDING_POST_MS = 120_000
export const SR8_LARGE_BYTES = 64 * 1024
export const SR8_SHARED_CHANNELS = 1_000
const object = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const records = (v: any): v is any[] => Array.isArray(v) && v.every(object)
const positive = (v: unknown): v is number => nonnegative(v) && v > 0
const integer = (v: unknown): v is number => nonnegative(v) && Number.isSafeInteger(v)
const stateRead = (v: string | undefined) => {
  if (!v?.trim()) return false
  try { if (object(JSON.parse(v))) return true } catch { /* a concatenated reader file may be JSONL */ }
  return v.trim().split('\n').every(l => { try { return object(JSON.parse(l)) } catch { return false } })
}
const acceptedFor = (queue: any[] | undefined, channel: string, ts: string) => queue?.filter(r => r.kind === 'accepted'
  && !r.compact && r.reminder_for === undefined && r.channel === channel && r.ts === ts) ?? []
const namedLines = (text: string | undefined, marker: string, key: string) =>
  text?.split('\n').filter(l => l.includes(`${marker} persona=${key}`) &&
    [':', ' '].includes(l.split(`${marker} persona=${key}`)[1]?.[0])) ?? []

export interface PendingProbe { parent: string; channel: string; ts: string; envelope_id: string }
export function pendingPostVerdicts(key: string, operation: string, start: number, end: number,
  before: any[] | undefined, after: any[] | undefined, probes: PendingProbe[] | undefined,
  queue: any[] | undefined, times: Times[] | undefined, rows: Measurement[] | undefined, holdMs: number): Result[] {
  const intents = [before, after].map(rs => rs?.filter(r => r.kind === 'post-intent' && r.operationId === operation) ?? [])
  const outcomes = [before, after].flatMap(rs => rs?.filter(r => r.kind === 'post-outcome' && r.operationId === operation) ?? [])
  const holds: Accepted[] = []
  let missing = !before || !after || !queue || !rows || !probes?.length || !times || !nonnegative(start) || !nonnegative(end - start)
    || intents.some(rs => rs.length !== 1) || !['other', 'bot', 'none'].every(p => probes?.some(r => r.parent === p))
  let unexpected = outcomes.length > 0 || intents.some(rs => rs.some(r => r.root !== undefined))
    || !isDeepStrictEqual(intents[0], intents[1])
  for (const p of probes ?? []) {
    if (!['other', 'bot', 'none'].includes(p.parent) || p.channel !== intents[0][0]?.channel) { missing = true; continue }
    const accepted = acceptedFor(queue, p.channel, p.ts)
    if (accepted.length > 1 || (p.parent !== 'other' && accepted.length !== 1)) { missing = true; continue }
    for (const a of accepted) {
      const stores = rows?.filter(r => r.kind === 'store' && r.key === key && r.seq === a.seq && r.store === 'post-hold') ?? []
      const resolved = rows?.filter(r => r.kind === 'post-hold-resolved' && r.key === key && r.seq === a.seq) ?? []
      if (p.parent === 'other') unexpected ||= stores.length > 0 || resolved.length > 0 || a.hold?.on === 'post'
      else { if (stores.length !== 1) missing = true; holds.push({ key, seq: a.seq }) }
    }
  }
  const duration = end - start
  const pending = result('pending-post', probes?.length ?? 0, { pending_ms: finite(duration) ? duration : 'missing',
    other: probes?.filter(p => p.parent === 'other').length ?? 0, held: holds.length }, `>=${SR8_PENDING_POST_MS}`,
    missing ? 'missing' : unexpected || duration < SR8_PENDING_POST_MS ? 'fail' : 'pass')
  return [pending, ackVerdict('pending-post-ack', probes?.map(p => p.envelope_id) ?? [], times), postHoldVerdict(rows, holds, holdMs)]
}
export interface PendingWindow { startSeq: number; endSeq: number; compactMs: number; startMs: number; endMs: number; before?: string; after?: string }
/** The pending post outlasts its burst and the probes ride inside it, in stub
 * record order; no maintenance replaced the journal both reads saw. */
export function pendingBurstVerdict(items: BurstItem[] | undefined, stub: any[] | undefined, probes: PendingProbe[] | undefined, w: PendingWindow): Result {
  const burst = items?.filter(i => ['roots', 'replies', 'dropped'].includes(i.phase)) ?? []
  // Index once: a 100,000-population stub record holds every burst push and ACK.
  const order = new Map<string, number[]>()
  for (const r of stub ?? []) if (['push', 'ws-message'].includes(r.event) && typeof r.envelope_id === 'string' && integer(r.seq))
    order.set(`${r.event} ${r.envelope_id}`, [...order.get(`${r.event} ${r.envelope_id}`) ?? [], r.seq])
  const seqs = (event: string, id: string | undefined) => order.get(`${event} ${id}`) ?? []
  const pushes: number[] = [], acks: number[] = []
  let missing = !stub || !burst.length || !probes?.length || !integer(w.startSeq) || !integer(w.endSeq) || !positive(w.compactMs)
  for (const i of burst) {
    const push = seqs('push', i.envelope_id), ack = seqs('ws-message', i.envelope_id)
    if (!i.envelope_id || push.length !== 1 || !ack.length) { missing = true; continue }
    pushes.push(push[0]); acks.push(...ack)
  }
  const first = pushes.length ? Math.min(...pushes) : NaN, last = maximum(acks)
  const inside = probes?.filter(p => {
    const push = seqs('push', p.envelope_id)
    return items?.filter(i => i.phase === 'probes' && i.envelope_id === p.envelope_id && i.channel === p.channel && i.ts === p.ts).length === 1
      && push.length === 1 && push[0] > first && push[0] < last
  }).length ?? 0
  const contained = w.startSeq < first && last <= w.endSeq
  const journal = (v: string | undefined) => /^\d+:\d+\n?$/.test(v ?? '') ? v!.trim() : undefined
  const before = journal(w.before), after = journal(w.after), window = w.endMs - w.startMs
  missing ||= !before || !after || !nonnegative(w.startMs) || !nonnegative(window) || inside !== probes?.length || !contained
  return result('pending-post-burst', burst.length, { compact_interval_ms: positive(w.compactMs) ? w.compactMs : 'missing',
    window_ms: nonnegative(window) ? window : 'missing', probes_inside: inside, burst_in_pending: contained ? 'yes' : 'no',
    same_journal: before && after ? before === after ? 'yes' : 'no' : 'missing' }, 'window_ms<compact_interval_ms',
  missing ? 'missing' : before !== after || window >= w.compactMs ? 'fail' : 'pass')
}

export interface SharedListEvidence {
  prepared?: string; preview?: string; growth?: { key: string; channel: string; delivery: string }[]
  phases: { facts?: any[]; input?: string }[]
  failureBefore?: string; failureAfter?: string; probeExit: number; failureLog?: string; failureExpected?: string
}
export function sharedListVerdicts(e: SharedListEvidence, keys: string[], marker: string): Result[] {
  let cfg: any
  try { cfg = JSON.parse(e.prepared!) } catch { /* missing below */ }
  const configBytes = e.prepared === undefined ? 0 : Buffer.byteLength(e.prepared)
  const previewBytes = e.preview === undefined ? 0 : Buffer.byteLength(e.preview)
  let missing = !records(cfg?.personas) || !keys.length || !e.preview?.trim() || !e.growth?.length || e.phases.length !== 5
  let invalid = false, initialCount = 0, grownCount = 0
  const facts = (phase: number, key: string) => e.phases[phase]?.facts?.filter(f => f.key === key) ?? []
  for (const phase of e.phases) {
    if (!phase.facts || phase.input === undefined || phase.facts.length !== keys.length) missing = true
    if (phase.input !== undefined && phase.input !== e.prepared) invalid = true
  }
  for (const key of keys) {
    const ps = facts(0, key), configured = records(cfg?.personas) ? cfg.personas.filter((p: any) => p.name === key) : []
    if (ps.length !== 1 || !object(ps[0].assignments) || configured.length !== 1 || !records(configured[0].channels)) { missing = true; continue }
    const original = ps[0].assignments, channels = configured[0].channels
    initialCount += Object.keys(original).length
    invalid ||= Object.keys(original).length < SR8_SHARED_CHANNELS || channels.length !== Object.keys(original).length
      || channels.some((ch: any) => original[ch.id]?.delivery !== ch.delivery)
    const additions = e.growth?.filter(g => g.key === key) ?? []
    if (!additions.length || new Set(additions.map(g => g.channel)).size !== additions.length) missing = true
    for (let phase = 1; phase < 5; phase++) {
      const next = facts(phase, key)
      if (next.length !== 1 || !object(next[0].assignments)) { missing = true; continue }
      const assignments = next[0].assignments
      invalid ||= next[0].incarnation !== ps[0].incarnation || next[0].mode !== ps[0].mode
        || Object.entries(original).some(([channel, value]) => !isDeepStrictEqual(assignments[channel], value))
      if (phase === 1) invalid ||= !isDeepStrictEqual(assignments, original)
      else {
        invalid ||= Object.keys(assignments).length !== Object.keys(original).length + additions.length
          || additions.some(g => original[g.channel] !== undefined || assignments[g.channel]?.delivery !== g.delivery)
        if (phase === 2) grownCount += Object.keys(assignments).length
        else invalid ||= !isDeepStrictEqual(assignments, facts(2, key)[0]?.assignments)
      }
    }
  }
  const failures = keys.reduce((n, key) => n + namedLines(e.failureLog, marker, key).length, 0)
  const failureMissing = !integer(e.probeExit) || !stateRead(e.failureBefore) || !stateRead(e.failureAfter) || !failures
    || !e.failureExpected?.trim() || !keys.some(key => namedLines(e.failureExpected, marker, key).length > 0)
    || !e.failureLog?.split('\n').some(line => line.includes(e.failureExpected!.trim()))
    || !e.phases[4]?.facts || e.phases[4]?.input === undefined
  return [result('shared-list', initialCount, { config_bytes: configBytes, preview_bytes: previewBytes, initial: initialCount, grown: grownCount },
    `channels>=${SR8_SHARED_CHANNELS},bytes>${SR8_LARGE_BYTES}`, missing ? 'missing' : invalid || configBytes <= SR8_LARGE_BYTES || previewBytes <= SR8_LARGE_BYTES ? 'fail' : 'pass'),
  result('shared-list-write-failure', failures, { probe_failed: e.probeExit > 0 ? 'yes' : 'no',
    unchanged: e.failureBefore !== undefined && e.failureBefore === e.failureAfter ? 'yes' : 'no' }, 'preserved',
    e.probeExit === 0 ? 'fail' : failureMissing ? 'missing' : e.failureBefore !== e.failureAfter || invalid ? 'fail' : 'pass')]
}

export interface ScanDiagnostic { complete: boolean; pages: number; reason: string; slack?: string; at: number; deadline: number; next: number; retryAfter: number }
export function scanDiagnostics(log: string | undefined, key: string, incomplete: string, complete: string): ScanDiagnostic[] | undefined {
  if (log === undefined) return undefined
  return log.split('\n').filter(l => [incomplete, complete].some(m => l.includes(`${m} persona=${key}:`))).map(l => {
    const field = (name: string) => l.match(new RegExp(`(?:^| )${name}=([^ .]+(?:\\.[0-9]+)?)(?=[ .]|$)`))?.[1]
    return { complete: l.includes(`${complete} persona=${key}:`), pages: Number(field('pages') ?? NaN), reason: field('reason') ?? '',
      slack: field('slack_error'), at: Date.parse(l.match(/^\[([^\]]+)\]/)?.[1] ?? ''), deadline: Number(field('deadline_at') ?? NaN),
      next: Number(field('next_attempt_at') ?? NaN), retryAfter: Number(field('retry_after_seconds') ?? NaN) }
  })
}
export function membershipFaultVerdicts(kind: string, page: string, key: string, stub: any[] | undefined,
  diagnostics: ScanDiagnostic[] | undefined, before: string | undefined, after: string | undefined,
  retryAfter: number, retryMs: number, requestMs: number, attemptMs: number): Result[] {
  const expected = { hang: ['hang', 'deadline', undefined], transient: ['error', 'transport', 'internal_error'],
    scope: ['error', 'access', 'missing_scope'], denied: ['error', 'authentication', 'invalid_auth'], rate: ['rate_limit', 'transport', undefined] }[kind]
  if (!expected || !['first', 'later'].includes(page)) throw new Error('usage')
  const faults = stub?.filter(r => r.event === 'fault' && r.control === 'faults' && r.method === 'users.conversations' && r.label === key && r.outcome === expected[0]) ?? []
  const observed = diagnostics?.filter(d => d.reason !== 'none') ?? []
  const answers = faults.map(f => stub?.filter(r => r.event === 'api' && r.request_id === f.request_id) ?? [])
  // A later-page invalid_auth is a credentials refusal: connectionChanged
  // resets the scan status (pages=0) before publishing the authentication failure.
  // With pages=0 the diagnostic no longer shows page 1 succeeded, so the stub's
  // request cursor must prove each fault was a later page.
  const laterCursor = answers.length > 0 && answers.every(a => a.length === 1 && typeof a[0].cursor === 'string' && a[0].cursor !== '')
  const matches = observed.filter(d => !d.complete && d.reason === expected[1] && (expected[2] === undefined || d.slack === expected[2])
    && (page === 'first' ? d.pages === 0 : d.pages > 0 || kind === 'denied' && d.pages === 0 && laterCursor))
  let missing = !stub || !diagnostics || faults.length < 2 || !observed.length || !stateRead(before) || !stateRead(after)
    || faults.some(f => !nonnegative(f.arrival_mono_ms) || !nonnegative(f.arrival_epoch_ms) || !f.request_id) || !positive(retryMs) || !positive(requestMs)
  let bad = diagnostics?.some(d => d.complete) === true || (observed.length > 0 && matches.length === 0) || (stateRead(before) && stateRead(after) && before !== after)
  if (kind !== 'hang') {
    if (answers.some(a => a.length !== 1)) missing = true
    bad ||= answers.some(a => a.length === 1 && (kind === 'rate' ? a[0].status !== 429 : a[0].answer !== expected[2]))
  }
  if (kind === 'rate' && (!nonnegative(retryAfter) || !matches.some(d => d.retryAfter === retryAfter))) missing = true
  let faultMissing = missing
  const gaps = faults.slice(1).map((f, i) => f.arrival_mono_ms - faults[i].arrival_mono_ms)
  // Each failure's published next-attempt timestamp binds the next start, too:
  // a hung request must expire BEFORE its retry wait begins. Both are epoch
  // times on the CI container clock; the monotonic gap check remains separate.
  const retryDiagnostics = matches.filter((d, i) => matches.findIndex(m => m.next === d.next) === i)
  if (retryDiagnostics.length < gaps.length || retryDiagnostics.some(d => !nonnegative(d.at) || !nonnegative(d.next))) missing = true
  const early = faults.slice(1).some((f, i) => {
    const d = retryDiagnostics[i], start = f.arrival_epoch_ms, previous = faults[i].arrival_epoch_ms
    if (!nonnegative(start) || !nonnegative(previous)) { missing = true; return false }
    return !!d && (start < d.next || d.at < previous)
  })
  // Response and subsequent request wall stamps share the stub's clock. Never
  // subtract a server timestamp from a stub monotonic timestamp.
  const after429 = kind === 'rate' ? faults.slice(1).map((f, i) => f.arrival_epoch_ms - Date.parse(answers[i][0]?.ts)) : []
  if (after429.some(n => !nonnegative(n))) missing = true
  const requestDurations: number[] = [], attemptDurations: number[] = []
  let deadlineBad = false
  if (kind === 'hang') {
    if (!positive(attemptMs)) faultMissing = true
    const used = new Set<ScanDiagnostic>()
    // A request on an idle scan republishes its status without deadline_at
    // (src/channel-membership-scan.ts request()); only an expiry carries one.
    const expiries = matches.filter(d => Number.isFinite(d.deadline))
    for (const [i, f] of faults.entries()) {
      // Only one staged hung page per attempt. Bind each diagnostic to that
      // request's arrival interval, and require its own abort settlement by ID.
      // D and A are container wall times, never process-relative monotonic times.
      const a = f.arrival_epoch_ms, next = faults[i + 1]?.arrival_epoch_ms ?? Infinity
      const ds = expiries.filter(d => d.at >= a && d.at < next)
      const ss = stub?.filter(r => r.event === 'fault-settled' && r.request_id === f.request_id) ?? []
      if (!nonnegative(a) || ds.length !== 1 || used.has(ds[0]) || ss.length !== 1) { faultMissing = true; continue }
      const d = ds[0], settlement = Date.parse(ss[0].ts)
      used.add(d)
      if (![d.at, d.deadline, d.next, settlement].every(nonnegative) || settlement < a
        || !(ss[0].seq > f.seq) || !positive(attemptMs)) { faultMissing = true; continue }
      const elapsed = d.at - a, attemptStart = d.deadline - attemptMs
      requestDurations.push(elapsed); attemptDurations.push(d.at - attemptStart)
      deadlineBad ||= elapsed - requestMs > SR8_DISPATCH_ALLOWANCE_MS || d.at > d.deadline || a < attemptStart
        || ss[0].resolution !== 'abort'
    }
    if (used.size !== expiries.length) faultMissing = true
    missing ||= faultMissing
  }
  const stats = { case: kind, page, fired: faults.length, incomplete: matches.length,
    max_request_ms: requestDurations.length ? maximum(requestDurations) : 'missing',
    max_attempt_ms: attemptDurations.length ? maximum(attemptDurations) : 'missing', attempt_limit_ms: attemptMs,
    ...(kind === 'hang' ? { excess_ms: requestDurations.length ? maximum(requestDurations) - requestMs : 'missing',
      allowance_ms: SR8_DISPATCH_ALLOWANCE_MS } : {}) }
  return [result('membership-fault', matches.length, stats, kind === 'hang' ? requestMs : 'incomplete', deadlineBad || bad ? 'fail' : faultMissing ? 'missing' : 'pass'),
    result('membership-retry', gaps.length, { case: kind, page, min_ms: gaps.length ? Math.min(...gaps) : 'missing',
      retry_after_ms: kind === 'rate' ? retryAfter * 1000 : 0, after_429_ms: after429.length ? Math.min(...after429) : 0 }, retryMs,
    deadlineBad ? 'fail' : missing ? 'missing' : early || gaps.some(n => n < retryMs) || after429.some(n => n < retryAfter * 1000) ? 'fail' : 'pass')]
}
/** Correlation rows for a membership-fault case that did not pass: the key's
 * users.conversations faults, each fault's settlement and API answer, joined by
 * the fault's ordinal (never its request ID), and every scan diagnostic. Only
 * finite numbers and lower-case code words print; anything else prints
 * `invalid`, so no text, ID, token or error reaches the line. */
export function membershipFaultRows(kind: string, key: string, stub: any[] | undefined, diagnostics: ScanDiagnostic[] | undefined): string[] {
  const num = (v: unknown) => v === undefined ? 'absent' : typeof v === 'number' && Number.isFinite(v) ? String(v) : 'invalid'
  const word = (v: unknown) => v === undefined ? 'absent' : typeof v === 'string' && /^[a-z_]{1,40}$/.test(v) ? v : 'invalid'
  const epoch = (v: unknown) => v === undefined ? 'absent' : num(typeof v === 'string' ? Date.parse(v) : NaN)
  const head = `recorded: sr8 membership-fault-row case=${word(kind)}`
  if (!stub) return [`${head} source=stub rows=unavailable`]
  const faults = stub.filter(r => r?.event === 'fault' && r.method === 'users.conversations' && r.label === key)
  const lines = faults.map((f, i) => `${head} source=fault fault=${i} seq=${num(f.seq)} outcome=${word(f.outcome)} arrival_epoch_ms=${num(f.arrival_epoch_ms)} arrival_mono_ms=${num(f.arrival_mono_ms)}`)
  for (const [i, f] of faults.entries()) {
    const own = (event: string) => typeof f.request_id === 'string' && f.request_id !== '' ? stub.filter(r => r?.event === event && r.request_id === f.request_id) : []
    for (const s of own('fault-settled')) lines.push(`${head} source=fault-settled fault=${i} seq=${num(s.seq)} resolution=${word(s.resolution)} ts_epoch_ms=${epoch(s.ts)}`)
    for (const a of own('api')) lines.push(`${head} source=api fault=${i} status=${num(a.status)} answer=${word(a.answer)} ts_epoch_ms=${epoch(a.ts)}`)
  }
  if (!diagnostics) lines.push(`${head} source=scan rows=unavailable`)
  for (const [i, d] of (diagnostics ?? []).entries()) {
    lines.push(`${head} source=scan scan=${i} at_epoch_ms=${num(d.at)} complete=${d.complete} pages=${num(d.pages)} reason=${word(d.reason || undefined)} slack=${word(d.slack)} deadline_at=${num(d.deadline)} next_attempt_at=${num(d.next)} retry_after_s=${num(d.retryAfter)}`)
  }
  return lines
}
export function membershipRepairVerdict(clearAt: number, diagnostics: ScanDiagnostic[] | undefined, attemptMs: number, retryMaxMs: number): Result {
  const completed = diagnostics?.filter(d => d.complete && d.at >= clearAt) ?? []
  const last = diagnostics?.filter(d => !d.complete && d.at <= clearAt).at(-1)
  const done = completed[0]
  // A refused page (access: missing_scope; authentication: invalid_auth) is
  // published once its attempt has ended, so no deadline remains. Attempts
  // after a refusal revalidate by reconnecting, whose status republication
  // drops deadline_at, so a complete line without one starts at that
  // attempt's own publication, never before the refusal's next_attempt_at.
  const refused = !!last && ['access', 'authentication'].includes(last.reason) && !!last.slack && !finite(last.deadline) && nonnegative(last.next)
  const attempt = refused && done && !finite(done.deadline)
    ? diagnostics!.filter(d => !d.complete && d.reason === 'none' && d.at > clearAt && d.at >= last!.next && d.at <= done.at).at(-1) : undefined
  const scanStart = !done ? NaN : finite(done.deadline) ? done.deadline - attemptMs : attempt ? attempt.at : NaN
  const scan = done ? done.at - scanStart : NaN, elapsed = done ? done.at - clearAt : NaN
  const remaining = last && nonnegative(last.deadline) ? Math.max(0, last.deadline - clearAt) : 0
  const retry = Math.max(retryMaxMs, last && nonnegative(last.retryAfter) ? last.retryAfter * 1000 : 0)
  const bound = remaining + retry + scan
  const missing = !last || !done || !nonnegative(clearAt) || !nonnegative(scan) || !nonnegative(elapsed)
    || (!refused && !nonnegative(last.deadline)) || !positive(attemptMs) || !positive(retryMaxMs)
  return result('membership-repair', done ? 1 : 0, { elapsed_ms: finite(elapsed) ? elapsed : 'missing',
    remaining_ms: remaining, retry_ms: retry, scan_ms: finite(scan) ? scan : 'missing' }, finite(bound) ? bound : 'missing',
    missing ? 'missing' : scan > attemptMs || remaining > attemptMs || elapsed > bound ? 'fail' : 'pass')
}
export function membershipLateVerdict(key: string, request: string, stub: any[] | undefined, completedMark: number,
  diagnostics: ScanDiagnostic[] | undefined, before: string | undefined, after: string | undefined): Result {
  const faults = stub?.filter(r => r.event === 'fault' && r.control === 'faults' && r.method === 'users.conversations'
    && r.label === key && r.request_id === request && r.outcome === 'late') ?? []
  const settled = stub?.filter(r => r.event === 'fault-settled' && r.request_id === request) ?? []
  const answered = stub?.filter(r => r.event === 'api' && r.request_id === request && r.method === 'users.conversations' && r.label === key) ?? []
  const complete = diagnostics?.some(d => d.complete) === true
  const changedCompleteness = complete && diagnostics?.at(-1)?.complete === false
  const late = settled.length === 1 && settled[0].resolution === 'late' && typeof settled[0].socket_open === 'boolean'
    && settled[0].seq > completedMark && answered.length === 1 && answered[0].seq > completedMark
  const missing = !stub || !integer(completedMark) || faults.length !== 1 || !nonnegative(faults[0]?.arrival_mono_ms)
    || !(faults[0]?.seq <= completedMark) || !complete || !late || !stateRead(before) || !stateRead(after)
  return result('membership-late', settled.length, { fired: faults.length, late_after_complete: late ? 'yes' : 'no', unchanged: before !== undefined && before === after ? 'yes' : 'no' }, 'unchanged',
    changedCompleteness || settled.some(s => s.resolution === 'abort') ? 'fail' : missing ? 'missing' : before === after ? 'pass' : 'fail')
}

export function zeroAckVerdict(id: string, times: Times[] | undefined, start: number, end: number, probeExit: number,
  log: string | undefined, marker: string, key: string): Result {
  const found = times?.filter(t => t.envelope_id === id) ?? [], count = found[0]?.acks.length ?? 0
  const missing = found.length !== 1 || !nonnegative(found[0]?.push?.sent_mono_ms) || !positive(end - start)
    || !nonnegative(start) || !integer(probeExit) || !namedLines(log, marker, key).length
  return result('zero-ack', found.length, { acks: count, observed_ms: finite(end - start) ? end - start : 'missing', probe_failed: probeExit > 0 ? 'yes' : 'no' }, 0,
    probeExit === 0 || count > 0 ? 'fail' : missing ? 'missing' : 'pass')
}
export interface AccountedEvent { kind: string; key: string; channel: string; ts: string; envelope_id: string; recovered_id: string; refusal?: string }
export function accountingVerdicts(items: AccountedEvent[] | undefined, stub: any[] | undefined, during: Times[] | undefined,
  final: Times[] | undefined, queues: Record<string, any[] | undefined>, clearMark: number): Result[] {
  const pushes = stub?.filter(r => r.event === 'push') ?? [], ids = items?.flatMap(i => [i.envelope_id, i.recovered_id].filter(id => id !== '-')) ?? []
  const immediate: string[] = [], recovered: string[] = []
  let missing = !items?.length || !stub || !during || !final || !integer(clearMark)
  let invalid = new Set(ids).size !== ids.length || pushes.length !== ids.length || pushes.some(p => !ids.includes(p.envelope_id))
  let stored = 0, withheld = 0
  for (const i of items ?? []) {
    const refused = i.kind === 'refused' || i.kind === 'refused-dropped'
    const deferred = refused || i.kind === 'withheld' || i.kind === 'withheld-dropped'
    const dropped = ['dropped', 'withheld-dropped', 'refused-dropped'].includes(i.kind)
    const pushed = pushes.filter(p => p.envelope_id === i.envelope_id)
    if ((!refused && pushed.length !== 1) || !queues[i.key]) { missing = true; continue }
    if (refused) invalid ||= i.envelope_id !== '-' || !['no-open-socket', 'send-failed'].includes(i.refusal!)
    else invalid ||= pushed[0].label !== i.key || pushed[0].channel !== i.channel || pushed[0].event_ts !== i.ts
    const accept = acceptedFor(queues[i.key], i.channel, i.ts)
    if (dropped) invalid ||= accept.length !== 0
    else if (i.kind === 'stored' || deferred) {
      if (!accept.length) missing = true
      invalid ||= accept.length > 1
      if (accept.length === 1) stored++
    } else missing = true
    if (!deferred) immediate.push(i.envelope_id)
    else {
        withheld++
        const held = during?.filter(t => t.envelope_id === i.envelope_id) ?? []
        const original = final?.filter(t => t.envelope_id === i.envelope_id) ?? []
        const replay = pushes.filter(p => p.envelope_id === i.recovered_id)
        const redelivery = stub?.filter(r => r.event === 'redelivery' && r.envelope_id === i.recovered_id) ?? []
        if ((!refused && (held.length !== 1 || original.length !== 1 || redelivery.length !== 1)) || replay.length !== 1) missing = true
        else {
          invalid ||= replay[0].seq <= clearMark || replay[0].label !== i.key || replay[0].channel !== i.channel || replay[0].event_ts !== i.ts
          if (refused) invalid ||= held.length !== 0 || original.length !== 0 || redelivery.length !== 0
          else invalid ||= held[0].acks.length !== 0 || original[0].acks.length !== 0 || pushed[0].seq > clearMark
            || redelivery[0].original_envelope_id !== i.envelope_id
        }
        recovered.push(i.recovered_id)
    }
    if (!deferred && i.recovered_id !== '-') invalid = true
  }
  // Refused HTTP attempts have no envelope; retain them and independently
  // require the stub's refusal counts. Never invent an original envelope ID.
  invalid ||= (stub?.filter(r => r.event === 'push-refused').length ?? 0) !== (items?.filter(i => i.kind.startsWith('refused')).length ?? 0)
  for (const key of new Set(items?.map(i => i.key))) for (const reason of ['no-open-socket', 'send-failed']) {
    const expected = items?.filter(i => i.key === key && i.kind.startsWith('refused') && i.refusal === reason).length ?? 0
    const actual = stub?.filter(r => r.event === 'push-refused' && r.label === key && r.reason === reason && r.seq <= clearMark).length ?? 0
    if (expected !== actual) invalid = true
  }
  const results = [result('accounting', pushes.length, { expected: ids.length, stored, withheld }, 'all-pushes', missing ? 'missing' : invalid ? 'fail' : 'pass')]
  if (immediate.length) results.push(ackVerdict('accounting-ack', immediate, final))
  if (recovered.length) results.push(ackVerdict('recovered-ack', recovered, final))
  return results
}
export function personaStoreVerdicts(rows: Measurement[] | undefined, accepted: Accepted[], keys: string[], percentile: (ns: number[], q: number) => number): Result[] {
  return [storeVerdict(rows, accepted, percentile), ...keys.map((key, i) => {
    const r = storeVerdict(rows, accepted.filter(a => a.key === key), percentile)
    r.stats.persona = i + 1; return r
  })]
}
export interface LookupProbe { key: string; method: string; outcome: string; match: string; envelope_id: string }
export function lookupFaultVerdicts(probes: LookupProbe[] | undefined, stub: any[] | undefined, times: Times[] | undefined): Result[] {
  let missing = !probes?.length || !stub, fired = 0
  for (const p of probes ?? []) {
    const matches = stub?.filter(r => r.event === 'fault' && r.control === 'faults' && r.label === p.key && r.method === p.method
      && r.match === p.match && r.outcome === p.outcome && nonnegative(r.arrival_mono_ms)) ?? []
    if (!['users.info', 'conversations.info'].includes(p.method) || !['hang', 'late'].includes(p.outcome) || matches.length !== 1) missing = true
    else fired++
  }
  return [result('lookup-faults', probes?.length ?? 0, { fired, required: probes?.length ?? 0 }, 'every-fault', missing ? 'missing' : 'pass'),
    ackVerdict('lookup-ack', probes?.map(p => p.envelope_id) ?? [], times)]
}

export function orderedWriteVerdicts(before: any[] | undefined, after: any[] | undefined, reopened: any[] | undefined,
  expected: { channel: string; delivery: string }[] | undefined, results: any[] | undefined,
  stub: any[] | undefined, submitMark: number, resultMark: number, times: Times[] | undefined): Result[] {
  const pushes = stub?.filter(r => r.event === 'push') ?? [], ids = pushes.map(p => p.envelope_id)
  const acks = stub?.filter(r => r.event === 'ws-message' && ids.includes(r.envelope_id)) ?? []
  const added = after?.slice(before?.length ?? 0) ?? []
  const missing = !before || !after || !reopened || !expected?.length || !results?.length || !stub || !pushes.length || !acks.length
    || !integer(submitMark) || !integer(resultMark) || added.length !== expected?.length || results?.length !== expected?.length
    || after.some(r => !integer(r.startedOrder) || !integer(r.resolvedOrder))
  const overlap = pushes.some(p => p.seq <= submitMark) && acks.some(a => a.seq > resultMark) && resultMark >= submitMark
  const order = after?.every((r, i) => r.startedOrder <= r.resolvedOrder && (i === 0 ||
    (r.startedOrder > after[i - 1].startedOrder && r.resolvedOrder > after[i - 1].resolvedOrder))) === true
  const retained = isDeepStrictEqual(before, after?.slice(0, before?.length)) && isDeepStrictEqual(after, reopened)
  const choices = added.every((r, i) => r.channel === expected?.[i]?.channel && r.delivery === expected?.[i]?.delivery)
  const seq = (rows: any[], pick: (s: number[]) => number) => {
    const s = rows.map(r => r.seq).filter(integer)
    return s.length ? pick(s) : 'missing'
  }
  const observed = { first_push_seq: seq(pushes, s => Math.min(...s)), last_push_seq: seq(pushes, s => Math.max(...s)),
    first_ack_seq: seq(acks, s => Math.min(...s)), last_ack_seq: seq(acks, s => Math.max(...s)),
    submit_seq: integer(submitMark) ? submitMark : 'missing', result_seq: integer(resultMark) ? resultMark : 'missing' }
  return [result('ordered-writes', added.length, { overlap: overlap ? 'yes' : 'no', retained: retained ? 'yes' : 'no', ordered: order ? 'yes' : 'no', ...observed }, 'durable-order',
    missing ? 'missing' : !overlap || !order || !retained || !choices || results!.some(r => r.isError !== false || r.error !== undefined) ? 'fail' : 'pass'),
    ackVerdict('ordered-write-ack', ids, times)]
}
export interface MembershipWrite { kind: string; envelope_id: string; event_id: string; stage_seq: string }
export interface MembershipWriteStates { before?: any[]; leave?: any[]; join?: any[]; reopened?: any[]; events?: any[]; eventsReopened?: any[] }
/** Strict ordered writes: the writer's live leave then qualifying rejoin of one channel. */
export function membershipWriteVerdicts(keys: string[], writer: string, channel: string, mode: string, states: MembershipWriteStates,
  writes: MembershipWrite[] | undefined, stub: any[] | undefined, submitMark: number, resultMark: number,
  times: Times[] | undefined, writeTimes: Times[] | undefined): Result[] {
  const facts = (rows: any[] | undefined, key: string) => {
    const found = rows?.filter(r => r.key === key) ?? []
    return found.length === 1 && object(found[0].assignments) && object(found[0].leaves) && object(found[0].historicalMembership) ? found[0] : undefined
  }
  const writeIds = writes?.map(w => w.envelope_id) ?? []
  const pushes = stub?.filter(r => r.event === 'push' && r.label === writer) ?? []
  const burst = pushes.filter(p => !writeIds.includes(p.envelope_id)), burstIds = burst.map(p => p.envelope_id)
  const acks = stub?.filter(r => r.event === 'ws-message' && burstIds.includes(r.envelope_id)) ?? []
  const q = (['before', 'leave', 'join', 'reopened'] as const).map(phase => facts(states[phase], writer))
  const others = keys.filter(k => k !== writer)
  const missing = !keys.includes(writer) || !others.length || q.some(f => !f) || !stub || !burst.length || !acks.length
    || writes?.length !== 2 || !integer(submitMark) || !integer(resultMark) || states.events?.length !== 2 || states.eventsReopened?.length !== 2
    || (['before', 'join', 'reopened'] as const).some(phase => others.some(k => !facts(states[phase], k)))
  const [before, left, joined, reopened] = q
  // Unrelated state: every persona's choices, leaves and identity, except the writer's write channel.
  const unrelated = (f: any, key: string) => {
    if (!f) return undefined
    const assignments = { ...f.assignments }, leaves = { ...f.leaves }
    if (key === writer) { delete assignments[channel]; delete leaves[channel] }
    return { mode: f.mode, incarnation: f.incarnation, assignments, leaves, removedDestinations: f.removedDestinations, threadMemoryCreated: f.threadMemoryCreated }
  }
  const membership = (f: any) => f?.historicalMembership?.[channel] ? { member: f.historicalMembership[channel].member, boundary: f.historicalMembership[channel].boundary } : undefined
  const retained = !missing && keys.every(k => {
    const phases = (k === writer ? ['before', 'leave', 'join', 'reopened'] : ['before', 'join', 'reopened']) as (keyof MembershipWriteStates)[]
    const base = unrelated(facts(states.before, k), k)
    return phases.every(phase => isDeepStrictEqual(unrelated(facts(states[phase], k), k), base))
  }) && isDeepStrictEqual(reopened.assignments[channel], joined.assignments[channel])
    && isDeepStrictEqual(reopened.leaves[channel], joined.leaves[channel]) && isDeepStrictEqual(membership(reopened), membership(joined))
  const prior = before?.assignments[channel], leave = left?.leaves[channel], rejoined = joined?.assignments[channel]
  const fresh = mode === 'open' ? 'mentions' : 'off'
  const ordered = !missing && writes!.map(w => w.kind).join(',') === 'leave,join'
    && object(prior) && integer(prior.order) && membership(before)?.member === true
    && left.assignments[channel] == null && object(leave) && typeof leave.event === 'string' && !leave.event.startsWith('scan:')
    && leave.event === writes![0].event_id && integer(leave.boundary) && leave.boundary > prior.order && leave.incarnation === before.incarnation
    && !isDeepStrictEqual(leave, before.leaves[channel]) && leave.boundary > (before.leaves[channel]?.boundary ?? 0)
    && isDeepStrictEqual(membership(left), { member: false, boundary: leave.boundary })
    && object(rejoined) && integer(rejoined.order) && rejoined.order > leave.boundary
    && isDeepStrictEqual(rejoined, { delivery: fresh, order: rejoined.order })
    && isDeepStrictEqual(joined.leaves[channel], leave) && isDeepStrictEqual(membership(joined), { member: true, boundary: rejoined.order })
    // The live events themselves, not a scan's, applied the leave and the rejoin.
    && writes![1].event_id !== writes![0].event_id && isDeepStrictEqual(states.events, [
      { kind: 'leave', event_id: writes![0].event_id, applied: { channel, member: false, order: leave.boundary, boundary: leave.boundary } },
      { kind: 'join', event_id: writes![1].event_id, applied: { channel, member: true, order: rejoined.order, boundary: rejoined.order } }])
    && isDeepStrictEqual(states.eventsReopened, states.events)
  // Each write is its own acknowledged envelope, in order, inside the marks,
  // after the writer's inventory was staged to agree and before a scan of it.
  const event = { leave: 'channel_left', join: 'member_joined_channel' } as Record<string, string>
  const firstPages = stub?.filter(r => r.event === 'api' && r.method === 'users.conversations' && r.label === writer && r.cursor === '') ?? []
  let acked = !missing && new Set(writeIds).size === 2, staged = !missing, previous = submitMark
  for (const [i, w] of (missing ? [] : writes!).entries()) {
    const push = pushes.filter(p => p.envelope_id === w.envelope_id), ack = stub!.filter(r => r.event === 'ws-message' && r.envelope_id === w.envelope_id)
    const stage = Number(w.stage_seq), next = i + 1 < writes!.length ? Number(writes![i + 1].stage_seq) : Infinity
    acked &&= push.length === 1 && ack.length === 1 && push[0].channel === channel && push[0].event_type === event[w.kind]
      && push[0].seq > previous && ack[0].seq > push[0].seq && ack[0].seq <= resultMark
    staged &&= integer(stage) && stage > previous && stage < (push[0]?.seq ?? -Infinity)
      && stub!.some(r => r.event === 'inventory' && r.seq === stage && r.label === writer)
      && firstPages.some(r => r.seq > push[0].seq && r.seq < next)
    previous = ack[0]?.seq ?? Infinity
  }
  // Replacing the control would reset the burst's fault counters.
  staged &&= !stub?.some(r => r.event === 'control' && r.seq > submitMark && r.seq <= resultMark)
  const overlap = burst.some(p => p.seq <= submitMark) && acks.some(a => a.seq > resultMark) && resultMark >= submitMark
  return [result('ordered-writes', missing ? 0 : 2, { overlap: overlap ? 'yes' : 'no', retained: retained ? 'yes' : 'no', ordered: ordered ? 'yes' : 'no', acked: acked ? 'yes' : 'no', staged: staged ? 'yes' : 'no' },
    'durable-order', missing ? 'missing' : !overlap || !retained || !ordered || !acked || !staged ? 'fail' : 'pass'),
    ackVerdict('ordered-write-ack', burstIds, times), ackVerdict('membership-write-ack', writeIds, writeTimes)]
}

export interface FaultItem extends BurstItem { ordinal: number; root: string; dependent: boolean }
export interface FaultPlan { kind: string; key: string; keys: string[]; all: boolean; channels: string[]; items: FaultItem[] }
export interface FaultPush { ordinal: number; stage: 'original' | 'replay'; envelope_id?: string; refusal?: string }
export interface FaultLoadEvidence {
  plan: FaultPlan; ledger?: FaultPush[]; stub?: any[]; during?: Times[]; times?: Times[]
  queues: Record<string, any[] | undefined>; duringQueues: Record<string, any[] | undefined>
  rows?: Measurement[]; clearMark: number; clearAt: number
}
const eventIdentity = (i: Pick<BurstItem, 'key' | 'channel' | 'ts'>) => JSON.stringify([i.key, i.channel, i.ts])
const faultOutcomes: Record<string, string> = { hang: 'hang', transient: 'error', scope: 'error', denied: 'error', rate: 'rate_limit', late: 'late', lookup: 'hang' }
const depends = (plan: FaultPlan, item: BurstItem) => item.key === plan.key && (plan.all || plan.channels.includes(item.channel))

/** Expected withholding never prevents the second wave, including its replies. */
/** Q's last independent replies, sent only after the ordered writes' result
 * mark so Q's burst ACKs continue past it. The burst's total size is unchanged. */
export const SR8_FAULT_TAIL_ITEMS = 8
export function faultTail(plan: FaultPlan): FaultItem[] {
  return plan.items.filter(i => i.phase === 'replies' && i.key !== plan.key && !i.dependent).slice(-SR8_FAULT_TAIL_ITEMS)
}
/** Open mode only: strict keeps its whole second wave concurrent. */
export function faultTailOption(mode: Context['mode'], plan: FaultPlan, released: () => Promise<boolean>) {
  return mode === 'open' ? { items: faultTail(plan), released } : undefined
}
export async function faultWaves(items: FaultItem[], send: (item: FaultItem) => Promise<void>, wait: (items: FaultItem[]) => Promise<boolean>,
  admitHeld: (items: FaultItem[]) => Promise<boolean>, tail?: { items: FaultItem[]; released: () => Promise<boolean> },
  mark: (wave: string) => void = () => {}): Promise<boolean> {
  const held = items.filter(i => i.phase === 'held')
  if (held.length) mark('held')
  await Promise.all(held.map(send))
  if (held.length && (!await wait(held.filter(i => !i.dependent)) || !await admitHeld(held.filter(i => !i.dependent)))) return false
  const roots = items.filter(i => i.phase === 'roots')
  mark('roots')
  await Promise.all(roots.map(send))
  if (!await wait(roots.filter(i => !i.dependent))) return false
  const rest = items.filter(i => !['roots', 'held'].includes(i.phase))
  const late = new Set(tail?.items.map(i => i.ordinal))
  mark('replies-drops')
  await Promise.all(rest.filter(i => !late.has(i.ordinal)).map(send))
  const released = !tail || await tail.released()
  await Promise.all(rest.filter(i => late.has(i.ordinal)).map(send))
  return await wait(rest.filter(i => !i.dependent)) && released
}

export function postHoldOverlapVerdicts(rows: Measurement[] | undefined, holds: Accepted[], ordinary: (Accepted & { envelope_id?: string })[], times: Times[] | undefined): Result[] {
  let missing = !rows || !holds.length
  const intervals: { key: string; start: number; end: number }[] = []
  for (const h of holds) {
    const start = rows?.filter(r => r.key === h.key && r.seq === h.seq && r.kind === 'store' && r.store === 'post-hold') ?? []
    const end = rows?.filter(r => r.key === h.key && r.seq === h.seq && r.kind === 'post-hold-resolved') ?? []
    if (start.length !== 1 || end.length !== 1 || !nonnegative(start[0].at_mono_ms) || !(end[0].at_mono_ms > start[0].at_mono_ms)) missing = true
    else intervals.push({ key: h.key, start: start[0].at_mono_ms, end: end[0].at_mono_ms })
  }
  const during = (a: Accepted, h: { key: string; start: number; end: number }) => {
    const stores = rows?.filter(r => r.kind === 'store' && r.store === 'accepted' && r.key === a.key && r.seq === a.seq) ?? []
    return stores.length === 1 && h.key === a.key && stores[0].at_mono_ms > h.start && stores[0].at_mono_ms < h.end
  }
  const covered = intervals.filter(h => ordinary.some(a => during(a, h))).length
  const overlapping = ordinary.filter(a => intervals.some(h => during(a, h)))
  return [result('post-hold-overlap', overlapping.length, { holds: intervals.length, covered_holds: covered, ordinary: overlapping.length }, 'ordinary-during-each-hold',
    missing || covered !== holds.length ? 'missing' : 'pass'), ackVerdict('post-hold-overlap-ack', overlapping.map(a => a.envelope_id), times)]
}

export function faultOverlapVerdict(plan: FaultPlan, ledger: FaultPush[] | undefined, stub: any[] | undefined, clearAt: number): Result {
  const qIds = new Set(ledger?.filter(l => l.stage === 'original' && plan.items.some(i => i.ordinal === l.ordinal && i.key !== plan.key)).map(l => l.envelope_id))
  const pushes = stub?.filter(r => r.event === 'push' && qIds.has(r.envelope_id)) ?? []
  const acks = stub?.filter(r => r.event === 'ws-message' && qIds.has(r.envelope_id)) ?? []
  const qStart = pushes.length ? Math.min(...pushes.map(r => Date.parse(r.ts))) : NaN
  const qEnd = acks.length ? Math.max(...acks.map(r => Date.parse(r.ts))) : NaN
  const faults = stub?.filter(r => r.event === 'fault' && r.control === 'faults' && r.label === plan.key
    && (plan.kind === 'lookup' ? ['users.info', 'conversations.info'].includes(r.method) && ['hang', 'late'].includes(r.outcome)
      : r.method === 'users.conversations' && r.outcome === faultOutcomes[plan.kind])) ?? []
  let overlap = 0, missing = !nonnegative(clearAt) || !nonnegative(qStart) || !(qEnd > qStart) || !faults.length
  for (const f of faults) {
    const settled = stub?.filter(r => r.event === 'fault-settled' && r.request_id === f.request_id) ?? []
    const start = Date.parse(f.ts), end = settled.length === 1 ? Math.min(clearAt, Date.parse(settled[0].ts)) : clearAt
    if (!f.request_id || settled.length > 1 || !nonnegative(start) || !(end >= start)) { missing = true; continue }
    overlap += Math.max(0, Math.min(end, qEnd) - Math.max(start, qStart))
  }
  return result('fault-overlap', faults.length, { overlap_ms: overlap, q_start_ms: finite(qStart) ? qStart : 'missing', q_end_ms: finite(qEnd) ? qEnd : 'missing' },
    'fault-during-q', missing || overlap <= 0 ? 'missing' : 'pass')
}

export function faultLoadVerdicts(e: FaultLoadEvidence, counts: { roots: number; replies: number; dropped: number }, holdMs: number,
  percentile: (ns: number[], q: number) => number): Result[] {
  const { plan, ledger, queues, duringQueues, rows } = e, items = plan.items
  let missing = !ledger || !e.stub || !e.during || !e.times || !rows || !integer(e.clearMark)
    || !items.length || plan.keys.length < 2 || !plan.keys.includes(plan.key)
  let invalid = !Object.hasOwn(faultOutcomes, plan.kind) || (plan.kind === 'denied' && !plan.all)
    || new Set(items.map(eventIdentity)).size !== items.length || new Set(items.map(i => i.ordinal)).size !== items.length
    || items.some(i => i.dependent !== depends(plan, i) || !plan.keys.includes(i.key))
    || (ledger?.some(l => !items.some(i => i.ordinal === l.ordinal) || !['original', 'replay'].includes(l.stage)) ?? false)
  for (const key of plan.keys) for (const phase of ['roots', 'replies', 'dropped'] as const)
    if (items.filter(i => i.key === key && i.phase === phase).length !== counts[phase]) missing = true
  const accepted: Accepted[] = [], holds: Accepted[] = [], ordinary: (Accepted & { envelope_id?: string })[] = []
  const accounts: AccountedEvent[] = [], immediate: FaultItem[] = []
  let withheldMissing = false, withheldBad = false, dependent = 0, refusedCount = 0, storeComplete = true
  const original = (i: FaultItem) => ledger?.filter(l => l.stage === 'original' && l.ordinal === i.ordinal) ?? []
  for (const i of items) {
    const orig = original(i), replay = ledger?.filter(l => l.stage === 'replay' && l.ordinal === i.ordinal) ?? []
    if (orig.length !== 1) { missing = true; continue }
    const o = orig[0], refused = o.refusal !== undefined
    if ((!o.envelope_id && !refused) || (i.dependent && replay.length !== 1)) missing = true
    if ((!i.dependent && replay.length) || (refused && (plan.kind !== 'denied' || !i.dependent || !!o.envelope_id))) invalid = true
    const kind = i.dependent ? (refused ? 'refused' : 'withheld') + (i.phase === 'dropped' ? '-dropped' : '') : i.phase === 'dropped' ? 'dropped' : 'stored'
    accounts.push({ kind, key: i.key, channel: i.channel, ts: i.ts, envelope_id: o.envelope_id ?? '-', recovered_id: replay[0]?.envelope_id ?? '-', refusal: o.refusal })
    if (i.dependent) {
      dependent++; if (refused) refusedCount++
      if (!duringQueues[i.key]) withheldMissing = true
      if (acceptedFor(duringQueues[i.key], i.channel, i.ts).length) withheldBad = true
      if (!refused) {
        const seen = e.during?.filter(t => t.envelope_id === o.envelope_id) ?? []
        if (seen.length !== 1) withheldMissing = true
        else if (seen[0].acks.length !== 0) withheldBad = true
      }
    } else immediate.push(i)
    if (!queues[i.key]) storeComplete = false
    if (i.phase === 'dropped') continue
    const found = acceptedFor(queues[i.key], i.channel, i.ts)
    if (found.length !== 1) { storeComplete = false; continue }
    const a = { key: i.key, seq: found[0].seq }
    accepted.push(a)
    if (i.phase === 'held' || found[0].hold?.on === 'post' || rows?.some(r => r.kind === 'store' && r.store === 'post-hold' && r.key === a.key && r.seq === a.seq)) holds.push(a)
    else ordinary.push({ ...a, envelope_id: i.dependent ? replay[0]?.envelope_id : o.envelope_id })
  }
  const results = [result('fault-workload', items.length, { originals: ledger?.filter(l => l.stage === 'original').length ?? 0,
    dependent, refused: refusedCount, roots: counts.roots, replies: counts.replies, dropped: counts.dropped }, 'every-planned-item', invalid ? 'fail' : missing ? 'missing' : 'pass'),
    result('fault-withheld', dependent, { refused: refusedCount }, 'zero-ack-and-unstored', withheldBad ? 'fail' : withheldMissing ? 'missing' : 'pass'),
    faultOverlapVerdict(plan, ledger, e.stub, e.clearAt),
    ...accountingVerdicts(accounts, e.stub, e.during, e.times, queues, e.clearMark)]
  // The ordinary ACK, drop and store predicates are also used by check.
  // Original and replay identities remain separate in accounts and the ledger.
  for (const [n, key] of plan.keys.entries()) for (const dropped of [false, true]) {
    const group = immediate.filter(i => i.key === key && (i.phase === 'dropped') === dropped)
    if (!group.length && key === plan.key) continue
    const r = ackVerdict(dropped ? 'ack-dropped' : 'ack-accepted', group.map(i => original(i)[0]?.envelope_id), e.times)
    r.stats.persona = n + 1
    if (dropped && group.some(i => acceptedFor(queues[key], i.channel, i.ts).length > 0)) r.verdict = 'fail'
    results.push(r)
  }
  results.push(...personaStoreVerdicts(storeComplete ? rows : undefined, accepted, plan.keys, percentile), postHoldVerdict(rows, holds, holdMs))
  if (items.some(i => i.phase === 'held')) results.push(...postHoldOverlapVerdicts(rows, holds, ordinary, e.times))
  return results
}
/** fault-check's compaction window: Q's original burst, the items fault-burst
 * observes, by their own acceptance stores. P's items and recovery replays never
 * bound it. Pure. */
export function faultWindow(e: FaultLoadEvidence): ServerWindow | undefined {
  const accepted: Accepted[] = []
  for (const i of e.plan.items.filter(i => i.key !== e.plan.key && i.phase !== 'dropped')) {
    const found = acceptedFor(e.queues[i.key], i.channel, i.ts)
    if (found.length !== 1) return undefined
    accepted.push({ key: i.key, seq: found[0].seq })
  }
  return storeWindow(e.rows, accepted)
}
/** fault-check's personas that must rewrite inside Q's window: those with stored
 * burst items there, Q always and P only when the plan has an independent
 * accepted P item (never under `all`). A P whose every item is withheld has no
 * Thread Memory change in the window, so its passes there correctly skip
 * (answers28). Pure. */
export function faultRewriters(plan: FaultPlan): string[] {
  return plan.keys.filter(key => key !== plan.key || plan.items.some(i => i.key === key && !i.dependent && i.phase !== 'dropped'))
}

// CLI adapters. Errors never echo raw evidence, event text, credentials or exceptions.
const pkg = () => resolve(process.env.CSCB_PKG_DIR ?? '/test-repo/node_modules/claude-slack-channel-bots')
const fixture = (name: string) => join(import.meta.dir, name)
function printer(name: string, ...args: string[]): string {
  return execFileSync(process.execPath, [fixture('fmk-texts.ts'), name, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
const population = () => import('../../test-helpers/thread-populations.ts')
function jsonl(path: string, offset = 0, requireNewline = false): any[] | undefined {
  try {
    const bytes = readFileSync(path)
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length) return undefined
    const text = bytes.subarray(offset).toString('utf8')
    if (requireNewline && text && !text.endsWith('\n')) return undefined
    return text.split('\n').filter(Boolean).map(l => JSON.parse(l))
  } catch { return undefined }
}
function textFile(path: string): string | undefined { try { return readFileSync(path, 'utf8') } catch { return undefined } }
function evidenceRows(path: string): any[] | undefined {
  const rows = jsonl(path, 0, true)
  return records(rows) ? rows : undefined
}
function timingRows(path: string): Times[] | undefined {
  const rows = evidenceRows(path)
  return rows?.every(r => typeof r.envelope_id === 'string' && object(r.push) && nonnegative(r.push.sent_mono_ms)
    && r.push.connection_id !== undefined && records(r.acks) && r.acks.every((a: any) => nonnegative(a.ack_mono_ms) && a.connection_id !== undefined)) ? rows : undefined
}
type EvidenceReason = 'timing-ids-invalid' | 'stub-record-invalid' | 'stub-observation-unavailable'
  | 'timing-push-missing' | 'timing-push-duplicate' | 'timing-monotonic-missing'
  | 'recovery-ledger-invalid' | 'recovery-payload-invalid' | 'recovery-deadline'
  | 'recovery-push-failed' | 'recovery-duplicate-envelope' | 'recovery-ack-invalid'
  | 'recovery-root-order' | 'recovery-unrecorded-envelope' | 'recovery-push-invalid'
class EvidenceFailure extends Error {
  constructor(readonly reason: EvidenceReason) { super(reason) }
}
interface StubIndex { pushes: Map<string, any[]>; acks: Map<string, any[]> }
const stubIndex = (): StubIndex => ({ pushes: new Map(), acks: new Map() })
function indexStub(index: StubIndex, row: any): void {
  if (!object(row) || typeof row.event !== 'string') throw new EvidenceFailure('stub-record-invalid')
  if (row.event !== 'push' && row.event !== 'ws-message') return
  if (row.event === 'ws-message' && row.envelope_id === null) return
  if (typeof row.envelope_id !== 'string' || !row.envelope_id) throw new EvidenceFailure('stub-record-invalid')
  const map = row.event === 'push' ? index.pushes : index.acks
  const rows = map.get(row.envelope_id) ?? []
  rows.push(row); map.set(row.envelope_id, rows)
}
function parseStubLine(line: string): any {
  try { return JSON.parse(line) } catch { throw new EvidenceFailure('stub-record-invalid') }
}
function indexedTiming(index: StubIndex, id: string): Times {
  const pushes = index.pushes.get(id) ?? [], acks = index.acks.get(id) ?? []
  if (!pushes.length) throw new EvidenceFailure('timing-push-missing')
  if (pushes.length !== 1) throw new EvidenceFailure('timing-push-duplicate')
  if (!finite(pushes[0].sent_mono_ms) || acks.some(r => !finite(r.ack_mono_ms))) throw new EvidenceFailure('timing-monotonic-missing')
  // Match jq's field projection (absent connection_id is null), including ACK
  // multiplicity and record order. Extraction applies no N1/accounting verdict.
  return { envelope_id: id, push: { sent_mono_ms: pushes[0].sent_mono_ms, connection_id: pushes[0].connection_id ?? null },
    acks: acks.map(r => ({ ack_mono_ms: r.ack_mono_ms, connection_id: r.connection_id ?? null })) }
}
export function envelopeTimings(ids: string[], rows: any[]): Times[] {
  if (ids.some(id => !id || id.trim() !== id || /\s/.test(id))) throw new EvidenceFailure('timing-ids-invalid')
  const index = stubIndex()
  for (const row of rows) indexStub(index, row)
  return ids.map(id => indexedTiming(index, id))
}
function bulkTimings(args: string[]): number {
  countArgs(args, 2)
  let ids: string, observation: string
  try { ids = readFileSync(args[0], 'utf8'); observation = readFileSync(args[1], 'utf8') }
  catch { throw new EvidenceFailure('stub-observation-unavailable') }
  if (ids && !ids.endsWith('\n')) throw new EvidenceFailure('timing-ids-invalid')
  if (observation && !observation.endsWith('\n')) throw new EvidenceFailure('stub-record-invalid')
  const requested = ids ? ids.slice(0, -1).split('\n').map(s => s.endsWith('\r') ? s.slice(0, -1) : s) : []
  const rows = observation ? observation.slice(0, -1).split('\n').map(parseStubLine) : []
  // Validate everything before emitting any rows, so a later missing push cannot
  // leave an apparently successful prefix. Duplicated requested IDs stay duplicated.
  for (const row of envelopeTimings(requested, rows)) console.log(JSON.stringify(row))
  return 0
}

/** One file descriptor and incremental complete lines for the whole recovery.
 * A live partial line waits for its newline; replacement/truncation fails closed. */
function recoveryObserver(path: string, index: StubIndex) {
  let fd: number
  let identity: ReturnType<typeof statSync>
  try {
    identity = statSync(path)
    if (!identity.isFile()) throw new EvidenceFailure('stub-observation-unavailable')
    fd = openSync(path, 'r')
  } catch { throw new EvidenceFailure('stub-observation-unavailable') }
  let offset = 0, tail = Buffer.alloc(0)
  const read = () => {
    const current = statSync(path)
    if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino || current.size < offset)
      throw new EvidenceFailure('stub-observation-unavailable')
    const bytes = Buffer.alloc(current.size - offset)
    let used = 0
    while (used < bytes.length) {
      const n = readSync(fd, bytes, used, bytes.length - used, offset + used)
      if (!n) throw new EvidenceFailure('stub-observation-unavailable')
      used += n
    }
    offset += used
    const pending = Buffer.concat([tail, bytes]), end = pending.lastIndexOf(10)
    if (end < 0) { tail = pending; return }
    for (const line of pending.subarray(0, end).toString('utf8').split('\n')) indexStub(index, parseStubLine(line))
    tail = pending.subarray(end + 1)
  }
  return { read, close: () => closeSync(fd), complete: () => tail.length === 0 }
}
function tsv(path: string, names: string[]): any[] | undefined {
  const text = textFile(path)
  if (text === undefined || (text !== '' && !text.endsWith('\n'))) return undefined
  const rows = text.split('\n').filter(Boolean).map(l => l.split('\t'))
  return rows.every(r => r.length === names.length && r.every(v => v !== '')) ? rows.map(r => Object.fromEntries(names.map((n, i) => [n, r[i]]))) : undefined
}
const numeric = (raw: string | undefined) => raw?.trim() ? Number(raw) : NaN
function diagnostics(path: string, key: string) {
  return scanDiagnostics(textFile(path), key, printer('MEMBERSHIP_INVENTORY_INCOMPLETE'), printer('MEMBERSHIP_INVENTORY_COMPLETE'))
}
async function additional(command: string, c: Context, args: string[]): Promise<Result[] | undefined> {
  if (command === 'pending-post') {
    countArgs(args, 18)
    const [key, operation, start, end, before, after, probes, queue, times, measurement, mark, channel,
      burstDir, startSeq, endSeq, compact, measuredStart, windowEnd] = args
    const ps = tsv(probes, ['parent', 'channel', 'ts', 'envelope_id']) as PendingProbe[] | undefined
    // A named channel fixes this case independently of the journal contents.
    const b = evidenceRows(before), a = evidenceRows(after)
    const belongs = b?.filter(r => r.kind === 'post-intent' && r.operationId === operation).every(r => r.channel === channel)
    const p = await population(), keys = p.sr8Personas(c.recipients), timing = timingRows(times)
    const items = evidenceRows(join(burstDir, 'burst.jsonl')) as BurstItem[] | undefined
    const queues = Object.fromEntries(keys.map(k => [k, evidenceRows(join(burstDir, `${k}.queue.jsonl`))]))
    const acks = burstAckVerdicts(keys, items, timing, queues, { roots: p.SR8_BURST_JOINS, replies: p.SR8_BURST_REPLIES, dropped: p.SR8_BURST_DROPPED })
    // check's store verdict catches an absent queue; here no drop can be proved unstored.
    if (keys.some(k => !queues[k])) acks[1].verdict = 'missing'
    return [...pendingPostVerdicts(key, operation, numeric(start), numeric(end), belongs ? b : undefined, a, ps,
      evidenceRows(queue), timing, measurements(measurement, numeric(mark)), Number(printer('THREAD_REPLY_HOLD_MS'))),
    ...acks,
    pendingBurstVerdict(items, evidenceRows(join(burstDir, 'final-stub.jsonl')), ps, { startSeq: numeric(startSeq), endSeq: numeric(endSeq),
      compactMs: numeric(compact), startMs: numeric(measuredStart), endMs: numeric(windowEnd),
      before: textFile(join(burstDir, 'before.journal')), after: textFile(join(burstDir, 'after.journal')) })]
  }
  if (command === 'shared-list') {
    countArgs(args, 2)
    const [dir, probe] = args, p = await population(), path = (name: string) => join(dir, name)
    return sharedListVerdicts({ prepared: textFile(path('prepared.input')), preview: textFile(path('ordinary.preview')),
      growth: tsv(path('growth.tsv'), ['key', 'channel', 'delivery']),
      phases: ['applied', 'restarted', 'grown', 'reopened', 'failed'].map(phase => ({ facts: evidenceRows(path(`${phase}.facts.jsonl`)), input: textFile(path(`${phase}.input`)) })),
      failureBefore: textFile(path('failure-before.state')), failureAfter: textFile(path('failure-after.state')),
      failureLog: textFile(path('failure.log')), failureExpected: textFile(path('failure.expected')),
      probeExit: numeric(probe) }, p.sr8Personas(c.recipients), printer('MEMBERSHIP_STORAGE_FAILED'))
  }
  if (command === 'membership-fault') {
    countArgs(args, 9)
    const [kind, page, key, stub, log, before, after, retryAfter, failures] = args
    const failureCount = numeric(failures)
    const wait = integer(failureCount) ? Number(printer('membershipRetryDelay', failures,
      ...(kind === 'rate' && nonnegative(numeric(retryAfter)) ? [retryAfter] : []))) : NaN
    const rows = evidenceRows(stub), scans = diagnostics(log, key)
    const results = membershipFaultVerdicts(kind, page, key, rows, scans, textFile(before), textFile(after),
      numeric(retryAfter), wait, Number(printer('MEMBERSHIP_REQUEST_TIMEOUT_MS')), Number(printer('MEMBERSHIP_ATTEMPT_TIMEOUT_MS')))
    if (results.some(r => r.verdict !== 'pass')) for (const line of membershipFaultRows(kind, key, rows, scans)) console.log(line)
    return results
  }
  if (command === 'membership-repair') {
    countArgs(args, 3)
    return [membershipRepairVerdict(numeric(args[1]), diagnostics(args[2], args[0]), Number(printer('MEMBERSHIP_ATTEMPT_TIMEOUT_MS')), Number(printer('MEMBERSHIP_RETRY_MAX_MS')))]
  }
  if (command === 'membership-late') {
    countArgs(args, 7)
    const [key, request, stub, mark, log, before, after] = args
    return [membershipLateVerdict(key, request, evidenceRows(stub), numeric(mark), diagnostics(log, key), textFile(before), textFile(after))]
  }
  if (command === 'zero-ack') {
    countArgs(args, 7)
    const [key, id, times, start, end, probe, log] = args
    return [zeroAckVerdict(id, timingRows(times), numeric(start), numeric(end), numeric(probe), textFile(log), printer('MEMBERSHIP_STORAGE_FAILED'), key)]
  }
  if (command === 'accounting') {
    countArgs(args, 6)
    const [manifest, stub, during, final, dir, mark] = args
    const items = tsv(manifest, ['kind', 'key', 'channel', 'ts', 'envelope_id', 'recovered_id']) as AccountedEvent[] | undefined
    const p = await population(), keys = p.sr8Personas(c.recipients)
    return accountingVerdicts(items, evidenceRows(stub), timingRows(during), timingRows(final),
      Object.fromEntries(keys.map(key => [key, evidenceRows(join(dir, `${key}.queue.jsonl`))])), numeric(mark))
  }
  if (command === 'stores') {
    countArgs(args, 3)
    const [dir, file, mark] = args, p = await population(), keys = p.sr8Personas(c.recipients)
    const items = evidenceRows(join(dir, 'burst.jsonl')), accepted: Accepted[] = []
    let complete = !!items?.length
    for (const key of keys) {
      const queue = evidenceRows(join(dir, `${key}.queue.jsonl`))
      if (!queue) complete = false
      for (const item of items?.filter(i => i.key === key && ['roots', 'replies', 'held'].includes(i.phase)) ?? []) {
        const matches = acceptedFor(queue, item.channel, item.ts)
        if (matches.length !== 1) complete = false
        else accepted.push({ key, seq: matches[0].seq })
      }
    }
    const { percentile } = await import('./transcript-receipts.ts')
    return personaStoreVerdicts(complete ? measurements(file, numeric(mark)) : undefined, accepted, keys, percentile)
  }
  if (command === 'lookup-faults') {
    countArgs(args, 3)
    return lookupFaultVerdicts(tsv(args[0], ['key', 'method', 'outcome', 'match', 'envelope_id']), evidenceRows(args[1]), timingRows(args[2]))
  }
  if (command === 'ordered-writes') {
    countArgs(args, 5)
    const [dir, stub, submit, done, times] = args, path = (name: string) => join(dir, name)
    return orderedWriteVerdicts(evidenceRows(path('before.jsonl')), evidenceRows(path('after.jsonl')), evidenceRows(path('reopened.jsonl')),
      tsv(path('expected.tsv'), ['channel', 'delivery']), evidenceRows(path('results.jsonl')), evidenceRows(stub), numeric(submit), numeric(done), timingRows(times))
  }
  if (command === 'membership-writes') {
    countArgs(args, 7)
    const [dir, writer, channel, stub, submit, done, times] = args, path = (name: string) => join(dir, name), p = await population()
    return membershipWriteVerdicts(p.sr8Personas(c.recipients), writer, channel, c.mode,
      { before: evidenceRows(path('before.jsonl')), leave: evidenceRows(path('leave.jsonl')), join: evidenceRows(path('join.jsonl')), reopened: evidenceRows(path('reopened.jsonl')),
        events: evidenceRows(path('events.jsonl')), eventsReopened: evidenceRows(path('events.reopened.jsonl')) },
      tsv(path('membership.tsv'), ['kind', 'envelope_id', 'event_id', 'stage_seq']), evidenceRows(stub), numeric(submit), numeric(done), timingRows(times), timingRows(path('membership-times.jsonl')))
  }
}
/** The verdicts' measurement rows. The server's diagnostic kinds feed only
 * `observe` (SR8_DIAGNOSTIC_KINDS); `thread-compaction` feeds only the compaction
 * proof, which checks its own fields; any other unknown kind is still invalid. */
function measurements(path: string, offset: number): Measurement[] | undefined {
  const rows = jsonl(path, offset, true)?.filter(r => !SR8_DIAGNOSTIC_KINDS.includes(r?.kind))
  return rows?.every(r => r.v === 1 && ['store', 'resolution-store', 'post-hold-resolved', 'thread-compaction'].includes(r.kind)
    && typeof r.key === 'string' && nonnegative(r.at_mono_ms)) ? rows : undefined
}
function context(args: string[]): Context {
  const [scenario, mode, pop, rec] = args.splice(0, 4), population = Number(pop), recipients = Number(rec)
  if (!/^[\w-]+$/.test(scenario ?? '') || !['strict', 'open'].includes(mode) || ![0, 10_000, 100_000].includes(population) || ![1, 2].includes(recipients)) throw new Error('usage')
  return { scenario, mode: mode as Context['mode'], population, recipients }
}
function countArgs(args: string[], min: number, max = min) { if (args.length < min || args.length > max) throw new Error('usage') }
async function channels() {
  const p = await population()
  return p.eligibleChannels(p.populationChannels(p.SR8_POPULATION_CHANNEL_COUNT))
}
async function config(args: string[]) {
  countArgs(args, 6, 7)
  const [mode, n, recipients, root, port, compact, timings] = args
  const c = context(['config', mode, n, recipients]), p = await population()
  if (timings !== undefined && timings !== 'timings') throw new Error('usage')
  const listed = [...(await channels()).map(id => ({ id, delivery: 'thread_hybrid' })), ...p.populationChannels(p.SR8_SHARED_LIST_CHANNELS, p.SR8_POPULATION_CHANNEL_COUNT)]
  const timers = JSON.parse(printer('testTimerOverridesBlock', `queue_compact_interval_ms=${compact}`))
  if (!Number.isSafeInteger(Number(port)) || Number(port) <= 0) throw new Error('usage')
  console.log(JSON.stringify({ channel_mode: c.mode, personas: p.sr8Personas(c.recipients).map(name => ({ name,
    credentials_file: join(resolve(root), `${name}.env`), working_directory: join(resolve(root), name), channels: listed,
    permission_prompts: listed[0].id, dm: { enabled: false } })), bind: '127.0.0.1', port: Number(port), health_check_interval: 0,
    [printer('TEST_MEASUREMENTS_KEY')]: true, ...(timings ? { [printer('TEST_MEASUREMENT_TIMINGS_KEY')]: true } : {}), test_timer_overrides: timers }, null, 2))
}
async function seed(args: string[]) {
  countArgs(args, 3)
  const [configPath, stateDir, raw] = args, n = Number(raw)
  requireSeedPopulation(n)
  const p = await population(), shared = await import(join(pkg(), 'src/shared-channels.ts'))
  const configModule = await import(join(pkg(), 'src/config.ts')), memory = await import(join(pkg(), 'src/thread-memory.ts'))
  const record = `${configPath}.last-applied`, bytes = readFileSync(configPath), cfg = configModule.loadPersonaConfig(configPath)
  if (!existsSync(record)) writeFileSync(record, shared.serializeSharedChannelState(shared.initialSharedChannelState(bytes, cfg)), { mode: 0o600, flag: 'wx' })
  const state = shared.parseSharedChannelState(readFileSync(record), record)
  if (!state || state.sourceBytesBase64 !== bytes.toString('base64')) throw new Error('seed authority mismatch')
  const authority = shared.createSharedChannelAuthority(record, state)
  for (const persona of cfg.personas) {
    const joins = p.populationJoins(persona.key, n, await channels())
    await p.seedPopulation({ createThreadMemory: memory.createThreadMemory, authority, stateDir }, { key: persona.key, joins })
    console.log(`recorded: sr8 seed key=${persona.key} joined=${n} oldest=${p.oldestJoins(joins, 1)[0].root}`)
  }
}
async function plan(args: string[]) {
  countArgs(args, 4)
  const [mode, n, recipients, start] = args, c = context(['plan', mode, n, recipients]), p = await population()
  if (!Number.isSafeInteger(Number(start)) || Number(start) < 0) throw new Error('usage')
  const spec = p.burstSpec(c, await channels(), Number(start))
  for (const [phase, messages] of [['roots', spec.rootMentions], ['replies', spec.replies], ['dropped', spec.dropped]] as const)
    for (const m of messages) console.log([phase, m.channel, m.ts, m.threadTs ?? '-', m.mentions.join(',') || '-'].join('\t'))
}

async function holdAdmission(items: BurstItem[], stateDir: string, file: string, mark: number, waitMs: number, out: string): Promise<boolean> {
  if (!items.length) return true
  const until = performance.now() + waitMs
  while (performance.now() < until) {
    const rows = measurements(file, mark)
    // Read through the production-parsed reader, just as shared_queue_snapshot.
    // Merge each observation with the valid prior archive before replacing it:
    // concatenation repeats acceptances in one journal and the reader rejects it.
    // Keep the original hold and any observed resolution even after compaction.
    let admitted = !!rows
    for (const key of new Set(items.map(i => i.key))) {
      const archive = join(out, `${key}.held-admission.jsonl`)
      const raw = printer('sharedQueueSnapshot', join(stateDir, 'queue', `${key}.jsonl`), ...(existsSync(archive) ? [archive] : []))
      const queue = raw.split('\n').filter(Boolean).map(l => JSON.parse(l))
      writeFileSync(archive, raw + '\n', { mode: 0o600 })
      for (const i of items.filter(i => i.key === key)) {
        const a = acceptedFor(queue, i.channel, i.ts)
        if (a.length !== 1 || !rows?.some(r => r.key === key && r.seq === a[0].seq && r.kind === 'store' && r.store === 'post-hold')) admitted = false
      }
    }
    if (admitted) return true
    await new Promise(r => setTimeout(r, 20))
  }
  return false
}

async function readFaultPlan(dir: string, c: Context): Promise<FaultPlan> {
  const data = JSON.parse(readFileSync(join(dir, 'fault-plan.json'), 'utf8'))
  const p = await population()
  if (!isDeepStrictEqual(data.context, c) || !object(data.plan) || !records(data.plan.items)
    || c.recipients !== 2 || !isDeepStrictEqual(data.plan.keys, p.sr8Personas(c.recipients)) || !Array.isArray(data.plan.channels) || typeof data.plan.all !== 'boolean'
    || !Object.hasOwn(faultOutcomes, data.plan.kind) || data.plan.items.some((i: any, n: number) => i.ordinal !== n
      || !['roots', 'replies', 'dropped', 'held'].includes(i.phase) || typeof i.dependent !== 'boolean'
      || ![i.key, i.channel, i.ts, i.sender, i.root].every(v => typeof v === 'string' && v.length > 0))) throw new Error('invalid fault plan')
  return data.plan
}
async function faultPlan(c: Context, args: string[]): Promise<number> {
  countArgs(args, 6)
  const [batchDir, planFile, kind, persona, scope, out] = args, p = await population(), keys = p.sr8Personas(c.recipients)
  const index = numeric(persona) - 1, planned = tsv(planFile, ['phase', 'channel', 'ts', 'root', 'mentions'])
  if (c.recipients !== 2 || !integer(index) || !keys[index] || !planned?.length || !Object.hasOwn(faultOutcomes, kind)
    || (kind === 'denied' && scope !== 'all')) throw new Error('usage fault declaration')
  const available = [...new Set(planned.map(i => i.channel))]
  const selected = scope === 'all' || scope === 'none' ? [] : scope.split(',').map(n => numeric(n) - 1)
  if (selected.some(n => !integer(n) || !available[n])) throw new Error('usage fault channel ordinals')
  const payloads: any[] = [], items: FaultItem[] = [], counts = { roots: p.SR8_BURST_JOINS, replies: p.SR8_BURST_REPLIES, dropped: p.SR8_BURST_DROPPED }
  const declaration: FaultPlan = { kind, key: keys[index], keys, all: scope === 'all', channels: selected.map(n => available[n]), items }
  for (const phase of ['roots', 'replies', 'dropped', 'held'] as const) {
    const path = join(batchDir, `${phase}.batch.jsonl`)
    if (phase === 'held' && !existsSync(path)) continue
    const bodies = jsonl(path)
    if (!bodies?.length) throw new Error('missing batch')
    for (const body of bodies) {
      if (!keys.includes(body.label) || !object(body.event) || ![body.event.channel, body.event.ts, body.event.user].every(v => typeof v === 'string' && v.length > 0)) throw new Error('invalid batch')
      const i: FaultItem = { ordinal: items.length, key: body.label, phase, channel: body.event.channel, ts: body.event.ts,
        root: body.event.thread_ts ?? '-', sender: body.event.user, dependent: false }
      i.dependent = depends(declaration, i)
      if (phase !== 'held' && planned.filter(r => r.phase === phase && r.channel === i.channel && r.ts === i.ts && r.root === i.root).length !== 1) throw new Error('batch differs from plan')
      items.push(i); payloads.push(body)
    }
    if (phase !== 'held' && (planned.filter(r => r.phase === phase).length !== counts[phase]
      || keys.some(key => items.filter(i => i.key === key && i.phase === phase).length !== counts[phase]))) throw new Error('incomplete workload')
  }
  if (new Set(items.map(eventIdentity)).size !== items.length) throw new Error('duplicate workload')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'fault-plan.json'), JSON.stringify({ context: c, plan: declaration }) + '\n', { flag: 'wx', mode: 0o600 })
  writeFileSync(join(out, 'payloads.jsonl'), payloads.map(b => JSON.stringify(b)).join('\n') + '\n', { flag: 'wx', mode: 0o600 })
  console.log(`recorded: sr8 fault-plan planned=${items.length} dependent=${items.filter(i => i.dependent).length} persona=${index + 1}`)
  return 0
}
async function faultBurst(c: Context, args: string[]): Promise<number> {
  countArgs(args, 7, c.mode === 'open' ? 8 : 7)
  const [dir, url, stubFile, stateDir, measurement, mark, rawWait, release] = args, waitMs = numeric(rawWait), plan = await readFaultPlan(dir, c)
  if (!/^http:\/\/(127\.0\.0\.1|\[::1\]):\d+$/.test(url) || !positive(waitMs) || !integer(numeric(mark))) throw new Error('usage')
  const payloads = jsonl(join(dir, 'payloads.jsonl'))
  if (payloads?.length !== plan.items.length || payloads.some((b, n) => {
    const i = plan.items[n]
    return b.label !== i.key || b.event?.channel !== i.channel || b.event?.ts !== i.ts || b.event?.user !== i.sender || (b.event?.thread_ts ?? '-') !== i.root
  })) throw new Error('payloads differ from declaration')
  const ledgerPath = join(dir, 'fault-ledger.jsonl'), compactPath = join(dir, 'compactions.jsonl'), ledger: FaultPush[] = []
  writeFileSync(ledgerPath, '', { flag: 'wx', mode: 0o600 }); writeFileSync(compactPath, '', { flag: 'wx', mode: 0o600 })
  const qIdentities = new Set(plan.items.filter(i => i.key !== plan.key).map(eventIdentity)), baseline = new Map<string, string>(), proof = new Set<string>()
  const observed = () => {
    const records = jsonl(stubFile, 0, true)
    if (!records) return undefined
    const pushes = records.filter(r => r.event === 'push' && qIdentities.has(eventIdentity({ key: r.label, channel: r.channel, ts: r.event_ts })))
    const ids = new Set(pushes.map(r => r.envelope_id)), acked = new Set(records.filter(r => r.event === 'ws-message' && ids.has(r.envelope_id)).map(r => r.envelope_id))
    return { pushes, acked }
  }
  const observe = () => {
    const first = observed()
    if (!first?.pushes.length || first.acked.size >= qIdentities.size) return
    // Queue journals only: Thread Memory compactions are proved by their measurement entries.
    const stats = plan.keys.map(key => {
      try { const st = statSync(join(stateDir, 'queue', `${key}.jsonl`)); return { key, kind: 'queue', id: `${st.dev}:${st.ino}` } } catch { return { key, kind: 'queue', id: '' } }
    })
    const after = observed()
    if (!after || after.acked.size >= qIdentities.size) return
    for (const s of stats) {
      if (!s.id) continue
      const id = `${s.key}:${s.kind}`, before = baseline.get(id)
      if (before && before !== s.id && !proof.has(id)) {
        proof.add(id); appendFileSync(compactPath, JSON.stringify({ key: s.key, kind: s.kind, before, after: s.id, inside: true }) + '\n')
      }
      baseline.set(id, s.id)
    }
  }
  let failed = false
  const timer = setInterval(observe, 20)
  const send = async (i: FaultItem) => {
    const row: FaultPush = { ordinal: i.ordinal, stage: 'original' }
    try {
      const response = await fetch(`${url}/_push`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payloads[i.ordinal]), signal: AbortSignal.timeout(waitMs) })
      const answer: any = await response.json()
      if (response.ok && answer.ok === true && typeof answer.envelope_id === 'string') row.envelope_id = answer.envelope_id
      else if (plan.kind === 'denied' && i.dependent && ((response.status === 409 && answer.error === 'no-open-socket') || (response.status === 503 && answer.error === 'send-failed'))) row.refusal = answer.error
      else failed = true
    } catch { failed = true }
    ledger.push(row); appendFileSync(ledgerPath, JSON.stringify(row) + '\n')
  }
  const wait = async (items: FaultItem[]) => {
    const until = performance.now() + waitMs
    while (performance.now() < until) {
      const records = jsonl(stubFile, 0, true)
      if (records && items.every(i => {
        const id = ledger.find(l => l.ordinal === i.ordinal)?.envelope_id
        return !!id && records.some(r => r.event === 'ws-message' && r.envelope_id === id)
      })) return true
      await new Promise(r => setTimeout(r, 20))
    }
    return false
  }
  const released = async () => {
    const until = performance.now() + waitMs
    while (performance.now() < until) {
      if (existsSync(release!)) return true
      await new Promise(r => setTimeout(r, 20))
    }
    return false
  }
  // test-45's opt-in CPU profile cuts one part per wave at these marks (cpu-profile.ts).
  const profileDir = process.env.SR8_PROFILE_DIR
  const profileMark = (wave: string) => {
    if (profileDir) try { appendFileSync(join(profileDir, 'waves'), `${wave}\n`, { mode: 0o600 }) } catch { /* never changes the burst */ }
  }
  try {
    const good = await faultWaves(plan.items, send, wait, held => holdAdmission(held, stateDir, measurement, numeric(mark), waitMs, dir),
      release === undefined ? undefined : faultTailOption(c.mode, plan, released), profileMark)
    return good && !failed ? 0 : 1
  } finally {
    clearInterval(timer)
    console.log(`recorded: sr8 fault-burst submitted=${ledger.length} expected=${plan.items.length} refused=${ledger.filter(l => l.refusal).length}`)
  }
}
async function faultRecover(c: Context, args: string[]): Promise<number> {
  countArgs(args, 5)
  const [dir, url, stubFile, rawWait, rawConcurrency] = args, waitMs = numeric(rawWait), concurrency = numeric(rawConcurrency)
  if (!/^http:\/\/(127\.0\.0\.1|\[::1\]):\d+$/.test(url) || !positive(waitMs) || !integer(concurrency) || concurrency < 1 || concurrency > 256)
    throw new Error('usage recovery bounds')
  const until = performance.now() + waitMs, plan = await readFaultPlan(dir, c), ledgerFile = join(dir, 'fault-ledger.jsonl')
  const ledger = evidenceRows(ledgerFile) as FaultPush[] | undefined, payloads = jsonl(join(dir, 'payloads.jsonl'))
  const originals = new Map<number, FaultPush>(), ids = new Set<string>(), replays = new Map<number, FaultPush>()
  if (!ledger || ledger.length !== plan.items.length) throw new EvidenceFailure('recovery-ledger-invalid')
  for (const row of ledger) {
    const item = plan.items[row.ordinal]
    if (!item || row.stage !== 'original' || originals.has(row.ordinal) || (row.envelope_id ? ids.has(row.envelope_id) || !!row.refusal
      : plan.kind !== 'denied' || !item.dependent || !['no-open-socket', 'send-failed'].includes(row.refusal!)))
      throw new EvidenceFailure('recovery-ledger-invalid')
    originals.set(row.ordinal, row); if (row.envelope_id) ids.add(row.envelope_id)
  }
  if (payloads?.length !== plan.items.length || payloads.some((body, n) => {
    const item = plan.items[n]
    return body.label !== item.key || body.event?.channel !== item.channel || body.event?.ts !== item.ts
      || body.event?.user !== item.sender || (body.event?.thread_ts ?? '-') !== item.root
  })) throw new EvidenceFailure('recovery-payload-invalid')
  const dependent = plan.items.filter(i => i.dependent), index = stubIndex(), observer = recoveryObserver(stubFile, index)
  const controller = new AbortController()
  let failure: unknown, timer: ReturnType<typeof setInterval> | undefined, attempted = 0, completed = 0
  const stop = (error: unknown) => { failure ??= error; controller.abort() }
  const remaining = () => {
    if (failure) throw failure
    const ms = Math.ceil(until - performance.now())
    if (ms <= 0) throw new EvidenceFailure('recovery-deadline')
    return ms
  }
  const waitAck = async (id: string) => {
    while (true) {
      remaining()
      const acks = index.acks.get(id) ?? []
      if (acks.length > 1) throw new EvidenceFailure('recovery-ack-invalid')
      if (acks.length === 1) {
        const timing = indexedTiming(index, id)
        if (!isDeepStrictEqual(timing.push.connection_id, timing.acks[0].connection_id)) throw new EvidenceFailure('recovery-ack-invalid')
        return
      }
      await new Promise(r => setTimeout(r, Math.min(20, remaining())))
    }
  }
  const send = async (item: FaultItem) => {
    const original = originals.get(item.ordinal)!, row: FaultPush = { ordinal: item.ordinal, stage: 'replay' }
    // This is the same redelivery control as slack_stub_redeliver. A refused
    // attempt uses its copied prebuilt event, never a newly constructed event.
    const body = original.envelope_id ? { label: item.key, redeliver: { envelope_id: original.envelope_id, retry_reason: 'timeout' } } : payloads![item.ordinal]
    attempted++
    try {
      const response = await fetch(`${url}/_push`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(remaining())]) })
      const answer: any = await response.json()
      if (!response.ok || answer.ok !== true || typeof answer.envelope_id !== 'string' || !answer.envelope_id) throw new EvidenceFailure('recovery-push-failed')
      row.envelope_id = answer.envelope_id
      if (ids.has(row.envelope_id!)) throw new EvidenceFailure('recovery-duplicate-envelope')
      ids.add(row.envelope_id!); replays.set(item.ordinal, row)
    } catch (error) {
      if (error instanceof EvidenceFailure) throw error
      if (failure) throw failure
      throw new EvidenceFailure(performance.now() >= until ? 'recovery-deadline' : 'recovery-push-failed')
    } finally {
      // Even a failed attempt stays in the ledger; never remove an original or
      // discard an actual returned ID. A partial row cannot pass accounting.
      appendFileSync(ledgerFile, JSON.stringify(row) + '\n')
    }
    await waitAck(row.envelope_id!)
    completed++
  }
  const pool = async (items: FaultItem[]) => {
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!failure && cursor < items.length) {
        const item = items[cursor++]
        try { remaining(); await send(item) } catch (error) { stop(error) }
      }
    }))
    if (failure) throw failure
  }
  try {
    observer.read()
    const initialPushes = new Map([...index.pushes].map(([id, rows]) => [id, rows.length]))
    timer = setInterval(() => { try { remaining(); observer.read() } catch (error) { stop(error) } }, 20)
    // All recovered roots have their own observed ACK before any reply starts.
    // This is also bounded concurrency for HTTP requests and outstanding ACKs.
    await pool(dependent.filter(i => i.phase === 'roots'))
    await pool(dependent.filter(i => i.phase !== 'roots'))
    remaining()
    observer.read()
    if (!observer.complete()) throw new EvidenceFailure('stub-record-invalid')
    const replayIds = new Set([...replays.values()].map(r => r.envelope_id!))
    for (const [id, pushes] of index.pushes) if (pushes.length > (initialPushes.get(id) ?? 0) && !replayIds.has(id))
      throw new EvidenceFailure('recovery-unrecorded-envelope')
    if (replays.size !== dependent.length) throw new EvidenceFailure('recovery-ledger-invalid')
    const roots = new Map(plan.items.filter(i => i.phase === 'roots').map(i => [eventIdentity(i), i]))
    for (const item of dependent) {
      const id = replays.get(item.ordinal)!.envelope_id!, push = index.pushes.get(id), timing = indexedTiming(index, id)
      if (push!.length !== 1 || push![0].label !== item.key || push![0].channel !== item.channel || push![0].event_ts !== item.ts)
        throw new EvidenceFailure('recovery-push-invalid')
      if (timing.acks.length !== 1) throw new EvidenceFailure('recovery-ack-invalid')
      const root = roots.get(eventIdentity({ key: item.key, channel: item.channel, ts: item.root }))
      if (root) {
        const parentId = (root.dependent ? replays : originals).get(root.ordinal)!.envelope_id!
        const parent = indexedTiming(index, parentId), ack = index.acks.get(parentId)
        if (parent.acks.length !== 1 || parent.acks[0].ack_mono_ms > timing.push.sent_mono_ms || !(ack![0].seq < push![0].seq))
          throw new EvidenceFailure('recovery-root-order')
      }
    }
    remaining()
    return 0
  } finally {
    if (timer) clearInterval(timer)
    observer.close()
    console.log(`recorded: sr8 fault-recover expected=${dependent.length} attempted=${attempted} recorded=${replays.size} completed=${completed} concurrency=${concurrency}`)
  }
}
async function faultCommands(command: string, c: Context, args: string[]): Promise<number | undefined> {
  if (command === 'fault-plan') return faultPlan(c, args)
  if (command === 'fault-burst') return faultBurst(c, args)
  if (command === 'fault-recover') return faultRecover(c, args)
  if (!['fault-pending', 'fault-body', 'fault-replayed', 'fault-ids', 'fault-check'].includes(command)) return undefined
  countArgs(args, command === 'fault-check' ? 8 : command === 'fault-replayed' ? 3 : command === 'fault-body' ? 2 : 1)
  const dir = args[0], plan = await readFaultPlan(dir, c), ledgerFile = join(dir, 'fault-ledger.jsonl'), ledger = evidenceRows(ledgerFile) as FaultPush[] | undefined
  if (!ledger) throw new Error('missing ledger')
  if (command === 'fault-pending') {
    for (const i of [...plan.items].sort((a, b) => (a.phase === 'roots' ? 0 : 1) - (b.phase === 'roots' ? 0 : 1))) {
      if (!i.dependent) continue
      const o = ledger.filter(l => l.ordinal === i.ordinal && l.stage === 'original')
      if (o.length !== 1 || (!o[0].envelope_id && !o[0].refusal)) throw new Error('missing original')
      console.log([i.ordinal, i.key, o[0].envelope_id ?? '-'].join('\t'))
    }
    return 0
  }
  if (command === 'fault-ids') { for (const l of ledger) if (l.envelope_id) console.log(l.envelope_id); return 0 }
  if (command === 'fault-body' || command === 'fault-replayed') {
    const n = numeric(args[1]), item = plan.items[n]
    if (!integer(n) || !item?.dependent) throw new Error('usage')
    if (command === 'fault-body') {
      const body = jsonl(join(dir, 'payloads.jsonl'))?.[n]
      if (!body?.event || body.label !== item.key || body.event.channel !== item.channel || body.event.ts !== item.ts) throw new Error('missing prebuilt event')
      console.log(JSON.stringify(body.event)); return 0
    }
    if (!args[2] || ledger.some(l => (l.ordinal === n && l.stage === 'replay') || l.envelope_id === args[2])) throw new Error('usage replay')
    appendFileSync(ledgerFile, JSON.stringify({ ordinal: n, stage: 'replay', envelope_id: args[2] }) + '\n'); return 0
  }
  const [, stub, clearMark, clearAt, measurement, mark, start, ready] = args, p = await population(), { percentile } = await import('./transcript-receipts.ts')
  const queues = Object.fromEntries(plan.keys.map(key => [key, evidenceRows(join(dir, `${key}.queue.jsonl`))]))
  const duringQueues = Object.fromEntries(plan.keys.map(key => [key, evidenceRows(join(dir, 'during', `${key}.queue.jsonl`))]))
  const e: FaultLoadEvidence = { plan, ledger, stub: evidenceRows(stub), during: timingRows(join(dir, 'during-times.jsonl')), times: timingRows(join(dir, 'times.jsonl')),
    queues, duringQueues, rows: measurements(measurement, numeric(mark)), clearMark: numeric(clearMark), clearAt: numeric(clearAt) }
  const rows = faultLoadVerdicts(e, { roots: p.SR8_BURST_JOINS, replies: p.SR8_BURST_REPLIES, dropped: p.SR8_BURST_DROPPED }, Number(printer('THREAD_REPLY_HOLD_MS')), percentile)
  for (const key of plan.keys) {
    const expected = p.populationJoins(key, c.population, await channels()), added = plan.items.filter(i => i.key === key && i.phase === 'roots').map(i => ({ channel: i.channel, root: i.ts }))
    const r = joinsVerdict(evidenceRows(join(dir, `${key}.before.jsonl`)), evidenceRows(join(dir, `${key}.after.jsonl`)), expected, added, 1)
    r.stats.persona = key; rows.push(r)
  }
  rows.push(startupVerdict(numeric(start), numeric(ready), c.population * c.recipients),
    compactionVerdict(evidenceRows(join(dir, 'compactions.jsonl')), e.rows, faultWindow(e), plan.keys, c.population === 100_000, faultRewriters(plan)))
  return printResults(c, rows)
}

async function burst(c: Context, args: string[]): Promise<number> {
  countArgs(args, 6, 8)
  const [batchDir, url, stubRecord, stateDir, out, rawWait, measurement, mark] = args
  if (args.length === 7) throw new Error('usage')
  if (!/^http:\/\/(127\.0\.0\.1|\[::1\]):\d+$/.test(url) || !nonnegative(Number(rawWait)) || Number(rawWait) === 0) throw new Error('usage')
  const p = await population(), keys = p.sr8Personas(c.recipients), submitted: BurstItem[] = [], proof: Compaction[] = []
  const batches = ['roots', 'replies', 'dropped'].map(phase => {
    const rows = jsonl(join(batchDir, `${phase}.batch.jsonl`))
    const expected = (phase === 'roots' ? p.SR8_BURST_JOINS : phase === 'replies' ? p.SR8_BURST_REPLIES : p.SR8_BURST_DROPPED) * c.recipients
    if (!rows || rows.length !== expected || rows.some(r => !keys.includes(r.label) || !r.event?.ts || !r.event?.channel || !r.event?.user)) throw new Error('batch missing')
    return { phase, rows }
  })
  const heldPath = join(batchDir, 'held.batch.jsonl')
  if (existsSync(heldPath)) {
    if (!measurement || !integer(numeric(mark))) throw new Error('usage held admission needs measurements')
    const held = jsonl(heldPath)
    if (!held?.length || held.some(r => !keys.includes(r.label) || !r.event?.ts || !r.event?.thread_ts || !r.event?.channel || !r.event?.user)) throw new Error('held batch missing')
    batches.push({ phase: 'held', rows: held })
  }
  const probesPath = join(batchDir, 'probes.batch.jsonl')
  if (existsSync(probesPath)) {
    const probes = jsonl(probesPath)
    if (!probes?.length || probes.some(r => !keys.includes(r.label) || !r.event?.ts || !r.event?.thread_ts || !r.event?.channel || !r.event?.user)) throw new Error('probes batch missing')
    batches.push({ phase: 'probes', rows: probes })
  }
  mkdirSync(out, { recursive: true })
  const ledger = join(out, 'burst.jsonl'), compactFile = join(out, 'compactions.jsonl')
  writeFileSync(ledger, '', { flag: 'wx', mode: 0o600 }); writeFileSync(compactFile, '', { flag: 'wx', mode: 0o600 })
  const expectedCount = batches.reduce((n, b) => n + b.rows.length, 0), baseline = new Map<string, string>()
  // Restrict the window to these batch timestamps/labels even when the stub record has prior runs.
  const identities = new Set(batches.flatMap(b => b.rows.map(r => `${r.label}:${r.event.channel}:${r.event.ts}`)))
  const observed = () => {
    const rows = jsonl(stubRecord, 0, true)
    if (!rows) return undefined
    const pushes = rows.filter(r => r.event === 'push' && identities.has(`${r.label}:${r.channel}:${r.event_ts}`))
    const ids = new Set(pushes.map(r => r.envelope_id)), acked = new Set(rows.filter(r => r.event === 'ws-message' && ids.has(r.envelope_id)).map(r => r.envelope_id))
    return { pushes, acked }
  }
  const observe = () => {
    const first = observed()
    if (!first?.pushes.length || first.acked.size >= expectedCount) return
    // Queue journals only: Thread Memory compactions are proved by their measurement entries.
    const stats = keys.map(key => {
      try { const st = statSync(join(stateDir, 'queue', `${key}.jsonl`)); return { key, kind: 'queue', id: `${st.dev}:${st.ino}` } } catch { return { key, kind: 'queue', id: '' } }
    })
    const after = observed()
    if (!after || after.acked.size >= expectedCount) return
    for (const s of stats) {
      if (!s.id) continue
      const id = `${s.key}:${s.kind}`, before = baseline.get(id)
      if (before && before !== s.id && !proof.some(r => r.key === s.key && r.kind === s.kind)) {
        const row = { key: s.key, kind: s.kind, before, after: s.id, inside: true }; proof.push(row); appendFileSync(compactFile, JSON.stringify(row) + '\n')
      }
      baseline.set(id, s.id)
    }
  }
  let failed = false
  const cpuFile = process.env.SR8_PHASE_CPU_FILE, cpuPids = phasePids(process.env.SR8_PHASE_CPU_PIDS, process.pid)
  // test-44's opt-in CPU profile cuts one part per wave at these marks (cpu-profile.ts).
  const profileDir = process.env.SR8_PROFILE_DIR
  const phaseCpu = (phase: string) => {
    if (profileDir) try { appendFileSync(join(profileDir, 'waves'), `${phase}\n`, { mode: 0o600 }) } catch { /* never changes the burst */ }
    if (!cpuFile) return
    try {
      const sample = phaseCpuSample(phase, performance.now(), cgroupCpuStat(), cpuPids.map(([name, pid]) => [name, textFile(`/proc/${pid}/stat`)]))
      appendFileSync(cpuFile, JSON.stringify(sample) + '\n', { mode: 0o600 })
    } catch { /* an observation never changes the burst */ }
  }
  const timer = setInterval(observe, 20)
  const send = async (phase: string, body: any) => {
    const item: BurstItem = { key: body.label, phase, channel: body.event.channel, ts: body.event.ts, sender: body.event.user }
    try {
      const response = await fetch(`${url}/_push`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(Number(rawWait)) })
      const answer: any = await response.json()
      if (!response.ok || answer.ok !== true || typeof answer.envelope_id !== 'string') throw new Error('push refused')
      item.envelope_id = answer.envelope_id
    } catch { failed = true }
    submitted.push(item); appendFileSync(ledger, JSON.stringify(item) + '\n')
  }
  const waitAcks = async (items: BurstItem[]) => {
    const until = performance.now() + Number(rawWait)
    while (performance.now() < until) {
      observe()
      const acked = observed()?.acked
      if (acked && items.every(i => i.envelope_id && acked.has(i.envelope_id))) return true
      await new Promise(r => setTimeout(r, 20))
    }
    return false
  }
  try {
    const held = batches.find(b => b.phase === 'held')
    if (held) {
      phaseCpu('probe')
      await Promise.all(held.rows.map(body => send('held', body)))
      if (failed || !await waitAcks(submitted) || !await holdAdmission(submitted, stateDir, measurement!, numeric(mark), Number(rawWait), out)) return 1
    }
    phaseCpu('roots')
    await Promise.all(batches[0].rows.map(body => send('roots', body)))
    if (failed || !await waitAcks(submitted)) return 1
    // Pending-post probes lead the second wave, so later burst pushes surround them.
    const wave = ['probes', 'replies', 'dropped'].flatMap(phase => batches.filter(b => b.phase === phase))
    phaseCpu('replies-drops')
    await Promise.all(wave.flatMap(b => b.rows.map(body => send(b.phase, body))))
    return failed || !await waitAcks(submitted) ? 1 : 0
  } finally { clearInterval(timer); phaseCpu('end'); console.log(`recorded: sr8 burst submitted=${submitted.length} expected=${expectedCount} push_failures=${submitted.filter(i => !i.envelope_id).length}`) }
}

async function check(c: Context, args: string[]): Promise<Result[]> {
  countArgs(args, 5, 7)
  const [dir, measurementFile, mark, start, ready, required = '0', n2File] = args
  if (args.length === 6 || !Number.isSafeInteger(Number(required)) || Number(required) < 0) throw new Error('usage')
  const p = await population(), { percentile } = await import('./transcript-receipts.ts'), keys = p.sr8Personas(c.recipients)
  const rows = measurements(measurementFile, Number(mark)), items: BurstItem[] | undefined = jsonl(join(dir, 'burst.jsonl')), times = jsonl(join(dir, 'times.jsonl'))
  const acceptedItems = items?.filter(i => ['roots', 'replies', 'held'].includes(i.phase)) ?? []
  const accepted: Accepted[] = [], holds: Accepted[] = [], joins: Result[] = [], ordinary: (Accepted & { envelope_id?: string })[] = []
  const queues: Record<string, any[] | undefined> = {}
  let complete = true
  for (const key of keys) {
    const queue = jsonl(join(dir, `${key}.queue.jsonl`))
    if (!queue) complete = false
    queues[key] = queue
    for (const item of acceptedItems.filter(i => i.key === key)) {
      const matches = queue?.filter(r => r.kind === 'accepted' && !r.compact && r.channel === item.channel && r.ts === item.ts && r.reminder_for === undefined) ?? []
      if (matches.length !== 1) { complete = false; continue }
      accepted.push({ key, seq: matches[0].seq })
      if (item.phase === 'held' || matches[0].hold?.on === 'post') holds.push({ key, seq: matches[0].seq })
      else ordinary.push({ key, seq: matches[0].seq, envelope_id: item.envelope_id })
    }
    const expected = p.populationJoins(key, c.population, await channels())
    const added = items?.filter(i => i.key === key && i.phase === 'roots').map(i => ({ channel: i.channel, root: i.ts })) ?? []
    const r = joinsVerdict(jsonl(join(dir, `${key}.before.jsonl`)), jsonl(join(dir, `${key}.after.jsonl`)), expected, added, 1)
    r.stats.persona = key; joins.push(r)
  }
  for (const a of accepted) if (!holds.some(h => identity(h) === identity(a))
    && rows?.some(r => r.kind === 'store' && r.store === 'post-hold' && r.key === a.key && r.seq === a.seq)) holds.push(a)
  const [ackAccepted, ackDropped] = burstAckVerdicts(keys, items, times, queues,
    { roots: p.SR8_BURST_JOINS, replies: p.SR8_BURST_REPLIES, dropped: p.SR8_BURST_DROPPED })
  const store = storeVerdict(complete ? rows : undefined, accepted, percentile)
  const results = [ackAccepted, ackDropped, store, postHoldVerdict(rows, holds, Number(printer('THREAD_REPLY_HOLD_MS'))),
    startupVerdict(Number(start), Number(ready), c.population * c.recipients), ...joins,
    compactionVerdict(jsonl(join(dir, 'compactions.jsonl')), rows, storeWindow(complete ? rows : undefined, accepted), keys, c.population === 100_000)]
  if (items?.some(i => i.phase === 'held')) results.push(...postHoldOverlapVerdicts(rows, holds, ordinary, times))
  if (Number(required) > 0) results.push(n2Verdict(n2File && textFile(n2File) !== undefined ? n2Samples(textFile(n2File)!) : undefined, Number(required)))
  return results
}
async function seal(c: Context, phase: string, args: string[]): Promise<Result[]> {
  countArgs(args, 3)
  const [log, mark, configPath] = args, bytes = textFile(log), p = await population()
  const keys = c.population ? p.sr8Personas(c.recipients) : []
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
  const expected = keys.map(key => printer('buildThreadMemoryChangedWhileStoppedLine', key,
    cfg.personas.find((x: any) => x.name === key).channels.filter((x: any) => x.delivery === 'thread_hybrid').map((x: any) => x.id).join(','), 'entry-missing', 'changed'))
  const offset = Number(mark), lines = bytes !== undefined && Number.isSafeInteger(offset) && offset >= 0 && offset <= Buffer.byteLength(bytes)
    ? Buffer.from(bytes).subarray(offset).toString().split('\n') : undefined
  return [sealVerdict(phase, keys, lines, printer('THREAD_MEMORY_CHANGED_WHILE_STOPPED'), expected, printer('THREAD_MEMORY_JOINS_LOST'))]
}
async function n4(c: Context, args: string[]): Promise<Result[]> {
  countArgs(args, 11)
  const [file, mark, key, queueFile, timesFile, stubFile, n2File, hungTs, hungUser, delayedTs, delayedUser] = args
  const queue = jsonl(queueFile), stub = jsonl(stubFile)
  const sample = (ts: string, sender: string): FaultSample | undefined => {
    const accepted = queue?.filter(r => r.kind === 'accepted' && !r.compact && r.source === 'slack' && r.user === sender
      && r.ts === ts && typeof r.channel === 'string' && r.channel.length > 0 && r.key?.chat_id === r.channel && r.key?.ts === ts) ?? []
    const push = stub?.filter(r => r.event === 'push' && r.label === key && r.event_ts === ts && r.channel === accepted[0]?.channel) ?? []
    return accepted.length === 1 && push.length === 1 ? { key, seq: accepted[0].seq, sender, envelope_id: push[0].envelope_id } : undefined
  }
  const text = textFile(n2File)
  return [n4Verdict(measurements(file, Number(mark)), sample(hungTs, hungUser), sample(delayedTs, delayedUser), jsonl(timesFile), text === undefined ? undefined : n2Samples(text), stub, Number(printer('NAME_LOOKUP_TIMEOUT_MS')))]
}
async function windows(c: Context, args: string[]): Promise<Result[]> {
  countArgs(args, 3)
  const raw = textFile(args[0]), lines = raw === '' ? [] : raw?.endsWith('\n') ? raw.slice(0, -1).split('\n').map(l => l.split('\t')) : undefined
  const calls = lines?.every(s => s.length === 6 && s[1].trim() && s[4].trim())
    ? lines.map(s => ({ instance: s[4], ms: Number(s[1]) * 1000 })) : undefined
  const windowsAt = (file: string) => tsv(file, ['instance', 'start', 'end'])?.map(w => ({ instance: w.instance, start: numeric(w.start) * 1000, end: numeric(w.end) * 1000 }))
  return [windowsVerdict(calls, windowsAt(args[1]), Number(printer('DELIVERY_MAX_AD_CALLS_PER_S')), windowsAt(args[2]))]
}
function concurrentOverlap(c: Context, args: string[]): Result[] {
  countArgs(args, 3)
  const operations = tsv(args[0], ['kind', 'id', 'start', 'end'])?.map(o => ({ kind: o.kind, id: o.id, start_epoch_ms: numeric(o.start), end_epoch_ms: numeric(o.end) }))
  const samples = tsv(args[1], ['key', 'seq', 'start', 'end'])?.map(s => ({ key: s.key, seq: numeric(s.seq), start_epoch_ms: numeric(s.start), end_epoch_ms: numeric(s.end) }))
  const measured = textFile(args[2])
  return concurrentOverlapVerdicts(operations, samples, measured === undefined ? undefined : n2Samples(measured), c.mode)
}
/** The container cgroup's CPU throttling counters, v2 first, then v1
 * (throttled_time is nanoseconds there). Undefined when no counter reads. */
export function cpuThrottle(text: string | undefined): { periods: number, throttled: number, throttledUsec: number } | undefined {
  const value = (name: string) => { const m = text?.match(new RegExp(`^${name} (\\d+)$`, 'm')); return m ? Number(m[1]) : undefined }
  const periods = value('nr_periods'), throttled = value('nr_throttled'), usec = value('throttled_usec'), ns = value('throttled_time')
  const throttledUsec = usec ?? (ns === undefined ? undefined : Math.floor(ns / 1000))
  return periods === undefined || throttled === undefined || throttledUsec === undefined ? undefined : { periods, throttled, throttledUsec }
}
/** `cpu_max=<quota|max>/<period>` and the throttling deltas since a case's
 * cpu-mark, each `unknown` when unreadable or malformed. */
export function cpuConditionFields(cpuMax: string | undefined, before: string | undefined, now: string | undefined): string {
  const max = cpuMax?.trim().match(/^(max|\d+) (\d+)$/)
  const a = cpuThrottle(before), b = cpuThrottle(now)
  const delta = (pick: (t: NonNullable<typeof a>) => number) => a && b && pick(b) >= pick(a) ? String(pick(b) - pick(a)) : 'unknown'
  return `cpu_max=${max ? `${max[1]}/${max[2]}` : 'unknown'} nr_periods_delta=${delta(t => t.periods)} nr_throttled_delta=${delta(t => t.throttled)} throttled_usec_delta=${delta(t => t.throttledUsec)}`
}

/** The cgroup's cpu.stat counters: v2 usage/user/system microseconds, and the
 * throttling counters through cpuThrottle (v1 has no usage here). Pure. */
export function cgroupCpuCounters(text: string | undefined): Record<string, number> | undefined {
  if (text === undefined) return undefined
  const counters: Record<string, number> = {}
  for (const name of ['usage_usec', 'user_usec', 'system_usec']) {
    const m = text.match(new RegExp(`^${name} (\\d+)$`, 'm'))
    if (m) counters[name] = Number(m[1])
  }
  const t = cpuThrottle(text)
  if (t) Object.assign(counters, { nr_periods: t.periods, nr_throttled: t.throttled, throttled_usec: t.throttledUsec })
  return Object.keys(counters).length ? counters : undefined
}
/** A process's whole-process utime/stime ticks from /proc/<pid>/stat. Pure. */
export function procCpuTicks(text: string | undefined): { utime: number; stime: number } | undefined {
  const close = text?.lastIndexOf(')') ?? -1
  if (!text || close < 0) return undefined
  // After "pid (comm) ", field 3 (state) is index 0: utime (14) and stime (15) are 11 and 12.
  const fields = text.slice(close + 1).trim().split(/\s+/)
  return /^\d+$/.test(fields[11] ?? '') && /^\d+$/.test(fields[12] ?? '') ? { utime: Number(fields[11]), stime: Number(fields[12]) } : undefined
}
/** `name=pid,...` from the script; the observing process is always `observer`. Pure. */
export function phasePids(spec: string | undefined, self: number): [string, number][] {
  const named = (spec ?? '').split(',').map(s => s.match(/^([a-z]+)=(\d+)$/)).filter(m => m !== null && m[1] !== 'observer')
    .map(m => [m![1], Number(m![2])] as [string, number])
  return [...named, ['observer', self]]
}
export interface PhaseCpuSample { phase: string; mono_ms: number; cgroup: Record<string, number> | null; procs: Record<string, { utime: number; stime: number } | null> }
/** One boundary reading: the phase starting here, or `end`. Pure. */
export function phaseCpuSample(phase: string, monoMs: number, cpuStat: string | undefined, procs: [string, string | undefined][]): PhaseCpuSample {
  return { phase, mono_ms: monoMs, cgroup: cgroupCpuCounters(cpuStat) ?? null, procs: Object.fromEntries(procs.map(([name, stat]) => [name, procCpuTicks(stat) ?? null])) }
}
const round3 = (n: number) => Math.round(n * 1000) / 1000
/** Per phase, between consecutive boundary readings: elapsed observer time,
 * cgroup CPU and throttling deltas, and each process's user/system CPU. A
 * counter unread at either end, or going backwards, is `unknown`. Pure. */
export function phaseCpuResults(samples: PhaseCpuSample[]): Result[] {
  const delta = (a: number | undefined, b: number | undefined, factor: number) => a !== undefined && b !== undefined && b >= a ? round3((b - a) * factor) : 'unknown'
  return samples.slice(0, -1).map((a, i) => {
    const b = samples[i + 1]!, elapsed = b.mono_ms - a.mono_ms, usage = delta(a.cgroup?.usage_usec, b.cgroup?.usage_usec, 1 / 1000)
    const stats: Result['stats'] = { phase: a.phase, elapsed_ms: round3(elapsed), cpu_usage_ms: usage,
      cpu_user_ms: delta(a.cgroup?.user_usec, b.cgroup?.user_usec, 1 / 1000), cpu_system_ms: delta(a.cgroup?.system_usec, b.cgroup?.system_usec, 1 / 1000),
      cpus_busy: typeof usage === 'number' && elapsed > 0 ? round3(usage / elapsed) : 'unknown',
      nr_periods: delta(a.cgroup?.nr_periods, b.cgroup?.nr_periods, 1), nr_throttled: delta(a.cgroup?.nr_throttled, b.cgroup?.nr_throttled, 1),
      throttled_ms: delta(a.cgroup?.throttled_usec, b.cgroup?.throttled_usec, 1 / 1000) }
    for (const name of Object.keys(b.procs)) {
      stats[`${name}_user_ms`] = delta(a.procs[name]?.utime, b.procs[name]?.utime, 1000 / SR8_USER_HZ)
      stats[`${name}_system_ms`] = delta(a.procs[name]?.stime, b.procs[name]?.stime, 1000 / SR8_USER_HZ)
    }
    return result('observe-cpu', 2, stats, 'none', 'recorded')
  })
}

/** A burst item's phase in the observed waves: held probes, roots, then the second wave. */
const SR8_WAVES: Record<string, string> = { held: 'probe', roots: 'roots', probes: 'replies-drops', replies: 'replies-drops', dropped: 'replies-drops' }
/** The server's ack outcomes: only `acked` is a receive-to-ACK sample. */
const SR8_ACK_OUTCOMES = ['acked', 'ack-failed', 'suppressed'] as const
export interface AckRow { kind: 'ack'; keys: string[]; ts?: string; outcome: typeof SR8_ACK_OUTCOMES[number]; receive_to_ack_ms: number; ack_call_ms?: number; at_mono_ms: number }
/** The stub side: one ACK, none after a push, more than one, or no push timing. */
export type StubAckStatus = 'acked' | 'unacked' | 'ambiguous' | 'missing'
/** The server side: one row by its outcome, more than one row, or none. */
export type ServerAckStatus = typeof SR8_ACK_OUTCOMES[number] | 'ambiguous' | 'missing'
/** One burst event: its persona and ordinal (ledger order within persona and
 * phase), both clocks' status, and the durations each side measured. `server`,
 * `received` and `acked` exist only for an `acked` row; a suppressed or failed
 * attempt carries only `attempt` (receipt to suppression or to the failed call). */
export interface ClockSample {
  phase: string; wave: string; key: string; ordinal: number; sent?: number
  stub_status: StubAckStatus; stub?: number; server_status: ServerAckStatus; server?: number; attempt?: number; received?: number; acked?: number
}
const ackRow = (r: any): r is AckRow => r?.kind === 'ack' && Array.isArray(r.keys) && typeof r.ts === 'string' && SR8_ACK_OUTCOMES.includes(r.outcome)
  && nonnegative(r.receive_to_ack_ms) && nonnegative(r.at_mono_ms) && (r.ack_call_ms === undefined || nonnegative(r.ack_call_ms))
/** Both ACK clocks for every burst event, matched by persona key and Slack ts:
 * the stub's push-to-ACK (one ACK only) and the server's receive-to-ACK (one
 * `acked` row only), with that row's receipt and ACK times on the server clock.
 * Every ledger item gives one sample, whatever either side saw. Pure. */
export function ackClockSamples(items: BurstItem[], times: Times[], rows: any[]): ClockSample[] {
  const timing = new Map(times.map(t => [t.envelope_id, t])), server = new Map<string, AckRow[]>(), ordinals = new Map<string, number>()
  for (const r of rows) if (ackRow(r)) for (const key of r.keys) {
    const id = `${key}\t${r.ts}`
    server.set(id, [...server.get(id) ?? [], r])
  }
  return items.map(item => {
    const t = item.envelope_id ? timing.get(item.envelope_id) : undefined, own = server.get(`${item.key}\t${item.ts}`) ?? []
    const row = own.length === 1 ? own[0]! : undefined, ordinal = (ordinals.get(`${item.key}\t${item.phase}`) ?? 0) + 1
    ordinals.set(`${item.key}\t${item.phase}`, ordinal)
    const stub_status: StubAckStatus = !t ? 'missing' : t.acks.length === 1 ? 'acked' : t.acks.length ? 'ambiguous' : 'unacked'
    return { phase: item.phase, wave: SR8_WAVES[item.phase] ?? item.phase, key: item.key, ordinal, ...(t ? { sent: t.push.sent_mono_ms } : {}),
      stub_status, ...(stub_status === 'acked' ? { stub: t!.acks[0]!.ack_mono_ms - t!.push.sent_mono_ms } : {}),
      server_status: row ? row.outcome : own.length ? 'ambiguous' : 'missing',
      ...(row?.outcome === 'acked' ? { server: row.receive_to_ack_ms, received: row.at_mono_ms - (row.ack_call_ms ?? 0) - row.receive_to_ack_ms, acked: row.at_mono_ms }
        : row ? { attempt: row.receive_to_ack_ms } : {}) }
  })
}
type Percentile = (values: number[], q: number) => number
const spread = (prefix: string, values: number[], percentile: Percentile): Result['stats'] => values.length
  ? { [`${prefix}_p50_ms`]: round3(percentile(values, .5)), [`${prefix}_p99_ms`]: round3(percentile(values, .99)), [`${prefix}_max_ms`]: round3(maximum(values)) }
  : { [`${prefix}_p50_ms`]: 'none', [`${prefix}_p99_ms`]: 'none', [`${prefix}_max_ms`]: 'none' }
const phasesOf = (samples: ClockSample[]) => [...new Set(samples.map(s => s.phase))]
/** Per burst phase: event and match counts, the stub's unACKed and doubled
 * events, the server's doubled, suppressed and failed attempts, then p50/p99/max
 * of the stub clock, the server's `acked` clock, their difference (stub minus
 * server, matched events), and the suppressed and failed attempts' durations. */
export function ackClockResults(samples: ClockSample[], percentile: Percentile): Result[] {
  return phasesOf(samples).map(phase => {
    const own = samples.filter(s => s.phase === phase), matched = own.filter(s => s.stub !== undefined && s.server !== undefined)
    const count = (pick: (s: ClockSample) => boolean) => own.filter(pick).length
    const attempts = (status: ServerAckStatus) => own.flatMap(s => s.server_status === status ? [s.attempt!] : [])
    return result('observe-ack', own.length, { phase, stub_events: count(s => s.stub !== undefined),
      server_events: count(s => s.server !== undefined), matched: matched.length,
      stub_unacked: count(s => s.stub_status === 'unacked'), stub_ambiguous: count(s => s.stub_status === 'ambiguous'),
      server_ambiguous: count(s => s.server_status === 'ambiguous'), suppressed: count(s => s.server_status === 'suppressed'),
      ack_failed: count(s => s.server_status === 'ack-failed'),
      ...spread('stub', own.flatMap(s => s.stub ?? []), percentile), ...spread('server', own.flatMap(s => s.server ?? []), percentile),
      ...spread('gap', matched.map(s => s.stub! - s.server!), percentile),
      ...spread('suppressed', attempts('suppressed'), percentile), ...spread('ack_failed', attempts('ack-failed'), percentile) }, 'none', 'recorded')
  })
}
/** One line per burst event, in ledger order: persona and ordinal, its push
 * offset from the phase's first push (stub clock), each side's status and
 * duration, their gap, and a suppressed or failed attempt's duration. Pure. */
export function ackEventResults(samples: ClockSample[]): Result[] {
  const first = new Map<string, number>()
  for (const s of samples) if (s.sent !== undefined) first.set(s.phase, Math.min(first.get(s.phase) ?? s.sent, s.sent))
  const ms = (n: number | undefined) => n === undefined ? 'none' : round3(n)
  return samples.map(s => result('observe-ack-event', 1, { phase: s.phase, persona: /^[a-z][a-z0-9-]*$/.test(s.key) ? s.key : 'invalid', ordinal: s.ordinal,
    offset_ms: s.sent === undefined ? 'none' : round3(s.sent - first.get(s.phase)!), stub: s.stub_status, stub_ms: ms(s.stub),
    server: s.server_status, server_ms: ms(s.server), gap_ms: s.stub !== undefined && s.server !== undefined ? round3(s.stub - s.server) : 'none',
    attempt_ms: ms(s.attempt) }, 'none', 'recorded'))
}
/** Each phase's pushed events in stub push order, cut into `bins` equal runs,
 * with each run's maximum of both clocks: whether latency builds through a wave. */
export function ackBinResults(samples: ClockSample[], bins: number): Result[] {
  const max = (values: number[]) => values.length ? round3(maximum(values)) : 'none'
  return phasesOf(samples).flatMap(phase => {
    const own = samples.filter(s => s.phase === phase && s.sent !== undefined).sort((a, b) => a.sent! - b.sent!), n = Math.min(bins, own.length)
    return Array.from({ length: n }, (_, i) => {
      const run = own.slice(Math.floor(i * own.length / n), Math.floor((i + 1) * own.length / n))
      return result('observe-ack-bin', run.length, { phase, bin: i + 1, bins: n, stub_max_ms: max(run.flatMap(s => s.stub ?? [])),
        server_max_ms: max(run.flatMap(s => s.server ?? [])), gap_max_ms: max(run.flatMap(s => s.stub !== undefined && s.server !== undefined ? [s.stub - s.server] : [])) }, 'none', 'recorded')
    })
  })
}
export interface ServerWave { wave: string; start: number; end: number }
/** Each wave's span on the server clock: its first `acked` receipt to its last
 * ACK, in time order; suppressed and failed attempts never bound a wave. Pure. */
export function serverWaves(samples: ClockSample[]): ServerWave[] {
  const waves = [...new Set(samples.map(s => s.wave))].flatMap(wave => {
    const own = samples.filter(s => s.wave === wave && s.received !== undefined)
    return own.length ? [{ wave, start: Math.min(...own.map(s => s.received!)), end: Math.max(...own.map(s => s.acked!)) }] : []
  })
  return waves.sort((a, b) => a.start - b.start)
}
/** A server time's phase: `before` the first wave, the wave whose start it
 * follows until the next wave starts, `after` the last wave's final ACK. */
export function serverPhase(at: number, waves: ServerWave[]): string {
  if (!waves.length) return 'unphased'
  if (at < waves[0]!.start) return 'before'
  const last = waves.filter(w => w.start <= at).at(-1)!
  return last === waves.at(-1) && at > last.end ? 'after' : last.wave
}
interface AppendRow { journal: string; key: string; records: number; bytes: number; append_ms: number; file_fsync_ms: number; dir_fsync_ms: number; fsyncs: number; at_mono_ms: number }
const appendRow = (r: any): r is AppendRow => r?.kind === 'append' && typeof r.journal === 'string'
  && [r.records, r.append_ms, r.file_fsync_ms, r.dir_fsync_ms, r.fsyncs, r.at_mono_ms].every(nonnegative)
const phaseOrder = (waves: ServerWave[]) => ['before', ...waves.map(w => w.wave), 'after', 'unphased']
/** Per server phase and journal: appends, group size (records per append) and
 * the append's, file fsync's and directory fsync's p50/p99/max and total. An
 * append's phase is its start (completion minus duration). Pure. */
export function appendResults(rows: any[], waves: ServerWave[], percentile: Percentile): Result[] {
  const appends = rows.filter(appendRow).map(r => ({ ...r, phase: serverPhase(r.at_mono_ms - r.append_ms, waves) }))
  const total = (values: number[]) => round3(values.reduce((n, v) => n + v, 0))
  return phaseOrder(waves).flatMap(phase => ['queue', 'thread-memory'].flatMap(journal => {
    const own = appends.filter(a => a.phase === phase && a.journal === journal)
    if (!own.length) return []
    const groups = own.map(a => a.records)
    return [result('observe-append', own.length, { phase, journal, records: groups.reduce((n, v) => n + v, 0),
      group_p50: percentile(groups, .5), group_p99: percentile(groups, .99), group_max: maximum(groups),
      ...spread('append', own.map(a => a.append_ms), percentile), append_total_ms: total(own.map(a => a.append_ms)),
      ...spread('file_fsync', own.map(a => a.file_fsync_ms), percentile), file_fsync_total_ms: total(own.map(a => a.file_fsync_ms)),
      ...spread('dir_fsync', own.map(a => a.dir_fsync_ms), percentile), dir_fsync_total_ms: total(own.map(a => a.dir_fsync_ms)),
      fsyncs: own.reduce((n, a) => n + a.fsyncs, 0) }, 'none', 'recorded')]
  }))
}
/** Per server phase: timed stores, `fixed` appends and Thread Memory saves
 * (count and records by kind), each at its row's own server time. Pure. */
export function saveResults(rows: any[], waves: ServerWave[]): Result[] {
  const at = (r: any) => nonnegative(r?.at_mono_ms) ? serverPhase(r.at_mono_ms, waves) : undefined
  const stores = rows.filter(r => r?.kind === 'store'), saves = rows.filter(r => r?.kind === 'thread-save' && [r.records, r.joins, r.intents, r.outcomes].every(nonnegative))
  const sum = (list: any[], field: string) => list.reduce((n, r) => n + r[field], 0)
  return phaseOrder(waves).flatMap(phase => {
    const own = stores.filter(r => at(r) === phase), mine = saves.filter(r => at(r) === phase), wave = waves.find(w => w.wave === phase)
    if (!own.length && !mine.length && !wave) return []
    return [result('observe-saves', own.length + mine.length, { phase, span_ms: wave ? round3(wave.end - wave.start) : 'none',
      stores: own.filter(r => r.store !== 'fixed').length, fixed: own.filter(r => r.store === 'fixed').length, thread_saves: mine.length,
      save_records: sum(mine, 'records'), joins: sum(mine, 'joins'), intents: sum(mine, 'intents'), outcomes: sum(mine, 'outcomes') }, 'none', 'recorded')]
  })
}
export interface ObserveInputs { rows?: any[]; items?: BurstItem[]; times?: Times[]; cpu?: PhaseCpuSample[] }
/** Every observe line, in order: inputs, CPU per phase, ACK clocks, ACK runs,
 * appends, saves, then one ACK line per burst event. Observation only: every
 * verdict is `recorded`. Pure. */
export function observeResults(inputs: ObserveInputs, percentile: Percentile): Result[] {
  const state = (v: unknown[] | undefined) => v === undefined ? 'missing' : 'read'
  const samples = ackClockSamples(inputs.items ?? [], inputs.times ?? [], inputs.rows ?? []), waves = serverWaves(samples)
  return [result('observe-inputs', inputs.rows?.length ?? 0, { measurements: state(inputs.rows), burst: state(inputs.items), times: state(inputs.times), cpu: state(inputs.cpu) }, 'none', 'recorded'),
    ...phaseCpuResults(inputs.cpu ?? []), ...ackClockResults(samples, percentile), ...ackBinResults(samples, 10),
    ...appendResults(inputs.rows ?? [], waves, percentile), ...saveResults(inputs.rows ?? [], waves), ...ackEventResults(samples)]
}
const phaseCpuRow = (r: any): r is PhaseCpuSample => typeof r?.phase === 'string' && nonnegative(r.mono_ms) && (r.cgroup === null || object(r.cgroup)) && object(r.procs)
async function observe(args: string[]): Promise<Result[]> {
  countArgs(args, 4)
  const [dir, file, mark, cpuFile] = args, { percentile } = await import('./transcript-receipts.ts')
  const cpu = jsonl(cpuFile, 0, true), items = jsonl(join(dir, 'burst.jsonl'), 0, true)
  return observeResults({ rows: integer(numeric(mark)) ? jsonl(file, Number(mark), true) : undefined, items: records(items) ? items : undefined,
    times: timingRows(join(dir, 'times.jsonl')), cpu: cpu?.every(phaseCpuRow) ? cpu : undefined }, percentile)
}
function cgroupCpuMax() {
  const v2 = textFile('/sys/fs/cgroup/cpu.max')
  if (v2 !== undefined) return v2
  const quota = textFile('/sys/fs/cgroup/cpu/cpu.cfs_quota_us')?.trim(), period = textFile('/sys/fs/cgroup/cpu/cpu.cfs_period_us')?.trim()
  return quota === undefined || period === undefined ? undefined : `${quota === '-1' ? 'max' : quota} ${period}`
}
const cgroupCpuStat = () => textFile('/sys/fs/cgroup/cpu.stat') ?? textFile('/sys/fs/cgroup/cpu/cpu.stat')
function cpuMark(args: string[]) {
  countArgs(args, 1)
  const stat = cgroupCpuStat()
  writeFileSync(args[0], cpuThrottle(stat) ? stat! : '', { flag: 'wx' })
}
function conditions(args: string[]) {
  countArgs(args, 2, 3)
  const [state, pid, mark] = args
  if (!/^\d+$/.test(pid)) throw new Error('usage')
  const memory = textFile('/sys/fs/cgroup/memory.max')?.trim() ?? textFile('/sys/fs/cgroup/memory/memory.limit_in_bytes')?.trim() ?? 'unknown'
  const mount = (textFile('/proc/self/mountinfo') ?? '').split('\n').map(l => l.split(' ')).filter(s => s[4] && (resolve(state) === s[4] || resolve(state).startsWith(s[4].replace(/\/$/, '') + '/'))).sort((a, b) => b[4].length - a[4].length)[0]?.[4] ?? 'unknown'
  const peak = textFile(`/proc/${pid}/status`)?.match(/^VmHWM:\s+(\d+) kB$/m)?.[1] ?? 'unknown'
  const cpu = mark === undefined ? '' : ` ${cpuConditionFields(cgroupCpuMax(), textFile(mark), cgroupCpuStat())}`
  console.log(`recorded: sr8 conditions bun=${Bun.version} cpus=${cpus().length} memory_limit=${memory} fs_type=${statfsSync(state).type} state_dir_mount=${mount} peak_rss_kib=${peak}${cpu}`)
}
async function main(args: string[]): Promise<number> {
  if (!existsSync('/etc/cscb-ci-image')) { console.error('FAIL: sr8-evidence requires the CI image'); return 2 }
  const command = args.shift()
  if (command === 'config') { await config(args); return 0 }
  if (command === 'seed') { await seed(args); return 0 }
  if (command === 'plan') { await plan(args); return 0 }
  if (command === 'bodies') {
    countArgs(args, 2)
    const events = jsonl(args[1]); if (!events || !/^[a-z0-9_]+$/.test(args[0])) throw new Error('usage')
    for (const event of events) console.log(JSON.stringify({ label: args[0], event }))
    return 0
  }
  if (command === 'conditions') { conditions(args); return 0 }
  if (command === 'cpu-mark') { cpuMark(args); return 0 }
  if (command === 'combinations') {
    countArgs(args, 0)
    const p = await population()
    for (const c of p.sr8Combinations()) console.log([c.population, c.mode, c.recipients].join('\t'))
    return 0
  }
  if (command === 'envelope-times') return bulkTimings(args)
  const phase = command === 'seal' ? args.shift()! : ''
  const c = context(args)
  const faultResult = await faultCommands(command!, c, args)
  if (faultResult !== undefined) return faultResult
  if (command === 'burst') return burst(c, args)
  if (command === 'check') return printResults(c, await check(c, args))
  if (command === 'startup-load') {
    countArgs(args, 0, 2)
    const timestamp = (raw: string | undefined) => raw?.trim() ? Number(raw) : NaN
    return printResults(c, [startupVerdict(timestamp(args[0]), timestamp(args[1]), c.population * c.recipients)])
  }
  if (command === 'seal') return printResults(c, await seal(c, phase, args))
  if (command === 'n4') return printResults(c, await n4(c, args))
  if (command === 'windows') return printResults(c, await windows(c, args))
  if (command === 'concurrent-overlap') return printResults(c, concurrentOverlap(c, args))
  if (command === 'observe') { for (const r of await observe(args)) console.log(resultLine(c, r)); return 0 }
  const extra = await additional(command!, c, args)
  if (extra) return printResults(c, extra)
  throw new Error('usage')
}
if (import.meta.main) {
  try { process.exitCode = await main(process.argv.slice(2)) }
  catch (error) { const usage = error instanceof Error && error.message.startsWith('usage'); console.error(`FAIL: sr8-evidence ${error instanceof EvidenceFailure ? error.reason : usage ? 'invalid command arguments' : 'evidence unavailable or invalid'}`); process.exitCode = usage ? 64 : 1 }
}
