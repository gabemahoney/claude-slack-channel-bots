/**
 * session-manager.ts — Library-backed startup orchestration for CSCB.
 *
 * The previous tmux-direct implementation has been replaced with calls to the
 * agent-director TypeScript library `Client` singleton (SR-1). Spawns are
 * keyed by persona (b.av2 SR-2.2): instance ID `cscb_<key>`, tmux session
 * `slack_bot_<key>`, `relay_mode='on'`, and the labels `service=cscb`,
 * `persona=<key>` and `config_dir=<12 hex of the real effective
 * claude_config_dir>`, and no other label. Per-persona reconciliation uses
 * the SR-1.4 collision-then-act dispatch:
 *
 *   1. Try `client.spawn(...)` directly: a plain first spawn from
 *      `buildSpawnParams`, with no reuse flag (b.jg5 SRJ-711), so a row that
 *      is already there collides and step 2 keeps its conversation.
 *   1a. A retired key (b.jg5 SRJ-805, SRJ-806): while the installed
 *      retired-key store (`setRetiredKeyStore`) has the key recorded, marked
 *      or not, every launch path for it makes no plain spawn and no `resume`.
 *      Its first launch is a reuse spawn of the same id in place of step 1
 *      (an ordinary fresh spawn with no row; a reset to a new life on a
 *      finished row); a live row makes it collide, and step 2's `get`
 *      decides: a finished row gets the replace step's reuse; with no "new
 *      life has begun" mark a live row (`pending` included) is the old life
 *      and goes through the live-row sequence with the retired-key flag;
 *      with the mark set a live row is the new life, handled by step 2's
 *      live branches as any live row. Every `resume` those branches would
 *      make is a reuse spawn instead, and the live-row sequence's start entry
 *      sets the retired-key flag for the key. A reuse spawn that succeeds for
 *      a key recorded both when its call was made and at its success sets
 *      its mark through the store and answers `fresh-retired`
 *      (`SPAWN_ACTION_FRESH_RETIRED`), a success like `spawned`, never turned
 *      into an amnesia result; a key recorded only while the call was in
 *      flight gets no mark and answers `spawned`. A mark whose write failed
 *      is held by the store and written again at the key's next launch
 *      decision.
 *   2. On `ErrInstanceIdCollision`, call `client.get(...)` through the shared
 *      own-row read (`readPersonaOwnRow`, b.jg5 SRJ-114). A read that latched
 *      the persona (a configured persona's own row reading `pending` with no
 *      launch start, or carrying a `provenance_conflict` note, or an UNUSABLE
 *      NAME answer) ends the ladder with `latched` before anything below,
 *      the `cwd` and `config_dir` guards included. A row whose `cwd`
 *      differs from the persona's working directory by real path is replaced
 *      whatever its state, with no row deleted (b.av2 SR-6.2 as amended,
 *      b.jg5 SRJ-1503). Otherwise branch on the observed state (ended/missing
 *      → resume, or the replacement when `resume_enabled` is false; waiting
 *      → /mcp reconnect via sendKeys; working →
 *      wait for waiting (or, b.f2b, for positive evidence that the row is
 *      stale and the session idle: the same idle pane and the same transcript,
 *      ended with a completed turn, across a window) then reconnect;
 *      check_permission/ask_user → one one-line `read-pane` of the row:
 *      no-op on a pane or a read that could not answer, and a findMissing
 *      sweep, then resume or spawn once its row reads dead, when
 *      agent-director finds no pane of its launch or no row (b.jdc, b.jg5
 *      SRJ-607); pending → the ladder's `pending` step: no-op with the
 *      persona's retry timer armed in pending-only mode for a covered row
 *      (b.jg5 SRJ-409), or the replacement when the row is not covered, its
 *      `cwd` or `config_dir` label differing, b.jg5 SRJ-411). Nothing is ever typed
 *      into a prompt. Before any resume, a row whose `config_dir` label is
 *      missing or differs from the persona's current effective
 *      claude_config_dir is replaced instead (a resume keeps the old config
 *      dir; b.av2 SR-6.2 as amended, b.jg5 SRJ-1504). Every replacement goes
 *      through one replace step (`replacePersonaRow`, b.jg5 SRJ-707), which
 *      decides on the row state the path last read: a finished row (`ended`,
 *      `missing` or no row) gets a reuse spawn of the same id
 *      (`reuseSpawnForPersona`, SRJ-112), whose collision re-runs this
 *      get-then-act once (a second collision arms the reuse-collision cause
 *      and answers `retrying`, uncounted); a live row (`pending`
 *      included) starts the live-row sequence (SRJ-705), which ends in that
 *      reuse spawn, and the ladder answers `sequence-waiting` with no other
 *      call. A replacement at the resume step whose path last read the row
 *      live but holds no dead evidence reads the row again first, and the
 *      fresh state decides (b.jg5 SRJ-609, SRJ-611). No ladder path deletes
 *      a row or kills one, and none launches over a live row. The `resume`'s
 *      outcomes follow SRJ-113 through one handler shared with the live-row
 *      sequence's launch (`resumeAtSite`). A resume's `ErrSpawnNotResumable`
 *      re-reads the row (b.jg5 SRJ-710): `pending` goes to the ladder's
 *      `pending` step, with nothing counted or posted; another live state
 *      starts the live-row sequence, with the conversation kept, only when
 *      the path holds dead evidence (SRJ-611); anything else is a lost race:
 *      nothing is killed, deleted or launched, the retry timer is armed with
 *      the lost-race cause, and the ladder answers `retrying`, uncounted.
 *      Every plain spawn (the first, the retry after the collision `get`
 *      found no row, the one after `resume` found none, at both `resume`
 *      sites) takes SRJ-111's table through one handler
 *      (`plainSpawnOutcomeAt`): a later plain spawn's collision re-runs this
 *      get-then-act once, and a plain spawn's collision in that re-run arms
 *      the collision cause and answers `retrying`, uncounted; no collision,
 *      at a plain spawn, a reuse spawn or a `resume`, raises a spawn-failure
 *      notice (b.jg5 SRJ-713).
 *   3. Any other error raises a spawn-failure notice for the persona via
 *      `notifySpawnFailure` (through the per-persona notifier) and is logged,
 *      except a refusal (b.jg5 SRJ-105, `refusalAt`): an UNAVAILABLE,
 *      ENVIRONMENT (`ErrTmuxNotAvailable`, SRJ-311), CONFIG
 *      (`ErrConfigMalformed`, SRJ-316: the wrapper has raised the
 *      `ad-config-malformed` outage) or UNCLASSIFIED (SRJ-313: an
 *      `ErrInternal` other than an unusable recorded name, a store-open
 *      name, `ErrSystemInstallDisappeared`, any name CSCB gives no handling,
 *      a plain spawn's STATE or GONE name, and a resume's or a plain spawn's
 *      `ErrInvalidFlags` after its re-check) outcome at any
 *      spawn or resume, or a read error (an
 *      ENVIRONMENT, CONFIG or UNCLASSIFIED answer included) at the collision
 *      `get`. It is logged once and stops the ladder with `failed`, which
 *      the launch answers as `retrying` once that error armed the retry
 *      timer: no notice, no `spawn-failed` entry, no `dead-session`
 *      verdict, and no further launch. An `ErrTmuxSessionCreate` (LAUNCH
 *      FAILURE, decided by name) at any spawn or resume the ladder makes is
 *      one counted launch failure (b.jg5 SRJ-602, SRJ-111, SRJ-113): one
 *      line, the notice, a `spawn-failed` entry at start and `failed`;
 *      nothing is killed because of it and no spawn is made in its place,
 *      and the persona's retry timer is armed at once in pending-only mode,
 *      so that the retry's read of the row decides (`launchFailureResult`;
 *      SRJ-301, SRJ-409): a failed fresh spawn's `pending` row, never CSCB's
 *      own launch, is waited out through the pending-row rule and never
 *      killed (SRJ-713, SRJ-410). An UNCLASSIFIED outcome has also been
 *      reported to the persona's unclassified-error episode
 *      (`src/persona-episodes.ts`). A `status` error in the working-row wait
 *      is no refusal: the wait goes on, or at its timeout ends
 *      `not-reconnected` (b.jg5 SRJ-605, `waitForWaitingAndReconnect`). The
 *      reconnect keystroke is one `send-keys`, never retried, decided by
 *      b.jg5 SRJ-118's reconnect row (`reconnectMcpWithCause`): it never
 *      raises a spawn-failure notice, and its `transient` answer ends the
 *      ladder `latched` for a latched persona and otherwise `retrying`,
 *      uncounted.
 *   4. A CONFLICT (`ErrTmuxSessionConflict`, b.jg5 SRJ-105, SRJ-501) at any
 *      spawn or resume the ladder makes (the first spawn, the retry spawn
 *      after the collision `get` found no row, the spawn after `resume`
 *      found none, the resume, and every reuse spawn of the same id: the
 *      replace step's and the one after resume's no-transcript answer) takes the
 *      CONFLICT row (`conflictAt`): the persona latches
 *      through the installed latch (`setConflictLatch`) with the refused
 *      operation "plain spawn", "reuse spawn" or "resume" and the row state the path last
 *      read before the call (one latch-time `status` read when it read
 *      nothing), and the ladder answers `latched`: no notice from here, no
 *      `spawn-failed` entry, nothing counted, and no further
 *      launch. A latched persona is not launched at all: `spawnForPersona`
 *      answers `latched` with no agent-director call (b.jg5 SRJ-502).
 *   5. An UNUSABLE NAME answer (an `ErrInternal` naming "the recorded tmux
 *      session name", b.jg5 SRJ-105, SRJ-512) at any of those spawns or the
 *      resume takes the UNUSABLE NAME row (`unusableNameAt`): the persona
 *      latches with the case "unusable recorded name", the refused operation
 *      "none" and the row state the path last read (one latch-time `status`
 *      read when it read nothing), and the ladder answers `latched`, as at
 *      the CONFLICT row: no notice from here, no `spawn-failed` entry,
 *      nothing counted, and no further launch or reuse, so no
 *      tmux-touching call follows it. Every other `ErrInternal` stays
 *      UNCLASSIFIED (step 3). The persona teardown's kill
 *      (`killPersonaInstanceForTeardown`) latches nothing.
 *   5a. An `ErrInvalidFlags` at a reuse spawn of the same id (b.jg5 SRJ-112,
 *      SRJ-207; `reuseSpawnFailedAt`) gets one immediate version re-check;
 *      unless it stops the server, the persona is held on `ErrInvalidFlags`
 *      through the installed hold (`setInvalidFlagsHold`) and the launch
 *      answers `held`: no notice, no `spawn-failed` entry, nothing counted or
 *      armed, and no other launch. A held persona is not launched at all:
 *      `spawnForPersona`, the live-row sequence's start entry and its
 *      sequence-launch entry answer `held` with no agent-director call. Only
 *      a reuse holds: a `resume`'s `ErrInvalidFlags` keeps the re-check,
 *      then UNCLASSIFIED (step 3).
 *   6. Every kill is a checked kill (`src/checked-kill.ts`; b.jg5 SRJ-110,
 *      SRJ-701): `killPersonaInstance` answers its outcome, `kill_sent`
 *      included, and never throws; its context (`KILL_CONTEXT_ATTEMPT` or
 *      `KILL_CONTEXT_TEARDOWN`) is required. The collision ladder makes no
 *      kill: a live row's kills are the live-row sequence's, which run
 *      through the bounded retry (`retryPersonaKill`, `src/kill-retry.ts`;
 *      b.jg5 SRJ-702) as the restart path's kill does, and raise the retry's
 *      kill-failure alert decision (`raisePersonaKillFailureAlert`, through
 *      the installed kill-failure alerts; b.jg5 SRJ-704). The persona
 *      teardown's kill runs through the same bounded retry
 *      (`killPersonaInstanceForTeardown`, b.jg5 SRJ-715), arming nothing and
 *      latching nothing; its caller raises the alert decision on the
 *      persona-teardown route. No path here deletes a persona's row.
 *
 * Own-row reads (b.jg5 SRJ-114, SRJ-115, SRJ-116): every `get` of a
 * persona's own row at SRJ-114's sites goes through `readPersonaOwnRow`, whose
 * act step (`actOnOwnRowRead`) the start sweep applies to each row of its
 * `list`, and every own-row `status` the session manager makes, the dialog
 * approver's included, through `readPersonaOwnRowStatus`, which applies the
 * own-row `status` step (`applyOwnRowStatusStep`; the liveness and reconnect
 * adapters in `src/server.ts` apply it after their own calls). Both apply
 * the row-read rule (`decideOwnRowRead`, `src/row-read-rules.ts`) to every
 * row or result they read: a configured persona's own row that reads
 * `pending` with no launch start latches the persona with the case "launch
 * start not recorded" (b.jg5 SRJ-513), whether or not it is the persona's
 * current life, and a `get` or `list` row carrying the `provenance_conflict`
 * note latches it with "conflicting labels" (a row with both latches with
 * the first only).
 * Any key's own row read live other than `pending` while the installed
 * retired-key store (`setRetiredKeyStore`) has the key recorded with its
 * mark set clears the key's entry, beside any latch the same read decides
 * (b.jg5 SRJ-807); the persona teardown kill's `status` read between its
 * tries applies that clear alone and latches nothing (`readTeardownKillRow`,
 * SRJ-715, SRJ-115), and so does the start sweep kill's (`sweepKillRead`,
 * SRJ-714).
 * An UNUSABLE NAME answer to either read latches the persona with the state
 * unreadable. A read that latched answers `latched`, and the caller calls
 * nothing more for the persona: no `send-keys`, kill, delete or launch, and
 * no hand-off to the `pending` deferral or the pending-only retry. A row
 * either read reads `ended` or `missing`, or an `ErrSpawnNotFound` answer,
 * ends the persona's kill-failure episode silently (b.jg5 SRJ-704,
 * SRJ-1016).
 * Old-life holds (b.jg5 SRJ-809): the server's one hold set
 * (`setOldLifeHolds`) is told of every read the session manager makes of a
 * row through one entry (`noteOldLifeRowRead`): the shared `get` and `status`
 * reads (so every kill retry's between-try read and the server's adapters
 * too), the teardown and start-sweep kills' between-try reads, every
 * completed `find-missing` run's `ids` and the start sweep's `list`. A read
 * of `ended` or `missing`, no row, or a listing in `ids` ends the hold on
 * that id, and a live `get` or `list` row's `cwd` re-points it; a recorded
 * key's reuse that began its new life ends the hold on `cscb_<key>`. No kill
 * outcome ends a hold. The start sweep begins holds, and a teardown or sweep
 * kill whose tries decided the ordinary kill-failure alert marks its hold
 * kill-failed (SRJ-812). Every
 * `read-pane` of a persona's own row outside the dialog approver goes
 * through the shared read-pane (`readPersonaOwnPane`, b.jg5 SRJ-117; the
 * outcome and its class in `src/pane-read.ts`). Its uses (the launch wait's
 * evidence read and the restart path's `waiting`-row check through
 * `readWorkingPane`, the `working`-row verdict in `src/server.ts`, whose
 * pane `checkWorkingRowPane` folds, and b.jdc's one-line reads of an
 * `ask_user` or `check_permission` row: the prompt-row verdict
 * `promptRowReconnectVerdict` in `src/server.ts` and the ladder's
 * `launchOnPromptRow`; and the pending-row rule's lap,
 * `readPendingRowLapPane`, the only read made with `allow_pending`) latch on
 * a CONFLICT answer,
 * with the refused operation "P's next check or recovery", and on an
 * UNUSABLE NAME answer, each with the state its caller last read; a latched
 * persona is not read, and its caller ends with nothing typed. A pane that
 * any of them reads, or the dialog approver reads, may be a single
 * leftover's (b.jg5 SRJ-613), so none acts on a pane alone: the `send-keys`
 * that follows is the backstop (the reconnect's CONFLICT "not this launch's
 * session" latches P with nothing typed; the approver's and the pending-row
 * lap's Enter answering `ErrSpawnNotInteractive` on a `pending` row types
 * nothing, stops the approver with no kill, and ends the lap with no
 * further lap on that launch; see `src/pane-read.ts`).
 *
 * Both row checks go through `compareRowToPersona`. At most one launch per
 * persona is in flight (b.av2 SR-6.3): a concurrent call for the same key
 * joins the running ladder. A launch that returned success starts the
 * persona's dialog approver after its launch call, outside the launch and
 * its attempt, in a registry holding at most one approver per persona
 * (`startDialogApprover`, b.jg5 SRJ-401); a teardown or shutdown stops it
 * (`stopDialogApprover`, `stopAllDialogApprovers`, SRJ-404), and so does a
 * latch of the persona set by any site (the set observer the latch installer
 * registers, `setConflictLatch`, SRJ-502). The approver paces its laps
 * (SRJ-403), stops at B from the launch start with no post (SRJ-404,
 * SRJ-405) and classifies every answer by class (SRJ-117, SRJ-118). Every launch
 * first resolves the persona's claude_config_dir to a real path with no
 * lexical fallback (bug b.g57,
 * `checkLaunchConfigDir`); when it cannot be resolved the launch makes no
 * agent-director call, keeps the row, hands the persona to the installed
 * hook (`setConfigDirUnresolvableHook`: the bring-up controller holds it
 * `retrying` and re-checks) and returns `deferred`. Every ladder run first
 * calls the installed pre-launch trust patcher (`setPreLaunchTrustPatcher`,
 * b.av2 SR-6.2), so the persona's `.claude.json` trust flags are set before
 * any spawn or resume.
 * Immediately before each `client.spawn` / `client.resume` it calls the
 * installed pre-launch reply guard (`setPreLaunchReplyGuard`, b.av2 SR-9.4):
 * the persona's reply-guard record, launched-with dir and managed Stop hook.
 * A path that only reconnects to a live instance or does nothing runs no
 * reply-guard step (the optimistic spawn's steps are undone on a collision).
 *
 * The start sweep (`reconcileOrphans`, b.av2 SR-6.3, b.jg5 SRJ-116,
 * SRJ-714) makes one `list` of every `service=cscb` row in every state; a
 * list failure records `orphan-cleanup-list-failed` and the sweep does
 * nothing more. Over the whole list, before any kill, it applies the shared
 * own-row read's act step to each row whose id is a key's own, so a
 * configured persona whose own row carries `provenance_conflict` or reads
 * `pending` with no launch start latches (once per episode, after a restart
 * too, b.jg5 SRJ-504), and a marked retired key's row read live other than
 * `pending` clears its entry (SRJ-807); a latched persona's own row and
 * every row labelled with it are then left unkilled for the whole pass,
 * whatever else the sweep would decide for them (b.jg5 SRJ-502, AC 55).
 * Next, in one write before the first kill, it records as retired the key
 * of every listed row labelled with a persona absent from the applied
 * configuration, with the cause `absent-at-start` (b.jg5 SRJ-714, SRJ-803);
 * a failed write leaves the file as it was while the store holds those keys
 * in memory, and the sweep goes on. Still before the first kill it begins an
 * old-life hold (b.jg5 SRJ-809) on the `cwd` of every row listed live
 * (`pending` included) whose key is recorded as retired without the "new
 * life has begun" mark, whether it then kills, keeps or spares the row for a
 * latch: holds live in server memory, so this restores after a restart the
 * holds apply step 1 began. Then it kills, with the result checked,
 * each remaining live row with a persona absent from the applied
 * configuration, an instance ID other than `cscb_<key>`, or a `cwd` other
 * than its persona's working directory, and each live pre-persona row (no
 * `persona` label, b.1ix); a finished row is never killed (each kill a
 * checked kill, b.jg5 SRJ-110, SRJ-701, run through the bounded retry with
 * one pass budget, SRJ-702; no kill latches anything or arms a retry timer).
 * It deletes no row (b.jg5 SRJ-714, SRJ-1506 amending b.av2 SR-6.3): every
 * row is kept, whatever its kill's outcome, pre-persona and absent-persona
 * rows are never resumed, and agent-director's `expire` removes them later.
 * A kill that did not succeed holds the row's `cwd` for an old life (its
 * old key the `persona` label's key, or the instance id for a pre-persona
 * row or an id that is not the label's `cscb_<key>`), marked kill-failed
 * when its tries decided the ordinary kill-failure alert (SRJ-809, SRJ-812);
 * no hold begins once the sweep has stopped.
 * One findMissing run follows the kills, over every row given one, so a
 * killed row reads `missing` once its session is gone and isn't killed again
 * at the next start, and one summary line ends the sweep. Once the server
 * begins shutting down, the sweep makes no further agent-director call. While a
 * persona's working directory cannot be resolved to a real path, neither the
 * sweep nor the collision ladder acts on `cwd` grounds on a row whose `cwd`
 * has no real path either (b.av2 SR-6.4): the sweep defers the check to the
 * launch, and the ladder keeps the row and fails the launch instead. A row
 * whose `cwd` resolves to an existing directory is still a `cwd` mismatch.
 *
 * At start, `startupSessionManager` brings each applied persona up through
 * the b.av2 SR-6.1 procedure (`persona-start.ts`, driven by the bring-up
 * controller in `persona-bringup-controller.ts`): the local credentials and
 * working-directory checks, Slack validation and connection (every persona at
 * once), then the launch through `spawnForPersona` (at most `concurrency` at
 * a time) for each persona that is up. A launch that starts waiting for a
 * `working` row is left to finish in the background, still in flight, so the
 * pass does not wait for it (b.f2b). A restart (`launchSession`) runs the
 * launch only, and only while the caller's gate says the persona is up.
 * Every collision ladder runs as a launch attempt for its persona (b.jg5
 * SRJ-301): an UNAVAILABLE, ENVIRONMENT, CONFIG or UNCLASSIFIED outcome, or a
 * `status`, `get` or `list` error, inside it arms the persona's retry timer, and a `failed`
 * launch whose last agent-director error armed it answers `retrying`
 * (`SPAWN_ACTION_RETRYING`, b.jg5 SRJ-1015), which the restart path never
 * counts and the start pass counts only in its `retrying` count.
 *
 * The live-row sequence (`src/live-row-sequence.ts`, b.jg5 SRJ-705) runs
 * through the dependencies `buildLiveRowSequenceDeps` binds to the shared
 * entries here, and makes its final launch through one launch call,
 * `launchForLiveRowSequence`: a `resume` whose outcomes follow SRJ-113
 * through the one handler the collision ladder's `resume` uses too
 * (`resumeAtSite`), its no-transcript answers going on to the no-transcript
 * step (`noTranscriptReuse`, b.jg5 SRJ-707, SRJ-712: after `ErrJsonlMissing`
 * the lost-transcript diagnosis, then the reuse spawn), its
 * `ErrSpawnNotFound` to one plain spawn and its `ErrSpawnNotResumable` to
 * one re-read that ends the sequence without its launch (SRJ-710: never a
 * second sequence), or the reuse spawn
 * (`reuseSpawnForPersona`, b.jg5
 * SRJ-112, SRJ-708: `buildSpawnParams` with the reuse flag, its outcomes
 * classified by name), whose collision ends the sequence without its launch;
 * the entry counts its launch's result once. Sequences run in the
 * server's one registry (`setLiveRowSequenceRegistry`, b.jg5 SRJ-706),
 * reached through the start entry (`startLiveRowSequence`) and the running
 * query (`isLiveRowSequenceRunning`); a latch of the persona stops its
 * sequence (the set observer the installers register). While a sequence runs
 * for a persona, every launch path for it answers `sequence-waiting` with no
 * agent-director call (the gate in `spawnForPersona`, which `launchSession`
 * answers as the uncounted `'refused'`); the sequence's own launch,
 * `launchForLiveRowSequence`, is exempt, and makes no call once the sequence
 * is stopped. Its production starters are the collision ladder's
 * replacement sites, through the replace step (`replacePersonaRow`, b.jg5
 * SRJ-707): a live row there (`pending` included) starts a sequence with the
 * conversation not kept and alert context `recovery`; and the ladder's
 * `resume` answering `ErrSpawnNotResumable` on a path that holds dead
 * evidence no read of the row as finished or gone has voided (dead evidence
 * covers one life), whose re-read finds the row live other than `pending`
 * (`spawnNotResumableAtLadder`, b.jg5 SRJ-710, SRJ-611): a sequence with the
 * conversation kept, which ends in `resume`. Either way the launch answers
 * `sequence-waiting`. The sequence's launch is never part of the start pass:
 * it runs detached, after its starter's answer was counted, and passes the
 * start flag false, so it writes no startup-errors entry (the lost-transcript
 * diagnosis at its `resume` keeps its lines and notices).
 *
 * The old-life wait (b.jg5 SRJ-811, SRJ-812, SRJ-1512) is the sequence's
 * no-launch form on a held old row's instance id, started in the same
 * registry through `ensureOldLifeWait` with its own dependencies
 * (`buildOldLifeWaitDeps`): every call under the old key (or the instance id
 * standing in), arming nothing for it, its kill keeping its tries until a
 * shutdown, the last waiter's teardown or, on a configured persona's own
 * row, that persona's latch, and ending them as a success when the hold
 * ends; its end handler routes the round's results by class
 * (`src/old-life-wait.ts`): log-only entries, the old row's
 * unclassified-error episode (keyed by the instance id), the hold's
 * kill-failed mark, and each waiting persona's retry timer. A hold's end
 * stops its wait and ends that episode; the
 * registry's close stops it at shutdown. While a wait runs for a hold a
 * persona waits on, that persona's retries are blocked
 * (`personaRetryBlockCause`) and a lost message reports `restarting`
 * (`isSequenceOrOldLifeWaitRunning`); once the hold's kill has failed, it
 * reports `kill-failed` (`waitsOnKillFailedHold`). A launch of a persona
 * whose own row carries a wait answers `sequence-waiting` with the persona
 * recorded as waiting on that hold and its retry timer armed.
 *
 * What a hold refuses (b.jg5 SRJ-810, SRJ-1502, SRJ-1505): while a directory
 * D is held, session admission refuses a session opened from D
 * (`oldLifeHeldDirectory`, the held-directory query `main()` gives
 * `decideSessionAdmission`); no `/mcp reconnect` is typed into a held own
 * row (`reconnectMcpWithCause`'s guard, `isOwnRowOldLifeHeld`); and no
 * persona whose working directory is D is launched: the hold step
 * (`oldLifeHoldStep`), at `spawnForPersona`'s old-life gate, at the
 * sequence-launch entry and at the restart path's old-life hook, records the
 * persona as waiting, starts the hold's wait (`ensureOldLifeWait`) when it is
 * not running and arms its retry timer, and the launch answers
 * `sequence-waiting`. A hold on the persona's own row is not the gate's: a
 * destructive modify's same-key new half waits by the retired-key rule, and
 * a held own row of a key not recorded is replaced through the live-row
 * sequence. Once a hold ends, `main()`'s end observer
 * (`createOldLifeHoldEndRetry`) retries each persona recorded as waiting on
 * it at once, one waiting on its own row once the wait the end stopped
 * there has settled; a persona teardown forgets the key's waits and stops a
 * wait no persona left waits on (`forgetOldLifeWaits`).
 *
 * No tmux process-tree walks, no JSONL existence checks for resume eligibility:
 * the library encapsulates both.
 *
 * SPDX-License-Identifier: MIT
 */

import type { Client, ListRow, SpawnParams, FindMissingResult, GetResult } from 'agent-director'

import type {
  Phase1GetResult,
  Phase1ResumeResult,
  Phase1SpawnParams,
  Phase1SpawnResult,
  Phase1StatusResult,
  PreTrust,
} from './ad-phase1-types.ts'

import { checkCozempicAvailable, resolveJsonlPath } from './cozempic.ts'
import {
  type Persona,
  type PersonaConfig,
  type StrictRealPathFs,
  MCP_SERVER_NAME,
  resolveRealPathStrict,
  tryResolveRealPath,
} from './config.ts'
import { checkPersonaConfigDir, type ConfigDirCheckResult } from './persona-bringup.ts'
import type { PersonaCheckFailure } from './persona-diagnostics.ts'
import {
  CONFIG_DIR_LABEL_PREFIX,
  PERSONA_INSTANCE_ID_PREFIX,
  PERSONA_LABEL_KEY,
  PERSONA_LABEL_PREFIX,
  SERVICE_LABEL,
  configDirLabelValue,
  personaInstanceId,
  personaSpawnEnv,
  personaTmuxSessionName,
  renderPersonaRef,
  resolveClaudeConfigDir,
  tmuxExactSessionTarget,
} from './persona-identity.ts'
import { getClient } from './agent-director-client.ts'
import {
  armPendingOnlyAfterLaunchFailure,
  armPendingOnlyForPendingRow,
  clearOutageFlag,
  endTmuxUnresponsiveForLaunchRow,
  getOutageFlags,
  raiseAdConfigMalformed,
  raiseTmuxUnavailable,
  reportAgentDirectorError,
  reportDeferredUnavailable,
  reportLostRaceAtSite,
  reportReuseCollisionAtSite,
  reportUnclassifiedAtSite,
  setOutageFlag,
  withOutageDetection,
  withSpawnDetection,
  type OutageDetectionOptions,
} from './outage-state.ts'
import {
  AgentDirectorError,
  ErrSpawnCapReached,
  ERR_INSTANCE_ID_COLLISION_NAME,
  ERR_JSONL_MISSING_NAME,
  ERR_JSONL_NEVER_WRITTEN_NAME,
  ERR_NO_SESSION_ID_NAME,
  ERR_SPAWN_CAP_REACHED_NAME,
  ERR_SPAWN_NOT_FOUND_NAME,
  ERR_SPAWN_NOT_INTERACTIVE_NAME,
  ERR_SPAWN_NOT_RESUMABLE_NAME,
} from './agent-director-errors.ts'
import {
  AD_ERROR_CLASS_CONFIG,
  AD_ERROR_CLASS_CONFLICT,
  AD_ERROR_CLASS_DIRECTORY,
  AD_ERROR_CLASS_ENVIRONMENT,
  AD_ERROR_CLASS_GONE,
  AD_ERROR_CLASS_LAUNCH_FAILURE,
  AD_ERROR_CLASS_UNAVAILABLE,
  AD_ERROR_CLASS_UNCLASSIFIED,
  AD_ERROR_CLASS_UNUSABLE_NAME,
  adKillCall,
  type AdErrorClass,
  type AdKillCall,
  type AdVerb,
  classifyAdError,
  classifyWithInvalidFlagsRecheck,
  conflictDescriptionOf,
  describeAdErrorClassification,
  describeAgentDirectorFailure,
  hasAdErrorName,
  isInvalidFlagsError,
  isLaunchTimeoutError,
  LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT,
  LAUNCH_TIMEOUT_FORM_TMUX_UNRESPONSIVE,
  launchTimeoutFormOf,
  unclassifiedClassificationOf,
  type LaunchTimeoutForm,
  type InvalidFlagsError,
} from './ad-error-class.ts'
import { RECHECK_OUTCOME_STOP, lastAdVersionSeen } from './ad-version-gate.ts'
import {
  INVALID_FLAGS_HOLD_DECISION_STOP,
  decideInvalidFlagsHold,
  describeHoldVersion,
  invalidFlagsHeldNoLaunchLine,
  type InvalidFlagsHold,
} from './invalid-flags-hold.ts'
import {
  KILL_OUTCOME_KILLED,
  KILL_OUTCOME_NOT_KILLED,
  KILL_REFUSAL_AT_KILL,
  KILL_REFUSAL_AT_READ,
  checkedKill,
  describeKillOutcome,
  killLetsNextStepRun,
  killOutcomeStopsServer,
  type KillOutcome,
  type KillRefusal,
} from './checked-kill.ts'
import {
  KILL_FAILURE_CONTEXT_OLD_LIFE_WAIT,
  KILL_FAILURE_CONTEXT_RECOVERY,
  KILL_FAILURE_CONTEXT_START_SWEEP,
  KILL_FAILURE_CONTEXT_STUCK_LAUNCH_ABORT,
  KILL_FAILURE_VERSION_ORDINARY,
  KILL_FAILURE_VERSION_SURVIVOR,
  ORPHAN_CLEANUP_LABEL,
  describeKillFailureDescriptions,
  killFailureAlertContentOf,
  killFailureAlertEntryText,
  killFailureAlertText,
  selectKillFailureAlertRoute,
  type KillFailureAlertContext,
} from './kill-failure-alert.ts'
import {
  KILL_FAILURE_END_ROW_FINISHED,
  KILL_FAILURE_END_ROW_GONE,
  PERSONA_UNCLASSIFIED_ERROR_LABEL,
  UNCLASSIFIED_ERROR_END_HOLD_ENDED,
  createPersonaEpisodes,
  createUnclassifiedErrorEpisodes,
  type KillFailureAlerts,
  type KillFailureEndReason,
  type PersonaEpisodes,
  type PersonaEpisodesClock,
  type UnclassifiedErrorEpisodes,
} from './persona-episodes.ts'
import {
  KILL_RETRY_ALERT_NONE,
  KILL_RETRY_ALERT_ORDINARY,
  KILL_RETRY_END_READ_LATCHED,
  KILL_RETRY_END_STOPPED,
  KILL_RETRY_READ_FAILED,
  KILL_RETRY_READ_LATCHED,
  KILL_RETRY_READ_NO_ROW,
  KILL_RETRY_READ_STATE,
  KILL_RETRY_SEED_LIVE_UNREAD,
  KILL_RETRY_SEED_NOT_LIVE_VALUE,
  KILL_RETRY_SYSTEM_CLOCK,
  createKillRetryPassBudget,
  killRetrySeedIsLive,
  killRetrySeedOfState,
  killRetryStopped,
  runKillRetry,
  type KillRetryAlert,
  type KillRetryPassBudget,
  type KillRetryRead,
  type KillRetryResult,
  type KillRetrySeed,
  type KillRetryWait,
} from './kill-retry.ts'
import {
  FULL_PANE_READ_LINES,
  PANE_READ_ABSENT,
  PANE_READ_CONFIG,
  PANE_READ_CONFLICT,
  PANE_READ_ENVIRONMENT,
  PANE_READ_GONE,
  PANE_READ_LATCHED,
  PANE_READ_NOT_READ_LATCHED,
  PANE_READ_PANE,
  PANE_READ_UNAVAILABLE,
  PANE_READ_UNCLASSIFIED,
  PANE_READ_UNUSABLE_NAME,
  paneReadClassNote,
  PROBE_PANE_READ_LINES,
  paneReadFailureOf,
  type PaneReadConflict,
  type PaneReadFailure,
  type PaneReadOutcome,
  type PaneReadUnclassified,
  type PaneReadUnusableName,
} from './pane-read.ts'
import {
  CONFLICT_LATCH_SET_LATCHED,
  CONFLICT_LATCH_SET_RELATCHED,
  CONFLICT_LATCH_SET_SAME_CASE,
  LATCH_CASE_LAUNCH_START_NOT_RECORDED,
  LATCH_CASE_NOT_THIS_LAUNCH,
  LATCH_ROW_STATE_KIND_NO_ROW,
  LATCH_ROW_STATE_KIND_READ,
  LATCH_ROW_STATE_KIND_UNREADABLE,
  LATCH_ROW_STATE_NO_ROW,
  LATCH_ROW_STATE_UNREADABLE,
  REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY,
  REFUSED_OPERATION_PLAIN_SPAWN,
  REFUSED_OPERATION_RESUME,
  REFUSED_OPERATION_REUSE_SPAWN,
  describeLatchRowState,
  isUnusableNameError,
  latchRowStateRead,
  launchStartNotRecordedSetInput,
  recogniseConflictCase,
  unusableNameSetInput,
  type ConflictLatch,
  type ConflictLatchCase,
  type ConflictLatchRecord,
  type ConflictLatchSetEvent,
  type ConflictLatchSetOutcome,
  type LatchRowState,
  type RefusedOperation,
} from './conflict-latch.ts'
import {
  LATCHING_LIVENESS_NOTE,
  decideOwnRowRead,
  decideRetiredEntryClear,
  isLatchingLivenessNote,
  isPersonaOwnRow,
  type RowReadClearDecision,
  type RowReadLatchDecision,
  type RowReadRow,
} from './row-read-rules.ts'
import {
  OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL,
  OLD_LIFE_HOLD_CAUSE_START_SWEEP_LISTING,
  OLD_LIFE_HOLD_END_FIND_MISSING_IDS,
  OLD_LIFE_HOLD_END_NEW_LIFE,
  OLD_LIFE_HOLD_END_READ_ENDED,
  OLD_LIFE_HOLD_END_READ_MISSING,
  OLD_LIFE_HOLD_LOG_PREFIX,
  RETIRED_KEY_CAUSE_ABSENT_AT_START,
  RETIRED_KEYS_NOT_RECORDED,
  RETIRED_KEYS_UNCHANGED,
  RETIRED_KEYS_WRITE_FAILED,
  RETIRED_KEYS_WRITTEN,
  oldLifeKeyOf,
  type OldLifeHold,
  type OldLifeHoldEndObserver,
  type OldLifeHoldEndReason,
  type OldLifeHoldPersona,
  type OldLifeHoldSet,
  type RetiredKeyStore,
} from './retired-keys.ts'
import {
  RETRY_BLOCK_LAUNCH,
  RETRY_BLOCK_LIVE_ROW_SEQUENCE,
  RETRY_BLOCK_OLD_LIFE_WAIT,
  claimTimerRetryRuleRun,
  currentAttemptLastError,
  isInsideTimerRetry,
  runDetachedRecoveryAttempt,
  runInAttempt,
  runOutsideAttempts,
  retryRunGateStop,
  unavailableRetryCauseFor,
  UNAVAILABLE_RETRY_CAUSE_LOST_RACE,
  UNAVAILABLE_RETRY_CAUSE_OLD_LIFE_HOLD,
  UNAVAILABLE_RETRY_CAUSE_REUSE_COLLISION,
  UNAVAILABLE_RETRY_CAUSE_SEQUENCE_ENDED,
  UNAVAILABLE_RETRY_CAUSE_SEQUENCE_NOT_JUDGED,
  UNAVAILABLE_RETRY_PENDING_STEP_KEPT,
  UNAVAILABLE_RETRY_PENDING_STEP_LATCHED,
  UNAVAILABLE_RETRY_PENDING_STEP_ROW,
  UNAVAILABLE_RETRY_PENDING_STEP_SEQUENCE_STARTED,
  UNAVAILABLE_RETRY_ROW_ABSENT,
  type AttemptView,
  type RetryBlockCause,
  type RetryRunGateDeps,
  type UnavailableRetryPendingStep,
  type UnavailableRetryRowRead,
  type UnavailableRetryTriggerSink,
} from './unavailable-retry.ts'
import {
  LIVE_ROW_ARM_ENDED,
  LIVE_ROW_ARM_LOST_RACE,
  LIVE_ROW_ARM_NOT_JUDGED,
  LIVE_ROW_ARM_REUSE_COLLISION,
  LIVE_ROW_LAUNCH_ANSWER_LAUNCHED,
  LIVE_ROW_LAUNCH_REUSE,
  LIVE_ROW_LAUNCH_SUCCESS_ACTIONS,
  LIVE_ROW_NOT_LAUNCHED_NOT_APPLIED,
  LIVE_ROW_NOT_LAUNCHED_NOT_RESUMABLE,
  LIVE_ROW_NOT_LAUNCHED_NOT_RESUMABLE_LATCHED,
  LIVE_ROW_NOT_LAUNCHED_NOT_RESUMABLE_PENDING,
  LIVE_ROW_NOT_LAUNCHED_REUSE_COLLISION,
  LIVE_ROW_NOT_LAUNCHED_SPAWN_COLLISION,
  LIVE_ROW_NOT_LAUNCHED_STOPPED,
  LIVE_ROW_OUTCOME_NOT_LAUNCHED,
  LIVE_ROW_READ_ABSENT,
  LIVE_ROW_READ_LATCHED,
  LIVE_ROW_READ_REFUSED,
  LIVE_ROW_READ_ROW,
  LIVE_ROW_RUN_FAILED,
  LIVE_ROW_RUN_JUDGED_ALIVE,
  LIVE_ROW_RUN_LATCHED,
  LIVE_ROW_RUN_LEFT_LIVE,
  LIVE_ROW_RUN_MARKED_MISSING,
  LIVE_ROW_RUN_NOT_JUDGED,
  LIVE_ROW_RUN_REFUSED,
  LIVE_ROW_SEQUENCE_ENTRY_GET,
  LIVE_ROW_SEQUENCE_ENTRY_KILL,
  LIVE_ROW_SEQUENCE_LOG_PREFIX,
  LIVE_ROW_START_ALREADY_RUNNING,
  LIVE_ROW_START_STARTED,
  LIVE_ROW_SEQUENCE_NO_ROW,
  LIVE_ROW_SEQUENCE_SITE,
  LIVE_ROW_STOP_HOLD_ENDED,
  LIVE_ROW_STOP_LATCHED,
  LIVE_ROW_STOP_SHUTDOWN,
  LIVE_ROW_STOP_TEARDOWN,
  liveRowStopCauseText,
  type LiveRowSequenceArmCause,
  type LiveRowSequenceDeps,
  type LiveRowSequenceLastRead,
  type LiveRowSequenceLaunchKind,
  type LiveRowSequenceNotLaunchedReason,
  type LiveRowSequenceOutcome,
  type LiveRowSequenceRead,
  type LiveRowSequenceRegistry,
  type LiveRowSequenceRequest,
  type LiveRowSequenceRunPlacement,
  type LiveRowSequenceStartAnswer,
  type LiveRowSequenceStopReason,
  type LiveRowSequenceStopSignal,
  type RetiredKeyAttemptStart,
} from './live-row-sequence.ts'
import {
  OLD_LIFE_WAIT_AT_FIND_MISSING,
  OLD_LIFE_WAIT_AT_GET,
  OLD_LIFE_WAIT_AT_KILL,
  OLD_LIFE_WAIT_AT_STATUS_READ,
  OLD_LIFE_WAIT_LOG_PREFIX,
  OLD_LIFE_WAIT_ROUTED_CONTEXT,
  OLD_LIFE_WAIT_SEED_LIVE_UNREAD,
  OLD_LIFE_WAIT_SITE,
  decideOldLifeWaitEnd,
  oldLifeWaitEndLine,
  oldLifeWaitRef,
  oldLifeWaitRefusalNoticeText,
  type OLD_LIFE_WAIT_ARM_CAUSE,
  type OldLifeWaitRefusal,
  type OldLifeWaitRefusalAt,
} from './old-life-wait.ts'
import { recordStartupError } from './startup-errors.ts'
// Type only: the held-directory answer session admission takes; nothing of
// the registry is loaded here.
import type { SessionHeldDirectory } from './registry.ts'
import {
  locateTranscript,
  readTranscriptTurnState,
  sameTranscriptSnapshot,
  type TranscriptReading,
  type TranscriptSnapshot,
} from './session-transcript.ts'
import type { ReplyGuardUndo } from './stop-hook-bootstrap.ts'
import {
  PERSONA_TEARDOWN_NOTICE_DURING_WAIT,
  PERSONA_TEARDOWN_NOTICE_LABEL,
  firstNoticeLine,
  notifySafely,
  personaTeardownNoticeEntryText,
  type PersonaNoticeOptions,
  type PersonaNotify,
} from './persona-notifier.ts'
import type { PersonaBringUpFailure } from './persona-start.ts'
import type { PersonaBringUpController, PersonaBringUpOutcome } from './persona-bringup-controller.ts'
import {
  describeLogMessage,
  describeThrownValue,
  isSafeIdentifier,
  MAX_LOGGED_MESSAGE_LENGTH,
  renderLogMessageText,
} from './persona-connection-errors.ts'
import { describeDestinationFailureCause } from './persona-destination.ts'
import { redactSlackLogText } from './slack-log-redaction.ts'
import { RESTART_FAILURE_CAP, recordLaunchResultOutsideRestartWork } from './restart.ts'
import {
  AGENT_DIRECTOR_DEAD_STATES,
  AGENT_DIRECTOR_LIVE_STATES,
  AGENT_DIRECTOR_PENDING_STATE,
  LIVENESS_DEAD_ROW_NO_ROW,
  deadRowReadOf,
  pendingLaunchStartOf,
  type LivenessReading,
} from './liveness-reading.ts'
import {
  PENDING_ROW_COVERED,
  PENDING_ROW_GET_ABSENT,
  PENDING_ROW_GET_LATCHED,
  PENDING_ROW_GET_REFUSED,
  PENDING_ROW_GET_ROW,
  PENDING_ROW_LAP_ENTER_CONFLICT,
  PENDING_ROW_LAP_ENTER_LATCHED,
  PENDING_ROW_LAP_ENTER_NOT_SENT_LATCHED,
  PENDING_ROW_LAP_ENTER_SENT,
  PENDING_ROW_LAP_ENTER_UNCLASSIFIED,
  PENDING_ROW_LAP_ENTER_UNUSABLE_NAME,
  PENDING_ROW_RELAUNCH_KEPT,
  PENDING_ROW_RELAUNCH_LATCHED,
  PENDING_ROW_RELAUNCH_SEQUENCE_STARTED,
  PENDING_ROW_RULE_GONE,
  PENDING_ROW_RULE_HELD,
  PENDING_ROW_RULE_LATCHED,
  PENDING_ROW_RULE_LIVE,
  PENDING_ROW_RULE_ORIGIN_APPROVER_STOP,
  PENDING_ROW_RULE_ORIGIN_RETRY,
  PENDING_ROW_RULE_READ_REFUSED,
  PENDING_ROW_RULE_REFUSAL,
  PENDING_ROW_RULE_RELAUNCH,
  PENDING_ROW_RUN_FAILED,
  PENDING_ROW_RUN_JUDGED_ALIVE,
  PENDING_ROW_RUN_LATCHED,
  PENDING_ROW_RUN_LEFT_LIVE,
  PENDING_ROW_RUN_MARKED_MISSING,
  PENDING_ROW_RUN_NOT_JUDGED,
  PENDING_ROW_RUN_REFUSED,
  STUCK_LAUNCH_ABORT_KILL_FAILED,
  STUCK_LAUNCH_ABORT_KILL_LATCHED,
  STUCK_LAUNCH_ABORT_KILL_STOPPED,
  STUCK_LAUNCH_ABORT_KILL_SUCCEEDED,
  STUCK_LAUNCH_ABORT_KILL_TRY_LATER,
  STUCK_LAUNCH_ABORT_SEQUENCE_NOT_STARTED,
  STUCK_LAUNCH_ABORT_SEQUENCE_STARTED,
  STUCK_LAUNCH_POST_FAILED,
  createStuckLaunchAbort,
  describePendingRowRuleAnswer,
  pendingRowLapEnterFailureOf,
  pendingRowRuleFailedLine,
  postStuckLaunchHeld,
  postStuckLaunchRelaunching,
  type StuckLaunchAbortEpisodes,
  type StuckLaunchAbortKillAnswer,
  type StuckLaunchAbortSequenceStart,
  type PendingRowLapEnterFailure,
  type PendingRowLapEnterLatching,
  type PendingRowLapEnterOutcome,
  type PendingRowLapEnterUnclassified,
  type PendingRowRule,
  type PendingRowRuleAnswer,
  type PendingRowRuleDeps,
  type PendingRowRuleGet,
  type PendingRowRuleRow,
  type PendingRowRunPlacement,
  type StuckLaunchPostEpisodes,
  PENDING_ROW_NO_LAUNCH_START,
  PENDING_ROW_NOT_COVERED,
  PENDING_ROW_REASON_CONFIG_DIR_MISMATCH,
  PENDING_ROW_REASON_CONFIG_DIR_UNRESOLVED,
  PENDING_ROW_REASON_CWD_MISMATCH,
  PENDING_ROW_REASON_CWD_UNRESOLVED,
  PENDING_ROW_REASON_RETIRED_OLD_LIFE,
  PENDING_ROW_UNDECIDED,
  PENDING_ROW_WAIT_NOT_ARMED,
  armPendingRowWait,
  decidePendingRowCover,
  describeLaunchStartForLog,
  endStuckLaunchEpisode,
  isLaunchStartInWindow,
  isPendingRowAged,
  isStuckLaunchEpisodeEndState,
  launchStartInstantOf,
  parseLaunchStart,
  stuckLaunchEndRowLiveReason,
  type LaunchCallWindow,
  type PendingRowCover,
  type PendingRowFields,
  type PendingRowNotCoveredReason,
  type PendingRowUndecidedReason,
} from './pending-row.ts'
import type { PersonaSerialize } from './persona-serializer.ts'
import { isDryRun } from './tokens.ts'
import {
  DIALOG_READY_TIMEOUT_MS,
  adGraceMsInEffect,
  adLaunchBoundMsInEffect,
  armNeverEarlyWait,
  type NeverEarlyWaitClock,
  type NeverEarlyWaitLength,
} from './ad-settings.ts'
// Import cycle with jsonl-persistence-check.ts: use these imports only inside functions, never at module top level.
import {
  UNATTRIBUTABLE_ZERO_REASON,
  makeDefaultArchiveCount,
  personaArchiveEvidenceScope,
  rfc3339ToEpochSeconds,
} from './jsonl-persistence-check.ts'
import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve as resolvePath } from 'node:path'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Live states per SR-11 (agent-director Spawn state machine), kept in
 * `src/liveness-reading.ts` beside the liveness readings (b.jg5 SRJ-314) and
 * re-exported here.
 */
export { AGENT_DIRECTOR_LIVE_STATES }

/** B's floor (`src/ad-settings.ts`, b.jg5 SRJ-210), re-exported for the approver's readers. */
export { DIALOG_READY_TIMEOUT_MS }

/** The CSCB-shipped template name (mirrors agent-director-client). */
const TEMPLATE_NAME = 'slack-channel-bot'

/**
 * Persona reference for log lines and startup-error messages (b.av2 SR-2.2):
 * the name JSON-quoted with the key beside it.
 */
function personaRef(persona: Pick<Persona, 'name' | 'key'>): string {
  return renderPersonaRef(persona.name, persona.key)
}

/** Log reference for a persona when only its key is in scope. */
function keyRef(key: string): string {
  return `persona=${key}`
}

/**
 * Thrown by `personaConfigDirLabelValue` for a claude_config_dir that cannot
 * be resolved to a real path (bug b.g57): there is no lexical fallback, so
 * such a directory has no `config_dir` label. Carries the configured
 * directory (tilde-expanded, absolute) and the errno code; never a token.
 */
export class ConfigDirUnresolvableError extends Error {
  constructor(
    readonly path: string,
    readonly code: string,
  ) {
    super(`claude_config_dir ${JSON.stringify(path)} cannot be resolved to a real path (${code})`)
    this.name = 'ConfigDirUnresolvableError'
  }
}

/**
 * A persona's `config_dir` label value, or why there is none: the configured
 * directory and the errno code when it cannot be resolved to a real path.
 */
function strictConfigDirLabel(
  configDir: string | undefined,
  home: string,
  fs: Partial<StrictRealPathFs> | undefined,
): { label: string } | { path: string; code: string } {
  const path = resolveClaudeConfigDir(configDir, home)
  const resolution = resolveRealPathStrict(path, fs)
  return resolution.resolved ? { label: configDirLabelValue(resolution.path, home) } : { path, code: resolution.code }
}

/**
 * Value of a persona's `config_dir` label: the 12-hex hash of the REAL path
 * of its effective claude_config_dir (b.av2 SR-1.5, SR-2.2). An absent
 * directory means `<home>/.claude`. The directory is tilde-expanded and
 * resolved against `home`, then real-pathed with `resolveRealPathStrict`, so
 * a symlink and its target give the same label, and a directory not created
 * yet gives the label of the real path it will have (its nearest existing
 * ancestor's real path plus the rest). There is no lexical fallback (bug
 * b.g57): a directory that cannot be resolved (a symlink on its path pointing
 * to nothing, an unmounted drive, a dropped mount) throws
 * `ConfigDirUnresolvableError`. E1's `configDirLabelValue` alone hashes
 * lexically; this is the one derivation spawns and later label comparisons
 * use (the launch checks the directory first, `checkLaunchConfigDir`, and
 * `compareRowToPersona` reports it as unresolved rather than throwing).
 *
 * @param configDir  The persona's effective claude_config_dir, as configured.
 * @param home       Home directory; defaults to the OS home, read at call time.
 * @param fs         Realpath and lstat overrides; default the real file system.
 */
export function personaConfigDirLabelValue(
  configDir?: string,
  home: string = homedir(),
  fs?: Partial<StrictRealPathFs>,
): string {
  const result = strictConfigDirLabel(configDir, home, fs)
  if ('label' in result) return result.label
  throw new ConfigDirUnresolvableError(result.path, result.code)
}

/** Label-map key of the `config_dir=<hash>` label (`config_dir`). */
const CONFIG_DIR_LABEL_KEY = CONFIG_DIR_LABEL_PREFIX.slice(0, -1)

/** How an agent-director row compares with a persona (b.av2 SR-6.2, SR-6.3). */
export interface RowPersonaComparison {
  /** The row's `cwd` and the persona's working_directory have the same real path. */
  cwdMatches: boolean
  /**
   * The persona's working_directory resolved to a real path. When it did not
   * (missing, not searchable, a dangling symlink), `cwdMatches` is only the
   * lexical comparison.
   */
  workingDirectoryResolved: boolean
  /**
   * The `cwd` condition cannot be evaluated now (b.av2 SR-6.4): the persona's
   * working_directory has no real path AND the row's `cwd` has none either
   * (absent, missing, a dangling symlink's old target) or equals the
   * configured working_directory lexically. The start sweep and the collision
   * ladder never act on such a row on `cwd` grounds. A row whose `cwd`
   * resolves to an existing directory elsewhere is not deferred: it is a
   * `cwd` mismatch even while the working directory is missing, so a persona
   * never adopts a directory another persona may now own.
   */
  cwdCheckDeferred: boolean
  /**
   * The persona's effective claude_config_dir resolved to a real path (or to
   * the one it will have once created; `resolveRealPathStrict`). When it did
   * not (bug b.g57), there is no `config_dir` verdict: `configDirMatches` and
   * `expectedConfigDirLabel` are undefined, and a caller keeps the row rather
   * than treat it as a mismatch.
   */
  configDirResolved: boolean
  /**
   * The row carries a `config_dir` label equal to `expectedConfigDirLabel`;
   * undefined (no verdict) when the directory is unresolvable. Check
   * `configDirResolved` before acting on it.
   */
  configDirMatches: boolean | undefined
  /** The row's `config_dir` label value; undefined when the label is absent. */
  configDirLabel: string | undefined
  /**
   * The `config_dir` label a spawn of the persona carries now
   * (`personaConfigDirLabelValue`); undefined when the directory is
   * unresolvable, since no label is ever derived from its lexical path.
   */
  expectedConfigDirLabel: string | undefined
}

/**
 * Compare an agent-director row with a persona (b.av2 SR-6.2, SR-6.3). The
 * one place a row's `cwd` is compared with a persona's working directory and
 * a row's `config_dir` label with the persona's current effective
 * claude_config_dir; the collision ladder's `cwd` guard, its pre-resume
 * `config_dir` guard and the start sweep's `cwd` condition all use it.
 * Side-effect free.
 *
 * - `cwdMatches`: `resolveRealPath` on both sides (a symlink to the working
 *   directory matches). A row with no `cwd` never matches.
 * - `workingDirectoryResolved`: the persona's working directory has a real
 *   path (`tryResolveRealPath`).
 * - `cwdCheckDeferred`: the working directory has no real path and the row's
 *   `cwd` has none either or equals the configured path lexically. Callers
 *   skip the `cwd` condition for such a row rather than act on the lexical
 *   comparison (b.av2 SR-6.4); a row whose `cwd` resolves to an existing
 *   directory is compared as usual and so mismatches.
 * - `configDirResolved`: the persona's effective claude_config_dir has a real
 *   path (`resolveRealPathStrict`, no lexical fallback; bug b.g57).
 * - `configDirMatches`: the row's `config_dir` label is present and equals
 *   `personaConfigDirLabelValue(persona.claude_config_dir, home, configDirFs)`,
 *   the value the spawn writes; undefined when the directory is unresolvable.
 *
 * @param row          The row's `cwd` and `labels` (from `get` or `list`).
 * @param persona      The resolved persona.
 * @param home         Home directory for an unset claude_config_dir; defaults
 *   to the OS home, read at call time.
 * @param realpath     Realpath function; defaults to `fs.realpathSync`.
 * @param configDirFs  Realpath and lstat for the claude_config_dir; default
 *   `realpath` and the real `lstat`.
 */
export function compareRowToPersona(
  row: { cwd?: string; labels?: Record<string, string> },
  persona: Pick<Persona, 'working_directory' | 'claude_config_dir'>,
  home: string = homedir(),
  realpath: (path: string) => string = realpathSync,
  configDirFs: Partial<StrictRealPathFs> = { realpath },
): RowPersonaComparison {
  const workingDirectory = tryResolveRealPath(persona.working_directory, realpath)
  const configuredLexical = resolvePath(persona.working_directory)
  const rowCwdReal = row.cwd ? tryResolveRealPath(row.cwd, realpath) : undefined
  const cwdMatches = !!row.cwd && (rowCwdReal ?? resolvePath(row.cwd)) === (workingDirectory ?? configuredLexical)
  const cwdCheckDeferred =
    workingDirectory === undefined &&
    (rowCwdReal === undefined || resolvePath(row.cwd!) === configuredLexical)
  const configDirLabel = row.labels?.[CONFIG_DIR_LABEL_KEY]
  const expected = strictConfigDirLabel(persona.claude_config_dir, home, configDirFs)
  const expectedConfigDirLabel = 'label' in expected ? expected.label : undefined
  return {
    cwdMatches,
    workingDirectoryResolved: workingDirectory !== undefined,
    cwdCheckDeferred,
    configDirResolved: expectedConfigDirLabel !== undefined,
    configDirMatches:
      expectedConfigDirLabel === undefined ? undefined : configDirLabel !== undefined && configDirLabel === expectedConfigDirLabel,
    configDirLabel,
    expectedConfigDirLabel,
  }
}

// ---------------------------------------------------------------------------
// Persona notices — spawn failure, restart cap, transcript loss (b.av2 SR-7.2)
// ---------------------------------------------------------------------------

/**
 * The one sink every session-manager notice goes through. Production installs
 * the per-persona notifier's `notify` (`src/persona-notifier.ts`), which
 * posts to the persona's destination under its identity, adds the persona
 * reference, holds a notice until the persona's client is validated, and
 * logs instead of posting in dry run.
 */
let noticeSink: PersonaNotify | undefined

/**
 * Install the notice sink, or clear it by passing undefined. With no sink
 * installed (unit tests, the integration driver) a notice is logged, never
 * posted, and never throws.
 */
export function setSessionNotifier(notify: PersonaNotify | undefined): void {
  noticeSink = notify
}

/** Send one notice body for persona `key` through the installed sink. Never throws. */
function sendPersonaNotice(key: string, text: string, options?: PersonaNoticeOptions): void {
  if (!noticeSink) {
    console.error(`[slack] session-manager: no notifier installed — notice for ${keyRef(key)} not posted: ${firstNoticeLine(text)}`)
    return
  }
  notifySafely(noticeSink, key, text, options, (err) => {
    console.error(`[slack] session-manager: notifier failed for ${keyRef(key)}: ${describeThrownValue(err)}`)
  })
}

/**
 * The error label of a spawn-failure notice: the typed error's `errName` when
 * it is a short identifier, else `describeThrownValue` of the error without
 * its `message="…"` field (which holds the description, prefixed by the
 * unchecked `errName`). The notice shows the description itself, once,
 * after the label.
 */
function spawnFailureLabel(error: AgentDirectorError): string {
  if (isSafeIdentifier(error.errName)) return error.errName
  const described = describeThrownValue(error)
  const message = describeLogMessage(error.message)
  return message === '' ? described : described.replace(` ${message}`, '')
}

/**
 * Raise a spawn-failure notice for persona `key`: the error name, the
 * description (through `redactSlackLogText`, cut to
 * `MAX_LOGGED_MESSAGE_LENGTH` characters) and a remediation hint. When a
 * startup notice's post fails, the `spawn-failure-post` startup error is
 * recorded; outside startup the failure is logged.
 *
 * Its callers: a launch's `ErrTmuxSessionCreate` (a plain spawn's
 * `plainSpawnFailedAt`, a reuse spawn's `reuseSpawnFailedAt`, a `resume`'s
 * `resumeFailedAt`), a `resume`'s error with no row of its own
 * (`resumeFailedAt`), and the restart cap (`notifyRestartCapReached`). A
 * collision (`ErrInstanceIdCollision`) never reaches it (b.jg5 SRJ-713): a
 * plain spawn's goes to get-then-act (`plainSpawnOutcomeAt`), a reuse
 * spawn's to its collided answer (`reuseSpawnFailedAt`), and a `resume`'s
 * to the collision cause's retry (`resumeCollisionAt`).
 */
export function notifySpawnFailure(key: string, error: AgentDirectorError, isStartup = true): void {
  const ref = keyRef(key)
  const text =
    `Spawn failure:\n` +
    `  Error: \`${spawnFailureLabel(error)}\` — ${redactSlackLogText(error.errDescription ?? '').slice(0, MAX_LOGGED_MESSAGE_LENGTH)}\n` +
    `  Remediation: ${remediationHint(error)}`
  sendPersonaNotice(key, text, {
    onPostFailure: (failure) => {
      // Token-safe cause: a Slack rejection can carry secrets, so only the
      // describer's output (type, code, redacted message, frames) reaches
      // stderr and the log file.
      // A failed DM open names the step and its code.
      const cause = describeDestinationFailureCause(failure)
      if (isStartup) {
        recordStartupError('spawn-failure-post', `failed to post spawn failure for ${ref}`, cause)
      } else {
        console.error(`[slack] spawn-failure-post: failed to post spawn failure for ${ref}: ${cause}`)
      }
    },
  })
}

/**
 * Raise the restart-cap notice for persona `key` (restart.ts `onCapReached`):
 * a non-startup spawn-failure notice carrying `ErrSpawnCapReached`, whose
 * remediation says automatic restarts are suspended for this persona.
 */
export function notifyRestartCapReached(key: string): void {
  const err = new ErrSpawnCapReached(
    `${RESTART_FAILURE_CAP} consecutive session-launch failures — automatic restarts suspended`,
  )
  notifySpawnFailure(key, err, false)
}

/** The result a launch or recovery site answers for a refusal: `failed`, which the launch answers as `retrying` when the timer was armed (`retryingWhenArmed`). */
type RefusedSiteResult = { key: string; action: 'failed' }

/** A site's latched result (b.jg5 SRJ-502): the persona latched, and nothing more is called for it. */
type LatchedSiteResult = { key: string; action: 'latched' }

/**
 * b.jg5 SRJ-105, SRJ-311, SRJ-313, SRJ-316: the one handling of a refusal at
 * the launch and recovery sites. `err` was thrown by an agent-director call
 * made with `verb` for persona `key`. It is a refusal when the arming
 * predicate (`unavailableRetryCauseFor`, which classifies by name through
 * `src/ad-error-class.ts`) answers a cause for it: UNAVAILABLE from any verb
 * (`ErrTmuxKillFailed` included), ENVIRONMENT (`ErrTmuxNotAvailable`) from
 * any verb (`kill` included: nothing is killed, deleted or respawned because
 * of it), CONFIG (`ErrConfigMalformed`) from any verb (SRJ-105's CONFIG row:
 * no action, nothing counted, never 'dead'; the wrapper has already raised
 * the `ad-config-malformed` outage), UNCLASSIFIED from any verb (SRJ-105's
 * UNCLASSIFIED row and SRJ-110, SRJ-111, SRJ-113: "No step follows"; an
 * `ErrInternal` other than an unusable recorded name, a store-open name,
 * `ErrSystemInstallDisappeared`, whose wrapper has raised `ad-unreachable`,
 * or any name CSCB gives no handling; the reporting point has reported it to
 * the persona's unclassified-error episode), and from a `status`, `get` or
 * `list` any error but `ErrSpawnNotFound` and an UNUSABLE NAME answer.
 * The same rule arms the retry timer, so the site's decision and the arming
 * decision cannot drift apart.
 *
 * For a refusal it logs one line (`site` is the log prefix, `what` names the
 * call) and answers `{ key, action: 'failed' }`: no spawn-failure notice, no
 * `spawn-failed` startup-errors entry, and the caller calls nothing more.
 * The launch turns it into `retrying` (`retryingWhenArmed`) only when the
 * attempt's last error armed a timer. Answers `undefined` for any other
 * value, which the site handles as before. Never throws.
 */
function refusalAt(
  key: string,
  err: unknown,
  verb: AdVerb,
  site: string,
  what: string,
  ref: string,
): RefusedSiteResult | undefined {
  if (unavailableRetryCauseFor(err, verb) === undefined) return undefined
  logRefusal(site, what, ref, describeAgentDirectorFailure(err))
  return { key, action: 'failed' }
}

/** The one refusal line (b.jg5 SRJ-105): `described` is a redacting describer's output, never the error. */
function logRefusal(site: string, what: string, ref: string, described: string): void {
  console.error(
    `[slack] ${site}: ${what} refused for ${ref}: ${described} — no spawn-failure notice; nothing more is called (b.jg5 SRJ-105)`,
  )
}

// ---------------------------------------------------------------------------
// The latch (b.jg5 SRJ-501, SRJ-502)
// ---------------------------------------------------------------------------

/**
 * What the session manager uses of the server's one latch
 * (`src/conflict-latch.ts`): `set` for a latching own-row read
 * (`readPersonaOwnRow`, `applyOwnRowStatusStep`; a launch start not recorded
 * with `launchStartNotRecordedSetInput`'s input) and for an UNUSABLE NAME
 * answer (with `unusableNameSetInput`'s input, `latchOnUnusableName`),
 * `setFromConflict` for a CONFLICT answer; and, when the latch has it,
 * `addSetObserver`, through which the installer stops a latched persona's
 * running dialog approver (`setConflictLatch`, b.jg5 SRJ-502).
 */
export type SessionConflictLatch = Pick<ConflictLatch, 'isLatched' | 'record' | 'set' | 'setFromConflict'> &
  Partial<Pick<ConflictLatch, 'addSetObserver'>>

/**
 * The installed latch. Production installs the server's one latch
 * (`createConflictLatch`, built in `main()`) before the start pass. With none
 * installed (unit tests, the integration driver) no persona is latched, so no
 * launch is held back, and a CONFLICT at a ladder spawn or resume still takes
 * the CONFLICT row's no-action path and answers `latched` (`conflictAt`), as
 * does a CONFLICT at the shared read-pane (`readPersonaOwnPane`), an
 * UNUSABLE NAME answer at any site that latches on it
 * (`unusableNameAt`, `readPersonaOwnRow`, `applyOwnRowStatusStep`,
 * `readPersonaOwnPane`), and a latch decision of the row-read rule at an
 * own-row read (`readPersonaOwnRow`, `applyOwnRowStatusStep`: a `pending`
 * row with no launch start, or a latching note) when a configured-persona
 * query counts the key.
 */
let conflictLatch: SessionConflictLatch | undefined

/** Removes the approver-stop set observer from the installed latch; undefined while none is registered. */
let removeApproverLatchObserver: (() => void) | undefined

/**
 * Install the server's latch (production: `main()`; the recovery harness
 * installs its own the same way), or remove it with undefined. The installer
 * registers one set observer on a latch that has `addSetObserver`
 * (`stopApproverOnLatch`, b.jg5 SRJ-502): every set of a persona, a relatch
 * and a same-case set included, stops that persona's running dialog approver
 * with the reason `latched`. The observer registered on a latch installed
 * before is removed first, so exactly one is registered, on the installed
 * latch only. When a live-row sequence registry is installed too
 * (`setLiveRowSequenceRegistry`), a second set observer stops the persona's
 * running live-row sequence with the latch reason (`stopSequenceOnLatch`,
 * SRJ-502, SRJ-706), registered once on the installed latch, whichever of
 * the two is installed second.
 */
export function setConflictLatch(latch: SessionConflictLatch | undefined): void {
  removeApproverLatchObserver?.()
  removeApproverLatchObserver = undefined
  conflictLatch = latch
  if (latch?.addSetObserver !== undefined) removeApproverLatchObserver = latch.addSetObserver(stopApproverOnLatch)
  syncSequenceLatchObserver()
}

/**
 * The latch's set observer the installer registers (`setConflictLatch`,
 * b.jg5 SRJ-502): stops persona `event.key`'s running dialog approver with
 * the reason `latched` through the stop entry (`stopDialogApprover`). The
 * approver is marked stopped synchronously, inside this call, so no approver
 * call for the persona starts after the latch's `set` returns, whatever order
 * the observers run in; a call already in progress returns first, and the
 * approver makes none after it. Does nothing when no approver runs for the
 * persona, and nothing more when its approver was already stopping (its own
 * CONFLICT or UNUSABLE NAME answer marks it before it latches). Returns
 * nothing to await; never throws.
 */
function stopApproverOnLatch(event: ConflictLatchSetEvent): void {
  void stopDialogApprover(event.key, APPROVER_STOP_LATCHED)
}

/** The case the latched gate logs when it cannot read the persona's latch record. */
const LATCH_CASE_UNKNOWN = 'unknown'

/**
 * What the latched gate (`spawnForPersona`, b.jg5 SRJ-502) read of persona
 * `key`'s latch: `undefined` when no latch is installed or the latch answers
 * not latched; otherwise the case to log (the record's, or
 * `LATCH_CASE_UNKNOWN` when the record cannot be read) and, when a latch
 * query threw, `describeThrownValue` of what it threw.
 */
interface LatchGateReading {
  readonly latchCase: string
  readonly failure?: string
}

/**
 * Read persona `key`'s latch for the latched gate (`LatchGateReading`). Fails
 * safe: an `isLatched` that throws counts as latched (case unknown), and so
 * does a latched persona whose `record` throws or answers nothing. Logs
 * nothing (the gate logs one line); never throws.
 */
function latchGateReadingOf(key: string): LatchGateReading | undefined {
  const latch = conflictLatch
  if (latch === undefined) return undefined
  let latched: boolean
  try {
    latched = latch.isLatched(key) === true
  } catch (err) {
    return { latchCase: LATCH_CASE_UNKNOWN, failure: `the latched query failed: ${describeThrownValue(err)}` }
  }
  if (!latched) return undefined
  try {
    const record: ConflictLatchRecord | undefined = latch.record(key)
    return { latchCase: record?.latchCase ?? LATCH_CASE_UNKNOWN }
  } catch (err) {
    return { latchCase: LATCH_CASE_UNKNOWN, failure: `its latch record could not be read: ${describeThrownValue(err)}` }
  }
}

// ---------------------------------------------------------------------------
// The ErrInvalidFlags hold (b.jg5 SRJ-207)
// ---------------------------------------------------------------------------

/**
 * What the session manager uses of the server's one `ErrInvalidFlags` hold
 * (`src/invalid-flags-hold.ts`): `set` at a reuse spawn's `ErrInvalidFlags`
 * whose immediate re-check did not stop the server (`reuseSpawnFailedAt`),
 * and `isHeld` at every launch entry (`spawnForPersona`, the sequence start
 * entry and the sequence-launch entry).
 */
export type SessionInvalidFlagsHold = Pick<InvalidFlagsHold, 'set' | 'isHeld'>

/**
 * The installed hold. Production installs the server's one hold
 * (`createInvalidFlagsHold`, built in `main()`) before the start pass. With
 * none installed (unit tests, the integration driver) no persona is held, so
 * no launch is held back, and a reuse spawn's `ErrInvalidFlags` whose
 * re-check did not stop the server still answers `held` with one line saying
 * that no hold is installed.
 */
let invalidFlagsHold: SessionInvalidFlagsHold | undefined

/**
 * Install the server's `ErrInvalidFlags` hold (production: `main()`; the
 * recovery harness installs its own the same way), or remove it with
 * undefined (b.jg5 SRJ-207).
 */
export function setInvalidFlagsHold(hold: SessionInvalidFlagsHold | undefined): void {
  invalidFlagsHold = hold
}

/** Test-only seam: remove the installed hold. */
export function _resetInvalidFlagsHold(): void {
  invalidFlagsHold = undefined
}

/**
 * What a launch entry's held gate read of persona `key` (b.jg5 SRJ-207):
 * `undefined` when no hold is installed or `isHeld` answers anything but
 * exactly `true`; otherwise held, with `failure`, `describeThrownValue` of
 * what `isHeld` threw, when it threw (fail safe: a query that throws counts
 * as held). Logs nothing; never throws.
 */
function heldGateReadingOf(key: string): { readonly failure?: string } | undefined {
  const hold = invalidFlagsHold
  if (hold === undefined) return undefined
  try {
    return hold.isHeld(key) === true ? {} : undefined
  } catch (err) {
    return { failure: describeThrownValue(err) }
  }
}

/**
 * The held gate of the launch entries (b.jg5 SRJ-207): when persona `key` is
 * held on `ErrInvalidFlags` (a held query that throws counts as held) and is
 * not latched (the latched gate answers for a latched one), log one line
 * (`invalidFlagsHeldNoLaunchLine`) and answer the `held` result: no
 * agent-director call, no trust patch, no reply-guard step, no record
 * written, nothing armed and nothing counted. Otherwise undefined.
 */
function heldResult(key: string, ref: string, site: string): SpawnPersonaResult | undefined {
  const held = heldGateReadingOf(key)
  if (held === undefined || latchGateReadingOf(key) !== undefined) return undefined
  const line = invalidFlagsHeldNoLaunchLine(site, ref)
  console.error(held.failure === undefined ? line : `${line} (the held query failed: ${held.failure} — taken as held)`)
  return { key, action: 'held' }
}

/**
 * The row state a launch site last read before its refused call (b.jg5
 * SRJ-501): the state read, or no row (the read answered `ErrSpawnNotFound`).
 * `NOTHING_READ` when the path read nothing before it (the first spawn):
 * the CONFLICT row then makes the one latch-time
 * `status` read (`latchTimeRowState`). A state is never re-read after a
 * write the path made since (a delete, a kill, a sweep): only the last read
 * counts.
 */
type LastRowRead = LatchRowState | typeof NOTHING_READ

/** The path read nothing of the row before its refused call (`LastRowRead`). */
const NOTHING_READ = undefined

/**
 * What the latch-time `status` read gave (`latchTimeRowState`): the row
 * state to record, or `latched` when the persona is latched once the read is
 * done (the read itself latched it, or it latched elsewhere meanwhile), with
 * the latch line's outcome text saying which.
 */
type LatchTimeRead = { readonly rowState: LatchRowState } | { readonly latched: true; readonly outcome: string }

/**
 * The latch-time `status` read (b.jg5 SRJ-501), for a CONFLICT or an
 * UNUSABLE NAME at a site whose path read nothing before the refused call:
 * one read of persona `key`'s row through the shared own-row `status` read
 * (`readPersonaOwnRowStatus`), inside the launch attempt (so its UNAVAILABLE
 * or read error arms the persona's retry timer and its UNCLASSIFIED answer
 * opens the unclassified-error episode, which the latch's holds then stop
 * and end). The state read; no row for `ErrSpawnNotFound`; unreadable for
 * any other error, which counts as live. A read that itself latched the
 * persona (its own UNUSABLE NAME answer, recorded unreadable, or its own
 * row-read rule: the persona's own row reading `pending` with no launch
 * start, b.jg5 SRJ-513) answers `latched`: that latch stands alone, the
 * caller sets nothing more (no CONFLICT or UNUSABLE NAME case on top, so
 * the persona gets that latch's one post, SRJ-1020's for a launch start not
 * recorded), and no further read is made. A persona latched elsewhere while
 * the read was awaited (`personaLatchedNow`, b.jg5 SRJ-502: the health
 * tick reads even while a launch is in flight, SRJ-315) answers `latched`
 * the same way, whatever the read gave: that latch stands, and no second
 * case or post is set on top of it. `site` names the path that met the
 * refusal in the read's own lines. Logs nothing of its own; never throws.
 */
async function latchTimeRowState(key: string, site: string): Promise<LatchTimeRead> {
  const read = await readPersonaOwnRowStatus(key, { site, what: 'latch-time status read' })
  if (read.kind === OWN_ROW_STATUS_LATCHED) return { latched: true, outcome: LATCH_TIME_READ_LATCHED }
  if (personaLatchedNow(key)) return { latched: true, outcome: LATCH_TIME_READ_LATCHED_ELSEWHERE }
  switch (read.kind) {
    case OWN_ROW_STATUS_STATE:
      return { rowState: latchRowStateRead(read.state) }
    case OWN_ROW_STATUS_ABSENT:
      return { rowState: LATCH_ROW_STATE_NO_ROW }
    case OWN_ROW_STATUS_REFUSED:
      return { rowState: LATCH_ROW_STATE_UNREADABLE }
  }
}

/**
 * The row state to record for a latch met by a call whose path last read
 * `lastRead`: `lastRead` itself, or, when the path read nothing
 * (`NOTHING_READ`), the one latch-time `status` read (`latchTimeRowState`),
 * its lines prefixed `site`.
 */
async function recordedRowState(key: string, lastRead: LastRowRead, site: string): Promise<LatchTimeRead> {
  return lastRead === NOTHING_READ ? latchTimeRowState(key, site) : { rowState: lastRead }
}

/** The latch line's outcome when the latch-time `status` read latched the persona itself. */
const LATCH_TIME_READ_LATCHED = 'the latch-time status read latched the persona, so that latch stands'

/** The latch line's outcome when the persona latched elsewhere while the latch-time `status` read was awaited. */
const LATCH_TIME_READ_LATCHED_ELSEWHERE =
  'the persona was latched elsewhere during the latch-time status read, so that latch stands'

/**
 * b.jg5 SRJ-105, SRJ-501, SRJ-111, SRJ-113: the CONFLICT row of the ladder's
 * refusal handling, at every spawn and `resume` the collision ladder makes
 * and at the reuse spawn (SRJ-112). `err` was thrown by that call for persona `key`. It is the row's only when
 * the classifier (`classifyAdError`, by name) answers CONFLICT
 * (`ErrTmuxSessionConflict`); for any other value it answers `undefined`
 * and the site goes on as before.
 *
 * For a CONFLICT it latches the persona through the installed latch's
 * `setFromConflict` with
 * `operation` (a plain spawn, a `resume` or the reuse spawn) and the row
 * state: `lastRead`,
 * the state the path last read before the refused call, or, when it read
 * nothing (`NOTHING_READ`), exactly one latch-time `status` read
 * (`latchTimeRowState`; when that read latched the persona itself, its latch
 * stands and nothing more is set). The latch's set observers then run, holds
 * before the notice (`main()`). Then it logs one line (`what` names the
 * call) saying the persona latched, or, when `setFromConflict` threw, that
 * latching it failed and what it threw. It answers `latched`: no
 * spawn-failure notice, no `spawn-failed` entry, nothing counted, and the
 * caller kills, deletes and launches nothing more. With no latch installed
 * it makes no read, sets nothing, logs the one line saying so, and still
 * answers `latched`. `site` is the line's prefix (default `spawnForPersona`).
 * Never throws.
 */
async function conflictAt(
  key: string,
  err: unknown,
  operation: RefusedOperation,
  lastRead: LastRowRead,
  what: string,
  ref: string,
  site = 'spawnForPersona',
): Promise<SpawnPersonaResult | undefined> {
  if (classifyAdError(err).errorClass !== AD_ERROR_CLASS_CONFLICT) return undefined
  const latch = conflictLatch
  if (latch === undefined) {
    logConflict(site, what, ref, err, LATCH_OUTCOME_NO_LATCH)
    return { key, action: 'latched' }
  }
  const recorded = await recordedRowState(key, lastRead, site)
  if ('latched' in recorded) {
    logConflict(site, what, ref, err, recorded.outcome)
    return { key, action: 'latched' }
  }
  const { rowState } = recorded
  try {
    latch.setFromConflict(key, err, { refusedOperation: operation, rowState })
  } catch (setErr) {
    logConflict(site, what, ref, err, `latching the persona failed: ${describeThrownValue(setErr)}`)
    return { key, action: 'latched' }
  }
  logConflict(site, what, ref, err, 'the persona latched')
  return { key, action: 'latched' }
}

/**
 * `conflictAt`'s one line for a CONFLICT at `what` for `ref`, with `outcome`
 * (what became of the latch), logged once the latch is set or has failed.
 */
function logConflict(site: string, what: string, ref: string, err: unknown, outcome: string): void {
  console.error(
    `[slack] ${site}: ${what} refused for ${ref}: ${describeAgentDirectorFailure(err)} — CONFLICT: ${outcome}; ` +
      `no spawn-failure notice; nothing more is called (b.jg5 SRJ-105, SRJ-501)`,
  )
}

/** The latch line's outcome with no latch installed. */
const LATCH_OUTCOME_NO_LATCH = 'no latch is installed, so nothing is latched'

/**
 * Latch persona `key` on the thrown UNUSABLE NAME `err` (b.jg5 SRJ-501,
 * SRJ-512): the installed latch's `set` with `unusableNameSetInput`'s input
 * (the case "unusable recorded name", the refused operation "none",
 * `rowState`, the classification's message as the description and the
 * session quoted in it). The latch's set observers then run, holds before
 * the notice (`main()`), and the notice reaction posts SRJ-1019 once per
 * episode. Answers the latch line's outcome text: the set's outcome
 * (`LATCH_SET_OUTCOME_TEXT`), `LATCH_OUTCOME_NO_LATCH` with no latch
 * installed, or that latching failed and what it threw. Logs nothing; never
 * throws.
 */
function latchOnUnusableName(key: string, err: unknown, rowState: LatchRowState): string {
  const latch = conflictLatch
  if (latch === undefined) return LATCH_OUTCOME_NO_LATCH
  try {
    const input = unusableNameSetInput(key, err, rowState)
    // Not reached: every caller has checked `isUnusableNameError`.
    if (input === undefined) return 'nothing is latched (the answer is not UNUSABLE NAME)'
    return LATCH_SET_OUTCOME_TEXT[latch.set(key, input)] ?? 'the persona latched'
  } catch (setErr) {
    return `latching the persona failed: ${describeThrownValue(setErr)}`
  }
}

/**
 * The one line for an UNUSABLE NAME answer at `what` for `ref` (b.jg5
 * SRJ-105, SRJ-512), with `outcome` (what became of the latch). The answer
 * is rendered by the redacting describer, never raw.
 */
function logUnusableName(site: string, what: string, ref: string, err: unknown, outcome: string): void {
  console.error(
    `[slack] ${site}: ${what} refused for ${ref}: ${describeAgentDirectorFailure(err)} — UNUSABLE NAME: ${outcome}; ` +
      `no spawn-failure notice; nothing more is called (b.jg5 SRJ-105, SRJ-512)`,
  )
}

/**
 * b.jg5 SRJ-105, SRJ-501, SRJ-512: the UNUSABLE NAME row of the ladder's
 * refusal handling, at every spawn and `resume` the collision ladder makes
 * (its reuse spawns included) and at a kill of the restart path or the
 * live-row sequence (`latchOnKillOutcomeAt`). `err` was thrown
 * by that call for persona `key`. It is the row's only when
 * `isUnusableNameError` (the classifier, by name) answers true; for any
 * other value it answers `undefined` and the site goes on as before (every
 * other `ErrInternal` is UNCLASSIFIED, SRJ-313).
 *
 * For an UNUSABLE NAME it latches the persona (`latchOnUnusableName`) with
 * the row state `lastRead`, the state the path last read before the call,
 * or, when it read nothing (`NOTHING_READ`), exactly one latch-time `status`
 * read (`latchTimeRowState`; when that read latched the persona itself, its
 * latch stands and nothing more is set). It logs one line (`site` and
 * `what` name the call) and answers `latched`: no spawn-failure notice, no
 * `spawn-failed` entry, nothing counted (the answer arms no retry timer), and
 * the caller kills, deletes, launches and reuses nothing more, so no
 * tmux-touching call follows (SRJ-502). With no latch installed it makes no
 * read, sets nothing, logs the one line saying so, and still answers
 * `latched`. Never throws.
 */
async function unusableNameAt(
  key: string,
  err: unknown,
  lastRead: LastRowRead,
  site: string,
  what: string,
  ref: string,
): Promise<LatchedSiteResult | undefined> {
  if (!isUnusableNameError(err)) return undefined
  if (conflictLatch === undefined) {
    logUnusableName(site, what, ref, err, LATCH_OUTCOME_NO_LATCH)
    return { key, action: 'latched' }
  }
  const recorded = await recordedRowState(key, lastRead, site)
  logUnusableName(
    site,
    what,
    ref,
    err,
    'latched' in recorded ? recorded.outcome : latchOnUnusableName(key, err, recorded.rowState),
  )
  return { key, action: 'latched' }
}

/**
 * The refusal handling of a spawn or `resume` the collision ladder makes
 * (b.jg5 SRJ-105): the CONFLICT row first (`conflictAt`, which latches the
 * persona and answers `latched`, with the refused operation "plain spawn"
 * for a spawn and "resume" for a resume, and `lastRead` as its row state),
 * then the UNUSABLE NAME row (`unusableNameAt`, which latches it with the
 * refused operation "none" and answers `latched`), then the refusal rows
 * (`refusalAt`, which answers `failed`). `undefined` for any other value,
 * which the site handles as before. Never throws.
 */
async function launchRefusalAt(
  key: string,
  err: unknown,
  verb: 'spawn' | 'resume',
  what: string,
  ref: string,
  lastRead: LastRowRead,
): Promise<SpawnPersonaResult | undefined> {
  const operation = verb === 'resume' ? REFUSED_OPERATION_RESUME : REFUSED_OPERATION_PLAIN_SPAWN
  return (
    (await conflictAt(key, err, operation, lastRead, what, ref)) ??
    (await unusableNameAt(key, err, lastRead, 'spawnForPersona', what, ref)) ??
    refusalAt(key, err, verb, 'spawnForPersona', what, ref)
  )
}

// ---------------------------------------------------------------------------
// Reads of a persona's own row (b.jg5 SRJ-114)
// ---------------------------------------------------------------------------

/** Whether a key is a persona of the applied configuration now. */
export type ConfiguredPersonaQuery = (key: string) => boolean

/**
 * The installed configured-persona query. Production installs one in
 * `main()` that reads the applied configuration at each call, so a persona an
 * apply adds or removes counts, or stops counting, at once. With none
 * installed (unit tests, the integration driver) no key counts as
 * configured, so no row read latches anyone by the row-read rule
 * (`readPersonaOwnRow`, `applyOwnRowStatusStep`).
 */
let configuredPersonaQuery: ConfiguredPersonaQuery | undefined

/** Install the configured-persona query (production: `main()`), or remove it with undefined. */
export function setConfiguredPersonaQuery(query: ConfiguredPersonaQuery | undefined): void {
  configuredPersonaQuery = query
}

/** Test-only seam: remove any installed configured-persona query. */
export function _resetConfiguredPersonaQuery(): void {
  configuredPersonaQuery = undefined
}

/**
 * What the session manager uses of the server's one retired-key store
 * (`src/retired-keys.ts`): `isMarked`, asked at every own-row read, and
 * `clear`, on the row-read rule's clear decision (b.jg5 SRJ-807);
 * `isRecorded` and `isMarked`, asked at each launch decision and by the
 * restart path's reconnect adapter (`retiredKeyReadingOf`, SRJ-805); and
 * `mark`, the "new life has begun" mark's one writer, called when a reuse
 * spawn for a recorded key succeeds and, to write again a mark whose write
 * failed, at the key's next launch decision (SRJ-806); and
 * `recordGeneration`, read when a launch attempt starts and at a reuse
 * spawn's success, so that a key recorded during the attempt, a re-record
 * that wrote nothing included, gets no mark (`reuseSuccessAction`, SRJ-806);
 * and `record`, the start sweep's one batch record of absent personas' keys
 * (`recordAbsentPersonaKeys`, SRJ-714, SRJ-803).
 */
export type SessionRetiredKeys = Pick<RetiredKeyStore, 'isRecorded' | 'isMarked' | 'mark' | 'clear' | 'recordGeneration' | 'record'>

/**
 * The installed retired-key store. Production installs the one store
 * `main()` loads, before the start sweep, so the clear is active at the first
 * row the server reads. With none installed (unit tests, the integration
 * driver, the CLI, which never writes the record, b.jg5 SRJ-801) no key
 * counts as recorded or marked, so no own-row read clears an entry, every
 * read behaves as it does with no store (`readPersonaOwnRow`,
 * `applyOwnRowStatusStep`), and every launch path launches as for a key that
 * is not retired (b.jg5 SRJ-711).
 */
let retiredKeyStore: SessionRetiredKeys | undefined

/** Install the server's retired-key store (production: `main()`), or remove it with undefined (b.jg5 SRJ-807). */
export function setRetiredKeyStore(store: SessionRetiredKeys | undefined): void {
  retiredKeyStore = store
}

/** Test-only seam: remove any installed retired-key store. */
export function _resetRetiredKeyStore(): void {
  retiredKeyStore = undefined
}

/**
 * The installed old-life hold set (b.jg5 SRJ-809; `createOldLifeHoldSet`,
 * `src/retired-keys.ts`). Production installs the one set `main()` builds,
 * before the start sweep, the set the reload controller's apply step 1
 * begins holds in. The session manager ends or re-points a hold at every
 * read it makes of a held row (`noteOldLifeRowRead`), ends a key's hold when
 * its reuse begins its new life (`endOldLifeHoldForNewLife`), begins the
 * start sweep's holds (`reconcileOrphans`) and marks a hold kill-failed when
 * the persona teardown's kill decided the ordinary kill-failure alert
 * (`killPersonaInstanceForTeardown`, SRJ-812). With none installed (unit
 * tests, the integration driver, the CLI) no row is held: every hold query
 * answers not held, no hold begins, and every hook does nothing.
 */
let oldLifeHolds: OldLifeHoldSet | undefined

/**
 * The state of each held row last read, by instance id (`noteOldLifeRowRead`):
 * the seed of the next wait's request on it. Dropped when its hold ends.
 */
const oldLifeLastReadState = new Map<string, string>()

/**
 * The tmux session of each held row, by instance id, as the start sweep's
 * listing named it when it began or kept the row's hold
 * (`noteOldLifeHoldSession`): the session a wait's kill-failure alert names
 * before a `get` of the row has read one. Dropped when its hold ends.
 */
const oldLifeSessionNames = new Map<string, string>()

/**
 * The stop of each old-life wait a hold's end stopped while it ran
 * (`onOldLifeHoldEnd`), by the held instance id: the registry's
 * `stopNoLaunch` promise, which resolves once the stopped wait has settled.
 * The end-retry observer (`createOldLifeHoldEndRetry`) retries a persona
 * whose own `cscb_<key>` that wait was on only once it has settled. Each
 * entry is dropped when its stop resolves.
 */
const oldLifeHoldEndStops = new Map<string, Promise<boolean>>()

/** Removes the hold-end observer from the installed hold set; undefined while none is registered. */
let removeOldLifeHoldEndObserver: (() => void) | undefined

/**
 * Install the server's old-life hold set (production: `main()`), or remove it
 * with undefined (b.jg5 SRJ-809). One end observer is registered on it
 * (`onOldLifeHoldEnd`): a hold's end ends its old-life wait (b.jg5 SRJ-811).
 */
export function setOldLifeHolds(holds: OldLifeHoldSet | undefined): void {
  removeOldLifeHoldEndObserver?.()
  removeOldLifeHoldEndObserver = undefined
  oldLifeHolds = holds
  oldLifeLastReadState.clear()
  oldLifeSessionNames.clear()
  oldLifeHoldEndStops.clear()
  if (holds !== undefined) removeOldLifeHoldEndObserver = holds.onEnd(onOldLifeHoldEnd)
}

/** Test-only seam: remove any installed old-life hold set and its end observer. */
export function _resetOldLifeHolds(): void {
  setOldLifeHolds(undefined)
}

/**
 * The hold set's end observer (b.jg5 SRJ-811, SRJ-809): a hold that ends
 * ends its old-life wait through the registry's no-launch stop (reason
 * `hold-ended`), which never stops a live-row sequence that ends in a launch
 * on the same id. A wait whose kill is between tries, or in a try whose
 * UNAVAILABLE outcome would stand, ends those tries as a success (the kill's
 * hold-end query; SRJ-702, option A), never as a stopped retry. The hold's
 * end also ends the wait's unclassified-error episode on the id, which
 * nothing else ends (b.jg5 SRJ-313; `OldLifeWaitBindings.unclassifiedErrorEpisodes`).
 * The stop of a wait that ran is kept until it resolves
 * (`oldLifeHoldEndStops`), so the end-retry observer can retry a persona
 * waiting on its own row once the stopped wait has settled. Called
 * synchronously inside the hold's end; returns nothing to await. Never
 * throws.
 */
function onOldLifeHoldEnd(hold: OldLifeHold): void {
  oldLifeLastReadState.delete(hold.instanceId)
  oldLifeSessionNames.delete(hold.instanceId)
  try {
    oldLifeWaitBindings?.unclassifiedErrorEpisodes?.end(hold.instanceId, UNCLASSIFIED_ERROR_END_HOLD_ENDED)
  } catch (err) {
    console.error(`[slack] old-life hold: ending the unclassified-error episode of instanceId=${hold.instanceId} failed: ${describeThrownValue(err)} (b.jg5 SRJ-313)`)
  }
  try {
    const registry = liveRowSequenceRegistry
    const ran = registry?.isNoLaunchRunning(hold.instanceId) === true
    const stopped = registry?.stopNoLaunch(hold.instanceId, LIVE_ROW_STOP_HOLD_ENDED)
    if (ran && stopped !== undefined) keepOldLifeHoldEndStop(hold.instanceId, stopped)
  } catch (err) {
    console.error(`[slack] old-life hold: stopping the wait on instanceId=${hold.instanceId} failed: ${describeThrownValue(err)} (b.jg5 SRJ-811)`)
  }
}

/**
 * Keep the stop of the wait a hold's end stopped on `instanceId` until it
 * resolves (`oldLifeHoldEndStops`). Never throws.
 */
function keepOldLifeHoldEndStop(instanceId: string, stopped: Promise<boolean>): void {
  oldLifeHoldEndStops.set(instanceId, stopped)
  const drop = (): void => {
    if (oldLifeHoldEndStops.get(instanceId) === stopped) oldLifeHoldEndStops.delete(instanceId)
  }
  void stopped.then(drop, drop)
}

/**
 * The stop a hold's end made of the wait on `instanceId` while it ran
 * (`onOldLifeHoldEnd`), until that stopped wait has settled; undefined when
 * none is pending. Never throws.
 */
function pendingOldLifeHoldEndStop(instanceId: string): Promise<boolean> | undefined {
  return oldLifeHoldEndStops.get(instanceId)
}

/** A read of a row gave its state (and, from a `get` or a `list` row, its `cwd`). */
export const OLD_LIFE_ROW_READ_STATE = 'state'
/** A read of a row found no row (`ErrSpawnNotFound`, by name). */
export const OLD_LIFE_ROW_READ_NO_ROW = 'no-row'
/** A completed `find-missing` run listed the row in its `ids`. */
export const OLD_LIFE_ROW_READ_FIND_MISSING_IDS = 'find-missing-ids'

/** What one read of a row answered, as `noteOldLifeRowRead` takes it. */
export type OldLifeRowRead =
  | { readonly kind: typeof OLD_LIFE_ROW_READ_STATE; readonly state: unknown; readonly cwd?: unknown }
  | { readonly kind: typeof OLD_LIFE_ROW_READ_NO_ROW }
  | { readonly kind: typeof OLD_LIFE_ROW_READ_FIND_MISSING_IDS }

/**
 * The one entry for a read of row `instanceId` (b.jg5 SRJ-809): what ends or
 * re-points an old-life hold on it, whoever made the read. `by` names the
 * read in the end line (`<site>: <what>`).
 *   - a state `ended` ends the hold (`OLD_LIFE_HOLD_END_READ_ENDED`); a state
 *     `missing`, or no row, ends it (`OLD_LIFE_HOLD_END_READ_MISSING`); a
 *     listing in a completed `find-missing` run's `ids` ends it
 *     (`OLD_LIFE_HOLD_END_FIND_MISSING_IDS`);
 *   - any other state (`pending` included, and a state CSCB does not know)
 *     keeps it, and a `cwd` the read carries that differs from the held
 *     directory replaces it (no line).
 * No kill outcome reaches this entry: a kill's success (`kill_sent` true,
 * false or absent, `ErrSpawnNotFound` at the kill), a CONFLICT and every
 * other answer to a kill end nothing (AC 54, AC 63); a kill retry's
 * between-try `status` read that finds the row finished is a read, and ends
 * the hold through its own call here. With no hold set installed, or no hold
 * on the id, nothing happens. Makes no agent-director call. Never throws.
 */
export function noteOldLifeRowRead(instanceId: string, read: OldLifeRowRead, by: string): void {
  const holds = oldLifeHolds
  if (holds === undefined || typeof instanceId !== 'string') return
  try {
    if (holds.holdOf(instanceId) === undefined) return
    if (read.kind === OLD_LIFE_ROW_READ_NO_ROW) {
      holds.end(instanceId, OLD_LIFE_HOLD_END_READ_MISSING, `${by}: no row`)
      return
    }
    if (read.kind === OLD_LIFE_ROW_READ_FIND_MISSING_IDS) {
      holds.end(instanceId, OLD_LIFE_HOLD_END_FIND_MISSING_IDS, by)
      return
    }
    if (read.state === 'ended' || read.state === 'missing') {
      const reason: OldLifeHoldEndReason = read.state === 'ended' ? OLD_LIFE_HOLD_END_READ_ENDED : OLD_LIFE_HOLD_END_READ_MISSING
      holds.end(instanceId, reason, by)
      return
    }
    // b.jg5 SRJ-811: the state a live read gave seeds the hold's next wait.
    if (isSafeIdentifier(read.state)) oldLifeLastReadState.set(instanceId, read.state)
    if (typeof read.cwd === 'string' && read.cwd !== '') holds.replaceDirectory(instanceId, read.cwd)
  } catch (err) {
    // Not reached (the hold set never throws); the hold stays as it was.
    console.error(`[slack] old-life hold: noting the read of instanceId=${instanceId} failed: ${describeThrownValue(err)} (b.jg5 SRJ-809)`)
  }
}

/** `<site>: <what>`, the read an own-row read site names in a hold's end line. */
function oldLifeReadName(at: OwnRowReadSite): string {
  return `${at.site}: ${at.what}`
}

/**
 * One `status` answer from persona `key`'s own row, given to the old-life
 * read entry (`noteOldLifeRowRead`, b.jg5 SRJ-809): a returned result's
 * state, or no row for a thrown `ErrSpawnNotFound` (by name); any other
 * thrown value read nothing and is not given. A `status` result carries no
 * `cwd`. Never throws.
 */
function noteOldLifeStatusAnswer(key: string, answer: OwnRowStatusAnswer, at: OwnRowReadSite): void {
  if ('thrown' in answer) {
    if (hasAdErrorName(answer.thrown, ERR_SPAWN_NOT_FOUND_NAME)) {
      noteOldLifeRowRead(personaInstanceId(key), { kind: OLD_LIFE_ROW_READ_NO_ROW }, oldLifeReadName(at))
    }
    return
  }
  noteOldLifeRowRead(personaInstanceId(key), { kind: OLD_LIFE_ROW_READ_STATE, state: answer.result.state }, oldLifeReadName(at))
}

/**
 * End the old-life hold on persona key `key`'s own row (`cscb_<key>`)
 * because a reuse spawn for the key began its new life (b.jg5 SRJ-809,
 * SRJ-806): a reuse that succeeded reset a finished row, so the old life is
 * over. Called at a recorded key's reuse success (`reuseSuccessAction`), and
 * at a reuse that timed out but launched, whose `get` read this launch's row
 * (`markNewLifeAfterTimedOutReuse`, b.jg5 SRJ-407), whatever the mark's write
 * did; `readName` names that read in the hold's end line. With no hold set
 * installed, or no hold on the id, nothing happens. Never throws.
 */
function endOldLifeHoldForNewLife(key: string, readName: string = OLD_LIFE_NEW_LIFE_READ): void {
  const holds = oldLifeHolds
  if (holds === undefined) return
  try {
    holds.end(personaInstanceId(key), OLD_LIFE_HOLD_END_NEW_LIFE, readName)
  } catch (err) {
    // Not reached (the hold set never throws).
    console.error(`[slack] old-life hold: ending the hold of ${keyRef(key)} for its new life failed: ${describeThrownValue(err)} (b.jg5 SRJ-809)`)
  }
}

/**
 * Whether key `key` is recorded as retired with its "new life has begun" mark
 * set, by the installed store, for the row-read rule (b.jg5 SRJ-807). No store
 * installed, or an `isMarked` that throws, counts as not marked, so nothing
 * is cleared. Never throws.
 */
function retiredMarkOf(key: string): boolean {
  const store = retiredKeyStore
  if (store === undefined) return false
  try {
    return store.isMarked(key) === true
  } catch (err) {
    console.error(`[slack] retired-keys: the mark query for ${keyRef(key)} failed: ${describeThrownValue(err)}; nothing is cleared (b.jg5 SRJ-807)`)
    return false
  }
}

/** What the installed retired-key store says of a key (`retiredKeyReadingOf`; b.jg5 SRJ-805, SRJ-806). */
export interface RetiredKeyReading {
  /** The key is recorded as retired (a key held only in memory included). */
  readonly recorded: boolean
  /**
   * The key is recorded with its "new life has begun" mark set, a mark whose
   * write failed, held in memory for this server's life, included. Always
   * false when the key is not recorded.
   */
  readonly marked: boolean
}

/** The reading of a key that is not recorded. */
const RETIRED_KEY_NOT_RECORDED: RetiredKeyReading = Object.freeze({ recorded: false, marked: false })

/**
 * Whether persona key `key` is recorded as retired, and whether its "new
 * life has begun" mark is set, by the installed store (b.jg5 SRJ-805,
 * SRJ-806): read at each launch decision for the key, at the live-row
 * sequence's start entry and by the restart path's reconnect adapter, so
 * every reader reads the one store `main()` installed. With no store
 * installed the key is not recorded. A query that throws gives one line: a
 * recorded query that throws reads not recorded, as with no store; a mark
 * query that throws reads not marked, so the row is the old life, erring
 * toward a fresh start. Never throws.
 */
export function retiredKeyReadingOf(key: string): RetiredKeyReading {
  const store = retiredKeyStore
  if (store === undefined) return RETIRED_KEY_NOT_RECORDED
  try {
    if (store.isRecorded(key) !== true) return RETIRED_KEY_NOT_RECORDED
  } catch (err) {
    console.error(
      `[slack] retired-keys: the recorded query for ${keyRef(key)} failed: ${describeThrownValue(err)}; taken as not recorded (b.jg5 SRJ-805)`,
    )
    return RETIRED_KEY_NOT_RECORDED
  }
  try {
    return { recorded: true, marked: store.isMarked(key) === true }
  } catch (err) {
    console.error(
      `[slack] retired-keys: the mark query for ${keyRef(key)} failed: ${describeThrownValue(err)}; taken as not marked, so its row is the old life (b.jg5 SRJ-805, SRJ-806)`,
    )
    return { recorded: true, marked: false }
  }
}

/**
 * Persona key `key`'s record generation in the installed store (b.jg5
 * SRJ-806): how many recordings named it in this server's life
 * (`RetiredKeyStore.recordGeneration`), read when a launch attempt starts
 * (`retiredKeyAttemptStartOf`) and at a reuse spawn's success. Undefined
 * with no store installed, or when the query throws, which gives one line;
 * `reuseSuccessAction` takes an
 * undefined generation as a recording it cannot rule out, so no mark is set,
 * erring toward a fresh start. Never throws.
 */
function retiredRecordGenerationOf(key: string): number | undefined {
  const store = retiredKeyStore
  if (store === undefined) return undefined
  try {
    return store.recordGeneration(key)
  } catch (err) {
    console.error(
      `[slack] retired-keys: the record-generation query for ${keyRef(key)} failed: ${describeThrownValue(err)}; a recording during the launch attempt cannot be ruled out, so no mark is set (b.jg5 SRJ-806)`,
    )
    return undefined
  }
}

/**
 * Persona key `key`'s reading at one of its launch decisions (b.jg5 SRJ-805,
 * SRJ-806): `retiredKeyReadingOf`, and, for a recorded key whose mark is
 * set, one call of the store's `mark`, which writes again a mark whose
 * earlier write failed and is held only in memory, and writes nothing for a
 * mark already in the file. The store logs its write and its failure; a
 * `mark` that throws gives one line. The reading is answered whatever the
 * write did. Never throws.
 */
function retiredLaunchReadingOf(key: string): RetiredKeyReading {
  const reading = retiredKeyReadingOf(key)
  const store = retiredKeyStore
  if (!reading.marked || store === undefined) return reading
  try {
    store.mark(key)
  } catch (err) {
    console.error(
      `[slack] retired-keys: writing the held mark of ${keyRef(key)} again failed: ${describeThrownValue(err)}; this server still reads it as marked (b.jg5 SRJ-806)`,
    )
  }
  return reading
}

/**
 * The installed store's reading of persona key `key` and its record
 * generation when a launch attempt starts (b.jg5 SRJ-806;
 * `RetiredKeyAttemptStart`): `reading` when the attempt has already read the
 * key (the collision ladder's launch decision), else `retiredKeyReadingOf`;
 * the generation is read only for a recorded key
 * (`retiredRecordGenerationOf`). Taken by the collision ladder at its start
 * (`runPersonaLadder`), by the live-row sequence's start entry
 * (`startLiveRowSequence`), and by a reuse spawn with no attempt context just
 * before its call. Never throws.
 */
function retiredKeyAttemptStartOf(key: string, reading: RetiredKeyReading = retiredKeyReadingOf(key)): RetiredKeyAttemptStart {
  return { recorded: reading.recorded, marked: reading.marked, generation: reading.recorded ? retiredRecordGenerationOf(key) : undefined }
}

/** `<how>` of the in-flight reuse line: the key was not recorded when the launch attempt started (b.jg5 SRJ-806). */
export const REUSE_RECORDED_SINCE_NOT_RECORDED_AT_START = 'it was not recorded when the launch attempt started'

/** `<how>` of the in-flight reuse line: a recording named the key again since the launch attempt started (b.jg5 SRJ-806). */
export const REUSE_RECORDED_SINCE_RECORDED_AGAIN = 'recorded again while the launch attempt was in flight'

/** `<how>` of the in-flight reuse line: a record generation could not be read (b.jg5 SRJ-806). */
export const REUSE_RECORDED_SINCE_GENERATION_UNREADABLE =
  'its record generation could not be read, so a recording during the launch attempt cannot be ruled out'

/** How a key came to be recorded during a reuse spawn's launch attempt: one of the three `<how>` texts. */
export type ReuseRecordedSince =
  | typeof REUSE_RECORDED_SINCE_NOT_RECORDED_AT_START
  | typeof REUSE_RECORDED_SINCE_RECORDED_AGAIN
  | typeof REUSE_RECORDED_SINCE_GENERATION_UNREADABLE

/**
 * The in-flight reuse line (b.jg5 SRJ-806, SRJ-805): a reuse spawn of `ref`
 * succeeded for a key recorded during its launch attempt (`how`), so no mark
 * is set:
 *
 *   [slack] reuseSpawnForPersona: <ref>'s key was recorded as retired while this reuse spawn's launch attempt was in flight (<how>) — the launch was decided before that recording, so its life is the old life: no mark is set; answering spawned (b.jg5 SRJ-806, SRJ-805)
 */
export function reuseRecordedInFlightLine(ref: string, how: ReuseRecordedSince): string {
  return `[slack] ${REUSE_SPAWN_SITE}: ${ref}'s key was recorded as retired while this reuse spawn's launch attempt was in flight (${how}) — the launch was decided before that recording, so its life is the old life: no mark is set; answering spawned (b.jg5 SRJ-806, SRJ-805)`
}

/**
 * The action a reuse spawn of persona `key` that succeeded answers (b.jg5
 * SRJ-806, SRJ-112's success row), given `start`, the installed store's
 * reading of the key and its record generation when the launch attempt the
 * reuse runs in started (`retiredKeyAttemptStartOf`; just before the call
 * for a reuse with no attempt context):
 *   - `fresh-retired` when the key was recorded both at the attempt's start
 *     and now, and its record generation now equals the start's, so no
 *     recording named it since: its "new life has begun" mark is set through
 *     the store's `mark`, the mark's one writer, unless it is already set;
 *   - `spawned` for a key not recorded now, with nothing written;
 *   - `spawned` for a key recorded since the attempt started (not recorded
 *     then, or recorded again since, whether that cleared a mark or, for a
 *     key with no mark, wrote nothing; a generation that could not be read
 *     counts as such a recording): the launch was decided before that
 *     recording, under the declaration the attempt carries, so its life is
 *     the life being retired, and no mark is set. One line
 *     (`reuseRecordedInFlightLine`, `<how>` one of the
 *     `REUSE_RECORDED_SINCE_*` texts):
 *
 *   [slack] reuseSpawnForPersona: <ref>'s key was recorded as retired while this reuse spawn's launch attempt was in flight (<how>) — the launch was decided before that recording, so its life is the old life: no mark is set; answering spawned (b.jg5 SRJ-806, SRJ-805)
 *
 * For `fresh-retired`, one line names `ref`, that its new life has begun and
 * what the mark's write did, and then the old-life hold on `cscb_<key>`, if
 * any, ends with the new-life reason, whatever the mark's write did
 * (`endOldLifeHoldForNewLife`, b.jg5 SRJ-809):
 *
 *   [slack] reuseSpawnForPersona: <ref>'s key is retired and its new life has begun — answering fresh-retired; <mark> (b.jg5 SRJ-806, SRJ-112)
 *
 * A write that fails is held in memory by the store (its own one line), so
 * this server reads the key as marked and writes the mark again at the key's
 * next launch decision (`retiredLaunchReadingOf`); a restart loses it.
 * Never throws.
 */
function reuseSuccessAction(key: string, ref: string, start: RetiredKeyAttemptStart): 'spawned' | typeof SPAWN_ACTION_FRESH_RETIRED {
  const decided = setNewLifeMarkForReuse(key, start)
  switch (decided.kind) {
    case NEW_LIFE_MARK_NOT_RECORDED:
      return 'spawned'
    case NEW_LIFE_MARK_RECORDED_SINCE:
      console.error(reuseRecordedInFlightLine(ref, decided.how))
      return 'spawned'
    case NEW_LIFE_MARK_SET:
      console.error(
        `[slack] ${REUSE_SPAWN_SITE}: ${ref}'s key is retired and its new life has begun — answering ${SPAWN_ACTION_FRESH_RETIRED}; ${decided.mark} (b.jg5 SRJ-806, SRJ-112)`,
      )
      // b.jg5 SRJ-809: the new life implies the old row was finished, so the
      // key's old-life hold ends, whatever the mark's write did.
      endOldLifeHoldForNewLife(key)
      return SPAWN_ACTION_FRESH_RETIRED
  }
}

/** `setNewLifeMarkForReuse`: the key is not recorded now; nothing is written. */
const NEW_LIFE_MARK_NOT_RECORDED = 'not-recorded'
/** `setNewLifeMarkForReuse`: the key was recorded since the launch attempt started; no mark is set. */
const NEW_LIFE_MARK_RECORDED_SINCE = 'recorded-since'
/** `setNewLifeMarkForReuse`: the key's "new life has begun" mark is set (`mark` says what the write did). */
const NEW_LIFE_MARK_SET = 'set'

/** What `setNewLifeMarkForReuse` did. */
type NewLifeMarkDecision =
  | { readonly kind: typeof NEW_LIFE_MARK_NOT_RECORDED }
  | { readonly kind: typeof NEW_LIFE_MARK_RECORDED_SINCE; readonly how: ReuseRecordedSince }
  | { readonly kind: typeof NEW_LIFE_MARK_SET; readonly mark: string }

/**
 * The mark step of a reuse spawn of persona `key` that began a new life
 * (b.jg5 SRJ-806), shared by a reuse that succeeded (`reuseSuccessAction`)
 * and one that timed out but launched (`markNewLifeAfterTimedOutReuse`,
 * b.jg5 SRJ-407), given `start`, the store's reading of the key and its
 * record generation when the launch attempt started:
 *   - not recorded now (or no store installed): nothing written;
 *   - recorded since the attempt started (not recorded then, recorded again
 *     since, or a generation that could not be read): no mark, with `how`;
 *   - otherwise the "new life has begun" mark is set through the store's
 *     `mark`, the mark's one writer, unless it is already set; `mark` says
 *     what the write did (a failed write is held in memory by the store).
 * Logs nothing and ends no hold: each caller writes its own line and then
 * ends the key's old-life hold (`endOldLifeHoldForNewLife`) for a set mark.
 * Never throws.
 */
function setNewLifeMarkForReuse(key: string, start: RetiredKeyAttemptStart): NewLifeMarkDecision {
  const reading = retiredKeyReadingOf(key)
  const store = retiredKeyStore
  if (!reading.recorded || store === undefined) return { kind: NEW_LIFE_MARK_NOT_RECORDED }
  // b.jg5 SRJ-806: a recording made since the launch attempt started retires
  // the life this launch began, so that life is never marked as the new one.
  // The record generation shows a re-record of an unmarked key, which writes nothing.
  const generationNow = start.recorded && start.generation !== undefined ? retiredRecordGenerationOf(key) : undefined
  const recordedSince: ReuseRecordedSince | undefined = !start.recorded
    ? REUSE_RECORDED_SINCE_NOT_RECORDED_AT_START
    : start.generation === undefined || generationNow === undefined
      ? REUSE_RECORDED_SINCE_GENERATION_UNREADABLE
      : generationNow !== start.generation
        ? REUSE_RECORDED_SINCE_RECORDED_AGAIN
        : undefined
  if (recordedSince !== undefined) return { kind: NEW_LIFE_MARK_RECORDED_SINCE, how: recordedSince }
  let mark: string
  if (reading.marked) {
    mark = 'its mark was already set, so nothing is written'
  } else {
    let outcome: string
    try {
      outcome = store.mark(key)
    } catch (err) {
      outcome = `threw: ${describeThrownValue(err)}`
    }
    switch (outcome) {
      case RETIRED_KEYS_WRITTEN:
        mark = 'its mark is set in the retired-key record'
        break
      case RETIRED_KEYS_UNCHANGED:
        mark = 'its mark was already set, so nothing is written'
        break
      case RETIRED_KEYS_NOT_RECORDED:
        // Not reached: the key was read recorded just above, and nothing runs in between.
        return { kind: NEW_LIFE_MARK_NOT_RECORDED }
      case RETIRED_KEYS_WRITE_FAILED:
        mark =
          "writing its mark failed, so this server holds the mark in memory and writes it again at the key's next launch decision"
        break
      default:
        mark = `setting its mark ${outcome}; this server reads the key as it did before`
    }
  }
  return { kind: NEW_LIFE_MARK_SET, mark }
}

/**
 * The read name the old-life hold's end line gives a reuse that timed out
 * but launched, whose `get` read this launch's row (b.jg5 SRJ-407, SRJ-806,
 * SRJ-809).
 */
export const OLD_LIFE_NEW_LIFE_AFTER_TIMEOUT_READ = "spawnForPersona: get after the reuse spawn's launch timeout read this launch's row"

/**
 * The line of a reuse of a retired key that timed out but launched (b.jg5
 * SRJ-407, SRJ-806): its `get` read this launch's row, so the key's new life
 * has begun; `mark` says what the mark's write did. The launch still answers
 * `retrying`:
 *
 *   [slack] spawnForPersona: <ref>'s key is retired and its reuse spawn timed out but launched (its row is this launch's) — its new life has begun; <mark>; the launch answers retrying (b.jg5 SRJ-407, SRJ-806)
 */
export function timedOutReuseNewLifeLine(ref: string, mark: string): string {
  return `[slack] spawnForPersona: ${ref}'s key is retired and its reuse spawn timed out but launched (its row is this launch's) — its new life has begun; ${mark}; the launch answers ${SPAWN_ACTION_RETRYING} (b.jg5 SRJ-407, SRJ-806)`
}

/**
 * The line of a reuse of a key recorded as retired during its launch attempt
 * (`how`), which timed out but launched (b.jg5 SRJ-407, SRJ-806): no mark is
 * set, so its row is the old life:
 *
 *   [slack] spawnForPersona: <ref>'s key was recorded as retired while its reuse spawn's launch attempt was in flight (<how>) — the reuse timed out but launched; its life is the old life: no mark is set (b.jg5 SRJ-407, SRJ-806)
 */
export function timedOutReuseRecordedInFlightLine(ref: string, how: ReuseRecordedSince): string {
  return `[slack] spawnForPersona: ${ref}'s key was recorded as retired while its reuse spawn's launch attempt was in flight (${how}) — the reuse timed out but launched; its life is the old life: no mark is set (b.jg5 SRJ-407, SRJ-806)`
}

/**
 * SRJ-806's second trigger (b.jg5 SRJ-407, SRJ-806, SRJ-809): a reuse spawn
 * of persona `key` that ended in a launch timeout, and whose one `get` read
 * this launch's row (its launch start inside the call's window), began the
 * key's new life. Through the same mark step as a reuse success
 * (`setNewLifeMarkForReuse`, with `start`, the attempt's start): for a key
 * recorded then and still, with no recording since, the mark is set (a
 * failed write held in memory) with one line (`timedOutReuseNewLifeLine`),
 * and the key's old-life hold ends with the new-life reason
 * (`endOldLifeHoldForNewLife`, read name
 * `OLD_LIFE_NEW_LIFE_AFTER_TIMEOUT_READ`), whose end observer retries a
 * persona waiting on it at once; a key recorded since gets one line
 * (`timedOutReuseRecordedInFlightLine`) and no mark; a key not recorded,
 * nothing. Answers whether the mark was set. The launch's result is not
 * changed by it. Never throws.
 */
function markNewLifeAfterTimedOutReuse(key: string, ref: string, start: RetiredKeyAttemptStart): boolean {
  const decided = setNewLifeMarkForReuse(key, start)
  switch (decided.kind) {
    case NEW_LIFE_MARK_NOT_RECORDED:
      return false
    case NEW_LIFE_MARK_RECORDED_SINCE:
      console.error(timedOutReuseRecordedInFlightLine(ref, decided.how))
      return false
    case NEW_LIFE_MARK_SET:
      console.error(timedOutReuseNewLifeLine(ref, decided.mark))
      endOldLifeHoldForNewLife(key, OLD_LIFE_NEW_LIFE_AFTER_TIMEOUT_READ)
      return true
  }
}

/**
 * Act on a clear decision of the row-read rule over one read of key `key`'s
 * own row (b.jg5 SRJ-807): clear the key's entry through the installed store,
 * whose one line names the persona reference, the file and this read (the
 * state read, `at`'s site and what it read):
 *
 *   [slack] retired-keys: persona=<key> entry cleared from "<path>" on its row read <state> with its mark set (<site>: <what>) (b.jg5 SRJ-807)
 *   [slack] retired-keys: cannot clear persona=<key> from "<path>" on its row read <state> with its mark set (<site>: <what>)<failure>; the entry stays, and the next qualifying read clears it again (b.jg5 SRJ-807)
 *
 * A failed write leaves the entry, in memory and in the file, and the next
 * qualifying read tries again; the read's answer to its caller is the same
 * whatever the clear did. Applied beside any latch the same read decided.
 * Never throws.
 */
function clearRetiredEntryOnRead(key: string, decision: RowReadClearDecision, at: OwnRowReadSite): void {
  const store = retiredKeyStore
  if (store === undefined) return
  try {
    store.clear(key, `its row read ${decision.stateRead} with its mark set (${at.site}: ${at.what})`)
  } catch (err) {
    // Not reached (the store's clear never throws); the entry stays, and the read goes on.
    console.error(`[slack] retired-keys: clearing ${keyRef(key)}'s entry failed: ${describeThrownValue(err)}; the entry stays (b.jg5 SRJ-807)`)
  }
}

/** Who reads, in the own-row lines of the retry timer's row read (`readPersonaRowState`; b.jg5 SRJ-115, SRJ-807). */
export const RETRY_ROW_READ_SITE: OwnRowReadSite = Object.freeze({ site: 'unavailable-retry', what: 'retry row read' })

/** Who reads, in the own-row lines of the `working`-row wait's `status` reads (`waitForWaitingAndReconnect`; the persona's ref is added; b.jg5 SRJ-115, SRJ-807). */
export const WORKING_WAIT_STATUS_SITE: OwnRowReadSite = Object.freeze({ site: 'waitForWaitingAndReconnect', what: 'status read' })

/** Who reads, in the own-row lines of the collision ladder's collision `get` (`ladderGetThenAct`; the persona's ref is added; b.jg5 SRJ-114, SRJ-807). */
export const COLLISION_GET_SITE: OwnRowReadSite = Object.freeze({ site: 'spawnForPersona', what: 'collision get' })

/**
 * The installed kill-failure alerts (b.jg5 SRJ-704, SRJ-1016;
 * `createKillFailureAlerts`, `src/persona-episodes.ts`). Production installs
 * `main()`'s, built over its notice episodes. The persona kills' alert
 * (`raisePersonaKillFailureAlert`) raises through it, and every own-row read
 * that reads the row `ended` or `missing`, or finds it gone, ends the
 * persona's kill-failure episode through it (`endKillFailureEpisodeOnRead`):
 * on the replacing path these are the collision ladder's `get` and the
 * live-row sequence's `get`s and between-try `status` reads, so a row seen
 * gone there ends the episode. With none installed (unit tests, the
 * integration driver) an alert is written as one log line only, and no
 * episode is ended.
 */
let killFailureAlerts: KillFailureAlerts | undefined

/** Install the kill-failure alerts (production: `main()`), or remove them with undefined. */
export function setKillFailureAlerts(alerts: KillFailureAlerts | undefined): void {
  killFailureAlerts = alerts
}

/** End persona `key`'s kill-failure episode for `reason` through the installed alerts. Never throws. */
function endKillFailureEpisode(key: string, reason: KillFailureEndReason): void {
  try {
    killFailureAlerts?.end(key, reason)
  } catch (err) {
    console.error(`[slack] kill-failure episode end for ${keyRef(key)} failed: ${describeThrownValue(err)}`)
  }
}

/**
 * The kill-failure episode's end at a read of persona `key`'s own row
 * (b.jg5 SRJ-704, SRJ-1016): a row read `ended` or `missing`
 * (`AGENT_DIRECTOR_DEAD_STATES`), or an answer of `ErrSpawnNotFound` (by
 * name: the row is gone), ends the persona's open episode silently. No other
 * answer ends it: not a live state, not `ErrSystemInstallDisappeared` (which
 * reads no row), and no kill's success. Never throws.
 */
function endKillFailureEpisodeOnRead(key: string, answer: { readonly state: unknown } | { readonly thrown: unknown }): void {
  if ('thrown' in answer) {
    if (hasAdErrorName(answer.thrown, ERR_SPAWN_NOT_FOUND_NAME)) endKillFailureEpisode(key, KILL_FAILURE_END_ROW_GONE)
    return
  }
  if (typeof answer.state === 'string' && AGENT_DIRECTOR_DEAD_STATES.has(answer.state)) {
    endKillFailureEpisode(key, KILL_FAILURE_END_ROW_FINISHED)
  }
}

/**
 * The server's one notice episodes instance, for the stuck-launch episode
 * (b.jg5 SRJ-1016, SRJ-1017; `createPersonaEpisodes`,
 * `src/persona-episodes.ts`). Production installs `main()`'s notice episodes
 * (`setStuckLaunchEpisodes`), before the start pass. Every own-row read that
 * reads the row live out of `pending` ends the persona's stuck-launch
 * episode through it (`endStuckLaunchEpisodeOnRead`). With none installed
 * (unit tests, the integration driver) no episode is ended.
 */
let stuckLaunchEpisodes: PersonaEpisodes | undefined

/** Install the notice episodes the stuck-launch episode lives in (production: `main()`), or remove them with undefined. */
export function setStuckLaunchEpisodes(episodes: PersonaEpisodes | undefined): void {
  stuckLaunchEpisodes = episodes
}

/**
 * The stuck-launch episode's end at a read of persona `key`'s own row
 * (b.jg5 SRJ-1016): a row read `waiting`, `working`, `ask_user` or
 * `check_permission` (`isStuckLaunchEpisodeEndState`) ends the persona's open
 * episode silently, through the installed episodes, with one line when one
 * was open (`endStuckLaunchEpisode`). Nothing else ends it here: not
 * `pending`, `ended`, `missing`, no row (`ErrSpawnNotFound`), a failed read
 * or a kill. Never throws.
 */
function endStuckLaunchEpisodeOnRead(key: string, state: unknown): void {
  const episodes = stuckLaunchEpisodes
  if (episodes === undefined || !isStuckLaunchEpisodeEndState(state)) return
  endStuckLaunchEpisode(episodes, key, stuckLaunchEndRowLiveReason(state as string), (line) => console.error(line))
}

/** `readPersonaOwnRow` read the row: `latched` is true when this read latched the persona. */
export const OWN_ROW_READ_ROW = 'row'
/** `readPersonaOwnRow`'s `get` answered `ErrSpawnNotFound`: the row is absent. */
export const OWN_ROW_READ_ABSENT = 'absent'
/** `readPersonaOwnRow`'s `get` failed with any other error but UNUSABLE NAME, carried unchanged. */
export const OWN_ROW_READ_REFUSED = 'refused'
/** `readPersonaOwnRow`'s `get` answered UNUSABLE NAME: the persona latched (b.jg5 SRJ-512), and there is no row to act on. */
export const OWN_ROW_READ_LATCHED = 'latched'

/** What one read of a persona's own row answers (`readPersonaOwnRow`). */
export type OwnRowRead =
  | { readonly kind: typeof OWN_ROW_READ_ROW; readonly row: GetResult; readonly latched: boolean }
  | { readonly kind: typeof OWN_ROW_READ_ABSENT }
  | { readonly kind: typeof OWN_ROW_READ_REFUSED; readonly error: unknown }
  | { readonly kind: typeof OWN_ROW_READ_LATCHED }

/** Who reads, for `readPersonaOwnRow`'s log lines: `[slack] <site>: <what> for <ref>: …`. */
export interface OwnRowReadSite {
  readonly site: string
  readonly what: string
  /** The persona's reference; `persona=<key>` when absent. */
  readonly ref?: string
  /**
   * Set for a `get` made in a context that routes an UNUSABLE NAME answer
   * per SRJ-1002 instead of latching (b.jg5 SRJ-512): the start sweep's
   * post-run `get`s. Names the context in the routed line
   * (`readPersonaOwnRow`). The row-read rule still applies to a row read.
   */
  readonly unusableNameRoutedIn?: string
  /**
   * Asked once the `get` settles, before anything is acted on: an answer
   * other than true (or a throw) means the read's caller has stopped, so
   * nothing is acted on (`ownRowActGoes`; b.jg5 SRJ-714): the start sweep's
   * post-run `get`s once the server has begun shutting down. Absent: the
   * answer is acted on.
   */
  readonly actGoes?: () => boolean
}

/**
 * Whether `readPersonaOwnRow` acts on the answer of the `get` it made at
 * `at` (`OwnRowReadSite.actGoes`): true when `at` carries no check; when the
 * check answers other than true or throws, false, with one line:
 *
 *   [slack] <site>: <what> for <ref>: the get settled after its caller stopped — not acted on: no latch, clear or episode end (b.jg5 SRJ-714)
 *
 * Never throws.
 */
function ownRowActGoes(key: string, at: OwnRowReadSite): boolean {
  if (at.actGoes === undefined) return true
  let goes: boolean
  try {
    goes = at.actGoes() === true
  } catch {
    goes = false
  }
  if (!goes) {
    console.error(`${ownRowReadHead(key, at)}: the get settled after its caller stopped — not acted on: no latch, clear or episode end (b.jg5 SRJ-714)`)
  }
  return goes
}

/**
 * The one read of persona `key`'s own row (`cscb_<key>`) at SRJ-114's sites
 * (b.jg5 SRJ-114): one `get` through `withOutageDetection`, then the
 * row-read rule (`decideOwnRowRead`, `src/row-read-rules.ts`) through the
 * act step the start sweep's `list` rows share (`actOnOwnRowRead`). Answers:
 *
 *   - `row`, with `latched` true when this read latched the persona: the row
 *     is `key`'s own, `key` is configured (the installed
 *     `ConfiguredPersonaQuery`), and either
 *       - the row reads `pending` with no launch start (b.jg5 SRJ-513;
 *         absent, `null` or unparseable, `src/pending-row.ts`), whatever its
 *         `cwd`, `config_dir` or note: the persona latches with the case
 *         "launch start not recorded", the refused operation "none", the
 *         state `pending`, the session `slack_bot_<key>` and no description
 *         (`launchStartNotRecordedSetInput`), and the notice reaction posts
 *         SRJ-1020 once per episode; or
 *       - the row's `liveness_note` is exactly `provenance_conflict`: the
 *         persona latches with the case "conflicting labels", the refused
 *         operation "P's bring-up", the row's state as this `get` read it,
 *         the session `slack_bot_<key>` and no description (b.jg5 SRJ-501),
 *         and the notice reaction posts the CONFLICT notice once per episode
 *         (b.jg5 SRJ-1004).
 *     The latch's set observers stop its timers and post, and nothing else
 *     is posted here. The caller then calls nothing more for the persona
 *     (b.jg5 SRJ-502). With no latch installed, or a `set` that throws,
 *     nothing is latched and `latched` is still true, as at the CONFLICT row
 *     (`conflictAt`). Every other note, an unknown note, no note, a `pending`
 *     row with a launch start, or either on a row that is not a configured
 *     persona's own changes nothing (C14, C24; b.jg5 SRJ-408);
 *   - `absent` for `ErrSpawnNotFound` (recognised by name);
 *   - `latched` for an UNUSABLE NAME answer (b.jg5 SRJ-105, SRJ-512): the
 *     persona latches with the case "unusable recorded name", the refused
 *     operation "none" and the state unreadable, since this read, the
 *     path's last, read none (`latchOnUnusableName`; no further read), and
 *     the caller calls nothing more for it, as after a read that latched;
 *     with no latch installed nothing is latched and the answer is the same.
 *     Where the answer is routed per SRJ-1002 (`at.unusableNameRoutedIn`:
 *     the start sweep's post-run `get`s) nothing latches: the routed line
 *     is logged and the answer is `refused`, carrying the error;
 *   - `refused` for any other error, carried unchanged for the caller's
 *     refusal handling (`refusalAt`, b.jg5 SRJ-105) or its own row.
 *
 * A row read `ended` or `missing`, or `ErrSpawnNotFound`, also ends the
 * persona's kill-failure episode silently (`endKillFailureEpisodeOnRead`;
 * b.jg5 SRJ-704, SRJ-1016), and ends an old-life hold on `cscb_<key>`, with
 * its one end line; a row read in any other state keeps the hold, and its
 * `cwd` becomes the held directory (`noteOldLifeRowRead`; b.jg5 SRJ-809).
 * While the persona holds a "this launch's row" record (b.jg5 SRJ-407), the
 * read applies SRJ-310's third end rule to it (`checkThisLaunchRowOnRead`).
 * A row read `waiting`, `working`, `ask_user` or `check_permission` ends the
 * persona's stuck-launch episode silently (`endStuckLaunchEpisodeOnRead`;
 * b.jg5 SRJ-1016); `pending`, `ended`, `missing`, no row and a failed read
 * do not.
 *
 * When `at.actGoes` answers that the caller has stopped once the `get`
 * settles (`ownRowActGoes`; b.jg5 SRJ-714), nothing below is acted on: no
 * latch, no retired-entry clear, no episode or hold end and no routed line; the read
 * answers `row` with `latched` false, `absent`, or `refused` carrying the
 * error, after that check's one line.
 *
 * A row that is the key's own, read `waiting`, `working`, `ask_user` or
 * `check_permission` while the installed retired-key store has the key
 * recorded with its mark set, clears the key's entry, durably, whether or
 * not the key is configured and beside any latch the same read decides
 * (`clearRetiredEntryOnRead`; b.jg5 SRJ-807). A `pending` row never clears.
 * The answer is the same whatever the clear did; a clear whose write fails
 * leaves the entry for the next qualifying read. With no store installed
 * nothing is cleared.
 *
 * Log lines (no line carries a token: the note and the instance id are
 * agent-director's text, rendered by `renderLogMessageText`, and an
 * UNUSABLE NAME answer by the redacting describer):
 *
 *   [slack] <site>: <what> for <ref>: its row reads pending with no launch start (state=pending) — <outcome>; nothing more is called for it (b.jg5 SRJ-114, SRJ-513)
 *   [slack] <site>: <what> for <ref>: its row carries the liveness note provenance_conflict (state=<state>) — <outcome>; nothing more is called for it (b.jg5 SRJ-114, SRJ-501)
 *   [slack] <site>: <what> for <ref>: <failure> — UNUSABLE NAME: <outcome>; nothing more is called for it (b.jg5 SRJ-105, SRJ-512)
 *   [slack] <site>: <what> for <ref>: <failure> — UNUSABLE NAME met in <context>: routed to the server log; nothing latches (b.jg5 SRJ-512, SRJ-1002)
 *   [slack] <site>: <what> for <ref>: its row carries the liveness note provenance_conflict, but <why> — the note is not applied (b.jg5 SRJ-114)
 *   [slack] <site>: <what> for <ref>: its row carries the liveness note "<note>", which latches no one — going on (b.jg5 SRJ-114)
 *
 * where `<outcome>` is `the persona latched`, `the persona relatched`, `the
 * persona was already latched with this case`, `no latch is installed, so
 * nothing is latched` or `latching the persona failed: <error>`, and `<why>`
 * is `no configured-persona query is installed`, `the configured-persona
 * query failed: <error>`, `persona=<key> is not a persona of the applied
 * configuration` or `the row is not the persona's own
 * (claude_instance_id="<id>")`. A row with no note logs nothing. The
 * "latches no one" line is logged once per note for a persona and again only
 * when the note on its row changes (`nonLatchingNoteLogged`). Never throws.
 */
export async function readPersonaOwnRow(key: string, at: OwnRowReadSite): Promise<OwnRowRead> {
  let row: GetResult
  try {
    row = await withOutageDetection(key, undefined, 'get', (client) =>
      client.get({ claude_instance_id: personaInstanceId(key) }),
    )
  } catch (err) {
    // b.jg5 SRJ-714: an answer that settles after the caller stopped is not acted on.
    if (!ownRowActGoes(key, at)) {
      return hasAdErrorName(err, ERR_SPAWN_NOT_FOUND_NAME) ? { kind: OWN_ROW_READ_ABSENT } : { kind: OWN_ROW_READ_REFUSED, error: err }
    }
    if (hasAdErrorName(err, ERR_SPAWN_NOT_FOUND_NAME)) {
      // b.jg5 SRJ-704, SRJ-1016: the row is gone; the kill-failure episode ends.
      endKillFailureEpisodeOnRead(key, { thrown: err })
      // b.jg5 SRJ-809: no row ends an old-life hold on it.
      noteOldLifeRowRead(personaInstanceId(key), { kind: OLD_LIFE_ROW_READ_NO_ROW }, oldLifeReadName(at))
      // b.jg5 SRJ-310 rule 3: no row is no longer this launch's row.
      checkThisLaunchRowOnRead(key, THIS_LAUNCH_ROW_READ_ABSENT, false, at)
      return { kind: OWN_ROW_READ_ABSENT }
    }
    if (at.unusableNameRoutedIn !== undefined) {
      // b.jg5 SRJ-512, SRJ-1002: routed, so nothing latches; carried as a failed read.
      if (isUnusableNameError(err)) logUnusableNameRouted(key, at, at.unusableNameRoutedIn, err)
      return { kind: OWN_ROW_READ_REFUSED, error: err }
    }
    if (latchOnUnusableNameRead(key, err, at)) return { kind: OWN_ROW_READ_LATCHED }
    return { kind: OWN_ROW_READ_REFUSED, error: err }
  }
  // b.jg5 SRJ-714: a row that settles after the caller stopped is not acted on.
  if (!ownRowActGoes(key, at)) return { kind: OWN_ROW_READ_ROW, row, latched: false }
  // b.jg5 SRJ-704, SRJ-1016: a row read `ended` or `missing` ends the kill-failure episode.
  endKillFailureEpisodeOnRead(key, { state: row.state })
  // b.jg5 SRJ-1016: a row read live out of `pending` ends the stuck-launch episode.
  endStuckLaunchEpisodeOnRead(key, row.state)
  // b.jg5 SRJ-809: a row read `ended` or `missing` ends an old-life hold on
  // it, and a live one's `cwd` becomes the held directory.
  noteOldLifeRowRead(personaInstanceId(key), { kind: OLD_LIFE_ROW_READ_STATE, state: row.state, cwd: row.cwd }, oldLifeReadName(at))
  const latched = actOnOwnRowRead(key, row, at, true) !== undefined
  // b.jg5 SRJ-310 rule 3, SRJ-407: this launch's row read live other than `pending` ends the condition.
  checkThisLaunchRowOnRead(key, { state: row.state, launchStartedAt: (row as Phase1GetResult).launch_started_at }, latched, at)
  return { kind: OWN_ROW_READ_ROW, row, latched }
}

/**
 * The shared own-row read's act step (b.jg5 SRJ-114, SRJ-116, SRJ-513,
 * SRJ-807) over a row of persona `key` already read: a `get` row
 * (`readPersonaOwnRow`) or a `list` row (the start sweep's latch pass,
 * `latchFromListedRows`). One code path for both: the same latch record
 * (case, refused operation, recorded state as the row carries it, quoted
 * session `slack_bot_<key>`, no description line), the same notice per latch
 * episode and the same clear, with the lines `readPersonaOwnRow` documents,
 * headed by `at` (`applyOwnRowRules`). `clearRetiredEntry` false leaves the
 * retired-key entry clear out of this read (b.jg5 SRJ-807): the start sweep's
 * `list` row of a key the same sweep records as retired, whose recording
 * clears its mark instead (SRJ-714). A row that is not `key`'s own, or the
 * own row of a key the configured-persona query does not count, latches no
 * one. Makes no agent-director call. Answers the latch decision this read
 * acted on when it latched the persona (or would have, with no latch
 * installed or a `set` that threw), else undefined. Never throws.
 */
function actOnOwnRowRead(key: string, row: RowReadRow, at: OwnRowReadSite, clearRetiredEntry: boolean): RowReadLatchDecision | undefined {
  try {
    return applyOwnRowRules(key, row, at, clearRetiredEntry)
  } catch (err) {
    // Not reached (every step below is guarded); a throw reads the row with no latch.
    console.error(`${ownRowReadHead(key, at)}: applying the note rule failed: ${describeThrownValue(err)} (b.jg5 SRJ-114)`)
    return undefined
  }
}

/**
 * The one line for an UNUSABLE NAME answer to a `get` made where it is
 * routed per SRJ-1002 (`OwnRowReadSite.unusableNameRoutedIn`, `context`):
 * a server-log line, nothing latched or posted (b.jg5 SRJ-512, SRJ-1002).
 * The answer through the redacting describer.
 *
 *   [slack] <site>: <what> for <ref>: <failure> — UNUSABLE NAME met in <context>: routed to the server log; nothing latches (b.jg5 SRJ-512, SRJ-1002)
 */
function logUnusableNameRouted(key: string, at: OwnRowReadSite, context: string, err: unknown): void {
  console.error(
    `${ownRowReadHead(key, at)}: ${describeAgentDirectorFailure(err)} — UNUSABLE NAME met in ${context}: routed to the server log; nothing latches (b.jg5 SRJ-512, SRJ-1002)`,
  )
}

/** `[slack] <site>: <what> for <ref>`. */
function ownRowReadHead(key: string, at: OwnRowReadSite): string {
  return `[slack] ${at.site}: ${at.what} for ${at.ref ?? keyRef(key)}`
}

/**
 * The last non-latching liveness note logged for each persona's own row
 * (`applyOwnRowRules`): the "latches no one" line is logged once per note and
 * again only when the note on the persona's row changes. A read of the row
 * with no note or the latching note forgets it, so the note's return is
 * logged again. Forgotten with the persona's not-connected episode
 * (`forgetNotConnectedEpisode`, run when it is torn down) and by
 * `_resetNotConnectedEpisodes`.
 */
const nonLatchingNoteLogged = new Map<string, string>()

/**
 * The row-read rule on `row`, read for persona `key` (b.jg5 SRJ-114,
 * SRJ-116, SRJ-513): asks `decideOwnRowRead` for every row read; on a clear
 * decision (only when `clear` is true) first clears the persona's
 * retired-key entry through the store (`clearRetiredEntryOnRead`, b.jg5
 * SRJ-807), before any latch handling, changing nothing the read answers;
 * then latches the persona on a latch decision (`latchFromRowRead`) with the
 * line naming why (`rowReadLatchReason`), and otherwise logs the read's note
 * line, if any (a non-latching note's line once per note,
 * `nonLatchingNoteLogged`). Answers the latch decision when the read latched
 * the persona (or would have, with no latch installed or a `set` that
 * threw), else undefined. Never throws.
 */
function applyOwnRowRules(key: string, row: RowReadRow, at: OwnRowReadSite, clear: boolean): RowReadLatchDecision | undefined {
  const configured = configuredReadingOf(key)
  const decision = decideOwnRowRead({
    key,
    row,
    configured: configured.configured,
    retiredMarked: clear ? retiredMarkOf(key) : false,
  })
  // b.jg5 SRJ-807: the clear applies beside any latch this read decides, and changes nothing the read answers.
  if (decision.clearRetiredEntry !== undefined) clearRetiredEntryOnRead(key, decision.clearRetiredEntry, at)
  const note: unknown = row.liveness_note
  const hasNote = note !== undefined && note !== null && note !== ''
  if (!hasNote || isLatchingLivenessNote(note)) nonLatchingNoteLogged.delete(key)
  if (decision.latch !== undefined) {
    const outcome = latchFromRowRead(key, decision.latch)
    console.error(
      `${ownRowReadHead(key, at)}: ${rowReadLatchReason(decision.latch)} (state=${describeLatchRowState(decision.latch.rowState)}) — ${outcome}; nothing more is called for it (${rowReadLatchSrjs(decision.latch)})`,
    )
    return decision.latch
  }
  if (!hasNote) return undefined
  if (!isLatchingLivenessNote(note)) {
    const noteText = String(note)
    if (nonLatchingNoteLogged.get(key) !== noteText) {
      nonLatchingNoteLogged.set(key, noteText)
      console.error(
        `${ownRowReadHead(key, at)}: its row carries the liveness note ${JSON.stringify(renderLogMessageText(note))}, which latches no one — going on (b.jg5 SRJ-114)`,
      )
    }
    return undefined
  }
  const why = !isPersonaOwnRow(row, key)
    ? `the row is not the persona's own (claude_instance_id=${JSON.stringify(renderLogMessageText(row.claude_instance_id))})`
    : configured.why
  console.error(
    `${ownRowReadHead(key, at)}: its row carries the liveness note ${LATCHING_LIVENESS_NOTE}, but ${why} — the note is not applied (b.jg5 SRJ-114)`,
  )
  return undefined
}

/** Why a row read latched, for the shared `get` read's latch line. */
function rowReadLatchReason(latch: RowReadLatchDecision): string {
  return latch.latchCase === LATCH_CASE_LAUNCH_START_NOT_RECORDED
    ? 'its row reads pending with no launch start'
    : `its row carries the liveness note ${LATCHING_LIVENESS_NOTE}`
}

/** The requirements the shared `get` read's latch line names. */
function rowReadLatchSrjs(latch: RowReadLatchDecision): string {
  return latch.latchCase === LATCH_CASE_LAUNCH_START_NOT_RECORDED ? 'b.jg5 SRJ-114, SRJ-513' : 'b.jg5 SRJ-114, SRJ-501'
}

/**
 * Whether persona `key` counts as configured for the row-read rule, and, when
 * it does not, why (for the not-applied line). No query installed, or one
 * that throws, counts as not configured. Never throws.
 */
function configuredReadingOf(key: string): { configured: boolean; why: string } {
  const query = configuredPersonaQuery
  if (query === undefined) return { configured: false, why: 'no configured-persona query is installed' }
  try {
    return query(key) === true
      ? { configured: true, why: '' }
      : { configured: false, why: `${keyRef(key)} is not a persona of the applied configuration` }
  } catch (err) {
    return { configured: false, why: `the configured-persona query failed: ${describeThrownValue(err)}` }
  }
}

/** The latch line's outcome text for each set outcome. */
const LATCH_SET_OUTCOME_TEXT: Readonly<Record<ConflictLatchSetOutcome, string>> = Object.freeze({
  [CONFLICT_LATCH_SET_LATCHED]: 'the persona latched',
  [CONFLICT_LATCH_SET_RELATCHED]: 'the persona relatched',
  [CONFLICT_LATCH_SET_SAME_CASE]: 'the persona was already latched with this case',
})

/**
 * Latch persona `key` from a latch decision over one of its own row reads
 * (b.jg5 SRJ-501): the installed latch's `set`. For "launch start not
 * recorded" (b.jg5 SRJ-513) its input is the latch's own
 * (`launchStartNotRecordedSetInput`, with the decision's row state); for a
 * `provenance_conflict` note it is `decision`'s case, refused operation and
 * row state. Either way the session is `slack_bot_<key>` and there is no
 * description, so a CONFLICT notice has no "agent-director said" line
 * (b.jg5 SRJ-1004). A persona latched with another case relatches with this
 * one, and the notice reaction posts its one new post. Answers the latch
 * line's outcome text. Never throws.
 */
function latchFromRowRead(key: string, decision: RowReadLatchDecision): string {
  const latch = conflictLatch
  if (latch === undefined) return LATCH_OUTCOME_NO_LATCH
  try {
    const outcome = latch.set(
      key,
      decision.latchCase === LATCH_CASE_LAUNCH_START_NOT_RECORDED
        ? launchStartNotRecordedSetInput(key, decision.rowState)
        : {
            latchCase: decision.latchCase,
            refusedOperation: decision.refusedOperation,
            rowState: decision.rowState,
            sessionName: personaTmuxSessionName(key),
          },
    )
    return LATCH_SET_OUTCOME_TEXT[outcome] ?? 'the persona latched'
  } catch (err) {
    return `latching the persona failed: ${describeThrownValue(err)}`
  }
}

/**
 * An own-row read's (`get` or `status`) thrown `err` for persona `key`
 * (b.jg5 SRJ-105, SRJ-512): when it is UNUSABLE NAME, latch the persona
 * (`latchOnUnusableName`) with the state unreadable, since the read that met
 * it read no state and no further read is made, log one line, and answer
 * true; false for any other value, with nothing done. Never throws.
 *
 *   [slack] <site>: <what> for <ref>: <failure> — UNUSABLE NAME: <outcome>; nothing more is called for it (b.jg5 SRJ-105, SRJ-512)
 */
function latchOnUnusableNameRead(key: string, err: unknown, at: OwnRowReadSite): boolean {
  if (!isUnusableNameError(err)) return false
  logUnusableNameRead(key, at, err, latchOnUnusableName(key, err, LATCH_ROW_STATE_UNREADABLE))
  return true
}

/** `latchOnUnusableNameRead`'s one line, with `outcome` (what became of the latch); the answer through the redacting describer. */
function logUnusableNameRead(key: string, at: OwnRowReadSite, err: unknown, outcome: string): void {
  console.error(
    `${ownRowReadHead(key, at)}: ${describeAgentDirectorFailure(err)} — UNUSABLE NAME: ${outcome}; nothing more is called for it (b.jg5 SRJ-105, SRJ-512)`,
  )
}

// ---------------------------------------------------------------------------
// The own-row `status` step and the shared own-row `status` read (b.jg5 SRJ-115)
// ---------------------------------------------------------------------------

/**
 * One `status` answer from persona P's own row, for the own-row `status`
 * step: the result it returned, or the value it threw. The result is the
 * one the client returned, passed whole: its `launch_started_at` (raw,
 * `src/ad-phase1-types.ts`) is what the launch-start decision reads, so a
 * caller that rebuilt the result from its `state` alone would make a
 * `pending` row with a launch start read as one with none.
 */
export type OwnRowStatusAnswer =
  | { readonly result: Phase1StatusResult }
  | { readonly thrown: unknown }

/**
 * The own-row `status` step (b.jg5 SRJ-105, SRJ-115, SRJ-512): the own-row
 * rules applied to one `status` answer from persona `key`'s own row
 * (`cscb_<key>`), whoever made the call (the shared own-row `status` read,
 * or an adapter's own call in `src/server.ts`). Answers whether it latched
 * the persona; never throws.
 *
 *   - A returned result: the row-read rule (`decideOwnRowRead`,
 *     `src/row-read-rules.ts`) over the result, as the persona's own row,
 *     with the installed configured-persona query (with none installed no
 *     decision latches). A latch decision latches the persona with the
 *     decision's case, refused operation and row state (`latchFromRowRead`)
 *     and logs one line. A configured persona's own row that reads
 *     `pending` with no launch start latches it with "launch start not
 *     recorded" and the state `pending` (b.jg5 SRJ-513; SRJ-1020 is posted
 *     once per episode), relatching a persona latched with another case. A
 *     `status` result carries no liveness note, so the note decision never
 *     latches here; every decision the rule gains applies here unchanged.
 *   - A thrown value: an UNUSABLE NAME answer (`isUnusableNameError`, by
 *     name) latches the persona with the state unreadable
 *     (`latchOnUnusableNameRead`: one line, no further read). Any other
 *     value, `ErrSpawnNotFound` included, is left to the caller.
 *   - A returned result reading `waiting`, `working`, `ask_user` or
 *     `check_permission` while the installed retired-key store has the key
 *     recorded with its mark set clears the key's entry, durably, whether or
 *     not the key is configured and beside any latch the same result decides
 *     (`clearRetiredEntryOnRead`; b.jg5 SRJ-807). A `pending` result never
 *     clears. What the step answers is the same whatever the clear did; a
 *     clear whose write fails leaves the entry for the next qualifying read.
 *     The liveness and reconnect adapters get the clear through this step.
 *   - Either way, first: a result reading `ended` or `missing`, or an
 *     `ErrSpawnNotFound` answer (the row is gone), ends the persona's
 *     kill-failure episode silently (`endKillFailureEpisodeOnRead`; b.jg5
 *     SRJ-704, SRJ-1016), and ends an old-life hold on `cscb_<key>`, with
 *     its one end line (`noteOldLifeRowRead`; b.jg5 SRJ-809); any other
 *     state keeps it. So every own-row `status` the server makes ends the
 *     hold this way: the shared own-row `status` read, a persona kill
 *     retry's between-try read, and the liveness and reconnect adapters.
 *   - A returned result reading `waiting`, `working`, `ask_user` or
 *     `check_permission` ends the persona's stuck-launch episode silently
 *     (`endStuckLaunchEpisodeOnRead`; b.jg5 SRJ-1016), whoever made the
 *     call, the liveness and reconnect adapters included; `pending`,
 *     `ended`, `missing`, `ErrSpawnNotFound` and a failed read do not.
 *   - While the persona holds a "this launch's row" record (b.jg5 SRJ-407),
 *     the answer applies SRJ-310's third end rule to it
 *     (`checkThisLaunchRowOnRead`), so every own-row `status` the server
 *     makes, an approver's lap and a health tick's included, can end the
 *     condition by it.
 *
 * With no latch installed a latching answer still answers true, with
 * nothing latched, as at the CONFLICT row. Log lines:
 *
 *   [slack] <site>: <what> for <ref>: its row read latches the persona (case=<case>, state=<state>) — <outcome>; nothing more is called for it (b.jg5 SRJ-115, SRJ-501)
 *   [slack] <site>: <what> for <ref>: <failure> — UNUSABLE NAME: <outcome>; nothing more is called for it (b.jg5 SRJ-105, SRJ-512)
 */
export function applyOwnRowStatusStep(key: string, answer: OwnRowStatusAnswer, at: OwnRowReadSite): boolean {
  try {
    // b.jg5 SRJ-704, SRJ-1016: a row read `ended` or `missing`, or gone, ends
    // the persona's kill-failure episode, whoever made the call.
    endKillFailureEpisodeOnRead(key, 'thrown' in answer ? { thrown: answer.thrown } : { state: answer.result.state })
    // b.jg5 SRJ-1016: a row read live out of `pending` ends the stuck-launch
    // episode, whoever made the call.
    if (!('thrown' in answer)) endStuckLaunchEpisodeOnRead(key, answer.result.state)
    // b.jg5 SRJ-809: a row read `ended` or `missing`, or gone, ends an
    // old-life hold on it, whoever made the call.
    noteOldLifeStatusAnswer(key, answer, at)
    if ('thrown' in answer) {
      // b.jg5 SRJ-310 rule 3: no row is no longer this launch's row.
      if (hasAdErrorName(answer.thrown, ERR_SPAWN_NOT_FOUND_NAME)) checkThisLaunchRowOnRead(key, THIS_LAUNCH_ROW_READ_ABSENT, false, at)
      return latchOnUnusableNameRead(key, answer.thrown, at)
    }
    const row = { ...answer.result, claude_instance_id: personaInstanceId(key) }
    const decision = decideOwnRowRead({
      key,
      row,
      configured: configuredReadingOf(key).configured,
      retiredMarked: retiredMarkOf(key),
    })
    // b.jg5 SRJ-807: the clear applies beside any latch this read decides, and changes nothing the step answers.
    if (decision.clearRetiredEntry !== undefined) clearRetiredEntryOnRead(key, decision.clearRetiredEntry, at)
    // b.jg5 SRJ-310 rule 3, SRJ-407: this launch's row read live other than `pending` ends the condition.
    checkThisLaunchRowOnRead(
      key,
      { state: answer.result.state, launchStartedAt: answer.result.launch_started_at },
      decision.latch !== undefined,
      at,
    )
    if (decision.latch === undefined) return false
    const outcome = latchFromRowRead(key, decision.latch)
    console.error(
      `${ownRowReadHead(key, at)}: its row read latches the persona (case=${decision.latch.latchCase}, state=${describeLatchRowState(decision.latch.rowState)}) — ${outcome}; nothing more is called for it (b.jg5 SRJ-115, SRJ-501)`,
    )
    return true
  } catch (err) {
    // Not reached (every step above is guarded); a throw latches nothing.
    console.error(`${ownRowReadHead(key, at)}: applying the own-row rules failed: ${describeThrownValue(err)} (b.jg5 SRJ-115)`)
    return false
  }
}

/** `readPersonaOwnRowStatus` read a state. */
export const OWN_ROW_STATUS_STATE = 'state'
/** `readPersonaOwnRowStatus`'s `status` answered `ErrSpawnNotFound`: the row is absent. */
export const OWN_ROW_STATUS_ABSENT = 'absent'
/** `readPersonaOwnRowStatus`'s `status` failed with any other error that latched nothing, carried unchanged. */
export const OWN_ROW_STATUS_REFUSED = 'refused'
/** `readPersonaOwnRowStatus`'s answer latched the persona (`applyOwnRowStatusStep`). */
export const OWN_ROW_STATUS_LATCHED = 'latched'

/** What one shared own-row `status` read answers (`readPersonaOwnRowStatus`). */
export type OwnRowStatusRead =
  | { readonly kind: typeof OWN_ROW_STATUS_STATE; readonly state: string; readonly launchStartedAt?: string }
  | { readonly kind: typeof OWN_ROW_STATUS_ABSENT }
  | { readonly kind: typeof OWN_ROW_STATUS_REFUSED; readonly error: unknown }
  /** `rowState`: what the read gave, as a latch records it (unreadable for a thrown answer). */
  | { readonly kind: typeof OWN_ROW_STATUS_LATCHED; readonly rowState: LatchRowState }

/**
 * The shared own-row `status` read (b.jg5 SRJ-115): one `status` of persona
 * `key`'s own row (`cscb_<key>`) through `withOutageDetection` (so a
 * failure raises its outage flags and, inside a launch or recovery attempt,
 * arms the persona's retry timer), then the own-row `status` step
 * (`applyOwnRowStatusStep`). Answers:
 *
 *   - `latched` when the step latched the persona (an UNUSABLE NAME answer,
 *     recorded unreadable, or a latch decision of the row-read rule: the
 *     persona's own row reading `pending` with no launch start, recorded
 *     `pending`, b.jg5 SRJ-513), with the state as a latch records it; the
 *     caller calls nothing more for the persona (b.jg5 SRJ-502);
 *   - `state`, with the raw launch start a `pending` result shows
 *     (`pendingLaunchStartOf`; absent when not shown);
 *   - `absent` for `ErrSpawnNotFound` (recognised by name);
 *   - `refused` for any other error, carried unchanged for the site's own
 *     handling (`refusalAt`, b.jg5 SRJ-105, or its own rule).
 *
 * The session manager's own-row `status` sites read through it: the launch
 * wait's poll and timeout reads, the prompt rows' re-read after a sweep
 * (`reconcileAndReadRowState`), the retry timer's row read
 * (`readPersonaRowState`), the latch-time read (`latchTimeRowState`) and
 * the dialog approver's lap (`approvePreSessionDialogs`). Never throws.
 */
export async function readPersonaOwnRowStatus(key: string, at: OwnRowReadSite): Promise<OwnRowStatusRead> {
  // The result whole, so the step reads its launch start (b.jg5 SRJ-513).
  let result: Phase1StatusResult
  try {
    result = await withOutageDetection(key, undefined, 'status', (client) =>
      client.status({ claude_instance_id: personaInstanceId(key) }),
    )
  } catch (err) {
    if (applyOwnRowStatusStep(key, { thrown: err }, at)) return { kind: OWN_ROW_STATUS_LATCHED, rowState: LATCH_ROW_STATE_UNREADABLE }
    return hasAdErrorName(err, ERR_SPAWN_NOT_FOUND_NAME)
      ? { kind: OWN_ROW_STATUS_ABSENT }
      : { kind: OWN_ROW_STATUS_REFUSED, error: err }
  }
  if (applyOwnRowStatusStep(key, { result }, at)) {
    return { kind: OWN_ROW_STATUS_LATCHED, rowState: latchRowStateRead(result.state) }
  }
  const launchStartedAt = pendingLaunchStartOf(result)
  return launchStartedAt === undefined
    ? { kind: OWN_ROW_STATUS_STATE, state: result.state }
    : { kind: OWN_ROW_STATUS_STATE, state: result.state, launchStartedAt }
}

// ---------------------------------------------------------------------------
// The shared read-pane of a persona's own row (b.jg5 SRJ-117)
// ---------------------------------------------------------------------------

/** What `readPersonaOwnPane` is asked to read, and for whom. */
export interface PersonaPaneReadRequest {
  /** Trailing pane lines to read (`FULL_PANE_READ_LINES` at a full read). */
  readonly nLines: number
  /**
   * The row state the calling path last read (b.jg5 SRJ-501), which a latch
   * set on the read's CONFLICT or UNUSABLE NAME answer records.
   */
  readonly lastRead: LatchRowState
  /** A short site label, the head of the reader's latch line. */
  readonly site: string
  /**
   * Read a `pending` row's pane (`allow_pending: true` on the call, b.jg5
   * SRJ-117, SRJ-402). Only the pending-row rule's lap sets it
   * (`readPendingRowLapPane`); every other site leaves it unset, and its call
   * carries no `allow_pending`.
   */
  readonly allowPending?: boolean
}

/**
 * What `readPersonaOwnPane` answers: a pane-read outcome other than CONFLICT
 * or UNUSABLE NAME, which the reader always answers as `PANE_READ_LATCHED`
 * with the failure as its `cause`.
 */
export type OwnPaneReadOutcome = Exclude<PaneReadOutcome, PaneReadConflict | PaneReadUnusableName>

/**
 * The shared read-pane of persona `key`'s own row (`cscb_<key>`, b.jg5
 * SRJ-117): one `readPane` through `withOutageDetection`, declaring the
 * `read-pane` verb (tmux-touching: inside an attempt an UNAVAILABLE starts
 * `tmux-unresponsive` and a pane or GONE ends it, and ENVIRONMENT and CONFIG
 * raise their outages, all in the wrapper), with `claude_instance_id` and
 * `n_lines` only, and `allow_pending: true` when `request.allowPending` is
 * set (the pending-row rule's lap, b.jg5 SRJ-410). Answers the read's
 * outcome (`src/pane-read.ts`):
 *
 *   - a persona already latched (`personaLatchedNow`, b.jg5 SRJ-502) gets no
 *     call and answers latched with no cause;
 *   - a CONFLICT latches the persona through the latch's CONFLICT entry
 *     (`setFromConflict`) with the refused operation "P's next check or
 *     recovery" and `request.lastRead` (b.jg5 SRJ-501), and answers latched
 *     with the CONFLICT as its cause;
 *   - an UNUSABLE NAME latches it through the unusable-name entry
 *     (`latchOnUnusableName`: refused operation "none", `request.lastRead`,
 *     b.jg5 SRJ-512), and answers latched with it as its cause;
 *   - an `ErrInvalidFlags`, to which `read-pane` gives no meaning, gets
 *     exactly one immediate version re-check (`classifyWithInvalidFlagsRecheck`,
 *     b.jg5 SRJ-104, SRJ-204) and then answers UNCLASSIFIED
 *     (`paneReadInvalidFlagsFailure`), carrying the stop mark
 *     `stopping: true` when the re-check decided that the server stops
 *     (b.jg5 SRJ-205; the caller then types nothing and calls nothing more
 *     for the persona);
 *   - every other outcome (a pane, GONE, absent, CONFIG, ENVIRONMENT,
 *     UNAVAILABLE, UNCLASSIFIED) is returned unchanged for the caller to
 *     handle.
 *
 * A pane it answers may be a single leftover's: with no session of the
 * row's current launch there and exactly one leftover of the persona,
 * agent-director answers the leftover's pane (b.jg5 SRJ-117, SRJ-613). The
 * reader treats it as no proof that the worker's own session is there, and
 * no caller acts on it alone: a pane leads at most to a deferral, no action,
 * a positive-idle fold, the reconnect, or the pending-row lap's Enter. The
 * backstop is the `send-keys` that follows: the reconnect's
 * (`reconnectMcpWithCause`), which on a live row that is not `pending`
 * answers CONFLICT "not this launch's session": CSCB then latches P (b.jg5
 * SRJ-501) with nothing typed and never retries the refused `send-keys`
 * (SRJ-118, SRJ-505); and the lap's Enter (`sendPendingRowLapEnter`), which
 * on a `pending` row whose session is not this launch's answers
 * `ErrSpawnNotInteractive` with nothing typed, after which no further lap is
 * made on the row's launch (b.jg5 SRJ-410, SRJ-613).
 *
 * With no latch installed a CONFLICT or UNUSABLE NAME still answers latched
 * with nothing latched, as the latch's entries do elsewhere (`conflictAt`,
 * `unusableNameAt`). The reader posts nothing and counts nothing, and makes
 * no further call after a latch. One line per latch it sets (no token: the
 * answer through the redacting describer):
 *
 *   [slack] <site>: pane read refused for persona=<key>: <failure> — CONFLICT: <outcome>; nothing is typed and nothing more is called for it (b.jg5 SRJ-105, SRJ-501)
 *   [slack] <site>: pane read refused for persona=<key>: <failure> — UNUSABLE NAME: <outcome>; nothing is typed and nothing more is called for it (b.jg5 SRJ-105, SRJ-512)
 *
 * Never throws.
 */
export async function readPersonaOwnPane(key: string, request: PersonaPaneReadRequest): Promise<OwnPaneReadOutcome> {
  if (personaLatchedNow(key)) return PANE_READ_NOT_READ_LATCHED
  let failure: PaneReadFailure
  try {
    const claude_instance_id = personaInstanceId(key)
    const result = await withOutageDetection(key, undefined, 'read-pane', (client) =>
      client.readPane(
        request.allowPending === true
          ? { claude_instance_id, n_lines: request.nLines, allow_pending: true }
          : { claude_instance_id, n_lines: request.nLines },
      ),
    )
    return { kind: PANE_READ_PANE, pane: result.pane }
  } catch (err) {
    failure = isInvalidFlagsError(err) ? await paneReadInvalidFlagsFailure(key, request, err) : paneReadFailureOf(err)
  }
  if (failure.kind === PANE_READ_CONFLICT) {
    logPaneReadLatch(key, request, failure, latchOnConflict(key, failure.error, REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY, request.lastRead))
    return { kind: PANE_READ_LATCHED, cause: failure }
  }
  if (failure.kind === PANE_READ_UNUSABLE_NAME) {
    logPaneReadLatch(key, request, failure, latchOnUnusableName(key, failure.error, request.lastRead))
    return { kind: PANE_READ_LATCHED, cause: failure }
  }
  return failure
}

/**
 * `readPersonaOwnPane`'s answer for an `ErrInvalidFlags` (b.jg5 SRJ-104:
 * `read-pane` gives it no meaning): exactly one immediate version re-check
 * through the `ErrInvalidFlags` step (`classifyWithInvalidFlagsRecheck`,
 * b.jg5 SRJ-204; a stop it decides ends the process as the re-check
 * defines), then the UNCLASSIFIED outcome with the step's class and the
 * error's redacted description. When the re-check decided the stop, the
 * outcome carries the stop mark `stopping: true` (b.jg5 SRJ-205) and nothing
 * is reported. Otherwise the outcome takes SRJ-105's UNCLASSIFIED row through
 * the outage state's site entry (`reportUnclassifiedAtSite`: inside a launch
 * or recovery attempt for the persona it arms the retry timer with the
 * UNCLASSIFIED cause and reports the persona's unclassified-error episode;
 * outside one it does nothing), since the wrapper's own report took the
 * value as STATE and reported nothing. One line, built from the
 * classification's rendered fields:
 *
 *   [slack] <site>: pane read for persona=<key> answered <classification> — UNCLASSIFIED after one immediate agent-director version re-check: <answer> (b.jg5 SRJ-104, SRJ-204)
 *
 * Never throws.
 */
async function paneReadInvalidFlagsFailure(
  key: string,
  request: PersonaPaneReadRequest,
  err: InvalidFlagsError,
): Promise<PaneReadUnclassified> {
  const step = await classifyWithInvalidFlagsRecheck(err)
  const stopping = step.recheck.kind === RECHECK_OUTCOME_STOP
  if (!stopping) reportUnclassifiedAtSite(key, err, 'read-pane', step.classification)
  console.error(
    `[slack] ${request.site}: pane read for ${keyRef(key)} answered ${describeAdErrorClassification(step.classification)} — UNCLASSIFIED after one immediate agent-director version re-check: ${step.recheck.kind} (b.jg5 SRJ-104, SRJ-204)`,
  )
  const outcome: PaneReadUnclassified = {
    kind: PANE_READ_UNCLASSIFIED,
    errorClass: step.classification.errorClass,
    description: describeAgentDirectorFailure(err),
  }
  return stopping ? { ...outcome, stopping: true } : outcome
}

/** `readPersonaOwnPane`'s one line for a latch it set (`outcome`: what became of the latch). */
function logPaneReadLatch(
  key: string,
  request: PersonaPaneReadRequest,
  cause: PaneReadConflict | PaneReadUnusableName,
  outcome: string,
): void {
  const [label, srj] = cause.kind === PANE_READ_CONFLICT ? ['CONFLICT', 'SRJ-501'] : ['UNUSABLE NAME', 'SRJ-512']
  console.error(
    `[slack] ${request.site}: pane read refused for ${keyRef(key)}: ${cause.description} — ${label}: ${outcome}; ` +
      `nothing is typed and nothing more is called for it (b.jg5 SRJ-105, ${srj})`,
  )
}

// ---------------------------------------------------------------------------
// The pending-row rule's lap: its read-pane and its Enter (b.jg5 SRJ-410)
// ---------------------------------------------------------------------------

/** The site label of the pending-row rule's own calls and lines. */
export const PENDING_ROW_RULE_SITE = 'pendingRowRule'

/** Who reads, in the own-row lines of the pending-row rule's `get` (the persona's ref is added; b.jg5 SRJ-114, SRJ-410). */
export const PENDING_ROW_RULE_GET_SITE: OwnRowReadSite = Object.freeze({ site: PENDING_ROW_RULE_SITE, what: 'pending-row rule get' })

/**
 * Whether `pane` shows a startup dialog the dialog approver recognises: one
 * of its needles (`PRE_SESSION_DIALOG_NEEDLES`: the folder-trust and
 * dev-channels option labels; b.jg5 SRJ-402). The approver's laps and the
 * pending-row rule's lap (b.jg5 SRJ-410) both read a pane through it. A pane
 * may be a single leftover's (b.jg5 SRJ-613), so a dialog on it leads at
 * most to Enter through `send-keys`, the backstop. Pure; never throws.
 */
export function paneShowsStartupDialog(pane: string): boolean {
  return typeof pane === 'string' && PRE_SESSION_DIALOG_NEEDLES.some((needle) => pane.includes(needle))
}

/**
 * The pending-row rule's lap `read-pane` of persona `key`'s own row (b.jg5
 * SRJ-410, SRJ-117's pending-row lap column): the shared reader
 * (`readPersonaOwnPane`) with 40 lines (`FULL_PANE_READ_LINES`) and
 * `allow_pending`, the row last read `pending`. The reader latches on
 * CONFLICT (refused operation "P's next check or recovery") and UNUSABLE
 * NAME, reads nothing for a latched persona, and answers every other
 * outcome by class. Its pane may be a single leftover's (b.jg5 SRJ-613): the
 * lap acts on it at most by Enter (`sendPendingRowLapEnter`), the backstop.
 * Never throws.
 */
export function readPendingRowLapPane(key: string, ref: string = keyRef(key)): Promise<OwnPaneReadOutcome> {
  return readPersonaOwnPane(key, {
    nLines: FULL_PANE_READ_LINES,
    lastRead: latchRowStateRead(AGENT_DIRECTOR_PENDING_STATE),
    site: `${PENDING_ROW_RULE_SITE} ${ref} lap`,
    allowPending: true,
  })
}

/**
 * The pending-row rule's lap Enter on persona `key`'s own row (b.jg5
 * SRJ-410, SRJ-118's approver-and-lap row): one `send-keys` with an empty
 * text and `allow_pending: true`, which presses Enter, through
 * `withOutageDetection` declaring the `send-keys` verb (tmux-touching:
 * inside an attempt an UNAVAILABLE starts `tmux-unresponsive`, an
 * UNCLASSIFIED opens the persona's unclassified-error episode, and
 * ENVIRONMENT and CONFIG raise their outages, all in the wrapper). Answers
 * the outcome (`PendingRowLapEnterOutcome`, `src/pending-row.ts`), by class
 * and name through `src/ad-error-class.ts`, never by testing the value
 * against an error class:
 *
 *   - a persona already latched (b.jg5 SRJ-502) gets no call: latched;
 *   - success: sent;
 *   - CONFLICT: the persona latches through the latch's CONFLICT entry
 *     (`setFromConflict`) with the refused operation "P's next check or
 *     recovery" and the recorded state `pending` (b.jg5 SRJ-501): latched,
 *     with one line;
 *   - UNUSABLE NAME: the persona latches through the unusable-name entry
 *     (b.jg5 SRJ-512), recorded `pending`: latched, with one line;
 *   - `ErrInvalidFlags`, to which `send-keys` gives no meaning: one immediate
 *     version re-check, then UNCLASSIFIED (carrying the stop mark when the
 *     re-check decided that the server stops; otherwise reported through
 *     the outage state's UNCLASSIFIED site entry), with one line;
 *   - every other answer returned by class: GONE, `ErrSpawnNotFound`,
 *     `ErrSpawnNotInteractive` (nothing was typed: the session holding the
 *     name is not this launch's, b.jg5 SRJ-613), UNAVAILABLE, CONFIG,
 *     ENVIRONMENT, UNCLASSIFIED (`ErrSendKeysWhileRelayed` included).
 *
 * It types nothing but on success, posts nothing and counts nothing. Never
 * throws.
 */
export async function sendPendingRowLapEnter(key: string, ref: string = keyRef(key)): Promise<PendingRowLapEnterOutcome> {
  if (personaLatchedNow(key)) return PENDING_ROW_LAP_ENTER_NOT_SENT_LATCHED
  let failure: PendingRowLapEnterFailure
  try {
    await withOutageDetection(key, undefined, 'send-keys', (client) =>
      client.sendKeys({ claude_instance_id: personaInstanceId(key), text: '', allow_pending: true }),
    )
    return { kind: PENDING_ROW_LAP_ENTER_SENT }
  } catch (err) {
    if (isInvalidFlagsError(err)) return lapEnterInvalidFlagsOutcome(key, ref, err)
    failure = pendingRowLapEnterFailureOf(err)
  }
  const lastRead = latchRowStateRead(AGENT_DIRECTOR_PENDING_STATE)
  if (failure.kind === PENDING_ROW_LAP_ENTER_CONFLICT) {
    logLapEnterLatch(ref, failure, latchOnConflict(key, failure.error, REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY, lastRead))
    return { kind: PENDING_ROW_LAP_ENTER_LATCHED, cause: failure }
  }
  if (failure.kind === PENDING_ROW_LAP_ENTER_UNUSABLE_NAME) {
    logLapEnterLatch(ref, failure, latchOnUnusableName(key, failure.error, lastRead))
    return { kind: PENDING_ROW_LAP_ENTER_LATCHED, cause: failure }
  }
  return failure
}

/**
 * `sendPendingRowLapEnter`'s answer to an `ErrInvalidFlags`: one immediate
 * version re-check (`classifyWithInvalidFlagsRecheck`, b.jg5 SRJ-204), then
 * UNCLASSIFIED, marked `stopping` when the re-check decided that the server
 * stops (b.jg5 SRJ-205), in which case nothing is reported; otherwise it
 * takes SRJ-105's UNCLASSIFIED row through the outage state's site entry
 * (`reportUnclassifiedAtSite`), since the wrapper took the value as STATE.
 * One line. Never throws.
 */
async function lapEnterInvalidFlagsOutcome(key: string, ref: string, err: InvalidFlagsError): Promise<PendingRowLapEnterUnclassified> {
  const step = await classifyWithInvalidFlagsRecheck(err)
  const stopping = step.recheck.kind === RECHECK_OUTCOME_STOP
  if (!stopping) reportUnclassifiedAtSite(key, err, 'send-keys', step.classification)
  console.error(
    `[slack] ${PENDING_ROW_RULE_SITE}: lap Enter for ${ref} answered ${describeAdErrorClassification(step.classification)} — UNCLASSIFIED after one immediate agent-director version re-check: ${step.recheck.kind}; nothing typed (b.jg5 SRJ-104, SRJ-204)`,
  )
  const outcome: PendingRowLapEnterUnclassified = {
    kind: PENDING_ROW_LAP_ENTER_UNCLASSIFIED,
    errorClass: step.classification.errorClass,
    description: describeAgentDirectorFailure(err),
  }
  return stopping ? { ...outcome, stopping: true } : outcome
}

/** `sendPendingRowLapEnter`'s one line for a latch it set (`outcome`: what became of the latch). */
function logLapEnterLatch(ref: string, cause: PendingRowLapEnterLatching, outcome: string): void {
  const [label, srj] = cause.kind === PENDING_ROW_LAP_ENTER_CONFLICT ? ['CONFLICT', 'SRJ-501'] : ['UNUSABLE NAME', 'SRJ-512']
  console.error(
    `[slack] ${PENDING_ROW_RULE_SITE}: lap Enter refused for ${ref}: ${cause.description} — ${label}: ${outcome}; ` +
      `nothing is typed and nothing more is called for it (b.jg5 SRJ-105, ${srj})`,
  )
}

/**
 * Latch persona `key` on the thrown CONFLICT `err` through the installed
 * latch's CONFLICT entry (`setFromConflict`, b.jg5 SRJ-501) with `operation`
 * and `rowState`. Answers the latch line's outcome text: the set's outcome,
 * that no latch is installed, or that latching failed and what it threw.
 * Logs nothing; never throws.
 */
function latchOnConflict(key: string, err: unknown, operation: RefusedOperation, rowState: LatchRowState): string {
  const latch = conflictLatch
  if (latch === undefined) return LATCH_OUTCOME_NO_LATCH
  try {
    return conflictSetOutcomeText(latch.setFromConflict(key, err, { refusedOperation: operation, rowState }))
  } catch (setErr) {
    return `latching the persona failed: ${describeThrownValue(setErr)}`
  }
}

/**
 * Why a persona is reported not connected (b.f2b), and what the notice says:
 * - `blocked-on-prompt`: its session shows a prompt or dialog that no one
 *   answered, and CSCB never types into one, so it won't reconnect the
 *   persona while the prompt is up: its `working` row's pane has shown one
 *   for `STALE_WORKING_WINDOW_MS`, its `waiting` row's pane shows one, or its
 *   row reads `ask_user` or `check_permission` (the restart path, or a launch
 *   wait that ended there). With `autoRestartDisabled` the notice also says
 *   nothing will reconnect it once the prompt is answered.
 * - `auto-restart-disabled`: its session runs but messages can't reach it
 *   (`cause`, fixed token-free text): its MCP connection is down, or, with
 *   `streamless`, it is connected but its message stream is gone. With
 *   `session_restart_delay` 0 nothing will reconnect it.
 * - `unproven-idle`: its row reads `working` and CSCB has held back from it,
 *   typing nothing, for `heldMs` (at least `UNPROVEN_IDLE_NOTICE_AFTER_MS`,
 *   `noteWorkingRowDeferral`, or a launch wait that gave up on the row at
 *   `session_restart_delay` 0), because it can't prove the session idle. With
 *   `autoRestartDisabled` the notice says nothing will reconnect it on its
 *   own; otherwise that CSCB reconnects it once it can tell it is idle.
 */
export type NotConnectedNotice =
  | { reason: 'blocked-on-prompt'; autoRestartDisabled: boolean }
  | { reason: 'auto-restart-disabled'; cause: string; streamless?: boolean }
  | { reason: 'unproven-idle'; autoRestartDisabled: boolean; heldMs: number }

/**
 * Why the health check finds an alive persona undeliverable (b.f2b): its MCP
 * session is not connected, or it is connected but has no message stream
 * (b.9cj).
 */
export type UndeliverableCause = 'disconnected' | 'streamless'

/**
 * Personas whose not-connected notice was raised in the current episode
 * (b.f2b). The episode ends when the persona's MCP session registers again,
 * when the health check finds it deliverable again, or when the persona is
 * torn down (`forgetNotConnectedEpisode`).
 */
const notConnectedNoticeRaised = new Set<string>()

/**
 * Raise the not-connected notice for persona `key` (b.f2b), at most once per
 * episode, through the persona notifier: its session runs, but it is not
 * connected to this server and CSCB will not reconnect it on its own. The
 * notice says why and what to do. Logs one line when it raises the notice and
 * returns whether it did; a second call in the same episode does nothing.
 */
export function notifyPersonaNotConnected(key: string, notice: NotConnectedNotice): boolean {
  if (notConnectedNoticeRaised.has(key)) return false
  notConnectedNoticeRaised.add(key)
  console.error(`[slack] session-manager: ${keyRef(key)} is not connected (${notice.reason}) — raising a not-connected notice (b.f2b)`)
  sendPersonaNotice(key, buildNotConnectedNotice(key, notice))
  return true
}

/**
 * The health check's report for an alive persona it would reconnect while
 * auto-restart is disabled (b.f2b): the `auto-restart-disabled` notice, once
 * per episode (`notifyPersonaNotConnected`), worded for why it is
 * undeliverable: its MCP connection is down (`disconnected`, the default), or
 * it is connected but its message stream is gone (`streamless`).
 */
export function notifyDisconnectedWithAutoRestartDisabled(key: string, cause: UndeliverableCause = 'disconnected'): void {
  notifyPersonaNotConnected(
    key,
    cause === 'streamless'
      ? {
          reason: 'auto-restart-disabled',
          cause: 'found on two health checks in a row',
          streamless: true,
        }
      : { reason: 'auto-restart-disabled', cause: 'its connection has been down on two health checks in a row' },
  )
}

/**
 * End persona `key`'s not-connected episode (b.f2b): its MCP session
 * registered again, the health check found it deliverable again, or it was
 * torn down. Its notice latch is cleared, so a later episode is reported
 * again, and so are the idle evidence the restart path gathered for its
 * `working` row (`checkWorkingRowPane`), its run of deferrals on that row
 * (`noteWorkingRowDeferral`), its run of deferrals on a row waiting on a
 * prompt (`checkPromptRowDeferral`, b.jdc) and the last non-latching
 * liveness note logged for its own row (`nonLatchingNoteLogged`, b.jg5
 * SRJ-114). Silent; other personas are untouched.
 */
export function forgetNotConnectedEpisode(key: string): void {
  notConnectedNoticeRaised.delete(key)
  workingRowPaneRuns.delete(key)
  workingRowDeferredSince.delete(key)
  promptRowDeferredSince.delete(key)
  nonLatchingNoteLogged.delete(key)
}

/** Test-only seam: end every persona's not-connected episode (notice latches, idle evidence, deferral runs and logged liveness notes). */
export function _resetNotConnectedEpisodes(): void {
  notConnectedNoticeRaised.clear()
  workingRowPaneRuns.clear()
  workingRowDeferredSince.clear()
  promptRowDeferredSince.clear()
  nonLatchingNoteLogged.clear()
}

/**
 * The not-connected notice body (b.f2b). The first line says what is wrong,
 * so a dry-run log line (which carries only the first line) keeps it; the
 * second says what to do. The notifier adds the persona reference. The attach
 * command names the session exactly (`=slack_bot_<key>`, b.1ix): a bare name
 * would attach to a prefix neighbour's session (`slack_bot_dev_2` for
 * `slack_bot_dev`) once the persona's own is gone.
 */
function buildNotConnectedNotice(key: string, notice: NotConnectedNotice): string {
  const attach = `\`tmux attach -t ${tmuxExactSessionTarget(personaTmuxSessionName(key))}\``
  const reconnect = `\`/mcp reconnect ${MCP_SERVER_NAME}\``
  if (notice.reason === 'blocked-on-prompt') {
    const after = notice.autoRestartDisabled
      ? `Automatic restarts are disabled (\`session_restart_delay\` is 0): if it is still not connected once its turn ends, type ${reconnect} there or restart the server.`
      : `Once it is answered, CSCB reconnects it when it can tell the session is idle again (its row reads waiting, or its screen and transcript prove it idle); if it stays disconnected, type ${reconnect} there.`
    return (
      `:warning: *Waiting on a prompt* — this persona is not connected to this server, and its session shows a prompt or dialog in its terminal that no one has answered. CSCB never types into a prompt, so it won't reconnect the persona while the prompt is up; messages sent to it until then are lost.\n` +
      `Attach with ${attach} and answer it. ${after}`
    )
  }
  if (notice.reason === 'unproven-idle') {
    const after = notice.autoRestartDisabled
      ? `Automatic restarts are disabled (\`session_restart_delay\` is 0), so nothing will reconnect it on its own; if it stays disconnected, restart the server.`
      : `Otherwise CSCB keeps checking it and reconnects it once its row reads waiting or its screen and transcript prove it idle.`
    return (
      `:warning: *Not connected* — this persona is not connected to this server: its session reads working but CSCB can't prove it's idle, so it won't type into it, and has held back for ${describeWaitSpan(notice.heldMs)}. Messages sent to it until it reconnects are lost.\n` +
      `Check it with ${attach}: let a running turn finish and answer anything on screen; if it sits idle at its prompt, type ${reconnect} there. ${after}`
    )
  }
  if (notice.streamless === true) {
    return (
      `:warning: *Not receiving messages* — this persona's session is running and connected to this server, but its message stream is gone (${notice.cause}), and automatic restarts are disabled (\`session_restart_delay\` is 0), so nothing will restore it; messages sent to it are lost.\n` +
      `To recover: attach with ${attach}, deal with anything on screen and type ${reconnect}, or restart the server.`
    )
  }
  return (
    `:warning: *Not connected* — this persona's session is running but is not connected to this server (${notice.cause}), and automatic restarts are disabled (\`session_restart_delay\` is 0), so nothing will reconnect it; messages sent to it are lost.\n` +
    `To recover: attach with ${attach}, deal with anything on screen and type ${reconnect}, or restart the server.`
  )
}

/** Spawn-failure remediation when agent-director raised `ErrSpawnNotFound`. */
export const SPAWN_NOT_FOUND_REMEDIATION = 'transient — restarting the server should resolve'

/** Spawn-failure remediation when CSCB's own restart cap (`ErrSpawnCapReached`) was reached. */
export const SPAWN_CAP_REACHED_REMEDIATION = 'restart the server to retry — automatic restarts are suspended for this persona'

/** Spawn-failure remediation for any other error. */
export const SPAWN_FAILURE_DEFAULT_REMEDIATION = 'Check server.log for details.'

/**
 * The remediation line of a spawn-failure notice (`notifySpawnFailure`),
 * decided by the error's name (`hasAdErrorName`, `src/ad-error-class.ts`;
 * b.jg5 SRJ-101 interim rule), never by `instanceof`: `ErrSpawnNotFound`,
 * CSCB's own `ErrSpawnCapReached` (`notifyRestartCapReached`), and any other
 * error. A collision (`ErrInstanceIdCollision`) has no hint: it never reaches
 * the notice, and no post calls it a fault (b.jg5 SRJ-713).
 */
function remediationHint(error: AgentDirectorError): string {
  if (hasAdErrorName(error, ERR_SPAWN_NOT_FOUND_NAME)) return SPAWN_NOT_FOUND_REMEDIATION
  if (hasAdErrorName(error, ERR_SPAWN_CAP_REACHED_NAME)) return SPAWN_CAP_REACHED_REMEDIATION
  return SPAWN_FAILURE_DEFAULT_REMEDIATION
}

// ---------------------------------------------------------------------------
// Raw tmux calls — one runner, exact targets only (b.1ix)
// ---------------------------------------------------------------------------

/** One `tmux` run: its exit code (`null` when it could not run) and its stdout. */
export interface TmuxRunResult {
  code: number | null
  stdout: string
}

/**
 * Runs `tmux <args>` and never rejects. No server path makes a raw tmux call
 * through it: CSCB reaches tmux only through agent-director. The runner and
 * its seams stay so a unit test can install a recording runner, see that no
 * argv reaches it, and never reach a real tmux server.
 */
export type TmuxCommandRunner = (args: readonly string[]) => Promise<TmuxRunResult>

const defaultRunTmux: TmuxCommandRunner = async (args) => {
  const { spawn } = await import('child_process')
  return new Promise<TmuxRunResult>((resolve) => {
    try {
      const child = spawn('tmux', [...args], { stdio: ['ignore', 'pipe', 'ignore'] })
      let stdout = ''
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
      child.on('error', () => resolve({ code: null, stdout: '' })) // tmux missing
      child.on('close', (code) => resolve({ code, stdout }))
    } catch {
      resolve({ code: null, stdout: '' })
    }
  })
}

let _runTmux: TmuxCommandRunner = defaultRunTmux

/** Test-only seam: override the tmux command runner. */
export function _setTmuxCommandRunner(fn: TmuxCommandRunner): void {
  _runTmux = fn
}

/** Test-only seam: restore the default tmux command runner. */
export function _resetTmuxCommandRunner(): void {
  _runTmux = defaultRunTmux
}

// ---------------------------------------------------------------------------
// reconnectMcp — send `/mcp reconnect <server-name>` via library sendKeys
// ---------------------------------------------------------------------------

/**
 * The reconnect's outcome (`reconnectMcpWithCause`, b.jg5 SRJ-118's
 * reconnect row, SRJ-609):
 *   - `ok`: `/mcp reconnect` was typed;
 *   - `dead-session`: the caller recovers the persona (the ladder through its
 *     find-missing run and resume/fresh-spawn, the restart adapter by
 *     sweeping and escalating it). Its cause (`DeadSessionCause`) says what
 *     agent-director answered. `waitForWaitingAndReconnect` also answers it
 *     for a row it read `ended` or `missing` (`row-read-finished`), or found
 *     absent (`ErrSpawnNotFound`, `row-absent`), with no tmux probe (b.ecw,
 *     b.jg5 SRJ-605). A `dead-session` from a row read or from a refusal as
 *     not interactive is not dead evidence and proves nothing about the
 *     worker's process (b.jg5 SRJ-609, SRJ-611); the
 *     recovery's resume or spawn decides what holds the persona's name
 *     (agent-director classifies any leftover session, and a CONFLICT there
 *     latches the persona, SRJ-501);
 *   - `transient`: nothing was typed and nothing is concluded about the
 *     session: the persona latched at the reconnect (CONFLICT, UNUSABLE
 *     NAME) or was latched already, or agent-director could not act on the
 *     keystrokes (UNAVAILABLE, timeouts included, ENVIRONMENT, CONFIG,
 *     UNCLASSIFIED). It is never counted toward the restart cap, never a
 *     spawn-failure notice and never a `spawn-failed` entry: the ladder maps
 *     it to `latched` for a latched persona and otherwise to `retrying`
 *     (uncounted, b.jg5 SRJ-1015), and the restart adapter to `transient`.
 */
export type ReconnectOutcome = 'ok' | 'dead-session' | 'transient'

/**
 * `waitForWaitingAndReconnect`'s outcome (b.f2b): a reconnect outcome (`ok`
 * only when `/mcp reconnect` was typed; `dead-session` as `ReconnectOutcome`
 * says, never for a `status` error other than `ErrSpawnNotFound`, and
 * always with its cause in the wait's result, `WaitDeadSession`;
 * `transient` for the wait's reconnect's own `transient`, for a refused
 * findMissing sweep, and for a server stop decided at the evidence read's
 * version re-check, never for a `status` error, b.jg5 SRJ-605: nothing was
 * typed and nothing is counted); `not-reconnected`: the wait ended with the
 * persona's session alive, or its state unknown, but typed nothing (the row
 * moved to a live transient state, the timeout found it still live, or the
 * timeout `status` read failed), and has logged what happens next for the
 * restart delay in effect (`reportWaitEndedDisconnected`); or `cancelled`:
 * the persona's teardown cancelled the wait (`cancelWorkingRowWait`), and
 * nothing was typed; or `latched`: the persona is latched after one of the
 * wait's agent-director calls (b.jg5 SRJ-502, SRJ-608: an UNUSABLE NAME
 * answer or a `pending` row with no launch start at a `status` read, a
 * CONFLICT or UNUSABLE NAME at the evidence read's pane read, a note its
 * transcript `get` read, or a latch set elsewhere), the wait called nothing
 * more, typed nothing and raised no not-connected notice, and the ladder
 * answers `latched`.
 */
export type WaitReconnectOutcome = ReconnectOutcome | 'not-reconnected' | 'cancelled' | typeof WAIT_OUTCOME_LATCHED

/** The wait's outcome for a persona that is latched (`WaitReconnectOutcome`). */
export const WAIT_OUTCOME_LATCHED = 'latched'

/**
 * A `dead-session` end of the launch wait, with its cause (b.jg5 SRJ-605,
 * SRJ-611). Each end has exactly one:
 *   - the wait's reconnect answered `dead-session`: the reconnect's cause,
 *     unchanged (`tmux-gone`, `row-not-interactive` or `row-absent`);
 *   - a `status` read, at the poll or the timeout, answered
 *     `ErrSpawnNotFound`: `row-absent`;
 *   - a `status` read, at the poll or the timeout (after its sweep), found
 *     the row `ended` or `missing`: `row-read-finished`, with that state
 *     (`finishedState`).
 * Of these only the reconnect's `tmux-gone` is dead evidence
 * (`isDeadEvidence`); the others are a refusal or row reads.
 */
export interface WaitDeadSession {
  readonly outcome: 'dead-session'
  readonly deadCause: DeadSessionCause
  /** With `row-read-finished` only: the state read, `ended` or `missing`. */
  readonly finishedState?: string
}

/** How the launch wait's body ends: a `dead-session` always carries its cause (`WaitDeadSession`). */
type WaitEnd = Exclude<WaitReconnectOutcome, 'dead-session'> | WaitDeadSession

/**
 * `waitForWaitingAndReconnectWithCause`'s answer: a `dead-session` with its
 * cause (`WaitDeadSession`), or any other outcome with, for `transient`,
 * whether the persona is latched or the server stops. `lastRead` is the row
 * state the wait's last read gave (b.jg5 SRJ-501), absent when none answered.
 */
export type WaitReconnectResult =
  | (WaitDeadSession & { readonly lastRead?: LatchRowState })
  | {
      readonly outcome: Exclude<WaitReconnectOutcome, 'dead-session'>
      readonly latched?: true
      readonly stopping?: true
      readonly lastRead?: LatchRowState
    }

/** `DeadSessionCause`: the reconnect's `send-keys` answered GONE (`ErrTmuxSendKeys`). */
export const DEAD_SESSION_CAUSE_TMUX_GONE = 'tmux-gone'

/** `DeadSessionCause`: agent-director refused the keystrokes as not interactive (`ErrSpawnNotInteractive`). */
export const DEAD_SESSION_CAUSE_ROW_NOT_INTERACTIVE = 'row-not-interactive'

/** `DeadSessionCause`: no row has the persona's instance id (`ErrSpawnNotFound`), a row read. */
export const DEAD_SESSION_CAUSE_ROW_ABSENT = 'row-absent'

/**
 * `DeadSessionCause`: the launch wait's `status` read found the row `ended`
 * or `missing` (at its poll, or at its timeout after the sweep), a row read;
 * the wait's answer carries the state read (`WaitDeadSession`).
 */
export const DEAD_SESSION_CAUSE_ROW_READ_FINISHED = 'row-read-finished'

/**
 * `DeadSessionCause`: the collision ladder's one-line `read-pane` of a row
 * read `ask_user` or `check_permission` answered GONE (`ErrTmuxCaptureFailed`,
 * b.jdc's ladder action, `launchOnPromptRow`; b.jg5 SRJ-607).
 */
export const DEAD_SESSION_CAUSE_PROMPT_ROW_LADDER_GONE = 'prompt-row-ladder-gone'

/**
 * Every `DeadSessionCause`, in one runtime list, so a test iterates the
 * values themselves (b.jg5 SRJ-611).
 */
export const DEAD_SESSION_CAUSES = Object.freeze([
  DEAD_SESSION_CAUSE_TMUX_GONE,
  DEAD_SESSION_CAUSE_ROW_NOT_INTERACTIVE,
  DEAD_SESSION_CAUSE_ROW_ABSENT,
  DEAD_SESSION_CAUSE_ROW_READ_FINISHED,
  DEAD_SESSION_CAUSE_PROMPT_ROW_LADDER_GONE,
] as const)

/**
 * What proved a `dead-session` verdict (b.jdc; b.jg5 SRJ-118, SRJ-609,
 * SRJ-611). Only the GONE-based causes are dead evidence
 * (`isDeadEvidence`); a refusal or a row read never is:
 *   - GONE-based, dead evidence:
 *     - `tmux-gone`: the reconnect's `send-keys` answered GONE
 *       (`ErrTmuxSendKeys`): agent-director found no session of the row's
 *       launch. Answered at once, with no tmux server start and no second
 *       try;
 *     - `prompt-row-ladder-gone`: the collision ladder's `read-pane` of a
 *       prompt row answered GONE (`ErrTmuxCaptureFailed`, `launchOnPromptRow`,
 *       SRJ-607);
 *   - a refusal, never dead evidence: `row-not-interactive`, agent-director
 *     refused the reconnect's keystrokes as not interactive
 *     (`ErrSpawnNotInteractive`, b.dup): the row finished (`ended` or
 *     `missing`) after the caller read it, or it reads `pending` and the
 *     session holding the persona's name may be another launch's (b.jg5
 *     SRJ-613). A finished row is not proof that the worker is gone, so this
 *     is only a route into the restart path's decision, and the restart work
 *     kills nothing because of it (SRJ-609);
 *   - row reads, never dead evidence:
 *     - `row-absent`: no row has the persona's instance id
 *       (`ErrSpawnNotFound`), at the reconnect's `send-keys`, at the launch
 *       wait's `status` read or at the ladder's prompt-row `read-pane`;
 *     - `row-read-finished`: the launch wait read the row `ended` or
 *       `missing`.
 * The reconnect answers only `tmux-gone`, `row-not-interactive` and
 * `row-absent` (`ReconnectDeadSessionCause`).
 */
export type DeadSessionCause = (typeof DEAD_SESSION_CAUSES)[number]

/** The `DeadSessionCause`s `reconnectMcpWithCause` answers (b.jg5 SRJ-118, SRJ-609). */
export type ReconnectDeadSessionCause =
  | typeof DEAD_SESSION_CAUSE_TMUX_GONE
  | typeof DEAD_SESSION_CAUSE_ROW_NOT_INTERACTIVE
  | typeof DEAD_SESSION_CAUSE_ROW_ABSENT

/**
 * `reconnectMcpWithCause`'s answer: the outcome, with what goes with it. A
 * `dead-session` always carries its cause (b.jg5 SRJ-611).
 */
export type ReconnectResult =
  | { outcome: 'ok' }
  | {
      outcome: 'dead-session'
      /** What agent-director answered. */
      deadCause: ReconnectDeadSessionCause
    }
  | {
      outcome: 'transient'
      /**
       * The persona is latched (the reconnect's CONFLICT or UNUSABLE NAME
       * answer latched it, or it was latched already and no `send-keys` was
       * made), so the ladder answers `latched` for it.
       */
      latched?: true
      /**
       * The keystrokes answered `ErrInvalidFlags` and the immediate version
       * re-check decided that the server stops (b.jg5 SRJ-104, SRJ-205); the
       * ladder answers a `failed` result marked `stopping`.
       */
      stopping?: true
    }

/**
 * Send `/mcp reconnect <MCP_SERVER_NAME>` to persona `key`'s row and answer
 * its outcome alone (`reconnectMcpWithCause`). `lastRead` is the row state
 * the caller last read (b.jg5 SRJ-501), `waiting` when not given: every
 * reconnect is made on a row read `waiting`, or a stale `working` row.
 *
 * @param key  Persona key: addresses `cscb_<key>` and keys outage flags and notices.
 * @param lastRead  The row state the caller last read, for a latch the reconnect sets.
 * @param ref  Log reference; defaults to the key alone.
 */
export async function reconnectMcp(
  key: string,
  lastRead: LatchRowState = latchRowStateRead('waiting'),
  ref: string = keyRef(key),
): Promise<ReconnectOutcome> {
  return (await reconnectMcpWithCause(key, lastRead, ref)).outcome
}

/**
 * Send `/mcp reconnect <MCP_SERVER_NAME>` to persona `key`'s row: exactly one
 * `sendKeys` through `withOutageDetection`, declaring the `send-keys` verb
 * (tmux-touching), with the library appending Enter. It never retries, never
 * starts a tmux server and makes no tmux call of its own (b.jg5 SRJ-609, HO
 * C20). Each answer is decided by class and name through
 * `src/ad-error-class.ts`, never by `instanceof` (b.jg5 SRJ-118's reconnect
 * row):
 *
 *   - a persona already latched (`personaLatchedNow`, b.jg5 SRJ-502): no
 *     `send-keys`; `transient` (latched);
 *   - a persona whose own `cscb_<key>` is held for an old life
 *     (`isOwnRowOldLifeHeld`, b.jg5 SRJ-810: CSCB types no `/mcp reconnect`
 *     into the old life's session): no `send-keys`; the persona recorded as
 *     waiting on that hold (`recordOwnRowWaiting`), its retry timer armed
 *     with the held-for-an-old-life cause (`armOldLifeWaiter`), one line
 *     (`reconnectHeldLine`) naming the persona and the held instance id;
 *     `transient`. This guards every caller: the ladder's `waiting` branch,
 *     the launch's working-row wait and the restart path's reconnect
 *     adapter, which itself starts the persona's live-row sequence for such
 *     a row before it would get here;
 *   - success: `ok`;
 *   - GONE (`ErrTmuxSendKeys`): `dead-session` with cause `tmux-gone`, at once;
 *   - `ErrSpawnNotInteractive`: `dead-session` with cause
 *     `row-not-interactive`, a route into the restart path's decision only;
 *     it claims nothing about the worker's process;
 *   - `ErrSpawnNotFound`: `dead-session` with cause `row-absent` (a row read,
 *     not a GONE);
 *   - CONFLICT: the persona latches through the latch's CONFLICT entry
 *     (`setFromConflict`) with the refused operation "P's next check or
 *     recovery" and `lastRead` (b.jg5 SRJ-501); `transient` (latched). On a
 *     live row that is not `pending`, "not this launch's session" means a
 *     leftover of an earlier launch holds the persona's session (SRJ-613),
 *     and its line says so. The refused `send-keys` is never retried
 *     (SRJ-505);
 *
 *     This CONFLICT is the backstop for every pane read that leads here
 *     (b.jg5 SRJ-613). A pane may be a single leftover's, so the waiting-row
 *     check's pane (`checkWaitingRowPane`), the working-row verdict's fold
 *     (`workingReconnectVerdict`, `checkWorkingRowPane`) and the launch
 *     wait's evidence read (`staleWorkingRowIsIdle`) never prove that the
 *     worker's own session is there; this `send-keys` is answered by the
 *     row's current launch, and when a leftover holds the persona's session
 *     it types nothing and P latches (its CONFLICT notice posted once,
 *     SRJ-508), held for a human (SRJ-502);
 *   - UNUSABLE NAME: the persona latches through the unusable-name entry
 *     (`latchOnUnusableName`: refused operation "none", `lastRead`, b.jg5
 *     SRJ-512); `transient` (latched);
 *   - `ErrInvalidFlags`, to which `send-keys` gives no meaning: one immediate
 *     version re-check, then UNCLASSIFIED (b.jg5 SRJ-104, SRJ-204):
 *     `transient`, carrying `stopping` when the re-check decided the stop;
 *   - UNAVAILABLE (timeouts included), ENVIRONMENT, CONFIG and UNCLASSIFIED
 *     (`ErrSendKeysWhileRelayed` and `ErrSystemInstallDisappeared`
 *     included), and any STATE, LAUNCH FAILURE or DIRECTORY name SRJ-118
 *     gives no column: `transient`. The wrapper has already done what their
 *     class asks (b.jg5 SRJ-105, SRJ-301, SRJ-311, SRJ-313, SRJ-316): it
 *     raised the `tmux-unavailable`, `ad-config-malformed` or
 *     `ad-unreachable` outage, armed the persona's retry timer inside an
 *     attempt and reported an UNCLASSIFIED answer to the persona's
 *     unclassified-error episode; a CONFIG answer is otherwise taken as the
 *     UNAVAILABLE column.
 *
 * No path posts a spawn-failure notice, records a `spawn-failed` entry or
 * counts anything. Nothing is typed on any path but success. One line per
 * call, from an exported builder (`reconnectStartLine`, then one of
 * `reconnectLatchedLine`, `reconnectGoneLine`, `reconnectNotInteractiveLine`,
 * `reconnectRowAbsentLine`, `reconnectConflictLine`,
 * `reconnectUnusableNameLine`, `reconnectInvalidFlagsLine` and
 * `reconnectTransientLine` for a failure). Never throws.
 *
 * @param key  Persona key: addresses `cscb_<key>` and keys outage flags and notices.
 * @param lastRead  The row state the caller last read (b.jg5 SRJ-501): the
 *   ladder's `waiting` branch `waiting`; the launch wait `waiting`, or
 *   `working` for a stale `working` row; the restart adapter the state its
 *   `status` read gave.
 * @param ref  Log reference; defaults to the key alone.
 */
export async function reconnectMcpWithCause(
  key: string,
  lastRead: LatchRowState,
  ref: string = keyRef(key),
): Promise<ReconnectResult> {
  if (personaLatchedNow(key)) {
    console.error(reconnectLatchedLine(ref))
    return { outcome: 'transient', latched: true }
  }
  // b.jg5 SRJ-810: no `/mcp reconnect` is typed into a held old life; the
  // persona waits on that hold, so the hold's end retries it at once.
  if (isOwnRowOldLifeHeld(key)) {
    recordOwnRowWaiting(key)
    console.error(reconnectHeldLine(ref, personaInstanceId(key), armOldLifeWaiter(key)))
    return { outcome: 'transient' }
  }
  console.error(reconnectStartLine(ref))
  try {
    await withOutageDetection(key, undefined, 'send-keys', (client) =>
      client.sendKeys({
        claude_instance_id: personaInstanceId(key),
        text: `/mcp reconnect ${MCP_SERVER_NAME}`,
      }),
    )
    return { outcome: 'ok' }
  } catch (err) {
    return reconnectAnswerTo(key, lastRead, ref, err)
  }
}

/**
 * `reconnectMcpWithCause`'s answer to a refused `send-keys` (`err`), by
 * class and name (b.jg5 SRJ-118's reconnect row; see `reconnectMcpWithCause`
 * for the table). Logs its one line. Never throws.
 */
async function reconnectAnswerTo(key: string, lastRead: LatchRowState, ref: string, err: unknown): Promise<ReconnectResult> {
  if (isInvalidFlagsError(err)) return reconnectInvalidFlagsAnswer(key, ref, err)
  const { errorClass } = classifyAdError(err)
  const failure = describeAgentDirectorFailure(err)
  if (errorClass === AD_ERROR_CLASS_GONE) {
    console.error(reconnectGoneLine(ref, failure))
    return { outcome: 'dead-session', deadCause: DEAD_SESSION_CAUSE_TMUX_GONE }
  }
  if (hasAdErrorName(err, ERR_SPAWN_NOT_INTERACTIVE_NAME)) {
    console.error(reconnectNotInteractiveLine(ref, failure))
    return { outcome: 'dead-session', deadCause: DEAD_SESSION_CAUSE_ROW_NOT_INTERACTIVE }
  }
  if (hasAdErrorName(err, ERR_SPAWN_NOT_FOUND_NAME)) {
    console.error(reconnectRowAbsentLine(ref, failure))
    return { outcome: 'dead-session', deadCause: DEAD_SESSION_CAUSE_ROW_ABSENT }
  }
  if (errorClass === AD_ERROR_CLASS_CONFLICT) {
    // The latch is set first; its line then carries what became of it. The
    // line's builder takes only the redacted description, the case and the
    // latch's own outcome text.
    logReconnectLine(
      reconnectConflictLine(
        ref,
        failure,
        recogniseConflictCase(conflictDescriptionOf(err)),
        latchOnConflict(key, err, REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY, lastRead),
      ),
    )
    return { outcome: 'transient', latched: true }
  }
  if (errorClass === AD_ERROR_CLASS_UNUSABLE_NAME) {
    logReconnectLine(reconnectUnusableNameLine(ref, failure, latchOnUnusableName(key, err, lastRead)))
    return { outcome: 'transient', latched: true }
  }
  console.error(reconnectTransientLine(ref, failure, errorClass))
  return { outcome: 'transient' }
}

/**
 * `reconnectMcpWithCause`'s answer to an `ErrInvalidFlags` (b.jg5 SRJ-104:
 * `send-keys` gives it no meaning): exactly one immediate version re-check
 * (`classifyWithInvalidFlagsRecheck`, b.jg5 SRJ-204; a stop it decides ends
 * the process as the re-check defines), then UNCLASSIFIED: `transient`,
 * carrying `stopping` when the re-check decided the stop (b.jg5 SRJ-205), in
 * which case nothing is reported. Otherwise the answer takes SRJ-105's
 * UNCLASSIFIED row through the outage state's site entry
 * (`reportUnclassifiedAtSite`), since the wrapper took the value as STATE.
 * One line (`reconnectInvalidFlagsLine`). Never throws.
 */
async function reconnectInvalidFlagsAnswer(key: string, ref: string, err: InvalidFlagsError): Promise<ReconnectResult> {
  const step = await classifyWithInvalidFlagsRecheck(err)
  const stopping = step.recheck.kind === RECHECK_OUTCOME_STOP
  if (!stopping) reportUnclassifiedAtSite(key, err, 'send-keys', step.classification)
  console.error(reconnectInvalidFlagsLine(ref, describeAdErrorClassification(step.classification), step.recheck.kind))
  return stopping ? { outcome: 'transient', stopping: true } : { outcome: 'transient' }
}

/**
 * One reconnect line to the server log; `line` comes from one of the
 * reconnect's exported builders. The two latching lines go through it, as
 * `logApproverLine` and `logPaneReadLatch` do, because their arguments hand
 * the thrown value to the latch call, which a direct log call may not.
 */
function logReconnectLine(line: string): void {
  console.error(line)
}

/** The reconnect's first line, before its one `send-keys` (`reconnectMcpWithCause`). */
export function reconnectStartLine(ref: string): string {
  return `[slack] reconnecting MCP server "${MCP_SERVER_NAME}": ${ref}`
}

/** The reconnect's line for a persona already latched: no `send-keys` is made (b.jg5 SRJ-502). */
export function reconnectLatchedLine(ref: string): string {
  return `[slack] reconnectMcp: ${ref} is latched — no send-keys; transient, nothing typed (b.jg5 SRJ-118, SRJ-502)`
}

/**
 * The reconnect's line for a persona whose own row is held for an old life
 * (b.jg5 SRJ-810): no `send-keys` is made; `armed` says whether its retry
 * timer was armed with the held-for-an-old-life cause:
 *
 *   [slack] reconnectMcp: <ref> — its own row instanceId="<id>" is held for an old life that may still be running: no send-keys; transient, nothing typed; its retry timer is armed (held-for-old-life) (b.jg5 SRJ-810)
 *   [slack] reconnectMcp: <ref> — its own row instanceId="<id>" is held for an old life that may still be running: no send-keys; transient, nothing typed; its retry timer could not be armed (b.jg5 SRJ-810)
 *
 * Pure.
 */
export function reconnectHeldLine(ref: string, instanceId: string, armed: boolean): string {
  const timer = armed ? `its retry timer is armed (${UNAVAILABLE_RETRY_CAUSE_OLD_LIFE_HOLD})` : 'its retry timer could not be armed'
  return (
    `[slack] reconnectMcp: ${ref} — its own row instanceId=${JSON.stringify(renderLogMessageText(instanceId))} is held for an old life ` +
    `that may still be running: no send-keys; transient, nothing typed; ${timer} (b.jg5 SRJ-810)`
  )
}

/**
 * The reconnect's line for a GONE answer (`ErrTmuxSendKeys`; `failure` is the
 * redacting describer's output): `dead-session` with cause `tmux-gone`, at
 * once, with no tmux server start and no second try (b.jg5 SRJ-118, SRJ-609).
 */
export function reconnectGoneLine(ref: string, failure: string): string {
  return `[slack] reconnectMcp: send-keys answered GONE for ${ref}: ${failure} — agent-director found no session of the row's launch; dead session (${DEAD_SESSION_CAUSE_TMUX_GONE}), with no tmux server start and no second try (b.jg5 SRJ-118, SRJ-609)`
}

/**
 * The reconnect's line for `ErrSpawnNotInteractive` (`failure` is the
 * redacting describer's output): `dead-session` with cause
 * `row-not-interactive`, a route into the restart path's decision only. It
 * claims nothing about the worker's process (b.jg5 SRJ-609).
 */
export function reconnectNotInteractiveLine(ref: string, failure: string): string {
  return `[slack] reconnectMcp: send-keys refused for ${ref}: ${failure} — agent-director refused the keystrokes as not interactive (the row finished after it was read, or a pending row's session may be another launch's), which does not prove the worker gone; dead session (${DEAD_SESSION_CAUSE_ROW_NOT_INTERACTIVE}), a route into the restart path's decision only (b.jg5 SRJ-118, SRJ-609)`
}

/**
 * The reconnect's line for `ErrSpawnNotFound` (`failure` is the redacting
 * describer's output): `dead-session` with cause `row-absent`, a row read and
 * not a GONE (b.jg5 SRJ-118).
 */
export function reconnectRowAbsentLine(ref: string, failure: string): string {
  return `[slack] reconnectMcp: send-keys found no row for ${ref}: ${failure} — no row has the persona's instance id (a row read, not a GONE); dead session (${DEAD_SESSION_CAUSE_ROW_ABSENT}) (b.jg5 SRJ-118)`
}

/**
 * What `reconnectConflictLine` adds for the CONFLICT case "not this launch's
 * session": on a live row that is not `pending`, a leftover of an earlier
 * launch holds the persona's session (b.jg5 SRJ-118, SRJ-613).
 */
export const RECONNECT_NOT_THIS_LAUNCH_NOTE = "a leftover of an earlier launch may hold the persona's session (b.jg5 SRJ-613)"

/**
 * The reconnect's line for a CONFLICT answer (`failure` is the redacting
 * describer's output, `latchCase` the case its description's words give,
 * `outcome` what became of the latch): nothing was typed, the persona
 * latched, and the refused `send-keys` is never retried (b.jg5 SRJ-118,
 * SRJ-501, SRJ-505). The case "not this launch's session" also carries
 * `RECONNECT_NOT_THIS_LAUNCH_NOTE`.
 */
export function reconnectConflictLine(ref: string, failure: string, latchCase: ConflictLatchCase, outcome: string): string {
  const note = latchCase === LATCH_CASE_NOT_THIS_LAUNCH ? ` (${RECONNECT_NOT_THIS_LAUNCH_NOTE})` : ''
  return `[slack] reconnectMcp: send-keys refused for ${ref}: ${failure} — CONFLICT case=${latchCase}${note}: ${outcome}; nothing was typed and the send-keys is not retried; transient (b.jg5 SRJ-118, SRJ-501)`
}

/**
 * The reconnect's line for an UNUSABLE NAME answer (`failure` is the
 * redacting describer's output, `outcome` what became of the latch): nothing
 * was typed and the persona latched (b.jg5 SRJ-118, SRJ-512).
 */
export function reconnectUnusableNameLine(ref: string, failure: string, outcome: string): string {
  return `[slack] reconnectMcp: send-keys refused for ${ref}: ${failure} — UNUSABLE NAME: ${outcome}; nothing was typed and the send-keys is not retried; transient (b.jg5 SRJ-118, SRJ-512)`
}

/**
 * The reconnect's line for an `ErrInvalidFlags` answer after its one version
 * re-check (`classification` rendered by `describeAdErrorClassification`,
 * `recheck` the re-check's answer kind): UNCLASSIFIED, `transient`, nothing
 * typed (b.jg5 SRJ-104, SRJ-204).
 */
export function reconnectInvalidFlagsLine(ref: string, classification: string, recheck: string): string {
  return `[slack] reconnectMcp: send-keys for ${ref} answered ${classification} — UNCLASSIFIED after one immediate agent-director version re-check: ${recheck}; transient, nothing typed (b.jg5 SRJ-104, SRJ-204)`
}

/**
 * The reconnect's line for every other refused `send-keys` (`failure` is the
 * redacting describer's output, `errorClass` its class): UNAVAILABLE,
 * ENVIRONMENT, CONFIG, UNCLASSIFIED, or a STATE, LAUNCH FAILURE or DIRECTORY
 * name SRJ-118 gives no column. `transient`: nothing was typed, no
 * spawn-failure notice, nothing counted (b.jg5 SRJ-118, SRJ-105).
 */
export function reconnectTransientLine(ref: string, failure: string, errorClass: AdErrorClass): string {
  return `[slack] reconnectMcp: send-keys refused for ${ref}: ${failure} — ${errorClass}: transient; nothing was typed, no spawn-failure notice, nothing counted (b.jg5 SRJ-118, SRJ-105)`
}

// ---------------------------------------------------------------------------
// approvePreSessionDialogs — auto-approve pre-SessionStart dialogs on spawn
// ---------------------------------------------------------------------------

/**
 * Verified against Claude Code 2.1.120 (2026-05-27). If this stops matching,
 * the dev-channels dialog has drifted — see b.yy6. Match the option label
 * (semantic, stable) rather than the header (cosmetic, drifts).
 */
export const DEV_CHANNELS_DIALOG_NEEDLE = 'I am using this for local development'

/**
 * Verified against Claude Code 2.1.120 (2026-06-02). If this stops matching,
 * the folder-trust dialog has drifted — see b.k54 / b.uhv. Match the option
 * label (semantic, stable) rather than the header (cosmetic, drifts).
 */
export const TRUST_DIALOG_NEEDLE = 'Yes, I trust this folder'

/**
 * The approver's pace (b.jg5 SRJ-403): at most one pane read a second. The
 * lap after one that read the pane starts at least this long after that
 * `read-pane` call, on the approver's clock (`_setApproverClock`), so two
 * `read-pane` calls are never closer than the pace in effect, however long
 * either lap's `status` read takes. The lap after one that read no pane
 * starts at least this long after that lap's start.
 */
export const DIALOG_POLL_INTERVAL_MS = 1_000

/**
 * The approver's slow pace (b.jg5 SRJ-403, SRJ-404): at most one pane read
 * every 5 s, measured as `DIALOG_POLL_INTERVAL_MS` is. The next lap waits it
 * once G (`adGraceMsInEffect`, read at the lap)
 * has passed since the launch start the lap's `status` read carried, and
 * after a lap that met an UNAVAILABLE or CONFIG answer (backing off).
 */
export const DIALOG_SLOW_POLL_INTERVAL_MS = 5_000

/**
 * The approver's test cap (b.jg5 SRJ-404, SRJ-1303): unset by default. While
 * it is set, the approver stops that many milliseconds after its own start,
 * on the approver's clock, in place of B; no other wait reads it.
 */
let _dialogReadyTimeoutMs: number | undefined

/** Test-only seam: cap the approver at `ms` from its own start, in place of B. */
export function _setDialogReadyTimeoutMs(ms: number): void {
  _dialogReadyTimeoutMs = ms
}

/** Test-only seam: unset the cap, so the approver stops at B. */
export function _resetDialogReadyTimeoutMs(): void {
  _dialogReadyTimeoutMs = undefined
}

/**
 * The time to wait from one lap's pane read (or, for a lap that read no
 * pane, its start) to the next lap's start (b.jg5 SRJ-403, SRJ-404):
 * `DIALOG_SLOW_POLL_INTERVAL_MS` after a lap that backed off (an
 * UNAVAILABLE or CONFIG answer), or once `graceMs` (G: the accessor itself,
 * read at this call) has passed at `nowMs` since the launch start
 * `launchStartedAt` names, the raw launch start the lap's `status` read
 * carried (`isPendingRowAged`, `src/pending-row.ts`; b.jg5 SRJ-406, never
 * `started_at`); otherwise `DIALOG_POLL_INTERVAL_MS`. A lap with no launch
 * start (never aged, SRJ-408), and a G of `AD_WAIT_NEVER_ENDS`, keep the 1 s
 * pace. Pure.
 */
export function approverPaceMs(
  backOff: boolean,
  launchStartedAt: unknown,
  nowMs: number,
  graceMs: NeverEarlyWaitLength,
): number {
  if (backOff) return DIALOG_SLOW_POLL_INTERVAL_MS
  if (isPendingRowAged(launchStartedAt, graceMs, nowMs)) return DIALOG_SLOW_POLL_INTERVAL_MS
  return DIALOG_POLL_INTERVAL_MS
}

// ---------------------------------------------------------------------------
// The approver's clock, stop reasons, startup-errors labels and log lines
// ---------------------------------------------------------------------------

/**
 * The approver's clock and timers: the timer subset of the persona clock type
 * (`NeverEarlyWaitClock`, `src/ad-settings.ts`). The approver's B (or cap)
 * timer and its sleeps between laps run on this clock only, so a suite drives
 * them all with `createFakeClock` and never waits on real time.
 */
export type ApproverClock = NeverEarlyWaitClock

/** The real clock, the approver's default. */
const SYSTEM_APPROVER_CLOCK: ApproverClock = Object.freeze({
  now: (): number => Date.now(),
  setTimeout: (callback: () => void, delayMs: number): unknown => setTimeout(callback, delayMs),
  clearTimeout: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
})

let _approverClock: ApproverClock = SYSTEM_APPROVER_CLOCK

/** Test-only seam: run the approver's B (or cap) timer and sleeps on `clock` (a suite passes `createFakeClock()`). */
export function _setApproverClock(clock: ApproverClock): void {
  _approverClock = clock
}

/** Test-only seam: restore the real clock for the approver. */
export function _resetApproverClock(): void {
  _approverClock = SYSTEM_APPROVER_CLOCK
}

/** The approver stopped because the row left `pending` for a live state: the dialog is gone. */
export const APPROVER_STOP_LIVE = 'live'
/** The approver stopped because the row read `ended` or `missing`: the launch is over (b.jg5 SRJ-402). */
export const APPROVER_STOP_FINISHED = 'finished'
/** The approver stopped because `status` answered `ErrSpawnNotFound`: the row is absent. */
export const APPROVER_STOP_ABSENT = 'absent'
/**
 * The approver stopped because the persona latched (b.jg5 SRJ-502, SRJ-512,
 * SRJ-513): its `status` read latched it (the own-row `status` step), its
 * own CONFLICT or UNUSABLE NAME answer latched it, it was latched before a
 * lap or while a call was awaited, or a latch set by any other site stopped
 * it (the latch's set observer, `setConflictLatch`).
 */
export const APPROVER_STOP_LATCHED = 'latched'
/**
 * The approver stopped because the row read `pending` with no launch start
 * and the read latched nothing (b.jg5 SRJ-401, SRJ-513). For a configured
 * persona the own-row `status` step (`applyOwnRowStatusStep`) latches such a
 * row with "launch start not recorded", answering latched even with no latch
 * installed, so the approver stops `latched` instead. This stop is reached
 * only when no configured-persona query is installed, or the query does not
 * answer that `key` is a configured persona's (it answers otherwise or
 * throws; e.g. a persona removed while its launch's approver runs).
 */
export const APPROVER_STOP_NO_LAUNCH_START = 'no-launch-start'
/**
 * The approver stopped at B (`adLaunchBoundMsInEffect`, b.jg5 SRJ-210,
 * SRJ-404), measured from the launch start its first `pending` lap kept, or
 * from its own start while no lap had read one.
 */
export const APPROVER_STOP_BOUND = 'bound'
/** The approver stopped at its test cap (`_setDialogReadyTimeoutMs`, measured from its own start), set in place of B. */
export const APPROVER_STOP_CAP = 'cap'
/**
 * The approver stopped on GONE (`ErrTmuxCaptureFailed`, `ErrTmuxSendKeys`)
 * from any of its calls, or on `ErrSpawnNotFound` from `read-pane` or
 * `send-keys` (b.jg5 SRJ-117, SRJ-118, SRJ-404).
 */
export const APPROVER_STOP_GONE = 'gone'
/**
 * The approver stopped on `ErrSpawnNotInteractive` with nothing typed (b.jg5
 * SRJ-118, SRJ-404): the session holding the name is not this launch's, by
 * its label's token, or the row has no launch start.
 */
export const APPROVER_STOP_NOT_INTERACTIVE = 'not-interactive'
/**
 * The approver stopped on ENVIRONMENT (`ErrTmuxNotAvailable`, b.jg5 SRJ-311,
 * SRJ-404); the wrapper raised the persona's `tmux-unavailable` outage, and
 * nothing is counted.
 */
export const APPROVER_STOP_TMUX_UNAVAILABLE = 'tmux-unavailable'
/**
 * The approver was stopped by the one-approver rule (b.jg5 SRJ-401; hatch
 * A2): a later launch of the persona started its own approver
 * (`startDialogApprover`), or a lap read a launch start other than the one
 * the approver kept. Either way the row belongs to a newer launch.
 */
export const APPROVER_STOP_SUPERSEDED = 'superseded'
/** The persona's teardown stopped the approver (b.jg5 SRJ-404, SRJ-715). */
export const APPROVER_STOP_TEARDOWN = 'teardown'
/**
 * The persona's key was recorded as retired (b.jg5 SRJ-808, SRJ-404): apply
 * step 1 stopped the approver right after its record, before the
 * last-applied rewrite and before the teardown's kill. No pending-row rule
 * run follows this stop.
 */
export const APPROVER_STOP_RETIRED_KEY = 'retired-key'
/** Shutdown stopped the approver (b.jg5 SRJ-404). */
export const APPROVER_STOP_SHUTDOWN = 'shutdown'
/**
 * The abort of the persona's own stuck launch began (b.jg5 SRJ-412, SRJ-404;
 * hatch A3): the pending-row rule stopped the approver before the abort's
 * kill (`stopApproverForStuckLaunchAbort`). No pending-row rule run follows
 * this stop, and it arms nothing (`APPROVER_STOPS_THAT_ARM`).
 */
export const APPROVER_STOP_STUCK_LAUNCH_ABORT = 'stuck-launch-abort'
/** The approver's loop threw (not reached: every step is guarded); the throw was logged and nothing more was called. */
export const APPROVER_STOP_FAILED = 'failed'

/**
 * Why the approver stopped: what `approvePreSessionDialogs` resolves with,
 * and the reason in an {@link ApproverOutcome}. Each kind of stop has its own
 * member, so a reader of the outcome tells which stops leave a `pending` row
 * to the pending-row rule (b.jg5 SRJ-404: B or the cap, GONE, not
 * interactive, tmux unavailable, superseded) from those that do not
 * (shutdown, latched, teardown, retired key, the stuck-launch abort).
 */
export type ApproverStopReason =
  | typeof APPROVER_STOP_LIVE
  | typeof APPROVER_STOP_FINISHED
  | typeof APPROVER_STOP_ABSENT
  | typeof APPROVER_STOP_LATCHED
  | typeof APPROVER_STOP_NO_LAUNCH_START
  | typeof APPROVER_STOP_BOUND
  | typeof APPROVER_STOP_CAP
  | typeof APPROVER_STOP_GONE
  | typeof APPROVER_STOP_NOT_INTERACTIVE
  | typeof APPROVER_STOP_TMUX_UNAVAILABLE
  | typeof APPROVER_STOP_SUPERSEDED
  | typeof APPROVER_STOP_TEARDOWN
  | typeof APPROVER_STOP_RETIRED_KEY
  | typeof APPROVER_STOP_SHUTDOWN
  | typeof APPROVER_STOP_STUCK_LAUNCH_ABORT
  | typeof APPROVER_STOP_FAILED

/**
 * The reasons a caller stops a persona's approver with (`stopDialogApprover`):
 * each is also the stopped approver's {@link ApproverStopReason}. One member
 * per kind of stop (the abort of the persona's own stuck launch included,
 * `APPROVER_STOP_STUCK_LAUNCH_ABORT`), so a reader of the outcome tells
 * which stops leave the row to the pending-row rule: none of these but
 * `superseded` does (b.jg5 SRJ-404).
 */
export type ApproverStopRequestReason =
  | typeof APPROVER_STOP_SUPERSEDED
  | typeof APPROVER_STOP_TEARDOWN
  | typeof APPROVER_STOP_RETIRED_KEY
  | typeof APPROVER_STOP_SHUTDOWN
  | typeof APPROVER_STOP_LATCHED
  | typeof APPROVER_STOP_STUCK_LAUNCH_ABORT

/** The approver's two time limits: B, or the test cap set in place of it. */
type ApproverLimitReason = typeof APPROVER_STOP_BOUND | typeof APPROVER_STOP_CAP

/** How one approver ended: why, and the launch start it kept (absent when no lap read the row `pending` with a launch start). */
export interface ApproverOutcome {
  readonly reason: ApproverStopReason
  /** Epoch ms of the launch start the approver's first lap whose `status` read the row `pending` with a launch start read. */
  readonly launchStartMs: number | undefined
}

/** The startup-errors class the approver writes, during a start-pass launch, when the row reads `ended` or `missing` (b.jg5 SRJ-402, SRJ-1013). */
export const STARTUP_ERROR_APPROVE_SPAWN_DIED = 'dev-channels-approve-spawn-died'
/** The startup-errors class the approver writes, during a start-pass launch, at B or its cap (b.jg5 SRJ-405). */
export const STARTUP_ERROR_APPROVE_NOT_READY = 'dev-channels-approve-not-ready'

/** The approver's site name, in its own log lines and in the own-row `status` read's lines. */
export const APPROVER_LOG_SITE = 'approvePreSessionDialogs'
/** What the approver's own-row `status` read is called in that read's lines (`OwnRowReadSite.what`). */
export const APPROVER_STATUS_READ_WHAT = 'readiness status read'
/** The head of every log line the approver writes itself. */
export const APPROVER_LOG_PREFIX = `[slack] ${APPROVER_LOG_SITE}: `
/** The pane lines one approver `read-pane` asks for (b.jg5 SRJ-402). */
export const APPROVER_PANE_LINES = 40

/** The agent-director verbs the approver calls. */
export type ApproverVerb = 'status' | 'read-pane' | 'send-keys'

/** B was measured from the launch start a lap kept. */
export const APPROVER_BOUND_FROM_LAUNCH_START = 'the launch start'
/** B was measured from the approver's own start: no lap had read a launch start. */
export const APPROVER_BOUND_FROM_APPROVER_START = "the approver's start"

/** Where B was measured from, in the at-B line ({@link approverBoundMessage}). */
export type ApproverBoundFrom = typeof APPROVER_BOUND_FROM_LAUNCH_START | typeof APPROVER_BOUND_FROM_APPROVER_START

/** One approver log line: {@link APPROVER_LOG_PREFIX} and `message`. */
export function approverLogLine(message: string): string {
  return `${APPROVER_LOG_PREFIX}${message}`
}

/** The message (log line and start-pass entry) for a row that read `ended` or `missing`. */
export function approverFinishedMessage(ref: string, state: string): string {
  return `${ref} reads ${renderLogMessageText(state)}: the launch is over, so the approver stops with no pane read and the restart path decides (b.jg5 SRJ-402)`
}

/** The message for an absent row (`ErrSpawnNotFound`); no startup-errors entry is written for it. */
export function approverAbsentMessage(ref: string): string {
  return `${ref} has no row (ErrSpawnNotFound): the approver stops; nothing is read or typed (b.jg5 SRJ-402)`
}

/** The message for a `pending` row with no launch start that latched nothing. */
export function approverNoLaunchStartMessage(ref: string): string {
  return `${ref} reads pending with no launch start: the approver stops; nothing is read or typed (b.jg5 SRJ-401, SRJ-513)`
}

/** The message for a state that is neither `pending`, live nor finished: nothing is read or typed this lap. */
export function approverUnknownStateMessage(ref: string, state: string): string {
  return `${ref} reads the state ${JSON.stringify(renderLogMessageText(state))}, which is neither pending, live nor finished — nothing read or typed; polling on within the bound`
}

/**
 * The message for a refused `status` whose class keeps the approver polling
 * (UNAVAILABLE, CONFIG, UNCLASSIFIED or a STATE name the approver gives no
 * meaning; b.jg5 SRJ-404). `failure` is the error already described by the
 * caller through `describeAgentDirectorFailure` (redacted); the builder never
 * sees the raw error.
 */
export function approverStatusRefusedMessage(ref: string, failure: string): string {
  return `status of ${ref} failed: ${failure} — polling on within the bound`
}

/**
 * The message for a failed `read-pane` or `send-keys` whose class keeps the
 * approver polling (UNAVAILABLE, CONFIG, UNCLASSIFIED, `ErrSendKeysWhileRelayed`
 * included, or a STATE name the approver gives no meaning; b.jg5 SRJ-117,
 * SRJ-118). `failure` is the error already described by the caller through
 * `describeAgentDirectorFailure` (redacted); the builder never sees the raw
 * error.
 */
export function approverPaneCallFailedMessage(ref: string, verb: 'read-pane' | 'send-keys', failure: string): string {
  return `${verb} of ${ref} failed: ${failure} — polling on within the bound`
}

/** The message for a GONE answer, or `ErrSpawnNotFound` from a pane verb: the approver stops. `failure` is already described (redacted). */
export function approverGoneMessage(ref: string, verb: ApproverVerb, failure: string): string {
  return `${verb} of ${ref} answered that the session is gone: ${failure} — the approver stops; nothing typed (b.jg5 SRJ-117, SRJ-118, SRJ-404)`
}

/**
 * The one line for `ErrSpawnNotInteractive` (b.jg5 SRJ-118, SRJ-404), naming
 * both possible causes. `failure` is already described (redacted).
 */
export function approverNotInteractiveMessage(ref: string, verb: ApproverVerb, failure: string): string {
  return (
    `${verb} of ${ref} answered that the row is not interactive: ${failure} — the session holding the name is not this ` +
    `launch's (by its label's token), or the row has no launch start; the approver stops with nothing typed and nothing killed (b.jg5 SRJ-118, SRJ-404)`
  )
}

/** The message for ENVIRONMENT (`ErrTmuxNotAvailable`): the approver stops. `failure` is already described (redacted). */
export function approverTmuxUnavailableMessage(ref: string, verb: ApproverVerb, failure: string): string {
  return `${verb} of ${ref} answered that tmux is not available: ${failure} — the approver stops; the tmux-unavailable outage is raised and nothing is counted (b.jg5 SRJ-311, SRJ-404)`
}

/**
 * The message for a CONFLICT answer: the persona latched (refused operation
 * "P's next check or recovery") and the approver stops. `failure` is already
 * described (redacted); `outcome` says what became of the latch.
 */
export function approverConflictMessage(ref: string, verb: ApproverVerb, failure: string, outcome: string): string {
  return `${verb} of ${ref} refused: ${failure} — CONFLICT: ${outcome}; the approver stops; nothing typed (b.jg5 SRJ-404, SRJ-501)`
}

/**
 * The message for an UNUSABLE NAME answer: the persona latched (refused
 * operation none) and the approver stops. `failure` is already described
 * (redacted); `outcome` says what became of the latch.
 */
export function approverUnusableNameMessage(ref: string, verb: ApproverVerb, failure: string, outcome: string): string {
  return `${verb} of ${ref} refused: ${failure} — UNUSABLE NAME: ${outcome}; the approver stops; nothing typed (b.jg5 SRJ-404, SRJ-512)`
}

/** The message for a persona found latched before a lap or after an awaited call: the approver stops with no further call. */
export function approverLatchedMessage(ref: string): string {
  return `${ref} is latched — the approver stops; nothing more is read or typed (b.jg5 SRJ-502)`
}

/** The message (log line and start-pass entry) at B: nothing is posted (b.jg5 SRJ-405). */
export function approverBoundMessage(ref: string, boundMs: number, measuredFrom: ApproverBoundFrom): string {
  return (
    `spawn never reached a live state within B (${boundMs}ms from ${measuredFrom}) for ${ref} — dialog unrecognized or session hung ` +
    `(dev-needle='${DEV_CHANNELS_DIALOG_NEEDLE}'); the approver stops and nothing is posted (b.jg5 SRJ-404, SRJ-405)`
  )
}

/** The message (log line and start-pass entry) at the test cap: nothing is posted (b.jg5 SRJ-405). */
export function approverCapMessage(ref: string, capMs: number): string {
  return (
    `spawn never reached a live state within ${capMs}ms for ${ref} — dialog unrecognized or session hung ` +
    `(dev-needle='${DEV_CHANNELS_DIALOG_NEEDLE}'); the approver stops at its cap and nothing is posted (b.jg5 SRJ-404, SRJ-405)`
  )
}

/** The message for a lap that read a launch start other than the one the approver kept: it stops with nothing typed. */
export function approverLaunchStartChangedMessage(ref: string): string {
  return `${ref} reads pending with a launch start other than the one this approver kept: the row belongs to a newer launch, whose own approver works on it — this approver stops; nothing read or typed (b.jg5 SRJ-401)`
}

/**
 * Why each requested stop happened, in {@link approverStopRequestedMessage}'s
 * line. Keyed by every {@link ApproverStopRequestReason}, so a new reason does
 * not compile without its text.
 */
const APPROVER_STOP_REQUEST_WHY: Readonly<Record<ApproverStopRequestReason, string>> = {
  [APPROVER_STOP_SUPERSEDED]: 'a later launch started its own approver',
  [APPROVER_STOP_TEARDOWN]: 'its teardown began',
  [APPROVER_STOP_RETIRED_KEY]: 'its key was recorded as retired',
  [APPROVER_STOP_SHUTDOWN]: 'the server is shutting down',
  [APPROVER_STOP_LATCHED]: 'the persona latched',
  [APPROVER_STOP_STUCK_LAUNCH_ABORT]: "CSCB is aborting the persona's own stuck launch, and its kill follows; no pending-row run follows this stop",
}

/** The message for a stop of a running approver (`stopDialogApprover`, `startDialogApprover` superseding one, the latch's set observer). */
export function approverStopRequestedMessage(ref: string, reason: ApproverStopRequestReason): string {
  return `stopping the approver for ${ref} (${reason}): ${APPROVER_STOP_REQUEST_WHY[reason]}; it makes no further call (b.jg5 SRJ-401, SRJ-404)`
}

/** The message for an approver not started because its persona was stopped while its launch was in flight, or after shutdown. */
export function approverNotStartedMessage(ref: string, reason: ApproverStopRequestReason): string {
  return `not starting the approver for ${ref} (${reason}): it was stopped before its launch returned; nothing read or typed (b.jg5 SRJ-404)`
}

/** The message for an approver whose loop threw. `failure` is already described (`describeThrownValue`). */
export function approverFailedMessage(ref: string, failure: string): string {
  return `the approver for ${ref} failed: ${failure} — it stops; nothing more is called`
}

/** An approver started because a launch call of the persona returned success (`afterLaunchSucceeded`; b.jg5 SRJ-401). */
export const APPROVER_ORIGIN_AFTER_LAUNCH = 'after-launch'
/**
 * An approver started after a launch call of the persona ended in a launch
 * timeout and the one `get` that followed read a covered `pending` row
 * (`afterLaunchUnavailable`; b.jg5 SRJ-401, SRJ-407).
 */
export const APPROVER_ORIGIN_LAUNCH_TIMEOUT = 'launch-timeout'

/** Why an approver is started (`startDialogApprover`). */
export type ApproverOrigin = typeof APPROVER_ORIGIN_AFTER_LAUNCH | typeof APPROVER_ORIGIN_LAUNCH_TIMEOUT

/**
 * What the start entry (`startDialogApprover`) is told about why it starts
 * an approver: after a launch that returned, with nothing more; or after a
 * launch timeout, with the decision the pending-row step made on the row the
 * `get` read (`cover`, `decidePendingRowCover`) and that row's raw launch
 * start (`launchStartedAt`), which the entry checks before it starts one.
 */
export type ApproverStart =
  | { readonly origin: typeof APPROVER_ORIGIN_AFTER_LAUNCH }
  | {
      readonly origin: typeof APPROVER_ORIGIN_LAUNCH_TIMEOUT
      readonly cover: PendingRowCover
      readonly launchStartedAt: unknown
    }

/** The start entry's default: an approver after a launch that returned. */
export const APPROVER_START_AFTER_LAUNCH: ApproverStart = Object.freeze({ origin: APPROVER_ORIGIN_AFTER_LAUNCH })

/** The message for an approver started after a launch timeout (b.jg5 SRJ-401, SRJ-407). */
export function approverStartedAfterLaunchTimeoutMessage(ref: string): string {
  return `starting the approver for ${ref} (${APPROVER_ORIGIN_LAUNCH_TIMEOUT}): its launch call timed out and the get after it read its pending row covered — the approver runs after the launch call returned, under the same stop rules as after a returned launch (b.jg5 SRJ-401, SRJ-404, SRJ-407)`
}

/**
 * The message for an approver the start entry refuses after a launch timeout
 * because the row the `get` read is not covered, is undecided or has no
 * launch start (b.jg5 SRJ-401, SRJ-407); `why` says which.
 */
export function approverRefusedRowMessage(ref: string, why: string): string {
  return `not starting the approver for ${ref} (${APPROVER_ORIGIN_LAUNCH_TIMEOUT}): its pending row ${why} — no status, read-pane or send-keys (b.jg5 SRJ-401, SRJ-407)`
}

/**
 * Why the start entry refuses an approver after a launch timeout, in
 * `approverRefusedRowMessage`'s words, or `undefined` when it may start one:
 * the decision is covered and the row's launch start parses. Pure.
 */
function approverRowRefusal(start: ApproverStart): string | undefined {
  if (start.origin !== APPROVER_ORIGIN_LAUNCH_TIMEOUT) return undefined
  const { cover } = start
  switch (cover.answer) {
    case PENDING_ROW_NO_LAUNCH_START:
      return 'has no launch start'
    case PENDING_ROW_NOT_COVERED:
      return `is not covered (${cover.reason})`
    case PENDING_ROW_UNDECIDED:
      return `is undecided (${cover.reason})`
    case PENDING_ROW_COVERED:
      return parseLaunchStart(start.launchStartedAt) === undefined ? 'has no launch start' : undefined
  }
}

/** Every pre-SessionStart dialog the approver answers (option 1 pre-selected; Enter accepts). Both kept: a folder-trust prompt can follow a `pre_trust` of `skipped` or `failed`. */
const PRE_SESSION_DIALOG_NEEDLES = [TRUST_DIALOG_NEEDLE, DEV_CHANNELS_DIALOG_NEEDLE]

/**
 * One armed time limit of an approver (B, or the cap): its reason, where B
 * was measured from, the plain check of whether it has passed at a given now
 * (against the wait in effect then: B's accessor itself, so a value raised
 * while armed never ends it early), and the cancel of its never-early timer.
 */
interface ApproverLimit {
  readonly reason: ApproverLimitReason
  readonly measuredFrom: ApproverBoundFrom
  readonly passed: (nowMs: number) => boolean
  readonly cancel: () => void
}

/**
 * One approver's state, shared by its loop and its stops. The registry
 * (`startDialogApprover`) keeps one per running approver; a direct
 * `approvePreSessionDialogs` call makes its own.
 */
interface ApproverRun {
  /**
   * Set by the first stop asked of this approver (`stopDialogApprover`, a
   * later start, the latch's set observer, the reset seam): its reason. The
   * approver sets `latched` itself right before it latches the persona on
   * its own CONFLICT or UNUSABLE NAME answer, so the set observer finds it
   * already stopping.
   */
  stopRequested: ApproverStopRequestReason | undefined
  /** Set when B (or the cap) has passed: the approver stops before its next call. */
  limitReached: ApproverLimitReason | undefined
  /** The armed limit, while the loop runs. */
  limit: ApproverLimit | undefined
  /** Wakes the approver's sleep between laps, while it sleeps. */
  wake: (() => void) | undefined
  /**
   * The launch start (epoch ms) the first lap whose `status` read the row
   * `pending` with a launch start read (b.jg5 SRJ-401; hatch A2). A lap whose
   * `status` failed sets nothing.
   */
  launchStartMs: number | undefined
  /**
   * The row state the approver's latest own-row `status` read gave, if any
   * read answered a row (b.jg5 SRJ-404): at its stop, a row last read
   * `pending`, or none read, is armed for (`armAfterApproverStop`).
   */
  lastStateRead: string | undefined
  /**
   * The raw launch start the approver's latest own-row `status` read carried
   * (`undefined` for a read that showed none, or a state other than
   * `pending`): with `lastStateRead`, the row read the pending-row rule's one
   * run at the approver's stop runs on (b.jg5 SRJ-404, SRJ-410).
   */
  lastLaunchStartedAt: unknown
  /**
   * The window of the launch call that started this approver
   * (`launchCallWindowOf` when the registry started it; b.jg5 SRJ-407,
   * SRJ-412), or `undefined` for an approver run directly
   * (`approvePreSessionDialogs`), which takes the persona's latest window at
   * its first lap. The first lap that keeps a launch start records CSCB's own
   * launch only while this is still the persona's latest window.
   */
  readonly launchWindow: LaunchCallWindowRecord | undefined
}

/** A fresh approver state: no stop asked, no limit armed, no launch start kept; `launchWindow` the window of the launch call that started it, if known. */
function newApproverRun(launchWindow?: LaunchCallWindowRecord): ApproverRun {
  return {
    stopRequested: undefined,
    limitReached: undefined,
    limit: undefined,
    wake: undefined,
    launchStartMs: undefined,
    lastStateRead: undefined,
    lastLaunchStartedAt: undefined,
    launchWindow,
  }
}

/** What one approver loop works with: the persona, its run and the clock it took at its start. */
interface ApproverContext {
  readonly key: string
  readonly isStartup: boolean
  readonly ref: string
  readonly at: OwnRowReadSite
  readonly run: ApproverRun
  readonly clock: ApproverClock
}

/**
 * Arm `run`'s time limit (`reason`) from the approver's own start `fromMs`
 * (a time on `clock`, never a row's launch start) with `waitMs`, through
 * `armNeverEarlyWait` on `clock`, replacing (and cancelling) any limit armed
 * before. The timer marks the limit reached and wakes any sleep. The limit's
 * check compares the time since `fromMs` with the wait in effect (a wait
 * that cannot be read is not reached).
 */
function armApproverLimit(
  clock: ApproverClock,
  run: ApproverRun,
  reason: ApproverLimitReason,
  fromMs: number,
  waitMs: () => number,
): void {
  run.limit?.cancel()
  const cancel = armNeverEarlyWait(clock, fromMs, waitMs, () => markApproverLimit(run, reason))
  const passed = (nowMs: number): boolean => {
    let currentWaitMs: number
    try {
      currentWaitMs = waitMs()
    } catch {
      return false
    }
    return nowMs - fromMs >= currentWaitMs
  }
  run.limit = { reason, measuredFrom: APPROVER_BOUND_FROM_APPROVER_START, passed, cancel }
}

/**
 * Re-arm `run`'s B from the launch start `launchStartedAt` names (raw, as
 * the lap's `status` read carried it), through `armPendingRowWait`
 * (`src/pending-row.ts`) with `adLaunchBoundMsInEffect` itself, replacing
 * (and cancelling) the limit armed before; its check is `isPendingRowAged`
 * against B in effect (b.jg5 SRJ-406: measured from the launch start, never
 * `started_at`). A launch start that is absent or does not parse arms
 * nothing and keeps the limit armed before (SRJ-408: never aged).
 */
function armApproverBoundFromLaunchStart(clock: ApproverClock, run: ApproverRun, launchStartedAt: unknown): void {
  const armed = armPendingRowWait(clock, launchStartedAt, adLaunchBoundMsInEffect, () =>
    markApproverLimit(run, APPROVER_STOP_BOUND),
  )
  if (armed === PENDING_ROW_WAIT_NOT_ARMED) return
  run.limit?.cancel()
  const passed = (nowMs: number): boolean => isPendingRowAged(launchStartedAt, adLaunchBoundMsInEffect, nowMs)
  run.limit = { reason: APPROVER_STOP_BOUND, measuredFrom: APPROVER_BOUND_FROM_LAUNCH_START, passed, cancel: armed.cancel }
}

/** Mark `run`'s limit reached (the first mark is kept) and wake its sleep. */
function markApproverLimit(run: ApproverRun, reason: ApproverLimitReason): void {
  if (run.limitReached !== undefined) return
  run.limitReached = reason
  run.wake?.()
}

/**
 * Why the approver must stop now, before its next call, or `undefined`: a
 * stop asked of it first, then its limit, checked with the timer's mark and
 * by a plain `elapsed >= wait` comparison against the wait in effect now (a
 * wait that cannot be read is not reached).
 */
function approverStopMark(ctx: ApproverContext): ApproverStopReason | undefined {
  const { run } = ctx
  if (run.stopRequested !== undefined) return run.stopRequested
  const limit = run.limit
  if (run.limitReached === undefined && limit !== undefined && limit.passed(ctx.clock.now())) {
    markApproverLimit(run, limit.reason)
  }
  return run.limitReached
}

/**
 * The stop mark (`approverStopMark`), else `latched` when the persona is
 * latched now (`personaLatchedNow`), after one line: a persona latched
 * before a lap, or while a call was awaited, gets no further call (b.jg5
 * SRJ-502). `undefined` to go on.
 */
function approverStopOrLatched(ctx: ApproverContext): ApproverStopReason | undefined {
  const mark = approverStopMark(ctx)
  if (mark !== undefined) return mark
  if (!personaLatchedNow(ctx.key)) return undefined
  console.error(approverLogLine(approverLatchedMessage(ctx.ref)))
  return APPROVER_STOP_LATCHED
}

/**
 * Drive a launched bot past its pre-SessionStart dialogs (folder-trust and
 * dev-channels) through agent-director only (b.jg5 SRJ-402). A launch,
 * fresh or resumed, reads `pending` until its session reports in (HO C5),
 * so every lap works on the `pending` row:
 *
 *   - before the lap, a persona already latched stops it with no call
 *     (`latched`, b.jg5 SRJ-502);
 *   - one own-row `status` read (`readPersonaOwnRowStatus`, which applies
 *     the own-row `status` step): a read that latched the persona stops the
 *     approver with nothing read or typed (`latched`); `ErrSpawnNotFound`
 *     stops it with one line and no startup-errors entry (`absent`); any
 *     other refusal takes the class rules below;
 *   - a live state other than `pending` stops it (`live`);
 *   - `ended` or `missing` stops it at once with no pane read and one line,
 *     and a start-pass launch writes `dev-channels-approve-spawn-died`
 *     (`finished`); the restart path decides what follows;
 *   - `pending` with no launch start (`isPendingWithNoLaunchStart`) that the
 *     read did not latch stops it with one line and nothing read or typed
 *     (`no-launch-start`); a configured persona's such row is latched by the
 *     read (`latched`), so this stop is reached only with no configured-persona
 *     query installed or one that does not answer `key` as configured;
 *   - `pending` with a launch start: the first such lap keeps that launch
 *     start, and B is re-armed from it; a later lap that reads another one
 *     stops the approver with one line and nothing read or typed
 *     (`superseded`, b.jg5 SRJ-401; hatch A2: the row belongs to a newer
 *     launch). Otherwise one `read-pane` (40 lines, `allow_pending`), and
 *     when the pane shows a needle of `PRE_SESSION_DIALOG_NEEDLES`, one
 *     `send-keys` with an empty text and `allow_pending`, which presses
 *     Enter.
 *
 * Each refused call is classified by class and name through
 * `src/ad-error-class.ts` (b.jg5 SRJ-117, SRJ-118, SRJ-404), with one line:
 *
 *   - GONE, or `ErrSpawnNotFound` from `read-pane` or `send-keys`: stop
 *     (`gone`);
 *   - `ErrSpawnNotInteractive`: stop with nothing typed and nothing killed
 *     (`not-interactive`); from `send-keys` only, the launch start the first
 *     lap kept is also recorded as a launch that met it
 *     (`recordSendKeysNotInteractive`; b.jg5 SRJ-118, SRJ-412, SRJ-1017),
 *     even when a stop asked during that call decides the stop's reason; a
 *     `read-pane` answer of that name records nothing;
 *   - CONFLICT: the persona latches through the latch's CONFLICT entry
 *     (`setFromConflict`) with the refused operation "P's next check or
 *     recovery" and the recorded state `pending` (unreadable for a `status`
 *     answer, which read none); stop (`latched`);
 *   - UNUSABLE NAME: the persona latches with the case "unusable recorded
 *     name" and the refused operation none (`latchOnUnusableName`), recorded
 *     `pending`; stop with nothing typed (`latched`);
 *   - ENVIRONMENT (`ErrTmuxNotAvailable`): stop (`tmux-unavailable`); the
 *     wrapper raised the outage, and nothing is counted;
 *   - UNAVAILABLE and CONFIG: poll on within B, the next lap at the slow
 *     pace (backing off; the wrapper raised `ad-config-malformed` for
 *     CONFIG and armed the persona's retry timer as from any verb);
 *   - anything else (UNCLASSIFIED, `ErrSendKeysWhileRelayed` included, or a
 *     STATE name the approver gives no meaning): poll on within B at the pace
 *     in effect.
 *
 * Every call names only the persona's `claude_instance_id`, and the server
 * runs no tmux command here; agent-director answers each call by the row's
 * current launch (HO rev 17). The pane a lap reads may be a single
 * leftover's: with no session of this launch there and exactly one leftover
 * of the persona, `read-pane` answers the leftover's pane (b.jg5 SRJ-117,
 * SRJ-613), so a needle on it is no proof that this launch's session shows
 * the dialog. The lap acts on it only through its Enter `send-keys`, which is
 * the backstop: on a `pending` row whose session is not this launch's (by its
 * label's token), it answers `ErrSpawnNotInteractive`, and the approver stops
 * with nothing typed, no kill and one log line (`not-interactive`, b.jg5
 * SRJ-404); a CONFLICT there latches the persona and stops it.
 *
 * Pace (b.jg5 SRJ-403): each lap starts at least `DIALOG_POLL_INTERVAL_MS`
 * after the previous lap's `read-pane` call (or, when the previous lap read
 * no pane, after its start), and `DIALOG_SLOW_POLL_INTERVAL_MS` after it
 * once G has passed since the launch start that lap's `status` read carried,
 * or after a lap that backed off (`approverPaceMs`). Two `read-pane` calls
 * are so never closer than the pace in effect, whatever the `status` reads
 * between them take.
 *
 * B (b.jg5 SRJ-210, SRJ-404): armed never-early (`armNeverEarlyWait` with
 * `adLaunchBoundMsInEffect` itself) from the approver's own start until a
 * lap keeps a launch start, then re-armed from that launch start through
 * `armPendingRowWait` (`src/pending-row.ts`; SRJ-406: never from
 * `started_at`); also checked by a plain comparison before each call
 * (`isPendingRowAged` once measured from the launch start). While the test cap
 * (`_setDialogReadyTimeoutMs`) is set, the cap is armed from the approver's
 * own start in place of B. All of it runs on the approver's clock
 * (`_setApproverClock`). At B or the cap it logs one line and, for a
 * start-pass launch, writes `dev-channels-approve-not-ready`; nothing is
 * posted to any notifier (b.jg5 SRJ-405). Resolves with why it stopped;
 * never rejects.
 *
 * Production starts an approver only through the registry
 * (`startDialogApprover`), which runs it outside every launch or recovery
 * attempt and stops it on request; direct calls are for tests. A direct
 * call runs one approver outside the registry, so nothing can stop it but
 * its own rules, and outside every launch or recovery attempt
 * (`runOutsideAttempts`), whatever attempt the caller runs in.
 */
export async function approvePreSessionDialogs(
  key: string,
  isStartup: boolean,
  ref: string = keyRef(key),
): Promise<ApproverStopReason> {
  return runOutsideAttempts(() => runApproverLoop(key, isStartup, ref, newApproverRun()))
}

/**
 * The approver's loop (`approvePreSessionDialogs`) over `run`: a stop asked
 * of `run`, or its limit, wakes its sleep at once and is checked before each
 * agent-director call, so no call follows a stop; the approver then resolves
 * with the stop's reason. Never rejects.
 */
async function runApproverLoop(key: string, isStartup: boolean, ref: string, run: ApproverRun): Promise<ApproverStopReason> {
  const clock = _approverClock
  const capMs = _dialogReadyTimeoutMs
  const ctx: ApproverContext = {
    key,
    isStartup,
    ref,
    at: { site: APPROVER_LOG_SITE, what: APPROVER_STATUS_READ_WHAT, ref },
    run,
    clock,
  }
  const startMs = clock.now()
  if (capMs !== undefined) {
    armApproverLimit(clock, run, APPROVER_STOP_CAP, startMs, () => capMs)
  } else {
    // b.jg5 SRJ-404, SRJ-406: before any launch start is read, B runs from the approver's own start.
    armApproverLimit(clock, run, APPROVER_STOP_BOUND, startMs, adLaunchBoundMsInEffect)
  }
  let reason: ApproverStopReason
  try {
    for (;;) {
      const lapStartMs = clock.now()
      const lap = await approverLap(ctx)
      if (typeof lap === 'string') {
        reason = lap
        break
      }
      const mark = approverStopMark(ctx)
      if (mark !== undefined) {
        reason = mark
        break
      }
      const paceMs = approverPaceMs(lap.backOff, lap.launchStartedAt, clock.now(), adGraceMsInEffect)
      // b.jg5 SRJ-403: the pace runs from the lap's pane read, so the next
      // read (after the next lap's `status` read) is never closer than it.
      const paceFromMs = lap.paneReadAtMs ?? lapStartMs
      if (clock.now() - paceFromMs < paceMs) await sleepUntilNextLap(ctx, paceFromMs, paceMs)
    }
  } finally {
    run.wake = undefined
    run.limit?.cancel()
  }
  if (reason === APPROVER_STOP_BOUND || reason === APPROVER_STOP_CAP) approverLimitReached(ctx, reason, capMs)
  return reason
}

/**
 * Sleep from `fromMs` (the lap's pane read, or its start when it read no
 * pane) until `paceMs` has passed on the approver's clock (never early:
 * `armNeverEarlyWait`), or until a stop or the limit wakes it.
 */
function sleepUntilNextLap(ctx: ApproverContext, fromMs: number, paceMs: number): Promise<void> {
  const { run, clock } = ctx
  return new Promise<void>((resolve) => {
    const done = (): void => {
      run.wake = undefined
      resolve()
    }
    const cancel = armNeverEarlyWait(clock, fromMs, paceMs, done)
    run.wake = () => {
      cancel()
      done()
    }
  })
}

/**
 * At B or the cap (b.jg5 SRJ-405): one server-log line and, for a start-pass
 * launch, the `dev-channels-approve-not-ready` entry. Nothing is posted to
 * Slack.
 */
function approverLimitReached(ctx: ApproverContext, reason: ApproverLimitReason, capMs: number | undefined): void {
  const msg =
    reason === APPROVER_STOP_CAP && capMs !== undefined
      ? approverCapMessage(ctx.ref, capMs)
      : approverBoundMessage(
          ctx.ref,
          adLaunchBoundMsInEffect(),
          ctx.run.limit?.measuredFrom ?? APPROVER_BOUND_FROM_APPROVER_START,
        )
  console.error(approverLogLine(msg))
  if (ctx.isStartup) recordStartupError(STARTUP_ERROR_APPROVE_NOT_READY, msg)
}

/**
 * Keep `launchStartMs`, the first launch start a lap read (b.jg5 SRJ-401),
 * and re-arm B from it (b.jg5 SRJ-404, SRJ-406: B runs from the approver's own
 * start only until a lap reads a launch start). The approver's start is
 * never earlier than the launch start, so the bound armed first was never
 * early. With the test cap set nothing is re-armed. `launchStartedAt` is
 * the raw launch start the lap read and `launchStartMs` its instant
 * (`parseLaunchStart`); B is re-armed from the raw value through
 * `armApproverBoundFromLaunchStart`, which arms nothing for one that does
 * not parse.
 *
 * b.jg5 SRJ-412, SRJ-407: when the launch call that started the approver
 * (`run.launchWindow`, or, for an approver run directly, the persona's
 * latest window) is still the persona's latest, returned success
 * (`LAUNCH_CALL_END_RETURNED`) and the kept launch start lies inside its
 * window, the launch is recorded as CSCB's own (`recordOwnLaunch`); the
 * record outlives the approver, for the pending-row rule's step 3. A launch
 * start outside the window, a window with no end or a launch-timeout window
 * (recorded by `afterLaunchUnavailable` instead) records nothing here.
 */
function keepApproverLaunchStart(ctx: ApproverContext, launchStartedAt: unknown, launchStartMs: number): void {
  const { run } = ctx
  run.launchStartMs = launchStartMs
  recordOwnLaunch(ctx.key, run.launchWindow ?? launchCallWindowOf(ctx.key), LAUNCH_CALL_END_RETURNED, launchStartedAt)
  if (run.limit === undefined || run.limit.reason !== APPROVER_STOP_BOUND) return
  armApproverBoundFromLaunchStart(ctx.clock, run, launchStartedAt)
}

/**
 * How a lap that stops nothing ended: whether it backed off, the raw launch
 * start its `status` read carried (`undefined` when it read none), and when
 * (on the approver's clock) it made its `read-pane` call, `undefined` when
 * it made none (b.jg5 SRJ-403: the pace runs from it).
 */
interface ApproverLapGoesOn {
  readonly backOff: boolean
  readonly launchStartedAt: unknown
  readonly paneReadAtMs: number | undefined
}

/** What the approver does with one refused call: stop with a reason, or poll on (backing off or not). */
type ApproverAnswer = { readonly stop: ApproverStopReason } | { readonly backOff: boolean }

/**
 * One approver lap (`approvePreSessionDialogs`): answers the stop reason, or
 * how the lap ended to poll on. A stop asked of the approver during a call
 * is answered as soon as that call returns, before anything else, except
 * that a pane call's CONFLICT or UNUSABLE NAME answer still latches the
 * persona first (`approverStoppedDuringCall`). Never throws.
 */
async function approverLap(ctx: ApproverContext): Promise<ApproverStopReason | ApproverLapGoesOn> {
  const { key, isStartup, ref, at, run } = ctx
  const before = approverStopOrLatched(ctx)
  if (before !== undefined) return before

  const read = await readPersonaOwnRowStatus(key, at)
  if (run.stopRequested !== undefined) return run.stopRequested
  if (read.kind === OWN_ROW_STATUS_LATCHED) return APPROVER_STOP_LATCHED // the step logged its line
  if (personaLatchedNow(key)) {
    console.error(approverLogLine(approverLatchedMessage(ref)))
    return APPROVER_STOP_LATCHED
  }
  if (read.kind === OWN_ROW_STATUS_ABSENT) {
    console.error(approverLogLine(approverAbsentMessage(ref)))
    return APPROVER_STOP_ABSENT
  }
  if (read.kind === OWN_ROW_STATUS_REFUSED) {
    // A failed read keeps no launch start (b.jg5 SRJ-401; hatch A2).
    const answer = approverAnswerTo(ctx, 'status', read.error)
    return 'stop' in answer ? answer.stop : { backOff: answer.backOff, launchStartedAt: undefined, paneReadAtMs: undefined }
  }

  const state = read.state
  run.lastStateRead = state
  run.lastLaunchStartedAt = read.launchStartedAt
  if (AGENT_DIRECTOR_DEAD_STATES.has(state)) {
    const msg = approverFinishedMessage(ref, state)
    console.error(approverLogLine(msg))
    if (isStartup) recordStartupError(STARTUP_ERROR_APPROVE_SPAWN_DIED, msg)
    return APPROVER_STOP_FINISHED
  }
  if (state !== AGENT_DIRECTOR_PENDING_STATE) {
    if (AGENT_DIRECTOR_LIVE_STATES.has(state)) return APPROVER_STOP_LIVE
    console.error(approverLogLine(approverUnknownStateMessage(ref, state)))
    return { backOff: false, launchStartedAt: undefined, paneReadAtMs: undefined }
  }
  const launchStartedAt = read.launchStartedAt
  const launchStartMs = parseLaunchStart(launchStartedAt)
  if (launchStartMs === undefined) {
    // `pending` with no launch start, or one that does not parse (as `isPendingWithNoLaunchStart` reads it).
    console.error(approverLogLine(approverNoLaunchStartMessage(ref)))
    return APPROVER_STOP_NO_LAUNCH_START
  }
  // b.jg5 SRJ-401 (hatch A2): the first lap that reads a launch start keeps
  // it; a later one that reads another belongs to a newer launch.
  if (run.launchStartMs === undefined) {
    keepApproverLaunchStart(ctx, launchStartedAt, launchStartMs)
  } else if (run.launchStartMs !== launchStartMs) {
    console.error(approverLogLine(approverLaunchStartChangedMessage(ref)))
    return APPROVER_STOP_SUPERSEDED
  }
  const beforePane = approverStopMark(ctx)
  if (beforePane !== undefined) return beforePane

  const claude_instance_id = personaInstanceId(key)
  // b.jg5 SRJ-403: the next lap is paced from this pane read.
  const goesOn: ApproverLapGoesOn = { backOff: false, launchStartedAt, paneReadAtMs: ctx.clock.now() }
  let pane: string
  try {
    const result = await withOutageDetection(key, undefined, 'read-pane', (client) =>
      client.readPane({ claude_instance_id, n_lines: APPROVER_PANE_LINES, allow_pending: true }),
    )
    pane = result.pane
  } catch (err) {
    if (run.stopRequested !== undefined) return approverStoppedDuringCall(ctx, 'read-pane', err, run.stopRequested)
    const answer = approverAnswerTo(ctx, 'read-pane', err)
    return 'stop' in answer ? answer.stop : { ...goesOn, backOff: answer.backOff }
  }
  const afterPane = approverStopOrLatched(ctx)
  if (afterPane !== undefined) return afterPane
  if (!paneShowsStartupDialog(pane)) return goesOn
  try {
    // An empty text presses Enter. The pane may be a single leftover's
    // (b.jg5 SRJ-613): this `send-keys` is the backstop, and its
    // `ErrSpawnNotInteractive` stops the approver with nothing typed and no
    // kill (SRJ-404).
    await withOutageDetection(key, undefined, 'send-keys', (client) =>
      client.sendKeys({ claude_instance_id, text: '', allow_pending: true }),
    )
  } catch (err) {
    // b.jg5 SRJ-118, SRJ-412, SRJ-1017: a `send-keys` that answered
    // `ErrSpawnNotInteractive` makes this launch (the launch start the first
    // lap kept) no longer CSCB's own, whatever stops the approver.
    if (hasAdErrorName(err, ERR_SPAWN_NOT_INTERACTIVE_NAME)) recordSendKeysNotInteractive(key, run.launchStartMs)
    if (run.stopRequested !== undefined) return approverStoppedDuringCall(ctx, 'send-keys', err, run.stopRequested)
    const answer = approverAnswerTo(ctx, 'send-keys', err)
    return 'stop' in answer ? answer.stop : { ...goesOn, backOff: answer.backOff }
  }
  if (run.stopRequested !== undefined) return run.stopRequested
  return goesOn
}

/**
 * The approver's one classification of a refused call (b.jg5 SRJ-117,
 * SRJ-118, SRJ-404), by class and name through `src/ad-error-class.ts`
 * (never `instanceof`), with one line from an exported builder carrying the
 * persona reference and the redacted description: see
 * `approvePreSessionDialogs` for the table. A `status` read's
 * `ErrSpawnNotFound` and UNUSABLE NAME answers never reach here (the shared
 * read answers absent and latched). Never throws.
 */
function approverAnswerTo(ctx: ApproverContext, verb: ApproverVerb, err: unknown): ApproverAnswer {
  const { ref } = ctx
  const { errorClass } = classifyAdError(err)
  const failure = describeAgentDirectorFailure(err)
  if (errorClass === AD_ERROR_CLASS_GONE || (verb !== 'status' && hasAdErrorName(err, ERR_SPAWN_NOT_FOUND_NAME))) {
    console.error(approverLogLine(approverGoneMessage(ref, verb, failure)))
    return { stop: APPROVER_STOP_GONE }
  }
  if (hasAdErrorName(err, ERR_SPAWN_NOT_INTERACTIVE_NAME)) {
    console.error(approverLogLine(approverNotInteractiveMessage(ref, verb, failure)))
    return { stop: APPROVER_STOP_NOT_INTERACTIVE }
  }
  if (approverLatchOn(ctx, verb, err, errorClass, failure)) return { stop: APPROVER_STOP_LATCHED }
  if (errorClass === AD_ERROR_CLASS_ENVIRONMENT) {
    console.error(approverLogLine(approverTmuxUnavailableMessage(ref, verb, failure)))
    return { stop: APPROVER_STOP_TMUX_UNAVAILABLE }
  }
  const message =
    verb === 'status' ? approverStatusRefusedMessage(ref, failure) : approverPaneCallFailedMessage(ref, verb, failure)
  console.error(approverLogLine(message))
  // CONFIG is taken as the UNAVAILABLE column (b.jg5 SRJ-117, SRJ-118): both back off.
  return { backOff: errorClass === AD_ERROR_CLASS_UNAVAILABLE || errorClass === AD_ERROR_CLASS_CONFIG }
}

/**
 * The two classes that latch at the approver (b.jg5 SRJ-117, SRJ-118):
 * for a CONFLICT or UNUSABLE NAME answer `err` to `verb` (`errorClass`, with
 * `failure` its redacted description), latch the persona through the
 * installed latch's entry for the class and log one line carrying what
 * became of the latch. The approver is marked stopping (`latched`) first
 * unless a stop was already asked, so the latch's set observer finds it
 * stopping. Answers whether `err` was of either class; for any other class
 * it does nothing. Never throws.
 */
function approverLatchOn(
  ctx: ApproverContext,
  verb: ApproverVerb,
  err: unknown,
  errorClass: AdErrorClass,
  failure: string,
): boolean {
  const { ref } = ctx
  if (errorClass === AD_ERROR_CLASS_CONFLICT) {
    // The latch is set first; its line then carries what became of it.
    logApproverLine(approverConflictMessage(ref, verb, failure, approverLatchOnConflict(ctx, verb, err)))
    return true
  }
  if (errorClass === AD_ERROR_CLASS_UNUSABLE_NAME) {
    ctx.run.stopRequested ??= APPROVER_STOP_LATCHED // the latch's set observer then finds it stopping
    logApproverLine(approverUnusableNameMessage(ref, verb, failure, latchOnUnusableName(ctx.key, err, approverLatchRowState(verb))))
    return true
  }
  return false
}

/**
 * A pane call (`verb`) refused with `err` after a stop was asked of the
 * approver (`requested`: superseded, latched, teardown or shutdown) while
 * the call was in progress. A CONFLICT or UNUSABLE NAME answer still latches
 * the persona with its one line (`approverLatchOn`; a persona already
 * latched answers as the latch's entry does for a same-case set); every
 * other answer is dropped with no line. Either way the approver honours the
 * stop already asked, answering its reason, and types nothing more. Never
 * throws.
 */
function approverStoppedDuringCall(
  ctx: ApproverContext,
  verb: ApproverVerb,
  err: unknown,
  requested: ApproverStopRequestReason,
): ApproverStopReason {
  const { errorClass } = classifyAdError(err)
  if (errorClass === AD_ERROR_CLASS_CONFLICT || errorClass === AD_ERROR_CLASS_UNUSABLE_NAME) {
    approverLatchOn(ctx, verb, err, errorClass, describeAgentDirectorFailure(err))
  }
  return requested
}

/** One approver line (`approverLogLine`) to the server log; `message` comes from an exported builder. */
function logApproverLine(message: string): void {
  console.error(approverLogLine(message))
}

/** The latch line's outcome text for what `setFromConflict` answered (`undefined`: the value was not CONFLICT, so nothing latched). */
function conflictSetOutcomeText(outcome: ConflictLatchSetOutcome | undefined): string {
  return outcome === undefined ? 'nothing is latched (the answer is not CONFLICT)' : LATCH_SET_OUTCOME_TEXT[outcome]
}

/**
 * The row state a latch records for the approver's answer to `verb` (b.jg5
 * SRJ-501): `pending`, which the lap's `status` read before a pane verb;
 * unreadable for a `status` answer, which read no state.
 */
function approverLatchRowState(verb: ApproverVerb): LatchRowState {
  return verb === 'status' ? LATCH_ROW_STATE_UNREADABLE : latchRowStateRead(AGENT_DIRECTOR_PENDING_STATE)
}

/**
 * Latch the persona on the approver's CONFLICT answer `err` to `verb`
 * (b.jg5 SRJ-501): the installed latch's CONFLICT entry (`setFromConflict`)
 * with the refused operation "P's next check or recovery" and the recorded
 * state (`approverLatchRowState`). The approver is marked stopping
 * (`latched`) first, so the latch's set observer finds it already stopping.
 * Answers the latch line's outcome text: the set's outcome, that no latch is
 * installed, or that latching failed and what it threw. Logs nothing; never
 * throws.
 */
function approverLatchOnConflict(ctx: ApproverContext, verb: ApproverVerb, err: unknown): string {
  ctx.run.stopRequested ??= APPROVER_STOP_LATCHED
  return latchOnConflict(ctx.key, err, REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY, approverLatchRowState(verb))
}

// ---------------------------------------------------------------------------
// waitForWaitingAndReconnect — used when a colliding spawn is in `working`
// ---------------------------------------------------------------------------

/** Hard cap on the wait-for-waiting poller (10 minutes). Test-only override below. */
export const WAIT_FOR_WAITING_TIMEOUT_MS = 10 * 60 * 1000

let _waitForWaitingTimeoutMs = WAIT_FOR_WAITING_TIMEOUT_MS

/** Test-only seam: override the wait-for-waiting timeout. */
export function _setWaitForWaitingTimeoutMs(ms: number): void {
  _waitForWaitingTimeoutMs = ms
}

/** Test-only seam: restore the default. */
export function _resetWaitForWaitingTimeoutMs(): void {
  _waitForWaitingTimeoutMs = WAIT_FOR_WAITING_TIMEOUT_MS
}

/**
 * The clock of the `working`-row wait and evidence (b.f2b):
 * `waitForWaitingAndReconnect`'s deadline and loop, the launch wait's
 * evidence reads (`staleWorkingRowIsIdle`) and the restart path's fold
 * (`checkWorkingRowPane`), pane and transcript alike, and the findMissing
 * memo's window (`sharedFindMissingSweep`, `FIND_MISSING_MEMO_TTL_MS`),
 * and each launch call's window (`launchCallWithWindow`, b.jg5 SRJ-407),
 * whose times are wall-clock instants compared with a row's
 * `launch_started_at`. Test-only override below.
 */
let _now: () => number = () => Date.now()

/** Test-only seam: override the clock of the `working`-row wait and evidence, of the findMissing memo and of each launch call's window (a suite passes `createFakeClock().now`). */
export function _setNow(now: () => number): void {
  _now = now
}

/** Test-only seam: restore the real clock. */
export function _resetNow(): void {
  _now = () => Date.now()
}

// ---------------------------------------------------------------------------
// Stale `working` rows (b.f2b) — evidence from the persona's pane and transcript
// ---------------------------------------------------------------------------

/**
 * How long a `working` row's idle evidence must hold, or its pane keep showing
 * a prompt, before `waitForWaitingAndReconnect` at a launch, or the restart
 * path's reconnect adapter across its attempts (`checkWorkingRowPane`), acts
 * on it (b.f2b): it reconnects the stale row, or reports the prompt. Idle
 * evidence is the positive-idle rule of `foldWorkingPaneRun`: at every read
 * across the window, the pane shows the same idle screen AND the session's
 * transcript ends with a completed turn, unchanged. Test-only override below.
 */
export const STALE_WORKING_WINDOW_MS = 60_000

let _staleWorkingWindowMs = STALE_WORKING_WINDOW_MS

/** Test-only seam: override the stale-`working` evidence window. */
export function _setStaleWorkingWindowMs(ms: number): void {
  _staleWorkingWindowMs = ms
}

/** Test-only seam: restore the default stale-`working` evidence window. */
export function _resetStaleWorkingWindowMs(): void {
  _staleWorkingWindowMs = STALE_WORKING_WINDOW_MS
}

/**
 * How often the launch wait reads a `working` row's evidence (b.f2b): its
 * pane and, when that shows an idle screen, its agent-director row and
 * transcript. Every agent-director call goes through its one queue, shared by
 * every persona, so the wait reads at this cadence rather than on each status
 * poll. Test-only override below.
 */
export const WORKING_ROW_READ_INTERVAL_MS = 5_000

let _workingRowReadIntervalMs = WORKING_ROW_READ_INTERVAL_MS

/** Test-only seam: override how often the launch wait reads a `working` row's evidence. */
export function _setWorkingRowReadIntervalMs(ms: number): void {
  _workingRowReadIntervalMs = ms
}

/** Test-only seam: restore the default evidence read interval. */
export function _resetWorkingRowReadIntervalMs(): void {
  _workingRowReadIntervalMs = WORKING_ROW_READ_INTERVAL_MS
}

/**
 * How long CSCB holds back from a persona whose row reads `working`, typing
 * nothing because it can't prove the session idle, before it reports the
 * persona through the `unproven-idle` not-connected notice (b.f2b), whatever
 * `session_restart_delay` is: measured from the first deferral of the run
 * (`noteWorkingRowDeferral`). Without it, a row whose idleness can't be proven
 * (an unreadable transcript, a compaction summary, a screen that keeps
 * changing) would be held back from for good, silently. Test-only override
 * below.
 */
export const UNPROVEN_IDLE_NOTICE_AFTER_MS = 10 * 60 * 1000

let _unprovenIdleNoticeAfterMs = UNPROVEN_IDLE_NOTICE_AFTER_MS

/** Test-only seam: override how long deferrals on a `working` row run before the `unproven-idle` notice. */
export function _setUnprovenIdleNoticeAfterMs(ms: number): void {
  _unprovenIdleNoticeAfterMs = ms
}

/** Test-only seam: restore the default. */
export function _resetUnprovenIdleNoticeAfterMs(): void {
  _unprovenIdleNoticeAfterMs = UNPROVEN_IDLE_NOTICE_AFTER_MS
}

/** The pane's last lines with text: Claude Code's prompt box, footer and any dialog are drawn there. */
const WORKING_PANE_BOTTOM_LINES = 12

/**
 * Claude Code's spinner line while a turn runs (2.1.280), matched only in its
 * own shape: at column 0 a spinner glyph, a space, the spinner's message, an
 * ellipsis, then the end of the line or ` (` and the turn's status (elapsed
 * time, tokens, thinking), e.g. `✳ Harmonizing… (2m 42s · ↓ 10.1k tokens)`.
 * The message holds no ellipsis and is short: a verb from Claude Code's list
 * (`Harmonizing`, `Fiddle-faddling`), a custom one from the `spinnerVerbs`
 * setting, which can be several words (`🐝 Buzzing about the hive`), or the
 * current task's `activeForm`. The status is left out at first, and in
 * screen-reader mode. The animated glyphs (`·` `✢` `✳` `✶` `✻` `✽`, and `*`
 * on some terminals) start no other line with an ellipsis: a finished turn's
 * line (`✻ Baked for 4m 11s`) has none, and text quoted in a reply is
 * indented.
 * `●` (U+25CF) is the glyph with prefersReducedMotion, but on Linux Claude
 * Code also draws it at column 0 before every reply and tool call (macOS draws
 * `⏺` there), and those lines can hold an ellipsis. So a `●` line counts only
 * as a single word and an ellipsis ending the line, or as any message whose
 * ellipsis is followed by ` (` and a status that starts with an elapsed time,
 * a token arrow or `thinking`/`thought for`; `● Let me check the logs…`,
 * `● Checked the build… (see the thread)` and `● Bash(ls …)` do not. Verified
 * (2026-09-26) against the 2.1.280 binary and live panes, which show custom
 * verbs of an emoji and three words with their status, and `●` reply and tool
 * lines. 2.1.280 no longer prints "esc to interrupt" while a turn runs.
 */
const BUSY_SPINNER_LINE_RE =
  /^(?:[·✢✳✶✻✽*] [^\s…][^…\n]{0,79}…(?: \(.*)?|● [\p{L}\p{M}'’-]{1,40}…|● [^\s…][^…\n]{0,79}… \((?:\d+(?:\.\d+)?[smhd]\b|[↓↑] |thinking|thought for ).*)$/mu

/**
 * Busy hints in the pane's bottom lines, matched case-insensitively: the
 * "esc to interrupt" hint of earlier Claude Code versions and of the
 * capacity-retry line ("to interrupt" also covers a rebound key), and a turn
 * paused on a usage limit ("continuing automatically at … · esc to cancel").
 */
const BUSY_PANE_NEEDLES = ['to interrupt', 'esc to cancel']

/**
 * The static rows Claude Code 2.1.280 draws instead of the spinner while a
 * turn waits on the API, with no glyph, no timer and no interrupt hint,
 * matched case-insensitively in the pane's bottom lines (b.f2b): "No response
 * from the API after 2m · retrying, waiting up to 5m · attempt 2/10" and its
 * fixed second line "A proxy or gateway that buffers…", "Rate limit reached ·
 * Retrying in 7m (resets …) · attempt n/m" (the countdown shows whole minutes
 * from 5 m up, so the row can stay the same for a minute or more), and
 * "Waiting for API response · will retry in …". Each is anchored on Claude
 * Code's own `·` separator or fixed wording, so a reply that mentions a retry
 * does not read busy.
 */
const BUSY_API_RETRY_ROWS: readonly RegExp[] = [
  /no response from the api after [^\n]*·\s*retrying/i,
  /a proxy or gateway that buffers/i,
  /rate limit reached\s*·\s*retrying in/i,
  /waiting for api response\s*·\s*will retry in/i,
  /·\s*attempt \d+\/\d+/i,
]

/**
 * A numbered option line of a Claude Code dialog (2.1.280), its box side
 * (`│`) dropped: an optional `❯` selection cursor, the option's number, a
 * period and its label, e.g. `❯ 1. Yes` or `2. No, and tell Claude what to do
 * differently (esc)`. Group 2 is the number.
 */
const DIALOG_OPTION_LINE_RE = /^(❯\s*)?(\d+)\.\s+\S/

/**
 * Option labels and footers that mark a Claude Code dialog (2.1.280), matched
 * case-insensitively on its option list and the lines below it: the deny
 * option of every tool-permission dialog, the select-menu footers
 * (AskUserQuestion and other pickers) and the pre-session dialogs' options.
 */
const DIALOG_NEEDLES = [
  'tell Claude what to do differently',
  'Enter to select',
  'Enter to confirm',
  ...PRE_SESSION_DIALOG_NEEDLES,
].map((needle) => needle.toLowerCase())

/** What a pane read from a `working` row shows (b.f2b). */
export type WorkingPaneReading = 'prompt' | 'busy' | 'idle' | 'blank'

/** The pane's lines without trailing spaces, and without the blank lines after its last text. */
function paneLines(pane: string): string[] {
  const lines = pane.split('\n').map((line) => line.trimEnd())
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** A pane line's text with a dialog box's sides (`│`) dropped, and whether it had a left side. */
function dialogRow(line: string): { text: string; boxed: boolean } {
  const trimmed = line.trim()
  const boxed = trimmed.startsWith('│')
  const text = (boxed ? trimmed.slice(1) : trimmed).replace(/│$/, '').trim()
  return { text, boxed }
}

/**
 * Whether the pane's bottom lines show a Claude Code dialog (b.f2b), anchored
 * to its layout, so an idle screen whose last reply merely quotes a dialog's
 * wording does not count: a numbered option list (an option `1.` and, below
 * it, an option `2.`; description lines may sit between them) with the `❯`
 * selection cursor on one of its options, and, to anchor it, a question line
 * (ending in `?`) above the list, a dialog option or footer
 * (`DIALOG_NEEDLES`) on or below it, or its options drawn inside the dialog's
 * box (`│`).
 */
function paneShowsDialog(bottom: readonly string[]): boolean {
  const rows = bottom.map(dialogRow)
  const optionNumber = (text: string): string | undefined => DIALOG_OPTION_LINE_RE.exec(text)?.[2]
  const first = rows.findIndex((row) => optionNumber(row.text) === '1')
  if (first < 0) return false
  const below = rows.slice(first)
  const options = below.filter((row) => optionNumber(row.text) !== undefined)
  if (!options.some((row) => optionNumber(row.text) === '2')) return false
  if (!options.some((row) => row.text.startsWith('❯'))) return false
  return (
    rows.slice(0, first).some((row) => row.text.endsWith('?')) ||
    below.some((row) => DIALOG_NEEDLES.some((needle) => row.text.toLowerCase().includes(needle))) ||
    options.some((row) => row.boxed)
  )
}

/**
 * Classify a pane read from a `working` (or `waiting`) row (b.f2b): `prompt`
 * when its bottom lines show a dialog (`paneShowsDialog`); else `busy` when it
 * shows Claude Code's spinner line anywhere, or a busy hint or an API retry
 * row in its bottom lines; `blank` when it holds no text; otherwise `idle`. A
 * prompt wins over a busy sign, since a dialog may sit under a running turn's
 * spinner: either way nothing is typed. `idle` is no proof the session is
 * idle: the stale-row rule also needs the transcript (`foldWorkingPaneRun`).
 * Pure.
 */
export function classifyWorkingPane(pane: string): WorkingPaneReading {
  const lines = paneLines(pane)
  if (lines.length === 0) return 'blank'
  const bottomLines = lines.slice(-WORKING_PANE_BOTTOM_LINES)
  if (paneShowsDialog(bottomLines)) return 'prompt'
  if (BUSY_SPINNER_LINE_RE.test(lines.join('\n'))) return 'busy'
  const bottom = bottomLines.join('\n').toLowerCase()
  if (BUSY_PANE_NEEDLES.some((needle) => bottom.includes(needle))) return 'busy'
  if (BUSY_API_RETRY_ROWS.some((row) => row.test(bottom))) return 'busy'
  return 'idle'
}

/** A run of consecutive evidence reads of a `working` row that agree (b.f2b). */
export interface WorkingPaneRun {
  /**
   * `idle`: every read showed the same idle screen and the same, unchanged
   * transcript ending with a completed turn; `prompt`: every read showed a
   * prompt or dialog.
   */
  reading: 'idle' | 'prompt'
  /** The run's first screen (its lines, trailing spaces dropped): an idle run lasts only while it is unchanged. */
  screen: string
  /** An idle run's transcript as its first read saw it: the run lasts only while every read sees it unchanged. */
  transcript?: TranscriptSnapshot
  /** When the run started (epoch ms, the session manager's clock `_now`). */
  since: number
}

/**
 * Fold one evidence read into the current run (b.f2b). This is the
 * positive-idle rule: a pane alone is never idle evidence.
 * - `pane` undefined (the read failed), a `busy` or a `blank` pane ends the
 *   run: no evidence.
 * - A `prompt` pane continues a prompt run, or starts one at `now`; the
 *   transcript plays no part (nothing is typed into a prompt either way).
 * - An `idle` pane is evidence only together with `transcript`, the session's
 *   transcript read with it, ending with a completed turn (`ended`, see
 *   `transcriptTailTurnState`). A transcript that doesn't, can't be located or
 *   read, or wasn't read ends the run. An idle run continues only while both
 *   the screen and the transcript's snapshot (path, device, inode, size,
 *   mtime) are unchanged; otherwise a new idle run starts at `now`.
 * So a row is stale only once the same idle screen and the same ended,
 * unchanged transcript were read at every read across the window. A live
 * turn, an API retry included, never ends its transcript with a completed
 * turn, so it never gives idle evidence, however still its screen. Pure.
 */
export function foldWorkingPaneRun(
  run: WorkingPaneRun | undefined,
  pane: string | undefined,
  now: number,
  transcript?: TranscriptReading,
): WorkingPaneRun | undefined {
  if (pane === undefined) return undefined
  const reading = classifyWorkingPane(pane)
  const screen = paneLines(pane).join('\n')
  if (reading === 'prompt') return run?.reading === 'prompt' ? run : { reading, screen, since: now }
  if (reading !== 'idle' || transcript === undefined || transcript.kind !== 'ended') return undefined
  const unchanged =
    run?.reading === 'idle' &&
    run.screen === screen &&
    run.transcript !== undefined &&
    sameTranscriptSnapshot(run.transcript, transcript.snapshot)
  return unchanged ? run : { reading, screen, transcript: transcript.snapshot, since: now }
}

/** One evidence read of a `working` row (b.f2b). */
interface WorkingRowRead {
  /** The pane; undefined when the read failed, or when the persona latched. */
  pane: string | undefined
  /**
   * The pane read's failure outcome (`src/pane-read.ts`: its class and its
   * token-safe description); set only when the read failed and latched
   * nothing. An UNCLASSIFIED here carries the reader's stop mark
   * (`stopping`) when its version re-check decided that the server stops.
   */
  paneFailure?: PaneReadFailure
  /** The session's transcript, read only when the pane shows an idle screen. */
  transcript?: TranscriptReading
  /**
   * b.jg5 SRJ-501: the row state the transcript `get` read (no row for
   * `ErrSpawnNotFound`, unreadable for an UNUSABLE NAME answer), when it was
   * made and gave one: the path's last read of the row from then on.
   */
  rowRead?: LatchRowState
  /**
   * b.jg5 SRJ-502: the persona is latched after one of the read's
   * agent-director calls (its pane read or its transcript `get` latched it,
   * or it was latched elsewhere). No evidence: the caller calls nothing more
   * and types nothing.
   */
  latched?: true
}

/** The evidence read of a persona that is latched (`WorkingRowRead.latched`). */
const WORKING_ROW_READ_LATCHED: WorkingRowRead = Object.freeze({ pane: undefined, latched: true })

/**
 * True when persona `key` is latched now, by the installed latch (b.jg5
 * SRJ-502): a latched query that throws, or a latched persona whose record
 * cannot be read, counts as latched (`latchGateReadingOf`). False with no
 * latch installed. Logs nothing; never throws.
 */
function personaLatchedNow(key: string): boolean {
  return latchGateReadingOf(key) !== undefined
}

/**
 * Asked right after one of persona `key`'s own-row reads (`what` at `site`)
 * that did not itself latch it (b.jg5 SRJ-502): true when the persona is
 * latched now (`personaLatchedNow`), latched elsewhere while the read was
 * awaited (the health tick reads even while a launch is in flight, b.jg5
 * SRJ-315), after logging one line; the caller then calls nothing more for
 * it. False otherwise, with nothing logged. Never throws.
 *
 *   [slack] <site>: <ref> is latched after its <what> — nothing more is called for it (b.jg5 SRJ-502)
 */
function latchedAfterOwnRowRead(key: string, site: string, what: string, ref: string): boolean {
  if (!personaLatchedNow(key)) return false
  console.error(`[slack] ${site}: ${ref} is latched after its ${what} — nothing more is called for it (b.jg5 SRJ-502)`)
  return true
}

/**
 * Read persona `key`'s pane (`readWorkingPane`, whose CONFLICT or UNUSABLE
 * NAME answer latches the persona with `lastRead`, the row state the calling
 * path last read) and, only when it shows an idle screen, its transcript
 * (`readIdlePaneTranscript`), for one evidence read of the launch wait
 * (b.f2b). After the pane read it asks whether the persona is latched
 * (`personaLatchedNow`, or a read that latched it), and then answers
 * `WORKING_ROW_READ_LATCHED` with nothing more read (b.jg5 SRJ-502). A
 * failed pane read that latched nothing is carried as its outcome
 * (`paneFailure`). Never throws.
 */
async function readWorkingRowEvidence(
  key: string,
  configDir: string | undefined,
  lastRead: LatchRowState,
): Promise<WorkingRowRead> {
  const read = await readWorkingPane(key, lastRead)
  if (read.kind === PANE_READ_LATCHED || personaLatchedNow(key)) return WORKING_ROW_READ_LATCHED
  if (read.kind !== PANE_READ_PANE) return { pane: undefined, paneFailure: read }
  return readIdlePaneTranscript(key, read.pane, configDir)
}

/**
 * The rest of one evidence read of persona `key`'s `working` row once its
 * `pane` has been read (b.f2b): the transcript (`readPersonaTranscript`, one
 * `get` of its own row) only when the pane shows an idle screen. After the
 * transcript `get` it asks whether the persona is latched (the `get` latched
 * it, or `personaLatchedNow`), and then answers `WORKING_ROW_READ_LATCHED`
 * (b.jg5 SRJ-502), carrying the state the `get` read when it gave one.
 * Never throws.
 */
async function readIdlePaneTranscript(key: string, pane: string, configDir: string | undefined): Promise<WorkingRowRead> {
  if (classifyWorkingPane(pane) !== 'idle') return { pane }
  const { transcript, rowRead } = await readPersonaTranscript(key, configDir)
  const tracked = rowRead === undefined ? {} : { rowRead }
  if (transcript.kind === PERSONA_TRANSCRIPT_LATCHED || personaLatchedNow(key)) {
    return { ...WORKING_ROW_READ_LATCHED, ...tracked }
  }
  return { pane, transcript, ...tracked }
}

/**
 * Read the last `FULL_PANE_READ_LINES` lines of persona `key`'s pane (b.f2b)
 * through the shared read-pane of its own row (`readPersonaOwnPane`, b.jg5
 * SRJ-117), answering its outcome. A CONFLICT or UNUSABLE NAME answer
 * latches the persona with `lastRead`, the row state the calling path last
 * read (the launch wait's last read, or the `waiting` state the restart
 * path's check was called for), and a persona already latched is not read:
 * either way the outcome is latched, and the caller ends what it was doing
 * with nothing typed (b.jg5 SRJ-501, SRJ-502, SRJ-512). A pane it answers
 * may be a single leftover's (b.jg5 SRJ-613): its callers (the launch wait's
 * evidence read and `checkWaitingRowPane`) act on it only through the
 * reconnect, whose `send-keys` is the backstop (`reconnectMcpWithCause`).
 * Never throws.
 */
async function readWorkingPane(key: string, lastRead: LatchRowState): Promise<OwnPaneReadOutcome> {
  return readPersonaOwnPane(key, { nLines: FULL_PANE_READ_LINES, lastRead, site: 'readWorkingPane' })
}

/**
 * The effective claude_config_dir of `persona`, absolute (`<home>/.claude`
 * when none is set), for composing its transcript's path (b.f2b); undefined
 * when the persona isn't known, and then only the row's persisted path is
 * used (`locateTranscript`).
 */
function transcriptConfigDir(persona: Pick<Persona, 'claude_config_dir'> | undefined): string | undefined {
  return persona === undefined ? undefined : resolveClaudeConfigDir(persona.claude_config_dir, spawnHomeDir())
}

/** `readPersonaTranscript`'s answer when its `get` latched the persona (b.jg5 SRJ-114, SRJ-512). */
const PERSONA_TRANSCRIPT_LATCHED = 'latched'

/** A transcript reading, or that its `get` latched the persona. */
type PersonaTranscriptReading = TranscriptReading | { kind: typeof PERSONA_TRANSCRIPT_LATCHED }

/**
 * What `readPersonaTranscript` answers: the reading, and the row state its
 * `get` read (b.jg5 SRJ-501), when it gave one.
 */
interface PersonaTranscriptRead {
  readonly transcript: PersonaTranscriptReading
  readonly rowRead?: LatchRowState
}

/**
 * Read persona `key`'s transcript for idle evidence (b.f2b): fetch its
 * agent-director row through the shared own-row read (`readPersonaOwnRow`,
 * one `get`, b.jg5 SRJ-114), locate the transcript of the row's session
 * (`locateTranscript`: the persisted `jsonl_path`, else the path composed
 * under `configDir`) and read its turn state (`readTranscriptTurnState`). A
 * `get` that latched the persona (its own row reading `pending` with no
 * launch start, b.jg5 SRJ-513, a latching note, or an UNUSABLE NAME
 * answer, b.jg5 SRJ-512) answers `latched`, and nothing more is read: no
 * evidence. An absent row (`ErrSpawnNotFound`), a failed `get`, a row that
 * names no transcript, or a file that can't be read is `unreadable`, with a
 * token-safe reason: no evidence. Beside the reading it answers the row
 * state the `get` read (`rowRead`, b.jg5 SRJ-501: the state of a row, no row
 * for an absent one, unreadable for an UNUSABLE NAME answer; none for a
 * failed `get`), so the caller tracks it as the path's last read. Never
 * throws.
 */
async function readPersonaTranscript(key: string, configDir: string | undefined): Promise<PersonaTranscriptRead> {
  const read = await readPersonaOwnRow(key, { site: 'readPersonaTranscript', what: 'transcript get' })
  if (read.kind === OWN_ROW_READ_LATCHED) {
    return { transcript: { kind: PERSONA_TRANSCRIPT_LATCHED }, rowRead: LATCH_ROW_STATE_UNREADABLE }
  }
  if (read.kind === OWN_ROW_READ_ABSENT) {
    return {
      transcript: { kind: 'unreadable', reason: 'its agent-director row is absent (ErrSpawnNotFound)' },
      rowRead: LATCH_ROW_STATE_NO_ROW,
    }
  }
  if (read.kind === OWN_ROW_READ_REFUSED) {
    return {
      transcript: { kind: 'unreadable', reason: `reading its agent-director row failed: ${describeAgentDirectorFailure(read.error)}` },
    }
  }
  const { row } = read
  const rowRead = latchRowStateRead(row.state)
  if (read.latched) return { transcript: { kind: PERSONA_TRANSCRIPT_LATCHED }, rowRead }
  const path = locateTranscript(row, configDir)
  if (path === undefined) {
    return { transcript: { kind: 'unreadable', reason: 'its agent-director row names no transcript for its session' }, rowRead }
  }
  const reading = readTranscriptTurnState(path)
  return {
    transcript: reading.kind === 'unreadable' ? { kind: 'unreadable', reason: `"${path}": ${reading.reason}` } : reading,
    rowRead,
  }
}

/**
 * Why a transcript read with an idle pane gives no idle evidence (b.f2b), for
 * a log line; undefined when it was not read or ends with a completed turn.
 */
function transcriptNoEvidence(transcript: TranscriptReading | undefined): string | undefined {
  if (transcript === undefined) return undefined
  if (transcript.kind === 'unreadable') return `its transcript can't be read: ${transcript.reason}`
  return transcript.kind === 'open' ? `its transcript "${transcript.snapshot.path}" does not end with a completed turn` : undefined
}

/**
 * `staleWorkingRowIsIdle`'s answer when its pane read's version re-check
 * decided that the server stops (b.jg5 SRJ-205).
 */
const WORKING_EVIDENCE_STOPPING = 'stopping'

/** One launch wait's evidence for a `working` row (b.f2b). */
interface WorkingPaneWatch {
  run: WorkingPaneRun | undefined
  /** When the wait last read the evidence (`_now`); undefined before its first read. */
  lastReadAt: number | undefined
  /** The first failed pane read was logged (later ones are not, for the rest of the wait). */
  readFailureLogged: boolean
  /** The last reason an idle pane's transcript gave no evidence, as logged: a changed reason is logged again. */
  transcriptNote: string | undefined
  /** A prompt run reached the window: logged and reported once for the wait. */
  promptReported: boolean
}

/**
 * The launch wait's evidence check for persona `key`'s `working` row (b.f2b),
 * called on every status poll. It reads the evidence only once
 * `WORKING_ROW_READ_INTERVAL_MS` has passed since its last read (the first
 * poll reads at once), and folds it into the wait's run (`foldWorkingPaneRun`).
 * True once the idle evidence has held for the whole window: the pane has
 * shown the same idle screen and the transcript has ended with a completed
 * turn, unchanged, at every read. The row is stale and the caller reconnects
 * it. A prompt shown for the window is logged and reported (once per wait,
 * through the not-connected notice) and the wait goes on; nothing is typed
 * into it. A failed pane read or an idle pane whose transcript gives no
 * evidence ends the run; the wait's first pane failure and each new
 * transcript reason are logged, and the wait goes on as before.
 * `latched` when the persona is latched after the read's pane or transcript
 * read (b.jg5 SRJ-502, `WorkingRowRead.latched`; a pane read's CONFLICT or
 * UNUSABLE NAME answer latches it with the wait's last read, b.jg5 SRJ-117,
 * SRJ-501, SRJ-512, SRJ-608, and a latched persona's pane is not read):
 * nothing is logged, folded or reported, and the wait ends with nothing
 * typed. `stopping` (`WORKING_EVIDENCE_STOPPING`) when the pane read's
 * UNCLASSIFIED carries the stop mark (b.jg5 SRJ-205: the shared reader's
 * `ErrInvalidFlags` re-check decided that the server stops): one line,
 * nothing folded or reported, and the wait ends with nothing typed. Every
 * other failed pane read (GONE, an absent row, UNAVAILABLE, ENVIRONMENT,
 * CONFIG, UNCLASSIFIED) is no evidence (b.jg5 SRJ-117, SRJ-608). The state
 * the transcript `get` read, when it was made, becomes the wait's last read
 * (`wait.lastRead`, b.jg5 SRJ-501).
 *
 * The pane may be a single leftover's (b.jg5 SRJ-117, SRJ-613: with no
 * session of the row's current launch there and exactly one leftover of the
 * persona, agent-director answers the leftover's pane), so it is no proof
 * that the worker's own session is there: a pane only feeds the fold, which
 * also needs the transcript. When the fold shows the row stale, the wait's
 * reconnect (`reconnectInWait`, `reconnectMcpWithCause` with the row state
 * `working`) is the backstop: its `send-keys` answers CONFLICT "not this
 * launch's session" on a live row that is not `pending` when a leftover
 * holds the persona's session, and then nothing is typed, P latches (b.jg5
 * SRJ-501) with its CONFLICT notice posted once, the refused `send-keys` is
 * never retried, and the wait answers `transient` noted as latched, so the
 * ladder answers `latched`.
 */
async function staleWorkingRowIsIdle(
  key: string,
  ref: string,
  config: PersonaConfig,
  watch: WorkingPaneWatch,
  wait: WorkingRowWait,
): Promise<boolean | typeof WAIT_OUTCOME_LATCHED | typeof WORKING_EVIDENCE_STOPPING> {
  const due = _now()
  if (watch.lastReadAt !== undefined && due - watch.lastReadAt < _workingRowReadIntervalMs) return false
  watch.lastReadAt = due
  const read = await readWorkingRowEvidence(
    key,
    transcriptConfigDir(config.personas.find((p) => p.key === key)),
    // The poll that called this has just read the row `working`.
    wait.lastRead ?? latchRowStateRead('working'),
  )
  if (read.rowRead !== undefined) wait.lastRead = read.rowRead
  // b.jg5 SRJ-608: a CONFLICT (or UNUSABLE NAME) at the pane read latched P;
  // the wait ends `latched` with no further call and nothing typed.
  if (read.latched) return WAIT_OUTCOME_LATCHED
  // b.jg5 SRJ-205: the pane read's version re-check decided that the server
  // stops; the wait ends with no further call and nothing typed.
  if (read.paneFailure?.kind === PANE_READ_UNCLASSIFIED && read.paneFailure.stopping === true) {
    console.error(
      `[slack] waitForWaitingAndReconnect: reading the pane of ${ref} failed: ${read.paneFailure.description} — the agent-director version re-check decided that the server stops; the wait ends, nothing more is called and nothing is typed (${paneReadClassNote(read.paneFailure)}; b.jg5 SRJ-204, SRJ-205)`,
    )
    return WORKING_EVIDENCE_STOPPING
  }
  if (read.paneFailure !== undefined && !watch.readFailureLogged) {
    watch.readFailureLogged = true
    console.error(
      `[slack] waitForWaitingAndReconnect: reading the pane of ${ref} failed: ${read.paneFailure.description} — no idle evidence from it; still waiting for its working row (${paneReadClassNote(read.paneFailure)}; b.f2b)`,
    )
  }
  const note = transcriptNoEvidence(read.transcript)
  if (note !== undefined && note !== watch.transcriptNote) {
    watch.transcriptNote = note
    console.error(
      `[slack] waitForWaitingAndReconnect: ${ref} reads working and its pane shows an idle screen, but ${note} — no idle evidence; still waiting for its working row (b.f2b)`,
    )
  }
  const now = _now()
  watch.run = foldWorkingPaneRun(watch.run, read.pane, now, read.transcript)
  const run = watch.run
  if (run === undefined || now - run.since < _staleWorkingWindowMs) return false
  const seconds = Math.round((now - run.since) / 1000)
  if (run.reading === 'idle') {
    console.error(
      `[slack] waitForWaitingAndReconnect: ${ref} reads working, but its pane has shown the same idle screen (no busy indicator, no prompt) and its transcript has ended with a completed turn, both unchanged, for ${seconds}s — treating the row as stale and reconnecting (b.f2b)`,
    )
    return true
  }
  if (!watch.promptReported) {
    watch.promptReported = true
    console.error(
      `[slack] waitForWaitingAndReconnect: ${ref} reads working and its pane has shown a prompt or dialog for ${seconds}s — blocked on it; not typing into it, still waiting (answer it in tmux session "${personaTmuxSessionName(key)}") (b.f2b)`,
    )
    notifyPersonaNotConnected(key, { reason: 'blocked-on-prompt', autoRestartDisabled: config.session_restart_delay === 0 })
  }
  return false
}

/**
 * The restart path's evidence for each persona whose row reads `working`
 * (b.f2b): one run per persona, kept across its reconnect attempts, which are
 * minutes apart (`checkWorkingRowPane`). Forgotten when an attempt finds the
 * row in another state or can't read it (`forgetWorkingRowEvidence`), when a
 * read gives no evidence and ends the run, when an idle run concludes and the
 * reconnect is typed, when any launch for the persona starts
 * (`spawnForPersona`), and with the persona's not-connected episode
 * (`forgetNotConnectedEpisode`: it reconnected, became deliverable again, or
 * was torn down).
 */
const workingRowPaneRuns = new Map<string, WorkingPaneRun>()

/**
 * When each persona's current run of deferrals on its `working` row began
 * (b.f2b, on the session manager's clock `_now`): the first time a launch
 * wait or the restart path held back from the row, typing nothing, because it
 * could not prove the session idle (`noteWorkingRowDeferral`). A run goes on
 * across reads and attempts that find no proof, whatever the reason: a busy,
 * changing or blank pane, a transcript that doesn't end with a completed
 * turn or can't be read, idle evidence not yet held for the window, a
 * prompt, a pane read agent-director could not answer (UNAVAILABLE or
 * CONFIG, b.jg5 SRJ-603). A failed status call, and a pane read that met
 * ENVIRONMENT, UNCLASSIFIED or a latch, neither extend nor end it. It ends
 * (`endWorkingRowDeferral`) when the row reads another state, when a
 * reconnect is typed into it, when any launch for the persona starts (the
 * launch's own wait starts a new run), and with the persona's not-connected
 * episode (`forgetNotConnectedEpisode`).
 */
const workingRowDeferredSince = new Map<string, number>()

/**
 * b.f2b: note that CSCB held back from persona `key`'s `working` row once
 * more, typing nothing, because it could not prove the session idle. The
 * first deferral of a run starts it (`workingRowDeferredSince`); once the run
 * has lasted `UNPROVEN_IDLE_NOTICE_AFTER_MS`, the `unproven-idle`
 * not-connected notice is raised, at any `session_restart_delay`, through the
 * shared latch: once per episode, and not at all when another not-connected
 * notice was raised in the episode. `autoRestartDisabled` (`session_restart_delay`
 * is 0) words what happens next; the restart path runs only with auto-restart
 * on. Returns whether it raised the notice; `notifyPersonaNotConnected` logs
 * the line.
 */
export function noteWorkingRowDeferral(key: string, autoRestartDisabled: boolean): boolean {
  const heldMs = noteDeferralRun(workingRowDeferredSince, key)
  if (heldMs < _unprovenIdleNoticeAfterMs) return false
  return notifyPersonaNotConnected(key, { reason: 'unproven-idle', autoRestartDisabled, heldMs })
}

/**
 * b.f2b: end persona `key`'s run of deferrals on its `working` row (it read
 * another state, a reconnect was typed into it, or a launch for it started),
 * so a later deferral starts a new run. Silent; other personas are untouched.
 */
export function endWorkingRowDeferral(key: string): void {
  workingRowDeferredSince.delete(key)
}

/** What `checkWorkingRowPane` tells the restart path's reconnect adapter (b.f2b). */
export type WorkingRowPaneVerdict = 'reconnect' | 'defer'

/** `checkWaitingRowPane`'s answer when the row's `read-pane` answered GONE (b.jg5 SRJ-117, SRJ-604). */
export const WAITING_ROW_PANE_GONE = 'gone'

/** `checkWaitingRowPane`'s answer when the row was absent (`ErrSpawnNotFound`) at its `read-pane` (b.jg5 SRJ-117). */
export const WAITING_ROW_PANE_ABSENT = 'absent'

/**
 * What `checkWaitingRowPane` tells the restart path's reconnect adapter
 * (b.f2b, b.jg5 SRJ-604): `reconnect`, `defer`, or that the row's
 * `read-pane` answered GONE (`gone`) or found the row absent (`absent`), on
 * either of which the adapter sweeps and escalates with nothing typed.
 */
export type WaitingRowPaneVerdict = WorkingRowPaneVerdict | typeof WAITING_ROW_PANE_GONE | typeof WAITING_ROW_PANE_ABSENT

/**
 * What a reconnect line says it does on a row it escalates as dead before the
 * restart path's re-probe (b.jg5 SRJ-610): the sweep and the 'escalate-dead'
 * answer, and no outcome, since a swept row may stay live for further ticks.
 */
export const ESCALATE_DEAD_REPROBE_DECIDES = "sweeping and escalating (escalate-dead); the restart path's re-probe decides"

/**
 * `checkWaitingRowPane`'s line when the `waiting` row's `read-pane` answered
 * GONE (b.jg5 SRJ-604); `read` is that failure.
 */
export function waitingRowPaneGoneLine(key: string, read: PaneReadFailure): string {
  return `[slack] reconnectSession: ${keyRef(key)} is waiting but agent-director's read-pane found no pane of its launch: ${read.description} — not typing /mcp reconnect; ${ESCALATE_DEAD_REPROBE_DECIDES} (${paneReadClassNote(read)}; b.jg5 SRJ-604)`
}

/**
 * `checkWaitingRowPane`'s line when the `waiting` row was absent
 * (`ErrSpawnNotFound`) at its `read-pane` (b.jg5 SRJ-117); `read` is that
 * failure.
 */
export function waitingRowAbsentAtPaneReadLine(key: string, read: PaneReadFailure): string {
  return `[slack] reconnectSession: ${keyRef(key)} is waiting but its agent-director row was absent at the pane read: ${read.description} — not typing /mcp reconnect; ${ESCALATE_DEAD_REPROBE_DECIDES} (${paneReadClassNote(read)}; b.jg5 SRJ-117)`
}

/** What `checkWorkingRowPane` is given beside the persona's key and pane. */
export interface WorkingRowPaneCheckOptions {
  /**
   * The persona, for locating its transcript under its claude_config_dir;
   * absent, only the row's persisted transcript path is read.
   */
  readonly persona?: Pick<Persona, 'claude_config_dir'>
  /**
   * The caller's latched gate (b.jg5 SRJ-502; production: the reconnect
   * adapter's `reconnectLatchedAt` for the persona, which logs the latched
   * line), asked right before a deferral is noted and right before the
   * `blocked-on-prompt` notice: a persona that latched meanwhile (a launch
   * outside the restart serializer can latch it during the check's awaits)
   * answers `defer` with its run forgotten, no deferral noted and no notice.
   * Absent: never asked.
   */
  readonly latchedNow?: () => boolean
}

/**
 * b.f2b, b.jg5 SRJ-603 — the restart path's positive-idle fold for a persona
 * whose row reads `working`, on the `pane` its caller read: the reconnect
 * adapter's one `read-pane` of the row (`workingReconnectVerdict` in
 * `server.ts`). It makes no `read-pane` of its own. It reads the transcript
 * (one `get` of the row; located with `options.persona`'s
 * claude_config_dir, and without it only the row's persisted transcript path
 * is used) only when the pane shows an idle screen, and folds the evidence
 * into the persona's run, kept across reconnect attempts
 * (`workingRowPaneRuns`):
 * - `reconnect` once the idle evidence has held across reads spanning
 *   `STALE_WORKING_WINDOW_MS`: the same idle screen (no busy indicator, no
 *   prompt) and the same transcript, ended with a completed turn and
 *   unchanged, at every read. The row is stale, and the caller types
 *   `/mcp reconnect`. The run is forgotten.
 * - `defer` otherwise: a busy or blank pane, or an idle pane whose transcript
 *   does not end with a completed turn or can't be located or read (the run
 *   ends: no evidence); idle evidence not yet held for the window; or a
 *   prompt or dialog. A prompt shown across reads spanning the window also
 *   raises the `blocked-on-prompt` not-connected notice (once per episode);
 *   nothing is ever typed into a prompt.
 * Each `defer` is one more deferral in the persona's run on its `working` row
 * (`noteWorkingRowDeferral`): once the run has lasted
 * `UNPROVEN_IDLE_NOTICE_AFTER_MS`, the `unproven-idle` notice is raised (once
 * per episode), so a row whose idleness can never be proven is not held back
 * from silently. `reconnect` ends the run. A live turn never ends its
 * transcript with a completed turn, so it is never taken for idle (b.rmy).
 *
 * The pane comes from the caller's one read and may be a single leftover's
 * (b.jg5 SRJ-117, SRJ-613: with no session of the row's current launch there
 * and exactly one leftover of the persona, agent-director answers the
 * leftover's pane), so a pane alone is never proof that the worker's own
 * session is there: the fold also needs the transcript, and `reconnect` only
 * lets the caller type `/mcp reconnect`. That reconnect's `send-keys`
 * (`reconnectMcpWithCause`) is the backstop: on a live row that is not
 * `pending` it answers CONFLICT "not this launch's session" when a leftover
 * holds the persona's session, and then nothing is typed, P latches (b.jg5
 * SRJ-501) with its CONFLICT notice posted once, and the refused `send-keys`
 * is never retried (SRJ-118).
 *
 * A persona latched during the transcript `get` (it read a
 * `provenance_conflict` note or answered UNUSABLE NAME, b.jg5 SRJ-114,
 * SRJ-512, or it was latched elsewhere), or one `options.latchedNow` finds
 * latched right before a deferral is noted or the notice is raised, answers
 * `defer` with its run forgotten, no deferral noted, no not-connected notice
 * and nothing typed (b.jg5 SRJ-502).
 * Logs one line per call; never throws.
 */
export async function checkWorkingRowPane(
  key: string,
  pane: string,
  options: WorkingRowPaneCheckOptions = {},
): Promise<WorkingRowPaneVerdict> {
  const verdict = await workingRowPaneVerdict(key, pane, options)
  // b.jg5 SRJ-502: a persona latched during the check is deferred with no
  // deferral noted, so no not-connected notice is raised for it.
  if (verdict === WAIT_OUTCOME_LATCHED) return 'defer'
  if (verdict === 'reconnect') {
    endWorkingRowDeferral(key)
    return 'reconnect'
  }
  // b.jg5 SRJ-502: asked right before the deferral that may raise the
  // `unproven-idle` notice.
  if (options.latchedNow?.() === true) {
    workingRowPaneRuns.delete(key)
    return 'defer'
  }
  // The restart path runs only with auto-restart on.
  noteWorkingRowDeferral(key, false)
  return 'defer'
}

/**
 * `checkWorkingRowPane`'s transcript read and verdict on the caller's `pane`,
 * before its deferral is noted (b.f2b); `latched` for a persona latched
 * during the transcript `get`, or found latched right before the
 * `blocked-on-prompt` notice (b.jg5 SRJ-502): its run is forgotten.
 */
async function workingRowPaneVerdict(
  key: string,
  pane: string,
  options: WorkingRowPaneCheckOptions,
): Promise<WorkingRowPaneVerdict | typeof WAIT_OUTCOME_LATCHED> {
  const ref = keyRef(key)
  const read = await readIdlePaneTranscript(key, pane, transcriptConfigDir(options.persona))
  if (read.latched) {
    workingRowPaneRuns.delete(key)
    console.error(
      `[slack] reconnectSession: ${ref} is working and is latched — deferring; no deferral noted, nothing typed (b.jg5 SRJ-502)`,
    )
    return WAIT_OUTCOME_LATCHED
  }
  const now = _now()
  const run = foldWorkingPaneRun(workingRowPaneRuns.get(key), pane, now, read.transcript)
  if (run === undefined) {
    workingRowPaneRuns.delete(key)
    logNoWorkingRowEvidence(ref, classifyWorkingPane(pane), read.transcript)
    return 'defer'
  }
  workingRowPaneRuns.set(key, run)
  const span = now - run.since
  const seconds = Math.round(span / 1000)
  if (run.reading === 'idle') {
    if (span < _staleWorkingWindowMs) {
      console.error(
        `[slack] reconnectSession: ${ref} is working; its pane shows an idle screen (no busy indicator, no prompt) and its transcript ends with a completed turn, both unchanged for ${seconds}s of the ${Math.round(_staleWorkingWindowMs / 1000)}s needed — deferring /mcp reconnect to a later tick, which reads them again (b.f2b)`,
      )
      return 'defer'
    }
    workingRowPaneRuns.delete(key)
    console.error(
      `[slack] reconnectSession: ${ref} reads working, but its pane has shown the same idle screen (no busy indicator, no prompt) and its transcript has ended with a completed turn, both unchanged, for ${seconds}s — treating the row as stale and reconnecting (b.f2b)`,
    )
    return 'reconnect'
  }
  if (span < _staleWorkingWindowMs) {
    console.error(`[slack] reconnectSession: ${ref} is working and its pane shows a prompt or dialog — not typing into it; deferring /mcp reconnect to a later tick (b.f2b/b.rmy)`)
    return 'defer'
  }
  // b.jg5 SRJ-502: asked right before the notice; the gate logs its line.
  if (options.latchedNow?.() === true) {
    workingRowPaneRuns.delete(key)
    return WAIT_OUTCOME_LATCHED
  }
  console.error(
    `[slack] reconnectSession: ${ref} reads working and its pane has shown a prompt or dialog for ${seconds}s — blocked on it; not typing into it, deferring /mcp reconnect to a later tick (answer it in tmux session "${personaTmuxSessionName(key)}") (b.f2b)`,
  )
  // The restart path runs only with auto-restart on: `scheduleRestart` arms
  // nothing while `session_restart_delay` is 0.
  notifyPersonaNotConnected(key, { reason: 'blocked-on-prompt', autoRestartDisabled: false })
  return 'defer'
}

/** `checkWorkingRowPane`'s line for a read that gave no evidence and ended the run (b.f2b). */
function logNoWorkingRowEvidence(ref: string, reading: WorkingPaneReading, transcript: TranscriptReading | undefined): void {
  if (reading === 'busy') {
    console.error(`[slack] reconnectSession: ${ref} is working — deferring /mcp reconnect to a later tick (b.9a7/b.rmy)`)
  } else if (reading === 'blank') {
    console.error(`[slack] reconnectSession: ${ref} is working and its pane is blank — no idle evidence; deferring /mcp reconnect to a later tick (b.f2b)`)
  } else {
    console.error(
      `[slack] reconnectSession: ${ref} is working and its pane shows an idle screen, but ${transcriptNoEvidence(transcript) ?? 'its transcript was not read'} — no idle evidence; deferring /mcp reconnect to a later tick (b.f2b/b.rmy)`,
    )
  }
}

/**
 * b.f2b, b.jg5 SRJ-604 — the restart path's check of a persona whose row
 * reads `waiting`, before the reconnect adapter types `/mcp reconnect`: one
 * `read-pane` of the row through the shared reader (`readWorkingPane`, the
 * full read, the row state `waiting`), answered by b.jg5 SRJ-117's
 * waiting-row column:
 * - a pane: a running turn (`busy`) defers; so does a prompt or dialog, which
 *   is never typed into and raises the `blocked-on-prompt` not-connected
 *   notice (once per episode); otherwise `reconnect`. The pane may be a
 *   single leftover's (b.jg5 SRJ-117, SRJ-613), so it is no proof the
 *   worker's own session is there: the reconnect's own `send-keys`
 *   (`reconnectMcpWithCause`) is the backstop. On a live row that is not
 *   `pending` it answers CONFLICT "not this launch's session" when a
 *   leftover holds the persona's session; then nothing is typed, P latches
 *   (b.jg5 SRJ-501) with its CONFLICT notice posted once, the refused
 *   `send-keys` is never retried (SRJ-118) and the adapter answers
 *   'transient';
 * - GONE (`ErrTmuxCaptureFailed`): `gone`; the adapter sweeps and escalates,
 *   typing nothing;
 * - the row absent (`ErrSpawnNotFound`): `absent`, which the adapter
 *   handles as GONE without dead evidence (b.jg5 SRJ-117);
 * - CONFLICT or UNUSABLE NAME (the reader latched the persona with the row
 *   state `waiting`, b.jg5 SRJ-501, SRJ-512), or a persona already latched,
 *   which the reader does not read: `defer`, with no notice, so nothing is
 *   typed (b.jg5 SRJ-502);
 * - ENVIRONMENT (`ErrTmuxNotAvailable`; the wrapper raised the
 *   `tmux-unavailable` outage, b.jg5 SRJ-311): `defer`, nothing typed;
 * - an UNCLASSIFIED carrying the stop mark (`stopping`: the reader's
 *   `ErrInvalidFlags` re-check decided that the server stops, b.jg5
 *   SRJ-205): `defer`, nothing typed and nothing more called;
 * - UNAVAILABLE (timeouts included), CONFIG (the wrapper raised the
 *   `ad-config-malformed` outage, b.jg5 SRJ-316) and any other
 *   UNCLASSIFIED: `reconnect` on the `waiting` row alone, agent-director's
 *   own idle signal, with one line naming the class.
 * `latchedNow` (the adapter's latched gate, b.jg5 SRJ-502) is asked right
 * before the `blocked-on-prompt` notice: a persona that latched meanwhile
 * gets no notice and `defer`. Logs one line for each answer but a plain
 * `reconnect`; never throws.
 */
export async function checkWaitingRowPane(key: string, latchedNow?: () => boolean): Promise<WaitingRowPaneVerdict> {
  const ref = keyRef(key)
  // The adapter called this for a row it has just read `waiting`.
  const read = await readWorkingPane(key, latchRowStateRead('waiting'))
  switch (read.kind) {
    case PANE_READ_PANE:
      return waitingRowPaneJudgement(key, ref, read.pane, latchedNow)
    case PANE_READ_LATCHED:
      console.error(`[slack] reconnectSession: ${ref} is waiting and is latched — deferring; nothing typed (b.jg5 SRJ-502)`)
      return 'defer'
    case PANE_READ_GONE:
      console.error(waitingRowPaneGoneLine(key, read))
      return WAITING_ROW_PANE_GONE
    case PANE_READ_ABSENT:
      console.error(waitingRowAbsentAtPaneReadLine(key, read))
      return WAITING_ROW_PANE_ABSENT
    case PANE_READ_ENVIRONMENT:
      console.error(
        `[slack] reconnectSession: ${ref} is waiting and reading its pane failed: ${read.description} — tmux is not available; not typing /mcp reconnect, deferring to a later tick (${paneReadClassNote(read)}; b.jg5 SRJ-117, SRJ-311)`,
      )
      return 'defer'
    case PANE_READ_UNCLASSIFIED:
      if (read.stopping === true) {
        console.error(
          `[slack] reconnectSession: ${ref} is waiting and reading its pane failed: ${read.description} — the agent-director version re-check decided that the server stops; not typing /mcp reconnect, nothing more is called for it (${paneReadClassNote(read)}; b.jg5 SRJ-204, SRJ-205)`,
        )
        return 'defer'
      }
      return reconnectOnWaitingRowAlone(ref, read)
    case PANE_READ_UNAVAILABLE:
    case PANE_READ_CONFIG:
      return reconnectOnWaitingRowAlone(ref, read)
  }
}

/** `checkWaitingRowPane`'s `reconnect` on the `waiting` row alone after a failed pane read, with its one line (b.f2b, b.jg5 SRJ-604). */
function reconnectOnWaitingRowAlone(ref: string, read: PaneReadFailure): 'reconnect' {
  console.error(
    `[slack] reconnectSession: ${ref} is waiting and reading its pane failed: ${read.description} — reconnecting on the waiting row alone (${paneReadClassNote(read)}; b.f2b, b.jg5 SRJ-604)`,
  )
  return 'reconnect'
}

/**
 * `checkWaitingRowPane`'s judgement of the `pane` it read (b.f2b): a running
 * turn defers; a prompt or dialog defers and raises the `blocked-on-prompt`
 * notice, unless `latchedNow` finds the persona latched right before it
 * (b.jg5 SRJ-502: no notice); anything else is `reconnect`.
 */
function waitingRowPaneJudgement(
  key: string,
  ref: string,
  pane: string,
  latchedNow: (() => boolean) | undefined,
): WorkingRowPaneVerdict {
  const reading = classifyWorkingPane(pane)
  if (reading === 'busy') {
    console.error(`[slack] reconnectSession: ${ref} is waiting but its pane shows a running turn — deferring /mcp reconnect to a later tick (b.f2b/b.rmy)`)
    return 'defer'
  }
  if (reading === 'prompt') {
    // b.jg5 SRJ-502: asked right before the notice; the gate logs its line.
    if (latchedNow?.() === true) return 'defer'
    console.error(
      `[slack] reconnectSession: ${ref} is waiting but its pane shows a prompt or dialog — not typing into it; deferring /mcp reconnect to a later tick (answer it in tmux session "${personaTmuxSessionName(key)}") (b.f2b/b.rmy)`,
    )
    notifyPersonaNotConnected(key, { reason: 'blocked-on-prompt', autoRestartDisabled: false })
    return 'defer'
  }
  return 'reconnect'
}

/**
 * b.f2b: true while the restart path holds an idle run for persona `key`'s
 * `working` row that has not yet concluded: one more reconnect attempt can
 * find the row stale and reconnect it. The health check then schedules that
 * attempt the first tick it finds the persona undeliverable, rather than
 * after two. A prompt run does not count: CSCB cannot recover that persona
 * until someone answers the prompt.
 */
export function hasPendingWorkingRowEvidence(key: string): boolean {
  return workingRowPaneRuns.get(key)?.reading === 'idle'
}

/**
 * b.f2b: forget the restart path's evidence for persona `key`'s `working` row
 * (a reconnect attempt found the row in another state or couldn't read it, so
 * the next `working` reading starts afresh). Silent; other personas are
 * untouched.
 */
export function forgetWorkingRowEvidence(key: string): void {
  workingRowPaneRuns.delete(key)
}

// ---------------------------------------------------------------------------
// Cancelling a launch's wait for a `working` row (b.f2b)
// ---------------------------------------------------------------------------

/** A running `waitForWaitingAndReconnect`, which the persona's teardown can cancel (b.f2b). */
interface WorkingRowWait {
  cancelled: boolean
  /** Ends the wait's current poll sleep at once (a no-op between sleeps). */
  wake: () => void
  /**
   * b.jg5 SRJ-118: set when the wait answers 'transient' because its
   * reconnect latched the persona (a CONFLICT or UNUSABLE NAME answer to the
   * keystrokes) or found it latched, so the ladder answers `latched`.
   */
  latched?: true
  /**
   * b.jg5 SRJ-205: set when the wait answers 'transient' because a version
   * re-check decided that the server stops (its evidence read's, or its
   * reconnect's after an `ErrInvalidFlags`); the ladder answers a `failed`
   * result marked `stopping`, records no `spawn-failed` entry and posts
   * nothing.
   */
  stopping?: true
  /**
   * b.jg5 SRJ-501: the row state the wait's last `status` read gave (no row
   * for `ErrSpawnNotFound`), for a CONFLICT at the resume or spawn the ladder
   * makes after a `dead-session` verdict. Absent until a read answers.
   */
  lastRead?: LatchRowState
}

/** The running wait of each persona whose launch waits for a `working` row (b.f2b); at most one per persona, like its launch. */
const workingRowWaits = new Map<string, WorkingRowWait>()

/**
 * Personas whose launch in flight has not started its wait for a `working`
 * row yet, but whose teardown already cancelled it (b.f2b): a wait that launch
 * starts is cancelled from its first check. Forgotten when the launch settles
 * (`spawnForPersona`).
 */
const cancelledLaunchWaits = new Set<string>()

/**
 * b.f2b: cancel persona `key`'s launch wait for a `working` row
 * (`waitForWaitingAndReconnect`, up to `WAIT_FOR_WAITING_TIMEOUT_MS`). The
 * persona's teardown calls this, so it does not wait out a launch parked on
 * the row, and neither does the apply that runs it (b.av2 SR-8.6). A running
 * wait wakes from its poll sleep at once, checks the flag after each
 * agent-director call, types nothing and returns `cancelled`; its launch then
 * settles as `not-reconnected`. When a launch for the persona is in flight
 * but has not started its wait yet, a wait it starts later is cancelled from
 * its first check. Logs one line and returns true when it cancelled a
 * running or a coming wait; returns false, silently, when no launch for the
 * persona is in flight or its wait was already cancelled.
 */
export function cancelWorkingRowWait(key: string): boolean {
  const wait = workingRowWaits.get(key)
  if (wait !== undefined) {
    if (wait.cancelled) return false
    wait.cancelled = true
    wait.wake()
    console.error(`[slack] waitForWaitingAndReconnect: ${keyRef(key)} — cancelling its launch's wait for its working row (b.f2b)`)
    return true
  }
  if (!inFlightLaunches.has(key) || cancelledLaunchWaits.has(key)) return false
  cancelledLaunchWaits.add(key)
  console.error(
    `[slack] waitForWaitingAndReconnect: ${keyRef(key)} — its launch in flight will not wait for a working row: any such wait is cancelled at once (b.f2b)`,
  )
  return true
}

/** Sleep `ms` (the wait's poll interval), or until the wait is cancelled (b.f2b). */
function sleepUnlessCancelled(wait: WorkingRowWait, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      wait.wake = () => {}
      resolve()
    }
    wait.wake = done
  })
}

/** The wait's outcome once its teardown cancelled it (b.f2b): logged, nothing typed. */
function waitCancelled(ref: string): 'cancelled' {
  console.error(`[slack] waitForWaitingAndReconnect: the wait for ${ref} was cancelled (its persona is being torn down) — nothing typed (b.f2b)`)
  return 'cancelled'
}

/** The wait's outcome once its persona is latched (b.jg5 SRJ-502): logged, nothing more called, nothing typed. */
function waitLatched(ref: string): typeof WAIT_OUTCOME_LATCHED {
  console.error(
    `[slack] waitForWaitingAndReconnect: ${ref} is latched — the wait ends; nothing more is called and nothing is typed (b.jg5 SRJ-502)`,
  )
  return WAIT_OUTCOME_LATCHED
}

/**
 * Whether the wait must end now: its teardown cancelled it, or its persona
 * `key` is latched (`personaLatchedNow`, b.jg5 SRJ-502). Asked after each
 * agent-director call the wait makes. Never throws.
 */
function waitMustEnd(key: string, wait: WorkingRowWait): boolean {
  return wait.cancelled || personaLatchedNow(key)
}

/** The ending outcome for a wait `waitMustEnd` answered true for: `cancelled` first, else `latched`. */
function endWait(ref: string, wait: WorkingRowWait): 'cancelled' | typeof WAIT_OUTCOME_LATCHED {
  return wait.cancelled ? waitCancelled(ref) : waitLatched(ref)
}

/** A wait's length for a notice: whole minutes from one minute up, else seconds. */
function describeWaitSpan(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`
}

/**
 * agent-director states in which the persona's session waits on a question
 * (`ask_user`) or a permission dialog (`check_permission`): nothing is ever
 * typed into them, and a persona left disconnected there is reported as
 * blocked on a prompt (b.f2b).
 */
export const PROMPT_ROW_STATES: ReadonlySet<string> = new Set(['ask_user', 'check_permission'])

/**
 * The not-connected notice for a wait that ended with its session alive and
 * its row in `state` while auto-restart is disabled (b.f2b):
 * `blocked-on-prompt` for `ask_user` or `check_permission` (a prompt is why
 * nothing reconnects it), else `auto-restart-disabled` with `cause`. (The
 * timeout words a `working` row's as `unproven-idle` itself.)
 */
function waitEndedNotice(state: string, cause: string): NotConnectedNotice {
  return PROMPT_ROW_STATES.has(state)
    ? { reason: 'blocked-on-prompt', autoRestartDisabled: true }
    : { reason: 'auto-restart-disabled', cause }
}

/**
 * How a launch wait that ends `not-reconnected` reports itself (b.f2b,
 * `reportWaitEndedDisconnected`): the head of its log line, the line's
 * follow-up with auto-restart on (the recovery the health check drives), and
 * the not-connected notice raised with `session_restart_delay` 0.
 */
export interface WaitEndedReport {
  readonly logHead: string
  readonly enabledFollowUp: string
  readonly notice: NotConnectedNotice
}

/**
 * The report of a wait whose poll read the row in `state`, a live state that
 * is neither `waiting` nor `working` (b.f2b): the notice is
 * `blocked-on-prompt` for a prompt state (`waitEndedNotice`).
 */
export function waitEndedOnStateReport(ref: string, state: string): WaitEndedReport {
  return {
    logHead: `[slack] waitForWaitingAndReconnect: ${ref} transitioned to state=${state} — aborting`,
    enabledFollowUp:
      'the health check reconnects it (tick sees alive && !connected on two ticks -> scheduleRestart -> reconnect, b.9a7; an ask_user or check_permission row is never typed into, b.f2b)',
    notice: waitEndedNotice(state, `it moved to state ${state} while CSCB waited to reconnect it`),
  }
}

/**
 * The report of a wait whose timeout read found the row in `state`, a live
 * state other than `waiting` (b.f2b), `timeoutMs` after it started; the
 * health check's `working`-row report comes after `unprovenIdleAfterMs` of
 * holding back. A `working` row's notice is `unproven-idle`, held for
 * `heldMs` (required for it); any other state's is `waitEndedNotice`'s.
 */
export function waitTimedOutLiveReport(
  ref: string,
  timeoutMs: number,
  unprovenIdleAfterMs: number,
  state: string,
  heldMs?: number,
): WaitEndedReport {
  return {
    logHead: `[slack] reconnect: gave up waiting for ${ref} after ${timeoutMs}ms — claude process state=${state} (alive)`,
    enabledFollowUp: `the health check schedules a reconnect once it has seen the persona disconnected on two ticks; for a working row it types /mcp reconnect only once its pane has shown the same idle screen and its transcript has ended with a completed turn, both unchanged, across attempts, and never into a prompt, and it reports the persona once CSCB has held back from the row for ${describeWaitSpan(unprovenIdleAfterMs)} (b.9a7/b.rmy/b.f2b)`,
    notice:
      state === 'working'
        ? { reason: 'unproven-idle', autoRestartDisabled: true, heldMs: heldMs ?? 0 }
        : waitEndedNotice(
            state,
            `its agent-director row still read ${state} ${describeWaitSpan(timeoutMs)} after launch, and CSCB found no proof it was idle`,
          ),
  }
}

/**
 * The report of a wait whose timeout `status` read failed with any error but
 * `ErrSpawnNotFound` (b.jg5 SRJ-605), `timeoutMs` after it started:
 * `described` is the error through the redacting describer and `errorClass`
 * its class. The line names no tmux session; the notice is
 * `auto-restart-disabled`, saying agent-director could not report the
 * persona's state.
 */
export function waitTimedOutUnreadReport(
  ref: string,
  timeoutMs: number,
  described: string,
  errorClass: AdErrorClass,
): WaitEndedReport {
  return {
    logHead: `[slack] waitForWaitingAndReconnect: timed out for ${ref} after ${timeoutMs}ms — its status read failed: ${described} (class=${errorClass}), so its state is not known — not reconnected (b.jg5 SRJ-605)`,
    enabledFollowUp:
      "the health check recovers it from its own reads of the row: once agent-director answers with the row live and the persona disconnected, the tick schedules a reconnect (b.9a7)",
    notice: {
      reason: 'auto-restart-disabled',
      cause: `agent-director could not report its state when CSCB stopped waiting for it, ${describeWaitSpan(timeoutMs)} after launching it`,
    },
  }
}

/**
 * The one line a wait ending `not-reconnected` writes (b.f2b): `report`'s
 * head and, with `session_restart_delay` (`sessionRestartDelay`) on, its
 * follow-up; with it 0, that nothing will reconnect the persona and the
 * not-connected notice reports it.
 */
export function waitEndedDisconnectedLine(
  report: Pick<WaitEndedReport, 'logHead' | 'enabledFollowUp'>,
  sessionRestartDelay: number,
): string {
  return sessionRestartDelay !== 0
    ? `${report.logHead}; ${report.enabledFollowUp}`
    : `${report.logHead}; session_restart_delay is 0, so nothing will reconnect it — the not-connected notice reports it (once per episode) (b.f2b)`
}

/**
 * The line of a wait whose `status` read found persona `ref`'s row absent
 * (`ErrSpawnNotFound`, b.jg5 SRJ-605): at the poll, or, with `timedOutAfterMs`,
 * at the timeout read. The wait answers 'dead-session' with no tmux probe,
 * its cause `row-absent`, a row read and not dead evidence (b.jg5 SRJ-611);
 * the recovery's spawn classifies any leftover session.
 */
export function waitRowAbsentLine(ref: string, timedOutAfterMs?: number): string {
  const at = timedOutAfterMs === undefined ? `${ref}'s` : `timed out for ${ref} after ${timedOutAfterMs}ms —`
  return `[slack] waitForWaitingAndReconnect: ${at} agent-director row is absent (ErrSpawnNotFound) — dead session (${describeDeadEvidence(carriedDeadEvidenceOf(DEAD_SESSION_CAUSE_ROW_ABSENT))}); the recovery's spawn classifies any leftover session (b.jg5 SRJ-605, SRJ-611)`
}

/**
 * The line of a wait whose `status` read found persona `ref`'s row in
 * `state`, `ended` or `missing` (b.ecw, b.jg5 SRJ-605): at the poll, or, with
 * `timedOutAfterMs`, at the timeout read after its sweep. The wait answers
 * 'dead-session' with no tmux probe, its cause `row-read-finished`, a row
 * read and not dead evidence: a finished row is not proof that the worker is
 * gone (b.jg5 SRJ-611). The recovery's resume or spawn decides what holds the
 * persona's name.
 */
export function waitRowFinishedLine(ref: string, state: string, timedOutAfterMs?: number): string {
  const at = timedOutAfterMs === undefined ? `${ref}'s` : `timed out for ${ref} after ${timedOutAfterMs}ms — its`
  return `[slack] waitForWaitingAndReconnect: ${at} row reads state=${state} — dead session (${describeDeadEvidence(carriedDeadEvidenceOf(DEAD_SESSION_CAUSE_ROW_READ_FINISHED))}); the recovery's resume or spawn decides what holds its name (b.ecw, b.jg5 SRJ-605, SRJ-611)`
}

/**
 * The line of a wait whose poll `status` read failed with any error but
 * `ErrSpawnNotFound` (b.jg5 SRJ-605): `described` is the error through the
 * redacting describer and `errorClass` its class. The wait goes on; it writes
 * this for its first failed read and again only when the class changes.
 */
export function waitPollStatusErrorLine(ref: string, described: string, errorClass: AdErrorClass): string {
  return `[slack] waitForWaitingAndReconnect: status read failed for ${ref}: ${described} (class=${errorClass}) — its state is not known; still waiting for its working row, nothing posted (b.jg5 SRJ-605)`
}

/**
 * b.f2b: the wait ends with the persona's session alive but not reconnected.
 * Log what happens next for the restart delay in effect
 * (`waitEndedDisconnectedLine`): with auto-restart on, the recovery the health
 * check drives; with `session_restart_delay` 0, that nothing will reconnect
 * it, and raise the once-per-episode not-connected notice, so the persona is
 * never left down silently. Returns the wait's outcome, `not-reconnected`.
 */
function reportWaitEndedDisconnected(key: string, config: PersonaConfig, report: WaitEndedReport): 'not-reconnected' {
  console.error(waitEndedDisconnectedLine(report, config.session_restart_delay))
  if (config.session_restart_delay === 0) notifyPersonaNotConnected(key, report.notice)
  return 'not-reconnected'
}

// ---------------------------------------------------------------------------
// reconcileMissingSweep — shared, load-shedding findMissing sweep
// ---------------------------------------------------------------------------

/**
 * The findMissing memo window (b.m4r), measured on the session manager's
 * clock (`_now`). AD's `findMissing({})` is a whole-store, per-row
 * evidence-based sweep, so two sweeps fired within a few seconds of each
 * other return the same verdicts. On a fleet restart, startupSessionManager
 * (concurrency=3) resolves collisions across N channels near-simultaneously,
 * and every `working`-row collision — plus each dead-path
 * `reconcileMissingFirst` — would otherwise fire its own whole-store sweep
 * (N sweeps, up to 3 concurrent). Single-flight collapses concurrent ordinary
 * callers onto one in-flight run; the window then lets ordinary callers
 * arriving just after it resolves reuse that result instead of re-sweeping.
 *
 * 10s comfortably covers one startup reconcile wave (the whole concurrency=3
 * wave over the fleet completes well inside this window) and collapses a
 * same-tick escalate-dead burst: when N personas escalate together (b.nk5
 * fleet shape — /tmp wiped, every persona dead-tmux at once), those
 * `sweepDeadTmuxChannel` callers land inside the window and share the single
 * in-flight or memoized sweep — one findMissing reconciles the whole store for
 * all of them. Across ticks the window is far shorter than the ~120s
 * health-check cadence, so a later tick's escalate-dead sweep falls outside
 * it and runs again. A swept row is not sure to read dead afterwards:
 * agent-director may leave it live (in `unverified_ids`, or, when `pending`,
 * not judged at all), and it may stay live for further ticks; each
 * escalate-dead tick then sweeps again, with no step beyond the sweep, and
 * the restart path posts the slow-recovery notice once after 3 such ticks
 * (b.jg5 SRJ-610, SRJ-1010). Only redundant load is shed (see the
 * `_buildReconnectSessionAdapter` call-site note in src/server.ts and
 * docs/architecture.md's sweep note).
 *
 * A bypassing run (`FIND_MISSING_RUN_BYPASSING`, b.jg5 SRJ-120) ignores the
 * window and anything in flight; its result is memoized for later ordinary
 * callers like any other run's.
 */
export const FIND_MISSING_MEMO_TTL_MS = 10 * 1000

/**
 * An ordinary findMissing run (b.jg5 SRJ-120): a caller arriving inside the
 * memo window reuses the memoized result, and one arriving while a run is in
 * flight joins it. Every caller today is ordinary.
 */
const FIND_MISSING_RUN_ORDINARY = 'ordinary'

/**
 * A bypassing findMissing run (b.jg5 SRJ-120): a new call whatever is
 * memoized or in flight, whose result is memoized for later ordinary callers
 * (`bypassingFindMissingSweep`).
 */
const FIND_MISSING_RUN_BYPASSING = 'bypassing'

/** The kind of a findMissing run (b.jg5 SRJ-120). */
type FindMissingRunKind = typeof FIND_MISSING_RUN_ORDINARY | typeof FIND_MISSING_RUN_BYPASSING

/** What a findMissing run is asked for (`reconcileMissingSweep`, `sharedFindMissingSweep`). */
interface FindMissingSweepOptions {
  /** The run kind; ordinary when absent. */
  readonly kind?: FindMissingRunKind
  /**
   * The persona whose own row the caller's next step reads with a `get`: a run
   * this caller starts makes no post-run `get` of that row (b.jg5 SRJ-120).
   * Only the starter's key counts: an ordinary caller that joins the run gets
   * no read of that row from it.
   */
  readonly nextStepGetKey?: string
  /**
   * The start sweep's run (`runStartSweepPostKillFindMissing`, which acts
   * for no persona): a run this caller starts makes its post-run `get`s with
   * an UNUSABLE NAME answer routed per SRJ-1002, so it latches nothing (b.jg5
   * SRJ-512) and is carried as a failed read. The note and launch-start
   * decisions still latch there (b.jg5 SRJ-114, SRJ-513). A run another
   * caller started keeps that caller's reads.
   */
  readonly startSweepRun?: boolean
  /**
   * Asked once when a run this caller starts has returned, before its
   * post-run `get`s: an answer other than true (or a throw) makes none, with
   * one line (the start sweep's shutdown stop, b.jg5 SRJ-714). Asked again
   * as each of those `get`s settles, before its answer is acted on: an
   * answer other than true leaves that `get`'s answer not acted on
   * (`readListedPersonaRows`). Absent: the `get`s are made and acted on.
   */
  readonly postRunGetsGo?: () => boolean
  /**
   * Told what the post-run `get` of the caller's own row read (its state, or
   * no row for `ErrSpawnNotFound`), once the run this caller started or
   * joined has resolved, when that `get` was made and acted on and did not
   * latch the persona (b.jg5 SRJ-120, SRJ-611: a read of the row after the
   * path's own find-missing run). Never told on a memo hit, a failed run, a
   * refused `get` or a row not listed in `unverified_ids`. A sink that throws
   * is ignored. Absent: nothing is told.
   */
  readonly onOwnRowRead?: (read: LatchRowState) => void
}

/** The context an UNUSABLE NAME answer to the start sweep's post-run `get`s is routed in (b.jg5 SRJ-1002). */
const START_SWEEP_ROUTED_CONTEXT = 'the start sweep'

let _findMissingMemoTtlMs = FIND_MISSING_MEMO_TTL_MS

/** What the post-run `get`s of a run read (`readListedPersonaRows`). */
interface PostRunReads {
  /**
   * The configured personas whose own row a post-run `get` of this run read
   * as latching (`OwnRowRead.latched`, b.jg5 SRJ-114, SRJ-513) or that answered
   * UNUSABLE NAME (`OWN_ROW_READ_LATCHED`, b.jg5 SRJ-512).
   */
  readonly latchedKeys: ReadonlySet<string>
  /**
   * The configured personas whose own row's post-run `get` failed with an
   * error other than `ErrSpawnNotFound` and UNUSABLE NAME (`OWN_ROW_READ_REFUSED`), each with
   * that error, carried unchanged; in the start sweep's run an UNUSABLE NAME
   * answer too, which latched nothing there (b.jg5 SRJ-512, SRJ-1002). Only
   * the persona's own caller acts on it (`postRunGetRefusal`, b.jg5
   * SRJ-105, SRJ-114), and an UNUSABLE NAME answer is no refusal there.
   */
  readonly refusedReads: ReadonlyMap<string, unknown>
  /**
   * The configured personas whose own row's post-run `get` was acted on and
   * did not latch, each with what it read: the row's state
   * (`latchRowStateRead`) or no row for `ErrSpawnNotFound`. Only the
   * persona's own caller is told it (`FindMissingSweepOptions.onOwnRowRead`).
   */
  readonly readStates: ReadonlyMap<string, LatchRowState>
}

/** What a run that resolved hands every caller awaiting it: its result and its post-run reads. */
interface FindMissingRunOutcome extends PostRunReads {
  readonly result: FindMissingResult
}

/** One findMissing run the server made. `seq` orders runs by when they started. */
interface FindMissingRun {
  readonly seq: number
  readonly kind: FindMissingRunKind
  readonly promise: Promise<FindMissingRunOutcome>
}

/** Sequence number of the most recently started run (`FindMissingRun.seq`). */
let _findMissingRunSeq = 0
/**
 * The most recently started run while it is in flight: ordinary callers join
 * it. Cleared when that run settles; an older run settling never clears it.
 */
let _findMissingInFlight: FindMissingRun | null = null
/**
 * The memo: the result of the most recently started run that succeeded, with
 * the time its call resolved (`_now`) and its `seq`. A run that started earlier
 * than the memoized one never overwrites it; a failure never touches it.
 */
let _findMissingLast: { result: FindMissingResult; at: number; seq: number } | null = null

/**
 * Test-only seam (mirrors `_setWaitForWaitingTimeoutMs`): override the memo
 * window (`FIND_MISSING_MEMO_TTL_MS` by default).
 */
export function _setFindMissingMemoTtlMs(ms: number): void {
  _findMissingMemoTtlMs = ms
}

/**
 * Test-only seam: clear all memo state (the in-flight run, the memoized
 * result, the run sequence) and restore the default window. Tests that count
 * findMissing calls must call this in their setup/teardown to stay
 * deterministic.
 */
export function _resetFindMissingMemo(): void {
  _findMissingInFlight = null
  _findMissingLast = null
  _findMissingRunSeq = 0
  _findMissingMemoTtlMs = FIND_MISSING_MEMO_TTL_MS
}

/**
 * Run AD's per-row, evidence-based `findMissing({})` sweep for persona `key`
 * through `withOutageDetection`, shedding redundant load (b.m4r, b.jg5
 * SRJ-120; `sharedFindMissingSweep` holds the rules):
 *
 * - An ordinary run (the default) reuses a result memoized inside the window
 *   and joins a run in flight; a bypassing run always makes a new call.
 * - After a run the server makes (not a memo reuse), each configured
 *   persona's own row listed in `unverified_ids` is read with one `get`
 *   (except `opts.nextStepGetKey`'s and an already-latched persona's), and
 *   only a `provenance_conflict` note there latches.
 *
 * Failures are never memoized. A failure the arming predicate answers a cause
 * for (b.jg5 SRJ-105, `refusalAt` with verb `find-missing`, which is not a
 * read verb, so an UNAVAILABLE, an ENVIRONMENT, a CONFIG or an UNCLASSIFIED
 * answer, b.jg5 SRJ-313) is a refusal: one refusal line, and
 * `FIND_MISSING_REFUSED`, after which the caller calls nothing more in its
 * attempt. Any other failure, UNUSABLE NAME included, logs once and lets the
 * caller proceed. A post-run `get` of persona `key`'s own row that fails with
 * an error other than `ErrSpawnNotFound` is handled as a `get` at an SRJ-114
 * site (b.jg5 SRJ-105, SRJ-114, `refusalAt` with verb `get`): a refusal
 * answers `FIND_MISSING_REFUSED` too; an UNUSABLE NAME answer there latches
 * the persona (b.jg5 SRJ-512), whose caller then gets `FIND_MISSING_LATCHED`.
 *
 * @param key persona key: the outage key and log context — the sweep itself is whole-store.
 * @param logPrefix distinguishes the call sites in the log line.
 * @param ref log reference; defaults to the key alone.
 * @param opts the run kind and the next-step `get` key; an ordinary run with none by default.
 * @returns the sweep's result (this caller's run, a shared in-flight one or
 *   the memoized one), `FIND_MISSING_REFUSED` for a refusal,
 *   `FIND_MISSING_LATCHED` when persona `key` is latched once the sweep is
 *   done (b.jg5 SRJ-502), or undefined when the sweep failed otherwise.
 */
async function reconcileMissingSweep(
  key: string,
  logPrefix: string,
  ref: string = keyRef(key),
  opts: FindMissingSweepOptions = {},
  call: FindMissingCallOptions = {},
): Promise<FindMissingSweepAnswer> {
  return sharedFindMissingSweep(
    async () => {
      try {
        return await withOutageDetection(key, undefined, 'find-missing', (client) => client.findMissing({}), call.outage)
      } catch (err) {
        noteFindMissingFailure(call, err)
        throw err
      }
    },
    logPrefix,
    ref,
    key,
    opts,
  )
}

/**
 * How a persona's own findMissing call is made (`bypassingFindMissingSweep`):
 * its wrapper's options (an old-life wait's calls arm nothing for the old
 * key, b.jg5 SRJ-811, SRJ-1512) and a sink told the call's failure before it
 * is handled (the wait's record of what its calls met). Absent: the wrapper's
 * defaults, no sink.
 */
export interface FindMissingCallOptions {
  readonly outage?: OutageDetectionOptions
  readonly onFailure?: (err: unknown) => void
}

/** Tell `call.onFailure` the run's failure; a throw is ignored. */
function noteFindMissingFailure(call: FindMissingCallOptions, err: unknown): void {
  try {
    call.onFailure?.(err)
  } catch {
    /* the sink's own failure changes nothing about the run */
  }
}

/**
 * What a persona's findMissing sweep answers (`reconcileMissingSweep`,
 * `bypassingFindMissingSweep`): the result, `FIND_MISSING_REFUSED`,
 * `FIND_MISSING_LATCHED`, or undefined for any other failure.
 */
export type FindMissingSweepAnswer =
  | FindMissingResult
  | typeof FIND_MISSING_REFUSED
  | typeof FIND_MISSING_LATCHED
  | undefined

/**
 * A persona's findMissing sweep that was refused (b.jg5 SRJ-105): the sweep
 * failed with an error the arming predicate answers a cause for, which for
 * `find-missing` (not a read verb) is an UNAVAILABLE, an ENVIRONMENT, a
 * CONFIG or an UNCLASSIFIED answer (b.jg5 SRJ-313); or the sweep succeeded
 * and the post-run `get` of the persona's own row failed with such an error,
 * which for `get` is any error but `ErrSpawnNotFound` and an UNUSABLE NAME
 * answer (b.jg5 SRJ-114). The caller stops its launch or recovery attempt:
 * no resume, kill, delete, launch, reconnect or dead-session verdict follows.
 */
export const FIND_MISSING_REFUSED: unique symbol = Symbol('find-missing refused')

/**
 * A persona's findMissing sweep after which the persona is latched (b.jg5
 * SRJ-502): a post-run `get` of its own row read the latching note (b.jg5
 * SRJ-114, SRJ-120) or answered UNUSABLE NAME (b.jg5 SRJ-512), or the
 * installed latch answers it latched
 * (`personaLatchedNow`). The caller makes no further agent-director call for
 * the persona: no status read, resume, kill, delete, launch or reconnect.
 */
export const FIND_MISSING_LATCHED: unique symbol = Symbol('find-missing latched')

/**
 * The memo and single-flight core of every findMissing caller
 * (b.m4r, b.jg5 SRJ-120). `start` makes the call when a run starts: a
 * persona's call through `withOutageDetection`, or the start sweep's direct
 * call (`runStartSweepPostKillFindMissing`), which acts for no persona. Never
 * throws.
 *
 * Run kinds (`opts.kind`):
 * - ordinary (the default): the run in flight, if any, is joined (a
 *   bypassing one included); otherwise a result memoized less than the
 *   window ago (`_findMissingMemoTtlMs`, on `_now`) is returned with no call
 *   and no `get`; otherwise a run starts;
 * - bypassing: a run always starts, and becomes the run in flight that later
 *   ordinary callers join.
 * A run that succeeds is memoized only when no run started after it has been
 * memoized already, so an older run resolving later never overwrites a newer
 * result, and it clears the in-flight slot only while it is still the run
 * there. Each run logs its line once (the starter's `logPrefix` and `ref`):
 *
 *   [slack] <logPrefix>: findMissing sweep for <ref> — count=<n> ids=[…] unverified=<n> unverified_ids=[…]
 *   [slack] <logPrefix>: bypassing findMissing sweep for <ref> — count=<n> ids=[…] unverified=<n> unverified_ids=[…]
 *
 * Post-run `get`s (`readListedPersonaRows`, b.jg5 SRJ-120): when a run
 * resolves, and before any caller awaiting it (its starter and its joiners
 * alike) goes on, each configured persona's own row listed in
 * `unverified_ids` is read with one `get` through the shared own-row read
 * (`readPersonaOwnRow`), except the row of the starter's
 * `opts.nextStepGetKey` and the row of a persona already latched then
 * (`personaLatchedNow`), which is skipped with no `get` and no latch call.
 * A memo hit makes no `get`. When the `get` of a
 * persona caller's own row failed with an error other than
 * `ErrSpawnNotFound`, that caller, the starter or a joiner, handles it as a
 * `get` at an SRJ-114 site (`postRunGetRefusal`, b.jg5 SRJ-105, SRJ-114): a
 * joiner first reports it under its own key, then a refusal (`refusalAt`
 * with `get`) logs its line and answers `FIND_MISSING_REFUSED`:
 *
 *   [slack] <logPrefix>: post-sweep get refused for <ref>: <failure> — no spawn-failure notice; nothing more is called (b.jg5 SRJ-105)
 *
 * An UNUSABLE NAME answer there is no failed read: it latched the persona
 * (b.jg5 SRJ-512), so its caller gets `FIND_MISSING_LATCHED`. A
 * failed `get` of another persona's row only shows in the run's line, and
 * no failed `get` changes the run's result or its memo.
 *
 * Failures, of either kind, are logged with the run kind, never memoized, and
 * leave any earlier memoized result in place; a failed run makes no `get`.
 * A joiner's failure is its own: a failed sweep is reported to the retry
 * timer once per persona that met it (b.jg5 SRJ-301): the starter's
 * `withOutageDetection` reports it under the starter's key, and a persona
 * that joined a run someone else started (another persona's, or the start
 * sweep's direct call) reports it here under its own key. A joiner whose
 * sweep failed with ENVIRONMENT (`ErrTmuxNotAvailable`, by class through
 * `src/ad-error-class.ts`) also raises its own 'tmux-unavailable' before that
 * report, as the starter's wrapper does for the starter (b.jg5 SRJ-311): same
 * onset, same-flag dedupe. A joiner whose sweep failed with CONFIG
 * (`ErrConfigMalformed`) raises its own 'ad-config-malformed' the same way
 * (b.jg5 SRJ-316). For a persona's caller, the starter and each joiner alike,
 * a refused sweep answers `FIND_MISSING_REFUSED` (b.jg5 SRJ-105); a caller
 * that acts for no persona only ever gets undefined for a failure. Any other
 * failure logs:
 *
 *   [slack] <logPrefix>: findMissing sweep failed for <ref>: <failure> — proceeding
 *   [slack] <logPrefix>: bypassing findMissing sweep failed for <ref>: <failure> — proceeding
 *
 * A persona's caller gets `FIND_MISSING_LATCHED` instead of a result or
 * undefined when its persona is latched once the sweep is done (b.jg5
 * SRJ-502): a post-run `get` of this run read its row as latching, or
 * `personaLatchedNow` answers true. The caller logs its own stop line. A
 * refusal, of the sweep or of the post-run `get` of the caller's own row,
 * answers `FIND_MISSING_REFUSED` whether or not the persona is latched.
 */
async function sharedFindMissingSweep(
  start: () => Promise<FindMissingResult>,
  logPrefix: string,
  ref: string,
  key?: undefined,
  opts?: FindMissingSweepOptions,
): Promise<FindMissingResult | undefined>
async function sharedFindMissingSweep(
  start: () => Promise<FindMissingResult>,
  logPrefix: string,
  ref: string,
  key: string,
  opts?: FindMissingSweepOptions,
): Promise<FindMissingSweepAnswer>
async function sharedFindMissingSweep(
  start: () => Promise<FindMissingResult>,
  logPrefix: string,
  ref: string,
  key?: string,
  opts: FindMissingSweepOptions = {},
): Promise<FindMissingSweepAnswer> {
  const kind = opts.kind ?? FIND_MISSING_RUN_ORDINARY

  // Single flight (ordinary runs only): join the run in flight rather than
  // starting one. Asked before the memo, so an ordinary caller arriving while
  // a bypassing run is in flight joins it; with ordinary runs alone a run is
  // in flight only once the memo has expired.
  const joined = kind === FIND_MISSING_RUN_ORDINARY ? _findMissingInFlight : null

  // Memo hit (ordinary runs only): a recent successful run is still inside the window.
  if (
    joined === null &&
    kind === FIND_MISSING_RUN_ORDINARY &&
    _findMissingLast &&
    _now() - _findMissingLast.at < _findMissingMemoTtlMs
  ) {
    return latchedOr(key, _findMissingLast.result, NO_LATCHED_KEYS)
  }

  const run = joined ?? startFindMissingRun(start, kind, opts, logPrefix, ref)
  if (joined === null) _findMissingInFlight = run

  let outcome: FindMissingRunOutcome
  try {
    outcome = await run.promise
  } catch (err) {
    // A joiner's failure is its own: raise and report it under its key, as the
    // starter's wrapper did under the starter's (b.jg5 SRJ-301, SRJ-311).
    if (joined !== null && key !== undefined) {
      const { errorClass } = classifyAdError(err)
      if (errorClass === AD_ERROR_CLASS_ENVIRONMENT) {
        // b.jg5 SRJ-1021: the raising error picks the onset.
        raiseTmuxUnavailable(key, err)
      } else if (errorClass === AD_ERROR_CLASS_CONFIG) {
        // b.jg5 SRJ-316: one outage per persona that met the answer.
        raiseAdConfigMalformed(key, err)
      }
      reportAgentDirectorError(key, err, 'find-missing')
    }
    const what = findMissingSweepWords(run.kind)
    // b.jg5 SRJ-105: a refused sweep stops the persona's attempt.
    if (key !== undefined && refusalAt(key, err, 'find-missing', logPrefix, what, ref)) {
      return FIND_MISSING_REFUSED
    }
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('findMissing', 'UnknownError', String(err))
    console.error(`[slack] ${logPrefix}: ${what} failed for ${ref}: ${describeAgentDirectorFailure(e)} — proceeding`)
    return latchedOr(key, undefined, NO_LATCHED_KEYS)
  }
  // b.jg5 SRJ-105, SRJ-114: a failed post-run `get` of the caller's own row stops its attempt.
  if (key !== undefined && postRunGetRefusal(key, outcome.refusedReads, joined !== null, logPrefix, ref)) {
    return FIND_MISSING_REFUSED
  }
  if (key !== undefined) tellOwnRowRead(opts, outcome.readStates.get(key))
  return latchedOr(key, outcome.result, outcome.latchedKeys)
}

/**
 * Tell the caller's `opts.onOwnRowRead` what the post-run `get` of its own
 * row read, when one was made (`read` defined). A sink that throws is
 * ignored. Never throws.
 */
function tellOwnRowRead(opts: FindMissingSweepOptions, read: LatchRowState | undefined): void {
  if (read === undefined || opts.onOwnRowRead === undefined) return
  try {
    opts.onOwnRowRead(read)
  } catch {
    /* the sink's own failure changes nothing about the run */
  }
}

/** No persona latched by a run's post-run `get`s. */
const NO_LATCHED_KEYS: ReadonlySet<string> = new Set<string>()

/**
 * Whether the post-run `get` of persona `key`'s own row, made by the run its
 * caller started or joined, is a refusal for that caller (b.jg5 SRJ-114:
 * this read is one of the `get` sites, and any error but `ErrSpawnNotFound`
 * follows SRJ-105's `status`/`get`/`list` rule). Only `key`'s own read
 * counts: another persona's failed read stays in the run's summary line.
 * When `key`'s read failed (`refusedReads`) and the caller joined a run
 * someone else started, the error is first reported under `key`
 * (`reportAgentDirectorError` with `get`), as a joiner's failed sweep is: the
 * `get` ran in the starter's context, so the caller's own attempt had not
 * seen it (b.jg5 SRJ-301); the read's wrapper has already raised `key`'s
 * outage flags. Then `refusalAt` with `get` decides: a refusal logs its one
 * line and answers true; any other error answers false (only an UNUSABLE
 * NAME answer carried from the start sweep's run, which latched nothing
 * there, b.jg5 SRJ-1002; elsewhere that answer latched the persona and is
 * not carried here), and the caller goes on as after any read. A read that answered absent, or no read,
 * answers false. Never throws.
 */
function postRunGetRefusal(
  key: string,
  refusedReads: ReadonlyMap<string, unknown>,
  joined: boolean,
  logPrefix: string,
  ref: string,
): boolean {
  if (!refusedReads.has(key)) return false
  const err = refusedReads.get(key)
  if (joined) reportAgentDirectorError(key, err, 'get')
  return refusalAt(key, err, 'get', logPrefix, 'post-sweep get', ref) !== undefined
}

/**
 * What a sweep answers persona `key`'s caller: `FIND_MISSING_LATCHED` when
 * `key` is in `latchedKeys` or latched now (`personaLatchedNow`), otherwise
 * `answer`. A caller that acts for no persona (`key` undefined) gets `answer`.
 */
function latchedOr(
  key: string | undefined,
  answer: FindMissingResult | undefined,
  latchedKeys: ReadonlySet<string>,
): FindMissingResult | typeof FIND_MISSING_LATCHED | undefined {
  if (key === undefined) return answer
  return latchedKeys.has(key) || personaLatchedNow(key) ? FIND_MISSING_LATCHED : answer
}

/** The run's words in its log lines: `findMissing sweep`, or `bypassing findMissing sweep` for a bypassing run. */
function findMissingSweepWords(kind: FindMissingRunKind): string {
  return kind === FIND_MISSING_RUN_BYPASSING ? 'bypassing findMissing sweep' : 'findMissing sweep'
}

/**
 * The read name a findMissing run gives the old-life hold end line of each
 * row in its `ids` (b.jg5 SRJ-809): `<logPrefix>: findMissing sweep`, or
 * `<logPrefix>: bypassing findMissing sweep` for a bypassing run. Pure.
 */
export function findMissingRunReadName(logPrefix: string, bypassing = false): string {
  return `${logPrefix}: ${findMissingSweepWords(bypassing ? FIND_MISSING_RUN_BYPASSING : FIND_MISSING_RUN_ORDINARY)}`
}

/**
 * Start one findMissing run (`sharedFindMissingSweep`): make the call, then,
 * on success, log the run's line, end the old-life hold on each row in the
 * result's `ids` (`noteOldLifeRowRead`, b.jg5 SRJ-809; not when the starter's
 * `postRunGetsGo` answered no, as its post-run `get`s are not made then),
 * make the post-run `get`s
 * (`readListedPersonaRows`, whose latched and failed reads the run's outcome
 * carries), memoize the result unless a run started later
 * has been memoized already, and clear the in-flight slot while this run is
 * still in it. On failure only the slot is cleared (while this run is in it)
 * and the error is rethrown to every caller awaiting the run. The caller puts
 * the run in the in-flight slot.
 */
function startFindMissingRun(
  start: () => Promise<FindMissingResult>,
  kind: FindMissingRunKind,
  opts: FindMissingSweepOptions,
  logPrefix: string,
  ref: string,
): FindMissingRun {
  const seq = ++_findMissingRunSeq
  // Assigned before the call below can settle: `start` runs behind an await.
  let run: FindMissingRun | undefined
  const promise = (async (): Promise<FindMissingRunOutcome> => {
    let result: FindMissingResult
    try {
      // The async wrapper turns a synchronous throw from `start` into a rejection.
      result = await (async () => start())()
    } catch (err) {
      if (_findMissingInFlight === run) _findMissingInFlight = null
      throw err
    }
    const at = _now()
    const words = findMissingSweepWords(kind)
    console.error(
      `[slack] ${logPrefix}: ${words} for ${ref} — count=${result.count} ids=[${result.ids.join(',')}] unverified=${result.unverified} unverified_ids=[${result.unverified_ids.join(',')}]`,
    )
    const go = postRunGetsGo(opts)
    // b.jg5 SRJ-809: a row in this run's `ids` reads `missing`, which ends an
    // old-life hold on it, whoever made the run; a memo reuse ends nothing new.
    if (go) for (const id of result.ids ?? []) noteOldLifeRowRead(id, { kind: OLD_LIFE_ROW_READ_FIND_MISSING_IDS }, findMissingRunReadName(logPrefix, kind === FIND_MISSING_RUN_BYPASSING))
    const reads = go
      ? await readListedPersonaRows(
          result,
          opts.nextStepGetKey,
          logPrefix,
          `${words} for ${ref}`,
          opts.startSweepRun === true ? START_SWEEP_ROUTED_CONTEXT : undefined,
          opts.postRunGetsGo === undefined ? undefined : () => postRunGetsGo(opts),
        )
      : noPostRunReads(logPrefix, `${words} for ${ref}`)
    if (_findMissingLast === null || _findMissingLast.seq < seq) _findMissingLast = { result, at, seq }
    if (_findMissingInFlight === run) _findMissingInFlight = null
    return { result, latchedKeys: reads.latchedKeys, refusedReads: reads.refusedReads, readStates: reads.readStates }
  })()
  run = { seq, kind, promise }
  return run
}

/** The starter's `postRunGetsGo` answer: true when absent, false for any other answer than true or a throw. Never throws. */
function postRunGetsGo(opts: FindMissingSweepOptions): boolean {
  if (opts.postRunGetsGo === undefined) return true
  try {
    return opts.postRunGetsGo() === true
  } catch {
    return false
  }
}

/**
 * A run's post-run reads when its starter's `postRunGetsGo` answered no: no
 * `get` is made, nothing latched and nothing refused, with one line:
 *
 *   [slack] <logPrefix>: after the <run> — no post-sweep get is made: its caller stopped (b.jg5 SRJ-120, SRJ-714)
 *
 * Never throws.
 */
function noPostRunReads(logPrefix: string, run: string): PostRunReads {
  console.error(`[slack] ${logPrefix}: after the ${run} — no post-sweep get is made: its caller stopped (b.jg5 SRJ-120, SRJ-714)`)
  return { latchedKeys: NO_LATCHED_KEYS, refusedReads: new Map<string, unknown>(), readStates: new Map<string, LatchRowState>() }
}

/**
 * The persona key whose own row id `id` is (`cscb_<key>`, `personaInstanceId`)
 * when that key is a persona of the applied configuration now (the installed
 * `ConfiguredPersonaQuery`, `configuredReadingOf`); undefined for any other
 * id: another caller's row, a pre-persona row, a non-`cscb_` id, or the
 * `cscb_<key>` of a key outside the applied configuration (C14, C24). With no
 * query installed no id counts. Pure but for the query; never throws.
 */
function configuredPersonaKeyOfRowId(id: unknown): string | undefined {
  const key = ownRowKeyOfRowId(id)
  if (key === undefined) return undefined
  return configuredReadingOf(key).configured ? key : undefined
}

/**
 * The key whose own row id `id` is (`cscb_<key>`, `personaInstanceId`),
 * configured or not; undefined for a non-`cscb_` id or the bare prefix. Pure;
 * never throws.
 */
function ownRowKeyOfRowId(id: unknown): string | undefined {
  if (typeof id !== 'string' || !id.startsWith(PERSONA_INSTANCE_ID_PREFIX)) return undefined
  const key = id.slice(PERSONA_INSTANCE_ID_PREFIX.length)
  if (key === '' || personaInstanceId(key) !== id) return undefined
  return key
}

/**
 * The post-run `get`s of a findMissing run the server made (b.jg5 SRJ-120's
 * notes on CSCB's rows): each configured persona's own row listed in
 * `result.unverified_ids` (`configuredPersonaKeyOfRowId`, each persona once,
 * in list order), except `nextStepGetKey`'s, is read with one `get` through
 * the shared own-row read (`readPersonaOwnRow`, through
 * `withOutageDetection` for that persona, whatever persona the run was made
 * for), all at once, and the run waits for every one of them to settle.
 * A listed persona that is already latched when the keys are built
 * (`personaLatchedNow`; a latched query that throws counts as latched) is
 * skipped: no `get`, no latch call, nothing in the answer; its own caller
 * still stops on the latch (`latchedOr`).
 * SRJ-114's rule applies at each read: only a `provenance_conflict` note on
 * the persona's own row latches it, and the read logs its note lines
 * (`<logPrefix>: post-sweep get for persona=<key>: …`); a `get` answering
 * UNUSABLE NAME latches it too (b.jg5 SRJ-512), and that persona is among
 * the latched ones, so its caller stops (`FIND_MISSING_LATCHED`), except in
 * the start sweep's run (`unusableNameRoutedIn` set), where that answer is
 * routed per SRJ-1002 (its routed line), latches nothing and is carried as a
 * failed read below. A `get`
 * answering absent changes nothing. A `get` failing with any other error is carried
 * in the answer (`refusedReads`) for that persona's own caller to handle
 * (`postRunGetRefusal`); for every other caller it is only listed in the
 * line below. Neither ever fails the run, is memoized as a failure or stops
 * the other `get`s. No `get` is made for any other id. `actGoes`, when
 * given (the starter's `postRunGetsGo`), is asked as each `get` settles
 * (`OwnRowReadSite.actGoes`): a `get` that settles once it answers no is
 * not acted on (b.jg5 SRJ-714): no latch, clear or episode end, nothing
 * latched or carried in the answer, and `not acted on (its caller stopped)`
 * in the line below. When at least one
 * listed persona was read or skipped, one line lists every one of them, in
 * `unverified_ids` order, with what its read answered or that it was skipped
 * (persona references only; a refused read carries the redacting
 * describer's text):
 *
 *   [slack] <logPrefix>: after the <run> — one get of each configured persona's own row in unverified_ids: persona=<key> <read|latched|absent|refused (<failure>)|skipped (latched)|not acted on (its caller stopped)>, … (b.jg5 SRJ-120)
 *
 * where `<run>` is `findMissing sweep for <ref>` or `bypassing findMissing
 * sweep for <ref>`. No line is logged when no configured persona is listed.
 * Answers the personas whose read latched (`OwnRowRead.latched`, or the
 * `latched` answer), the personas whose read failed, each with its error,
 * and the personas whose read found the row (its state) or no row, each with
 * what it found (`PostRunReads.readStates`; b.jg5 SRJ-611: a finished read
 * there voids the dead evidence of that persona's caller).
 * Never throws.
 */
async function readListedPersonaRows(
  result: FindMissingResult,
  nextStepGetKey: string | undefined,
  logPrefix: string,
  run: string,
  unusableNameRoutedIn: string | undefined,
  actGoes: (() => boolean) | undefined,
): Promise<PostRunReads> {
  const latchedKeys = new Set<string>()
  const refusedReads = new Map<string, unknown>()
  const readStates = new Map<string, LatchRowState>()
  // The personas whose `get` settled after the starter stopped: not acted on.
  const notActed = new Set<string>()
  const siteFor = (key: string): OwnRowReadSite => {
    const base: OwnRowReadSite =
      unusableNameRoutedIn === undefined
        ? { site: logPrefix, what: 'post-sweep get' }
        : { site: logPrefix, what: 'post-sweep get', unusableNameRoutedIn }
    if (actGoes === undefined) return base
    return {
      ...base,
      actGoes: () => {
        const goes = actGoes()
        if (!goes) notActed.add(key)
        return goes
      },
    }
  }
  // One entry per listed configured persona, in `unverified_ids` order: what
  // its `get` answered, or that it was skipped because it was already latched.
  const entries: string[] = []
  try {
    const listed: { readonly key: string; readonly skipped: boolean }[] = []
    for (const id of result.unverified_ids ?? []) {
      const key = configuredPersonaKeyOfRowId(id)
      if (key === undefined || key === nextStepGetKey || listed.some((l) => l.key === key)) continue
      // An already-latched persona gets no `get` (a latched query that throws counts as latched).
      listed.push({ key, skipped: personaLatchedNow(key) })
    }
    const toRead = listed.filter((l) => !l.skipped).map((l) => l.key)
    const settled = await Promise.allSettled(toRead.map((key) => readPersonaOwnRow(key, siteFor(key))))
    const entryOf = new Map<string, string>()
    settled.forEach((outcome, i) => {
      const key = toRead[i]
      if (outcome.status === 'rejected') {
        // Not reached (`readPersonaOwnRow` never throws); that persona is left out of the line.
        console.error(`[slack] ${logPrefix}: after the ${run} — the post-sweep gets failed: ${describeThrownValue(outcome.reason)} (b.jg5 SRJ-120)`)
        return
      }
      if (notActed.has(key)) {
        // b.jg5 SRJ-714: settled after the starter stopped; neither latched nor carried.
        entryOf.set(key, `${keyRef(key)} not acted on (its caller stopped)`)
        return
      }
      const ownRead = outcome.value
      if (ownRead.kind === OWN_ROW_READ_ROW) {
        if (ownRead.latched) latchedKeys.add(key)
        else readStates.set(key, latchRowStateRead(ownRead.row.state))
        entryOf.set(key, `${keyRef(key)} ${ownRead.latched ? 'latched' : 'read'}`)
      } else if (ownRead.kind === OWN_ROW_READ_LATCHED) {
        // b.jg5 SRJ-512: an UNUSABLE NAME answer latched the persona, so its caller stops.
        latchedKeys.add(key)
        entryOf.set(key, `${keyRef(key)} latched`)
      } else if (ownRead.kind === OWN_ROW_READ_ABSENT) {
        readStates.set(key, LATCH_ROW_STATE_NO_ROW)
        entryOf.set(key, `${keyRef(key)} absent`)
      } else {
        refusedReads.set(key, ownRead.error)
        entryOf.set(key, `${keyRef(key)} refused (${describeAgentDirectorFailure(ownRead.error)})`)
      }
    })
    for (const { key, skipped } of listed) {
      const entry = skipped ? `${keyRef(key)} skipped (latched)` : entryOf.get(key)
      if (entry !== undefined) entries.push(entry)
    }
  } catch (err) {
    // Not reached (nothing above throws); a throw ends the reads with what was read.
    console.error(`[slack] ${logPrefix}: after the ${run} — the post-sweep gets failed: ${describeThrownValue(err)} (b.jg5 SRJ-120)`)
  }
  if (entries.length > 0) {
    console.error(
      `[slack] ${logPrefix}: after the ${run} — one get of each configured persona's own row in unverified_ids: ${entries.join(', ')} (b.jg5 SRJ-120)`,
    )
  }
  return { latchedKeys, refusedReads, readStates }
}

/**
 * The bypassing findMissing run for persona `key` (b.jg5 SRJ-120): a new
 * `findMissing({})` call through `withOutageDetection` for `key`, whatever is
 * memoized or in flight; its result is memoized for later ordinary callers,
 * and ordinary callers arriving while it is in flight join it. After it, each
 * configured persona's own row listed in `unverified_ids` is read with one
 * `get` (`readListedPersonaRows`), except `nextStepGetKey`'s, the row the
 * caller's own next step reads with a `get`, and the row of a persona already
 * latched then, which is skipped with no `get`. Exactly these runs bypass, and
 * this is their one entry:
 *
 * - the live-row sequence's runs (b.jg5 SRJ-705) and an old-life wait's runs
 *   (SRJ-811);
 * - the pending-row rule's runs (SRJ-410);
 * - the run before the single retry that follows a latch re-check whose probe
 *   found the condition cleared, and the run after a latch clears by the
 *   re-check's step 1 or by `clear-latch` (SRJ-506).
 *
 * The live-row sequence's dependency builder binds it for the sequence's runs
 * (`buildLiveRowSequenceDeps`, with the persona's key as the next-step
 * `get`). Every other findMissing caller is an ordinary run.
 *
 * Answers as `reconcileMissingSweep` does: the result, `FIND_MISSING_REFUSED`
 * for a refusal of the run or of the post-run `get` of `key`'s own row (b.jg5
 * SRJ-105, SRJ-114: the caller stops its attempt),
 * `FIND_MISSING_LATCHED` when `key` is latched once the run is done (b.jg5
 * SRJ-502: the caller calls nothing more for it), or undefined for any other
 * failure, which is logged and never memoized and leaves the earlier memoized
 * result in place. A persona already latched before the run gets
 * `FIND_MISSING_LATCHED` too, whatever the run found (a refusal still answers
 * `FIND_MISSING_REFUSED`); a successful run's result is still memoized. Never
 * throws.
 *
 * @param key the persona the run is made for: its outage key and log context.
 * @param logPrefix distinguishes the call site in the log lines.
 * @param nextStepGetKey the persona whose own row the caller reads next with a `get`, if any.
 * @param call how the run's call is made (`FindMissingCallOptions`: an old-life wait's arms nothing for its old key).
 */
export async function bypassingFindMissingSweep(
  key: string,
  logPrefix: string,
  nextStepGetKey?: string,
  call?: FindMissingCallOptions,
): Promise<FindMissingSweepAnswer> {
  try {
    return await reconcileMissingSweep(key, logPrefix, keyRef(key), { kind: FIND_MISSING_RUN_BYPASSING, nextStepGetKey }, call)
  } catch (err) {
    // Not reached (`reconcileMissingSweep` never throws).
    console.error(`[slack] ${logPrefix}: bypassing findMissing sweep failed for ${keyRef(key)}: ${describeThrownValue(err)} — proceeding`)
    return undefined
  }
}

/**
 * The reading of one row in a findMissing result (b.jg5 SRJ-120): agent-director
 * marked it `missing` (it is in `ids`).
 */
export const FIND_MISSING_ROW_MARKED_MISSING = 'marked-missing'
/** The row was judged and left live (it is in `unverified_ids`). */
export const FIND_MISSING_ROW_LEFT_LIVE = 'judged-left-live'
/**
 * The row was not judged: it was `pending` when last read and is in neither
 * list (inside the host's grace period, or its launch's worker process is
 * alive). Retry later; never a reason to escalate, alert or kill.
 */
export const FIND_MISSING_ROW_NOT_JUDGED = 'not-judged'
/** The row was judged alive: it was not `pending` when last read and is in neither list. */
export const FIND_MISSING_ROW_JUDGED_ALIVE = 'judged-alive'

/** What a findMissing result says of one row (`readFindMissingRow`). */
export type FindMissingRowReading =
  | typeof FIND_MISSING_ROW_MARKED_MISSING
  | typeof FIND_MISSING_ROW_LEFT_LIVE
  | typeof FIND_MISSING_ROW_NOT_JUDGED
  | typeof FIND_MISSING_ROW_JUDGED_ALIVE

/**
 * What findMissing result `result` says of row `id`, whose state was
 * `stateBefore` as last read before the run (b.jg5 SRJ-120; HO C2 step 2,
 * C14, C21, C23):
 *
 * - in `ids` → `FIND_MISSING_ROW_MARKED_MISSING`: marked `missing`;
 * - in `unverified_ids` → `FIND_MISSING_ROW_LEFT_LIVE`: judged and left live;
 * - in neither, `stateBefore` `pending` → `FIND_MISSING_ROW_NOT_JUDGED`: the
 *   run did not judge it (the row is inside the host's grace period, or its
 *   launch's worker process is alive);
 * - in neither, any other `stateBefore` → `FIND_MISSING_ROW_JUDGED_ALIVE`.
 *
 * `stateBefore` is required: a caller with no state read for the row has no
 * reading to ask for.
 *
 * "Not judged" means retry later, whatever time has passed, and is never a
 * reason to escalate, alert or kill (b.jg5 SRJ-410, SRJ-717). Pure: no state,
 * no call, no log line; never throws.
 */
export function readFindMissingRow(
  result: Pick<FindMissingResult, 'ids' | 'unverified_ids'>,
  id: string,
  stateBefore: string,
): FindMissingRowReading {
  if ((result.ids ?? []).includes(id)) return FIND_MISSING_ROW_MARKED_MISSING
  if ((result.unverified_ids ?? []).includes(id)) return FIND_MISSING_ROW_LEFT_LIVE
  return stateBefore === AGENT_DIRECTOR_PENDING_STATE ? FIND_MISSING_ROW_NOT_JUDGED : FIND_MISSING_ROW_JUDGED_ALIVE
}

/**
 * b.sv7 / Epic t1.tkk.e4: the escalate-dead → internal-sweep entry point, and
 * the single reusable place for it (do NOT inline the sweep at another call
 * site).
 *
 * When the tick/restart path escalates a persona as dead while its AD row
 * still looks alive (an `EscalateDeadVerdict`: a GONE answer, a refused
 * keystroke, a row found absent at a pane read, or a prompt row's tmux
 * session not found; 'dead-session' → 'escalate-dead'), CSCB
 * recovers itself instead of silently waiting on the external
 * `~/startup/find-missing-loop.sh`: emit an operator-visible log line, then run
 * the memoized, ordinary `reconcileMissingSweep` (b.m4r, b.jg5 SRJ-120). The
 * sweep may reconcile the frozen `working` row to `missing`; when the restart
 * run's second liveness probe (b.d61) then reads `dead`, it relaunches at
 * once, making its checked kill first only after a verdict that is dead
 * evidence and a re-probe of `ErrSystemInstallDisappeared`, which reads no
 * row; a re-probe that read the row voids the verdict, so the relaunch has
 * no kill and carries none (b.jg5 SRJ-611). It may also leave the row live (in
 * `unverified_ids`, or, when `pending`, not judged), and the row may stay
 * live for further ticks: nothing promises that the re-probe or a later tick
 * reads it dead (b.jg5 SRJ-610). A re-probe reading `pending` or `unknown`
 * leaves the relaunch undone (`unknown` arms the retry timer); one that still
 * reads `live` ends the run with no kill, launch or counted failure, and each
 * later escalate-dead tick sweeps again here, with no step beyond the sweep,
 * while the restart path counts those re-probes and posts the slow-recovery
 * notice once after 3 such ticks (SRJ-1010). After a run the sweep makes,
 * each configured persona's own row left in `unverified_ids` is read with one
 * `get`, and only a `provenance_conflict` note there latches; the restart run
 * asks the latch right after the 'escalate-dead' verdict, before its re-probe,
 * so a persona latched that way gets no further agent-director call (b.jg5
 * SRJ-502), and again right before its kill (src/restart.ts). The external
 * loop remains belt-and-braces; removing it is a separate operator decision.
 *
 * The log line is emitted UNCONDITIONALLY here — before/outside the memoized
 * helper — because a memo hit returns silently and a sweep failure logs only
 * the generic failure line; an operator must see that recovery was triggered on
 * every escalate-dead verdict. `reconcileMissingSweep` stays module-private;
 * this wrapper, `sweepDeadTmuxChannelWithCause` and the bypassing entry
 * (`bypassingFindMissingSweep`) are its only exports.
 *
 * Never throws: `reconcileMissingSweep` already logs and swallows its own
 * failures (and does not memoize them, so a later escalate-dead tick's sweep
 * runs again).
 *
 * @param key the dead-tmux persona's key (log context; the sweep itself is
 *   whole-store, so one in-flight sweep serves the fleet — b.nk5).
 * @param verdict why the persona was escalated; the log line names it and
 *   says what it proves (`ESCALATE_DEAD_EVIDENCE`, b.jdc).
 */
export async function sweepDeadTmuxChannel(key: string, verdict: EscalateDeadVerdict): Promise<void> {
  await sweepDeadTmuxChannelWithCause(key, verdict)
}

/**
 * `sweepDeadTmuxChannel`, also saying whether the sweep was refused (b.jg5
 * SRJ-105, `FIND_MISSING_REFUSED`: the run, or the post-run `get` of the
 * persona's own row, SRJ-114). The restart path's reconnect adapter
 * (`src/server.ts`) then answers `transient` instead of `escalate-dead`, so
 * the restart run neither re-probes nor kills nor relaunches the persona. A
 * persona latched once the sweep is done (`FIND_MISSING_LATCHED`) answers as
 * an unrefused sweep: the restart run asks the latch right after the
 * 'escalate-dead' verdict, before its re-probe, and stops there with no
 * further agent-director call (b.jg5 SRJ-502).
 */
export async function sweepDeadTmuxChannelWithCause(key: string, verdict: EscalateDeadVerdict): Promise<{ refused?: true }> {
  console.error(escalateDeadSweepLine(key, verdict))
  return (await reconcileMissingSweep(key, 'escalate-dead')) === FIND_MISSING_REFUSED ? { refused: true } : {}
}

/**
 * The escalate-dead line `sweepDeadTmuxChannelWithCause` logs before each
 * sweep (b.sv7, b.jdc): the persona reference, the verdict and what it
 * observed (`ESCALATE_DEAD_EVIDENCE`). It names no outcome: the row may stay
 * live for further ticks, each escalate-dead tick sweeping again (b.jg5
 * SRJ-610).
 */
export function escalateDeadSweepLine(key: string, verdict: EscalateDeadVerdict): string {
  return `[slack] escalate-dead: ${keyRef(key)} verdict=${verdict} — ${ESCALATE_DEAD_EVIDENCE[verdict]}, triggering internal findMissing reconciliation (the row may stay live for further ticks, each escalate-dead tick sweeping again; ~/startup/find-missing-loop.sh is belt-and-braces)`
}

/**
 * Why the restart path's reconnect adapter escalated a persona as dead, by
 * what the verdict came from:
 * - from a GONE answer (`ErrTmuxSendKeys`, or `ErrTmuxCaptureFailed` at a
 *   pane read: agent-director found no session or pane of the row's launch,
 *   b.jg5 SRJ-104):
 *   - `dead-session`: the reconnect's one `send-keys` answered
 *     `ErrTmuxSendKeys` (cause `tmux-gone`; b.3ce, b.jg5 SRJ-609);
 *   - `working-tmux-gone`: its row reads `working` and the reconnect
 *     adapter's `read-pane` of the row answered GONE (b.d61, b.jg5 SRJ-603);
 *   - `waiting-row-pane-gone`: its row reads `waiting` and the waiting-row
 *     check's `read-pane` answered GONE (b.f2b, b.jg5 SRJ-604);
 *   - `prompt-row-tmux-gone`: its row reads `ask_user` or
 *     `check_permission` and the prompt-row verdict's one-line `read-pane`
 *     answered GONE (b.jdc, b.jg5 SRJ-606);
 * - from a refusal: `row-not-interactive`, agent-director refused the
 *   reconnect's keystrokes as not interactive (`ErrSpawnNotInteractive`,
 *   b.dup): a route into the restart path's decision only, which kills
 *   nothing because of it (b.jg5 SRJ-609);
 * - from a row read: `row-absent-at-pane-read`, the row was absent
 *   (`ErrSpawnNotFound`) at the `read-pane` of the `working`-row verdict,
 *   the waiting-row check or the prompt-row verdict, which takes the GONE
 *   column without being a GONE (b.jg5 SRJ-117), or at the reconnect's
 *   `send-keys` (cause `row-absent`, b.jg5 SRJ-118).
 * Neither a GONE (b.jg5 SRJ-613) nor a refusal as not interactive nor a row
 * read proves the worker's process gone, and every evidence text
 * (`ESCALATE_DEAD_EVIDENCE`) says only what was observed. Each verdict
 * records its origin as one of the labels above, apart from its evidence
 * text. Only the GONE-based verdicts are dead evidence (`isDeadEvidence`,
 * b.jg5 SRJ-611); `row-not-interactive` and `row-absent-at-pane-read` never
 * are, and never by themselves lead to a kill, a delete or a live-row
 * sequence (SRJ-609, SRJ-611).
 */
export type EscalateDeadVerdict = (typeof ESCALATE_DEAD_VERDICTS)[number]

/**
 * Every `EscalateDeadVerdict`, in one runtime list, so a test iterates the
 * values themselves (b.jg5 SRJ-611).
 */
export const ESCALATE_DEAD_VERDICTS = Object.freeze([
  'dead-session',
  'row-not-interactive',
  'working-tmux-gone',
  'waiting-row-pane-gone',
  'row-absent-at-pane-read',
  'prompt-row-tmux-gone',
] as const)

/** The escalate-dead verdict of a `waiting` row whose `read-pane` answered GONE (b.jg5 SRJ-604). */
export const ESCALATE_DEAD_WAITING_ROW_PANE_GONE = 'waiting-row-pane-gone' satisfies EscalateDeadVerdict

/**
 * The escalate-dead verdict of a row found absent (`ErrSpawnNotFound`) at a
 * pane read (b.jg5 SRJ-117) or at the reconnect's `send-keys` (cause
 * `row-absent`, b.jg5 SRJ-118).
 */
export const ESCALATE_DEAD_ROW_ABSENT_AT_PANE_READ = 'row-absent-at-pane-read' satisfies EscalateDeadVerdict

/**
 * What each escalate-dead verdict observed, for its log line
 * (`sweepDeadTmuxChannelWithCause`, b.jdc): exactly one text per verdict.
 * No text says a tmux session or a worker is provably dead: a GONE says that
 * agent-director found no session or pane of the row's launch, an absent row
 * that the row read found none, and `row-not-interactive` that
 * agent-director refused the keystrokes as not interactive, which does not
 * prove the worker gone (a
 * finished row, or a `pending` row whose session may be another launch's,
 * b.jg5 SRJ-609, SRJ-613). The GONE-based verdicts (`dead-session`,
 * `working-tmux-gone`, `waiting-row-pane-gone`, `prompt-row-tmux-gone`) are
 * dead evidence; the refusal (`row-not-interactive`) and the row read
 * (`row-absent-at-pane-read`) never are (b.jg5 SRJ-609, SRJ-611;
 * `isDeadEvidence`).
 */
export const ESCALATE_DEAD_EVIDENCE: Readonly<Record<EscalateDeadVerdict, string>> = Object.freeze({
  'dead-session':
    "agent-director's send-keys answered GONE (ErrTmuxSendKeys) at the /mcp reconnect: no session of the row's launch was found",
  'row-not-interactive':
    "row not interactive (agent-director refused the /mcp reconnect keystrokes as not interactive: the row finished, or a pending row's session may be another launch's; this does not prove the worker gone)",
  'working-tmux-gone':
    "agent-director's read-pane found no pane of the row's launch (GONE) on its working row",
  'waiting-row-pane-gone':
    "agent-director's read-pane found no pane of the row's launch (GONE) on its waiting row",
  'row-absent-at-pane-read':
    "its agent-director row was absent (ErrSpawnNotFound) at the pane read or the /mcp reconnect's send-keys: a row read, not a GONE",
  'prompt-row-tmux-gone':
    "agent-director's read-pane found no pane of the row's launch (GONE) on its ask_user or check_permission row",
})

/**
 * The escalate-dead verdict the restart path's reconnect adapter sweeps with
 * for a `dead-session` reconnect of cause `cause` (b.jg5 SRJ-118, SRJ-609):
 * `tmux-gone` gives `dead-session`, `row-not-interactive` gives
 * `row-not-interactive`, and `row-absent` gives `row-absent-at-pane-read`,
 * never `tmux-gone`'s verdict, so each verdict keeps its cause's dead
 * evidence answer (b.jg5 SRJ-611). Pure.
 */
export function escalateDeadVerdictOfCause(cause: ReconnectDeadSessionCause): EscalateDeadVerdict {
  switch (cause) {
    case DEAD_SESSION_CAUSE_TMUX_GONE:
      return 'dead-session'
    case DEAD_SESSION_CAUSE_ROW_NOT_INTERACTIVE:
      return 'row-not-interactive'
    case DEAD_SESSION_CAUSE_ROW_ABSENT:
      return ESCALATE_DEAD_ROW_ABSENT_AT_PANE_READ
  }
}

// ---------------------------------------------------------------------------
// Dead evidence (b.jg5 SRJ-611)
// ---------------------------------------------------------------------------

/** What a path's dead evidence is decided on: a `dead-session` cause or an escalate-dead verdict. */
export type DeadEvidenceSource = DeadSessionCause | EscalateDeadVerdict

/** `CarriedDeadEvidence.source` when a path carries no cause or verdict. */
export const DEAD_EVIDENCE_NONE = 'none'

/**
 * Whether `source`, a `dead-session` cause or an escalate-dead verdict, is
 * dead evidence for the persona (b.jg5 SRJ-611): true exactly for the
 * GONE-based ones, a `dead-session` caused by `ErrTmuxSendKeys`
 * (`tmux-gone`, and the reconnect adapter's verdict for it, `dead-session`)
 * or by a pane read's `ErrTmuxCaptureFailed` (`working-tmux-gone`,
 * `waiting-row-pane-gone`, `prompt-row-tmux-gone`, and the ladder action's
 * `prompt-row-ladder-gone`). False for the refusal as not interactive
 * (`row-not-interactive`, SRJ-609), for the row reads (`row-absent`,
 * `row-absent-at-pane-read`, `row-read-finished`), for
 * `DEAD_EVIDENCE_NONE` and for any value it does not know (fail safe). The
 * switch is exhaustive: a new cause or verdict fails the typecheck until it
 * is decided here. Decided by value alone. Pure; never throws.
 */
export function isDeadEvidence(source: string | undefined): boolean {
  const value = source as DeadEvidenceSource
  switch (value) {
    case DEAD_SESSION_CAUSE_TMUX_GONE:
    case DEAD_SESSION_CAUSE_PROMPT_ROW_LADDER_GONE:
    case 'dead-session':
    case 'working-tmux-gone':
    case ESCALATE_DEAD_WAITING_ROW_PANE_GONE:
    case 'prompt-row-tmux-gone':
      return true
    case DEAD_SESSION_CAUSE_ROW_NOT_INTERACTIVE:
    case DEAD_SESSION_CAUSE_ROW_ABSENT:
    case DEAD_SESSION_CAUSE_ROW_READ_FINISHED:
    case ESCALATE_DEAD_ROW_ABSENT_AT_PANE_READ:
      return false
    default: {
      // Every known value is decided above, so `value` is `never` here; at
      // run time an unknown value (or none) is not dead evidence.
      const undecided: never = value
      void undecided
      return false
    }
  }
}

/**
 * The dead evidence a recovery path carries (b.jg5 SRJ-611): the cause or
 * verdict that proved its `dead-session` or escalate-dead verdict, or
 * `DEAD_EVIDENCE_NONE`, and whether it is dead evidence. Built only by
 * `carriedDeadEvidenceOf`, so `evidence` is always `isDeadEvidence(source)`:
 * the type carries a type-only brand (`carriedDeadEvidenceBrand`, never
 * present at run time) that only `carriedDeadEvidenceOf` and
 * `CARRIED_DEAD_EVIDENCE_NONE` supply, so an object literal built by hand
 * fails the typecheck. The restart path carries it across its dependencies
 * as an opaque value (`src/restart.ts` imports the type only).
 * Dead evidence covers one life: once the path that holds it reads P's row
 * `ended`, `missing` or gone, or, for a verdict carried in, a reconnect
 * answers `row-not-interactive`, it is void for the rest of that attempt
 * (`voidDeadEvidence` in the collision ladder; the restart path's own kill
 * decision, `killBeforeRelaunch` in `src/restart.ts`).
 */
export interface CarriedDeadEvidence {
  readonly source: DeadEvidenceSource | typeof DEAD_EVIDENCE_NONE
  readonly evidence: boolean
  readonly [carriedDeadEvidenceBrand]: true
}

/**
 * The brand on `CarriedDeadEvidence`: declared only, so it has no run-time
 * value and no module outside this one can name it.
 */
declare const carriedDeadEvidenceBrand: unique symbol

/** A path that carries no cause or verdict: never dead evidence. */
export const CARRIED_DEAD_EVIDENCE_NONE: CarriedDeadEvidence = brandCarriedDeadEvidence(DEAD_EVIDENCE_NONE, false)

/**
 * The frozen value `{ source, evidence }`, typed with the brand (b.jg5
 * SRJ-611). The one place the brand is applied; callers are
 * `carriedDeadEvidenceOf` and `CARRIED_DEAD_EVIDENCE_NONE`.
 */
function brandCarriedDeadEvidence(source: CarriedDeadEvidence['source'], evidence: boolean): CarriedDeadEvidence {
  return Object.freeze({ source, evidence }) as CarriedDeadEvidence
}

/**
 * The carried dead evidence of `source` (b.jg5 SRJ-611):
 * `CARRIED_DEAD_EVIDENCE_NONE` for none (absent or `DEAD_EVIDENCE_NONE`),
 * else the source with `isDeadEvidence`'s answer. Pure.
 */
export function carriedDeadEvidenceOf(source: DeadEvidenceSource | typeof DEAD_EVIDENCE_NONE | undefined): CarriedDeadEvidence {
  if (source === undefined || source === DEAD_EVIDENCE_NONE) return CARRIED_DEAD_EVIDENCE_NONE
  return brandCarriedDeadEvidence(source, isDeadEvidence(source))
}

/**
 * `carried`'s cause or verdict and whether it counts as dead evidence, as
 * the dead-session lines name it (b.jg5 SRJ-611): `cause=<source>: dead
 * evidence (GONE-based)`, `cause=<source>: not dead evidence`, or `no cause
 * carried: not dead evidence`. Decided again from the source
 * (`isDeadEvidence`), so a value cast past the brand says what it is. Pure.
 */
export function describeDeadEvidence(carried: CarriedDeadEvidence): string {
  if (carried.source === DEAD_EVIDENCE_NONE) return 'no cause carried: not dead evidence'
  return isDeadEvidence(carried.source)
    ? `cause=${carried.source}: dead evidence (GONE-based)`
    : `cause=${carried.source}: not dead evidence`
}

/**
 * The collision ladder's one line for a dead-session route (b.jg5 SRJ-611):
 * persona `ref`'s row, read `state`, goes to resume/fresh-spawn
 * (`resumeOrFreshSpawn`); `own` is the route's own cause and `carriedIn` the
 * escalate-dead verdict the restart path carried into the launch
 * (`CARRIED_DEAD_EVIDENCE_NONE` when none), and the line says whether the
 * path holds dead evidence (either does), unless `voidedBy` names the read
 * or the answer that voids it (dead evidence covers one life): then the path
 * holds none, as `resumeOrFreshSpawn` takes it (`voidDeadEvidence`).
 */
export function deadSessionRouteLine(
  ref: string,
  state: string,
  own: CarriedDeadEvidence,
  carriedIn: CarriedDeadEvidence,
  voidedBy?: string,
): string {
  const carried = carriedIn.source === DEAD_EVIDENCE_NONE ? '' : `; the restart path carried in ${describeDeadEvidence(carriedIn)}`
  const anyEvidence = isDeadEvidence(own.source) || isDeadEvidence(carriedIn.source)
  const holds = !anyEvidence
    ? 'holds no dead evidence'
    : voidedBy === undefined
      ? 'holds dead evidence'
      : `holds no dead evidence: ${voidedBy}, which voids it`
  return `[slack] spawnForPersona: dead session for ${ref} (state=${state}) — ${describeDeadEvidence(own)}${carried}; the path ${holds}; recovering via resume/fresh-spawn (b.jg5 SRJ-611)`
}

/**
 * The line logged once for each piece of dead evidence a recovery path voids
 * (b.jg5 SRJ-611, SRJ-1014; dead evidence covers one life): persona `ref`'s
 * cause or verdict `voided` is void for the rest of the attempt because of
 * `voidedBy`, the read (`deadEvidenceVoidingRead`) or the answer
 * (`DEAD_EVIDENCE_VOIDED_BY_RESUME_NOT_FOUND`,
 * `DEAD_EVIDENCE_VOIDED_BY_ROW_NOT_INTERACTIVE`,
 * `DEAD_EVIDENCE_VOIDED_BY_REUSE_COLLISION_RERUN`,
 * `DEAD_EVIDENCE_VOIDED_BY_RETIRED_KEY_FIRST_LAUNCH`) that voided it:
 *   `[slack] spawnForPersona: <ref>'s dead evidence (<describeDeadEvidence>) is void for the rest of this attempt — <voidedBy>; a later live reading of the row is a launch that evidence never saw, handled as on a path with no dead evidence (b.jg5 SRJ-611)`
 */
export function deadEvidenceVoidedLine(ref: string, voided: CarriedDeadEvidence, voidedBy: string): string {
  return `[slack] spawnForPersona: ${ref}'s dead evidence (${describeDeadEvidence(voided)}) is void for the rest of this attempt — ${voidedBy}; a later live reading of the row is a launch that evidence never saw, handled as on a path with no dead evidence (b.jg5 SRJ-611)`
}

/**
 * The words naming a read of persona P's row that voids the path's dead
 * evidence (b.jg5 SRJ-611): `<by> read the row <state>`, or `<by> found no
 * row (ErrSpawnNotFound)`. `by` names the read (`DEAD_EVIDENCE_READ_BY_*`,
 * `deadEvidenceReadByCause`); `read` is what it found. Pure.
 */
export function deadEvidenceVoidingRead(by: string, read: LatchRowState): string {
  return read.kind === LATCH_ROW_STATE_KIND_NO_ROW
    ? `${by} found no row (ErrSpawnNotFound)`
    : `${by} read the row ${describeLatchRowState(read)}`
}

/** The read that gave `resumeOrFreshSpawn` its finished state last read, when its caller names none. */
export const DEAD_EVIDENCE_READ_BY_PATH = "the path's last read"
/** The collision ladder's collision `get` (b.jg5 SRJ-114). */
export const DEAD_EVIDENCE_READ_BY_COLLISION_GET = 'the collision get'
/** b.jdc's ladder action's re-read after its find-missing run (`launchOnPromptRow`, b.jg5 SRJ-607). */
export const DEAD_EVIDENCE_READ_BY_PROMPT_ROW_REREAD = "the prompt-row ladder action's re-read after its find-missing run"
/** The `get` SRJ-120 makes of P's own row after the path's own find-missing run, before its `resume`. */
export const DEAD_EVIDENCE_READ_BY_POST_SWEEP_GET = "the get of its own row after the path's find-missing run"

/**
 * The read behind a dead-session route whose cause is a row read (b.jg5
 * SRJ-605, SRJ-118): `row-absent` (the reconnect's `send-keys` or the
 * working-row wait found no row) or `row-read-finished` (the working-row
 * wait read the row finished). Pure.
 */
export function deadEvidenceReadByCause(cause: DeadSessionCause): string {
  return `the read behind its dead-session cause (cause=${cause})`
}

/**
 * The one re-run of get-then-act a reuse collision gives (b.jg5 SRJ-112)
 * carries no dead evidence (SRJ-611): the reuse was made on a row the path
 * took as finished, and the re-run's collision `get` reads whatever life
 * holds the row now.
 */
export const DEAD_EVIDENCE_VOIDED_BY_REUSE_COLLISION_RERUN =
  'the reuse spawn collided, and the re-run of get-then-act it gives carries no dead evidence'

/**
 * A retired key's first launch (b.jg5 SRJ-805) is a reuse spawn that starts
 * a new life, so the get-then-act its collision enters carries no dead
 * evidence (SRJ-611): a live row there is judged afresh.
 */
export const DEAD_EVIDENCE_VOIDED_BY_RETIRED_KEY_FIRST_LAUNCH =
  "the retired key's first launch is a reuse spawn that starts a new life, which the evidence never saw, so the get-then-act its collision enters carries no dead evidence"

/** `resume` answered `ErrSpawnNotFound` (b.jg5 SRJ-113): the row is gone, a voiding read (SRJ-611). */
export const DEAD_EVIDENCE_VOIDED_BY_RESUME_NOT_FOUND = 'resume answered ErrSpawnNotFound: the row is gone'

/**
 * A reconnect's `send-keys` answered `ErrSpawnNotInteractive`
 * (`row-not-interactive`, b.jg5 SRJ-118, SRJ-609), which voids a verdict the
 * path carries in (SRJ-611; HO §2 mapping row 20).
 */
export const DEAD_EVIDENCE_VOIDED_BY_ROW_NOT_INTERACTIVE =
  "the reconnect's send-keys answered ErrSpawnNotInteractive (row-not-interactive): the row is finished, or pending under a launch the verdict never saw"

// ---------------------------------------------------------------------------
// Rows waiting on a prompt whose session may be gone (b.jdc)
// ---------------------------------------------------------------------------

/**
 * b.jdc: how long the restart path holds back from a persona whose row reads
 * `ask_user` or `check_permission` while its one-line `read-pane` answers a
 * pane or is taken as alive (UNAVAILABLE, CONFIG or UNCLASSIFIED, b.jg5
 * SRJ-606, SRJ-117), before each further deferral first runs the memoized
 * findMissing sweep and reads the row again (`checkPromptRowDeferral`). A
 * session that dies under a prompt keeps its row in that state:
 * agent-director only refreshes a row at SessionEnd and leaves reaping to its
 * sweep. A read that finds no pane of the row's launch (GONE) escalates at
 * once; this bounds what the read cannot tell: a pane does not show whether
 * a claude process still runs in it, and a read that could not answer is no
 * proof either way. Measured from the first deferral of the
 * run, on the session manager's clock (`_now`).
 */
export const PROMPT_ROW_SWEEP_AFTER_MS = 10 * 60 * 1000

/**
 * When each persona's current run of deferrals on its `ask_user` or
 * `check_permission` row began (b.jdc, on the session manager's clock
 * `_now`): the first time the restart path held back from the row on a pane
 * or a read taken as alive (`checkPromptRowDeferral`). It ends
 * (`endPromptRowDeferral`) when the row reads another state, when its
 * `read-pane` finds no pane of the row's launch (GONE) or finds no row, when
 * the row is escalated, when any launch for the persona starts, and with the
 * persona's not-connected episode (`forgetNotConnectedEpisode`). A failed
 * status call, a latched persona and a read answering ENVIRONMENT neither
 * extend nor end it.
 */
const promptRowDeferredSince = new Map<string, number>()

/**
 * Start persona `key`'s run in `runs` at its first deferral, and return how
 * long the run has lasted (ms, on `_now`). Shared by the `working`-row and
 * prompt-row deferral runs.
 */
function noteDeferralRun(runs: Map<string, number>, key: string): number {
  const now = _now()
  let since = runs.get(key)
  if (since === undefined) {
    since = now
    runs.set(key, since)
  }
  return now - since
}

/**
 * b.jdc: end persona `key`'s run of deferrals on its prompt row, so a later
 * deferral starts a new one. Silent; other personas are untouched.
 */
export function endPromptRowDeferral(key: string): void {
  promptRowDeferredSince.delete(key)
}

/** A finished row state: agent-director ended the row or marked it missing (a row read, never dead evidence; b.jg5 SRJ-611). */
function isDeadRowState(state: string | undefined): state is 'ended' | 'missing' {
  return state === 'ended' || state === 'missing'
}

/**
 * b.jdc: run the memoized findMissing sweep (b.m4r), then read persona
 * `key`'s row state again. Returns that state, or undefined when the read
 * failed (logged with `logPrefix` and `ref`). A failed sweep logs its own
 * line, and the row is read anyway, except a refused one (b.jg5 SRJ-105; the
 * run refused, or the post-run `get` of the persona's own row, SRJ-114):
 * then nothing is read and `FIND_MISSING_REFUSED` is returned. When the
 * persona is latched once the sweep is done (`FIND_MISSING_LATCHED`: a
 * post-run `get` of its row latched it, b.jg5 SRJ-114, SRJ-513, or the latch answers it
 * latched, b.jg5 SRJ-120, SRJ-502), nothing is read, one line is logged and
 * `FIND_MISSING_LATCHED` is returned:
 *
 *   [slack] <logPrefix>: <ref> is latched after the findMissing sweep — its row is not read; nothing more is called for it (b.jg5 SRJ-502)
 *
 * The row is read through the shared own-row `status` read
 * (`readPersonaOwnRowStatus`, b.jg5 SRJ-115): a read that latched the
 * persona (an UNUSABLE NAME answer, b.jg5 SRJ-512, or its own row reading
 * `pending` with no launch start, b.jg5 SRJ-513, logged there) answers
 * `FIND_MISSING_LATCHED` too, and its caller makes no further call and never
 * escalates. So does a persona latched elsewhere while that read was awaited
 * (`latchedAfterOwnRowRead`, b.jg5 SRJ-502), whatever the read gave, with
 * one line:
 *
 *   [slack] <logPrefix>: <ref> is latched after its status read after the findMissing sweep — nothing more is called for it (b.jg5 SRJ-502)
 *
 * Never throws.
 */
async function reconcileAndReadRowState(
  key: string,
  logPrefix: string,
  ref: string,
): Promise<string | typeof FIND_MISSING_REFUSED | typeof FIND_MISSING_LATCHED | undefined> {
  const sweep = await reconcileMissingSweep(key, logPrefix, ref)
  if (sweep === FIND_MISSING_REFUSED) return FIND_MISSING_REFUSED
  if (sweep === FIND_MISSING_LATCHED) {
    console.error(
      `[slack] ${logPrefix}: ${ref} is latched after the findMissing sweep — its row is not read; nothing more is called for it (b.jg5 SRJ-502)`,
    )
    return FIND_MISSING_LATCHED
  }
  // b.jg5 SRJ-115: P's own row through the shared own-row `status` read.
  const what = 'status read after the findMissing sweep'
  const read = await readPersonaOwnRowStatus(key, { site: logPrefix, what, ref })
  // b.jg5 SRJ-512, SRJ-513, SRJ-502: the read latched P (logged there): no further call.
  if (read.kind === OWN_ROW_STATUS_LATCHED) return FIND_MISSING_LATCHED
  // b.jg5 SRJ-502: P latched elsewhere while the read was awaited: no resume,
  // escalation or notice follows, whatever the read gave.
  if (latchedAfterOwnRowRead(key, logPrefix, what, ref)) return FIND_MISSING_LATCHED
  switch (read.kind) {
    case OWN_ROW_STATUS_STATE:
      return read.state
    case OWN_ROW_STATUS_ABSENT:
      console.error(`[slack] ${logPrefix}: reading the row of ${ref} after the findMissing sweep failed: ${ERR_SPAWN_NOT_FOUND_NAME}`)
      return undefined
    case OWN_ROW_STATUS_REFUSED:
      console.error(`[slack] ${logPrefix}: reading the row of ${ref} after the findMissing sweep failed: ${describeAgentDirectorFailure(read.error)}`)
      return undefined
  }
}

/**
 * The UNAVAILABLE retry timer's row read (b.jg5 SRJ-303, SRJ-115): one read
 * of persona `key`'s row (`cscb_<key>`) through the shared own-row `status`
 * read (`readPersonaOwnRowStatus`), with no findMissing sweep before it and
 * no other call. Answers the row's `state` as agent-director reports it
 * (`pending`, `waiting`, `ended`, `missing` …), or
 * `UNAVAILABLE_RETRY_ROW_ABSENT` when there is no row (`ErrSpawnNotFound`,
 * recognised by name). On a `pending` row it also answers the launch start
 * the result shows (`launchStartedAt`, raw, `pendingLaunchStartOf`; absent
 * when not shown, and never answered for another state). A read that
 * latched the persona answers the state as the latch recorded it: an
 * UNUSABLE NAME answer (b.jg5 SRJ-512) as `unreadable`, which counts as
 * live, and its own row reading `pending` with no launch start (b.jg5
 * SRJ-513) as `pending`, so a configured persona's own such row never
 * reaches the pending-only retry as a row still to wait on (it latched
 * first; a row under an unconfigured key latches nothing and still does).
 * The latch's hold has stopped the persona's timer, and the retry
 * action asks the latched query right after this read and stops with the
 * latch's stop reason, handing nothing to the restart path. Every other
 * error is thrown to the caller; inside a recovery attempt for the persona
 * the wrapper has already reported it, so a `status` error arms the
 * persona's retry timer (SRJ-301). Logs nothing of its own.
 */
export async function readPersonaRowState(key: string): Promise<UnavailableRetryRowRead> {
  // b.jg5 SRJ-115: P's own row through the shared own-row `status` read.
  const read = await readPersonaOwnRowStatus(key, RETRY_ROW_READ_SITE)
  switch (read.kind) {
    case OWN_ROW_STATUS_STATE:
      return read.launchStartedAt === undefined ? { state: read.state } : { state: read.state, launchStartedAt: read.launchStartedAt }
    case OWN_ROW_STATUS_ABSENT:
      return { state: UNAVAILABLE_RETRY_ROW_ABSENT }
    case OWN_ROW_STATUS_LATCHED:
      // b.jg5 SRJ-305, SRJ-512, SRJ-513: the read latched P; the latch's hold
      // has stopped the timer, and the retry asks the latch next and stops.
      return { state: describeLatchRowState(read.rowState) }
    case OWN_ROW_STATUS_REFUSED:
      throw read.error
  }
}

/**
 * b.jdc — the restart path's check of a persona whose row reads `state`
 * (`ask_user` or `check_permission`) and whose one-line `read-pane` answered
 * a pane or was taken as alive (UNAVAILABLE, CONFIG or UNCLASSIFIED; the
 * reconnect adapter's `promptRowReconnectVerdict` in `server.ts`, which
 * types nothing into such a row; b.jg5 SRJ-606). Notes one more deferral
 * in the persona's run on the row (`promptRowDeferredSince`). Once the run
 * has lasted
 * `PROMPT_ROW_SWEEP_AFTER_MS`, it runs the memoized findMissing sweep and
 * reads the row again: on `ended` or `missing` it logs what was read
 * (`promptRowSweepFinishedLine`), ends the run and returns `escalate`, and
 * the adapter answers escalate-dead with the cause `row-read-finished`, a
 * row read and not dead evidence (b.jg5 SRJ-609, SRJ-611): the restart
 * path's re-probe decides, and no kill follows from it. A refused sweep
 * (b.jg5 SRJ-105) returns `refused`: the row is not read, and the adapter
 * answers `transient`, so the restart run kills and launches nothing and
 * raises no notice. A persona latched once the sweep is done (b.jg5 SRJ-120,
 * SRJ-502: `reconcileAndReadRowState` answers `FIND_MISSING_LATCHED`) gets no
 * row read and is never escalated: `latched`, and the adapter answers
 * `transient` with no notice, since the persona is held (b.jg5 SRJ-502) and
 * its latch's own notice already tells the human (SRJ-508). Otherwise
 * `defer`: the adapter defers the row and raises its notice, as before.
 * Never throws.
 */
export async function checkPromptRowDeferral(key: string, state: string): Promise<'escalate' | 'defer' | 'refused' | 'latched'> {
  const heldMs = noteDeferralRun(promptRowDeferredSince, key)
  if (heldMs < PROMPT_ROW_SWEEP_AFTER_MS) return 'defer'
  const ref = keyRef(key)
  const after = await reconcileAndReadRowState(key, 'reconnectSession: prompt row', ref)
  if (after === FIND_MISSING_REFUSED) return 'refused'
  // b.jg5 SRJ-502: a persona latched after the sweep is never escalated, and
  // gets no not-connected notice.
  if (after === FIND_MISSING_LATCHED) return 'latched'
  if (!isDeadRowState(after)) return 'defer'
  endPromptRowDeferral(key)
  console.error(promptRowSweepFinishedLine(ref, state, heldMs, after))
  return 'escalate'
}

/**
 * `checkPromptRowDeferral`'s line when persona `ref`'s row, read `state` for
 * `heldMs` of deferrals, reads `after` (`ended` or `missing`) after the
 * findMissing sweep (b.jdc): it says what was read, a row read and not dead
 * evidence (cause `row-read-finished`, b.jg5 SRJ-609, SRJ-611), and that the
 * restart path's re-probe decides. Exported for tests.
 *
 * @internal
 */
export function promptRowSweepFinishedLine(ref: string, state: string, heldMs: number, after: string): string {
  return `[slack] reconnectSession: ${ref} has read ${state} for ${describeWaitSpan(heldMs)} of deferrals, and after a findMissing sweep its row reads ${after} — not deferring; escalating (escalate-dead), the restart path's re-probe decides (${describeDeadEvidence(carriedDeadEvidenceOf(DEAD_SESSION_CAUSE_ROW_READ_FINISHED))}; b.jdc, b.jg5 SRJ-611)`
}

/**
 * b.jdc, b.jg5 SRJ-607 — the collision ladder's action for persona
 * `persona`'s row read `state` (`ask_user` or `check_permission`), b.jg5
 * SRJ-117's "b.jdc ladder action" column. Nothing is ever typed into such a
 * row (b.rmy). Its session may be gone, though: a session that dies under a
 * prompt keeps its row in that state until a findMissing sweep reaps it. So
 * the ladder makes one `read-pane` of the persona's own row through the
 * shared reader (`readPersonaOwnPane`: `PROBE_PANE_READ_LINES`, the
 * collision `get`'s state as the recorded state), with no tmux call, mapped:
 * - a pane → no action (`no-op`), as before; the health check's restart path
 *   reports the prompt if the persona stays disconnected. The pane may be a
 *   single leftover's (b.jg5 SRJ-117, SRJ-613), so it is no proof that the
 *   worker's own session is there, and nothing is typed on it. The backstop
 *   is the later reconnect's `send-keys` (`reconnectMcpWithCause`), made
 *   only once the row reads `waiting`, or shows a `working` row stale: on a
 *   live row that is not `pending` it answers CONFLICT "not this launch's
 *   session" when a leftover holds the persona's session, and then nothing
 *   is typed, P latches (b.jg5 SRJ-501) with its CONFLICT notice posted
 *   once, and the refused `send-keys` is never retried (SRJ-118);
 * - GONE (`ErrTmuxCaptureFailed`: agent-director found no pane of the row's
 *   launch), or the row absent (`ErrSpawnNotFound`, which takes the GONE
 *   column, b.jg5 SRJ-117) → the memoized findMissing sweep, then the row is
 *   read again: `ended` or `missing` is recovered through
 *   `resumeOrFreshSpawn`, with that re-read as the state last read (a
 *   finished row, so any replacement there is a reuse spawn of the same id,
 *   b.jg5 SRJ-707), whose resume or spawn decides what holds the
 *   persona's name; for a retired key it is a reuse spawn and never a
 *   `resume` (b.jg5 SRJ-805, SRJ-607), whose success answers `fresh-retired`
 *   and sets the mark (SRJ-806). The route's line (`deadSessionRouteLine`) names its
 *   cause: after a GONE `prompt-row-ladder-gone`, dead evidence; after an
 *   absent row `row-absent`, a row read and not dead evidence (b.jg5
 *   SRJ-611). Dead evidence covers one life: the re-read found the row
 *   finished, so the GONE and any verdict the restart path carried in are
 *   void for the rest of the attempt (`resumeOrFreshSpawn` takes the path as
 *   holding none, one line per voided piece), and a live row a later read
 *   finds is a launch that evidence never saw (b.jg5 SRJ-607, SRJ-611).
 *   Anything else (or a failed read) is left as it is
 *   (`no-op`), for the restart path to retry. A refused sweep (b.jg5
 *   SRJ-105) reads nothing and answers `failed`: no resume or launch. A
 *   persona latched before the sweep (b.jg5 SRJ-502, `personaLatchedNow`),
 *   or once it is done (b.jg5 SRJ-120: `FIND_MISSING_LATCHED`, the re-read
 *   included), answers `latched`: no further call, no resume, kill, delete
 *   or launch;
 * - UNAVAILABLE (timeouts included), CONFIG (the wrapper raised the
 *   `ad-config-malformed` outage, b.jg5 SRJ-316) or UNCLASSIFIED (b.jg5
 *   SRJ-105) → taken as alive: `no-op`, with one line naming the class;
 * - ENVIRONMENT (the wrapper raised the `tmux-unavailable` outage, b.jg5
 *   SRJ-311) → `no-op`, with one line naming the class;
 * - an UNCLASSIFIED carrying the stop mark (`stopping`: the reader's
 *   `ErrInvalidFlags` re-check decided that the server stops, b.jg5
 *   SRJ-205) → a `failed` result marked `stopping`, as at the working-row
 *   wait: no post, no `spawn-failed` entry, nothing counted;
 * - CONFLICT or UNUSABLE NAME (the reader latched the persona with the
 *   collision `get`'s state and logged its line, b.jg5 SRJ-501, SRJ-512), or
 *   a persona already latched, which the reader does not read → `latched`,
 *   nothing typed.
 * Each log line but the pane's `no-op` comes from an exported builder
 * (`promptRowLadderNoPaneLine`, `promptRowLadderAfterSweepLine`,
 * `promptRowLadderNoActionLine`, `promptRowLadderStoppingLine`,
 * `promptRowLadderLatchedLine`, `deadSessionRouteLine`).
 */
async function launchOnPromptRow(
  run: LadderRun,
  row: Pick<GetResult, 'cwd' | 'labels'>,
  state: string,
): Promise<SpawnPersonaResult> {
  const { persona, config, ref } = run
  const { key } = persona
  const read = await readPersonaOwnPane(key, {
    nLines: PROBE_PANE_READ_LINES,
    // b.jg5 SRJ-501: the collision `get` is the path's last read.
    lastRead: latchRowStateRead(state),
    site: PROMPT_ROW_LADDER_PANE_READ_SITE,
  })
  switch (read.kind) {
    case PANE_READ_PANE:
      console.error(`[slack] spawnForPersona: no action — state=${state} for ${ref}`)
      return { key, action: 'no-op' }
    case PANE_READ_LATCHED:
      console.error(promptRowLadderLatchedLine(ref, state))
      return { key, action: 'latched' }
    case PANE_READ_UNCLASSIFIED:
      if (read.stopping === true) {
        console.error(promptRowLadderStoppingLine(ref, state, read))
        return { key, action: 'failed', stopping: true }
      }
      console.error(promptRowLadderNoActionLine(ref, state, read))
      return { key, action: 'no-op' }
    case PANE_READ_UNAVAILABLE:
    case PANE_READ_CONFIG:
    case PANE_READ_ENVIRONMENT:
      console.error(promptRowLadderNoActionLine(ref, state, read))
      return { key, action: 'no-op' }
    case PANE_READ_GONE:
    case PANE_READ_ABSENT:
      break
  }
  console.error(promptRowLadderNoPaneLine(ref, state, read))
  // b.jg5 SRJ-502: latched elsewhere while the read was awaited → no sweep.
  if (personaLatchedNow(key)) {
    console.error(promptRowLadderLatchedLine(ref, state))
    return { key, action: 'latched' }
  }
  const after = await reconcileAndReadRowState(key, 'spawnForPersona: prompt row', ref)
  if (after === FIND_MISSING_REFUSED) return { key, action: 'failed' }
  // b.jg5 SRJ-502: a persona latched after the sweep gets no further call.
  if (after === FIND_MISSING_LATCHED) return { key, action: 'latched' }
  if (isDeadRowState(after)) {
    // b.jg5 SRJ-607, SRJ-611: a GONE read is dead evidence
    // (`prompt-row-ladder-gone`); an absent row is a row read (`row-absent`)
    // and is not.
    const own = carriedDeadEvidenceOf(read.kind === PANE_READ_GONE ? DEAD_SESSION_CAUSE_PROMPT_ROW_LADDER_GONE : DEAD_SESSION_CAUSE_ROW_ABSENT)
    // b.jg5 SRJ-501: the re-read after the sweep is the path's last read.
    const lastRead = latchRowStateRead(after)
    // b.jg5 SRJ-611: that re-read found the row finished, which voids the
    // path's dead evidence, its own GONE and any carried verdict alike
    // (`resumeOrFreshSpawn`'s gate); the route's line says so.
    console.error(deadSessionRouteLine(ref, state, own, run.carriedDeadEvidence, deadEvidenceVoidingRead(DEAD_EVIDENCE_READ_BY_PROMPT_ROW_REREAD, lastRead)))
    return resumeOrFreshSpawn(run, row, {
      lastRead,
      lastReadBy: DEAD_EVIDENCE_READ_BY_PROMPT_ROW_REREAD,
      deadEvidence: heldDeadEvidence(own, run.carriedDeadEvidence),
    })
  }
  const next = config.session_restart_delay === 0
    ? 'session_restart_delay is 0, so nothing retries it before the next server start'
    : "the health check's restart retries it"
  console.error(promptRowLadderAfterSweepLine(ref, read, after, next))
  return { key, action: 'no-op' }
}

/** The site label of the ladder's prompt-row read, the head of the shared reader's latch line. */
const PROMPT_ROW_LADDER_PANE_READ_SITE = 'spawnForPersona: prompt row'

/**
 * `launchOnPromptRow`'s line when persona `ref`'s row reads `state` and its
 * one-line `read-pane` answered GONE or found the row absent (b.jdc, b.jg5
 * SRJ-607, SRJ-117); `read` is that failure. Exported for tests.
 *
 * @internal
 */
export function promptRowLadderNoPaneLine(ref: string, state: string, read: PaneReadFailure): string {
  return `[slack] spawnForPersona: ${ref} reads ${state} but ${promptRowLadderNoPaneFinding(read)}: ${read.description} — reconciling its row before deciding (${paneReadClassNote(read)}; b.jdc, b.jg5 SRJ-607)`
}

/**
 * What the prompt-row ladder's pane read found, shared by
 * `promptRowLadderNoPaneLine` and `promptRowLadderAfterSweepLine` so the two
 * cannot drift: an absent row (`ErrSpawnNotFound`) is a row read, not a GONE
 * (b.jg5 SRJ-117), and its line says so.
 */
function promptRowLadderNoPaneFinding(read: Pick<PaneReadFailure, 'kind'>): string {
  return read.kind === PANE_READ_ABSENT
    ? 'its agent-director row was absent at the pane read'
    : "agent-director's read-pane found no pane of its launch"
}

/**
 * `launchOnPromptRow`'s line when, after a GONE or absent read (`read`) and
 * the findMissing sweep, persona `ref`'s row could not be read (`after`
 * undefined) or still reads `after`, a state that is not `ended` or
 * `missing`: no action; `next` says what retries it (b.jdc, b.jg5 SRJ-607,
 * SRJ-117). Exported for tests.
 *
 * @internal
 */
export function promptRowLadderAfterSweepLine(
  ref: string,
  read: Pick<PaneReadFailure, 'kind'>,
  after: string | undefined,
  next: string,
): string {
  return `[slack] spawnForPersona: ${ref}: ${promptRowLadderNoPaneFinding(read)}, but its row ${after === undefined ? 'could not be read' : `still reads ${after}`} after the findMissing sweep — no action; ${next} (b.jdc, b.jg5 SRJ-607)`
}

/**
 * `launchOnPromptRow`'s line when persona `ref`'s row reads `state` and its
 * one-line `read-pane` answered UNAVAILABLE, CONFIG or UNCLASSIFIED (taken
 * as alive) or ENVIRONMENT (tmux is not available): no action (b.jdc, b.jg5
 * SRJ-607, SRJ-117, SRJ-105, SRJ-311); `read` is that failure. Exported for
 * tests.
 *
 * @internal
 */
export function promptRowLadderNoActionLine(ref: string, state: string, read: PaneReadFailure): string {
  const why = read.kind === PANE_READ_ENVIRONMENT
    ? 'tmux is not available'
    : 'taken as alive (no proof the session is gone)'
  return `[slack] spawnForPersona: ${ref} reads ${state} and reading its pane failed: ${read.description} — ${why}; no action (${paneReadClassNote(read)}; b.jdc, b.jg5 SRJ-607, SRJ-117)`
}

/**
 * `launchOnPromptRow`'s line when persona `ref`'s row reads `state` and its
 * `read-pane` carried the stop mark of a version re-check that decided that
 * the server stops (b.jg5 SRJ-204, SRJ-205); `read` is that failure.
 * Exported for tests.
 *
 * @internal
 */
export function promptRowLadderStoppingLine(ref: string, state: string, read: PaneReadFailure): string {
  return `[slack] spawnForPersona: ${ref} reads ${state} and reading its pane failed: ${read.description} — the agent-director version re-check decided that the server stops; nothing more is called for it (${paneReadClassNote(read)}; b.jg5 SRJ-204, SRJ-205)`
}

/**
 * `launchOnPromptRow`'s line when persona `ref`'s row reads `state` and the
 * persona is latched: the shared reader's CONFLICT or UNUSABLE NAME answer
 * latched it (the reader logged that line), it was already latched and was
 * not read, or it latched elsewhere while the read was awaited (b.jg5
 * SRJ-501, SRJ-502, SRJ-512). Exported for tests.
 *
 * @internal
 */
export function promptRowLadderLatchedLine(ref: string, state: string): string {
  return `[slack] spawnForPersona: ${ref} reads ${state} and is latched — no action; nothing typed and nothing more is called for it (b.jg5 SRJ-502)`
}

/**
 * Poll `status({claude_instance_id})` until the spawn transitions to
 * `waiting`, then call reconnectMcp. Transitions to live transient states
 * (ask_user, check_permission, pending) return 'not-reconnected' (b.f2b;
 * 'ok' before); recovery is then the health-check tick's job — post-b.9a7 the
 * tick observes the row as alive && !connected and routes it through
 * scheduleRestart -> reconnect. 'ok' now always means `/mcp reconnect` was
 * typed.
 *
 * b.f2b — a stale `working` row. agent-director can leave a row `working`
 * after the turn ended, so while the row reads `working` the wait also reads
 * its evidence, every `WORKING_ROW_READ_INTERVAL_MS` (`staleWorkingRowIsIdle`):
 * the persona's pane and, when that shows an idle screen, the session's
 * transcript. The row is stale only on the positive-idle rule
 * (`foldWorkingPaneRun`): for the whole `STALE_WORKING_WINDOW_MS`, every read
 * showed the same idle screen (no spinner, busy hint, API retry row, prompt
 * or dialog) AND the same transcript, unchanged, ending with a completed turn.
 * Then it reconnects, as the `waiting` branch does. A live turn never ends its
 * transcript with a completed turn, an API retry or stall included (which can
 * hide the spinner and hold the screen still), so it is never taken for idle
 * and never typed into (the b.rmy invariant). A transcript that can't be
 * located or read is no evidence. A pane that shows a prompt or dialog for
 * the window is never typed into either: the wait goes on, and the prompt is
 * logged and reported through the not-connected notice, once. The reconnect
 * is part of the launch, not an auto-restart, so it runs whatever
 * `session_restart_delay` is, like the `waiting` branch's. Each poll that
 * reads the row `working` and doesn't reconnect it is one more deferral in
 * the persona's run on the row (`noteWorkingRowDeferral`), and so is the
 * timeout on a `working` row: once the run has lasted
 * `UNPROVEN_IDLE_NOTICE_AFTER_MS`, the `unproven-idle` notice is raised, at
 * any restart delay (once per episode). Any other state ends the run.
 *
 * b.f2b — every wait that ends without reconnecting a live session (a live
 * transient state at the poll; at the timeout, a live row or a failed
 * `status` read) returns 'not-reconnected' and says what happens next for
 * the restart delay in effect: with `session_restart_delay` 0 nothing will
 * reconnect the persona, so the not-connected notice is raised (once per
 * episode) instead of claiming the health check will
 * (`reportWaitEndedDisconnected`, its line and notice built by
 * `waitEndedOnStateReport`, `waitTimedOutLiveReport` and
 * `waitTimedOutUnreadReport`): the `blocked-on-prompt` notice when the row
 * ended at `ask_user` or `check_permission`, `unproven-idle` when the timeout
 * finds it `working`, the `auto-restart-disabled` one otherwise.
 *
 * b.f2b — a teardown cancels the wait (`cancelWorkingRowWait`). The wait
 * checks after each agent-director call and wakes from its poll sleep at
 * once, types nothing once cancelled, and returns 'cancelled'.
 *
 * b.jg5 SRJ-502 — the wait asks whether its persona is latched at the same
 * points, after each agent-director call it makes (its `find-missing` runs,
 * `status` polls, pane reads and transcript `get`s): a latch its transcript
 * `get` set (a `provenance_conflict` note, b.jg5 SRJ-114), one a `find-missing`
 * run's post-run `get` set (b.jg5 SRJ-120), or one set elsewhere ends it
 * with 'latched', one line, no further call, nothing typed and no
 * not-connected notice. A cancelled wait still answers 'cancelled'.
 *
 * b.ecw, b.jg5 SRJ-605 — every terminal branch keys on agent-director's row
 * for the claude process; the wait makes no tmux probe. Where it answers
 * 'dead-session', the recovery's resume or spawn (`resumeOrFreshSpawn`)
 * decides what holds the persona's name: agent-director classifies any
 * leftover session, and a CONFLICT there latches the persona (b.jg5
 * SRJ-501). Each 'dead-session' end carries one cause
 * (`waitForWaitingAndReconnectWithCause`, `WaitDeadSession`, b.jg5
 * SRJ-611): only the reconnect's `tmux-gone` is dead evidence; a
 * 'dead-session' from a row read or from a refusal as not interactive is
 * not.
 *   - ended/missing branch: `ended` means SessionEnd fired; `missing` after
 *     the up-front sweep is agent-director's sweep verdict on the row. One
 *     line (`waitRowFinishedLine`), then 'dead-session' directly, cause
 *     `row-read-finished` with the state read.
 *   - timeout branch: a FRESH findMissing sweep (the 10s memo has long
 *     expired at the 10-minute deadline) + one status call. A `waiting` row
 *     is reconnected (b.f2b); a process mid-long-turn is left alive,
 *     'not-reconnected' (the b.rmy/b.3ce long-turn guard); only a row that
 *     reads `ended` or `missing` (cause `row-read-finished`), or is absent,
 *     returns 'dead-session'.
 *   - an absent row (`ErrSpawnNotFound`), at the poll or the timeout
 *     `status`: one line (`waitRowAbsentLine`), then 'dead-session', cause
 *     `row-absent`.
 *   - any other `status` error (UNAVAILABLE, a timeout, ENVIRONMENT, CONFIG,
 *     UNCLASSIFIED, `ErrSystemInstallDisappeared` included; b.jg5 SRJ-605):
 *     never 'dead-session', 'transient' or a refusal. At the poll the wait goes
 *     on to its next poll with no post, logging its first failed read and
 *     again only when the class changes; at the timeout it ends
 *     'not-reconnected' through `reportWaitEndedDisconnected`. The wrapper
 *     raised the error's outage (`ad-unreachable`, `tmux-unavailable`,
 *     `ad-config-malformed`), armed the persona's retry timer and reported
 *     an UNCLASSIFIED answer to its episode, as at any row read in a launch
 *     attempt (b.jg5 SRJ-105, SRJ-301), so the launch's result follows the
 *     wait's outcome.
 *   - an UNUSABLE NAME answer (b.jg5 SRJ-105, SRJ-512), or the persona's own
 *     row reading `pending` with no launch start (b.jg5 SRJ-513), at the
 *     poll or the timeout `status` (both through `readPersonaOwnRowStatus`),
 *     or an UNUSABLE NAME at a pane read or transcript `get` of the evidence
 *     read: the persona latches and the wait ends 'latched', with nothing
 *     typed, no not-connected notice and never 'dead-session'. A `status`
 *     answer records what it read (`wait.lastRead`); a pane read records the
 *     wait's last read; a transcript `get` that read a row, or no row,
 *     becomes the wait's last read (b.jg5 SRJ-501).
 *   - a CONFLICT at the evidence read's pane read (b.jg5 SRJ-608): the
 *     shared reader latches the persona with the refused operation "P's next
 *     check or recovery" and the wait's last read, and the wait ends
 *     'latched' at once, with no further call and nothing typed. Every other
 *     failed pane read (GONE, an absent row, UNAVAILABLE, ENVIRONMENT, CONFIG,
 *     UNCLASSIFIED) is no evidence and the wait goes on.
 *   - an UNCLASSIFIED at the evidence read's pane read carrying the stop mark
 *     (`stopping`: the shared reader's `ErrInvalidFlags` re-check decided
 *     that the server stops, b.jg5 SRJ-205): one line, then 'transient' with
 *     the stop noted on the wait, no further call and nothing typed; the
 *     ladder answers a `failed` result marked `stopping`, as for a resume's
 *     re-check stop.
 *   - a refused findMissing sweep (b.jg5 SRJ-105), up front or at the
 *     timeout: its refusal line, then 'transient' with no status read.
 *   - the reconnect (`reconnectMcpWithCause`, made on a row read `waiting`,
 *     at the poll or the timeout, or on a stale `working` row, with that row
 *     state as its last read): its outcome is the wait's, unchanged (b.jg5
 *     SRJ-118), a 'dead-session' with the reconnect's cause (`tmux-gone`,
 *     `row-not-interactive` or `row-absent`). A `transient` reconnect that
 *     latched the persona, or found it latched, is noted on the wait so the
 *     ladder answers `latched`; one
 *     whose `ErrInvalidFlags` re-check decided the stop is noted as a stop.
 *     It is never retried.
 * Outcome only: it answers a bare 'dead-session' with no cause; a caller
 * that needs the cause uses `waitForWaitingAndReconnectWithCause`.
 */
export async function waitForWaitingAndReconnect(
  key: string,
  config: PersonaConfig,
  ref: string = keyRef(key),
): Promise<WaitReconnectOutcome> {
  return (await waitForWaitingAndReconnectWithCause(key, config, ref)).outcome
}

/**
 * `waitForWaitingAndReconnect`, also saying, for a `dead-session` outcome,
 * its cause (`WaitDeadSession`: the reconnect's, `row-absent` or
 * `row-read-finished` with the state read; b.jg5 SRJ-611), and, for a
 * `transient` outcome, whether the persona is latched (`latched`: the wait's
 * reconnect latched it or found it latched, b.jg5 SRJ-118) or the server
 * stops (`stopping`, b.jg5 SRJ-205: a version re-check, the evidence read's
 * or the reconnect's, decided it). `lastRead` is the row state the wait's
 * last read gave (b.jg5 SRJ-501), absent when none answered.
 */
export async function waitForWaitingAndReconnectWithCause(
  key: string,
  config: PersonaConfig,
  ref: string = keyRef(key),
): Promise<WaitReconnectResult> {
  const wait: WorkingRowWait = { cancelled: cancelledLaunchWaits.has(key), wake: () => {} }
  workingRowWaits.set(key, wait)
  try {
    const end = await waitForWorkingRow(key, config, ref, wait)
    const lastRead = wait.lastRead === undefined ? {} : { lastRead: wait.lastRead }
    if (typeof end !== 'string') return { ...end, ...lastRead }
    if (end !== 'transient') return { outcome: end, ...lastRead }
    if (wait.stopping) return { outcome: end, stopping: true, ...lastRead }
    return wait.latched ? { outcome: end, latched: true, ...lastRead } : { outcome: end, ...lastRead }
  } finally {
    if (workingRowWaits.get(key) === wait) workingRowWaits.delete(key)
  }
}

/**
 * The wait's reconnect (b.jg5 SRJ-118): `reconnectMcpWithCause` with
 * `lastRead`, the row state the wait read just before (`waiting`, or
 * `working` for a stale row), answering its outcome unchanged, a
 * `dead-session` with the reconnect's cause (b.jg5 SRJ-611), and noting on
 * `wait` a `transient` one's latch or stop.
 */
async function reconnectInWait(key: string, ref: string, wait: WorkingRowWait, lastRead: LatchRowState): Promise<WaitEnd> {
  const result = await reconnectMcpWithCause(key, lastRead, ref)
  if (result.outcome === 'dead-session') return { outcome: 'dead-session', deadCause: result.deadCause }
  if (result.outcome === 'transient') {
    if (result.latched) wait.latched = true
    if (result.stopping) wait.stopping = true
  }
  return result.outcome
}

/**
 * The wait's answer after a refused findMissing sweep (b.jg5 SRJ-105), which
 * logged its own refusal line: 'cancelled' for a wait its teardown cancelled
 * meanwhile (or 'latched' for a persona latched meanwhile), otherwise
 * 'transient': nothing typed, nothing counted. No status read, reconnect or
 * 'dead-session' verdict follows.
 */
function refusedWaitSweep(key: string, ref: string, wait: WorkingRowWait): 'cancelled' | typeof WAIT_OUTCOME_LATCHED | 'transient' {
  if (waitMustEnd(key, wait)) return endWait(ref, wait)
  return 'transient'
}

/**
 * `waitForWaitingAndReconnect`'s body, with its cancellable `wait` (b.f2b).
 * Each `dead-session` end carries its cause (`WaitDeadSession`, b.jg5
 * SRJ-611).
 */
async function waitForWorkingRow(
  key: string,
  config: PersonaConfig,
  ref: string,
  wait: WorkingRowWait,
): Promise<WaitEnd> {
  const pollIntervalMs = config.agent_director_poll_interval_ms
  const waitStartedAt = _now()
  const deadline = waitStartedAt + _waitForWaitingTimeoutMs
  /** The class of the poll's last logged `status` error (b.jg5 SRJ-605); undefined before the first. */
  let loggedStatusErrorClass: AdErrorClass | undefined
  const paneWatch: WorkingPaneWatch = {
    run: undefined,
    lastReadAt: undefined,
    readFailureLogged: false,
    transcriptNote: undefined,
    promptReported: false,
  }

  // b.m4r: a bot killed mid-turn never fires SessionEnd, so its AD row freezes
  // at `working`. Without a reconcile, the poll below spins on `status` for the
  // full 10-minute window before the timeout branch's sweep + status finally
  // decides — the persona stays down that whole time. Run AD's per-row,
  // evidence-based findMissing sweep ONCE up front (agent-director plan b.93m,
  // t1.93m.hp: degraded-mode guard removed, shipped ≥ 0.8.0). A genuinely-dead
  // row reconciles to `missing`, so the FIRST status poll below hits the
  // ended/missing branch and returns 'dead-session' directly in seconds (b.ecw:
  // process-keyed, no tmux probe); a genuinely-alive long-turn row is untouched
  // by the evidence-based sweep and keeps today's polling behavior (b.rmy
  // long-turn guard preserved). Prefer
  // AD's findMissing verb over a CSCB-side tmux reconcile per
  // docs/engineering-guide.md ("Avoiding Duplicated Effort"), mirroring
  // resumeOrFreshSpawn's reconcileMissingFirst branch. On a findMissing
  // error, log and fall through to the existing poll loop (today's
  // behavior), except a refused sweep (b.jg5 SRJ-105): nothing more is
  // called, and the wait answers 'transient'.
  if (waitMustEnd(key, wait)) return endWait(ref, wait)
  const upFrontSweep = await reconcileMissingSweep(key, 'waitForWaitingAndReconnect', ref)
  if (upFrontSweep === FIND_MISSING_REFUSED) return refusedWaitSweep(key, ref, wait)
  // b.jg5 SRJ-120, SRJ-502: a persona latched once the sweep is done ends the wait.
  if (upFrontSweep === FIND_MISSING_LATCHED) return endWait(ref, wait)

  while (_now() < deadline) {
    if (waitMustEnd(key, wait)) return endWait(ref, wait)
    // b.jg5 SRJ-115: P's own row through the shared own-row `status` read.
    const read = await readPersonaOwnRowStatus(key, { ...WORKING_WAIT_STATUS_SITE, ref })
    // b.jg5 SRJ-105, SRJ-512, SRJ-513: the read latched P (an UNUSABLE NAME
    // answer, recorded unreadable, or its own row reading `pending` with no
    // launch start, recorded `pending`): the wait ends `latched`, nothing
    // typed and no not-connected notice.
    if (read.kind === OWN_ROW_STATUS_LATCHED) {
      wait.lastRead = read.rowState
      return endWait(ref, wait)
    }
    let state: string
    if (read.kind === OWN_ROW_STATUS_STATE) {
      state = read.state
      wait.lastRead = latchRowStateRead(state)
    } else {
      if (waitMustEnd(key, wait)) return endWait(ref, wait)
      if (read.kind === OWN_ROW_STATUS_ABSENT) {
        // b.jg5 SRJ-605: the row is absent (`ErrSpawnNotFound`): 'dead-session'
        // with no tmux probe; the recovery's spawn classifies any leftover
        // session. A row read, so not dead evidence (b.jg5 SRJ-611): cause
        // `row-absent`.
        wait.lastRead = LATCH_ROW_STATE_NO_ROW
        console.error(waitRowAbsentLine(ref))
        return { outcome: 'dead-session', deadCause: DEAD_SESSION_CAUSE_ROW_ABSENT }
      }
      // b.jg5 SRJ-605: any other `status` error (UNAVAILABLE, ENVIRONMENT,
      // CONFIG, UNCLASSIFIED, `ErrSystemInstallDisappeared` included) is
      // transient: the wait goes on to its next poll, with no post and no
      // result of its own. The wrapper has raised the error's outage, armed
      // the retry timer and reported an UNCLASSIFIED episode (b.jg5 SRJ-105,
      // SRJ-301). The wait's first failed read is logged, and again only
      // when the class changes.
      const errorClass = classifyAdError(read.error).errorClass
      if (errorClass !== loggedStatusErrorClass) {
        loggedStatusErrorClass = errorClass
        console.error(waitPollStatusErrorLine(ref, describeAgentDirectorFailure(read.error), errorClass))
      }
      await sleepUnlessCancelled(wait, pollIntervalMs)
      continue
    }
    if (waitMustEnd(key, wait)) return endWait(ref, wait)
    // b.f2b: a run of deferrals on the `working` row ends with any other state.
    if (state !== 'working') endWorkingRowDeferral(key)

    if (state === 'waiting') {
      return reconnectInWait(key, ref, wait, latchRowStateRead(state))
    }

    if (state === 'working') {
      // b.f2b: a stale row — the positive-idle rule held for the whole window
      // (the same idle screen and the same ended, unchanged transcript) — is
      // reconnected like a `waiting` one.
      const stale = await staleWorkingRowIsIdle(key, ref, config, paneWatch, wait)
      // b.jg5 SRJ-608: the evidence read latched P (a pane read's CONFLICT
      // or UNUSABLE NAME): `latched` at once, nothing more called or typed.
      if (stale === WAIT_OUTCOME_LATCHED) return endWait(ref, wait)
      // b.jg5 SRJ-205: the pane read's version re-check decided the stop.
      if (stale === WORKING_EVIDENCE_STOPPING) {
        wait.stopping = true
        return 'transient'
      }
      // b.jg5 SRJ-502: E14's after-call check — a latch set elsewhere, or a
      // cancel, ends the wait.
      if (waitMustEnd(key, wait)) return endWait(ref, wait)
      if (stale) {
        endWorkingRowDeferral(key)
        return reconnectInWait(key, ref, wait, latchRowStateRead(state))
      }
      // b.f2b: held back again; a run that has lasted
      // UNPROVEN_IDLE_NOTICE_AFTER_MS raises the unproven-idle notice.
      noteWorkingRowDeferral(key, config.session_restart_delay === 0)
      await sleepUnlessCancelled(wait, pollIntervalMs)
      continue
    }

    // b.ecw: this branch keys on the row agent-director keeps for the claude
    // process. `ended` means SessionEnd fired; `missing` (after the up-front
    // reconcileMissingSweep) is agent-director's sweep verdict on the row.
    // Either way the wait returns 'dead-session' directly, with no tmux
    // probe, and the recovery's resume or spawn (resumeOrFreshSpawn) decides
    // what holds the persona's name: agent-director classifies any leftover
    // session. A row read, so not dead evidence (b.jg5 SRJ-611): cause
    // `row-read-finished`, with the state read. Live transient states
    // (ask_user, check_permission, pending) fall through to 'not-reconnected'
    // below (b.f2b).
    if (state === 'ended' || state === 'missing') {
      console.error(waitRowFinishedLine(ref, state))
      return { outcome: 'dead-session', deadCause: DEAD_SESSION_CAUSE_ROW_READ_FINISHED, finishedState: state }
    }

    return reportWaitEndedDisconnected(key, config, waitEndedOnStateReport(ref, state))
  }

  // b.ecw: timed out — key on agent-director's row for the claude process.
  // The up-front sweep's 10s memo has long expired at the 10-minute
  // deadline, so run a FRESH reconcileMissingSweep (a real whole-store
  // findMissing) to reconcile a row frozen at `working`, then one status call.
  // - ended/missing → 'dead-session', cause `row-read-finished` with the
  //   state read: a row read, not dead evidence (b.jg5 SRJ-611).
  // - waiting → the turn ended at the deadline: reconnect (b.f2b).
  // - any other live state (working/ask_user/check_permission/pending) → a
  //   process merely mid-long-turn is left alive, 'not-reconnected' (b.f2b;
  //   the b.rmy/b.3ce long-turn guard).
  // - ErrSpawnNotFound → the row is absent: 'dead-session', cause
  //   `row-absent`, with no tmux probe, as at the poll; the recovery's spawn
  //   classifies any leftover session (b.jg5 SRJ-605, SRJ-611).
  // - any other status error → 'not-reconnected' through
  //   reportWaitEndedDisconnected, never 'dead-session' or 'transient' (b.jg5
  //   SRJ-605); an UNUSABLE NAME answer, or the row reading `pending` with
  //   no launch start, latches the persona and ends the wait 'latched'
  //   (b.jg5 SRJ-512, SRJ-513).
  // - a refused sweep → 'transient' with no status read (b.jg5 SRJ-105).
  if (waitMustEnd(key, wait)) return endWait(ref, wait)
  const timeoutSweep = await reconcileMissingSweep(key, 'waitForWaitingAndReconnect: timeout', ref)
  if (timeoutSweep === FIND_MISSING_REFUSED) return refusedWaitSweep(key, ref, wait)
  // b.jg5 SRJ-120, SRJ-502: a persona latched once the sweep is done ends the wait.
  if (timeoutSweep === FIND_MISSING_LATCHED) return endWait(ref, wait)
  if (waitMustEnd(key, wait)) return endWait(ref, wait)
  // b.jg5 SRJ-115: P's own row through the shared own-row `status` read.
  const timeoutRead = await readPersonaOwnRowStatus(key, {
    site: 'waitForWaitingAndReconnect: timeout',
    what: 'status read',
    ref,
  })
  // b.jg5 SRJ-105, SRJ-512, SRJ-513: the read latched P (an UNUSABLE NAME
  // answer, recorded unreadable, or its own row reading `pending` with no
  // launch start, recorded `pending`, b.jg5 SRJ-501): the wait ends
  // `latched`, nothing typed, never 'dead-session'.
  if (timeoutRead.kind === OWN_ROW_STATUS_LATCHED) {
    wait.lastRead = timeoutRead.rowState
    return endWait(ref, wait)
  }
  if (timeoutRead.kind !== OWN_ROW_STATUS_STATE) {
    if (waitMustEnd(key, wait)) return endWait(ref, wait)
    if (timeoutRead.kind === OWN_ROW_STATUS_ABSENT) {
      // b.jg5 SRJ-605: the row is absent: 'dead-session' with no tmux probe,
      // as at the poll; cause `row-absent`, not dead evidence (b.jg5 SRJ-611).
      wait.lastRead = LATCH_ROW_STATE_NO_ROW
      console.error(waitRowAbsentLine(ref, _waitForWaitingTimeoutMs))
      return { outcome: 'dead-session', deadCause: DEAD_SESSION_CAUSE_ROW_ABSENT }
    }
    // b.jg5 SRJ-605: any other `status` error (`ErrSystemInstallDisappeared`
    // included) ends the wait 'not-reconnected', never 'dead-session' or
    // 'transient'; the wrapper has raised its outage and armed the retry timer.
    const err = timeoutRead.error
    return reportWaitEndedDisconnected(
      key,
      config,
      waitTimedOutUnreadReport(ref, _waitForWaitingTimeoutMs, describeAgentDirectorFailure(err), classifyAdError(err).errorClass),
    )
  }
  const timeoutState = timeoutRead.state
  wait.lastRead = latchRowStateRead(timeoutState)
  if (waitMustEnd(key, wait)) return endWait(ref, wait)

  if (timeoutState !== 'working') endWorkingRowDeferral(key)
  if (timeoutState === 'ended' || timeoutState === 'missing') {
    console.error(waitRowFinishedLine(ref, timeoutState, _waitForWaitingTimeoutMs))
    return { outcome: 'dead-session', deadCause: DEAD_SESSION_CAUSE_ROW_READ_FINISHED, finishedState: timeoutState }
  }
  // b.f2b: the row settled at the deadline — reconnect, as the loop would have.
  if (timeoutState === 'waiting') return reconnectInWait(key, ref, wait, latchRowStateRead(timeoutState))
  // b.f2b: a `working` row given up on is one more deferral: a run that has
  // lasted UNPROVEN_IDLE_NOTICE_AFTER_MS raises the unproven-idle notice, at
  // any restart delay.
  let heldMs: number | undefined
  if (timeoutState === 'working') {
    heldMs = _now() - (workingRowDeferredSince.get(key) ?? waitStartedAt)
    noteWorkingRowDeferral(key, config.session_restart_delay === 0)
  }
  // b.f2b: say what actually happens next for the restart delay in effect.
  // With auto-restart on, the health check schedules the reconnect, whose
  // adapter types `/mcp reconnect` into a `working` row only on the
  // positive-idle rule across attempts, and never into a prompt
  // (b.9a7/b.rmy); with `session_restart_delay` 0 nothing reconnects it, so
  // the not-connected notice is raised (once per episode: not again after a
  // prompt or unproven-idle report).
  return reportWaitEndedDisconnected(
    key,
    config,
    waitTimedOutLiveReport(ref, _waitForWaitingTimeoutMs, _unprovenIdleNoticeAfterMs, timeoutState, heldMs),
  )
}

// ---------------------------------------------------------------------------
// spawnForPersona — SR-1.4 collision-then-act dispatcher
// ---------------------------------------------------------------------------

/**
 * The launch result action of a reuse spawn that succeeded for a key the
 * installed retired-key store has recorded (b.jg5 SRJ-806, SRJ-112's success
 * row): the "new life has begun" mark is set, and the persona is up on a new
 * life that resumed nothing. A success like `spawned`: every consumer that
 * reads `spawned` as a launched new life reads it the same
 * (`launchSession` maps it to true, the live-row sequence's launch counts it
 * as a success, the after-launch step has started the dialog approver). The
 * start summary counts it in `succeeded` and in its own `freshRetired`
 * count, never in `freshSpawned` (b.jg5 SRJ-1015).
 */
export const SPAWN_ACTION_FRESH_RETIRED = 'fresh-retired'

/**
 * The launch result action of a launch handed to the persona's retry timer
 * (b.jg5 SRJ-1015): a launch whose last agent-director error armed the timer
 * (UNAVAILABLE, a launch timeout included, ENVIRONMENT, CONFIG or
 * UNCLASSIFIED, or a read error, b.jg5 SRJ-301), a reuse's second
 * `ErrInstanceIdCollision` (SRJ-112), SRJ-710's lost race, or the ladder's
 * `transient` reconnect for a persona that is not latched (SRJ-118,
 * SRJ-609). A launch result, not the bring-up controller's `retrying`
 * outcome (`PersonaBringUpOutcome`), which holds a persona before its launch
 * and is counted under `not brought up`.
 */
export const SPAWN_ACTION_RETRYING = 'retrying'

/** `sequence-waiting` held back by a live-row sequence (b.jg5 SRJ-706). */
export const SEQUENCE_WAITING_CAUSE_LIVE_ROW_SEQUENCE = 'live-row-sequence'
/** `sequence-waiting` held back by an old-life hold or its wait (b.jg5 SRJ-810, SRJ-811). */
export const SEQUENCE_WAITING_CAUSE_OLD_LIFE_HOLD = 'old-life-hold'

/** What a `sequence-waiting` result was held back by. */
export type SequenceWaitingCause = typeof SEQUENCE_WAITING_CAUSE_LIVE_ROW_SEQUENCE | typeof SEQUENCE_WAITING_CAUSE_OLD_LIFE_HOLD

export interface SpawnPersonaResult {
  /** Persona key. */
  key: string
  action:
    | 'spawned'
    /**
     * b.jg5 SRJ-806, SRJ-112: a reuse spawn for a retired key succeeded and
     * its "new life has begun" mark is set (`SPAWN_ACTION_FRESH_RETIRED`).
     * A success, read as `spawned` is.
     */
    | typeof SPAWN_ACTION_FRESH_RETIRED
    | 'resumed'
    /** `/mcp reconnect` was typed into the persona's live session. */
    | 'reconnected'
    /**
     * b.f2b: the persona's row read `working`, and the wait for it to settle
     * ended with its session alive but nothing typed
     * (`waitForWaitingAndReconnect`'s `not-reconnected`; the wait logged what
     * happens next), or its teardown cancelled the wait (`cancelled`). Not a
     * failure: the session runs, so it is counted with the
     * succeeded personas and `launchSession` maps it to true, as it did when
     * this outcome was reported as `reconnected` (SR-25.1 counting unchanged).
     */
    | 'not-reconnected'
    | 'no-op'
    | 'failed'
    | 'fresh-after-amnesia'
    | 'fresh-after-inconclusive-amnesia'
    /**
     * Not launched: the persona's claude_config_dir cannot be resolved to a
     * real path (bug b.g57). No agent-director call was made and its row is
     * untouched; the bring-up controller holds the persona `retrying` until
     * the directory resolves. Not a failure: `launchSession` maps it to
     * `'skipped'`, so it counts toward no restart failure or cap.
     */
    | 'deferred'
    /**
     * b.jg5 SRJ-501, SRJ-502: the persona is latched. Either a spawn or
     * `resume` the collision ladder made answered CONFLICT, so the persona
     * latched (`conflictAt`); or a call or read of the ladder answered
     * UNUSABLE NAME (`unusableNameAt`, b.jg5 SRJ-512); or a read of its own
     * row latched it; or it was already latched when the launch was asked
     * for, so no agent-director call was made at all. Not a failure:
     * never counted, no spawn-failure notice, no `spawn-failed` entry, and
     * nothing is killed, deleted or launched after it. `launchSession` maps
     * it to `'skipped'` (SRJ-1015), and the start pass counts it neither as
     * failed nor as succeeded.
     */
    | 'latched'
    /**
     * b.jg5 SRJ-706: a live-row sequence runs for the persona
     * (`isLiveRowSequenceRunning`), so no other launch for it starts: no
     * agent-director call, no trust patch, no reply-guard step, no record
     * written, and nothing armed. Not a failure: `launchSession` maps it to
     * the uncounted `'refused'` (SRJ-1015), so a retry that meets it re-arms
     * the persona's retry timer (SRJ-302), and the start pass counts it
     * neither as failed nor as succeeded.
     */
    | 'sequence-waiting'
    /**
     * b.jg5 SRJ-207: the persona is held on `ErrInvalidFlags`. Either a reuse
     * spawn answered `ErrInvalidFlags` and the immediate version re-check
     * passed, could not run or was not running, so the persona was held
     * (`reuseSpawnFailedAt`); or it was already held when the launch was asked
     * for, so no agent-director call was made at all. Not a failure: never
     * counted, no spawn-failure notice, no `spawn-failed` entry, nothing
     * armed, and nothing is killed, deleted or launched after it.
     * `launchSession` maps it to `'skipped'` (SRJ-1015: the hold stops the
     * retry timer), and the start pass counts it neither as failed nor as
     * succeeded.
     */
    | 'held'
    /**
     * b.jg5 SRJ-1015 (`SPAWN_ACTION_RETRYING`): the launch was handed to the
     * persona's retry timer, which now owns it: the attempt's last
     * agent-director error armed the timer (b.jg5 SRJ-301), a reuse collided
     * a second time (SRJ-112), the `resume`'s `ErrSpawnNotResumable` ended in
     * a lost race (SRJ-710), or the ladder's reconnect, or its launch wait,
     * was `transient` for a persona that is not latched (SRJ-118, SRJ-609,
     * `transientReconnectResult`). Not a failure: no spawn-failure notice, no
     * `spawn-failed` entry, nothing counted. `launchSession` answers the
     * uncounted `'refused'`, so a retry that meets it re-arms the timer
     * (SRJ-302), and the start pass counts it only in its `retrying` count.
     * Not the bring-up controller's `retrying` outcome
     * (`PersonaBringUpOutcome`), which is counted under `not brought up`.
     */
    | typeof SPAWN_ACTION_RETRYING
  /**
   * For `sequence-waiting` (b.jg5 SRJ-706, SRJ-811, SRJ-1015): what holds
   * the launch back, a live-row sequence (`SEQUENCE_WAITING_CAUSE_LIVE_ROW_SEQUENCE`)
   * or an old-life hold or its wait (`SEQUENCE_WAITING_CAUSE_OLD_LIFE_HOLD`),
   * which launches no one, so the persona's retry timer was armed at the
   * refusal. Either way `launchSession` answers the uncounted `'refused'`.
   * Set only for the old-life cause; absent means a live-row sequence.
   */
  sequenceWaitingCause?: SequenceWaitingCause
  /** For `deferred`: the claude_config_dir cause (`claude-config-dir` step). */
  deferredBy?: PersonaBringUpFailure
  /**
   * Set on a `failed` result only: a resume, or a pane read of the launch
   * wait's evidence read (b.jg5 SRJ-205), answered `ErrInvalidFlags` and the
   * immediate version re-check decided the stop, so the server is stopping.
   * No spawn-failure notice was posted and no `spawn-failed` entry recorded;
   * `launchSession` answers `'skipped'`, which counts toward no failure or
   * cap.
   */
  stopping?: true
  /**
   * Set on a counted `failed` result only: the launch (a plain spawn, a
   * reuse or a `resume`) answered `ErrTmuxSessionCreate` and armed the
   * persona's retry timer at once in pending-only mode
   * (`launchFailureResult`, `armPendingOnlyAfterLaunchFailure`; b.jg5
   * SRJ-111, SRJ-112, SRJ-113, SRJ-409), so the retry's read of the row
   * decides. The failure is still counted. The live-row sequence arms no
   * other cause of its own after such a final launch.
   */
  pendingOnlyArmed?: true
  /**
   * Set on a `failed` result only, where its error is handled by class: the
   * class is LAUNCH FAILURE (`ErrTmuxSessionCreate`) or DIRECTORY
   * (`ErrCwdNotFound`, `ErrCwdNotADirectory`), the classes SRJ-112 and
   * SRJ-113 count (b.jg5). Every launch's LAUNCH FAILURE sets it
   * (`launchFailureResult`: the plain spawn's, the reuse spawn's and the
   * `resume`'s failure handling); the reuse spawn sets it for DIRECTORY too,
   * and so does the live-row sequence's `resume` leg. The live-row
   * sequence's launch entry counts a failure only when it is set
   * (`sequenceLaunchCounted`); the restart path counts any `failed` result
   * that is not stopping.
   */
  countedClass?: true
}

// ---------------------------------------------------------------------------
// Pre-launch claude_config_dir check (bug b.g57)
// ---------------------------------------------------------------------------

/**
 * Realpath and lstat overrides for resolving a persona's claude_config_dir on
 * the launch path: the pre-launch check, the spawn label and the ladder's
 * `config_dir` comparison. `undefined` means the real file system.
 */
let _configDirFs: Partial<StrictRealPathFs> | undefined

/** Test-only seam: resolve every persona's claude_config_dir on the launch path through `fs`. */
export function _setConfigDirFs(fs: Partial<StrictRealPathFs>): void {
  _configDirFs = fs
}

/** Test-only seam: restore the real file system for the claude_config_dir resolution. */
export function _resetConfigDirFs(): void {
  _configDirFs = undefined
}

/**
 * The launch path's check of a persona's claude_config_dir (bug b.g57):
 * `checkPersonaConfigDir` against the spawn home and the file-system seam, so
 * the check, the spawn label and the ladder's comparison resolve the
 * directory the same way. Production also injects it into the bring-up
 * controller as its re-check. Never throws.
 */
export function checkLaunchConfigDir(persona: Persona): ConfigDirCheckResult {
  return checkPersonaConfigDir(persona, { home: spawnHomeDir(), fs: _configDirFs })
}

/**
 * Told when a launch finds a persona's claude_config_dir unresolvable; returns
 * whether it holds the persona (production: the bring-up controller's
 * `holdForConfigDir`, which logs the failure line once per episode and
 * re-checks on the persona's own timer).
 */
export type ConfigDirUnresolvableHook = (persona: Persona, failure: PersonaCheckFailure) => boolean

/**
 * The one hook, installed like the pre-launch reply guard. With none installed
 * (unit tests, the integration driver), or when it does not hold the persona,
 * the failure line is logged here, on every attempt.
 */
let configDirUnresolvableHook: ConfigDirUnresolvableHook | undefined

/** Install (or, with undefined, remove) the unresolvable-claude_config_dir hook (production: `server.ts`). */
export function setConfigDirUnresolvableHook(hook: ConfigDirUnresolvableHook | undefined): void {
  configDirUnresolvableHook = hook
}

/** Hand an unresolvable claude_config_dir to the hook; log its line when nothing holds the persona. Never throws. */
function deferLaunchForConfigDir(persona: Persona, failure: PersonaCheckFailure): void {
  let held = false
  if (configDirUnresolvableHook) {
    try {
      held = configDirUnresolvableHook(persona, failure)
    } catch (err) {
      console.error(
        `[slack] spawnForPersona: holding ${personaRef(persona)} for its claude_config_dir failed: ${describeThrownValue(err)}`,
      )
    }
  }
  if (!held) console.error(failure.line)
}

/** The `deferred` result for a persona whose claude_config_dir cannot be resolved. */
function deferredResult(persona: Persona, failure: PersonaCheckFailure): SpawnPersonaResult {
  return { key: persona.key, action: 'deferred', deferredBy: { step: 'claude-config-dir', class: failure.class, cause: failure.cause } }
}

/**
 * Before a path that would touch the persona's instance ahead of its launch
 * (the restart module's kill adapter): check its claude_config_dir and, when
 * it cannot be resolved, hand it to the hook as a launch would and return
 * true, so the caller leaves the instance and its row alone. False when the
 * directory resolves. Makes no agent-director call.
 */
export function holdLaunchIfConfigDirUnresolvable(persona: Persona): boolean {
  return deferIfConfigDirUnresolvable(persona) !== undefined
}

/**
 * Check the persona's claude_config_dir; when it cannot be resolved, hand it
 * to the hook as a launch would and return the `deferred` result with its
 * cause (`deferredBy`), as the pre-launch check does. Undefined when the
 * directory resolves.
 */
function deferIfConfigDirUnresolvable(persona: Persona): SpawnPersonaResult | undefined {
  const check = checkLaunchConfigDir(persona)
  if (check.ok) return undefined
  deferLaunchForConfigDir(persona, check)
  return deferredResult(persona, check)
}

/**
 * Home directory the spawn path resolves an unset claude_config_dir against
 * (`<home>/.claude`) when computing the `config_dir` label. `undefined` means
 * the OS home, read at spawn time.
 */
let _spawnHomeDir: string | undefined

/** Test-only seam: resolve the spawn `config_dir` label against `home`. */
export function _setSpawnHomeDir(home: string): void {
  _spawnHomeDir = home
}

/** Test-only seam: restore the OS home for the spawn `config_dir` label. */
export function _resetSpawnHomeDir(): void {
  _spawnHomeDir = undefined
}

/**
 * Home directory for `config_dir` label values: the test seam's home when set,
 * else the OS home, read at call time. Used by the spawn labels and by every
 * row comparison, so both derive the label from the same home.
 */
function spawnHomeDir(): string {
  return _spawnHomeDir ?? homedir()
}

/**
 * Build SpawnParams for a persona (SR-1.1, b.av2 SR-2.2): instance ID, tmux
 * session name, labels and env from E1's persona-identity functions, `cwd`
 * set to the persona's working directory.
 *
 * `CLAUDE_CONFIG_DIR` carries the persona's effective claude_config_dir exactly
 * as configured and is absent when none is; the `config_dir` label is
 * `configDirLabel`, the hash of its real path from the launch's pre-launch
 * check (`checkLaunchConfigDir`), never of its lexical path (bug b.g57).
 *
 * extra_env unconditionally carries CSCB_CRONTABLE_PATH (the resolved,
 * tilde-expanded, absolute cron_table_path from the config) so bots can
 * locate the self-documenting crontable from the env var alone — no config
 * file lookup needed (D-Q2, b.grx decision 3).
 *
 * extra_env also always carries `PROMPT_SUGGESTION_OFF_ENV`
 * (`CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false`, b.svb/b.f2b; see
 * persona-identity.ts for why). Every plain spawn in the ladder (the first
 * spawn, the retry spawn after the collision `get` found no row, and the
 * spawn after `resume` found none) sends
 * these params unchanged, the reuse spawn (`reuseSpawnForPersona`), which
 * is every replacement of a row the ladder cannot keep (the replace step,
 * `replacePersonaRow`, and the live-row sequence's final launch) and the
 * launch after resume's no-transcript answer (b.jg5 SRJ-707, SRJ-712), sends
 * them with only `reuse_finished: true` added (b.jg5 SRJ-708: one
 * derivation, so a reuse carries the same template, `cwd`, labels and
 * `extra_env` as any launch of the persona), and a resume restores the env
 * agent-director stored with the row at its spawn, so every launch of the
 * persona's Claude runs with it.
 *
 * The params never carry the reuse flag (b.jg5 SRJ-711, SRJ-111): only the
 * reuse launch adds it, so a first spawn of a key that is not retired is
 * plain, and when the key's row is already there it collides and the ladder
 * goes on to the collision `get` and `resume`, which keep the conversation.
 * The only first launch that is a reuse is a retired key's (SRJ-805).
 *
 * CSCB never passes `no_pre_trust`: not here, not on a reuse and not on a
 * `resume`, so agent-director pre-accepts the persona's folder trust at
 * every launch and reports the outcome as the result's `pre_trust`, which
 * CSCB only logs (`preTrustLogLine`, b.jg5 SRJ-413).
 */
function buildSpawnParams(persona: Persona, config: PersonaConfig, configDirLabel: string): SpawnParams {
  const { key } = persona
  return {
    template: TEMPLATE_NAME,
    cwd: persona.working_directory,
    claude_instance_id: personaInstanceId(key),
    relay_mode: 'on',
    tmux_session_name: personaTmuxSessionName(key),
    label: [
      SERVICE_LABEL,
      `${PERSONA_LABEL_PREFIX}${key}`,
      `${CONFIG_DIR_LABEL_PREFIX}${configDirLabel}`,
    ],
    extra_env: personaSpawnEnv({
      key,
      crontablePath: config.cron_table_path,
      claudeConfigDir: persona.claude_config_dir,
    }),
  }
}

/**
 * A kill made inside a launch or recovery attempt for the persona (the
 * live-row sequence's kills, the restart path's kill).
 */
const KILL_CONTEXT_ATTEMPT = 'attempt'
/** A persona teardown's kill: no launch or recovery attempt; it arms nothing (b.jg5 SRJ-110; hatch A3). */
export const KILL_CONTEXT_TEARDOWN = 'teardown'

/** The context of a `killPersonaInstance` call. */
export type KillContext = typeof KILL_CONTEXT_ATTEMPT | typeof KILL_CONTEXT_TEARDOWN

/** Options of `killPersonaInstance`. `context` is required, so no caller takes either form by omission. */
export interface KillPersonaInstanceOptions {
  /**
   * `KILL_CONTEXT_ATTEMPT`: the kill is made inside a launch or recovery
   * attempt for the persona. The wrapper reports its error as for any call in
   * the attempt (b.jg5 SRJ-301: an UNAVAILABLE, ENVIRONMENT, CONFIG or
   * UNCLASSIFIED answer arms the persona's retry timer), and a class the kill
   * has no row for (`unlistedClass`: a STATE name other than
   * `ErrSpawnNotFound`, `ErrInvalidFlags` after its re-check included, LAUNCH
   * FAILURE, DIRECTORY) takes SRJ-105's UNCLASSIFIED row through the outage
   * state's site entry (`reportUnclassifiedAtSite`): it arms the retry timer
   * with the UNCLASSIFIED cause and feeds the persona's unclassified-error
   * episode (b.jg5 SRJ-313), and is never counted.
   *
   * `KILL_CONTEXT_TEARDOWN`: the persona teardown's kill, which is no launch
   * or recovery attempt (b.jg5 SRJ-110; hatch A3): it arms no retry timer,
   * starts no `tmux-unresponsive` condition, reports nothing to the
   * unclassified-error episode, and raises the `tmux-unavailable` or
   * `ad-config-malformed` outage for an ENVIRONMENT or CONFIG answer only
   * when the persona is in the applied configuration (the installed
   * configured-persona query).
   */
  readonly context: KillContext
  /**
   * True when the caller kills a row it read in a live state (b.jg5
   * glossary: only such a kill is tmux-touching): the live-row sequence's
   * kills. Absent or false otherwise (the persona teardown did not read the
   * row; the restart path kills only after a `dead` reading).
   */
  readonly rowReadLive?: boolean
  /**
   * `KILL_CONTEXT_ATTEMPT` only: true for one try of a bounded kill retry
   * (`retryPersonaKill`; b.jg5 SRJ-702): the wrapper does not report an
   * UNAVAILABLE answer (`OutageDetectionOptions.deferUnavailableReport`), so
   * no try but the one whose outcome stands arms the retry timer or starts
   * the `tmux-unresponsive` condition. Ignored for `KILL_CONTEXT_TEARDOWN`.
   */
  readonly deferUnavailableReport?: boolean
}

/**
 * Kill persona `key`'s instance (`cscb_<key>`): one checked kill
 * (`checkedKill`, `src/checked-kill.ts`; b.jg5 SRJ-110, SRJ-701) through
 * `withOutageDetection`, which raises or clears the key's outage flags as
 * `options.context` says (`KillPersonaInstanceOptions`). Answers the kill's
 * outcome, `kill_sent` included: a success (any `kill_sent`,
 * `ErrSpawnNotFound`, or GONE) or a non-success with its class and the
 * thrown value. An `ErrInvalidFlags` gets exactly one immediate version
 * re-check first, in either context (`recheckKillOnInvalidFlags`; b.jg5
 * SRJ-104, SRJ-204), its answer kind kept in the outcome; when it decides
 * that the server stops (`killOutcomeStopsServer`), nothing is reported and
 * the caller does nothing more (b.jg5 SRJ-205). In `KILL_CONTEXT_ATTEMPT`
 * an outcome of a class the kill has no row for is then reported as
 * UNCLASSIFIED (`reportUnlistedKillOutcome`). With
 * `options.deferUnavailableReport` (one try of `retryPersonaKill`) an
 * UNAVAILABLE answer is not reported here. Never throws or rejects, and
 * never retries. Logs nothing, records no startup error, raises no notice of
 * its own and latches nothing: each caller acts on the outcome by its own
 * context. Its callers, one call per try of a bounded retry: the persona
 * teardown's kill (`killPersonaInstanceForTeardown`, `KILL_CONTEXT_TEARDOWN`;
 * b.jg5 SRJ-715) and the live-row sequence's kills and the restart path's
 * kill (`retryPersonaKill`, `KILL_CONTEXT_ATTEMPT`). The collision ladder
 * makes no kill.
 */
export async function killPersonaInstance(key: string, options: KillPersonaInstanceOptions): Promise<KillOutcome> {
  const call = adKillCall(options.rowReadLive === true)
  const inAttempt = options.context === KILL_CONTEXT_ATTEMPT
  const wrapperOptions = inAttempt
    ? options.deferUnavailableReport === true
      ? { deferUnavailableReport: true }
      : undefined
    : { armsNothing: { personaConfigured: () => configuredReadingOf(key).configured } }
  const killed = await checkedKill(personaInstanceId(key), (params) =>
    withOutageDetection(key, undefined, call, (client) => client.kill(params), wrapperOptions),
  )
  const outcome = await recheckKillOnInvalidFlags(killed)
  if (inAttempt) reportUnlistedKillOutcome(key, outcome, call)
  return outcome
}

/**
 * The `ErrInvalidFlags` step at a kill (b.jg5 SRJ-104, SRJ-204): every kill
 * site gives `ErrInvalidFlags` no meaning, so a non-success whose thrown
 * value is an `ErrInvalidFlags` (by name) gets exactly one immediate version
 * re-check (`classifyWithInvalidFlagsRecheck`; a stop it decides ends the
 * process as the re-check defines) and is answered with the re-check's
 * answer kind as its `recheck`; it stays UNCLASSIFIED. Every other outcome is
 * answered as it is, with no re-check. Never throws or rejects.
 */
async function recheckKillOnInvalidFlags(outcome: KillOutcome): Promise<KillOutcome> {
  if (outcome.kind !== KILL_OUTCOME_NOT_KILLED || outcome.errorClass === AD_ERROR_CLASS_UNAVAILABLE) return outcome
  if (!isInvalidFlagsError(outcome.error)) return outcome
  const step = await classifyWithInvalidFlagsRecheck(outcome.error)
  return { ...outcome, recheck: step.recheck.kind }
}

/**
 * Inside a launch or recovery attempt for persona `key`: an outcome of a
 * class the kill has no row for (`unlistedClass`: a STATE name other than
 * `ErrSpawnNotFound`, LAUNCH FAILURE, DIRECTORY; b.jg5 SRJ-104, SRJ-110),
 * which the wrapper did not take as UNCLASSIFIED, is reported as an
 * UNCLASSIFIED outcome through the outage state's site entry
 * (`reportUnclassifiedAtSite`, with its UNCLASSIFIED classification,
 * `unclassifiedClassificationOf`): the persona's retry timer is armed with
 * the UNCLASSIFIED cause (the attempt records it, so a launch it ends is
 * refused and never counted) and its unclassified-error episode is fed
 * (b.jg5 SRJ-105, SRJ-313). An `ErrInvalidFlags` whose re-check decided that
 * the server stops is not reported (b.jg5 SRJ-205). Every other outcome,
 * a by-name UNCLASSIFIED one included (the wrapper reported it), reports
 * nothing. Never throws.
 */
function reportUnlistedKillOutcome(key: string, outcome: KillOutcome, call: AdKillCall): void {
  try {
    if (outcome.kind !== KILL_OUTCOME_NOT_KILLED || outcome.errorClass === AD_ERROR_CLASS_UNAVAILABLE) return
    if (outcome.unlistedClass === undefined || killOutcomeStopsServer(outcome)) return
    reportUnclassifiedAtSite(key, outcome.error, call, unclassifiedClassificationOf(outcome.error))
  } catch {
    /* a failing report changes nothing about the kill's own outcome */
  }
}

// ---------------------------------------------------------------------------
// The bounded retry of a persona's kill (b.jg5 SRJ-702)
// ---------------------------------------------------------------------------

/**
 * What the server tells a persona's kill retry (b.jg5 SRJ-702, SRJ-305):
 * whether the persona is up (serving, its bring-up `up`, its key applied;
 * false once it is torn down or not up) and whether the server is shutting
 * down. Production installs one in `main()`. The latch is asked separately
 * (`personaLatchedNow`).
 */
export interface PersonaKillKeepGoingQuery {
  isPersonaUp(key: string): boolean
  isShuttingDown(): boolean
}

let personaKillKeepGoingQuery: PersonaKillKeepGoingQuery | undefined

/** Install (or, with `undefined`, remove) the persona kill retry's keep-going query. */
export function setPersonaKillKeepGoingQuery(query: PersonaKillKeepGoingQuery | undefined): void {
  personaKillKeepGoingQuery = query
}

/**
 * The keep-going check of persona `key`'s kill retry: false once the
 * persona is latched (`personaLatchedNow`, b.jg5 SRJ-502), or, with a query
 * installed, once the server is shutting down or the persona is not up (a
 * query that throws counts as false). With no query installed, only the
 * latch is asked. Never throws.
 */
function personaKillKeepsGoing(key: string): boolean {
  if (personaLatchedNow(key)) return false
  const query = personaKillKeepGoingQuery
  if (query === undefined) return true
  try {
    return query.isShuttingDown() !== true && query.isPersonaUp(key) === true
  } catch {
    return false
  }
}

/** The stop cause of a persona's kill retry when the server's keep-going query cannot tell which one answered false. */
export const PERSONA_KILL_STOP_CAUSE_GENERIC =
  'its keep-going check answered false: the persona is torn down or not up, or the server is shutting down'

/** The stop cause of a persona's kill retry when the server's keep-going query says the server is shutting down (b.jg5 SRJ-702). */
export const PERSONA_KILL_STOP_CAUSE_SHUTDOWN = 'its keep-going check answered false: the server is shutting down'

/** The stop cause of a persona's kill retry when the server's keep-going query says the persona is not up (b.jg5 SRJ-702). */
export const PERSONA_KILL_STOP_CAUSE_NOT_UP = 'its keep-going check answered false: the persona is torn down or not up'

/** The stop cause of a persona's kill retry whose last outcome's version re-check decided that the server stops (b.jg5 SRJ-702, SRJ-205). */
export const PERSONA_KILL_STOP_CAUSE_RECHECK = "the last outcome's version re-check stops the server"

/**
 * Why persona `key`'s kill retry was stopped, as far as the server's
 * keep-going query tells now (b.jg5 SRJ-702: the stop's cause): the server
 * is shutting down, or the persona is not up (torn down, or no longer
 * serving); otherwise, a query that throws, or none installed, the generic
 * cause (`PERSONA_KILL_STOP_CAUSE_GENERIC`). Read when the alert is raised,
 * right after the tries. A caller that knows its own cause (the live-row
 * sequence's stop) passes it instead. Never throws.
 */
function personaKillStopCause(key: string): string {
  const query = personaKillKeepGoingQuery
  if (query === undefined) return PERSONA_KILL_STOP_CAUSE_GENERIC
  try {
    if (query.isShuttingDown() === true) return PERSONA_KILL_STOP_CAUSE_SHUTDOWN
    if (query.isPersonaUp(key) !== true) return PERSONA_KILL_STOP_CAUSE_NOT_UP
  } catch {
    /* the generic cause below */
  }
  return PERSONA_KILL_STOP_CAUSE_GENERIC
}

/** What `retryPersonaKill` is given. */
export interface PersonaKillRetryOptions {
  /** True when the path read the row in a live state: each try is a tmux-touching kill (`AdKillCall`). */
  readonly rowReadLive: boolean
  /** The row state the path last read (`src/kill-retry.ts`'s seed): only a live one gets the tries. */
  readonly lastRead: KillRetrySeed
  /** The head of the tries' and reads' lines (`[slack] <site>: …`). */
  readonly site: string
  /** The persona's reference, for the read's lines. */
  readonly ref: string
  /** The wait between tries. */
  readonly clock: KillRetryWait
  /**
   * The caller's own keep-going check, asked beside the server's
   * (`personaKillKeepsGoing`): the tries go on only while both answer true
   * (the live-row sequence's: it is not stopped and the persona is not
   * latched). A throw counts as false. Absent: the server's alone.
   */
  readonly keepGoing?: () => boolean
}

/** What the between-try read of a persona's own row is called in that read's lines. */
const KILL_RETRY_READ_WHAT = 'status read between kill tries'

/**
 * The bounded retry of persona `key`'s kill inside a launch or recovery
 * attempt (b.jg5 SRJ-702, SRJ-110; `runKillRetry`, `src/kill-retry.ts`):
 *   - each try is one checked kill (`killPersonaInstance`,
 *     `KILL_CONTEXT_ATTEMPT`, with `deferUnavailableReport`), so a try's
 *     UNAVAILABLE answer arms nothing and starts nothing; every other answer
 *     is reported at once, as it stands at once;
 *   - the read between tries is the shared own-row `status` read
 *     (`readPersonaOwnRowStatus`): through `withOutageDetection`, so a CONFIG
 *     answer raises `ad-config-malformed` (b.jg5 SRJ-316) and, inside the
 *     attempt, a failed read reports as any read does; a read of the
 *     persona's own row `pending` with no launch start, or an UNUSABLE NAME
 *     answer, latches the persona (b.jg5 SRJ-512, SRJ-513), which ends the
 *     tries with no further kill;
 *   - the keep-going check (`personaKillKeepsGoing`, and the caller's own
 *     `options.keepGoing` when given) ends the tries with no further kill
 *     once the persona is latched, torn down or not up, or the server is
 *     shutting down (or the caller's check answers false);
 *   - only a seed read live gets the tries; any other kill is one try.
 * Then, when the tries ended in a failure that no stop ended and the caller's
 * own keep-going check, when given, still answers true (`callerKeepsGoing`),
 * its outcome is reported once (`reportDeferredUnavailable`, with the kill's
 * declared call):
 * an UNAVAILABLE outcome arms the persona's retry timer once (the
 * kill-failed cause for `ErrTmuxKillFailed`) and, for a kill of a row read
 * live, an UNAVAILABLE other than `ErrTmuxKillFailed` starts or continues
 * its `tmux-unresponsive` condition. A success reports nothing more, and a
 * stop reports nothing, so no retry timer is armed for a latched persona or
 * for a caller stopped while its last try ran.
 * Answers the retry's result, its alert decision included, for the caller's
 * own handling of the outcome that stands. Never throws or rejects.
 */
export async function retryPersonaKill(key: string, options: PersonaKillRetryOptions): Promise<KillRetryResult> {
  const call = adKillCall(options.rowReadLive)
  const result = await runKillRetry({
    instanceId: personaInstanceId(key),
    kill: () =>
      killPersonaInstance(key, { context: KILL_CONTEXT_ATTEMPT, rowReadLive: options.rowReadLive, deferUnavailableReport: true }),
    read: () => readPersonaKillRow(key, options.site, options.ref),
    wait: options.clock,
    lastRead: options.lastRead,
    keepGoing: () => personaKillKeepsGoing(key) && (options.keepGoing === undefined || options.keepGoing() === true),
    log: (line) => console.error(line),
    logPrefix: `[slack] ${options.site}`,
  })
  if (result.outcome.kind === KILL_OUTCOME_NOT_KILLED && !killRetryStopped(result) && callerKeepsGoing(options)) {
    reportDeferredUnavailable(key, result.outcome.error, call)
  }
  return result
}

/**
 * The caller's own keep-going check of a persona's kill retry, asked once
 * more after the tries: true with no check given, false when it answers
 * anything but true or throws. A caller whose check answers false then (the
 * live-row sequence, stopped or latched while the last try ran) gets no
 * deferred report: the retry timer is not armed and no `tmux-unresponsive`
 * condition starts. Never throws.
 */
function callerKeepsGoing(options: PersonaKillRetryOptions): boolean {
  if (options.keepGoing === undefined) return true
  try {
    return options.keepGoing() === true
  } catch {
    return false
  }
}

/**
 * Raise the kill-failure alert that persona `key`'s kill retry decided
 * (`retried.alert`; b.jg5 SRJ-704, SRJ-702, SRJ-1007), at the restart path
 * (`_buildKillSessionAdapter`, `src/server.ts`) and the live-row sequence's
 * kills, after the standing outcome's own handling (a CONFLICT has
 * latched the persona with its own post; an UNAVAILABLE outcome has armed
 * its retry timer, `ErrTmuxKillFailed` with the kill-failed cause and never
 * the `tmux-unresponsive` condition) and, for the survivor version, before
 * the caller's next step. The context is `recovery` at the restart path
 * (SRJ-1007); the live-row sequence's kills pass their request's context
 * (`recovery` for a sequence the collision ladder starts) and the server's
 * alerts (`buildLiveRowSequenceDeps`). Through the given kill-failure alerts, the
 * installed ones (`setKillFailureAlerts`) by default, which route it by
 * whether the persona is in the applied configuration now:
 *   - `survivor`: its destination, once for this retry, with no episode; or
 *     one `persona-kill-survivor` entry when not configured;
 *   - `ordinary`: its destination, once per kill-failure episode, closing
 *     with the latched sentence when the persona is latched now (the last
 *     outcome latched it, a read between tries did, or it latched while the
 *     tries ran), and otherwise with "CSCB keeps retrying"; or one
 *     `persona-kill-failed` entry when not configured.
 * The keep-going stop (b.jg5 SRJ-702, SRJ-301): an `ordinary` decision whose
 * tries the keep-going check stopped while the persona is not latched (it
 * is torn down or not up, or the server is shutting down), or whose last
 * outcome's version re-check decided that the server stops, is raised with
 * `stopped`, the last outcome's class and the stop's cause (`stopCause` when
 * the caller knows it, as the live-row sequence does for its own stop;
 * otherwise what the server's keep-going query tells now: the server is
 * shutting down, or the persona is torn down or not up, with the generic
 * `PERSONA_KILL_STOP_CAUSE_GENERIC` when it cannot tell; for a version
 * re-check's stop, that): it is no notice
 * (b.jg5 SRJ-702, SRJ-1003, SRJ-1013), inside a teardown window or not, so
 * the alerts post nothing, raise neither version, open no episode and write
 * one line naming the persona, the context, that class, that cause and the
 * redacted descriptions (the latest survivor-naming one included); for a
 * persona no longer in the applied configuration (one removed while the
 * tries ran) they also write that line's content as one
 * `persona-kill-failed` entry, with no alert text, and for a configured
 * persona the line only. With no
 * alerts installed, one line carries the decision instead. A `none`
 * decision does nothing. Never throws.
 *
 *   [slack] <site>: kill for <ref>: the kill-failure alert's <version> version is not raised — no kill-failure alerts are installed; <descriptions> (b.jg5 SRJ-704)
 *
 * where `<descriptions>` is `last="<redacted>"` and `earlier survivor-naming="<redacted>"`, each when present, or `survivor-naming="<redacted>"`.
 */
export function raisePersonaKillFailureAlert(
  key: string,
  retried: KillRetryResult,
  site: string,
  ref: string,
  context: KillFailureAlertContext = KILL_FAILURE_CONTEXT_RECOVERY,
  alerts: KillFailureAlerts | undefined = killFailureAlerts,
  stopCause?: string,
): void {
  try {
    const decision = retried.alert
    if (decision.kind === KILL_RETRY_ALERT_NONE) return
    const latched = retried.end === KILL_RETRY_END_READ_LATCHED || personaLatchedNow(key)
    const stopsServer = killOutcomeStopsServer(retried.outcome)
    const stopped = stopsServer || (retried.end === KILL_RETRY_END_STOPPED && !latched)
    if (alerts === undefined) {
      console.error(
        `[slack] ${site}: kill for ${ref}: the kill-failure alert's ${decision.kind} version is not raised — no kill-failure alerts are installed; ${describeKillFailureDescriptions(decision)} (b.jg5 SRJ-704)`,
      )
      return
    }
    const { outcome } = retried
    // b.jg5 SRJ-702: a stopped retry's one line names the last outcome's class and the stop's cause.
    const stop = stopped
      ? {
          lastOutcomeClass: outcome.kind === KILL_OUTCOME_NOT_KILLED ? outcome.errorClass : outcome.kind,
          stopCause: stopsServer ? PERSONA_KILL_STOP_CAUSE_RECHECK : (stopCause ?? personaKillStopCause(key)),
        }
      : {}
    alerts.raise({ key, decision, latched, stopped, context, ...stop })
  } catch (err) {
    console.error(`[slack] ${site}: kill for ${ref}: raising the kill-failure alert failed: ${describeThrownValue(err)}`)
  }
}

/** One between-try `status` read of persona `key`'s own row, as the kill retry takes it. Never throws. */
async function readPersonaKillRow(key: string, site: string, ref: string): Promise<KillRetryRead> {
  const read = await readPersonaOwnRowStatus(key, { site, what: KILL_RETRY_READ_WHAT, ref })
  switch (read.kind) {
    case OWN_ROW_STATUS_STATE:
      return { kind: KILL_RETRY_READ_STATE, state: read.state }
    case OWN_ROW_STATUS_ABSENT:
      return { kind: KILL_RETRY_READ_NO_ROW }
    case OWN_ROW_STATUS_LATCHED:
      return { kind: KILL_RETRY_READ_LATCHED }
    case OWN_ROW_STATUS_REFUSED:
      return { kind: KILL_RETRY_READ_FAILED, error: read.error }
  }
}

// ---------------------------------------------------------------------------
// The persona teardown's kill (b.jg5 SRJ-715, SRJ-110, SRJ-702)
// ---------------------------------------------------------------------------

/**
 * One CONFLICT or UNUSABLE NAME answer the persona teardown's kill met (b.jg5
 * SRJ-715, SRJ-1002, SRJ-1003): where, its class (by name, through
 * `src/ad-error-class.ts`) and the thrown value, raw, for the teardown's own
 * routing. Nothing latched on it. The shape is `KillRefusal`
 * (`src/checked-kill.ts`), whose notice builder the teardown uses.
 */
export type PersonaTeardownKillRefusal = KillRefusal

/**
 * What the persona teardown's kill answers: the bounded retry's result (the
 * outcome that stands, how the tries ended, and the kill-failure alert
 * decision, which the caller raises on the persona-teardown route), and every
 * CONFLICT or UNUSABLE NAME answer met, in order (a CONFLICT is never tried
 * again, so at most one comes from a try).
 */
export interface PersonaTeardownKillResult extends KillRetryResult {
  readonly refusals: readonly PersonaTeardownKillRefusal[]
}

/** What `killPersonaInstanceForTeardown` is given. */
export interface PersonaTeardownKillOptions {
  /** The wait between tries (production: `KILL_RETRY_SYSTEM_CLOCK`; a test passes `createFakeClock()`). */
  readonly clock: KillRetryWait
  /** The persona's reference for the lines; `persona=<key>` when absent. */
  readonly ref?: string
}

/** The line head of the persona teardown kill's tries and reads. */
const TEARDOWN_KILL_LOG_PREFIX = '[slack] persona teardown kill'

/** `err`'s class when it is CONFLICT or UNUSABLE NAME (by name), else undefined. Never throws. */
function teardownRefusalClassOf(err: unknown): PersonaTeardownKillRefusal['errorClass'] | undefined {
  try {
    const { errorClass } = classifyAdError(err)
    return errorClass === AD_ERROR_CLASS_CONFLICT || errorClass === AD_ERROR_CLASS_UNUSABLE_NAME ? errorClass : undefined
  } catch {
    return undefined
  }
}

/**
 * The persona teardown's kill of `cscb_<key>` (b.jg5 SRJ-715, SRJ-110,
 * SRJ-702): the bounded retry (`runKillRetry`, `src/kill-retry.ts`) on
 * `options.clock`, seeded as a live row the teardown has not read
 * (`KILL_RETRY_SEED_LIVE_UNREAD`), so its UNAVAILABLE outcomes get up to 3
 * tries 2 s apart:
 *   - each try is one checked kill (`killPersonaInstance` with
 *     `KILL_CONTEXT_TEARDOWN`): through `withOutageDetection` arming nothing,
 *     so no try arms a retry timer, starts a `tmux-unresponsive` condition or
 *     feeds the unclassified-error episode, and an ENVIRONMENT or CONFIG
 *     answer raises its outage only while the persona is in the applied
 *     configuration; an `ErrInvalidFlags` gets its one version re-check;
 *   - the read before each further try is one `status` of the row through
 *     `withOutageDetection` arming nothing too (`readTeardownKillRow`): a
 *     CONFIG answer raises `ad-config-malformed` for a configured persona
 *     only, and the read latches nothing (b.jg5 SRJ-1002): no own-row latch
 *     step applies, so a `pending` row with no launch start is a live read
 *     and an UNUSABLE NAME answer a failed one, and the next try goes ahead;
 *     the row-read rule's entry clear alone applies (b.jg5 SRJ-807, SRJ-115):
 *     a row read `waiting`, `working`, `ask_user` or `check_permission` of
 *     a key recorded with its mark set clears the key's entry;
 *   - no keep-going check: the teardown is not stopped by the persona being
 *     latched or not up. Neither SRJ-316's rule against starting a kill of a
 *     row last read `pending` nor a latch holds the kill's start back, so a
 *     `pending` row with no launch start, and a latched persona's row, get
 *     its first try (b.jg5 SRJ-503, SRJ-513). Between tries the retry's own
 *     rule still applies: a CONFIG answer at a read that follows a read of
 *     `pending` ends the tries with no further kill (b.jg5 SRJ-702);
 *   - a CONFLICT is never tried again (the retry tries only UNAVAILABLE), and
 *     nothing latches on it or on an UNUSABLE NAME: each one met, at a try or
 *     at a read, is answered in `refusals` for the teardown's routing.
 * Nothing is reported after the tries: an UNAVAILABLE outcome that stands
 * arms no retry timer. When the tries decided the kill-failure alert's
 * ordinary version, the key's old-life hold (begun at apply step 1) is
 * marked kill-failed (`markOldLifeHoldKillFailed`; b.jg5 SRJ-812, SRJ-715);
 * no outcome ends the hold, a success included: the next read of the old
 * row does (b.jg5 SRJ-809). No delete is made, whatever the outcome: the row is
 * kept (b.jg5 SRJ-715). Each try and read is logged by the retry under
 * `[slack] persona teardown kill`. Never throws or rejects, and leaves no
 * timer pending once it settles.
 *
 * Before its first try it forgets the persona's launch-call window and its
 * "this launch's row" record (`forgetLaunchCalls`, b.jg5 SRJ-407, SRJ-310):
 * the teardown calls it once the persona's launch in flight has settled, so
 * no launch of the persona is left to record either.
 */
export async function killPersonaInstanceForTeardown(
  key: string,
  options: PersonaTeardownKillOptions,
): Promise<PersonaTeardownKillResult> {
  forgetLaunchCalls(key)
  const ref = options.ref ?? keyRef(key)
  const refusals: PersonaTeardownKillRefusal[] = []
  const result = await runKillRetry({
    instanceId: personaInstanceId(key),
    kill: async () => {
      const outcome = await killPersonaInstance(key, { context: KILL_CONTEXT_TEARDOWN })
      if (outcome.kind === KILL_OUTCOME_NOT_KILLED) {
        const errorClass =
          outcome.errorClass === AD_ERROR_CLASS_CONFLICT || outcome.errorClass === AD_ERROR_CLASS_UNUSABLE_NAME
            ? outcome.errorClass
            : undefined
        if (errorClass !== undefined) refusals.push({ at: KILL_REFUSAL_AT_KILL, errorClass, error: outcome.error })
      }
      return outcome
    },
    read: async () => {
      const read = await readTeardownKillRow(key)
      if (read.kind === KILL_RETRY_READ_FAILED) {
        const errorClass = teardownRefusalClassOf(read.error)
        if (errorClass !== undefined) refusals.push({ at: KILL_REFUSAL_AT_READ, errorClass, error: read.error })
      }
      return read
    },
    wait: options.clock,
    lastRead: KILL_RETRY_SEED_LIVE_UNREAD,
    log: (line) => console.error(line),
    logPrefix: `${TEARDOWN_KILL_LOG_PREFIX} for ${ref}`,
  })
  // b.jg5 SRJ-812, SRJ-809: tries that decided the ordinary kill-failure
  // alert mark the old life's hold kill-failed; nothing here ends it.
  markOldLifeHoldKillFailed(personaInstanceId(key), result)
  return { ...result, refusals: [...refusals] }
}

/**
 * Mark the old-life hold on `instanceId` kill-failed (b.jg5 SRJ-812, SRJ-809)
 * when `retried`, a kill of the old row, decided the ordinary kill-failure
 * alert (`ErrTmuxKillFailed` after its tries, or any failure after a
 * survivor-naming one) and no stop ended its tries (`killRetryStopped`),
 * since a stopped kill raises no alert. A caller whose stop rule withholds
 * the alert for more (the start sweep, once it has stopped) does not call
 * it then. A success (`kill_sent` true or false, or after a survivor-naming
 * failure, whose survivor version never marks), a CONFLICT or an UNUSABLE
 * NAME with no survivor-naming failure before it, or any outcome that
 * decided no ordinary alert marks nothing. Nothing ends
 * the hold here, and with no hold set installed, or no hold on the id,
 * nothing happens. The mark lasts until the hold ends. Never throws.
 */
function markOldLifeHoldKillFailed(instanceId: string, retried: KillRetryResult): void {
  const holds = oldLifeHolds
  if (holds === undefined) return
  try {
    if (retried.alert.kind !== KILL_RETRY_ALERT_ORDINARY || killRetryStopped(retried)) return
    holds.markKillFailed(instanceId)
  } catch (err) {
    // Not reached (the hold set never throws); the hold stays as it was.
    console.error(`[slack] old-life hold: marking instanceId=${instanceId} kill-failed failed: ${describeThrownValue(err)} (b.jg5 SRJ-812)`)
  }
}

/** Who reads, in the clear line of the teardown kill's `status` read between its tries (b.jg5 SRJ-807). */
export const TEARDOWN_KILL_STATUS_SITE: OwnRowReadSite = Object.freeze({ site: 'persona teardown kill', what: 'status read between tries' })

/**
 * One `status` read of persona `key`'s row between the teardown kill's tries
 * (b.jg5 SRJ-702, SRJ-715): through `withOutageDetection` arming nothing (a
 * CONFIG answer raises `ad-config-malformed` for a configured persona only;
 * nothing is armed or reported). It latches nothing (SRJ-715, SRJ-1002): of
 * the row-read rule only the entry clear applies (`decideRetiredEntryClear`
 * over the read of `cscb_<key>` with the installed store's mark,
 * `clearRetiredEntryOnRead`; b.jg5 SRJ-807, SRJ-115), so a row read live
 * other than `pending` of a key recorded with its mark set clears its entry,
 * with the store's one line naming `TEARDOWN_KILL_STATUS_SITE`. A read of
 * `ended` or `missing`, or no row, ends the old-life hold on `cscb_<key>`
 * (`noteOldLifeRowRead`; b.jg5 SRJ-809). Its state, no row for
 * `ErrSpawnNotFound` (by name), or a failed read; what it answers is the same
 * whatever the clear or the hold's end did. Never throws.
 */
async function readTeardownKillRow(key: string): Promise<KillRetryRead> {
  try {
    const result = await withOutageDetection(
      key,
      undefined,
      'status',
      (client) => client.status({ claude_instance_id: personaInstanceId(key) }),
      { armsNothing: { personaConfigured: () => configuredReadingOf(key).configured } },
    )
    const clear = decideRetiredEntryClear({
      key,
      row: { ...result, claude_instance_id: personaInstanceId(key) },
      configured: false,
      retiredMarked: retiredMarkOf(key),
    })
    if (clear !== undefined) clearRetiredEntryOnRead(key, clear, TEARDOWN_KILL_STATUS_SITE)
    // b.jg5 SRJ-809: a row read `ended` or `missing` ends the key's old-life hold.
    noteOldLifeRowRead(personaInstanceId(key), { kind: OLD_LIFE_ROW_READ_STATE, state: result.state }, oldLifeReadName(TEARDOWN_KILL_STATUS_SITE))
    return { kind: KILL_RETRY_READ_STATE, state: result.state }
  } catch (err) {
    if (hasAdErrorName(err, ERR_SPAWN_NOT_FOUND_NAME)) {
      // b.jg5 SRJ-809: no row ends the key's old-life hold.
      noteOldLifeRowRead(personaInstanceId(key), { kind: OLD_LIFE_ROW_READ_NO_ROW }, oldLifeReadName(TEARDOWN_KILL_STATUS_SITE))
      return { kind: KILL_RETRY_READ_NO_ROW }
    }
    return { kind: KILL_RETRY_READ_FAILED, error: err }
  }
}

/**
 * The row state the restart path's kill records in a latch (b.jg5 SRJ-501):
 * the state its run last read, carried by `lastRead`, the run's `dead`
 * reading (`deadRowReadOf`): `ended` or `missing` as read, or no row for
 * `ErrSpawnNotFound`. `NOTHING_READ` when the reading carries no row state
 * (`ErrSystemInstallDisappeared`, which reads no row, or a reading made with
 * no `status` call): the latch then makes the one latch-time `status` read.
 */
function restartKillLastRead(lastRead: LivenessReading): LastRowRead {
  const rowRead = deadRowReadOf(lastRead)
  if (rowRead === undefined) return NOTHING_READ
  return rowRead === LIVENESS_DEAD_ROW_NO_ROW ? LATCH_ROW_STATE_NO_ROW : latchRowStateRead(rowRead)
}

/**
 * The restart path's latch for its kill's outcome (b.jg5 SRJ-110, SRJ-501,
 * SRJ-512; `_buildKillSessionAdapter`, `src/server.ts`): a CONFLICT latches
 * persona `key` through the latch's CONFLICT entry with the refused
 * operation "P's next check or recovery", and an UNUSABLE NAME through the
 * unusable-name entry, each with the row state the restart run last read
 * (`lastRead`, its `dead` reading: `ended`, `missing` or no row;
 * `restartKillLastRead`), with no further `status` read; only when that
 * reading carries no row state (`ErrSystemInstallDisappeared`) is one
 * latch-time `status` read made, its lines prefixed `site` too. A read that
 * itself latches the persona leaves that latch standing. One line prefixed
 * `site`. With no latch installed nothing is read or set, and the line says
 * so. Answers true for those two classes (the restart work answers
 * `latched`), false for every other outcome, for which it does nothing. The
 * kill is never repeated. Never throws.
 */
export async function latchOnRestartKillOutcome(
  key: string,
  outcome: KillOutcome,
  site: string,
  lastRead: LivenessReading,
): Promise<boolean> {
  return latchOnKillOutcomeAt(key, outcome, site, keyRef(key), restartKillLastRead(lastRead))
}

/**
 * The latch for a kill's standing outcome inside a launch or recovery
 * attempt (b.jg5 SRJ-110, SRJ-501, SRJ-512): a CONFLICT latches persona
 * `key` through the latch's CONFLICT entry (`conflictAt`) with the refused
 * operation "P's next check or recovery", and an UNUSABLE NAME through the
 * unusable-name entry (`unusableNameAt`), each with `lastRead`, the row
 * state the path last read (one latch-time `status` read only when it read
 * nothing), its line prefixed `site`. Answers true for those two classes,
 * false for every other outcome, for which it does nothing. The kill is
 * never repeated. Never throws.
 */
async function latchOnKillOutcomeAt(
  key: string,
  outcome: KillOutcome,
  site: string,
  ref: string,
  lastRead: LastRowRead,
): Promise<boolean> {
  if (outcome.kind !== KILL_OUTCOME_NOT_KILLED) return false
  if (outcome.errorClass === AD_ERROR_CLASS_CONFLICT) {
    await conflictAt(key, outcome.error, REFUSED_OPERATION_NEXT_CHECK_OR_RECOVERY, lastRead, 'kill', ref, site)
    return true
  }
  if (outcome.errorClass === AD_ERROR_CLASS_UNUSABLE_NAME) {
    await unusableNameAt(key, outcome.error, lastRead, site, 'kill', ref)
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// A launch's failure: the plain spawn's handling and LAUNCH FAILURE
// ---------------------------------------------------------------------------

/** The tail of the one line a launch's LAUNCH FAILURE writes (b.jg5 SRJ-602). */
const LAUNCH_FAILURE_LINE_TAIL = ' — a counted launch failure; nothing is killed and no spawn is made in its place (b.jg5 SRJ-602)'

/**
 * Whether `err` is a LAUNCH FAILURE (`ErrTmuxSessionCreate`), decided by name
 * (`classifyAdError`): a launch whose session-creating call failed, after
 * "duplicate session" (the new row ended, unless the end write was not
 * applied) or otherwise (a fresh spawn's row left `pending`, never CSCB's
 * own launch; b.jg5 SRJ-713). Never throws.
 */
function isLaunchFailure(err: unknown): boolean {
  return classifyAdError(err).errorClass === AD_ERROR_CLASS_LAUNCH_FAILURE
}

/**
 * The result of a launch whose `ErrTmuxSessionCreate` (LAUNCH FAILURE) is
 * one counted launch failure (b.jg5 SRJ-602, SRJ-111, SRJ-112, SRJ-113,
 * SRJ-713), once its caller has written the line, the notice and the
 * `spawn-failed` entry. Nothing is killed because of it and no launch
 * follows it. The persona's retry timer is armed at once, with no `get`
 * first, in pending-only mode (`armPendingOnlyAfterLaunchFailure`; SRJ-301,
 * SRJ-409; HO rev 28), so that the retry's read of the row decides, with
 * neither `session_restart_delay` nor `health_check_interval` needed:
 *   - a fresh spawn's launch that failed other than by "duplicate session"
 *     leaves its row `pending`, covered unless its key is retired with no
 *     "new life has begun" mark (SRJ-411). It is never CSCB's own launch:
 *     the call neither returned success nor timed out, so its window has no
 *     end (`launchCallWithWindow`) and no own-launch record is set
 *     (SRJ-412). The retries wait it out through the pending-row rule
 *     (SRJ-410): it is never killed, gets at most the held post at B, and P
 *     is brought up once agent-director marks it `missing` (SRJ-713);
 *   - after "duplicate session" agent-director ended the new row (`ended`),
 *     and a leftover's hooks never revive it; only an end write that was
 *     not applied leaves it `pending`, waited out the same way;
 *   - a `resume`'s or a reuse's row reads as agent-director's restore left
 *     it; one still `pending` is handled as a failed fresh spawn's.
 * Answers `failed` marked `countedClass`, and `pendingOnlyArmed` when the
 * timer was armed (inside a launch attempt with a sink installed). Never
 * throws.
 */
function launchFailureResult(key: string): SpawnPersonaResult {
  return armPendingOnlyAfterLaunchFailure(key)
    ? { key, action: 'failed', countedClass: true, pendingOnlyArmed: true }
    : { key, action: 'failed', countedClass: true }
}

/**
 * A launch's `ErrInvalidFlags` at a site that gives it no meaning (b.jg5
 * SRJ-104, SRJ-204: a plain spawn and a `resume`; the reuse spawn holds the
 * persona instead, `invalidFlagsAtReuse`): exactly one immediate version
 * re-check through the `ErrInvalidFlags` step
 * (`classifyWithInvalidFlagsRecheck`), then:
 *   - a stop the re-check decides: one line (`what` names the call), and
 *     `failed` marked `stopping`: nothing posted, and the launch it ends is
 *     not counted (SRJ-205);
 *   - any other re-check answer: SRJ-105's UNCLASSIFIED row (SRJ-313): the
 *     outage state's site entry (`reportUnclassifiedAtSite`, with the
 *     declared `verb`) arms the persona's retry timer with the UNCLASSIFIED
 *     cause and reports it to the persona's unclassified-error episode, one
 *     refusal line, and `failed`, which the launch answers as `retrying`
 *     when the timer was armed (`retryingWhenArmed`).
 * No spawn-failure notice, no `spawn-failed` entry, nothing counted, and no
 * further launch, delete or kill. Each line is built from the
 * classification's rendered fields, never from the error itself. Never
 * throws.
 */
async function invalidFlagsUnclassifiedAt(
  key: string,
  err: InvalidFlagsError,
  verb: 'spawn' | 'resume',
  what: string,
  ref: string,
): Promise<SpawnPersonaResult> {
  const step = await classifyWithInvalidFlagsRecheck(err)
  const recheck = `after one immediate agent-director version re-check: ${step.recheck.kind}`
  if (step.recheck.kind === RECHECK_OUTCOME_STOP) {
    console.error(
      `[slack] spawnForPersona: ${what} failed for ${ref}: ${describeAdErrorClassification(step.classification)} (${recheck})`,
    )
    return { key, action: 'failed', stopping: true }
  }
  reportUnclassifiedAtSite(key, err, verb, step.classification)
  logRefusal('spawnForPersona', what, ref, `${describeAdErrorClassification(step.classification)} (${recheck})`)
  return { key, action: 'failed' }
}

/**
 * A plain spawn's failure by class (b.jg5 SRJ-111, SRJ-713), once the one
 * plain-spawn outcome handler (`plainSpawnOutcomeAt`) has taken its
 * collision, with no further launch in the attempt:
 *   - `ErrInvalidFlags`: one immediate version re-check, then UNCLASSIFIED
 *     (`invalidFlagsUnclassifiedAt`, SRJ-204, SRJ-313);
 *   - DIRECTORY (`ErrCwdNotFound`, `ErrCwdNotADirectory`, by name): `failed`
 *     quietly (the spawn's wrapper raised `cwd-unreachable`);
 *   - the refusal handling (`launchRefusalAt`): a CONFLICT, the pre-spawn
 *     scan's refusal (no row written) or one after "duplicate session" (the
 *     new row ended, unless agent-director's end write was not applied)
 *     alike (CSCB does not tell them apart by their words), latches with the
 *     refused operation "plain spawn" and `lastRead`, with nothing counted
 *     and no kill; an
 *     UNUSABLE NAME latches; UNAVAILABLE, ENVIRONMENT, CONFIG and
 *     UNCLASSIFIED answer `failed` with no notice, the reporting point having
 *     armed the persona's retry timer, raised the outage or fed the
 *     unclassified-error episode by class;
 *   - an UNAVAILABLE refusal (a launch timeout, the pre-spawn scan that could
 *     not answer, "duplicate session"'s unreadable or ambiguous holder, and
 *     the re-lookup after "duplicate session" that could not answer, whose
 *     new row agent-director ended, included) is then followed by the one
 *     `get` and its decision (`afterLaunchUnavailable`, b.jg5 SRJ-407);
 *   - LAUNCH FAILURE (`ErrTmuxSessionCreate`): one line (`what` names the
 *     spawn), a `spawn-failed` entry at start and the spawn-failure notice,
 *     and one counted launch failure (`launchFailureResult`): nothing is
 *     killed, no spawn is made in its place (SRJ-602), and the persona's
 *     retry timer is armed at once in pending-only mode. Unless it followed
 *     "duplicate session", its row stays `pending`, never CSCB's own launch
 *     (the call set no window end), and the retries wait it out through the
 *     pending-row rule until agent-director marks it `missing` (SRJ-713);
 *   - any other value (a STATE or GONE name a plain spawn gives no meaning):
 *     SRJ-105's UNCLASSIFIED row through the site entry
 *     (`reportUnclassifiedAtSite`), one refusal line, `failed`, no notice.
 * Only a LAUNCH FAILURE reaches the spawn-failure notice. Never throws.
 */
async function plainSpawnFailedAt(
  persona: Persona,
  err: unknown,
  isStartup: boolean,
  ref: string,
  what: string,
  lastRead: LastRowRead,
): Promise<SpawnPersonaResult> {
  const { key } = persona
  // b.jg5 SRJ-111, SRJ-204: the plain spawn gives ErrInvalidFlags no meaning.
  if (isInvalidFlagsError(err)) return invalidFlagsUnclassifiedAt(key, err, 'spawn', what, ref)
  // b.av2 SR-6.4: `cwd-unreachable` was raised by the spawn's wrapper.
  if (classifyAdError(err).errorClass === AD_ERROR_CLASS_DIRECTORY) return { key, action: 'failed' }
  const refused = await launchRefusalAt(key, err, 'spawn', what, ref, lastRead)
  // b.jg5 SRJ-407: an UNAVAILABLE outcome (a launch timeout, HO rev 15's
  // pre-spawn scan that could not answer, HO rev 20's holder, HO rev 26's
  // re-lookup included) is followed by one `get`, and no launch, in this attempt.
  if (refused) {
    return isUnavailableRefusal(refused, err)
      ? afterLaunchUnavailable({ persona, isStartup, ref, verb: 'spawn', what }, err, refused)
      : refused
  }
  if (isLaunchFailure(err)) {
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('spawn', 'UnknownError', String(err))
    const described = describeAgentDirectorFailure(e)
    console.error(`[slack] spawnForPersona: ${what} failed for ${ref}: ${described}${LAUNCH_FAILURE_LINE_TAIL}`)
    if (isStartup) recordStartupError('spawn-failed', `${what} failed for ${ref}: ${described}`)
    notifySpawnFailure(key, e, isStartup)
    return launchFailureResult(key)
  }
  // b.jg5 SRJ-104, SRJ-105, SRJ-313: a name the plain spawn gives no meaning.
  const classification = unclassifiedClassificationOf(err)
  reportUnclassifiedAtSite(key, err, 'spawn', classification)
  logRefusal('spawnForPersona', what, ref, describeAdErrorClassification(classification))
  return { key, action: 'failed' }
}

/** What a plain-spawn site gives the one plain-spawn outcome handler (`plainSpawnOutcomeAt`). */
export interface PlainSpawnSite<R> {
  readonly persona: Persona
  /** Whether the launch is part of the start pass (startup-errors entries are written only then). */
  readonly isStartup: boolean
  readonly ref: string
  /** The plain spawn's parameters: `buildSpawnParams`, unchanged, with no reuse flag and no `no_pre_trust` (b.jg5 SRJ-111, SRJ-413). */
  readonly params: SpawnParams
  /** What the handler's lines call the spawn. */
  readonly what: string
  /** The row state the site last read before the spawn: the state a CONFLICT or UNUSABLE NAME latch records (b.jg5 SRJ-501). */
  readonly lastRead: LastRowRead
  /**
   * Whether a DIRECTORY failure (`ErrCwdNotFound`, `ErrCwdNotADirectory`) is
   * marked `countedClass`: the live-row sequence's launch entry counts a
   * failure only when it is marked (b.jg5 SRJ-111), while the restart path
   * counts any `failed` result that is not stopping. Absent: not marked.
   */
  readonly marksDirectoryCounted?: boolean
  /** The site's line for a success, given the spawn's result. */
  readonly spawnedLine: (launched: Phase1SpawnResult) => string
  /**
   * The site's `ErrInstanceIdCollision` row (b.jg5 SRJ-111, SRJ-114): the
   * collision ladder's get-then-act (its first run after the first spawn,
   * its one re-run after a later plain spawn's collision,
   * `plainSpawnCollisionAtLadder`), or, at the live-row sequence's launch
   * entry, the sequence's end without its launch, whose retry runs
   * get-then-act. Never the spawn-failure notice (SRJ-713).
   */
  readonly collided: (err: unknown) => Promise<R>
}

/**
 * The one plain-spawn outcome handler (b.jg5 SRJ-111): one plain spawn of
 * persona `site.persona`'s `cscb_<key>` from `site.params`, its outcome
 * decided by name or class (`src/ad-error-class.ts`), never by `instanceof`.
 * Used at every plain-spawn site: the collision ladder's first spawn, its
 * retry spawn after the collision `get` answered `ErrSpawnNotFound`, and the
 * spawn after `resume`'s `ErrSpawnNotFound` at both `resume` sites
 * (`resumeOrFreshSpawn` and the live-row sequence's launch entry, through
 * `plainSpawnAfterResumeNotFound`). agent-director's pre-spawn scan runs
 * inside the spawn and writes nothing when it refuses (HO rev 15): no row
 * exists afterwards. A spawn whose session-creating call meets "duplicate
 * session" ends its new row (`ended`), which a leftover's hooks never
 * revive, unless agent-director's end write was not applied, which leaves it
 * `pending` (HO rev 15, rev 17). A fresh spawn whose launch failed otherwise
 * (`ErrTmuxSessionCreate`) leaves a `pending` row that is never CSCB's own
 * launch, waited out by the pending-row rule, never killed (b.jg5 SRJ-713,
 * SRJ-410). A row whose create reply was lost and whose worker then exited
 * is counted gone by agent-director's `find-missing` once no pane carries
 * its launch's per-pane label, and is marked `missing` past G (HO rev 18).
 *
 * The installed reply-guard steps run immediately before the call (b.av2
 * SR-9.4), and the call records its window (`launchCallWithWindow`, b.jg5
 * SRJ-407). Then:
 *   - success: the site's line, the after-launch step
 *     (`afterLaunchSucceeded`: the dialog approver on the persona's `pending`
 *     row, the pending-only arm of its retry timer, the `pre_trust` line;
 *     SRJ-401, SRJ-301, SRJ-413), and `spawned`;
 *   - `ErrInstanceIdCollision` (by name): nothing was launched, so the
 *     reply-guard steps are undone (restored while still the step's own),
 *     and the site's collision row (`site.collided`) answers: nothing is
 *     counted, and no spawn-failure notice is posted (SRJ-713);
 *   - any other value: the plain spawn's failure by class
 *     (`plainSpawnFailedAt`): CONFLICT and UNUSABLE NAME latch, a launch
 *     timeout and every other UNAVAILABLE outcome are followed by the one
 *     `get`, ENVIRONMENT, CONFIG and UNCLASSIFIED are refusals,
 *     `ErrTmuxSessionCreate` is one counted launch failure with no kill,
 *     DIRECTORY answers `failed` (marked `countedClass` where the site asks,
 *     `site.marksDirectoryCounted`), and `ErrInvalidFlags` gets one
 *     immediate version re-check, then UNCLASSIFIED.
 * The handler makes one launch call and never a second one after a refusal;
 * nothing here deletes, kills or sets `include_finished`. Never throws.
 */
export async function plainSpawnOutcomeAt<R>(site: PlainSpawnSite<R>): Promise<SpawnPersonaResult | R> {
  const { persona, isStartup, ref, params } = site
  const { key } = persona
  const replyGuardUndo = runPreLaunchReplyGuard(persona, ref)
  let launched: Phase1SpawnResult
  try {
    launched = await launchCallWithWindow(key, persona.working_directory, 'spawn', (client) => client.spawn(params))
  } catch (err) {
    if (hasAdErrorName(err, ERR_INSTANCE_ID_COLLISION_NAME)) {
      // b.av2 SR-9.4: a collision means an instance already exists, so this
      // spawn's reply-guard steps are undone; any later launch runs them again.
      undoPreLaunchReplyGuard(replyGuardUndo, ref)
      return site.collided(err)
    }
    const notSpawned = await plainSpawnFailedAt(persona, err, isStartup, ref, site.what, site.lastRead)
    return site.marksDirectoryCounted === true ? withDirectoryCounted(notSpawned, err) : notSpawned
  }
  console.error(site.spawnedLine(launched))
  afterLaunchSucceeded(key, isStartup, ref, LAUNCH_VERB_SPAWN, launched)
  return { key, action: 'spawned' }
}

// ---------------------------------------------------------------------------
// ErrJsonlMissing diagnostic (bug b.wrb)
// ---------------------------------------------------------------------------

/** The startup-errors class of a lost transcript: a resume met `ErrJsonlMissing` after provable activity (b.wrb; b.jg5 SRJ-712). */
export const JSONL_TRANSCRIPT_LOST_ENTRY_CLASS = 'jsonl-transcript-lost-on-resume'

/** The startup-errors class of an inconclusive lost-transcript diagnosis (b.fwu; b.jg5 SRJ-712). */
export const JSONL_DIAGNOSIS_INCONCLUSIVE_ENTRY_CLASS = 'jsonl-diagnosis-inconclusive'

/**
 * What every text of the lost-transcript diagnosis says about the persona
 * after `ErrJsonlMissing` (b.jg5 SRJ-712): its log lines and startup-errors
 * details ("the persona is …") and its persona notices ("I was …"). The
 * persona is brought up fresh by a reuse spawn of its own id, and its row is
 * kept; none of them says the row goes away.
 */
export const JSONL_DIAGNOSIS_REUSE_WORDING =
  'brought up fresh by a reuse spawn of the same instance, and its row is kept (its history archived to the earlier life)'

/** What the lost-transcript diagnosis concluded (b.wrb, b.fwu). */
type JsonlDiagnosisVerdict = 'lost' | 'never-created' | 'inconclusive'

/**
 * The lost-transcript diagnosis's answer when it read the row (or found
 * none): its verdict, and the persona notice it holds back until the reuse
 * spawn after it succeeds (`notice`; absent for `never-created`, which posts
 * none). Its log line and startup-errors entry were written already.
 */
interface JsonlDiagnosis {
  readonly verdict: JsonlDiagnosisVerdict
  readonly notice?: string
}

/** The source tokens agent-director stamps on each candidate it stat'd
 *  (AD's `jsonlAttempt.source`): the persisted jsonl_path column, the
 *  CLAUDE_CONFIG_DIR-aware recomputed fallback, and archived session_history
 *  entries. Kept as the literal token set AD emits — never a version check. */
type AdJsonlCandidateSource = 'persisted' | 'fallback' | 'history'

/** Single source of truth for the tokens the candidate parser anchors on. */
const AD_JSONL_CANDIDATE_SOURCES: readonly AdJsonlCandidateSource[] = [
  'persisted',
  'fallback',
  'history',
]

/** One transcript candidate resume tried (or that we recomputed locally). */
interface JsonlCandidate {
  /** Provenance as reported by AD (see AdJsonlCandidateSource), or a
   *  'locally-computed(…)' label when we reconstructed it ourselves because
   *  AD's message lacked detail. */
  source: string
  path: string
  /** The stat error AD reported, or our own local stat result label. */
  note: string
}

/**
 * Best-effort parse of an ErrJsonlMissing description into the candidate list
 * AD enumerates as `<source> <path> (<stat error>)`, joined by "; ".
 *
 * Returns [] when the description does not carry the enumerated detail — the
 * case for any AD whose ErrJsonlMissing message predates the per-candidate
 * enumeration delivered by AD bug b.1ba. Callers MUST treat [] as "AD gave no
 * path detail" and degrade to locally-computed candidates, never as "no paths".
 *
 * Strictly non-throwing and version-agnostic: it keys off the literal
 * `persisted` / `fallback` / `history` source tokens, not any version string.
 * An AD that emits only a subset of those tokens simply yields fewer matches.
 */
function parseJsonlMissingCandidates(description: string): JsonlCandidate[] {
  if (!description) return []
  const out: JsonlCandidate[] = []
  // AD renders each attempt as: `<source> <path> (<stat error>)`.
  // Anchor on the known source tokens so unrelated prose is ignored.
  const re = new RegExp(
    `(${AD_JSONL_CANDIDATE_SOURCES.join('|')})\\s+(\\S+)\\s+\\(([^)]*)\\)`,
    'g',
  )
  let m: RegExpExecArray | null
  while ((m = re.exec(description)) !== null) {
    out.push({ source: m[1], path: m[2], note: m[3] })
  }
  return out
}

/** Local stat label: what WE see at a path right now (never claims AD tried it). */
function localStatNote(path: string): string {
  try {
    const st = statSync(path)
    if (st.isFile() && st.size > 0) return `locally present, ${st.size} bytes`
    if (st.isFile()) return 'locally present but empty'
    return 'locally present but not a regular file'
  } catch (err) {
    const code = (err as { code?: string })?.code
    return code ? `locally absent (${code})` : 'locally absent'
  }
}

/**
 * b.wrb, b.jg5 SRJ-712: make an `ErrJsonlMissing` resume failure legible.
 * Reads the persona's row, logs which transcript path(s) were tried and their
 * provenance, and classifies the loss as never-created (expected, lossless),
 * lost (real context destroyed, operator-visible) or inconclusive. The
 * persona is then brought up fresh by a reuse spawn of its own id, which
 * keeps its row as an earlier life (`JSONL_DIAGNOSIS_REUSE_WORDING`).
 *
 * It runs before that reuse spawn, because the reuse resets the row it reads
 * (its `jsonl_path`, session id, `cwd` and `started_at`). Never throws.
 *
 * The log line and the startup-errors entry (`JSONL_TRANSCRIPT_LOST_ENTRY_CLASS`,
 * `JSONL_DIAGNOSIS_INCONCLUSIVE_ENTRY_CLASS`, at start only) are written here.
 * The persona notice of a `lost` or `inconclusive` verdict is not posted
 * here: it is answered as `notice`, and the caller posts it only once the
 * reuse spawn has brought the persona up (`noTranscriptReuse`), since the
 * notice says the persona was brought up fresh.
 *
 * b.jg5 SRJ-105/SRJ-114: the row `get` is one of SRJ-114's sites, made
 * through the shared own-row read (`readPersonaOwnRow`). No diagnosis is
 * reported (no startup-errors entry, no persona notice, no amnesia count)
 * when it latched the persona (a `provenance_conflict` note on its own row,
 * or an UNUSABLE NAME answer, b.jg5 SRJ-512, which records the state
 * unreadable): the diagnosis answers `latched`, and the caller launches
 * nothing (b.jg5 SRJ-502). The same when the persona latched elsewhere while
 * the get was awaited (`latchedAfterOwnRowRead`, its one line). Nor when it
 * failed with a refusal (`refusalAt` with verb `get`: any error but
 * `ErrSpawnNotFound` and an UNUSABLE NAME answer, a CONFIG answer included,
 * b.jg5 SRJ-316): the diagnosis answers the refusal result, and the caller
 * launches nothing (SRJ-105); any other failure, none today, answers
 * `failed` the same way, with one line and no spawn-failure notice.
 * `ErrSpawnNotFound` (the row is absent) gives 'inconclusive', its reason
 * saying the row is absent.
 *
 * `read.lastRead` is set to what the `get` read (b.jg5 SRJ-501): the state
 * the reuse spawn after it records if it latches.
 *
 * @returns the diagnosis (`JsonlDiagnosis`): 'lost' when the row had
 *          provable prior activity but no transcript survives (loud),
 *          'never-created' when the archive was consulted and proved
 *          idle-since-spawn (quiet, evidence-based lossless), 'inconclusive'
 *          when not enough evidence could be gathered to decide either way
 *          (loud-but-uncertain: the diagnosis machinery itself is degraded,
 *          which correlates with the storage faults that cause loss); or the
 *          ladder's result (`failed` or `latched`) when the row `get` failed
 *          or latched the persona.
 */
async function diagnoseJsonlMissing(
  persona: Persona,
  config: PersonaConfig,
  err: AgentDirectorError,
  isStartup: boolean,
  read: { lastRead?: LatchRowState },
): Promise<JsonlDiagnosis | RefusedSiteResult | LatchedSiteResult> {
  const { key } = persona
  const ref = personaRef(persona)
  // --- 1. What paths did AD try, and from where? -------------------------
  // err.errDescription is AD's detail string. The rich format (AD b.1ba,
  // shipped in v0.10.0) enumerates `<source> <path> (<err>)`; pre-b.1ba ADs do
  // not. Parse defensively — [] means "no AD detail", not "no paths".
  const adCandidates = parseJsonlMissingCandidates(err.errDescription ?? '')

  // --- 2. Read the row before the reuse spawn resets it (best-effort). ----
  // b.jg5 SRJ-501: this get is the path's last read of the row before the
  // reuse spawn, so `read.lastRead` records what it gave.
  const claudeInstanceId = personaInstanceId(key)
  const what = 'ErrJsonlMissing diagnosis get'
  const ownRead = await readPersonaOwnRow(key, { site: 'spawnForPersona', what, ref })
  if (ownRead.kind === OWN_ROW_READ_LATCHED) {
    // b.jg5 SRJ-105, SRJ-512: an UNUSABLE NAME answer latched the persona.
    // No diagnosis is reported; the caller launches nothing.
    read.lastRead = LATCH_ROW_STATE_UNREADABLE
    return { key, action: 'latched' }
  }
  // b.jg5 SRJ-502: the get is awaited, and the persona may have latched
  // elsewhere meanwhile (the health tick's liveness read, SRJ-315): no
  // diagnosis is reported, and the caller launches nothing.
  if (latchedAfterOwnRowRead(key, 'spawnForPersona', what, ref)) return { key, action: 'latched' }
  if (ownRead.kind === OWN_ROW_READ_REFUSED) {
    // b.jg5 SRJ-105/SRJ-114: a read error on this get is a refusal (the get
    // runs inside the launch attempt, so it arms the retry timer; `get` is
    // not tmux-touching, so it starts no condition). No diagnosis is
    // reported; the caller launches nothing.
    const refused = refusalAt(key, ownRead.error, 'get', 'spawnForPersona', what, ref)
    if (refused) return refused
    // Not reached: every `get` error but ErrSpawnNotFound and UNUSABLE NAME
    // is a refusal. Any other ends the ladder 'failed' as a refusal does: no
    // diagnosis, no launch, no spawn-failure notice (b.jg5 SRJ-105).
    console.error(`[slack] spawnForPersona: ${what} failed for ${ref}: ${describeAgentDirectorFailure(ownRead.error)} — nothing more is called`)
    return { key, action: 'failed' }
  }
  if (ownRead.kind === OWN_ROW_READ_ABSENT) {
    read.lastRead = LATCH_ROW_STATE_NO_ROW
    // (a) Row already gone (ErrSpawnNotFound) — cannot enrich or classify.
    // Inconclusive: the row could not be consulted at all, so whether history
    // was lost is unknown. Report it as uncertainty, not reassurance.
    const adDetail = adCandidates.length
      ? adCandidates.map((c) => `${c.source} ${c.path} (${c.note})`).join('; ')
      : redactSlackLogText(err.errDescription || '(no path detail from agent-director)')
    const notice = reportInconclusiveDiagnosis(
      ref,
      claudeInstanceId,
      `the agent-director row is absent (ErrSpawnNotFound); AD reported: ${adDetail}`,
      isStartup,
      err,
    )
    return { verdict: 'inconclusive', notice }
  }
  const row = ownRead.row
  read.lastRead = latchRowStateRead(row.state)
  // b.jg5 SRJ-502: a persona this read latched is not brought up fresh, so
  // the diagnosis, whose texts say it is, is not reported either.
  if (ownRead.latched) return { key, action: 'latched' }

  // --- 3. Assemble the candidate list to log. ----------------------------
  // The persona's effective claude_config_dir (per-persona, else top-level);
  // undefined makes resolveJsonlPath use the home-directory default.
  const effectiveConfigDir = persona.claude_config_dir
  const candidates: JsonlCandidate[] = [...adCandidates]

  if (adCandidates.length === 0) {
    // pre-b.1ba / shape-mismatch path: AD gave no enumerated detail.
    // Reconstruct what WE can, clearly labelled as locally computed — never
    // claim it is what AD tried.
    if (row.jsonl_path) {
      candidates.push({
        source: 'locally-computed(persisted-column)',
        path: row.jsonl_path,
        note: localStatNote(row.jsonl_path),
      })
    }
    if (row.claude_session_id) {
      const fallback = resolveJsonlPath(row.cwd, row.claude_session_id, effectiveConfigDir)
      if (fallback !== row.jsonl_path) {
        candidates.push({
          source: 'locally-computed(config-dir fallback)',
          path: fallback,
          note: localStatNote(fallback),
        })
      }
    }
  }

  const candidateStr =
    candidates.length > 0
      ? candidates.map((c) => `${c.source} ${c.path} (${c.note})`).join('; ')
      : '(no transcript path could be determined)'
  const detailProvenance =
    adCandidates.length > 0
      ? 'paths+sources reported by agent-director'
      : 'agent-director gave no path detail (pre-b.1ba message shape); paths below are locally computed'

  // --- 4. Classify never-created vs lost via message-archive evidence. ----
  // Reuse b.zak's archive-count helper (message_archive_db, read-only, absent
  // file → null == no evidence). started_at bounds "since spawn".
  const startedAtEpoch = row.started_at ? rfc3339ToEpochSeconds(row.started_at) : null
  // b.av2 SR-7.4: count only the persona's `delivery: all` channels; a zero
  // count is evidence of idleness only when the archive can see all of the
  // persona's traffic (no `mentions` channel, DMs off).
  const scope = personaArchiveEvidenceScope(persona)
  const archiveCount = makeDefaultArchiveCount(config)
  const archivedSinceSpawn =
    startedAtEpoch === null ? null : archiveCount(scope.channelIds, startedAtEpoch, ref)

  if (archivedSinceSpawn !== null && archivedSinceSpawn > 0) {
    // LOST: conversation provably happened since spawn, yet no transcript
    // survives. Real context destroyed — must be operator-visible.
    const detail =
      `${ref} instance=${claudeInstanceId}: resume threw ErrJsonlMissing and the persona is ` +
      `${JSONL_DIAGNOSIS_REUSE_WORDING}, but the message archive holds ${archivedSinceSpawn} message(s) since spawn ` +
      `(started_at=${row.started_at}). Conversation history was LOST. Transcript candidates tried ` +
      `(${detailProvenance}): ${candidateStr}.`
    console.error(`[slack] ErrJsonlMissing diagnostic: ${detail}`)
    // Operator-visible signal — reuse the existing startup-errors mechanism.
    if (isStartup) recordStartupError(JSONL_TRANSCRIPT_LOST_ENTRY_CLASS, detail, describeAgentDirectorFailure(err))
    // And a persona notice so it is not buried in logs, posted once the
    // reuse spawn has brought the persona up.
    const notice =
      `⚠️ CSCB: on restart my conversation transcript could not be found, but the message archive shows ` +
      `${archivedSinceSpawn} message(s) since I started — my conversation memory has been lost and I ` +
      `was ${JSONL_DIAGNOSIS_REUSE_WORDING}. An operator should investigate transcript storage. Paths tried: ${candidateStr}`
    return { verdict: 'lost', notice }
  }

  // Below archivedSinceSpawn is 0 or null. Only an attributable 0 (archive
  // consulted, no activity since spawn in channels that carry all of the
  // persona's traffic) is evidence-based never-created. null means we never got
  // a usable count, and an unattributable 0 proves nothing — both are
  // INCONCLUSIVE, not reassurance.
  if (archivedSinceSpawn === 0 && scope.zeroIsAttributable) {
    // NEVER-CREATED (evidence-based): the archive was consulted and proved zero
    // archived activity since spawn. Claude writes the .jsonl lazily on first
    // message; a persona idle since spawn simply never had one. Expected and
    // lossless — quiet log, no error, no persona notice; counted with the
    // diagnosed amnesia (`fresh-after-amnesia`).
    console.error(
      `[slack] ErrJsonlMissing diagnostic: ${ref} instance=${claudeInstanceId} — transcript never ` +
        `created (archive consulted: 0 archived messages since spawn). Nothing to lose; the persona is ` +
        `${JSONL_DIAGNOSIS_REUSE_WORDING}. Transcript candidates tried (${detailProvenance}): ${candidateStr}.`,
    )
    return { verdict: 'never-created' }
  }

  // INCONCLUSIVE: we could not gather enough evidence to decide loss vs
  // never-created. Determine WHY — the operator needs the actionable cause.
  //   (b) started_at absent/unparseable → could not bound "since spawn".
  //   (c-config) no message_archive_db configured → diagnosis is structurally
  //              impossible; actionable "turn on the archive" hint.
  //   (c-other) archive configured but file-missing / unreadable / query threw.
  //   (d) b.av2 SR-7.4: a 0 count the archive cannot attribute to the persona.
  let reason: string
  if (startedAtEpoch === null) {
    reason =
      `the row's started_at is absent or unparseable (started_at=${row.started_at ?? '(none)'}), ` +
      `so "since spawn" could not be bounded and the archive was not consulted`
  } else if (archivedSinceSpawn === 0) {
    reason = UNATTRIBUTABLE_ZERO_REASON
  } else if (!config.message_archive_db) {
    reason =
      `no message archive is configured (message_archive_db unset), so there is no evidence source to ` +
      `consult — enable the message archive to make transcript-loss diagnosis possible`
  } else {
    reason =
      `the message archive (${config.message_archive_db}) could not be consulted (missing file, ` +
      `unreadable, or the count query failed) — see prior archive-count error line`
  }
  const notice = reportInconclusiveDiagnosis(
    ref,
    claudeInstanceId,
    `${reason}. Transcript candidates tried (${detailProvenance}): ${candidateStr}`,
    isStartup,
    err,
  )
  return { verdict: 'inconclusive', notice }
}

/**
 * b.fwu, b.jg5 SRJ-712: the operator-visible signal for an INCONCLUSIVE
 * `ErrJsonlMissing` diagnosis, one where whether prior history was lost
 * could not be determined. Like the 'lost' verdict, it writes the log line
 * and, at start, the startup-errors entry
 * (`JSONL_DIAGNOSIS_INCONCLUSIVE_ENTRY_CLASS`) now, and answers the persona
 * notice text, which its caller posts once the reuse spawn has brought the
 * persona up. Every text says the persona is brought up fresh by a reuse
 * spawn and its row is kept (`JSONL_DIAGNOSIS_REUSE_WORDING`), and is worded
 * as uncertainty, not loss: a false "your history was destroyed" is its own
 * harm. Never throws.
 */
function reportInconclusiveDiagnosis(
  ref: string,
  claudeInstanceId: string,
  reason: string,
  isStartup: boolean,
  err: AgentDirectorError,
): string {
  const detail =
    `${ref} instance=${claudeInstanceId}: resume threw ErrJsonlMissing and the persona is ` +
    `${JSONL_DIAGNOSIS_REUSE_WORDING}, but diagnosis was INCONCLUSIVE — could not determine whether conversation ` +
    `history was lost because ${reason}.`
  console.error(`[slack] ErrJsonlMissing diagnostic: ${detail}`)
  if (isStartup) recordStartupError(JSONL_DIAGNOSIS_INCONCLUSIVE_ENTRY_CLASS, detail, describeAgentDirectorFailure(err))
  return (
    `⚠️ CSCB: on restart I was ${JSONL_DIAGNOSIS_REUSE_WORDING}; I could not determine whether my prior ` +
    `conversation history was preserved (diagnosis inconclusive: ${reason}). An operator should ` +
    `investigate.`
  )
}

// ---------------------------------------------------------------------------
// The no-transcript step (b.jg5 SRJ-707, SRJ-712)
// ---------------------------------------------------------------------------

/** `resume`'s no-transcript answers, which go on to a reuse spawn of the same id (b.jg5 SRJ-707, SRJ-113, SRJ-705), by name. */
const NO_TRANSCRIPT_RESUME_ERR_NAMES = [ERR_NO_SESSION_ID_NAME, ERR_JSONL_MISSING_NAME, ERR_JSONL_NEVER_WRITTEN_NAME] as const

/**
 * Whether `err` is one of `resume`'s no-transcript answers (`ErrNoSessionId`,
 * `ErrJsonlMissing`, `ErrJsonlNeverWritten`). The answer is decided by name
 * (`hasAdErrorName`); the `instanceof` check only narrows the type.
 */
function isNoTranscriptResumeError(err: unknown): err is AgentDirectorError {
  return err instanceof AgentDirectorError && NO_TRANSCRIPT_RESUME_ERR_NAMES.some((name) => hasAdErrorName(err, name))
}

/** What the no-transcript step is told by its caller. */
interface NoTranscriptReuseOptions {
  /** Whether the launch is part of the start pass (startup-errors entries are written only then). */
  readonly isStartup: boolean
  /** The row state the caller last read before the `resume` (the diagnosis's read replaces it when it makes one). */
  readonly lastRead: LatchRowState
  /** True when the caller ran the pre-launch trust patch in this launch attempt. */
  readonly trustPatchRan: boolean
  /** The store's reading of the key when the launch attempt started, for the reuse (`ReuseSpawnOptions.retiredAtStart`, b.jg5 SRJ-806). */
  readonly retiredAtStart: RetiredKeyAttemptStart | undefined
}

/**
 * The no-transcript step (b.jg5 SRJ-707, SRJ-712, SRJ-113): what follows a
 * `resume` of persona `persona`'s id that answered `ErrNoSessionId`,
 * `ErrJsonlNeverWritten` or `ErrJsonlMissing` (`err`, by name;
 * `isNoTranscriptResumeError`). The collision ladder (`resumeOrFreshSpawn`)
 * and the live-row sequence's launch entry's `resume` leg
 * (`sequenceLaunchCall`) both use it. The row `resume` refused for these
 * reasons is finished, so no live-row sequence is needed first.
 *   - `ErrJsonlMissing`: the lost-transcript diagnosis runs first
 *     (`diagnoseJsonlMissing`), because the reuse spawn resets the row it
 *     reads. Its latched and refused answers end the step with no launch
 *     (b.jg5 SRJ-502, SRJ-105), and are answered as they are.
 *   - Then one reuse spawn of the same id (`reuseSpawnForPersona`), with the
 *     row state last read: the diagnosis's read when it made one, else
 *     `options.lastRead`.
 *   - A `fresh-retired` success (a retired key's, whose mark the reuse set,
 *     b.jg5 SRJ-806) is answered as it is, after any of the three answers
 *     (SRJ-112's success row): no amnesia result, and the diagnosis's
 *     persona notice is not posted, with one line when it had one.
 *   - A `spawned` success answers `fresh-after-amnesia` after
 *     `ErrJsonlMissing` (`fresh-after-inconclusive-amnesia` for an
 *     inconclusive diagnosis), and only then posts the diagnosis's persona
 *     notice, which says the persona was brought up fresh; `spawned` for the
 *     other two answers, which lost no history.
 *   - Every other answer is the reuse spawn's (SRJ-112, `reuseSpawnFailedAt`),
 *     its collided answer included, which each caller handles; the
 *     diagnosis's notice is not posted for it, and a later attempt makes its
 *     own diagnosis.
 * Nothing here deletes, kills or makes a plain spawn. Never throws.
 */
async function noTranscriptReuse(
  persona: Persona,
  config: PersonaConfig,
  err: AgentDirectorError,
  options: NoTranscriptReuseOptions,
): Promise<ReuseSpawnResult> {
  const { key } = persona
  let diagnosis: JsonlDiagnosis | undefined
  // b.jg5 SRJ-501: the diagnosis `get`, when made, is the last read before the reuse.
  const diagnosisRead: { lastRead?: LatchRowState } = {}
  if (hasAdErrorName(err, ERR_JSONL_MISSING_NAME)) {
    const diagnosed = await diagnoseJsonlMissing(persona, config, err, options.isStartup, diagnosisRead)
    if ('action' in diagnosed) return diagnosed
    diagnosis = diagnosed
  }
  const result = await reuseSpawnForPersona(persona, config, {
    isStartup: options.isStartup,
    lastRead: diagnosisRead.lastRead ?? options.lastRead,
    trustPatchRan: options.trustPatchRan,
    retiredAtStart: options.retiredAtStart,
  })
  // b.jg5 SRJ-112's success row: a retired key's success is `fresh-retired`,
  // its mark set by the reuse; the amnesia results are for any other key.
  if (result.action === SPAWN_ACTION_FRESH_RETIRED) {
    if (diagnosis?.notice !== undefined) {
      console.error(
        `[slack] spawnForPersona: ${personaRef(persona)}'s key is retired, so its reuse spawn answered ${SPAWN_ACTION_FRESH_RETIRED} — answering it, not an amnesia result; the lost-transcript diagnosis's persona notice is not posted (b.jg5 SRJ-112, SRJ-806)`,
      )
    }
    return result
  }
  if (diagnosis === undefined || result.action !== 'spawned') return result
  // b.jg5 SRJ-712: the persona is up, so the notice that says so is posted now.
  if (diagnosis.notice !== undefined) sendPersonaNotice(key, diagnosis.notice)
  // b.fwu: amnesia, not a clean spawn, so the start summary counts it apart:
  // 'lost' and 'never-created' are diagnosed, 'inconclusive' is not.
  return {
    key,
    action: diagnosis.verdict === 'inconclusive' ? 'fresh-after-inconclusive-amnesia' : 'fresh-after-amnesia',
  }
}

// ---------------------------------------------------------------------------
// The replace step (b.jg5 SRJ-707, SRJ-112, SRJ-705, SRJ-706)
// ---------------------------------------------------------------------------

/**
 * One run of the collision ladder's get-then-act for a persona
 * (`ladderGetThenAct`), carried by every step that can enter it again: the
 * replace step's reuse collision re-runs it once (b.jg5 SRJ-112), and so
 * does a later plain spawn's collision (SRJ-111, `plainSpawnCollisionAtLadder`).
 */
interface LadderRun {
  readonly persona: Persona
  readonly config: PersonaConfig
  /** Whether the launch is part of the start pass (startup-errors entries are written only then). */
  readonly isStartup: boolean
  readonly ref: string
  /** The plain spawn's parameters (`buildSpawnParams`), for the retry spawn and the spawn after `resume` found no row. */
  readonly params: SpawnParams
  /** The hooks of the `spawnForPersona` call that started the ladder. */
  readonly hooks: LaunchHooks | undefined
  /**
   * True in the one re-run of get-then-act that a reuse collision gives
   * (b.jg5 SRJ-112): a reuse collision there is the second one, which
   * re-runs nothing. A retired key's first launch is a reuse, so the
   * get-then-act its collision enters is that re-run (`retiredKeyFirstLaunch`).
   * Neither the re-run after `reuseFinishedRow`'s collision nor the retired
   * key's first launch's get-then-act carries dead evidence (b.jg5 SRJ-611):
   * a retired key's first launch starts a new life, which no verdict saw.
   */
  readonly reuseCollisionRerun: boolean
  /**
   * True in the one re-run of get-then-act that a plain spawn's collision
   * gives (b.jg5 SRJ-111, SRJ-114): the collision of a plain spawn made inside
   * get-then-act (the retry spawn after the collision `get` found no row, or
   * the spawn after `resume` found none) re-runs it once; a plain spawn's
   * collision there re-runs nothing, arms the retry timer and answers
   * `retrying` (`plainSpawnCollisionAtLadder`). The first spawn's collision
   * enters get-then-act itself, as no re-run. Kept apart from
   * `reuseCollisionRerun`, so each kind of collision gets its own one re-run.
   */
  readonly plainSpawnCollisionRerun: boolean
  /**
   * The escalate-dead verdict the restart path carried into this launch
   * (`spawnForPersona`'s `deadEvidence`, b.jg5 SRJ-611), kept for the run
   * until a read or an answer voids it (dead evidence covers one life,
   * `voidDeadEvidence`): from then on the run carries
   * `CARRIED_DEAD_EVIDENCE_NONE`, as it does when none was carried. The
   * re-runs of get-then-act after a reuse collision (a retired key's first
   * launch's included), after a plain spawn's collision following the
   * collision `get`'s `ErrSpawnNotFound`, and after `resume`'s
   * `ErrSpawnNotFound` carry none.
   */
  readonly carriedDeadEvidence: CarriedDeadEvidence
  /**
   * The installed retired-key store's reading of the key and its record
   * generation at the ladder's launch decision (`retiredKeyAttemptStartOf`,
   * b.jg5 SRJ-806), taken once when the ladder starts and kept for the run:
   * every reuse spawn the ladder makes, and every live-row sequence it
   * starts, compares against it, so a key recorded after the ladder started
   * gets no mark from a reuse the ladder makes under its old declaration.
   */
  readonly retiredAtStart: RetiredKeyAttemptStart
}

/**
 * The dead evidence a ladder path hands `resumeOrFreshSpawn` (b.jg5
 * SRJ-611): the path holds dead evidence when its own cause (`own`) is dead
 * evidence or the verdict the restart path carried in (`carriedIn`) is,
 * within the same recovery attempt. Answers the one that is dead evidence,
 * the path's own first; with neither, the path's own cause, or the carried
 * verdict when the path has none. Evidence covers one life: when the state
 * the path hands on is finished (`ended`, `missing` or no row),
 * `resumeOrFreshSpawn` voids what this answers (`voidDeadEvidence`), and a
 * carried verdict a reconnect's `row-not-interactive` voided is no longer
 * on the run. Pure.
 */
function heldDeadEvidence(own: CarriedDeadEvidence, carriedIn: CarriedDeadEvidence): CarriedDeadEvidence {
  if (isDeadEvidence(own.source)) return own
  if (isDeadEvidence(carriedIn.source)) return carriedIn
  return own.source === DEAD_EVIDENCE_NONE ? carriedIn : own
}

/** A ladder run and the dead evidence its path holds, as `voidDeadEvidence` answers them. */
interface HeldDeadEvidence {
  readonly run: LadderRun
  readonly deadEvidence: CarriedDeadEvidence
}

/**
 * Void the dead evidence a collision ladder path holds (b.jg5 SRJ-611, dead
 * evidence covers one life): `held` is the evidence the path hands on (its
 * own cause or the carried verdict, `heldDeadEvidence`), and
 * `run.carriedDeadEvidence` the verdict the restart path carried in. Each of
 * them that is dead evidence is void for the rest of the attempt: one line
 * for each (`deadEvidenceVoidedLine`, naming `voidedBy`, the read or the
 * answer that voided it), and the answer holds none of it: `deadEvidence`
 * `CARRIED_DEAD_EVIDENCE_NONE`, and the run with `carriedDeadEvidence`
 * `CARRIED_DEAD_EVIDENCE_NONE`, so every later step of the attempt, a re-run
 * of get-then-act included, holds none. Evidence that is not dead evidence
 * is answered as it is, with no line. Never throws.
 */
function voidDeadEvidence(run: LadderRun, held: CarriedDeadEvidence, voidedBy: string): HeldDeadEvidence {
  const carried = run.carriedDeadEvidence
  const heldVoided = isDeadEvidence(held.source)
  const carriedVoided = isDeadEvidence(carried.source)
  if (!heldVoided && !carriedVoided) return { run, deadEvidence: held }
  if (heldVoided) console.error(deadEvidenceVoidedLine(run.ref, held, voidedBy))
  if (carriedVoided && !(heldVoided && carried.source === held.source)) {
    console.error(deadEvidenceVoidedLine(run.ref, carried, voidedBy))
  }
  return {
    run: carriedVoided ? { ...run, carriedDeadEvidence: CARRIED_DEAD_EVIDENCE_NONE } : run,
    deadEvidence: heldVoided ? CARRIED_DEAD_EVIDENCE_NONE : held,
  }
}

/**
 * The row state a dead-session route hands `resumeOrFreshSpawn` as the
 * state last read (b.jg5 SRJ-501, SRJ-611): a cause that is a row read
 * passes what it read, no row for `row-absent` and the state read for
 * `row-read-finished` (`finishedState`), never the earlier live read; any
 * other cause passes `liveRead`, the route's own last read.
 */
function deadSessionLastRead(cause: DeadSessionCause, finishedState: string | undefined, liveRead: LatchRowState): LatchRowState {
  if (cause === DEAD_SESSION_CAUSE_ROW_ABSENT) return LATCH_ROW_STATE_NO_ROW
  if (cause === DEAD_SESSION_CAUSE_ROW_READ_FINISHED && finishedState !== undefined) return latchRowStateRead(finishedState)
  return liveRead
}

/**
 * A dead-session route of the collision ladder's `waiting` or `working`
 * branch (b.3ce; b.jg5 SRJ-611) for persona `run.persona`'s row read
 * `state`: one line naming the route's own `cause` and whether the path
 * holds dead evidence (`deadSessionRouteLine`), then resume/fresh-spawn with
 * the find-missing run before its `resume` (`reconcileMissingFirst`), on
 * every such route and for every cause, dead evidence or not. It hands on
 * the state its cause last read (`deadSessionLastRead`; `liveRead` for a
 * cause that is no row read) and the dead evidence the path holds
 * (`heldDeadEvidence`). Dead evidence covers one life (b.jg5 SRJ-611): a
 * cause that read the row finished or gone (`row-read-finished`,
 * `row-absent`) hands on a finished state, so `resumeOrFreshSpawn` voids the
 * evidence the path holds; and a reconnect that answered
 * `row-not-interactive` voids the verdict the restart path carried in here,
 * before the call, whatever route carried it (`voidDeadEvidence`; HO §2
 * mapping row 20). The route's line says what the path then holds. Adds no
 * kill, delete or launch of its own.
 */
function deadSessionRoute(
  run: LadderRun,
  row: Pick<GetResult, 'cwd' | 'labels'>,
  state: string,
  cause: DeadSessionCause,
  finishedState: string | undefined,
  liveRead: LatchRowState,
): Promise<SpawnPersonaResult> {
  const own = carriedDeadEvidenceOf(cause)
  const lastRead = deadSessionLastRead(cause, finishedState, liveRead)
  const lastReadBy = cause === DEAD_SESSION_CAUSE_ROW_ABSENT || cause === DEAD_SESSION_CAUSE_ROW_READ_FINISHED
    ? deadEvidenceReadByCause(cause)
    : DEAD_EVIDENCE_READ_BY_PATH
  const notInteractive = cause === DEAD_SESSION_CAUSE_ROW_NOT_INTERACTIVE && isDeadEvidence(run.carriedDeadEvidence.source)
  const voidedBy = notInteractive
    ? DEAD_EVIDENCE_VOIDED_BY_ROW_NOT_INTERACTIVE
    : lastReadIsFinished(lastRead)
      ? deadEvidenceVoidingRead(lastReadBy, lastRead)
      : undefined
  console.error(deadSessionRouteLine(run.ref, state, own, run.carriedDeadEvidence, voidedBy))
  // b.jg5 SRJ-611: `row-not-interactive` voids the carried verdict for the
  // rest of the attempt; the route's own cause is no dead evidence either.
  const routed = notInteractive ? voidDeadEvidence(run, CARRIED_DEAD_EVIDENCE_NONE, DEAD_EVIDENCE_VOIDED_BY_ROW_NOT_INTERACTIVE).run : run
  return resumeOrFreshSpawn(routed, row, {
    reconcileMissingFirst: true,
    lastRead,
    lastReadBy,
    deadEvidence: heldDeadEvidence(own, routed.carriedDeadEvidence),
  })
}

/**
 * Whether the row state a ladder site last read is finished for the replace
 * step: `ended`, `missing` or no row. Every other state is live, `pending`
 * and an unreadable state included (b.jg5 SRJ-707, SRJ-705).
 */
function lastReadIsFinished(lastRead: LatchRowState): boolean {
  if (lastRead.kind === LATCH_ROW_STATE_KIND_NO_ROW) return true
  return lastRead.kind === LATCH_ROW_STATE_KIND_READ && AGENT_DIRECTOR_DEAD_STATES.has(lastRead.state)
}

/** The live-row sequence's seed state for a live row last read as `lastRead` (an unreadable state is seeded as such, a live state CSCB does not know). */
function sequenceSeedState(lastRead: LatchRowState): string {
  return lastRead.kind === LATCH_ROW_STATE_KIND_READ ? lastRead.state : LATCH_ROW_STATE_KIND_UNREADABLE
}

/**
 * The collision ladder's answer to the start entry's answer `startAnswer`:
 * `held` for a persona held on `ErrInvalidFlags` (b.jg5 SRJ-207),
 * `sequence-waiting` for any other (SRJ-706).
 */
function sequenceStartAction(startAnswer: string): 'held' | 'sequence-waiting' {
  return startAnswer === LIVE_ROW_START_HELD ? 'held' : 'sequence-waiting'
}

/**
 * What held back a `sequence-waiting` answered for the start entry's answer
 * `startAnswer` on `instanceId` (b.jg5 SRJ-811): an old-life wait running on
 * the id (the start entry armed the persona's timer), else a live-row
 * sequence. Never throws.
 */
function sequenceStartWaitingCause(startAnswer: string, instanceId: string): SequenceWaitingCause {
  return startAnswer === LIVE_ROW_START_ALREADY_RUNNING && liveRowSequenceRegistry?.isNoLaunchRunning(instanceId) === true
    ? SEQUENCE_WAITING_CAUSE_OLD_LIFE_HOLD
    : SEQUENCE_WAITING_CAUSE_LIVE_ROW_SEQUENCE
}

/**
 * One start of the live-row sequence (SRJ-705) for a collision ladder site's
 * live row of persona `run.persona`, through the start entry
 * (`startLiveRowSequence`): seeded with `lastRead`, entry at step 1, the
 * conversation kept when `keepsConversation`, the request's retired-key flag
 * `retiredKey` (the start entry sets it anyway while the key is recorded,
 * b.jg5 SRJ-805), the ladder's retired-key reading at its start
 * (`run.retiredAtStart`, SRJ-806; absent for the pending-row step's
 * read-and-step entry, which holds no ladder, so the start entry reads the
 * store then), ending in a launch, alert context `recovery`. Answers the
 * start entry's answer and the ladder's action for it
 * (`sequenceStartAction`). Never throws.
 */
function startRecoverySequence(
  run: Pick<LadderRun, 'persona' | 'ref'> & { readonly retiredAtStart?: RetiredKeyAttemptStart },
  lastRead: LatchRowState,
  keepsConversation: boolean,
  retiredKey: boolean,
): { startAnswer: LiveRowSequenceStartEntryAnswer; action: 'held' | 'sequence-waiting'; result: SpawnPersonaResult } {
  const { persona, ref } = run
  const { key } = persona
  const startAnswer = startLiveRowSequence({
    key,
    ref,
    instanceId: personaInstanceId(key),
    lastReadState: sequenceSeedState(lastRead),
    entryStep: LIVE_ROW_SEQUENCE_ENTRY_KILL,
    keepsConversation,
    retiredKey,
    retiredAtStart: run.retiredAtStart,
    launches: true,
    alertContext: KILL_FAILURE_CONTEXT_RECOVERY,
  })
  const action = sequenceStartAction(startAnswer)
  const result: SpawnPersonaResult =
    action === 'sequence-waiting' && sequenceStartWaitingCause(startAnswer, personaInstanceId(key)) === SEQUENCE_WAITING_CAUSE_OLD_LIFE_HOLD
      ? { key, action, sequenceWaitingCause: SEQUENCE_WAITING_CAUSE_OLD_LIFE_HOLD }
      : { key, action }
  return { startAnswer, action, result }
}

/**
 * The replace step (b.jg5 SRJ-707, SRJ-1503, SRJ-1504, SRJ-805): replace
 * persona P's row `cscb_<key>` at a collision ladder site whose row cannot be
 * kept (`replacing` says why: `resume_enabled` false, a `cwd` mismatch, a
 * `config_dir` label missing or different, a retired key's old life or
 * finished row), deciding on `lastRead`, the row state the site last read:
 *   - finished (`ended`, `missing` or no row): one reuse spawn of the same id
 *     (`reuseSpawnForPersona`, SRJ-112), through the finished-row branch
 *     (`reuseFinishedRow`), whose collision re-runs get-then-act once; with
 *     no row it is an ordinary fresh spawn, and for a retired key its
 *     success sets the "new life has begun" mark (SRJ-806);
 *   - live (every other state, `pending` and an unreadable state included):
 *     the live-row sequence (SRJ-705), started through the start entry
 *     (`startLiveRowSequence`) with the state last read as its seed, entry
 *     at step 1, the conversation not kept, the request's retired-key flag
 *     `retiredKey` (when not given, whether the installed store has the key
 *     recorded now, `retiredKeyReadingOf`; SRJ-805), ending in a launch,
 *     alert context `recovery`; the sequence decides its step-6
 *     launch itself, a reuse spawn of the same id for each of these reasons.
 *     No other call is made, and the answer is `sequence-waiting` whatever
 *     the start entry answers (`started`, `already-running`, `closed`,
 *     `not-installed`), each with its own line from the start entry or the
 *     registry, except `held` (the persona is held on `ErrInvalidFlags`,
 *     b.jg5 SRJ-207), which answers `held`; nothing is counted (SRJ-706,
 *     SRJ-1015).
 * The step never deletes, never kills and never launches over a live row.
 * `resumeOrFreshSpawn`'s replacements reach it through
 * `replaceAtResumeSite`, so a dead-session path's earlier live read starts
 * the sequence here only when that path holds dead evidence (b.jg5 SRJ-609,
 * SRJ-611). Never throws.
 */
async function replacePersonaRow(
  run: LadderRun,
  lastRead: LatchRowState,
  replacing: string,
  retiredKey?: boolean,
): Promise<SpawnPersonaResult> {
  const { persona, config, isStartup, ref } = run
  const { key } = persona
  if (lastReadIsFinished(lastRead)) {
    console.error(
      `[slack] spawnForPersona: replacing the row of ${ref} (${replacing}; last read ${describeLatchRowState(lastRead)}): a reuse spawn of the same id; nothing is deleted (b.jg5 SRJ-707)`,
    )
    return reuseFinishedRow(run, REUSE_SPAWN_WHAT, () =>
      reuseSpawnForPersona(persona, config, { isStartup, lastRead, trustPatchRan: true, retiredAtStart: run.retiredAtStart }),
    )
  }
  const retired = retiredKey ?? retiredKeyReadingOf(key).recorded
  const { startAnswer, action, result } = startRecoverySequence(run, lastRead, false, retired)
  console.error(
    `[slack] spawnForPersona: replacing the row of ${ref} (${replacing}; last read ${describeLatchRowState(lastRead)}): a live row goes through the live-row sequence first${retired ? ' (its key is retired)' : ''}, which ends in a reuse spawn of the same id; start answered ${startAnswer} — answering ${action}; no other call, nothing counted (b.jg5 SRJ-707, SRJ-705, SRJ-706${retired ? ', SRJ-805' : ''})`,
  )
  return result
}

/**
 * The replace step's finished-row branch (b.jg5 SRJ-707, SRJ-112): `reuse`
 * makes the one reuse spawn of persona `run.persona`'s id (the replace
 * step's, or the no-transcript step's after a `resume`, `noTranscriptReuse`;
 * `what` names it in the lines), and its answer is the result, except a
 * collision (`ErrInstanceIdCollision`: the row turned live), which launched
 * nothing:
 *   - the first collision re-runs get-then-act once (`ladderGetThenAct`,
 *     marked as the re-run): its collision `get` reads the row and its
 *     branches decide again. The re-run carries no dead evidence, whichever
 *     caller made the reuse (b.jg5 SRJ-611, dead evidence covers one life):
 *     a verdict the restart path carried in is void, with its line
 *     (`voidDeadEvidence`), and only a GONE the re-run meets on the life it
 *     reads is evidence there;
 *   - a collision in that re-run (any second collision) makes no further
 *     call, arms the persona's retry timer with the reuse-collision cause
 *     (`reportReuseCollisionAtSite`, so the attempt records it) and answers
 *     `retrying` (b.jg5 SRJ-1015): no notice, no `spawn-failed` entry,
 *     nothing counted (SRJ-112, SRJ-301).
 * Never throws.
 */
async function reuseFinishedRow(
  run: LadderRun,
  what: string,
  reuse: () => Promise<ReuseSpawnResult>,
): Promise<SpawnPersonaResult> {
  const { key } = run.persona
  const { ref } = run
  const reused = await reuse()
  if (!isReuseSpawnCollided(reused)) return reused
  if (!run.reuseCollisionRerun) {
    console.error(
      `[slack] spawnForPersona: the ${what} of ${ref} collided with a live row — nothing launched; re-running get-then-act once (b.jg5 SRJ-112)`,
    )
    // b.jg5 SRJ-611: the re-run carries no dead evidence; a GONE it meets on
    // the life its collision `get` reads is its own.
    const voided = voidDeadEvidence(run, CARRIED_DEAD_EVIDENCE_NONE, DEAD_EVIDENCE_VOIDED_BY_REUSE_COLLISION_RERUN)
    return ladderGetThenAct({ ...voided.run, reuseCollisionRerun: true })
  }
  // b.jg5 SRJ-112, SRJ-301: a second collision; P is re-evaluated at its
  // next tick or retry, so its retry timer is armed with the reuse-collision cause.
  const armed = reportReuseCollisionAtSite(key)
  console.error(
    `[slack] spawnForPersona: the ${what} of ${ref} collided with a live row again, in the re-run of get-then-act — nothing launched; answering retrying, no spawn-failure notice, nothing counted; the retry timer ${armed ? 'is armed' : 'could not be armed'} (cause=${UNAVAILABLE_RETRY_CAUSE_REUSE_COLLISION}; b.jg5 SRJ-112, SRJ-1015)`,
  )
  return { key, action: SPAWN_ACTION_RETRYING }
}

/**
 * The line of a plain spawn's collision inside the collision ladder's
 * get-then-act (b.jg5 SRJ-111, SRJ-114, SRJ-713), for the spawn `what` of
 * persona `ref`: with `rerun` the collision re-runs get-then-act once;
 * otherwise it met the one re-run already, and the retry timer was armed
 * (`armed`) or could not be.
 */
export function plainSpawnCollisionLine(what: string, ref: string, rerun: boolean, armed: boolean): string {
  const outcome = rerun
    ? 're-running get-then-act once'
    : `this is the re-run of get-then-act it gave — answering retrying; the retry timer ${armed ? 'is armed' : 'could not be armed'} (cause=${UNAVAILABLE_RETRY_CAUSE_REUSE_COLLISION})`
  return `[slack] spawnForPersona: the ${what} of ${ref} collided with a live row — nothing launched, no spawn-failure notice, nothing counted; ${outcome} (b.jg5 SRJ-111, SRJ-114, SRJ-713)`
}

/**
 * The collision row of a plain spawn made inside the collision ladder's
 * get-then-act (b.jg5 SRJ-111, SRJ-114, SRJ-713): the retry spawn after the
 * collision `get` answered `ErrSpawnNotFound`, or the spawn after `resume`'s
 * `ErrSpawnNotFound` (`resumeOrFreshSpawn`). The row turned live since the
 * read that found none, so nothing was launched:
 *   - the first such collision in the attempt re-runs get-then-act once
 *     (`ladderGetThenAct`, marked as that re-run,
 *     `run.plainSpawnCollisionRerun`): its collision `get` reads the row and
 *     its branches decide again;
 *   - a plain spawn's collision in that re-run makes no further call, arms
 *     the persona's retry timer with the collision cause, as a reuse spawn's
 *     second collision does (`reportReuseCollisionAtSite`, so the attempt
 *     records it), and answers `retrying` (b.jg5 SRJ-1015).
 * One line either way (`plainSpawnCollisionLine`). Never the spawn-failure
 * notice and never counted. Both callers read the row gone before the spawn
 * (the collision `get`'s or `resume`'s `ErrSpawnNotFound`), which voided the
 * path's dead evidence, so `run` and the re-run carry none (b.jg5 SRJ-611).
 * Never throws.
 */
function plainSpawnCollisionAtLadder(run: LadderRun, what: string): Promise<SpawnPersonaResult> {
  const { key } = run.persona
  if (!run.plainSpawnCollisionRerun) {
    console.error(plainSpawnCollisionLine(what, run.ref, true, false))
    return ladderGetThenAct({ ...run, plainSpawnCollisionRerun: true })
  }
  const armed = reportReuseCollisionAtSite(key)
  console.error(plainSpawnCollisionLine(what, run.ref, false, armed))
  return Promise.resolve({ key, action: SPAWN_ACTION_RETRYING })
}

/**
 * Recover a collided spawn whose live session cannot be reached: resume-first
 * (preserves session history) when resume_enabled. The `resume` and its
 * outcomes follow b.jg5 SRJ-113's table through the one `resume` outcome
 * handler that both `resume` sites use (`resumeAtSite`; the other site is
 * the live-row sequence's launch entry, `launchForLiveRowSequence`), each
 * outcome decided by name or class (`src/ad-error-class.ts`), row by row:
 *   - success: `resumed`, then the after-launch step (`afterLaunchSucceeded`);
 *   - ErrNoSessionId / ErrJsonlMissing / ErrJsonlNeverWritten → the
 *     no-transcript step (`noTranscriptReuse`, b.jg5 SRJ-707, SRJ-712):
 *     after ErrJsonlMissing the lost-transcript diagnosis, then one reuse
 *     spawn of the same id through the replace step's finished-row branch
 *     (`reuseFinishedRow`), with nothing deleted;
 *   - ErrSpawnNotResumable → the not-resumable step (below; SRJ-710);
 *   - ErrSpawnNotFound → one plain spawn of `cscb_<key>` from
 *     `buildSpawnParams` (no reuse flag, b.jg5 SRJ-711), which makes
 *     agent-director's pre-spawn scan (SRJ-111; HO rev 15), with no
 *     spawn-failure notice for the ErrSpawnNotFound itself; the spawn takes
 *     SRJ-111's whole table through the one plain-spawn outcome handler
 *     (`plainSpawnOutcomeAt`): its collision re-runs get-then-act once
 *     (`plainSpawnCollisionAtLadder`), its CONFLICT latches with the refused
 *     operation "plain spawn", its `ErrTmuxSessionCreate` is counted;
 *   - every other outcome → `resumeFailedAt`: a CONFLICT latches (below),
 *     never a kill; UNAVAILABLE (the launch-timeout forms included) and
 *     ENVIRONMENT take the refusal rows, and nothing assumes the row was
 *     restored, since a failed `resume`'s restore is conditional (HO rev 28);
 *     an UNAVAILABLE outcome is followed by one `get`, whose row decides
 *     with no launch in the attempt (`afterLaunchUnavailable`, b.jg5
 *     SRJ-407); an `ErrTmuxSessionCreate` is one
 *     counted launch failure that kills nothing, makes no spawn in its place
 *     and arms the persona's retry timer at once in pending-only mode, so
 *     that the retry's read of the row decides (SRJ-409; HO rev 28); the
 *     DIRECTORY errors give `cwd-unreachable` (raised by the wrapper),
 *     counted; ErrInvalidFlags takes the version re-check, then
 *     UNCLASSIFIED (below); UNUSABLE NAME, CONFIG and UNCLASSIFIED are
 *     SRJ-105's; a collision arms the collision cause and answers
 *     `retrying`, never the spawn-failure notice (`resumeCollisionAt`,
 *     SRJ-713).
 * These two are the handler's only sites: a refused `resume` is not retried
 * anywhere else.
 *
 * `opts.lastRead` is the row state the caller last read, which the replace
 * step decides on (b.jg5 SRJ-707): the `ended`/`missing` branch's collision
 * `get` (a finished row); a dead-session path's (`reconcileMissingFirst`)
 * collision `get` or working-row wait's last read, a live row unless its
 * cause is a row read (no row for `row-absent`, the state read for
 * `row-read-finished`, `deadSessionLastRead`); the prompt-row recovery's
 * re-read, which read it finished.
 *
 * `opts.deadEvidence` is the dead evidence the path holds (b.jg5 SRJ-611,
 * `heldDeadEvidence`): its own `dead-session` cause, or the escalate-dead
 * verdict the restart path carried in, whichever is dead evidence;
 * `CARRIED_DEAD_EVIDENCE_NONE` when not given. Only a GONE-based cause or
 * verdict is dead evidence; `row-not-interactive` and the row reads never
 * are. The not-resumable step and the replacements decide on it, and their
 * lines name it.
 *
 * Dead evidence covers one life (b.jg5 SRJ-611): once the path has read
 * the row `ended`, `missing` or gone, the evidence it holds, its own or
 * carried in, is void for the rest of the attempt (`voidDeadEvidence`: one
 * line per voided piece, `deadEvidenceVoidedLine`, and the run carries none
 * into any re-run of get-then-act). This gate voids it when:
 *   - `opts.lastRead` is finished (`ended`, `missing` or no row; the read is
 *     named by `opts.lastReadBy`): the collision `get`'s `ended`/`missing`
 *     branch, a dead-session route whose cause is a row read (`row-absent`,
 *     `row-read-finished`), the prompt-row action's re-read;
 *   - with `reconcileMissingFirst`, the `get` SRJ-120 makes of P's own row
 *     after the path's own find-missing run reads it `ended`, `missing` or
 *     gone, before the `resume` (the run's listing itself voids nothing);
 *     that read also becomes the path's state last read, which the latch
 *     state and the replacement steps below use;
 *   - `resume` answers `ErrSpawnNotFound` (SRJ-113): the plain spawn after
 *     it, and any get-then-act its collision runs, hold none.
 * Evidence that is not dead evidence passes through as it is. With the
 * evidence voided, `ErrSpawnNotResumable` followed by a re-read in a live
 * state other than `pending` is the lost race, and a replacement decides on
 * the state last read as for a path with no evidence. A GONE the path meets
 * after the read, on the life it then reads live, is new evidence of that
 * life, and is kept.
 *
 * The no-transcript step's reuse spawn has SRJ-112's outcomes
 * (`reuseSpawnFailedAt`); its collision (`ErrInstanceIdCollision`: the row
 * is live again) takes the finished-row branch's one get-then-act re-run,
 * and a second collision arms the reuse-collision cause and answers
 * `retrying`, uncounted (`reuseFinishedRow`).
 * This is the `ended`/`missing` state handling, extracted so the
 * b.3ce dead-session fallback in the `waiting`/`working` branches reuses the
 * exact same decision logic instead of inventing its own.
 *
 * A retired key (b.jg5 SRJ-805): while the installed retired-key store has
 * the key recorded, marked or not (`retiredKeyReadingOf`), this never calls
 * `resume`, on every path into it: the ladder's finished branch, the
 * dead-session routes from `waiting` and from `working`, and the prompt-row
 * recovery's finished re-read (`launchOnPromptRow`, SRJ-607). The
 * reconcile-missing-first sweep and the unresolvable-directory deferral
 * come first, as for any key; then the store is read again (a key recorded
 * during the sweep's await included) and, for a recorded key, in place of
 * the `resume_enabled`, the `config_dir` and the `resume` steps, one reuse
 * spawn of the same id is made first, whatever row the path last read
 * (`retiredKeyAtResumeSite`): a finished row or no row gets its new life
 * (`fresh-retired`, the mark set, SRJ-806); a live row makes it collide,
 * and the re-run of get-then-act reads the row, sending an old life (no
 * mark) through the live-row sequence with the retired-key flag and
 * handling a new life (mark set) as any live row. A key that is not
 * recorded takes the `resume_enabled`, `config_dir` and `resume` steps
 * below (SRJ-711); the read made before the sweep decides only the
 * `resume_enabled` false step, which a key not recorded then takes at once.
 *
 * `resume_enabled: false` (b.jg5 SRJ-707): the row is not resumed; it is
 * replaced through the resume site's replacement (`replaceAtResumeSite`),
 * nothing deleted: a row last read finished gets a reuse spawn of the same
 * id; a row last read live goes through the live-row sequence first only
 * when the path holds dead evidence, and is otherwise read again first, the
 * fresh state deciding (b.jg5 SRJ-609, SRJ-611).
 *
 * b.av2 SR-6.2 `config_dir` guard, as amended (b.jg5 SRJ-1504): before the
 * `resume` call (after the reconcile-missing-first sweep), the row's
 * `config_dir` label — captured by the collision `get` when the ladder
 * started — is compared with the persona's current effective
 * claude_config_dir through `compareRowToPersona`. On a mismatch or a
 * missing label it does not resume, because agent-director's `ResumeParams`
 * carries only the instance ID and a resume keeps the old
 * `CLAUDE_CONFIG_DIR`: the row is replaced as for `resume_enabled: false`
 * (`replaceAtResumeSite`), by a reuse spawn of the same id (a new life),
 * after the live-row sequence for a live row; no row is deleted. The old
 * history stays in the old directory, archived to the earlier life. No
 * transcript was lost, so no JSONL diagnosis or amnesia action runs. A
 * directory that cannot be resolved keeps the row and answers `deferred`
 * with no call (bug b.g57).
 *
 * b.jg5 SRJ-710: `ErrSpawnNotResumable` is never by itself a reason to kill
 * and replace, and it is no reuse site. The not-resumable step
 * (`spawnNotResumableAtLadder`) re-reads the row once through the shared
 * own-row read (`notResumableStep`, so a `provenance_conflict` note
 * latches, SRJ-114) and decides on the re-read (`decideNotResumable`):
 *   - the read latched the persona: `latched`, nothing more called;
 *   - `pending`, a launch in progress: nothing counted or posted, and no
 *     live-row sequence of its own, whatever evidence the path holds; the
 *     row goes to the ladder's `pending` step (`ladderPendingRowStep`),
 *     whose answer is the result: a covered row is left (`no-op`, the
 *     persona's retry timer armed in pending-only mode), with no
 *     kill and no launch, and a row that is not covered gets SRJ-411's
 *     sequence through the replace step;
 *   - another known live state (`AGENT_DIRECTOR_LIVE_STATES`), on a path
 *     that holds dead evidence: one live-row
 *     sequence with the conversation kept (alert context `recovery`), which
 *     ends in `resume` when the row has a session id and the persona may
 *     resume it, and the answer `sequence-waiting` (SRJ-705, SRJ-706);
 *   - another live state with no dead evidence, a state CSCB does not know
 *     (whatever evidence the path holds), `ended`, `missing`, no row, or a
 *     read refused by the shared read's own error rows (its read-error cause
 *     armed): the lost race. Nothing is killed, deleted or launched,
 *     nothing is counted or posted, the persona's retry timer is armed with
 *     the lost-race cause (`reportLostRaceAtSite`,
 *     `UNAVAILABLE_RETRY_CAUSE_LOST_RACE`), and the answer is `retrying`,
 *     uncounted (b.jg5 SRJ-1015), so the persona is re-evaluated at its
 *     next tick or retry.
 *
 * b.jg5 SRJ-104: a `resume` that answers `ErrInvalidFlags` goes through the
 * `ErrInvalidFlags` step (`classifyWithInvalidFlagsRecheck`): one immediate
 * version re-check (a stop it decides ends the process, SRJ-205), class
 * UNCLASSIFIED, and one log line built from the classification's rendered
 * fields. Nothing is deleted, killed or launched because of it, and the
 * persona is never held (the hold is a reuse spawn's only). When the
 * re-check decides the stop, nothing is posted and the `failed` result is
 * marked `stopping`, which the restart path does not count; after any other
 * re-check answer it takes SRJ-105's UNCLASSIFIED row (SRJ-313): the outage
 * state's site entry (`reportUnclassifiedAtSite`) arms the persona's retry
 * timer with the UNCLASSIFIED cause and reports it to the persona's
 * unclassified-error episode, one refusal line is logged, no spawn-failure
 * notice is posted, and the `failed` result is never counted; the launch
 * answers it as `retrying` when the timer was armed (`retryingWhenArmed`).
 *
 * Every other UNCLASSIFIED outcome here (SRJ-113, SRJ-111: "No step
 * follows"), `ErrSystemInstallDisappeared` included, is a refusal through
 * `refusalAt`, at the resume and at each spawn after it.
 *
 * b.jg5 SRJ-501, SRJ-113, SRJ-111: a CONFLICT at the resume, or at any
 * spawn after it, latches the persona (`conflictAt`), with the refused
 * operation "resume" (whatever its case: "this row's own id", "left over
 * from an earlier life", "no valid instance id", "a different instance id",
 * "another agent-director store", or "conflicting labels", which a stray
 * `@ad_owner` value or a duplicate label gives after "duplicate session"
 * too), "plain spawn" or, at a reuse spawn, "reuse spawn", and the row state
 * the path last read before that call: `opts.lastRead` (the caller's last
 * read: the collision `get`'s state, the working-row wait's last `status`,
 * or the prompt row's re-read) unless SRJ-120's post-run `get` read the row
 * finished, which then replaces it, or, for the reuse after `ErrJsonlMissing`,
 * what its diagnosis `get` read. It answers `latched`: nothing is killed,
 * deleted or launched after it. An UNUSABLE NAME answer at the resume or at
 * any spawn after it latches the persona the same way, with the refused
 * operation "none" (b.jg5 SRJ-512, `unusableNameAt`).
 *
 * b.jg5 SRJ-120, SRJ-502: with `reconcileMissingFirst`, a persona latched
 * once the findMissing sweep is done (a post-run `get` of its own row read
 * the latching note, or the latch answers it latched) answers `latched` with
 * one line and no `resume`, sequence or spawn.
 *
 * @param row  The row returned by the collision `get` (its `labels`).
 */
async function resumeOrFreshSpawn(
  runIn: LadderRun,
  row: Pick<GetResult, 'cwd' | 'labels'>,
  opts: { reconcileMissingFirst?: boolean; lastRead: LatchRowState; lastReadBy?: string; deadEvidence?: CarriedDeadEvidence },
): Promise<SpawnPersonaResult> {
  const { persona, params, config, isStartup, ref } = runIn
  const { key } = persona
  let { lastRead } = opts
  // b.jg5 SRJ-611: dead evidence covers one life. A path whose state last
  // read is finished (`ended`, `missing` or no row) holds none from here on,
  // its own or carried in: one line per voided piece, and the run carries
  // none into any re-run of get-then-act.
  let { run, deadEvidence } = lastReadIsFinished(lastRead)
    ? voidDeadEvidence(runIn, opts.deadEvidence ?? CARRIED_DEAD_EVIDENCE_NONE, deadEvidenceVoidingRead(opts.lastReadBy ?? DEAD_EVIDENCE_READ_BY_PATH, lastRead))
    : { run: runIn, deadEvidence: opts.deadEvidence ?? CARRIED_DEAD_EVIDENCE_NONE }
  // b.jg5 SRJ-805: a retired key is never resumed; its rule runs below,
  // after the sweep and the unresolvable-directory deferral, on a reading
  // taken there. This reading decides only the `resume_enabled` false step.
  if (config.resume_enabled === false && !retiredKeyReadingOf(key).recorded) {
    return resumeDisabledAtResumeSite(run, lastRead, deadEvidence)
  }

  // b.4dk: dead-session callers (state=waiting/working, whatever the
  // verdict's cause) arrive with a LIVE-state AD row. AD's resume verb
  // requires a terminal row (ended/missing) — otherwise ErrSpawnNotResumable.
  // Run findMissing first so AD's per-row, evidence-based sweep
  // (agent-director plan b.93m, t1.93m.hp: degraded-mode guard removed) can
  // move a row whose process is gone to `missing`, letting resume succeed and
  // preserve session history. It runs on every such path, for every cause,
  // dead evidence or not (b.jg5 SRJ-611); only the evidence the path carries
  // differs. The ended/missing caller does NOT set reconcileMissingFirst (row
  // already terminal). A refused sweep (b.jg5 SRJ-105: UNAVAILABLE, e.g.
  // ErrCallTimeout, ENVIRONMENT, ErrTmuxNotAvailable, CONFIG,
  // ErrConfigMalformed, SRJ-316, or UNCLASSIFIED, SRJ-313), or a refused
  // post-run `get` of the persona's own row (SRJ-114), stops the attempt
  // before the resume: a resume of the still-live row would answer
  // ErrSpawnNotResumable. The ladder answers failed, which the launch
  // answers as `retrying` (`retryingWhenArmed`). On any other findMissing error, fall through to attempting
  // resume anyway (an ErrSpawnNotResumable then takes the not-resumable
  // step). Prefer AD's findMissing verb over CSCB-side tmux probing per
  // docs/engineering-guide.md ("Avoiding Duplicated Effort").
  if (opts.reconcileMissingFirst) {
    const postSweep: { ownRowRead?: LatchRowState } = {}
    const sweep = await reconcileMissingSweep(key, 'spawnForPersona: before resume', ref, {
      onOwnRowRead: (read) => {
        postSweep.ownRowRead = read
      },
    })
    if (sweep === FIND_MISSING_REFUSED) return { key, action: 'failed' }
    if (sweep === FIND_MISSING_LATCHED) {
      // b.jg5 SRJ-120, SRJ-502: the persona latched during the sweep (a
      // post-run `get` of its row read the latching note, or the latch
      // answers it latched): no resume, sequence or spawn follows.
      console.error(
        `[slack] spawnForPersona: ${ref} is latched after the findMissing sweep before resume — not resuming; nothing more is called for it (b.jg5 SRJ-502)`,
      )
      return { key, action: 'latched' }
    }
    // b.jg5 SRJ-120, SRJ-611: the post-run `get` of P's own row (made only
    // for a row the run left in `unverified_ids`, never on a memo hit) is a
    // read of the row: finished or gone, it voids the path's dead evidence
    // before the `resume`, and it becomes the path's last read, so the latch
    // state and the replacement step below act on it, not on the earlier
    // live read. The run's own listing voids nothing.
    const { ownRowRead } = postSweep
    if (ownRowRead !== undefined && lastReadIsFinished(ownRowRead)) {
      const voided = voidDeadEvidence(run, deadEvidence, deadEvidenceVoidingRead(DEAD_EVIDENCE_READ_BY_POST_SWEEP_GET, ownRowRead))
      run = voided.run
      deadEvidence = voided.deadEvidence
      lastRead = ownRowRead
    }
  }

  // b.av2 SR-6.2 (b.jg5 SRJ-1504): a resume keeps the row's old
  // CLAUDE_CONFIG_DIR, so resume only a row labelled with the persona's
  // current effective config dir.
  const configDir = compareRowToPersona(row, persona, spawnHomeDir(), undefined, _configDirFs)
  if (!configDir.configDirResolved) return deferForUnresolvedConfigDir(persona, ref)
  // b.jg5 SRJ-805: no `resume` while the key is recorded, marked or not,
  // read after the sweep's await, so a key recorded during it is never resumed.
  const retired = retiredKeyReadingOf(key)
  if (retired.recorded) return retiredKeyAtResumeSite(run, lastRead, retired)
  // A key read recorded above whose entry was cleared during the sweep
  // (SRJ-807) still takes the `resume_enabled` false step.
  if (config.resume_enabled === false) return resumeDisabledAtResumeSite(run, lastRead, deadEvidence)
  if (!configDir.configDirMatches) {
    console.error(`[slack] spawnForPersona: ${configDirMismatchText(persona, ref, configDir)} — not resuming; replacing its row by a reuse spawn of the same id`)
    return replaceAtResumeSite(run, lastRead, CONFIG_DIR_MISMATCH_WHY, deadEvidence)
  }

  // resume_enabled: attempt resume
  console.error(`[slack] spawnForPersona: attempting resume for ${ref}`)
  return resumeAtSite<SpawnPersonaResult>({
    persona,
    isStartup,
    ref,
    lastRead,
    params,
    head: LADDER_LOG_HEAD,
    marksDirectoryCounted: false,
    noTranscript: (err) => {
      console.error(
        `[slack] spawnForPersona: ${describeAgentDirectorFailure(err)} on resume for ${ref} — a reuse spawn of the same id follows; nothing is deleted (b.jg5 SRJ-707)`,
      )
      // b.jg5 SRJ-707, SRJ-712: the no-transcript step, through the replace
      // step's finished-row branch (the row `resume` refused is finished).
      // After ErrJsonlMissing the lost-transcript diagnosis runs first; a
      // refused diagnosis get ends the ladder with no launch (`failed`, which
      // the launch answers as `retrying`), and one that latched the persona
      // answers `latched` (b.jg5 SRJ-105, SRJ-502). ErrNoSessionId and
      // ErrJsonlNeverWritten lost no history, so they get no diagnosis and a
      // success answers `spawned`. The reuse spawn's outcomes are SRJ-112's:
      // a CONFLICT latches with the refused operation "reuse spawn" (b.jg5
      // SRJ-501); a collision re-runs get-then-act once.
      return reuseFinishedRow(run, `${REUSE_SPAWN_WHAT} after its resume's no-transcript answer`, () =>
        noTranscriptReuse(persona, config, err, { isStartup, lastRead, trustPatchRan: true, retiredAtStart: run.retiredAtStart }),
      )
    },
    notResumable: (err) => spawnNotResumableAtLadder(run, err, deadEvidence),
    // b.jg5 SRJ-113, SRJ-611: `resume`'s ErrSpawnNotFound read the row gone,
    // which voids the path's dead evidence: the plain spawn after it, and any
    // get-then-act its collision runs, carry none.
    resumeNotFound: () => {
      const voided = voidDeadEvidence(run, deadEvidence, DEAD_EVIDENCE_VOIDED_BY_RESUME_NOT_FOUND)
      run = voided.run
      deadEvidence = voided.deadEvidence
    },
    // b.jg5 SRJ-111, SRJ-114: the plain spawn after `resume`'s
    // ErrSpawnNotFound collided: get-then-act, re-run once.
    plainSpawnCollided: () => plainSpawnCollisionAtLadder(run, RESUME_NOT_FOUND_SPAWN_WHAT),
  })
}

/**
 * `resumeOrFreshSpawn`'s retired-key rule (b.jg5 SRJ-805), for persona
 * `run.persona` whose key the installed store has recorded (`retired`,
 * marked or not), after the find-missing run and the unresolvable-directory
 * deferral: never a `resume`. One line, then the reuse spawn of the same id
 * first, whatever row the path last read (`lastRead`), through the replace
 * step's finished-row branch (`reuseFinishedRow`, SRJ-112): a finished row
 * or no row gets its new life (with no row an ordinary fresh spawn, HO rev
 * 15), `fresh-retired` with the mark set (SRJ-806); a row still live makes
 * it collide, and get-then-act is re-run once, its collision `get` reading
 * the row and the ladder's retired-key rule deciding (`retiredKeyAtCollision`):
 * with no mark the old life goes through the live-row sequence with the
 * retired-key flag; with the mark set the live row is the new life and is
 * handled as any live row. A collision in that re-run arms the
 * reuse-collision cause and answers `retrying`, uncounted. Nothing is
 * deleted or killed here. Never throws.
 */
function retiredKeyAtResumeSite(run: LadderRun, lastRead: LatchRowState, retired: RetiredKeyReading): Promise<SpawnPersonaResult> {
  const { persona, config, isStartup, ref } = run
  console.error(
    `[slack] spawnForPersona: ${ref}'s key is retired (${describeRetiredMark(retired)}; last read ${describeLatchRowState(lastRead)}) — not resuming: a reuse spawn of the same id first; nothing is deleted (b.jg5 SRJ-805)`,
  )
  return reuseFinishedRow(run, RETIRED_KEY_REUSE_WHAT, () =>
    reuseSpawnForPersona(persona, config, { isStartup, lastRead, trustPatchRan: true, retiredAtStart: run.retiredAtStart }),
  )
}

/**
 * `resumeOrFreshSpawn`'s `resume_enabled` false step (b.jg5 SRJ-707, SRJ-609,
 * SRJ-611): one line, then no `resume`: the resume site's replacement
 * decides on the state last read and the path's evidence
 * (`replaceAtResumeSite`). Never throws.
 */
function resumeDisabledAtResumeSite(run: LadderRun, lastRead: LatchRowState, deadEvidence: CarriedDeadEvidence): Promise<SpawnPersonaResult> {
  console.error(`[slack] spawnForPersona: resume_enabled=false for ${run.ref} — not resuming; replacing its row by a reuse spawn of the same id`)
  return replaceAtResumeSite(run, lastRead, RESUME_DISABLED_WHY, deadEvidence)
}

/** The head of the collision ladder's lines. */
const LADDER_LOG_HEAD = '[slack] spawnForPersona:'

/** The replace step's reason for `resume_enabled` false (b.jg5 SRJ-707). */
const RESUME_DISABLED_WHY = 'resume_enabled is false'

/** The replace step's reason for a `config_dir` label missing or different (b.jg5 SRJ-707, SRJ-1504). */
const CONFIG_DIR_MISMATCH_WHY = 'its config_dir label is missing or differs'

/** The replace step's reason for a row whose `cwd` differs from the persona's working directory by real path (b.jg5 SRJ-707, SRJ-1503). */
const CWD_MISMATCH_WHY = "its cwd differs from the persona's working directory"

/** The words of a `config_dir` mismatch line: the label missing or changed, what it was and what it is now. */
function configDirMismatchText(persona: Persona, ref: string, configDir: RowPersonaComparison): string {
  const was = configDir.configDirLabel === undefined ? 'label absent' : `was=${configDir.configDirLabel}`
  return (
    `${ref} config_dir label ${configDir.configDirLabel === undefined ? 'missing' : 'changed'} ` +
    `(${was}, now=${configDir.expectedConfigDirLabel} for claude_config_dir=${persona.claude_config_dir ?? '<default>'})`
  )
}

/**
 * Bug b.g57: the persona's claude_config_dir stopped resolving since this
 * ladder's pre-launch check, so a row's `config_dir` label has no verdict and
 * is no reason to replace it: the row is kept and nothing is launched; the
 * hold re-checks and launches once it resolves (`deferred`). Never throws.
 */
function deferForUnresolvedConfigDir(persona: Persona, ref: string): SpawnPersonaResult {
  const deferred = deferIfConfigDirUnresolvable(persona)
  if (deferred !== undefined) return deferred
  // It resolved again between the comparison and the re-check: nothing
  // holds it, and its next restart or health tick launches it.
  console.error(
    `[slack] spawnForPersona: ${ref} claude_config_dir could not be resolved during the launch — keeping its row; not launching`,
  )
  return { key: persona.key, action: 'deferred' }
}

// ---------------------------------------------------------------------------
// The one `resume` outcome handler (b.jg5 SRJ-113)
// ---------------------------------------------------------------------------

/** What a `resume` site gives the one `resume` outcome handler (`resumeAtSite`). */
interface ResumeSite<R> {
  readonly persona: Persona
  /** Whether the launch is part of the start pass (startup-errors entries are written only then). */
  readonly isStartup: boolean
  readonly ref: string
  /** The row state the site last read before the `resume`: the state a CONFLICT or UNUSABLE NAME latch records (b.jg5 SRJ-501). */
  readonly lastRead: LatchRowState
  /** The plain spawn's parameters (`buildSpawnParams`, no reuse flag), for the spawn after `ErrSpawnNotFound`. */
  readonly params: SpawnParams
  /** The head of the site's lines (`[slack] spawnForPersona:`, or the live-row sequence's prefix). */
  readonly head: string
  /**
   * Whether a DIRECTORY failure (`ErrCwdNotFound`, `ErrCwdNotADirectory`) of
   * the `resume` or of the plain spawn after it is marked `countedClass`:
   * the live-row sequence's launch entry counts a failure only when it is
   * marked (b.jg5 SRJ-113, SRJ-111), while the restart path counts any
   * `failed` result that is not stopping.
   */
  readonly marksDirectoryCounted: boolean
  /** The no-transcript row (`ErrNoSessionId`, `ErrJsonlNeverWritten`, `ErrJsonlMissing`): the site's line and its reuse spawn of the same id. */
  readonly noTranscript: (err: AgentDirectorError) => Promise<R>
  /** The `ErrSpawnNotResumable` row (b.jg5 SRJ-710): the site's not-resumable step. */
  readonly notResumable: (err: unknown) => Promise<R>
  /**
   * Told once when the `resume` answered `ErrSpawnNotFound`, before the plain
   * spawn after it (b.jg5 SRJ-113, SRJ-611: a read of the row as gone, which
   * voids the collision ladder path's dead evidence). Absent: nothing is told.
   */
  readonly resumeNotFound?: () => void
  /**
   * The collision row of the plain spawn after `ErrSpawnNotFound` (b.jg5
   * SRJ-111, SRJ-713; `plainSpawnOutcomeAt`'s `collided`): the collision
   * ladder's get-then-act re-run once (`plainSpawnCollisionAtLadder`), or the
   * live-row sequence's end without its launch (`sequenceSpawnCollision`).
   */
  readonly plainSpawnCollided: (err: unknown) => Promise<R>
}

/**
 * The one `resume` outcome handler (b.jg5 SRJ-113), used by both `resume`
 * sites: `resumeOrFreshSpawn` and the live-row sequence's launch entry's
 * `resume` leg (`launchForLiveRowSequence`). One `resume` of persona
 * `site.persona`'s `cscb_<key>` through the ladder's launch helper
 * (`launchWithReplyGuard`: the reply guard, spawn detection, arming by
 * class), its outcome decided by name or class, never by `instanceof`:
 *   - success: one line, the after-launch step (`afterLaunchSucceeded`: the
 *     `pre_trust` line and the dialog approver on the row, which reads
 *     `pending` until its session reports in, b.jg5 SRJ-402), `resumed`;
 *   - `ErrNoSessionId`, `ErrJsonlNeverWritten`, `ErrJsonlMissing`: the
 *     site's no-transcript row (`site.noTranscript`, SRJ-707, SRJ-712);
 *   - `ErrSpawnNotResumable`: the site's not-resumable step
 *     (`site.notResumable`, SRJ-710);
 *   - `ErrSpawnNotFound`: the site told (`site.resumeNotFound`), then one
 *     plain spawn of the same id
 *     (`plainSpawnAfterResumeNotFound`, SRJ-111) through the one plain-spawn
 *     outcome handler, with no spawn-failure notice for the
 *     `ErrSpawnNotFound` itself; its collision takes the site's row
 *     (`site.plainSpawnCollided`);
 *   - any other outcome: `resumeFailedAt` (CONFLICT latches with the refused
 *     operation "resume" and `site.lastRead`, never a kill; UNAVAILABLE,
 *     ENVIRONMENT, CONFIG and UNCLASSIFIED take the refusal rows, an
 *     UNAVAILABLE one followed by the one `get` and its decision
 *     (`afterLaunchUnavailable`, b.jg5 SRJ-407); UNUSABLE
 *     NAME latches; `ErrTmuxSessionCreate` is one counted launch failure
 *     that arms the retry timer at once in pending-only mode; the DIRECTORY
 *     errors give `cwd-unreachable`, counted; `ErrInvalidFlags` takes the
 *     version re-check, then UNCLASSIFIED; an `ErrInstanceIdCollision`,
 *     which agent-director's `resume` does not answer, arms the collision
 *     cause and answers `retrying`, never the spawn-failure notice,
 *     `resumeCollisionAt`). Nothing assumes the row was
 *     restored after a failed `resume` (HO rev 28): a later read decides.
 * Nothing here deletes, kills or sets `include_finished`. Never throws.
 */
async function resumeAtSite<R>(site: ResumeSite<R>): Promise<SpawnPersonaResult | R> {
  const { persona, isStartup, ref, lastRead, head } = site
  const { key } = persona
  try {
    const launched: Phase1ResumeResult = await launchWithReplyGuard(persona, ref, 'resume', (client) =>
      client.resume({ claude_instance_id: personaInstanceId(key) }),
    )
    console.error(`${head} resumed ${ref}`)
    // A resumed bot faces the same startup dialogs as a fresh one. Its row
    // reads `pending` from the resume until its session reports in (HO C5),
    // so the approver clears the dialog through agent-director, as after a
    // spawn (b.jg5 SRJ-402).
    afterLaunchSucceeded(key, isStartup, ref, LAUNCH_VERB_RESUME, launched)
    return { key, action: 'resumed' }
  } catch (err) {
    if (isNoTranscriptResumeError(err)) return site.noTranscript(err)
    if (hasAdErrorName(err, ERR_SPAWN_NOT_RESUMABLE_NAME)) return site.notResumable(err)
    if (hasAdErrorName(err, ERR_SPAWN_NOT_FOUND_NAME)) {
      site.resumeNotFound?.()
      return plainSpawnAfterResumeNotFound(site)
    }
    const notResumed = await resumeFailedAt(persona, err, isStartup, ref, lastRead)
    return site.marksDirectoryCounted ? withDirectoryCounted(notResumed, err) : notResumed
  }
}

/**
 * The line before the plain spawn that follows `resume`'s `ErrSpawnNotFound`
 * (b.jg5 SRJ-113, SRJ-111), at either `resume` site (`head`):
 *   `<head> ErrSpawnNotFound on resume for <ref> — fresh-spawn: one plain spawn of the same id, which makes agent-director's pre-spawn scan; no spawn-failure notice for the ErrSpawnNotFound (b.jg5 SRJ-113, SRJ-111)`
 */
export function resumeNotFoundSpawnLine(head: string, ref: string): string {
  return `${head} ErrSpawnNotFound on resume for ${ref} — fresh-spawn: one plain spawn of the same id, which makes agent-director's pre-spawn scan; no spawn-failure notice for the ErrSpawnNotFound (b.jg5 SRJ-113, SRJ-111)`
}

/** What the lines of the plain spawn after `resume`'s `ErrSpawnNotFound` call it. */
const RESUME_NOT_FOUND_SPAWN_WHAT = 'fresh spawn after ErrSpawnNotFound on resume'

/**
 * `resume`'s `ErrSpawnNotFound` row (b.jg5 SRJ-113, SRJ-111): the row is
 * gone (an operator's action, or `expire` removed it before `resume`'s
 * move), so one plain spawn of `cscb_<key>` from `site.params`
 * (`buildSpawnParams`, no reuse flag, SRJ-711) through the one plain-spawn
 * outcome handler (`plainSpawnOutcomeAt`); agent-director's pre-spawn scan
 * runs inside it (HO rev 15). No spawn-failure notice is posted for the
 * `ErrSpawnNotFound` itself. A success runs the after-launch step and
 * answers `spawned`; a collision takes the site's collision row
 * (`site.plainSpawnCollided`: get-then-act at the collision ladder, the
 * sequence's end without its launch at the live-row sequence's entry); a
 * failure takes the plain spawn's handling (`plainSpawnFailedAt`): its
 * CONFLICT (the scan's refusal, or one after "duplicate session") latches
 * with the refused operation "plain spawn" and `site.lastRead`, since
 * `resume` is not a read; its `ErrTmuxSessionCreate` is one counted launch
 * failure. A DIRECTORY failure is marked `countedClass` where the site asks
 * (`site.marksDirectoryCounted`). Never throws.
 */
async function plainSpawnAfterResumeNotFound<R>(site: ResumeSite<R>): Promise<SpawnPersonaResult | R> {
  const { persona, isStartup, ref, lastRead, head, params } = site
  console.error(resumeNotFoundSpawnLine(head, ref))
  return plainSpawnOutcomeAt<R>({
    persona,
    isStartup,
    ref,
    params,
    what: RESUME_NOT_FOUND_SPAWN_WHAT,
    lastRead,
    marksDirectoryCounted: site.marksDirectoryCounted,
    spawnedLine: () => `${head} fresh-spawned (after ErrSpawnNotFound on resume) for ${ref}`,
    collided: site.plainSpawnCollided,
  })
}

/** `result` marked `countedClass` when it is `failed`, not stopping, and `err`'s class is DIRECTORY; otherwise `result` as it is. */
function withDirectoryCounted(result: SpawnPersonaResult, err: unknown): SpawnPersonaResult {
  if (!isUnstoppedFailure(result) || classifyAdError(err).errorClass !== AD_ERROR_CLASS_DIRECTORY) return result
  return { ...result, countedClass: true }
}

// ---------------------------------------------------------------------------
// The re-read of a persona's row before a decision (b.jg5 SRJ-710, SRJ-609, SRJ-114)
// ---------------------------------------------------------------------------

/** The re-read latched the persona (a latching note, a `pending` row with no launch start, an UNUSABLE NAME answer), or found it latched. */
export const ROW_REREAD_LATCHED = 'latched'
/** The re-read failed (any error but `ErrSpawnNotFound` and an UNUSABLE NAME answer): the shared read's error rows applied. */
export const ROW_REREAD_REFUSED = 'refused'
/** The row reads `ended` or `missing`, or there is none (`ErrSpawnNotFound`). */
export const ROW_REREAD_FINISHED = 'finished'
/** The row reads `pending`. */
export const ROW_REREAD_PENDING = 'pending'
/** The row reads a known live state other than `pending` (`AGENT_DIRECTOR_LIVE_STATES`). */
export const ROW_REREAD_LIVE = 'live'
/** The row reads a state CSCB does not know (neither finished nor in `AGENT_DIRECTOR_LIVE_STATES`), or one that could not be read. Never leads to a kill. */
export const ROW_REREAD_UNKNOWN = 'unknown'

/** What one re-read of a persona's own row found (`rereadPersonaRow`). */
export type PersonaRowReread =
  | { readonly kind: typeof ROW_REREAD_LATCHED }
  | { readonly kind: typeof ROW_REREAD_REFUSED }
  | { readonly kind: typeof ROW_REREAD_FINISHED; readonly lastRead: LatchRowState }
  | { readonly kind: typeof ROW_REREAD_PENDING; readonly row: GetResult; readonly lastRead: LatchRowState }
  | { readonly kind: typeof ROW_REREAD_LIVE; readonly row: GetResult; readonly lastRead: LatchRowState }
  | { readonly kind: typeof ROW_REREAD_UNKNOWN; readonly row: GetResult; readonly lastRead: LatchRowState }

/** The re-read of one kind. */
type PersonaRowRereadOf<K extends PersonaRowReread['kind']> = Extract<PersonaRowReread, { readonly kind: K }>

/** A re-read, in words, for a line: `the read latched the persona`, `the read failed`, `state=<state>` or `state=no-row`. */
export function describePersonaRowReread(reread: PersonaRowReread): string {
  switch (reread.kind) {
    case ROW_REREAD_LATCHED:
      return 'the read latched the persona'
    case ROW_REREAD_REFUSED:
      return 'the read failed'
    default:
      return `state=${describeLatchRowState(reread.lastRead)}`
  }
}

/**
 * One `get` of persona `key`'s own row through the shared own-row read
 * (`readPersonaOwnRow`, b.jg5 SRJ-114; `what` at `site` names it in the
 * lines), its latch and error rows applying: a read that latched the
 * persona (a `provenance_conflict` note, its own `pending` row with no launch
 * start, an UNUSABLE NAME answer), or a persona latched elsewhere while it
 * was awaited (`latchedAfterOwnRowRead`), answers `latched`; a read error is
 * a refusal (`refusalAt`: one line; the `get` ran inside the caller's
 * attempt, so an error the arming predicate answers a cause for armed the
 * retry timer with its read-error cause, SRJ-301) and answers `refused`;
 * `ErrSpawnNotFound` answers `finished` with no row; a row answers
 * `finished` (`ended`, `missing`), `pending`, `live` (another state in
 * `AGENT_DIRECTOR_LIVE_STATES`) or `unknown` (any other state, an unreadable
 * one included) by its state, with the state read as the state last read.
 * Never throws.
 */
async function rereadPersonaRow(key: string, ref: string, site: string, what: string): Promise<PersonaRowReread> {
  const read = await readPersonaOwnRow(key, { site, what, ref })
  if (read.kind === OWN_ROW_READ_LATCHED || (read.kind === OWN_ROW_READ_ROW && read.latched)) return { kind: ROW_REREAD_LATCHED }
  // b.jg5 SRJ-502: the get is awaited, and the persona may have latched elsewhere meanwhile.
  if (latchedAfterOwnRowRead(key, site, what, ref)) return { kind: ROW_REREAD_LATCHED }
  if (read.kind === OWN_ROW_READ_ABSENT) return { kind: ROW_REREAD_FINISHED, lastRead: LATCH_ROW_STATE_NO_ROW }
  if (read.kind === OWN_ROW_READ_REFUSED) {
    if (refusalAt(key, read.error, 'get', site, what, ref) === undefined) {
      // Not reached: every `get` error but ErrSpawnNotFound and UNUSABLE NAME is a refusal.
      console.error(`[slack] ${site}: ${what} failed for ${ref}: ${describeAgentDirectorFailure(read.error)} — nothing more is called`)
    }
    return { kind: ROW_REREAD_REFUSED }
  }
  const { row } = read
  const lastRead = latchRowStateRead(row.state)
  if (AGENT_DIRECTOR_DEAD_STATES.has(row.state)) return { kind: ROW_REREAD_FINISHED, lastRead }
  if (row.state === AGENT_DIRECTOR_PENDING_STATE) return { kind: ROW_REREAD_PENDING, row, lastRead }
  if (AGENT_DIRECTOR_LIVE_STATES.has(row.state)) return { kind: ROW_REREAD_LIVE, row, lastRead }
  return { kind: ROW_REREAD_UNKNOWN, row, lastRead }
}

// ---------------------------------------------------------------------------
// The not-resumable step (b.jg5 SRJ-710, SRJ-611)
// ---------------------------------------------------------------------------

/** What the not-resumable step's `get` is called in its lines. */
export const NOT_RESUMABLE_REREAD_WHAT = 'get after ErrSpawnNotResumable'

/** The re-read latched the persona: nothing more is called for it. */
export const NOT_RESUMABLE_LATCHED = 'latched'
/** The row reads `pending`: a launch in progress, not a failure. */
export const NOT_RESUMABLE_PENDING = 'pending'
/** The row reads another known live state and the path holds dead evidence: the live-row sequence, ending in `resume`. */
export const NOT_RESUMABLE_SEQUENCE = 'live-row-sequence'
/** A lost race: the row live with no dead evidence (or the sequence barred), a state CSCB does not know, `ended`, `missing`, no row, or the read refused. */
export const NOT_RESUMABLE_LOST_RACE = 'lost-race'

/** What the not-resumable step decided (`decideNotResumable`), with the re-read it decided on. */
export type NotResumableDecision =
  | { readonly answer: typeof NOT_RESUMABLE_LATCHED; readonly reread: PersonaRowReread }
  | { readonly answer: typeof NOT_RESUMABLE_PENDING; readonly reread: PersonaRowRereadOf<typeof ROW_REREAD_PENDING> }
  | { readonly answer: typeof NOT_RESUMABLE_SEQUENCE; readonly reread: PersonaRowRereadOf<typeof ROW_REREAD_LIVE> }
  | { readonly answer: typeof NOT_RESUMABLE_LOST_RACE; readonly reread: PersonaRowReread }

/**
 * The not-resumable step's decision on its re-read (b.jg5 SRJ-710, SRJ-611):
 *   - the read latched the persona → `latched`;
 *   - `pending` → `pending`, whatever evidence the path holds: a launch in
 *     progress, which starts no live-row sequence of its own;
 *   - another known live state (`live`) → `live-row-sequence` only when
 *     `deadEvidence` is dead evidence (`isDeadEvidence`, decided again from
 *     its source) and the sequence is not barred (`sequenceBarred`: the
 *     `resume` is the live-row sequence's own step 6, which never starts a
 *     second one); otherwise `lost-race`;
 *   - a state CSCB does not know (`unknown`), whatever evidence the path
 *     holds → `lost-race`: an unknown state never leads to a kill;
 *   - `ended`, `missing`, no row, or a refused read → `lost-race`.
 * Pure; never throws.
 */
export function decideNotResumable(
  reread: PersonaRowReread,
  deadEvidence: CarriedDeadEvidence,
  sequenceBarred: boolean,
): NotResumableDecision {
  switch (reread.kind) {
    case ROW_REREAD_LATCHED:
      return { answer: NOT_RESUMABLE_LATCHED, reread }
    case ROW_REREAD_PENDING:
      return { answer: NOT_RESUMABLE_PENDING, reread }
    case ROW_REREAD_LIVE:
      return !sequenceBarred && isDeadEvidence(deadEvidence.source)
        ? { answer: NOT_RESUMABLE_SEQUENCE, reread }
        : { answer: NOT_RESUMABLE_LOST_RACE, reread }
    default:
      return { answer: NOT_RESUMABLE_LOST_RACE, reread }
  }
}

/** What the not-resumable step is told by its site. */
export interface NotResumableStepOptions {
  /** The log prefix's site, which names the `get` in the shared read's lines. */
  readonly site: string
  /** The dead evidence the path that reached the `resume` holds (b.jg5 SRJ-611); none when absent. */
  readonly deadEvidence?: CarriedDeadEvidence
  /** True at the live-row sequence's own step-6 `resume`: no answer starts a sequence. */
  readonly sequenceBarred: boolean
}

/**
 * The not-resumable step (b.jg5 SRJ-710): what follows a `resume` of persona
 * `key`'s `cscb_<key>` that answered `ErrSpawnNotResumable`, which is never
 * by itself a reason to kill and replace. One `get` of the row through the
 * shared own-row read (`rereadPersonaRow`, so a `provenance_conflict` note
 * latches, SRJ-114; a refused read takes the shared read's error rows), and
 * the decision on it (`decideNotResumable`). The step itself calls nothing
 * more: each site acts on the decision (`spawnNotResumableAtLadder` at the
 * collision ladder, `sequenceNotResumable` at the live-row sequence's
 * launch entry) and logs its one line (`spawnNotResumableLine`). Never
 * throws.
 */
export async function notResumableStep(key: string, ref: string, options: NotResumableStepOptions): Promise<NotResumableDecision> {
  const reread = await rereadPersonaRow(key, ref, options.site, NOT_RESUMABLE_REREAD_WHAT)
  return decideNotResumable(reread, options.deadEvidence ?? CARRIED_DEAD_EVIDENCE_NONE, options.sequenceBarred)
}

/**
 * The not-resumable step's one line at a site (`head`), naming the failure
 * (`failure`, a redacting describer's output), the re-read, the dead
 * evidence the path held (`evidence`; absent at the live-row sequence's own
 * `resume`, which carries none) and what follows (`outcome`):
 *   `<head> <failure> on resume for <ref> — re-read: <re-read>[; <describeDeadEvidence>] — <outcome> (b.jg5 SRJ-710, SRJ-611 | SRJ-706)`
 */
export function spawnNotResumableLine(
  head: string,
  ref: string,
  failure: string,
  reread: PersonaRowReread,
  evidence: CarriedDeadEvidence | undefined,
  outcome: string,
): string {
  const held = evidence === undefined ? '' : `; ${describeDeadEvidence(evidence)}`
  const tags = evidence === undefined ? 'b.jg5 SRJ-710, SRJ-706' : 'b.jg5 SRJ-710, SRJ-611'
  return `${head} ${failure} on resume for ${ref} — re-read: ${describePersonaRowReread(reread)}${held} — ${outcome} (${tags})`
}

/** The outcome a re-read that latched the persona gives at the collision ladder. */
export const REREAD_LATCHED_OUTCOME = 'the persona is latched: answering latched; nothing more is called for it'

/** The outcome of the not-resumable step's `pending` answer at the collision ladder. */
export const NOT_RESUMABLE_PENDING_OUTCOME =
  "a launch in progress, not a failure: nothing counted or posted, and no live-row sequence of its own; the ladder's pending step decides"

/**
 * The outcome of the not-resumable step's sequence answer at the collision
 * ladder, with the start entry's answer: `held` for a persona held on
 * `ErrInvalidFlags` (b.jg5 SRJ-207), `sequence-waiting` for any other.
 */
export function notResumableSequenceOutcome(startAnswer: string): string {
  return `the path holds dead evidence and the row is live: the live-row sequence, with the conversation kept (alert context ${KILL_FAILURE_CONTEXT_RECOVERY}), ending in resume; start answered ${startAnswer} — answering ${sequenceStartAction(startAnswer)}; no other call, nothing counted`
}

/** The outcome of a lost race at the collision ladder, with whether the retry timer was armed. */
export function lostRaceOutcome(armed: boolean): string {
  return `a lost race: nothing killed, deleted or launched; answering retrying, no spawn-failure notice, nothing counted; the retry timer ${armed ? 'is armed' : 'could not be armed'} (cause=${UNAVAILABLE_RETRY_CAUSE_LOST_RACE})`
}

/**
 * The not-resumable step at the collision ladder (`resumeOrFreshSpawn`'s
 * `ErrSpawnNotResumable` row; b.jg5 SRJ-710, SRJ-611, SRJ-301), for the path
 * holding `deadEvidence`. One re-read and its decision (`notResumableStep`),
 * one line naming the re-read, the evidence and what follows
 * (`spawnNotResumableLine`), then:
 *   - `latched`: `latched`, nothing more called;
 *   - `pending`: the ladder's `pending` step (`ladderPendingRowStep`), whose
 *     answer is the result: a covered row's `no-op`, with no kill or launch,
 *     or, for a row that is not covered, SRJ-411's live-row sequence through
 *     the replace step. Nothing is counted or posted here, and nothing is
 *     armed beyond what that step arms;
 *   - `live-row-sequence`: one start of the live-row sequence through the
 *     start entry (`startLiveRowSequence`), seeded with the re-read state,
 *     entry at step 1, the conversation kept, the retired-key flag unset (the
 *     start entry sets it if the key is recorded by then, SRJ-805), ending in
 *     a launch, alert context `recovery`; its step 6 is a `resume` when the
 *     row has a session id and the persona may resume it (SRJ-705). The
 *     answer is `sequence-waiting` whatever the start entry answers but
 *     `held` (b.jg5 SRJ-207), which answers `held`, with no other call and
 *     nothing counted (SRJ-706);
 *   - `lost-race`: nothing killed, deleted or launched; the persona's retry
 *     timer armed with the lost-race cause through the outage state's site
 *     entry (`reportLostRaceAtSite`; the attempt records it), and
 *     `retrying` (b.jg5 SRJ-1015): no notice, no `spawn-failed` entry,
 *     nothing counted. The persona is re-evaluated at
 *     its next tick or retry.
 * Never throws.
 */
async function spawnNotResumableAtLadder(run: LadderRun, err: unknown, deadEvidence: CarriedDeadEvidence): Promise<SpawnPersonaResult> {
  const { persona, ref } = run
  const { key } = persona
  const decision = await notResumableStep(key, ref, { site: 'spawnForPersona', deadEvidence, sequenceBarred: false })
  const log = (outcome: string): void => {
    console.error(spawnNotResumableLine(LADDER_LOG_HEAD, ref, describeAgentDirectorFailure(err), decision.reread, deadEvidence, outcome))
  }
  switch (decision.answer) {
    case NOT_RESUMABLE_LATCHED:
      log(REREAD_LATCHED_OUTCOME)
      return { key, action: 'latched' }
    case NOT_RESUMABLE_PENDING:
      log(NOT_RESUMABLE_PENDING_OUTCOME)
      return ladderPendingRowStep(run, decision.reread.row, decision.reread.lastRead)
    case NOT_RESUMABLE_SEQUENCE: {
      // A `resume` was made, so the key was not recorded at the path's
      // decision; the start entry sets the flag if it is recorded now (b.jg5 SRJ-805).
      const { startAnswer, result } = startRecoverySequence(run, decision.reread.lastRead, true, false)
      log(notResumableSequenceOutcome(startAnswer))
      return result
    }
    case NOT_RESUMABLE_LOST_RACE:
      return lostRaceAtLadder(key, log)
  }
}

/** The lost race at a collision ladder site (b.jg5 SRJ-710, SRJ-301, SRJ-1015): the lost-race cause armed, `log`'s one line, `retrying`. */
function lostRaceAtLadder(key: string, log: (outcome: string) => void): SpawnPersonaResult {
  const armed = reportLostRaceAtSite(key)
  log(lostRaceOutcome(armed))
  return { key, action: SPAWN_ACTION_RETRYING }
}

// ---------------------------------------------------------------------------
// The pending-row step (b.jg5 SRJ-409, SRJ-411)
// ---------------------------------------------------------------------------

/** The head of the pending-row step's own lines. */
export const PENDING_ROW_STEP_LOG_PREFIX = '[slack] pending-row:'

/** Who reads, in the own-row lines of the read-and-step entry's `get` (`readAndStepPendingRow`; the persona's ref is added; b.jg5 SRJ-114, SRJ-409). */
export const PENDING_ROW_STEP_GET_SITE: OwnRowReadSite = Object.freeze({ site: 'pendingRowStep', what: 'pending-row get' })

/** The read-and-step entry's answer when its read latched the persona, or found it latched (b.jg5 SRJ-114, SRJ-502, SRJ-513). */
export const PENDING_ROW_STEP_LATCHED = 'latched'
/** The read-and-step entry's answer when its `get` read the row in a state other than `pending`. */
export const PENDING_ROW_STEP_NOT_PENDING = 'not-pending'
/** The read-and-step entry's answer when its `get` answered `ErrSpawnNotFound`: the row is gone. */
export const PENDING_ROW_STEP_NO_ROW = 'no-row'
/** The read-and-step entry's answer when the shared read refused its `get` (its own error rows applied, its cause armed inside an attempt). */
export const PENDING_ROW_STEP_REFUSED = 'refused'

/**
 * What the read-and-step entry answers (`readAndStepPendingRow`; b.jg5
 * SRJ-409, SRJ-411): the covered row's arm, the undecided row's arm, the
 * uncovered row's sequence start (the start entry's answer), a latch, the
 * state another live or finished row read, no row, or a refused read.
 * `armed` is whether the persona's timer was asked to arm (false for a
 * latched persona, or with no trigger sink installed).
 */
export type PendingRowStepAnswer =
  | {
      readonly kind: typeof PENDING_ROW_COVERED
      readonly armed: boolean
      /** The row the `get` read (`pending`, with its raw launch start): the row read the pending-row rule runs on (b.jg5 SRJ-410). */
      readonly row: PendingRowRuleRow
    }
  | { readonly kind: typeof PENDING_ROW_UNDECIDED; readonly reason: PendingRowUndecidedReason; readonly armed: boolean }
  | {
      readonly kind: typeof PENDING_ROW_NOT_COVERED
      readonly reason: PendingRowNotCoveredReason
      readonly startAnswer: LiveRowSequenceStartEntryAnswer
    }
  | { readonly kind: typeof PENDING_ROW_STEP_LATCHED }
  | { readonly kind: typeof PENDING_ROW_STEP_NOT_PENDING; readonly state: string }
  | { readonly kind: typeof PENDING_ROW_STEP_NO_ROW }
  | { readonly kind: typeof PENDING_ROW_STEP_REFUSED; readonly error: unknown }

/**
 * The replace step's reason, and the uncovered-row line's words, for a
 * reason a `pending` row is not covered. A function, so the module's later
 * constants are read at call time. Pure.
 */
function pendingRowNotCoveredWhy(reason: PendingRowNotCoveredReason): string {
  switch (reason) {
    case PENDING_ROW_REASON_RETIRED_OLD_LIFE:
      return `${RETIRED_KEY_WHY} and no new life has begun yet, so the row is the old life`
    case PENDING_ROW_REASON_CWD_MISMATCH:
      return CWD_MISMATCH_WHY
    case PENDING_ROW_REASON_CONFIG_DIR_MISMATCH:
      return CONFIG_DIR_MISMATCH_WHY
  }
}

/** The undecided-row line's words for each reason a `pending` row's cover is undecided. */
const PENDING_ROW_UNDECIDED_WHY: Readonly<Record<PendingRowUndecidedReason, string>> = {
  [PENDING_ROW_REASON_CWD_UNRESOLVED]: 'its working_directory does not resolve to a real path now',
  [PENDING_ROW_REASON_CONFIG_DIR_UNRESOLVED]: 'its claude_config_dir cannot be resolved now',
}

/**
 * The one line for a `pending` row that is not covered, sent to the live-row
 * sequence (b.jg5 SRJ-411), naming the persona reference `ref` and the
 * reason:
 *
 *   [slack] pending-row: <ref>'s pending row is not covered (<reason>: <why>) — it goes through the live-row sequence, the conversation not kept (alert context recovery); no approver, nothing typed (b.jg5 SRJ-411)
 *
 * Pure.
 */
export function uncoveredPendingRowLine(ref: string, reason: PendingRowNotCoveredReason): string {
  return `${PENDING_ROW_STEP_LOG_PREFIX} ${ref}'s pending row is not covered (${reason}: ${pendingRowNotCoveredWhy(reason)}) — it goes through the live-row sequence, the conversation not kept (alert context ${KILL_FAILURE_CONTEXT_RECOVERY}); no approver, nothing typed (b.jg5 SRJ-411)`
}

/**
 * The one line for a `pending` row whose cover is undecided (b.jg5 SRJ-409;
 * b.av2 SR-6.4, b.g57), with whether its timer was asked to arm:
 *
 *   [slack] pending-row: <ref>'s pending row is undecided (<reason>: <why>) — no approver, no sequence; its retry timer is armed in pending-only mode, and the next read decides again (b.jg5 SRJ-409)
 *
 * Pure.
 */
export function undecidedPendingRowLine(ref: string, reason: PendingRowUndecidedReason, armed: boolean): string {
  const timer = armed ? 'its retry timer is armed in pending-only mode' : 'its retry timer could not be armed'
  return `${PENDING_ROW_STEP_LOG_PREFIX} ${ref}'s pending row is undecided (${reason}: ${PENDING_ROW_UNDECIDED_WHY[reason]}) — no approver, no sequence; ${timer}, and the next read decides again (b.jg5 SRJ-409)`
}

/**
 * The line for a configured persona's own `pending` row with no launch
 * start that reached the pending-row step (b.jg5 SRJ-513, SRJ-408): the read
 * that found it latched the persona, so nothing is armed or started:
 *
 *   [slack] pending-row: <ref>'s pending row has no launch start — the persona latches on it; nothing armed, no sequence (b.jg5 SRJ-513)
 */
export function noLaunchStartPendingRowLine(ref: string): string {
  return `${PENDING_ROW_STEP_LOG_PREFIX} ${ref}'s pending row has no launch start — the persona latches on it; nothing armed, no sequence (b.jg5 SRJ-513)`
}

/**
 * The line for a covered or undecided `pending` row whose persona is latched,
 * so its retry timer is not armed (b.jg5 SRJ-305, SRJ-409), naming the
 * persona reference `ref`:
 *
 *   [slack] pending-row: not arming <ref>'s retry timer for its pending row — the persona is latched (b.jg5 SRJ-305)
 *
 * Pure.
 */
export function latchedNoArmPendingRowLine(ref: string): string {
  return `${PENDING_ROW_STEP_LOG_PREFIX} not arming ${ref}'s retry timer for its pending row — the persona is latched (b.jg5 SRJ-305)`
}

/**
 * Arm persona `key`'s retry timer in pending-only mode for its covered (or
 * undecided) `pending` row (b.jg5 SRJ-301, SRJ-409), through the outage
 * state's pending-row arm (`armPendingOnlyForPendingRow`), in or outside an
 * attempt; the controller's armed line, with the `pending-row` cause, is the
 * arm's line. A latched persona is never armed (b.jg5 SRJ-305): one line
 * (`latchedNoArmPendingRowLine`), and false. Answers whether the timer was
 * asked to arm. Never throws.
 */
function armPendingRowWatch(key: string, ref: string): boolean {
  if (personaLatchedNow(key)) {
    console.error(latchedNoArmPendingRowLine(ref))
    return false
  }
  return armPendingOnlyForPendingRow(key)
}

/**
 * Whether persona `persona`'s own `pending` row `row` is covered (b.jg5
 * SRJ-409, SRJ-411): `decidePendingRowCover` (`src/pending-row.ts`) over the
 * row, whether the key is a configured persona's (`configuredReadingOf`),
 * the installed retired-key store's reading of the key now
 * (`retiredKeyReadingOf`: its in-memory mark counted as set) and the one row
 * comparison (`compareRowToPersona`, `cwd` and the `config_dir` label).
 *
 * `statusOnlySite` is true for a site that read the row with `status` only
 * and then one `get` for this comparison (the read-and-step entry: the
 * restart path's deferral and its re-probe, a pending-only retry). There,
 * a persona working directory with no real path leaves the `cwd` condition
 * unresolved whatever the row's `cwd` is (`pendingRowComparisonFor`), and
 * `decidePendingRowCover` is told the site is status-only, so a working
 * directory or `claude_config_dir` that cannot be resolved leaves the row
 * undecided before any mismatch is checked, and the next read decides
 * (b.jg5 SRJ-409, SRJ-411, b.av2 SR-6.4); the lexical comparison never
 * makes it covered. The collision ladder passes false: its own `cwd` guard
 * has run before its `pending` branch, and a `cwd` mismatch is checked
 * first. Answers the decision. Never throws.
 */
function pendingRowCoverOf(
  persona: Persona,
  row: PendingRowFields & Pick<GetResult, 'cwd' | 'labels'>,
  statusOnlySite: boolean,
): PendingRowCover {
  const comparison = compareRowToPersona(row, persona, spawnHomeDir(), undefined, _configDirFs)
  return decidePendingRowCover({
    row,
    ownConfigured: configuredReadingOf(persona.key).configured,
    retired: retiredKeyReadingOf(persona.key),
    comparison: statusOnlySite ? pendingRowComparisonFor(comparison) : comparison,
    statusOnlySite,
  })
}

/**
 * The row comparison a status-only site's pending-row decision reads
 * (b.jg5 SRJ-411, b.av2 SR-6.4): `comparison` as is while the persona's
 * working directory has a real path; otherwise its `cwd` condition is
 * unresolved (`cwdMatches` false, `cwdCheckDeferred` true), so
 * `decidePendingRowCover` answers undecided with the `cwd-unresolved`
 * reason rather than act on the lexical comparison. Pure; never throws.
 */
export function pendingRowComparisonFor(comparison: RowPersonaComparison): RowPersonaComparison {
  if (comparison.workingDirectoryResolved) return comparison
  return { ...comparison, cwdMatches: false, cwdCheckDeferred: true }
}

/**
 * The one pending-row step (b.jg5 SRJ-409, SRJ-411, SRJ-408, SRJ-513) over
 * persona `persona`'s own row `row`, read `pending`: decides whether it is
 * covered (`pendingRowCoverOf`) and acts on every answer but "not covered":
 *   - no launch start: nothing (the read that found it latched the persona;
 *     one line);
 *   - covered: the persona's retry timer is armed in pending-only mode
 *     (`armPendingRowWatch`); no kill, no launch, no approver;
 *   - undecided: armed the same, with one line; no approver, no sequence;
 *   - not covered: one line (`uncoveredPendingRowLine`); its caller starts
 *     the live-row sequence (the collision ladder through its replace step,
 *     the read-and-step entry through the start entry).
 * The step never starts an approver, kills or launches. `statusOnlySite`
 * is passed to `pendingRowCoverOf`. Answers the decision and whether the
 * timer was asked to arm. Never throws.
 */
function pendingRowStep(
  persona: Persona,
  ref: string,
  row: PendingRowFields & Pick<GetResult, 'cwd' | 'labels'>,
  statusOnlySite: boolean,
): { readonly cover: PendingRowCover; readonly armed: boolean } {
  const cover = pendingRowCoverOf(persona, row, statusOnlySite)
  switch (cover.answer) {
    case PENDING_ROW_NO_LAUNCH_START:
      console.error(noLaunchStartPendingRowLine(ref))
      return { cover, armed: false }
    case PENDING_ROW_COVERED:
      return { cover, armed: armPendingRowWatch(persona.key, ref) }
    case PENDING_ROW_UNDECIDED: {
      const armed = armPendingRowWatch(persona.key, ref)
      console.error(undecidedPendingRowLine(ref, cover.reason, armed))
      return { cover, armed }
    }
    case PENDING_ROW_NOT_COVERED:
      console.error(uncoveredPendingRowLine(ref, cover.reason))
      return { cover, armed: false }
  }
}

/**
 * The collision ladder's `pending` step (b.jg5 SRJ-409, SRJ-411, SRJ-707,
 * SRJ-1504) for persona `run.persona`'s row `row`, read `pending`
 * (`lastRead`): the ladder's `pending` branch, and a re-read that found the
 * row `pending` (the not-resumable step, SRJ-710; the re-read before a
 * resume site's replacement, SRJ-609). It runs the one pending-row step
 * (`pendingRowStep`) and answers:
 *   - covered: `no-op` (counted as before), the persona's retry timer armed
 *     in pending-only mode, with no kill and no launch; at a retry of the
 *     persona's timer only (full mode, the not-resumable re-read
 *     included), the pending-row rule's one run of that retry on the row
 *     read (`runPendingRowRuleAtRetry`, P's own launch in flight not
 *     blocking it), whose answer `ladderResultOfRuleAnswer` maps; from any
 *     other origin (the start pass, an apply's bring-up, a restart timer, a
 *     human-triggered restart) no rule run (b.jg5 SRJ-410);
 *   - not covered (SRJ-411: a retired key's old life before its new life, a
 *     `cwd` that differs from the persona's working directory by real path,
 *     a `config_dir` label missing or different): the replace step
 *     (`replacePersonaRow`) sends it through the live-row sequence, with the
 *     conversation not kept and alert context `recovery` (the retired-key
 *     flag set for an old life), which waits until G past its launch start
 *     and ends in a reuse spawn of the same id: `sequence-waiting`;
 *   - undecided: the timer armed the same; a `claude_config_dir` that cannot
 *     be resolved also keeps its deferral (`deferForUnresolvedConfigDir`,
 *     `deferred`, bug b.g57), and a `cwd` that cannot be compared answers
 *     `no-op`;
 *   - no launch start: `latched` (the collision `get` or re-read latched the
 *     persona first, so the ladder does not reach here for such a row).
 * Never throws.
 */
async function ladderPendingRowStep(run: LadderRun, row: GetResult, lastRead: LatchRowState): Promise<SpawnPersonaResult> {
  const { persona, ref } = run
  const { key } = persona
  const { cover } = pendingRowStep(persona, ref, row, false)
  switch (cover.answer) {
    case PENDING_ROW_NO_LAUNCH_START:
      return { key, action: 'latched' }
    case PENDING_ROW_NOT_COVERED:
      return replacePersonaRow(
        run,
        lastRead,
        pendingRowNotCoveredWhy(cover.reason),
        cover.reason === PENDING_ROW_REASON_RETIRED_OLD_LIFE ? true : undefined,
      )
    case PENDING_ROW_UNDECIDED:
      if (cover.reason === PENDING_ROW_REASON_CONFIG_DIR_UNRESOLVED) return deferForUnresolvedConfigDir(persona, ref)
      return { key, action: 'no-op' }
    case PENDING_ROW_COVERED: {
      console.error(`[slack] spawnForPersona: no action — state=${AGENT_DIRECTOR_PENDING_STATE} for ${ref}`)
      // b.jg5 SRJ-410: at a retry of P's timer (full mode), the rule's one
      // run of that retry; from any other origin the arm above only.
      const ruled = await runPendingRowRuleAtRetry(persona, pendingRowRuleRowOf(row), { withinOwnLaunch: true })
      return ruled === undefined ? { key, action: 'no-op' } : ladderResultOfRuleAnswer(key, ref, ruled)
    }
  }
}

/**
 * The collision ladder's result for the pending-row rule's answer at its
 * `pending` step (b.jg5 SRJ-410, SRJ-409, SRJ-1015), for persona `key`
 * (`ref`):
 *   - a refusal, the held post or a row the rule read live: `no-op`, as for
 *     a covered row (nothing counted, no kill and no launch);
 *   - a latch: `latched`;
 *   - a row the rule read gone, or a `get` it had refused: `retrying`, with
 *     one line: nothing is launched in this attempt (the launch never goes
 *     over a row it has not read since), and the retry timer, armed in
 *     pending-only mode by the step, owns the persona, so its next retry
 *     reads the row and hands a gone row to the restart path's decision;
 *   - the own-launch branch's abort: `sequence-waiting` for a sequence it
 *     started, `latched` for a latch, `no-op` otherwise.
 * Logs the gone line only. Pure but for that line.
 */
function ladderResultOfRuleAnswer(key: string, ref: string, ruled: PendingRowRuleAnswer): SpawnPersonaResult {
  switch (ruled.kind) {
    case PENDING_ROW_RULE_REFUSAL:
    case PENDING_ROW_RULE_HELD:
    case PENDING_ROW_RULE_LIVE:
      return { key, action: 'no-op' }
    case PENDING_ROW_RULE_LATCHED:
      return { key, action: 'latched' }
    case PENDING_ROW_RULE_GONE:
    case PENDING_ROW_RULE_READ_REFUSED:
      console.error(ladderRuleRetryingLine(ref, describePendingRowRuleAnswer(ruled)))
      return { key, action: SPAWN_ACTION_RETRYING }
    case PENDING_ROW_RULE_RELAUNCH:
      switch (ruled.answer.kind) {
        case PENDING_ROW_RELAUNCH_SEQUENCE_STARTED:
          return { key, action: 'sequence-waiting' }
        case PENDING_ROW_RELAUNCH_LATCHED:
          return { key, action: 'latched' }
        case PENDING_ROW_RELAUNCH_KEPT:
          return { key, action: 'no-op' }
      }
  }
}

/** The ladder's line when the pending-row rule at its `pending` step read the row gone, or its `get` was refused: nothing launched now; the retry timer owns the persona. */
export function ladderRuleRetryingLine(ref: string, answer: string): string {
  return `[slack] spawnForPersona: the pending-row rule for ${ref} answered ${answer} — nothing launched in this attempt; answering ${SPAWN_ACTION_RETRYING}, its retry timer owns it and its next retry reads the row (b.jg5 SRJ-410, SRJ-1015)`
}

/**
 * The read-and-step entry (b.jg5 SRJ-409, SRJ-411) for persona `persona`, for
 * a caller that holds only a `status` read showing its row `pending` (the
 * restart path's deferral, `deferPendingRow` in `src/server.ts`, and the
 * pending-only retry, `retryPendingRowStep`): one `get` of its own row
 * through the shared own-row read (`readPersonaOwnRow` at
 * `PENDING_ROW_STEP_GET_SITE`, so its note latch, its launch-start latch,
 * its retired-entry clear and its old-life read entry apply), then:
 *   - the read latched the persona (or found it latched after the read):
 *     `latched`, nothing more;
 *   - `ErrSpawnNotFound`: `no-row`; any other refused read: `refused`, with
 *     the error (an UNAVAILABLE armed its cause inside an attempt);
 *   - a state other than `pending`: `not-pending`, with the state read;
 *   - `pending`: the one pending-row step (`pendingRowStep`): covered or
 *     undecided, the timer armed in pending-only mode (a covered answer
 *     carries the row the `get` read, for the pending-row rule's run at a
 *     retry, `runPendingRowRuleAtRetry`); not covered, one
 *     start of the live-row sequence through the start entry
 *     (`startRecoverySequence`: seeded `pending`, entry at step 1, the
 *     conversation not kept, the retired-key flag set for a retired key's
 *     old life and by the start entry for any recorded key, ending in a
 *     launch, alert context `recovery`), answering the start entry's
 *     answer; no launch call of its own. A sequence it starts meets the
 *     old-life hold gate at its step-6 launch.
 * Never starts an approver, kills or launches; no new `getClient()` site.
 * Never throws.
 */
export async function readAndStepPendingRow(persona: Persona): Promise<PendingRowStepAnswer> {
  const { key } = persona
  const ref = personaRef(persona)
  const read = await readPersonaOwnRow(key, { ...PENDING_ROW_STEP_GET_SITE, ref })
  if (read.kind === OWN_ROW_READ_LATCHED) return { kind: PENDING_ROW_STEP_LATCHED }
  if (read.kind === OWN_ROW_READ_ABSENT) return { kind: PENDING_ROW_STEP_NO_ROW }
  if (read.kind === OWN_ROW_READ_REFUSED) return { kind: PENDING_ROW_STEP_REFUSED, error: read.error }
  if (read.latched) return { kind: PENDING_ROW_STEP_LATCHED }
  if (latchedAfterOwnRowRead(key, PENDING_ROW_STEP_GET_SITE.site, PENDING_ROW_STEP_GET_SITE.what, ref)) {
    return { kind: PENDING_ROW_STEP_LATCHED }
  }
  const { row } = read
  if (row.state !== AGENT_DIRECTOR_PENDING_STATE) return { kind: PENDING_ROW_STEP_NOT_PENDING, state: row.state }
  const { cover, armed } = pendingRowStep(persona, ref, row, true)
  switch (cover.answer) {
    case PENDING_ROW_NO_LAUNCH_START:
      return { kind: PENDING_ROW_STEP_LATCHED }
    case PENDING_ROW_COVERED:
      return { kind: PENDING_ROW_COVERED, armed, row: pendingRowRuleRowOf(row) }
    case PENDING_ROW_UNDECIDED:
      return { kind: PENDING_ROW_UNDECIDED, reason: cover.reason, armed }
    case PENDING_ROW_NOT_COVERED: {
      const { startAnswer } = startRecoverySequence(
        { persona, ref },
        latchRowStateRead(AGENT_DIRECTOR_PENDING_STATE),
        false,
        cover.reason === PENDING_ROW_REASON_RETIRED_OLD_LIFE,
      )
      console.error(`${PENDING_ROW_STEP_LOG_PREFIX} ${ref}'s live-row sequence start answered ${startAnswer}; no other call, nothing counted (b.jg5 SRJ-411, SRJ-706)`)
      return { kind: PENDING_ROW_NOT_COVERED, reason: cover.reason, startAnswer }
    }
  }
}

/**
 * The pending-only retry's pending-row step (`FullModeRetryDeps.stepPendingRow`,
 * bound in `main()`; b.jg5 SRJ-409, SRJ-411, SRJ-410) for persona `key`, whose
 * applied persona is `persona`: the read-and-step entry
 * (`readAndStepPendingRow`), its answer mapped for the retry action:
 *   - covered (the timer armed pending-only): the pending-row rule's one run
 *     of this retry on the row the `get` read (`runPendingRowRuleAtRetry`),
 *     its answer mapped by `pendingStepOfRuleAnswer`; with no rule
 *     installed, `kept`;
 *   - undecided (the timer armed pending-only, no rule run) or a refused
 *     read: `kept`;
 *   - not covered with the sequence started or already running:
 *     `sequence-started`; with nothing started (`held`, `closed`,
 *     `not-installed`): `kept`;
 *   - latched: `latched`;
 *   - another state: `row` with that state; no row: `row` with
 *     `UNAVAILABLE_RETRY_ROW_ABSENT`.
 * A persona that is not applied (`persona` undefined, or another key's)
 * reads nothing and answers `kept`; the retry action stops for it on its
 * own check. Never throws.
 */
export async function retryPendingRowStep(key: string, persona: Persona | undefined): Promise<UnavailableRetryPendingStep> {
  if (persona === undefined || persona.key !== key) return { kind: UNAVAILABLE_RETRY_PENDING_STEP_KEPT }
  const answer = await readAndStepPendingRow(persona)
  switch (answer.kind) {
    case PENDING_ROW_COVERED: {
      const ruled = await runPendingRowRuleAtRetry(persona, answer.row)
      return ruled === undefined ? { kind: UNAVAILABLE_RETRY_PENDING_STEP_KEPT } : pendingStepOfRuleAnswer(ruled)
    }
    case PENDING_ROW_UNDECIDED:
    case PENDING_ROW_STEP_REFUSED:
      return { kind: UNAVAILABLE_RETRY_PENDING_STEP_KEPT }
    case PENDING_ROW_NOT_COVERED:
      return answer.startAnswer === LIVE_ROW_START_STARTED || answer.startAnswer === LIVE_ROW_START_ALREADY_RUNNING
        ? { kind: UNAVAILABLE_RETRY_PENDING_STEP_SEQUENCE_STARTED }
        : { kind: UNAVAILABLE_RETRY_PENDING_STEP_KEPT }
    case PENDING_ROW_STEP_LATCHED:
      return { kind: UNAVAILABLE_RETRY_PENDING_STEP_LATCHED }
    case PENDING_ROW_STEP_NOT_PENDING:
      return { kind: UNAVAILABLE_RETRY_PENDING_STEP_ROW, state: answer.state }
    case PENDING_ROW_STEP_NO_ROW:
      return { kind: UNAVAILABLE_RETRY_PENDING_STEP_ROW, state: UNAVAILABLE_RETRY_ROW_ABSENT }
  }
}

// ---------------------------------------------------------------------------
// The pending-row rule: its production dependencies, its one instance and
// where it runs (b.jg5 SRJ-410, SRJ-404, SRJ-303)
// ---------------------------------------------------------------------------

/** The row read the pending-row rule runs on, from a row read `pending` (its state and raw launch start). Pure. */
function pendingRowRuleRowOf(row: PendingRowFields): PendingRowRuleRow {
  return { state: row.state, launchStartedAt: pendingLaunchStartOf(row) }
}

/** What `main()` gives the pending-row rule's dependency builder (`buildPendingRowRuleDeps`). */
export interface PendingRowRuleDepsInput {
  /** The applied persona with this key, read at each call (production: `getAppliedPersona`); the old-life hold gate reads it. */
  readonly appliedPersona: (key: string) => Persona | undefined
  /**
   * The server's one notice episodes instance, the stuck-launch posters' and
   * the abort's per-episode state's (production: `main()`'s notice
   * episodes). Absent: the stuck-launch episodes installed with
   * `setStuckLaunchEpisodes`, read at each post.
   */
  readonly episodes?: StuckLaunchPostEpisodes & StuckLaunchAbortEpisodes
  /** Receives the rule's lines and its poster's (default: the server log). */
  readonly log?: (line: string) => void
  /** The wait between the abort kill's tries (default: `KILL_RETRY_SYSTEM_CLOCK`; b.jg5 SRJ-702, SRJ-412). */
  readonly killRetryWait?: KillRetryWait
  /** The kill-failure alerts the abort kill raises through (default: the installed ones, `setKillFailureAlerts`). */
  readonly killFailureAlerts?: KillFailureAlerts
}

/**
 * Whether persona `key`'s working directory is held for an old life, for
 * the pending-row rule's gate (b.jg5 SRJ-810): its own row held
 * (`isOwnRowOldLifeHeld`), or a hold on its working directory, through the
 * old-life hold step the restart path's hook uses (`oldLifeHoldStep`, at
 * `PENDING_ROW_RULE_SITE`), which records the persona as waiting, starts the
 * hold's wait and arms its retry timer, as SRJ-810 does for any persona it
 * holds back. A persona that is not applied is not held here. Never throws.
 */
function pendingRowRuleHeldForOldLife(key: string, appliedPersona: (key: string) => Persona | undefined): boolean {
  if (isOwnRowOldLifeHeld(key)) return true
  const persona = appliedPersona(key)
  return persona !== undefined && oldLifeHoldStep(persona, PENDING_ROW_RULE_SITE)
}

/** The step-2 `find-missing` run of the pending-row rule for persona `key`: one bypassing run, its key as the next-step `get`, read against `pending`. Never throws. */
async function runPendingRowRuleFindMissing(key: string): Promise<PendingRowRunPlacement> {
  const answer = await bypassingFindMissingSweep(key, PENDING_ROW_RULE_SITE, key)
  if (answer === FIND_MISSING_REFUSED) return PENDING_ROW_RUN_REFUSED
  if (answer === FIND_MISSING_LATCHED) return PENDING_ROW_RUN_LATCHED
  if (answer === undefined) return PENDING_ROW_RUN_FAILED
  switch (readFindMissingRow(answer, personaInstanceId(key), AGENT_DIRECTOR_PENDING_STATE)) {
    case FIND_MISSING_ROW_MARKED_MISSING:
      return PENDING_ROW_RUN_MARKED_MISSING
    case FIND_MISSING_ROW_LEFT_LIVE:
      return PENDING_ROW_RUN_LEFT_LIVE
    case FIND_MISSING_ROW_NOT_JUDGED:
      return PENDING_ROW_RUN_NOT_JUDGED
    case FIND_MISSING_ROW_JUDGED_ALIVE:
      return PENDING_ROW_RUN_JUDGED_ALIVE
  }
}

/** The step-2 `get` of the pending-row rule: one `get` of persona `key`'s own row through the shared own-row read (its note, launch-start and UNUSABLE NAME latches applying). Never throws. */
async function readPendingRowRuleRow(key: string, ref: string): Promise<PendingRowRuleGet> {
  const read = await readPersonaOwnRow(key, { ...PENDING_ROW_RULE_GET_SITE, ref })
  switch (read.kind) {
    case OWN_ROW_READ_ROW:
      if (read.latched) return { kind: PENDING_ROW_GET_LATCHED }
      return { kind: PENDING_ROW_GET_ROW, state: read.row.state, launchStartedAt: pendingLaunchStartOf(read.row) }
    case OWN_ROW_READ_ABSENT:
      return { kind: PENDING_ROW_GET_ABSENT }
    case OWN_ROW_READ_LATCHED:
      return { kind: PENDING_ROW_GET_LATCHED }
    case OWN_ROW_READ_REFUSED:
      return { kind: PENDING_ROW_GET_REFUSED, error: read.error }
  }
}

/** The line for a held post with no episodes instance to post through: nothing posted. */
export function pendingRowRuleNoEpisodesLine(key: string): string {
  return `[slack] pending-row: persona=${key} stuck-launch held text not posted — no notice episodes are installed (b.jg5 SRJ-1017)`
}

/** The line for a relaunching post with no episodes instance to post through: nothing posted, and so no abort. */
export function pendingRowRuleNoEpisodesRelaunchingLine(key: string): string {
  return `[slack] pending-row: persona=${key} stuck-launch relaunching text not posted — no notice episodes are installed, so no abort is made (b.jg5 SRJ-1017, SRJ-412)`
}

// ---------------------------------------------------------------------------
// The abort of CSCB's own stuck launch: its kill, its approver stop and its
// sequence (b.jg5 SRJ-412)
// ---------------------------------------------------------------------------

/** The abort kill's site: the head of its tries', reads' and latch lines (`[slack] <site>: …`). */
export const STUCK_LAUNCH_ABORT_SITE = 'pendingRowRule stuck-launch abort'

/** What `abortKillOwnStuckLaunch` is given. */
export interface StuckLaunchAbortKillOptions {
  /** The wait between tries (production: `KILL_RETRY_SYSTEM_CLOCK`; a test passes its fake clock). */
  readonly clock: KillRetryWait
  /** The kill-failure alerts (default: the installed ones, `setKillFailureAlerts`). */
  readonly alerts?: KillFailureAlerts
}

/**
 * The abort's one checked kill of persona `key`'s own row (b.jg5 SRJ-412,
 * SRJ-110, SRJ-702, SRJ-704, SRJ-316), inside the launch or recovery attempt
 * the pending-row rule runs in:
 *   - the bounded retry over the checked kill (`retryPersonaKill`): the row
 *     read `pending` (`killRetrySeedOfState`), so up to 3 tries 2 s apart on
 *     UNAVAILABLE (SRJ-702), each a tmux-touching kill (`rowReadLive`), the
 *     shared own-row `status` read between tries (a CONFIG answer there
 *     raises `ad-config-malformed` and, the row last read `pending`, ends the
 *     tries with no further kill, SRJ-316), the server's keep-going check
 *     (P latched, not up or torn down, or a shutdown, stop the tries), on
 *     `options.clock`. None of the old-life wait's or the CLI's options
 *     (`holdEnded`, `configReadEndsTries`, `goneIsFailure`) applies, and the
 *     restart path's one-try seed is never used;
 *   - a CONFLICT ("not this launch's session") latches P through the latch's
 *     CONFLICT entry with the refused operation "P's next check or recovery"
 *     and the recorded state `pending`, and an UNUSABLE NAME through the
 *     unusable-name entry (`latchOnKillOutcomeAt`): never tried again;
 *   - then the kill-failure alert the tries decided
 *     (`raisePersonaKillFailureAlert`, context 'stuck-launch abort'): the
 *     ordinary version for `ErrTmuxKillFailed` after its tries, the survivor
 *     version after a survivor-naming failure that a success followed, and,
 *     after a survivor-naming failure, the ordinary version on any
 *     non-success; for tries SRJ-702's stop rule stopped, neither version,
 *     only its one line (and, for P removed during the tries, its
 *     `persona-kill-failed` entry with no alert text).
 * Answers, by class and name (`src/ad-error-class.ts`):
 *   - succeeded, with `kill_sent` from agent-director's result (any success
 *     form: `kill_sent` true or false, the row or the session gone, the row
 *     read finished between tries);
 *   - kill-failed: `ErrTmuxKillFailed` stands, its tries not stopped;
 *   - latched: CONFLICT or UNUSABLE NAME latched P, a read between tries
 *     latched it, or it was latched when its tries stopped;
 *   - try-later: any other UNAVAILABLE, ENVIRONMENT (which raised
 *     `tmux-unavailable`), CONFIG (which raised `ad-config-malformed`) or
 *     UNCLASSIFIED (reported by the kill as any in an attempt);
 *   - stopped: tries SRJ-702's stop rule stopped (P not latched), or an
 *     `ErrInvalidFlags` whose version re-check stops the server.
 * No delete and no launch follows any answer here. No new `getClient()`
 * site: every call goes through `withOutageDetection` inside the shared
 * entries. Never throws or rejects.
 */
export async function abortKillOwnStuckLaunch(
  key: string,
  ref: string,
  options: StuckLaunchAbortKillOptions,
): Promise<StuckLaunchAbortKillAnswer> {
  const site = STUCK_LAUNCH_ABORT_SITE
  const retried = await retryPersonaKill(key, {
    rowReadLive: true,
    lastRead: killRetrySeedOfState(AGENT_DIRECTOR_PENDING_STATE),
    site,
    ref,
    clock: options.clock,
  })
  const { outcome } = retried
  const description = describeKillOutcome(outcome)
  const raise = (): void =>
    raisePersonaKillFailureAlert(key, retried, site, ref, KILL_FAILURE_CONTEXT_STUCK_LAUNCH_ABORT, options.alerts)
  if (killRetryStopped(retried)) {
    raise()
    const latched = retried.end === KILL_RETRY_END_READ_LATCHED || personaLatchedNow(key)
    return latched
      ? { kind: STUCK_LAUNCH_ABORT_KILL_LATCHED, description }
      : { kind: STUCK_LAUNCH_ABORT_KILL_STOPPED, description }
  }
  if (killOutcomeStopsServer(outcome)) {
    raise()
    return { kind: STUCK_LAUNCH_ABORT_KILL_STOPPED, description }
  }
  if (outcome.kind !== KILL_OUTCOME_NOT_KILLED) {
    // SRJ-702, SRJ-704: a survivor version is raised before the sequence.
    raise()
    return outcome.kind === KILL_OUTCOME_KILLED && outcome.killSent !== undefined
      ? { kind: STUCK_LAUNCH_ABORT_KILL_SUCCEEDED, killSent: outcome.killSent, description }
      : { kind: STUCK_LAUNCH_ABORT_KILL_SUCCEEDED, description }
  }
  // SRJ-501, SRJ-512: the outcome's own handling first, then the alert (SRJ-704).
  const latched = await latchOnKillOutcomeAt(key, outcome, site, ref, latchRowStateRead(AGENT_DIRECTOR_PENDING_STATE))
  raise()
  if (latched) return { kind: STUCK_LAUNCH_ABORT_KILL_LATCHED, description }
  if (outcome.errorClass === AD_ERROR_CLASS_UNAVAILABLE && outcome.killFailed) return { kind: STUCK_LAUNCH_ABORT_KILL_FAILED, description }
  return { kind: STUCK_LAUNCH_ABORT_KILL_TRY_LATER, errorClass: outcome.errorClass, description }
}

/**
 * Stop persona `key`'s running dialog approver for the abort of its own
 * stuck launch (b.jg5 SRJ-404, SRJ-412; hatch A3), before the abort's kill:
 * with `APPROVER_STOP_STUCK_LAUNCH_ABORT`, a stop outside the stops the
 * pending-row rule runs after and that arm the retry timer
 * (`APPROVER_STOPS_THAT_ARM`), so no rule run follows it. Only a running
 * approver is stopped (`isDialogApproverRunning`): no coming approver of a
 * launch in flight is cancelled. Resolves once it has stopped, true when one
 * ran. Never rejects.
 */
export async function stopApproverForStuckLaunchAbort(key: string): Promise<boolean> {
  if (!isDialogApproverRunning(key)) return false
  return stopDialogApprover(key, APPROVER_STOP_STUCK_LAUNCH_ABORT)
}

/**
 * Start persona `key`'s live-row sequence after the abort's own kill (b.jg5
 * SRJ-412, SRJ-705, SRJ-706) through the start entry
 * (`startLiveRowSequence`): entry at step 2 (`LIVE_ROW_SEQUENCE_ENTRY_GET`),
 * the state last read `pending`, the conversation kept (a row with a session
 * id ends in `resume`, any other in a reuse spawn), ending in a launch, alert
 * context 'stuck-launch abort'. The start entry sets the retired-key flag
 * for a recorded key and answers held for a persona held on
 * `ErrInvalidFlags`. The sequence's launch passes `isStartup: false`, as
 * every sequence launch does (`launchForLiveRowSequence`). Answers whether
 * it started, with the start entry's answer otherwise. Never throws.
 */
export function startStuckLaunchAbortSequence(key: string, ref: string): StuckLaunchAbortSequenceStart {
  try {
    const answer = startLiveRowSequence({
      key,
      ref,
      instanceId: personaInstanceId(key),
      lastReadState: AGENT_DIRECTOR_PENDING_STATE,
      entryStep: LIVE_ROW_SEQUENCE_ENTRY_GET,
      keepsConversation: true,
      retiredKey: false,
      launches: true,
      alertContext: KILL_FAILURE_CONTEXT_STUCK_LAUNCH_ABORT,
    })
    return answer === LIVE_ROW_START_STARTED
      ? { kind: STUCK_LAUNCH_ABORT_SEQUENCE_STARTED }
      : { kind: STUCK_LAUNCH_ABORT_SEQUENCE_NOT_STARTED, why: answer }
  } catch (err) {
    return { kind: STUCK_LAUNCH_ABORT_SEQUENCE_NOT_STARTED, why: `its start failed: ${describeThrownValue(err)}` }
  }
}

/**
 * The pending-row rule's production dependencies (b.jg5 SRJ-410), bound to
 * the shared entries, so `main()` and the recovery harness compose the rule
 * identically:
 *   - the session manager's injected clock (`_setNow`) and the log;
 *   - the latch's latched query (`personaLatchedNow`), the "blocks a retry"
 *     causes (`personaRetryBlockCause`, P's own launch left out from its
 *     ladder) and the old-life hold gate (`isOwnRowOldLifeHeld`,
 *     `oldLifeHoldStep`);
 *   - the dialog approver's running query (`isDialogApproverRunning`) and
 *     its startup-dialog recognition (`paneShowsStartupDialog`);
 *   - the record of a launch whose `send-keys` met `ErrSpawnNotInteractive`
 *     (`launchMetSendKeysNotInteractive`, `recordSendKeysNotInteractive`);
 *   - the lap's `read-pane` (`readPendingRowLapPane`, the shared reader with
 *     `allow_pending`) and Enter (`sendPendingRowLapEnter`);
 *   - the bypassing `find-missing` run (`bypassingFindMissingSweep`, P's key
 *     as its next-step `get`, read with `readFindMissingRow`) and the shared
 *     own-row `get` (`readPersonaOwnRow`);
 *   - the outage flags (`getOutageFlags`: `tmux-unavailable`,
 *     `ad-config-malformed`);
 *   - the held text's poster (`postStuckLaunchHeld`) over the one episodes
 *     instance;
 *   - step 3's own-launch slot (b.jg5 SRJ-412): one abort instance
 *     (`createStuckLaunchAbort`, holding the per-episode abort state) over
 *     the own-launch query (`isCscbOwnLaunch`), the latched query and the
 *     outage flags, the relaunching text's poster
 *     (`postStuckLaunchRelaunching`, B in effect at the post) and the
 *     stuck-launch episode's close hook over the same episodes instance, the
 *     approver's stop (`stopApproverForStuckLaunchAbort`), the abort kill
 *     (`abortKillOwnStuckLaunch`, on `input.killRetryWait` with
 *     `input.killFailureAlerts`) and the sequence's start at step 2
 *     (`startStuckLaunchAbortSequence`).
 * Every agent-director call goes through `withOutageDetection` inside those
 * entries; there is no new `getClient()` site. The builder reads nothing and
 * starts nothing when called.
 */
export function buildPendingRowRuleDeps(input: PendingRowRuleDepsInput): PendingRowRuleDeps {
  const log = input.log ?? ((line: string): void => console.error(line))
  const tmuxUnavailableRaised = (key: string): boolean => getOutageFlags(key).has('tmux-unavailable')
  const configMalformedRaised = (key: string): boolean => getOutageFlags(key).has('ad-config-malformed')
  const episodesNow = (): (StuckLaunchPostEpisodes & StuckLaunchAbortEpisodes) | undefined => input.episodes ?? stuckLaunchEpisodes
  const ownLaunch = createStuckLaunchAbort({
    log,
    isOwnLaunch: (key, launchStart) => isCscbOwnLaunch(key, launchStart),
    isLatched: (key) => personaLatchedNow(key),
    isTmuxUnavailableRaised: tmuxUnavailableRaised,
    isConfigMalformedRaised: configMalformedRaised,
    postRelaunching: (key) => {
      const episodes = episodesNow()
      if (episodes === undefined) {
        log(pendingRowRuleNoEpisodesRelaunchingLine(key))
        return STUCK_LAUNCH_POST_FAILED
      }
      return postStuckLaunchRelaunching({ episodes, tmuxUnavailableRaised, log }, key, adLaunchBoundMsInEffect())
    },
    episodes: {
      whenClosed: (key, kind, dispose) => episodesNow()?.whenClosed(key, kind, dispose) === true,
    },
    stopApprover: (key) => stopApproverForStuckLaunchAbort(key),
    abortKill: (key, ref) =>
      abortKillOwnStuckLaunch(key, ref, {
        clock: input.killRetryWait ?? KILL_RETRY_SYSTEM_CLOCK,
        ...(input.killFailureAlerts === undefined ? {} : { alerts: input.killFailureAlerts }),
      }),
    startSequence: (key, ref) => startStuckLaunchAbortSequence(key, ref),
  })
  return {
    now: () => _now(),
    log,
    isLatched: (key) => personaLatchedNow(key),
    retryBlockedBy: (key, withinOwnLaunch) => retryBlockCauseOf(key, withinOwnLaunch),
    isHeldForOldLife: (key) => pendingRowRuleHeldForOldLife(key, input.appliedPersona),
    isApproverRunning: (key) => isDialogApproverRunning(key),
    launchMetNotInteractive: (key, launchStart) => launchMetSendKeysNotInteractive(key, launchStart),
    recordNotInteractive: (key, launchStart) => recordSendKeysNotInteractive(key, launchStart),
    readLapPane: (key, ref) => readPendingRowLapPane(key, ref),
    paneShowsStartupDialog: (pane) => paneShowsStartupDialog(pane),
    sendLapEnter: (key, ref) => sendPendingRowLapEnter(key, ref),
    runFindMissing: (key) => runPendingRowRuleFindMissing(key),
    readRow: (key, ref) => readPendingRowRuleRow(key, ref),
    isTmuxUnavailableRaised: tmuxUnavailableRaised,
    isConfigMalformedRaised: configMalformedRaised,
    postHeld: (key, launchStart, metNotInteractive) => {
      const episodes = episodesNow()
      if (episodes === undefined) {
        log(pendingRowRuleNoEpisodesLine(key))
        return STUCK_LAUNCH_POST_FAILED
      }
      return postStuckLaunchHeld({ episodes, tmuxUnavailableRaised, log }, key, launchStart, metNotInteractive)
    },
    ownLaunch,
  }
}

/** What `main()` installs: the one pending-row rule instance and P's lifecycle serializer. */
export interface PendingRowRuleInstall {
  /** The rule, built through `createPendingRowRule` over `buildPendingRowRuleDeps`. */
  readonly rule: PendingRowRule
  /**
   * P's lifecycle serializer (production: `main()`'s `personaLifecycle.run`):
   * the rule's one run at the dialog approver's stop takes P's turn there.
   * Absent: that run starts at once, on its own.
   */
  readonly serialize?: PersonaSerialize
  /**
   * The retry action's gate before any call (`retryRunGateStop`,
   * `src/unavailable-retry.ts`; production: the same dependencies `main()`
   * gives the retry action): asked when the rule's run at a dialog
   * approver's stop starts, after its turn in P's serializer, so a run that
   * waited behind P's teardown, or finds P latched, held on
   * `ErrInvalidFlags`, not up or at the restart cap, is dropped with no call
   * (b.jg5 SRJ-404, SRJ-410, SRJ-411, SRJ-305; b.av2 SR-8.6). Absent: only
   * the shutdown drop applies there.
   */
  readonly gate?: RetryRunGateDeps
}

/**
 * The installed pending-row rule (b.jg5 SRJ-410). Production installs it in
 * `main()` beside the live-row sequence registry, before the start pass.
 * With none installed (unit tests that install none) no rule run is made:
 * the retries and the approver's stop keep the pending-only arm only, with
 * one line where a run would have been made.
 */
let pendingRowRule: PendingRowRuleInstall | undefined

/** Install the pending-row rule (production: `main()`), or remove it with undefined (b.jg5 SRJ-410). */
export function setPendingRowRule(install: PendingRowRuleInstall | undefined): void {
  pendingRowRule = install
}

/** Test-only seam: remove any installed pending-row rule. */
export function _resetPendingRowRule(): void {
  pendingRowRule = undefined
}

/** The line for a retry that would run the pending-row rule with none installed: the pending-only arm only. */
export function pendingRowRuleNotInstalledLine(ref: string): string {
  return `[slack] pending-row: ${ref}: no pending-row rule is installed — its covered pending row keeps its pending-only arm only; no lap, run or post (b.jg5 SRJ-410)`
}

/** The line for a second rule run asked in one retry of the persona's timer: none is made. */
export function pendingRowRuleAlreadyRanLine(ref: string): string {
  return `[slack] pending-row: ${ref}: the pending-row rule already ran in this retry — no second lap, run or post (b.jg5 SRJ-410)`
}

/**
 * Run the pending-row rule once for persona `persona` at a retry of its
 * retry timer (b.jg5 SRJ-410, SRJ-303), on `row`, the covered `pending` row
 * the caller's read holds: the pending-only retry's step
 * (`retryPendingRowStep`), the restart path's deferral (`deferPendingRow`,
 * `src/server.ts`) and the collision ladder's `pending` step
 * (`ladderPendingRowStep`, `withinOwnLaunch`), the not-resumable re-read
 * included. Only inside a retry of the persona's timer, in either mode
 * (`isInsideTimerRetry`): reached from any other origin (the start pass, an
 * apply's bring-up, a restart timer, a human-triggered restart, the
 * hand-off run after a pending-only stop) it answers `undefined` with no
 * call and no line, so the site keeps its pending-only arm only. At most once per retry
 * (`claimTimerRetryRuleRun`): a second site reached in the same retry gets
 * `undefined` with one line. With no rule installed, `undefined` with one
 * line. Otherwise the rule's answer. Never throws.
 */
export async function runPendingRowRuleAtRetry(
  persona: Persona,
  row: PendingRowRuleRow,
  options: { readonly withinOwnLaunch?: boolean } = {},
): Promise<PendingRowRuleAnswer | undefined> {
  const { key } = persona
  if (!isInsideTimerRetry(key)) return undefined
  const ref = personaRef(persona)
  const installed = pendingRowRule
  if (installed === undefined) {
    console.error(pendingRowRuleNotInstalledLine(ref))
    return undefined
  }
  if (!claimTimerRetryRuleRun(key)) {
    console.error(pendingRowRuleAlreadyRanLine(ref))
    return undefined
  }
  return installed.rule.run({
    key,
    ref,
    row,
    origin: PENDING_ROW_RULE_ORIGIN_RETRY,
    ...(options.withinOwnLaunch === true ? { withinOwnLaunch: true } : {}),
  })
}

/**
 * The pending-only retry's step answer for the pending-row rule's answer
 * (b.jg5 SRJ-410, SRJ-303): a refusal, the held post or a read the `get`
 * refused keep the row `pending` (`kept`: the retry is a refusal); a row
 * the rule read gone is `row` with `ended`, `missing` or absent (the retry
 * stops and hands P to the restart path's decision); a row it read live is
 * `row` with that state (the retry stops, with no call beyond that read); a
 * latch is `latched`; the own-launch branch's abort answers
 * `sequence-started` for a sequence it started, `latched` for a latch, and
 * `kept` otherwise. Pure.
 */
export function pendingStepOfRuleAnswer(answer: PendingRowRuleAnswer): UnavailableRetryPendingStep {
  switch (answer.kind) {
    case PENDING_ROW_RULE_REFUSAL:
    case PENDING_ROW_RULE_HELD:
    case PENDING_ROW_RULE_READ_REFUSED:
      return { kind: UNAVAILABLE_RETRY_PENDING_STEP_KEPT }
    case PENDING_ROW_RULE_GONE:
      return {
        kind: UNAVAILABLE_RETRY_PENDING_STEP_ROW,
        state: answer.state === LIVENESS_DEAD_ROW_NO_ROW ? UNAVAILABLE_RETRY_ROW_ABSENT : answer.state,
      }
    case PENDING_ROW_RULE_LIVE:
      return { kind: UNAVAILABLE_RETRY_PENDING_STEP_ROW, state: answer.state }
    case PENDING_ROW_RULE_LATCHED:
      return { kind: UNAVAILABLE_RETRY_PENDING_STEP_LATCHED }
    case PENDING_ROW_RULE_RELAUNCH:
      switch (answer.answer.kind) {
        case PENDING_ROW_RELAUNCH_SEQUENCE_STARTED:
          return { kind: UNAVAILABLE_RETRY_PENDING_STEP_SEQUENCE_STARTED }
        case PENDING_ROW_RELAUNCH_LATCHED:
          return { kind: UNAVAILABLE_RETRY_PENDING_STEP_LATCHED }
        case PENDING_ROW_RELAUNCH_KEPT:
          return { kind: UNAVAILABLE_RETRY_PENDING_STEP_KEPT }
      }
  }
}

/**
 * The line of the pending-row rule's one run at persona `ref`'s dialog
 * approver's stop (b.jg5 SRJ-404, SRJ-410): the stop's reason and the
 * rule's answer:
 *
 *   [slack] pending-row: <ref> rule (approver-stop): its dialog approver stopped (<reason>) with the row pending — the run answered <answer> (b.jg5 SRJ-404, SRJ-410)
 *
 * Pure.
 */
export function pendingRowRuleApproverStopLine(ref: string, reason: ApproverStopReason, answer: PendingRowRuleAnswer): string {
  return `[slack] pending-row: ${ref} rule (${PENDING_ROW_RULE_ORIGIN_APPROVER_STOP}): its dialog approver stopped (${reason}) with the row pending — the run answered ${describePendingRowRuleAnswer(answer)} (b.jg5 SRJ-404, SRJ-410)`
}

/** The line for a queued approver-stop run dropped because the server is shutting down: no call. */
export function pendingRowRuleApproverStopDroppedLine(ref: string): string {
  return `[slack] pending-row: ${ref} rule (${PENDING_ROW_RULE_ORIGIN_APPROVER_STOP}): dropped — the server is shutting down; no call (b.jg5 SRJ-404)`
}

/**
 * The line for a queued approver-stop run dropped at its start by the retry
 * action's gate (`retryRunGateStop`): `why` is the gate's stop reason (P not
 * in the applied configuration, latched, held on `ErrInvalidFlags`, not up,
 * at the restart cap, the server shutting down) or the gate's failure. No
 * call:
 *
 *   [slack] pending-row: <ref> rule (approver-stop): dropped — <why>; no call (b.jg5 SRJ-404, SRJ-410, SRJ-305)
 */
export function pendingRowRuleApproverStopGatedLine(ref: string, why: string): string {
  return `[slack] pending-row: ${ref} rule (${PENDING_ROW_RULE_ORIGIN_APPROVER_STOP}): dropped — ${why}; no call (b.jg5 SRJ-404, SRJ-410, SRJ-305)`
}

/** The `why` of `pendingRowRuleApproverStopGatedLine` when the gate itself threw: taken as stopped (fail safe). */
export function pendingRowRuleApproverStopGateFailedWhy(described: string): string {
  return `its gate failed (${described}), taken as stopped`
}

/** The line for an approver stop that would run the rule with none installed: the pending-only arm only. */
export function pendingRowRuleApproverStopNotInstalledLine(ref: string, reason: ApproverStopReason): string {
  return `[slack] pending-row: ${ref}: its dialog approver stopped (${reason}) with the row pending, and no pending-row rule is installed — the pending-only arm only; no lap, run or post (b.jg5 SRJ-404, SRJ-410)`
}

/**
 * At the stop of persona `key`'s registered approver (after it has left the
 * registry and its pending-only arm, `armAfterApproverStop`), with `reason` and the
 * approver's state `run` (b.jg5 SRJ-404, SRJ-410; a loop that threw,
 * `failed`, is in the set too): when the reason is one after which the rule runs
 * (`approverStopArmsPendingRow`, `APPROVER_STOPS_THAT_ARM`: B or the test
 * cap, GONE, not interactive, tmux unavailable, superseded, failed; never
 * shutdown, a latch, the key's retired-key recording, a teardown or the
 * stuck-launch abort) and the
 * approver's last `status` read gave the row `pending` with a launch start,
 * one rule run for P is queued in P's lifecycle serializer turn
 * (`PendingRowRuleInstall.serialize`), not awaited by the approver. It runs
 * as a recovery attempt of its own (`runDetachedRecoveryAttempt`; hatch A2:
 * its UNAVAILABLE arms, a tmux-touching call's UNAVAILABLE starts
 * `tmux-unresponsive`, its UNCLASSIFIED opens an episode), on that last
 * read, exempt from the retry timer's cadence. When it starts, a run after
 * shutdown began, or one the retry action's gate stops
 * (`PendingRowRuleInstall.gate`: P not applied, latched, held on
 * `ErrInvalidFlags`, not up, at the cap), is dropped with one line and no
 * call; then the rule's own gates apply. Its answer is logged in one line; a gone row is left to the timer
 * the stop's arm armed. No run for any other reason, for a last read in another
 * state, with none, or with no launch start. With no rule installed, one
 * line and nothing more. Never throws.
 */
function queueApproverStopRuleRun(key: string, ref: string, reason: ApproverStopReason, run: ApproverRun): void {
  try {
    if (!approverStopArmsPendingRow(reason)) return
    if (run.lastStateRead !== AGENT_DIRECTOR_PENDING_STATE) return
    const launchStartedAt = run.lastLaunchStartedAt
    if (parseLaunchStart(launchStartedAt) === undefined) return
    const installed = pendingRowRule
    if (installed === undefined) {
      console.error(pendingRowRuleApproverStopNotInstalledLine(ref, reason))
      return
    }
    const row: PendingRowRuleRow = { state: AGENT_DIRECTOR_PENDING_STATE, launchStartedAt }
    const operation = (): Promise<void> => approverStopRuleRun(key, ref, reason, row, installed)
    const queued = installed.serialize === undefined ? operation() : installed.serialize(key, operation)
    void queued.catch((err: unknown) => {
      console.error(pendingRowRuleFailedLine(ref, PENDING_ROW_RULE_ORIGIN_APPROVER_STOP, describeThrownValue(err)))
    })
  } catch {
    /* a queued run never changes how the approver ended */
  }
}

/**
 * The queued approver-stop run itself (`queueApproverStopRuleRun`), when its
 * turn starts: dropped with one line after shutdown began
 * (`pendingRowRuleApproverStopDroppedLine`), or when the installed gate
 * (`PendingRowRuleInstall.gate`, through `retryRunGateStop`) answers a stop
 * reason or throws (`pendingRowRuleApproverStopGatedLine`): no `read-pane`,
 * Enter, `find-missing`, `get`, post or kill for a persona removed, latched,
 * held, not up or at the cap. Else one rule run as a recovery attempt, and
 * its line.
 */
async function approverStopRuleRun(
  key: string,
  ref: string,
  reason: ApproverStopReason,
  row: PendingRowRuleRow,
  installed: PendingRowRuleInstall,
): Promise<void> {
  if (approversClosed) {
    console.error(pendingRowRuleApproverStopDroppedLine(ref))
    return
  }
  const gate = installed.gate
  if (gate !== undefined) {
    let why: string | undefined
    try {
      why = retryRunGateStop(gate, key)
    } catch (err) {
      why = pendingRowRuleApproverStopGateFailedWhy(describeThrownValue(err))
    }
    if (why !== undefined) {
      console.error(pendingRowRuleApproverStopGatedLine(ref, why))
      return
    }
  }
  const { rule } = installed
  const ruled = await runDetachedRecoveryAttempt(key, () =>
    rule.run({ key, ref, row, origin: PENDING_ROW_RULE_ORIGIN_APPROVER_STOP }),
  )
  console.error(pendingRowRuleApproverStopLine(ref, reason, ruled))
}

// ---------------------------------------------------------------------------
// A resume site's replacement (b.jg5 SRJ-707, SRJ-609, SRJ-611)
// ---------------------------------------------------------------------------

/**
 * The line of a resume site's replacement that read the row again first
 * (`replaceAtResumeSite`; b.jg5 SRJ-609, SRJ-611, SRJ-707):
 *   `[slack] spawnForPersona: replacing the row of <ref> (<why>; last read <state>; <describeDeadEvidence>) — the path holds no dead evidence, so the row is read again first: re-read: <re-read> — <outcome> (b.jg5 SRJ-609, SRJ-611, SRJ-707)`
 */
export function replaceRereadLine(
  ref: string,
  replacing: string,
  lastRead: LatchRowState,
  evidence: CarriedDeadEvidence,
  reread: PersonaRowReread,
  outcome: string,
): string {
  return `[slack] spawnForPersona: replacing the row of ${ref} (${replacing}; last read ${describeLatchRowState(lastRead)}; ${describeDeadEvidence(evidence)}) — the path holds no dead evidence, so the row is read again first: re-read: ${describePersonaRowReread(reread)} — ${outcome} (b.jg5 SRJ-609, SRJ-611, SRJ-707)`
}

/** What the re-read before a resume site's replacement is called in its lines. */
export const REPLACE_REREAD_WHAT = 'get before replacing'

/** The outcome of a refused re-read before a resume site's replacement. */
export const REPLACE_REREAD_REFUSED_OUTCOME = 'the read was refused: answering the refusal result; nothing more is called'

/** The outcome of a finished re-read before a resume site's replacement. */
export const REPLACE_REREAD_FINISHED_OUTCOME = "the row is finished: the replace step's reuse spawn of the same id"

/** The outcome of a `pending` re-read before a resume site's replacement. */
export const REPLACE_REREAD_PENDING_OUTCOME = "a launch in progress: no live-row sequence of its own; the ladder's pending step decides"

/**
 * A replacement at `resumeOrFreshSpawn` (`replacing` says why:
 * `resume_enabled` false, a `config_dir` label missing or different; b.jg5
 * SRJ-707), deciding on `lastRead`, the row state the path last read, and
 * the dead evidence the path holds (`deadEvidence`). A dead-session verdict
 * that is not dead evidence (`row-not-interactive`, or none carried) never
 * by itself leads to a kill, a delete or a live-row sequence (b.jg5 SRJ-609,
 * SRJ-611): the row may have finished since, or be `pending` under another
 * process's launch, so its earlier live read is not acted on.
 *   - Last read finished (`ended`, `missing`, no row), or the path holds
 *     dead evidence: the replace step as it is (`replacePersonaRow`): a
 *     finished row's reuse spawn of the same id; a live row's live-row
 *     sequence, with the conversation not kept, ending in that reuse spawn.
 *   - Last read live and no dead evidence: one re-read of the row through
 *     the shared own-row read (`rereadPersonaRow`, its latch and error rows
 *     applying), and the fresh state decides; this never starts the
 *     sequence itself:
 *       - the read latched the persona: `latched`;
 *       - the read was refused: the refusal result (`failed`; the `get`
 *         armed its read-error cause, so the launch answers `retrying`);
 *       - `ended`, `missing` or no row: the replace step with the re-read
 *         state, so its reuse spawn of the same id;
 *       - `pending`: the ladder's `pending` step (`ladderPendingRowStep`): a
 *         covered row is left (`no-op`, the persona's retry timer armed in
 *         pending-only mode); a row that is not covered (a
 *         `config_dir` mismatch, SRJ-411) gets SRJ-411's sequence there;
 *       - any other live state, or a state CSCB does not know: the lost
 *         race (`lostRaceAtLadder`): nothing killed, deleted or launched,
 *         the lost-race cause armed, `retrying`.
 * One line per re-read (`replaceRereadLine`). Never throws.
 */
async function replaceAtResumeSite(
  run: LadderRun,
  lastRead: LatchRowState,
  replacing: string,
  deadEvidence: CarriedDeadEvidence,
): Promise<SpawnPersonaResult> {
  if (lastReadIsFinished(lastRead) || isDeadEvidence(deadEvidence.source)) return replacePersonaRow(run, lastRead, replacing)
  const { persona, ref } = run
  const { key } = persona
  const reread = await rereadPersonaRow(key, ref, 'spawnForPersona', REPLACE_REREAD_WHAT)
  const log = (outcome: string): void => {
    console.error(replaceRereadLine(ref, replacing, lastRead, deadEvidence, reread, outcome))
  }
  switch (reread.kind) {
    case ROW_REREAD_LATCHED:
      log(REREAD_LATCHED_OUTCOME)
      return { key, action: 'latched' }
    case ROW_REREAD_REFUSED:
      log(REPLACE_REREAD_REFUSED_OUTCOME)
      return { key, action: 'failed' }
    case ROW_REREAD_FINISHED:
      log(REPLACE_REREAD_FINISHED_OUTCOME)
      return replacePersonaRow(run, reread.lastRead, replacing)
    case ROW_REREAD_PENDING:
      log(REPLACE_REREAD_PENDING_OUTCOME)
      return ladderPendingRowStep(run, reread.row, reread.lastRead)
    case ROW_REREAD_LIVE:
    case ROW_REREAD_UNKNOWN:
      return lostRaceAtLadder(key, log)
  }
}

/**
 * The line of a `resume` of persona `ref` that answered
 * `ErrInstanceIdCollision` (`resumeCollisionAt`; b.jg5 SRJ-713, SRJ-112,
 * SRJ-301): `failure` is the error as `describeAgentDirectorFailure` renders
 * it, and `armed` says whether the retry timer was armed with the collision
 * cause.
 */
export function resumeCollisionLine(ref: string, failure: string, armed: boolean): string {
  return `[slack] spawnForPersona: ${failure} on the resume of ${ref} — its row is live, so nothing was launched; no spawn-failure notice, nothing counted; answering retrying, the retry timer ${armed ? 'is armed' : 'could not be armed'} (cause=${UNAVAILABLE_RETRY_CAUSE_REUSE_COLLISION}), and that retry's run of the restart path's decision is the get-then-act (b.jg5 SRJ-713, SRJ-112, SRJ-301)`
}

/**
 * A `resume` of persona `key` that answered `ErrInstanceIdCollision` (by
 * name), at either `resume` site (`resumeFailedAt`). agent-director's
 * `resume` has no such answer (b.jg5 SRJ-113's table has no row for it), so
 * this only keeps a collision away from the spawn-failure notice (SRJ-713):
 * a collision means the row is live, a launch in progress included, and
 * nothing was launched. As a reuse spawn's second collision (SRJ-112), it
 * makes no further call, arms the persona's retry timer with the collision
 * cause (`reportReuseCollisionAtSite`, so the attempt records it) and
 * answers `retrying`; that retry's run of the restart path's decision is the
 * get-then-act. Nothing is counted, posted or killed; one line
 * (`resumeCollisionLine`). Never throws.
 */
function resumeCollisionAt(key: string, ref: string, err: unknown): SpawnPersonaResult {
  const armed = reportReuseCollisionAtSite(key)
  console.error(resumeCollisionLine(ref, describeAgentDirectorFailure(err), armed))
  return { key, action: SPAWN_ACTION_RETRYING }
}

/**
 * A `resume`'s failure by class, once the one `resume` outcome handler's
 * own rows have passed it (`resumeAtSite`, at `resumeOrFreshSpawn` and at
 * the live-row sequence's launch entry), with no further launch: `ErrInvalidFlags` gets one immediate version re-check
 * (`invalidFlagsUnclassifiedAt`: a stop it decides answers `failed` marked
 * `stopping`; otherwise UNCLASSIFIED through the site entry, b.jg5 SRJ-104,
 * SRJ-313); the
 * DIRECTORY errors (`ErrCwdNotFound`, `ErrCwdNotADirectory`, by name) answer
 * `failed` quietly (the wrapper raised `cwd-unreachable`); then the refusal handling
 * (`launchRefusalAt`: a CONFLICT latches with the refused operation
 * "resume" and `lastRead`, an UNUSABLE NAME latches, a refusal answers
 * `failed`); any other error answers `failed` with one line and the
 * spawn-failure notice. An `ErrTmuxSessionCreate` (LAUNCH FAILURE, by name)
 * among those is one counted launch failure (b.jg5 SRJ-113, SRJ-602): one
 * line, the notice, a `spawn-failed` entry at start, and
 * `launchFailureResult`'s answer: nothing is killed, no spawn is made in its
 * place, and the persona's retry timer is armed at once in pending-only
 * mode, since agent-director's restore of the row may not have applied (HO
 * rev 28), so the retry's read of the row decides (SRJ-301, SRJ-409); the
 * result is marked `countedClass`, and `pendingOnlyArmed` when it armed.
 * An `ErrInstanceIdCollision` (by name) never reaches the notice: it takes
 * `resumeCollisionAt` first (b.jg5 SRJ-713).
 * Never throws.
 */
async function resumeFailedAt(
  persona: Persona,
  err: unknown,
  isStartup: boolean,
  ref: string,
  lastRead: LastRowRead,
): Promise<SpawnPersonaResult> {
  const { key } = persona
  // b.jg5 SRJ-713: a collision never reaches the spawn-failure notice.
  if (hasAdErrorName(err, ERR_INSTANCE_ID_COLLISION_NAME)) return resumeCollisionAt(key, ref, err)
  // b.jg5 SRJ-104: the resume site gives ErrInvalidFlags no meaning: one
  // immediate version re-check, then UNCLASSIFIED (SRJ-105, SRJ-313).
  if (isInvalidFlagsError(err)) return invalidFlagsUnclassifiedAt(key, err, 'resume', 'resume', ref)
  // b.av2 SR-6.4: `cwd-unreachable` was raised by the resume's wrapper.
  if (classifyAdError(err).errorClass === AD_ERROR_CLASS_DIRECTORY) return { key, action: 'failed' }
  // b.jg5 SRJ-104, SRJ-105: `ErrSystemInstallDisappeared` is UNCLASSIFIED
  // (its wrapper has raised `ad-unreachable`), a refusal like the others.
  // b.jg5 SRJ-113: a CONFLICT latches the persona (refused operation
  // "resume"); never a kill.
  const refused = await launchRefusalAt(key, err, 'resume', 'resume', ref, lastRead)
  // b.jg5 SRJ-407: an UNAVAILABLE outcome (a launch timeout included) is
  // followed by one `get`, and no launch, in this attempt.
  if (refused) {
    return isUnavailableRefusal(refused, err)
      ? afterLaunchUnavailable({ persona, isStartup, ref, verb: 'resume', what: 'resume' }, err, refused)
      : refused
  }
  const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('resume', 'UnknownError', String(err))
  const described = describeAgentDirectorFailure(e)
  if (!isLaunchFailure(err)) {
    console.error(`[slack] spawnForPersona: resume failed for ${ref}: ${described}`)
    notifySpawnFailure(key, e, isStartup)
    return { key, action: 'failed' }
  }
  console.error(`[slack] spawnForPersona: resume failed for ${ref}: ${described}${LAUNCH_FAILURE_LINE_TAIL}`)
  if (isStartup) recordStartupError('spawn-failed', `resume failed for ${ref}: ${described}`)
  notifySpawnFailure(key, e, isStartup)
  return launchFailureResult(key)
}

// ---------------------------------------------------------------------------
// The one `get` after a launch's UNAVAILABLE outcome (b.jg5 SRJ-407)
// ---------------------------------------------------------------------------

/** Who reads, in the own-row lines of the one `get` after a launch's UNAVAILABLE outcome (`afterLaunchUnavailable`; the persona's ref is added; b.jg5 SRJ-407, SRJ-114). */
export const LAUNCH_UNAVAILABLE_GET_SITE: OwnRowReadSite = Object.freeze({
  site: 'spawnForPersona',
  what: "get after the launch's UNAVAILABLE outcome",
})

/** The step's outcome: the read latched the persona (or found it latched). */
export const LAUNCH_UNAVAILABLE_OUTCOME_LATCHED = 'the persona is latched: answering latched; nothing more is called for it'
/** The step's outcome: no row (`ErrSpawnNotFound`). */
export const LAUNCH_UNAVAILABLE_OUTCOME_NO_ROW = 'no row: nothing more in this attempt; the retry the outcome armed brings the persona up'
/** The step's outcome: the read was refused (the shared read's own error rows applied). */
export const LAUNCH_UNAVAILABLE_OUTCOME_REFUSED = 'the read was refused: nothing more in this attempt'
/** The step's outcome: the row reads `ended` or `missing`. */
export const LAUNCH_UNAVAILABLE_OUTCOME_FINISHED = 'the row is finished: nothing more in this attempt; the retry the outcome armed launches it again'
/** The step's outcome: the row reads another live state. */
export const LAUNCH_UNAVAILABLE_OUTCOME_LIVE =
  "another live state: no launch over it; the retry the outcome armed runs the restart path, whose reconnect adapter handles the row"
/** The step's outcome: the row reads a state CSCB does not know. */
export const LAUNCH_UNAVAILABLE_OUTCOME_UNKNOWN = 'a state CSCB does not know: nothing more in this attempt'
/** The step's outcome: a covered `pending` row after a launch timeout, the approver started. */
export const LAUNCH_UNAVAILABLE_OUTCOME_APPROVER = 'covered: the approver starts once the launch call has returned; the retry timer watches the row'
/** The step's outcome: a covered `pending` row after a launch timeout whose approver the start entry did not start. */
export const LAUNCH_UNAVAILABLE_OUTCOME_APPROVER_NOT_STARTED = 'covered, but the approver was not started; the retry timer watches the row'
/** The step's outcome: a covered `pending` row after an UNAVAILABLE outcome that was no launch timeout. */
export const LAUNCH_UNAVAILABLE_OUTCOME_COVERED_NO_APPROVER =
  'covered: no approver after this outcome; the retry timer watches the row'
/** The step's outcome: a `pending` row whose cover is undecided. */
export const LAUNCH_UNAVAILABLE_OUTCOME_UNDECIDED = 'undecided: no approver, no sequence; the retry timer watches the row'
/** The step's outcome: a configured persona's own `pending` row with no launch start. */
export const LAUNCH_UNAVAILABLE_OUTCOME_NO_LAUNCH_START = 'no launch start: the persona latches on it; answering latched'

/** The step's outcome for a `pending` row that is not covered, started through the live-row sequence's start entry. */
export function launchUnavailableSequenceOutcome(reason: PendingRowNotCoveredReason, startAnswer: string, action: string): string {
  return `not covered (${reason}): the live-row sequence, no approver; start answered ${startAnswer} — answering ${action}`
}

/**
 * The step's line text for each launch-timeout form: CSCB's own text, picked
 * by the form, so no agent-director text reaches the line through it.
 */
const LAUNCH_TIMEOUT_FORM_TEXT: Readonly<Record<LaunchTimeoutForm, string>> = Object.freeze({
  [LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT]: `a launch timeout (${LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT})`,
  [LAUNCH_TIMEOUT_FORM_TMUX_UNRESPONSIVE]: `a launch timeout (${LAUNCH_TIMEOUT_FORM_TMUX_UNRESPONSIVE})`,
})

/**
 * How the step's line names the launch's outcome: for a launch timeout
 * (`timeoutForm`, from `launchTimeoutFormOf`) its form (`a launch timeout
 * (ErrCallTimeout)`, `a launch timeout (ErrTmuxUnresponsive)`), else
 * `UNAVAILABLE (<failure>)`, where `failure` is the outcome already rendered
 * by `describeAgentDirectorFailure`. Takes no caught error, so none reaches
 * the line except through the describer. Pure; never throws.
 */
export function launchUnavailableFormText(timeoutForm: LaunchTimeoutForm | undefined, failure: string): string {
  return timeoutForm !== undefined ? LAUNCH_TIMEOUT_FORM_TEXT[timeoutForm] : `UNAVAILABLE (${failure})`
}

/**
 * The step's one line per decision (b.jg5 SRJ-407), naming the persona
 * reference, the call (`what`), the outcome's form or kind (`form`), the row
 * state the `get` read (`read`: a state through `isSafeIdentifier`, or what
 * the read found), whether the row is this launch's (with its launch start
 * only as CSCB renders it, `describeLaunchStartForLog`), and the outcome:
 *
 *   [slack] spawnForPersona: one get after the <what> of <ref> ended in <form>: read <read>; this launch's row: <yes (launch start <iso>)|no> — <outcome>; no launch in this attempt (b.jg5 SRJ-407)
 */
export function launchUnavailableGetLine(
  ref: string,
  what: string,
  form: string,
  read: string,
  thisLaunchRow: ThisLaunchRowRecord | undefined,
  outcome: string,
): string {
  const own =
    thisLaunchRow === undefined ? 'no' : `yes (launch start ${describeLaunchStartForLog(thisLaunchRow.launchStartMs)})`
  return `[slack] spawnForPersona: one get after the ${what} of ${ref} ended in ${form}: read ${read}; this launch's row: ${own} — ${outcome}; no launch in this attempt (b.jg5 SRJ-407)`
}

/** What a launch call whose UNAVAILABLE outcome the step follows was. */
interface LaunchUnavailableSite {
  readonly persona: Persona
  /** Whether the launch is part of the start pass (passed to the approver). */
  readonly isStartup: boolean
  readonly ref: string
  /** The call's declared verb: `spawn` (plain or reuse) or `resume`. */
  readonly verb: 'spawn' | 'resume'
  /** What the step's line calls the call. */
  readonly what: string
  /**
   * Present for a reuse spawn: the store's reading of the key and its record
   * generation when the launch attempt started (b.jg5 SRJ-806), for the mark
   * of a reuse that timed out but launched.
   */
  readonly reuseRetiredAtStart?: RetiredKeyAttemptStart
}

/** Whether a launch's refusal result `refused` is for an UNAVAILABLE outcome (`err`'s class), the step's trigger. Never throws. */
function isUnavailableRefusal(refused: SpawnPersonaResult, err: unknown): boolean {
  return refused.action === 'failed' && classifyAdError(err).errorClass === AD_ERROR_CLASS_UNAVAILABLE
}

/** A row state for the step's line: the state when it is a short identifier, else `unknown`. */
function launchUnavailableReadText(state: unknown): string {
  return isSafeIdentifier(state) ? state : 'unknown'
}

/**
 * The one post-UNAVAILABLE step (b.jg5 SRJ-407), run inside the launch
 * attempt right after a launch call of `site.persona` (a plain spawn at any
 * of its sites, a reuse spawn at any of its sites, the live-row sequence's
 * final one included, or a `resume` at either site) ended in an UNAVAILABLE
 * outcome (`err`, by class) and the refusal handling answered `refused` and
 * armed the persona's retry timer. No launch call follows in this attempt,
 * whatever the read shows. One `get` of the persona's own row through the
 * shared own-row read (`readPersonaOwnRow` at `LAUNCH_UNAVAILABLE_GET_SITE`,
 * so its note latch, its no-launch-start latch, its retired-entry clear and
 * its old-life read entry apply; SRJ-114, SRJ-513, SRJ-807, SRJ-809), then:
 *   - the read latched the persona, or it was latched meanwhile: `latched`;
 *   - `ErrSpawnNotFound`: nothing more; the retry the outcome armed brings
 *     the persona up, never a launch in this attempt;
 *   - a refused read: the shared read's own error rows (`refusalAt`: one
 *     line; inside the attempt its UNAVAILABLE arms its read-error cause);
 *   - `ended` or `missing`: nothing more; launched again at the next retry;
 *   - another live state, or one CSCB does not know: nothing more; the retry
 *     the outcome armed runs the restart path, whose reconnect adapter
 *     handles the row; never a launch over it;
 *   - `pending` after a launch timeout (`launchTimeoutFormOf`, either form):
 *     first, when its launch start lies inside the call's window
 *     (`isLaunchStartInWindow` over `launchCallWindowOf`, both ends
 *     included), the row is this launch's: the persona's "this launch's row"
 *     record is set (`thisLaunchRows`: its launch start and the window, for
 *     SRJ-310's rule 3, `checkThisLaunchRowOnRead`), so is the record of
 *     CSCB's own launch (`ownLaunches`, b.jg5 SRJ-412), and for a reuse spawn
 *     of a recorded key the "new life has begun" mark is set and the key's
 *     old-life hold ended (`markNewLifeAfterTimedOutReuse`, SRJ-806,
 *     SRJ-809), before the cover decision, so the reuse's own row is covered
 *     as the new life; then the one pending-row step (`pendingRowStep`)
 *     decides and arms; a covered row gets the dialog approver through the
 *     start entry with the launch-timeout origin (`startDialogApprover`,
 *     `APPROVER_ORIGIN_LAUNCH_TIMEOUT`; not awaited, its first call after the
 *     launch call returned), never through the after-launch step;
 *   - `pending` after any other UNAVAILABLE outcome: the pending-row step
 *     only: never this launch's row, no mark and no approver;
 *   - a `pending` row that is not covered (a retired key's old life, a `cwd`
 *     or `config_dir` mismatch): the live-row sequence through the start
 *     entry (`startRecoverySequence`: seeded `pending`, the conversation not
 *     kept, alert context `recovery`), no approver, answering
 *     `sequence-waiting` (`held` for a persona held on `ErrInvalidFlags`);
 *   - a configured persona's own `pending` row with no launch start:
 *     `latched` (its read latched it).
 * Any other answer is the launch's refusal result (b.jg5 SRJ-1015): `retrying` when the
 * attempt's error before or during the step armed the persona's timer
 * (`currentAttemptLastError`), else `refused` as it came. One line per
 * decision (`launchUnavailableGetLine`). Nothing here kills, deletes,
 * launches or counts. Never throws.
 */
async function afterLaunchUnavailable(
  site: LaunchUnavailableSite,
  err: unknown,
  refused: SpawnPersonaResult,
): Promise<SpawnPersonaResult> {
  const { persona, ref, verb, what } = site
  const { key } = persona
  // The launch's own UNAVAILABLE was recorded (and armed) before this step;
  // the `get` below records its own answer in its place.
  const launchArmed = currentAttemptLastError(key)?.armed === true
  const notLaunched = (): SpawnPersonaResult =>
    launchArmed || currentAttemptLastError(key)?.armed === true ? { key, action: SPAWN_ACTION_RETRYING } : refused
  const timeoutForm = launchTimeoutFormOf(err, verb)
  const formText = launchUnavailableFormText(timeoutForm, describeAgentDirectorFailure(err))
  const log = (read: string, thisLaunchRow: ThisLaunchRowRecord | undefined, outcome: string): void => {
    console.error(launchUnavailableGetLine(ref, what, formText, read, thisLaunchRow, outcome))
  }
  const at: OwnRowReadSite = { ...LAUNCH_UNAVAILABLE_GET_SITE, ref }
  const read = await readPersonaOwnRow(key, at)
  if (read.kind === OWN_ROW_READ_LATCHED || (read.kind === OWN_ROW_READ_ROW && read.latched)) {
    log(read.kind === OWN_ROW_READ_ROW ? launchUnavailableReadText(read.row.state) : 'an UNUSABLE NAME answer', undefined, LAUNCH_UNAVAILABLE_OUTCOME_LATCHED)
    return { key, action: 'latched' }
  }
  // b.jg5 SRJ-502: the get is awaited, and the persona may have latched elsewhere meanwhile.
  if (latchedAfterOwnRowRead(key, at.site, at.what, ref)) {
    log(read.kind === OWN_ROW_READ_ROW ? launchUnavailableReadText(read.row.state) : read.kind, undefined, LAUNCH_UNAVAILABLE_OUTCOME_LATCHED)
    return { key, action: 'latched' }
  }
  if (read.kind === OWN_ROW_READ_ABSENT) {
    log('no row (ErrSpawnNotFound)', undefined, LAUNCH_UNAVAILABLE_OUTCOME_NO_ROW)
    return notLaunched()
  }
  if (read.kind === OWN_ROW_READ_REFUSED) {
    if (refusalAt(key, read.error, 'get', at.site, at.what, ref) === undefined) {
      // Not reached: every `get` error but ErrSpawnNotFound and UNUSABLE NAME is a refusal.
      console.error(`[slack] ${at.site}: ${at.what} failed for ${ref}: ${describeAgentDirectorFailure(read.error)} — nothing more is called`)
    }
    log('nothing (a refused read)', undefined, LAUNCH_UNAVAILABLE_OUTCOME_REFUSED)
    return notLaunched()
  }
  // The row whole, so its launch start is read (`src/ad-phase1-types.ts`).
  const row: Phase1GetResult = read.row
  const readText = launchUnavailableReadText(row.state)
  if (row.state !== AGENT_DIRECTOR_PENDING_STATE) {
    const outcome = AGENT_DIRECTOR_DEAD_STATES.has(row.state)
      ? LAUNCH_UNAVAILABLE_OUTCOME_FINISHED
      : AGENT_DIRECTOR_LIVE_STATES.has(row.state)
        ? LAUNCH_UNAVAILABLE_OUTCOME_LIVE
        : LAUNCH_UNAVAILABLE_OUTCOME_UNKNOWN
    log(readText, undefined, outcome)
    return notLaunched()
  }
  // b.jg5 SRJ-407, SRJ-806: after a launch timeout, a launch start inside the
  // call's window makes the row this launch's; a reuse of a recorded key then
  // begins its new life before the cover decision, so its row is covered.
  let thisLaunchRow: ThisLaunchRowRecord | undefined
  if (timeoutForm !== undefined) {
    const window = launchCallWindowOf(key)
    const launchStartMs = parseLaunchStart(row.launch_started_at)
    if (window !== undefined && launchStartMs !== undefined && isLaunchStartInWindow(row.launch_started_at, window)) {
      thisLaunchRow = { launchStartMs, window }
      thisLaunchRows.set(key, thisLaunchRow)
      // b.jg5 SRJ-412: a timed-out launch's own row is CSCB's own launch. An
      // uncovered row may be recorded too; only the pending-row rule's step 3,
      // which runs on a covered row, reads the record.
      recordOwnLaunch(key, window, LAUNCH_CALL_END_LAUNCH_TIMEOUT, row.launch_started_at)
      if (site.reuseRetiredAtStart !== undefined) markNewLifeAfterTimedOutReuse(key, ref, site.reuseRetiredAtStart)
    }
  }
  const { cover } = pendingRowStep(persona, ref, row, false)
  switch (cover.answer) {
    case PENDING_ROW_NO_LAUNCH_START:
      log(readText, thisLaunchRow, LAUNCH_UNAVAILABLE_OUTCOME_NO_LAUNCH_START)
      return { key, action: 'latched' }
    case PENDING_ROW_UNDECIDED:
      log(readText, thisLaunchRow, LAUNCH_UNAVAILABLE_OUTCOME_UNDECIDED)
      return notLaunched()
    case PENDING_ROW_COVERED: {
      if (timeoutForm === undefined) {
        log(readText, thisLaunchRow, LAUNCH_UNAVAILABLE_OUTCOME_COVERED_NO_APPROVER)
        return notLaunched()
      }
      // b.jg5 SRJ-401, SRJ-407: started outside the launch call; its first
      // call waits until this launch has settled.
      const started = startDialogApprover(key, site.isStartup, ref, {
        origin: APPROVER_ORIGIN_LAUNCH_TIMEOUT,
        cover,
        launchStartedAt: row.launch_started_at,
      })
      log(readText, thisLaunchRow, started ? LAUNCH_UNAVAILABLE_OUTCOME_APPROVER : LAUNCH_UNAVAILABLE_OUTCOME_APPROVER_NOT_STARTED)
      return notLaunched()
    }
    case PENDING_ROW_NOT_COVERED: {
      const { startAnswer, result } = startRecoverySequence(
        { persona, ref, retiredAtStart: site.reuseRetiredAtStart },
        latchRowStateRead(AGENT_DIRECTOR_PENDING_STATE),
        false,
        cover.reason === PENDING_ROW_REASON_RETIRED_OLD_LIFE,
      )
      log(readText, thisLaunchRow, launchUnavailableSequenceOutcome(cover.reason, startAnswer, result.action))
      return result
    }
  }
}

// ---------------------------------------------------------------------------
// Pre-launch trust patch (b.av2 SR-6.2)
// ---------------------------------------------------------------------------

/** Patches the persona's `.claude.json` trust flags before a launch. */
export type PreLaunchTrustPatcher = (persona: Persona) => void

/**
 * The one pre-launch trust patcher. Production installs the single-persona
 * trust patch (`trustPatchPersona` in `src/trust-bootstrap.ts`). With none
 * installed (unit tests, the integration driver) no patch runs and nothing
 * is written.
 */
let preLaunchTrustPatcher: PreLaunchTrustPatcher | undefined

/** Install the pre-launch trust patcher (production: `server.ts`). */
export function setPreLaunchTrustPatcher(patcher: PreLaunchTrustPatcher): void {
  preLaunchTrustPatcher = patcher
}

/** Test-only seam: remove any installed pre-launch trust patcher. */
export function _resetPreLaunchTrustPatcher(): void {
  preLaunchTrustPatcher = undefined
}

/**
 * Run the installed pre-launch trust patcher for `persona`. A throw is logged
 * with the persona reference and never reaches the ladder.
 */
function runPreLaunchTrustPatch(persona: Persona, ref: string): void {
  if (!preLaunchTrustPatcher) return
  try {
    preLaunchTrustPatcher(persona)
  } catch (err) {
    console.error(`[slack] spawnForPersona: pre-launch trust patch failed for ${ref} — launching anyway: ${describeThrownValue(err)}`)
  }
}

// ---------------------------------------------------------------------------
// Pre-launch reply guard (b.av2 SR-9.4, SR-6.2)
// ---------------------------------------------------------------------------

/**
 * Runs the reply-guard steps before one persona's launch (record write,
 * launched-with update, launch-time hook pass) and may return an undo for a
 * launch that turns out not to be one.
 */
export type PreLaunchReplyGuard = (persona: Persona) => ReplyGuardUndo | void

/**
 * The one pre-launch reply guard. Production installs `preLaunchReplyGuard`
 * from `src/stop-hook-bootstrap.ts`, closed over the server's state directory
 * and a getter for the applied persona set. With none installed (unit tests,
 * the integration driver) no record is written and no settings are patched;
 * nothing here resolves a state directory.
 */
let preLaunchReplyGuard: PreLaunchReplyGuard | undefined

/** Install the pre-launch reply guard (production: `server.ts`). */
export function setPreLaunchReplyGuard(guard: PreLaunchReplyGuard): void {
  preLaunchReplyGuard = guard
}

/** Test-only seam: remove any installed pre-launch reply guard. */
export function _resetPreLaunchReplyGuard(): void {
  preLaunchReplyGuard = undefined
}

/**
 * Run the installed pre-launch reply guard for `persona`, immediately before
 * an agent-director spawn or resume. A throw is logged with the persona
 * reference and never reaches the ladder. Returns the guard's undo, if any.
 */
function runPreLaunchReplyGuard(persona: Persona, ref: string): ReplyGuardUndo | undefined {
  if (!preLaunchReplyGuard) return undefined
  try {
    return preLaunchReplyGuard(persona) ?? undefined
  } catch (err) {
    console.error(`[slack] spawnForPersona: pre-launch reply guard failed for ${ref} — launching anyway: ${describeThrownValue(err)}`)
    return undefined
  }
}

/** Run a reply-guard undo; a throw is logged and never reaches the ladder. */
function undoPreLaunchReplyGuard(undo: ReplyGuardUndo | undefined, ref: string): void {
  if (!undo) return
  try {
    undo()
  } catch (err) {
    console.error(`[slack] spawnForPersona: undoing the pre-launch reply guard failed for ${ref}: ${describeThrownValue(err)}`)
  }
}

/**
 * An agent-director call that starts the persona's instance (`client.spawn`
 * or `client.resume`, declared as `verb`), preceded immediately by the
 * reply-guard steps. Every
 * `resume` goes through here; every plain spawn goes through the one
 * plain-spawn outcome handler (`plainSpawnOutcomeAt`), which also undoes the
 * steps when it meets a live instance, and the reuse spawn
 * (`reuseSpawnForPersona`) makes the same two steps itself so that a retired
 * key's first launch can undo them the same way (b.jg5 SRJ-805). The call
 * records its window (`launchCallWithWindow`, b.jg5 SRJ-407).
 */
function launchWithReplyGuard<T>(
  persona: Persona,
  ref: string,
  verb: 'spawn' | 'resume',
  call: (client: Client) => Promise<T>,
): Promise<T> {
  runPreLaunchReplyGuard(persona, ref)
  return launchCallWithWindow(persona.key, persona.working_directory, verb, call)
}

// ---------------------------------------------------------------------------
// Each launch call's window (b.jg5 SRJ-407)
// ---------------------------------------------------------------------------

/** A launch call's window ended because the call returned success. */
export const LAUNCH_CALL_END_RETURNED = 'returned'
/** A launch call's window ended because the call ended in a launch timeout (`isLaunchTimeoutError`). */
export const LAUNCH_CALL_END_LAUNCH_TIMEOUT = 'launch-timeout'

/** How a launch call's window ended. */
export type LaunchCallEnd = typeof LAUNCH_CALL_END_RETURNED | typeof LAUNCH_CALL_END_LAUNCH_TIMEOUT

/**
 * The window of a persona's latest launch call (b.jg5 SRJ-407): the verb the
 * call declared (`spawn`, plain or reuse, or `resume`), its start, and, once
 * it returned success or ended in a launch timeout, its end and how it ended.
 * A call that ended any other way keeps no end.
 */
export interface LaunchCallWindowRecord extends LaunchCallWindow {
  readonly verb: 'spawn' | 'resume'
  readonly end?: LaunchCallEnd
}

/**
 * Each persona's latest launch call's window (b.jg5 SRJ-407), kept beside the
 * launch-in-flight state (`inFlightLaunches`). Replaced at each launch call
 * for the persona; forgotten at its teardown's kill (`forgetLaunchCalls`)
 * and by `_resetInFlightLaunches`.
 */
const launchCallWindows = new Map<string, LaunchCallWindowRecord>()

/**
 * The window of persona `key`'s latest launch call (b.jg5 SRJ-407), or
 * `undefined` when none is kept. Its times are wall-clock epoch
 * milliseconds on the session manager's clock (`_setNow`). Read-only.
 */
export function launchCallWindowOf(key: string): LaunchCallWindowRecord | undefined {
  return launchCallWindows.get(key)
}

/**
 * Forget persona `key`'s launch-call window, its "this launch's row"
 * record (b.jg5 SRJ-407, SRJ-310), its record of a launch whose
 * `send-keys` answered `ErrSpawnNotInteractive` and its record of CSCB's own
 * launch (b.jg5 SRJ-412), as its teardown does
 * (`killPersonaInstanceForTeardown`, which runs once the persona's launch in
 * flight has settled). Silent; never throws.
 */
export function forgetLaunchCalls(key: string): void {
  launchCallWindows.delete(key)
  thisLaunchRows.delete(key)
  notInteractiveLaunches.delete(key)
  ownLaunches.delete(key)
}

/**
 * Each persona's latest launch whose `send-keys` answered
 * `ErrSpawnNotInteractive` (b.jg5 SRJ-118, SRJ-412, SRJ-1017): the launch
 * start of that launch (epoch ms), kept beside the launch-in-flight state,
 * in memory only (a server restart forgets it). Set by
 * `recordSendKeysNotInteractive` (the dialog approver's `send-keys`; the
 * pending-row lap's), a later record replacing it; read by
 * `launchMetSendKeysNotInteractive`. Forgotten at the persona's teardown's
 * kill (`forgetLaunchCalls`) and by `_resetInFlightLaunches`. A new launch
 * call keeps it: the record names its launch by its launch start, so a new
 * launch, with a new launch start, reads no.
 */
const notInteractiveLaunches = new Map<string, number>()

/**
 * Record that a `send-keys` on persona `key`'s row answered
 * `ErrSpawnNotInteractive` during the launch whose launch start is
 * `launchStart` (b.jg5 SRJ-118, SRJ-412, SRJ-1017), raw or parsed
 * (`launchStartInstantOf`): the session holding the name is not that
 * launch's. Replaces the persona's earlier record. A launch start that is
 * absent or does not parse records nothing (an approver that never read
 * one). Only a `send-keys` answer counts: a `read-pane` or `status` answer
 * of that name is never recorded (SRJ-412, SRJ-1017). Silent; never throws.
 */
export function recordSendKeysNotInteractive(key: string, launchStart: unknown): void {
  const launchStartMs = launchStartInstantOf(launchStart)
  if (launchStartMs === undefined) return
  notInteractiveLaunches.set(key, launchStartMs)
}

/**
 * Whether persona `key`'s launch with the launch start `launchStart`, raw
 * or parsed, met a `send-keys` that answered `ErrSpawnNotInteractive`
 * (b.jg5 SRJ-118, SRJ-412, SRJ-1017): true only when the persona's record
 * names that instant (`launchStartInstantOf`, so both launch-start forms of
 * one instant match); false for any other launch start, for one that is
 * absent or does not parse, and when no record is kept. Read-only; never
 * throws.
 */
export function launchMetSendKeysNotInteractive(key: string, launchStart: unknown): boolean {
  const recorded = notInteractiveLaunches.get(key)
  if (recorded === undefined) return false
  return launchStartInstantOf(launchStart) === recorded
}

// ---------------------------------------------------------------------------
// CSCB's own launch (b.jg5 SRJ-412)
// ---------------------------------------------------------------------------

/**
 * Persona P's record of CSCB's own launch (b.jg5 SRJ-412, SRJ-407): the
 * launch start (epoch ms, as `parseLaunchStart` reads it) of the row a launch
 * call this server made left, and that call's window. Set only when the
 * launch start lies inside the window (`isLaunchStartInWindow`, both ends
 * included): after a call that returned success, as the dialog approver's
 * first lap read it (`keepApproverLaunchStart`); after a call that ended in a
 * launch timeout, as the one `get` that followed read it
 * (`afterLaunchUnavailable`).
 */
export interface OwnLaunchRecord {
  readonly launchStartMs: number
  readonly window: LaunchCallWindowRecord
}

/**
 * Each persona's record of CSCB's own launch (`OwnLaunchRecord`; b.jg5
 * SRJ-412), kept beside the launch-in-flight state and the launch-call
 * windows, in memory only (a server restart forgets it). It outlives the
 * dialog approver that set it, so the pending-row rule's step 3 reads it
 * after the approver has stopped. Unlike "this launch's row"
 * (`thisLaunchRows`), no read forgets it: a read only compares the launch
 * start it carries (`isCscbOwnLaunch`). Forgotten at a new launch call for
 * the persona (`launchCallWithWindow`; put back after a call that answered
 * `ErrInstanceIdCollision`, `restoreLaunchRecords`), at its teardown's kill
 * (`forgetLaunchCalls`) and by `_resetInFlightLaunches`. A launch call that
 * failed in any other way (no window end), another process's or a human's
 * launch, a row with no launch start and a launch start outside the window
 * are never recorded.
 */
const ownLaunches = new Map<string, OwnLaunchRecord>()

/** Persona `key`'s record of CSCB's own launch, or `undefined` when none is kept (b.jg5 SRJ-412). Read-only. */
export function ownLaunchRecordOf(key: string): OwnLaunchRecord | undefined {
  return ownLaunches.get(key)
}

/**
 * Record persona `key`'s own launch (b.jg5 SRJ-412) when `launchStartedAt`,
 * the raw launch start a read gave, lies inside `window`, which must still be
 * the persona's latest launch call's window and have ended `end`
 * (`LAUNCH_CALL_END_RETURNED` for the approver's first lap,
 * `LAUNCH_CALL_END_LAUNCH_TIMEOUT` for the get after a launch timeout).
 * Answers whether it recorded. Silent; never throws.
 */
function recordOwnLaunch(
  key: string,
  window: LaunchCallWindowRecord | undefined,
  end: LaunchCallEnd,
  launchStartedAt: unknown,
): boolean {
  try {
    if (window === undefined || window.end !== end || launchCallWindows.get(key) !== window) return false
    const launchStartMs = parseLaunchStart(launchStartedAt)
    if (launchStartMs === undefined || !isLaunchStartInWindow(launchStartedAt, window)) return false
    ownLaunches.set(key, { launchStartMs, window })
    return true
  } catch {
    return false
  }
}

/**
 * Whether persona `key`'s row's current launch, whose raw launch start as
 * read now is `launchStart` (raw or parsed), is CSCB's own (b.jg5 SRJ-412):
 * true only when the persona's own-launch record is kept, that launch start
 * equals the recorded one (`launchStartInstantOf`, so both launch-start forms
 * of one instant match), and no `send-keys` on the row answered
 * `ErrSpawnNotInteractive` during that launch
 * (`launchMetSendKeysNotInteractive`). False for a launch start that is
 * absent or does not parse. Whether it is a relaunch an abort made earlier in
 * the same stuck-launch episode is the pending-row rule's per-episode abort
 * state, not this query's. Read only from the rule's step 3, on a row decided
 * covered (SRJ-410). Read-only; never throws.
 */
export function isCscbOwnLaunch(key: string, launchStart: unknown): boolean {
  try {
    const record = ownLaunches.get(key)
    if (record === undefined) return false
    if (launchStartInstantOf(launchStart) !== record.launchStartMs) return false
    return !launchMetSendKeysNotInteractive(key, launchStart)
  } catch {
    return false
  }
}

/**
 * One launch call of persona `key` (`client.spawn`, plain or reuse, or
 * `client.resume`, declared as `verb`) through spawn detection
 * (`withSpawnDetection`), recording its window (b.jg5 SRJ-407): a new window
 * starts just before the call, on the session manager's clock (`_now`),
 * replacing the persona's earlier one, and the call forgets the persona's
 * "this launch's row" record (`thisLaunchRows`) and its record of CSCB's own
 * launch (`ownLaunches`, b.jg5 SRJ-412), putting both back when it answers
 * `ErrInstanceIdCollision`, which started no launch
 * (`restoreLaunchRecords`); the window's end is taken
 * when the call returns success or, for a launch timeout
 * (`isLaunchTimeoutError`: `ErrCallTimeout`, or `ErrTmuxUnresponsive` whose
 * description carries "the session may have been created"), when the call's
 * error reaches CSCB. Any other error leaves the window with no end. The
 * call's answer or error is passed on unchanged. Every launch call goes
 * through here: every plain spawn (`plainSpawnOutcomeAt`) and a reuse spawn
 * directly, and every `resume` through `launchWithReplyGuard`.
 */
async function launchCallWithWindow<T>(
  key: string,
  workingDirectory: string | undefined,
  verb: 'spawn' | 'resume',
  call: (client: Client) => Promise<T>,
): Promise<T> {
  const keptThisLaunchRow = thisLaunchRows.get(key)
  const keptOwnLaunch = ownLaunches.get(key)
  thisLaunchRows.delete(key)
  ownLaunches.delete(key)
  const started: LaunchCallWindowRecord = { verb, startMs: _now() }
  launchCallWindows.set(key, started)
  let result: T
  try {
    result = await withSpawnDetection(key, workingDirectory, verb, call)
  } catch (err) {
    if (isLaunchTimeoutError(err, verb)) endLaunchCallWindow(key, started, LAUNCH_CALL_END_LAUNCH_TIMEOUT)
    if (hasAdErrorName(err, ERR_INSTANCE_ID_COLLISION_NAME)) restoreLaunchRecords(key, started, keptThisLaunchRow, keptOwnLaunch)
    throw err
  }
  endLaunchCallWindow(key, started, LAUNCH_CALL_END_RETURNED)
  return result
}

/**
 * After persona `key`'s launch call whose window is `started` answered
 * `ErrInstanceIdCollision` (by name), which created no row and started no
 * launch (b.jg5 SRJ-112, SRJ-713), put back the "this launch's row" record
 * and the record of CSCB's own launch (b.jg5 SRJ-407, SRJ-412) the call set
 * aside at its start, so an earlier launch's records survive a call that
 * changed nothing. Each record is put back only while `started` is still the
 * persona's latest window (no later launch call, and no teardown's
 * `forgetLaunchCalls`, came after it) and nothing set that record during the
 * call. Every other outcome, a CONFLICT refusal included (CSCB cannot tell
 * agent-director's pre-spawn scan refusal, which writes no row, from one
 * after "duplicate session", which may leave this call's row `pending`), may
 * have started a launch, and the records stay forgotten. Either record still
 * counts only for the launch start it carries (`isCscbOwnLaunch`,
 * `checkThisLaunchRowOnRead`). Silent; never throws.
 */
function restoreLaunchRecords(
  key: string,
  started: LaunchCallWindowRecord,
  thisLaunchRow: ThisLaunchRowRecord | undefined,
  ownLaunch: OwnLaunchRecord | undefined,
): void {
  try {
    if (launchCallWindows.get(key) !== started) return
    if (thisLaunchRow !== undefined && !thisLaunchRows.has(key)) thisLaunchRows.set(key, thisLaunchRow)
    if (ownLaunch !== undefined && !ownLaunches.has(key)) ownLaunches.set(key, ownLaunch)
  } catch {
    /* a record not put back only fails safe: no abort, the held text */
  }
}

/**
 * "This launch's row" (b.jg5 SRJ-407, SRJ-310 rule 3): after a launch call
 * of persona P ended in a launch timeout, the one `get` that followed it read
 * P's row `pending` with a launch start inside that call's window. The
 * record keeps that launch start (epoch ms, as `parseLaunchStart` reads it)
 * and the window.
 */
export interface ThisLaunchRowRecord {
  readonly launchStartMs: number
  readonly window: LaunchCallWindowRecord
}

/**
 * Each persona's "this launch's row" record (`ThisLaunchRowRecord`), set by
 * the step after a launch's UNAVAILABLE outcome (`afterLaunchUnavailable`)
 * and checked at every shared own-row read (`checkThisLaunchRowOnRead`).
 * Forgotten at a new launch call for the persona (`launchCallWithWindow`; put
 * back after a call that answered `ErrInstanceIdCollision`,
 * `restoreLaunchRecords`), by rule 3's check, at its teardown's kill
 * (`forgetLaunchCalls`) and by
 * `_resetInFlightLaunches`.
 */
const thisLaunchRows = new Map<string, ThisLaunchRowRecord>()

/** Persona `key`'s "this launch's row" record, or `undefined` when none is kept (b.jg5 SRJ-407). Read-only. */
export function thisLaunchRowOf(key: string): ThisLaunchRowRecord | undefined {
  return thisLaunchRows.get(key)
}

/** `checkThisLaunchRowOnRead`'s reading for a read that found no row (`ErrSpawnNotFound`). */
const THIS_LAUNCH_ROW_READ_ABSENT = 'absent'

/** What one own-row read found, for `checkThisLaunchRowOnRead`: the row's state and its raw launch start, or no row. */
type ThisLaunchRowReading = { readonly state: string; readonly launchStartedAt: unknown } | typeof THIS_LAUNCH_ROW_READ_ABSENT

/**
 * The line of SRJ-310's third end rule (b.jg5 SRJ-310, SRJ-407), at the read
 * `at` that found persona `ref`'s row, this launch's, in the live state
 * `state` (through `isSafeIdentifier`), with whether the condition was asked
 * to end:
 *
 *   [slack] <site>: <what> for <ref>: this launch's row left pending for <state> after its launch timeout — the tmux-unresponsive condition ends if it holds (SRJ-310 rule 3; b.jg5 SRJ-407)
 *   [slack] <site>: <what> for <ref>: this launch's row left pending for <state> after its launch timeout — no condition sink is installed, so nothing ends (SRJ-310 rule 3; b.jg5 SRJ-407)
 */
export function thisLaunchRowLiveLine(at: OwnRowReadSite, ref: string, state: string, asked: boolean): string {
  const ended = asked ? 'the tmux-unresponsive condition ends if it holds' : 'no condition sink is installed, so nothing ends'
  return `[slack] ${at.site}: ${at.what} for ${ref}: this launch's row left pending for ${isSafeIdentifier(state) ? state : 'unknown'} after its launch timeout — ${ended} (SRJ-310 rule 3; b.jg5 SRJ-407)`
}

/**
 * SRJ-310's third end rule (b.jg5 SRJ-310, SRJ-303, SRJ-407), applied by the
 * shared own-row reads (`readPersonaOwnRow`'s `get`, and the own-row `status`
 * step, `applyOwnRowStatusStep`, which every own-row `status` goes through:
 * the retry's row read, the liveness and reconnect adapters, the approver's
 * laps, the live-row sequence's reads) to persona `key`'s "this launch's row"
 * record, if any. The rule applies only once this launch's row was
 * established: after a launch timeout, by a `pending` read whose launch
 * start lay inside the call's window (`afterLaunchUnavailable`); a first read
 * already live other than `pending` sets no record and is left to rules 1
 * and 2. On the read's answer (`reading`):
 *   - a live state other than `pending` (`AGENT_DIRECTOR_LIVE_STATES`): the
 *     record is forgotten, then, unless the same read latched the persona
 *     (`latched`: the latch's own silent end applies), the condition is
 *     ended once through the outage state's end entry
 *     (`endTmuxUnresponsiveForLaunchRow`) with that state as its reading,
 *     with one line (`thisLaunchRowLiveLine`); the condition's own rules
 *     decide the recovery post, and its condition-end hook stops the retry
 *     timer unless another cause holds (SRJ-306). Whichever read sees it
 *     first ends it, and no later read ends it again;
 *   - `ended`, `missing`, no row, or `pending` with a launch start other than
 *     the record's (none included): the record is forgotten, with no end;
 *   - `pending` with the record's launch start, or a state CSCB does not
 *     know: the record is kept.
 * Never throws.
 */
function checkThisLaunchRowOnRead(key: string, reading: ThisLaunchRowReading, latched: boolean, at: OwnRowReadSite): void {
  try {
    const record = thisLaunchRows.get(key)
    if (record === undefined) return
    if (reading === THIS_LAUNCH_ROW_READ_ABSENT) {
      thisLaunchRows.delete(key)
      return
    }
    const { state } = reading
    if (state === AGENT_DIRECTOR_PENDING_STATE) {
      if (parseLaunchStart(reading.launchStartedAt) !== record.launchStartMs) thisLaunchRows.delete(key)
      return
    }
    if (AGENT_DIRECTOR_DEAD_STATES.has(state)) {
      thisLaunchRows.delete(key)
      return
    }
    if (!AGENT_DIRECTOR_LIVE_STATES.has(state)) return
    thisLaunchRows.delete(key)
    if (latched) return
    const asked = endTmuxUnresponsiveForLaunchRow(key, state)
    console.error(thisLaunchRowLiveLine(at, at.ref ?? keyRef(key), state, asked))
  } catch {
    /* the rule never changes what the read answers */
  }
}

/** End `started`, persona `key`'s window, now, with `end`, while it is still the persona's latest. */
function endLaunchCallWindow(key: string, started: LaunchCallWindowRecord, end: LaunchCallEnd): void {
  if (launchCallWindows.get(key) !== started) return
  launchCallWindows.set(key, { ...started, endMs: _now(), end })
}

/**
 * In-flight launches by persona key (b.av2 SR-6.3): at most one ladder per
 * persona runs at a time. Holds only unsettled launches; an entry is removed
 * when its launch settles, whatever the outcome. A launch's dialog approver
 * is not part of it: it runs after the launch call returned, in the approver
 * registry below (b.jg5 SRJ-401).
 */
const inFlightLaunches = new Map<string, Promise<SpawnPersonaResult>>()

/**
 * Test-only seam: forget every in-flight launch (and, b.f2b, every cancel of
 * a wait one had not started), every launch call's window, every "this
 * launch's row" record (b.jg5 SRJ-407), every record of a launch whose
 * `send-keys` answered `ErrSpawnNotInteractive` and every record of CSCB's
 * own launch (b.jg5 SRJ-412); cancel, wake and forget every running wait for
 * a `working` row, as `cancelWorkingRowWait` does but without its log line, so
 * the wait types nothing more and returns `cancelled` instead of polling on
 * to its deadline; and stop and forget every dialog approver
 * (`_resetDialogApprovers`); so none outlives a test.
 */
export function _resetInFlightLaunches(): void {
  inFlightLaunches.clear()
  cancelledLaunchWaits.clear()
  launchCallWindows.clear()
  thisLaunchRows.clear()
  notInteractiveLaunches.clear()
  ownLaunches.clear()
  for (const wait of workingRowWaits.values()) {
    wait.cancelled = true
    wait.wake()
  }
  workingRowWaits.clear()
  _resetDialogApprovers()
}

/**
 * True while a launch call (collision ladder) for persona `key` is in flight
 * (b.av2 SR-6.6). The restart module's kill adapter consults this so a restart
 * that is about to join a running launch does not first kill the session that
 * launch is bringing up. The health check skips such a persona (b.f2b): a
 * start launch still waiting in the background for a `working` row owns its
 * session until it settles. The launch's dialog approver is not part of the
 * launch in flight: this answers false while only the approver runs
 * (b.jg5 SRJ-401; `isDialogApproverRunning` answers for it).
 */
export function isLaunchInFlight(key: string): boolean {
  return inFlightLaunches.has(key)
}

// ---------------------------------------------------------------------------
// The dialog approver registry (b.jg5 SRJ-401, SRJ-404)
// ---------------------------------------------------------------------------

/** One running approver in the registry: its state and the promise its stop resolves. */
interface RegisteredApprover {
  readonly run: ApproverRun
  readonly ref: string
  /** Resolves once the approver has stopped (after any call in progress returned); never rejects. */
  readonly stopped: Promise<ApproverOutcome>
}

/**
 * The running dialog approvers by persona key (b.jg5 SRJ-401; hatch A2): at
 * most one per persona. An approver's entry is removed when it stops; an
 * approver a later start superseded has already left the map then, and the
 * later one waits for its stop before its first call.
 */
const runningApprovers = new Map<string, RegisteredApprover>()

/**
 * Keys whose launch in flight has not started its approver yet and whose
 * approver was stopped meanwhile (`stopDialogApprover`), with the stop's
 * reason: that launch's approver does not start. Forgotten when the launch
 * settles, as `cancelledLaunchWaits` is.
 */
const cancelledComingApprovers = new Map<string, ApproverStopRequestReason>()

/** Set by `stopAllDialogApprovers` (shutdown): no approver starts after it. Cleared only by the reset seam. */
let approversClosed = false

/**
 * How each persona's latest stopped approver ended; one entry per key.
 * Read by the await seam `_whenDialogApproverStopped`, which answers from it
 * once no approver runs for the key.
 */
const lastApproverOutcomes = new Map<string, ApproverOutcome>()

/**
 * Ask `entry`'s approver to stop with `reason`: marks it (the first reason
 * asked is kept) and wakes its sleep at once; a call in progress returns
 * first, and the loop makes no further call. Logs one line when this ask
 * is the first. Answers whether it was.
 */
function requestApproverStop(entry: RegisteredApprover, reason: ApproverStopRequestReason, log: boolean): boolean {
  if (entry.run.stopRequested !== undefined) return false
  entry.run.stopRequested = reason
  if (log) console.error(approverLogLine(approverStopRequestedMessage(entry.ref, reason)))
  entry.run.wake?.()
  return true
}

/**
 * Start persona `key`'s dialog approver on its own (b.jg5 SRJ-401): the
 * approver's loop (`approvePreSessionDialogs`' rules) runs without being
 * awaited, outside every launch or recovery attempt (`runOutsideAttempts`),
 * so this returns at once, and the caller's launch call returns while the
 * approver runs. Its UNAVAILABLE answers then arm no retry timer and start
 * no `tmux-unresponsive` condition, its UNCLASSIFIED answers open no
 * unclassified-error episode and arm nothing, and its ENVIRONMENT and CONFIG
 * answers raise their outages and arm the persona's retry timer as from any
 * verb (SRJ-301, SRJ-307, SRJ-311, SRJ-313, SRJ-316).
 *
 * The approver makes its first call only once the launch in flight for
 * `key` when it starts (the launch whose success started it), if any, has
 * settled, so it never runs while `isLaunchInFlight` answers for that
 * launch. The registry holds at most one approver per persona (hatch A2): an
 * approver still running for `key` is stopped first (`superseded`, one line),
 * and the new one makes its first call only once that stop has completed.
 * No approver starts when `key` was stopped while this launch was in flight
 * (`stopDialogApprover`), or after `stopAllDialogApprovers`: one line, and
 * the answer false. Otherwise answers true. A failure inside the loop is
 * logged and the approver stops (`failed`); it never becomes an unhandled
 * rejection. The entry is removed when the approver stops. Never throws.
 *
 * `start` says why it starts (b.jg5 SRJ-401, SRJ-407): after a launch that
 * returned (`APPROVER_START_AFTER_LAUNCH`, the default; `afterLaunchSucceeded`),
 * or after a launch timeout whose `get` read the persona's row `pending`
 * (`APPROVER_ORIGIN_LAUNCH_TIMEOUT`; `afterLaunchUnavailable`). For the
 * launch-timeout origin the entry first checks the pending-row step's
 * decision on that row, as a guard beside its caller's: a row that is not
 * covered, undecided, or with no launch start (by the decision, or a launch
 * start that does not parse) gets no approver, with one line
 * (`approverRefusedRowMessage`), and the answer false. An approver it starts
 * logs one line naming the origin (`approverStartedAfterLaunchTimeoutMessage`)
 * and then runs exactly as one started after a returned launch: the same
 * loop, stop rules, pace, B from the launch start its first lap keeps, and
 * the one-approver rule (SRJ-404).
 */
export function startDialogApprover(
  key: string,
  isStartup: boolean,
  ref: string = keyRef(key),
  start: ApproverStart = APPROVER_START_AFTER_LAUNCH,
): boolean {
  const rowRefusal = approverRowRefusal(start)
  if (rowRefusal !== undefined) {
    console.error(approverLogLine(approverRefusedRowMessage(ref, rowRefusal)))
    return false
  }
  const refusal = approversClosed ? APPROVER_STOP_SHUTDOWN : cancelledComingApprovers.get(key)
  if (refusal !== undefined) {
    console.error(approverLogLine(approverNotStartedMessage(ref, refusal)))
    return false
  }
  if (start.origin === APPROVER_ORIGIN_LAUNCH_TIMEOUT) console.error(approverLogLine(approverStartedAfterLaunchTimeoutMessage(ref)))
  const previous = runningApprovers.get(key)
  if (previous !== undefined) requestApproverStop(previous, APPROVER_STOP_SUPERSEDED, true)
  // b.jg5 SRJ-412: the window of the launch call that starts this approver, for its first lap's own-launch record.
  const run = newApproverRun(launchCallWindowOf(key))
  let resolveStopped!: (outcome: ApproverOutcome) => void
  const stopped = new Promise<ApproverOutcome>((resolve) => {
    resolveStopped = resolve
  })
  const entry: RegisteredApprover = { run, ref, stopped }
  runningApprovers.set(key, entry)
  const launch = inFlightLaunches.get(key)
  runOutsideAttempts(() => {
    void runRegisteredApprover(key, isStartup, entry, launch, previous).then(resolveStopped)
  })
  return true
}

/**
 * The registered approver's run: waits for `launch` to settle and
 * `previous` to stop, runs the loop unless a stop came meanwhile, and
 * removes its entry. Never rejects.
 */
async function runRegisteredApprover(
  key: string,
  isStartup: boolean,
  entry: RegisteredApprover,
  launch: Promise<unknown> | undefined,
  previous: RegisteredApprover | undefined,
): Promise<ApproverOutcome> {
  let reason: ApproverStopReason
  try {
    // Always awaited, so the first call comes after the start entry returned.
    await (launch ?? Promise.resolve()).then(
      () => undefined,
      () => undefined, // the launch's own caller handles its outcome
    )
    if (previous !== undefined) await previous.stopped
    reason = entry.run.stopRequested ?? (await runApproverLoop(key, isStartup, entry.ref, entry.run))
  } catch (err) {
    console.error(approverLogLine(approverFailedMessage(entry.ref, describeThrownValue(err))))
    reason = APPROVER_STOP_FAILED
  }
  const outcome: ApproverOutcome = { reason, launchStartMs: entry.run.launchStartMs }
  if (runningApprovers.get(key) === entry) {
    runningApprovers.delete(key)
    lastApproverOutcomes.set(key, outcome)
  }
  // b.jg5 SRJ-409, SRJ-404: the row an approver leaves `pending` when it stops is watched.
  armAfterApproverStop(key, entry.ref, reason, entry.run.lastStateRead)
  // b.jg5 SRJ-404, SRJ-410: and gets the pending-row rule's one run, queued, not awaited.
  queueApproverStopRuleRun(key, entry.ref, reason, entry.run)
  return outcome
}

/**
 * The approver stops after which the row it leaves `pending` arms the
 * persona's retry timer in pending-only mode (b.jg5 SRJ-409, SRJ-404): B or
 * the test cap, GONE, not interactive, tmux unavailable, the one-approver
 * rule (`superseded`), and a loop that threw (`failed`, so a `pending` row
 * is never left unwatched). Never after shutdown, a latch, the key's
 * retired-key recording, a teardown or the abort of the persona's own stuck
 * launch (`stuck-launch-abort`: its kill and sequence follow, b.jg5
 * SRJ-412); `live`, `finished`, `absent` and
 * `no-launch-start` leave no covered `pending` row. The same set is the one
 * after which the pending-row rule runs once for P (b.jg5 SRJ-404, SRJ-410;
 * `queueApproverStopRuleRun`), for a last read of `pending` with a launch
 * start; there is no second list.
 */
const APPROVER_STOPS_THAT_ARM: ReadonlySet<ApproverStopReason> = new Set<ApproverStopReason>([
  APPROVER_STOP_BOUND,
  APPROVER_STOP_CAP,
  APPROVER_STOP_GONE,
  APPROVER_STOP_NOT_INTERACTIVE,
  APPROVER_STOP_TMUX_UNAVAILABLE,
  APPROVER_STOP_SUPERSEDED,
  APPROVER_STOP_FAILED,
])

/** Whether an approver stopped with `reason` arms the persona's retry timer for the row it leaves `pending` (`APPROVER_STOPS_THAT_ARM`). Pure. */
export function approverStopArmsPendingRow(reason: ApproverStopReason): boolean {
  return APPROVER_STOPS_THAT_ARM.has(reason)
}

/**
 * At the stop of persona `key`'s registered approver (after it has left the
 * registry), with `reason` and `lastState`, the state its latest `status`
 * read gave (b.jg5 SRJ-409, SRJ-404): for a stop that arms
 * (`approverStopArmsPendingRow`) whose last read was `pending`, or that read
 * no row, the persona's retry timer is armed in pending-only mode
 * (`armPendingRowWatch`: never for a latched persona), outside every
 * attempt; the controller's armed line is its line. Nothing for any other
 * stop. Never throws.
 */
function armAfterApproverStop(key: string, ref: string, reason: ApproverStopReason, lastState: string | undefined): void {
  try {
    if (!approverStopArmsPendingRow(reason)) return
    if (lastState !== undefined && lastState !== AGENT_DIRECTOR_PENDING_STATE) return
    armPendingRowWatch(key, ref)
  } catch {
    /* an arm never changes how the approver ended */
  }
}

/**
 * Stop persona `key`'s dialog approver with `reason` (b.jg5 SRJ-404), as
 * `cancelWorkingRowWait` cancels a launch's wait. A running approver is
 * marked and its sleep woken at once; it makes no call after the one in
 * progress, if any, returns (no `send-keys` follows a stop), and resolves
 * true once it has stopped, with one line logged when this stop was the
 * first asked of it. While a launch for `key` is in flight, the approver that
 * launch would start is cancelled too, from its start: it makes no call.
 * Resolves false, silently, when no approver ran. Never rejects.
 */
export async function stopDialogApprover(key: string, reason: ApproverStopRequestReason): Promise<boolean> {
  if (inFlightLaunches.has(key) && !cancelledComingApprovers.has(key)) cancelledComingApprovers.set(key, reason)
  const entry = runningApprovers.get(key)
  if (entry === undefined) return false
  requestApproverStop(entry, reason, true)
  await entry.stopped
  return true
}

/**
 * Stop every running dialog approver (`shutdown`, b.jg5 SRJ-404), and let no
 * approver start after it. Every approver is marked and woken before this
 * returns its promise, so none makes a further call once the call in
 * progress returns; the promise resolves once all have stopped. Never rejects.
 */
export async function stopAllDialogApprovers(): Promise<void> {
  approversClosed = true
  const entries = [...runningApprovers.values()]
  for (const entry of entries) requestApproverStop(entry, APPROVER_STOP_SHUTDOWN, true)
  await Promise.all(entries.map((entry) => entry.stopped))
}

/**
 * True while a dialog approver runs for persona `key` (b.jg5 SRJ-401): from
 * its start until it has stopped, a stop asked but not yet completed
 * included. Such an approver is in flight for the persona for the health
 * tick and the lost-message routing, and never blocks a retry (SRJ-303).
 */
export function isDialogApproverRunning(key: string): boolean {
  return runningApprovers.has(key)
}

/**
 * The launch start (epoch ms) that persona `key`'s running approver kept:
 * the one its first lap whose `status` read the row `pending` with a launch
 * start read (b.jg5 SRJ-401, SRJ-412). Undefined when no approver runs or
 * none has kept one yet. Read-only. The first lap that keeps it also sets
 * the record of CSCB's own launch for a launch that returned success
 * (`keepApproverLaunchStart`, `ownLaunchRecordOf`; b.jg5 SRJ-412), which
 * outlives the approver.
 */
export function dialogApproverLaunchStart(key: string): number | undefined {
  return runningApprovers.get(key)?.run.launchStartMs
}

/**
 * Test-only seam: resolves with how persona `key`'s latest approver ended:
 * the running one's, once it has stopped; otherwise at once the last one's
 * that stopped while it was the persona's latest (a superseded approver's
 * outcome is not kept); `undefined` when there is none. Starts and stops
 * nothing.
 */
export function _whenDialogApproverStopped(key: string): Promise<ApproverOutcome | undefined> {
  return runningApprovers.get(key)?.stopped ?? Promise.resolve(lastApproverOutcomes.get(key))
}

/**
 * Test-only seam: stop every running approver (marked and woken, silently;
 * each makes no further call once its call in progress returns) and forget
 * them all, with every cancel of a coming approver and the shutdown mark.
 */
export function _resetDialogApprovers(): void {
  for (const entry of runningApprovers.values()) requestApproverStop(entry, APPROVER_STOP_SHUTDOWN, false)
  runningApprovers.clear()
  cancelledComingApprovers.clear()
  lastApproverOutcomes.clear()
  approversClosed = false
}

/** The launches whose success runs the after-launch step, as the `pre_trust` line names them. */
export type LaunchVerb = typeof LAUNCH_VERB_SPAWN | typeof LAUNCH_VERB_RESUME | typeof LAUNCH_VERB_REUSE_SPAWN
/** A plain spawn (a first or retry spawn, or the spawn after `resume` found no row). */
export const LAUNCH_VERB_SPAWN = 'spawn'
/** A `resume`. */
export const LAUNCH_VERB_RESUME = 'resume'
/** A reuse spawn: agent-director's `spawn` with the reuse flag (`reuseSpawnForPersona`; b.jg5 SRJ-112, SRJ-413). */
export const LAUNCH_VERB_REUSE_SPAWN = 'reuse spawn'

/** The head of every `pre_trust` line. */
export const PRE_TRUST_LOG_PREFIX = '[slack] spawnForPersona: '

/**
 * The one log line a successful launch writes about its `pre_trust` (b.jg5
 * SRJ-413): the persona reference `ref`, the launch verb (a plain spawn, a
 * `resume` or a reuse spawn, `LaunchVerb`) and the value the result carried, shown as it arrived (rendered for the log, never checked
 * against a list); for a result without the field (`preTrust` undefined), that
 * the result came from an agent-director older than Phase 1. The line is
 * information only: no value changes what CSCB does, and a folder-trust prompt
 * that follows is the dialog approver's. Pure; never throws.
 */
export function preTrustLogLine(ref: string, verb: LaunchVerb, preTrust: PreTrust | undefined): string {
  if (preTrust === undefined) {
    return (
      `${PRE_TRUST_LOG_PREFIX}${ref} ${verb} result carries no pre_trust: ` +
      `it came from an agent-director older than Phase 1 (logged only, b.jg5 SRJ-413)`
    )
  }
  return `${PRE_TRUST_LOG_PREFIX}${ref} ${verb} pre_trust=${renderPreTrustValue(preTrust)} (logged only, b.jg5 SRJ-413)`
}

/**
 * A present `pre_trust` value as the log shows it: a string through
 * `renderLogMessageText`, any other JSON value by its JSON text, rendered the
 * same way; `<unreadable>` when that renders to nothing. Never throws.
 */
function renderPreTrustValue(value: unknown): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
  } catch {
    text = ''
  }
  const rendered = renderLogMessageText(text)
  return rendered === '' ? '<unreadable>' : rendered
}

/**
 * The one step after a launch call that returned success (b.jg5 SRJ-401):
 * the plain spawn, the retry spawn after the collision
 * `get`'s `ErrSpawnNotFound`, the `resume`, the plain spawn after
 * `resume`'s `ErrSpawnNotFound` (`plainSpawnAfterResumeNotFound`), and the reuse spawn
 * (`reuseSpawnForPersona`), including the reuse spawn of the same id after
 * `resume`'s no-transcript answer (b.jg5 SRJ-707, SRJ-712). `verb` names the launch and `launched` is the
 * call's whole result. The step writes the launch's one
 * `pre_trust` line (`preTrustLogLine`, b.jg5 SRJ-413), then arms the
 * persona's retry timer in pending-only mode with the `pending-row` cause
 * (`armPendingRowWatch`; b.jg5 SRJ-301, SRJ-409: the row a launch that
 * returned leaves reads `pending` until its session reports in, and is the
 * persona's own current life, built from its own spawn parameters; a
 * latched persona is not armed), then starts the persona's dialog approver
 * (`startDialogApprover`) without awaiting it, so the ladder's result is
 * returned as soon as the launch call returned. Every success site calls
 * it, so the arm covers each of them: the live-row sequence's final launch,
 * a `fresh-retired` reuse, and the launch the pending-only retry's hand-off
 * run makes. A full-mode retry whose launch succeeds still switches to
 * pending-only mode (`armPendingOnly` is no full-mode cause).
 * The client returns the parsed reply as is, so a `null` or missing result
 * is read as one with no `pre_trust` field. Nothing here or after it reads
 * the `pre_trust` value. Never throws.
 */
function afterLaunchSucceeded(
  key: string,
  isStartup: boolean,
  ref: string,
  verb: LaunchVerb,
  launched: Phase1SpawnResult | Phase1ResumeResult,
): void {
  console.error(preTrustLogLine(ref, verb, launched?.pre_trust))
  armPendingRowWatch(key, ref)
  try {
    startDialogApprover(key, isStartup, ref)
  } catch (err) {
    // Not reached: the start entry never throws.
    console.error(approverLogLine(approverFailedMessage(ref, describeThrownValue(err))))
  }
}

/**
 * Resolves once the launch in flight for persona `key` (if any) has settled,
 * whatever its outcome; at once when none is. Never rejects and starts
 * nothing. For a teardown (b.av2 SR-6.6), which must not kill the row while
 * a launch is still bringing it up; launches that run outside the
 * lifecycle serializer (the start pass) are covered too. The launch's dialog
 * approver is not waited for: a launch settles as its launch call returns,
 * and the teardown stops the approver first (`stopDialogApprover`, b.jg5
 * SRJ-404, SRJ-715).
 */
export async function whenLaunchSettled(key: string): Promise<void> {
  const inFlight = inFlightLaunches.get(key)
  if (inFlight === undefined) return
  try {
    await inFlight
  } catch {
    /* the launch's own caller handles its outcome */
  }
}

/**
 * Core per-persona spawn dispatcher (SR-1.4), addressing `cscb_<key>`:
 *
 * 00. The held gate (b.jg5 SRJ-207): a persona the installed hold
 *    (`setInvalidFlagsHold`) holds on `ErrInvalidFlags`, and that is not
 *    latched, answers `held` before any other step, joining no launch in
 *    flight, with one line: no agent-director call, no trust patch, no
 *    reply-guard step, no record written, nothing armed or counted. A held
 *    query that throws counts as held. A latched persona goes on to the
 *    latched gate.
 * 0. The live-row sequence gate (b.jg5 SRJ-706): while a live-row sequence
 *    runs for the persona (`isLiveRowSequenceRunning`) and it is not
 *    latched, the call answers `sequence-waiting` before any other step,
 *    joining no launch in flight (the sequence's own step-6 launch
 *    included), with one log line: no agent-director call, no trust patch,
 *    no reply-guard step, no record written, nothing armed. The sequence's
 *    own launch (`launchForLiveRowSequence`) does not come through here and
 *    is exempt. A latched persona goes on to the latched gate.
 * 0a. The old-life gate (b.jg5 SRJ-810 bullet 3; b.av2 SR-6.1 as amended by
 *    b.jg5 SRJ-1502: "(4) launch, which waits while an old life that may
 *    still be running holds the persona's working directory (b.jg5 SRJ-809,
 *    SRJ-810); the persona is retried on its UNAVAILABLE retry timer (b.jg5
 *    SRJ-301) until that wait ends"): while a hold whose instance id is not
 *    the persona's own `cscb_<key>` is on its working directory, by real
 *    path, and it is not latched, the hold step (`oldLifeHoldStep`) records
 *    the persona as waiting on each such hold, starts each hold's wait when
 *    it is not running (`ensureOldLifeWait`; one wait per held instance id),
 *    arms its retry timer with the held-for-an-old-life cause and logs one
 *    line (`oldLifeHoldLaunchLine`), and the call answers `sequence-waiting`
 *    (`sequenceWaitingCause` `old-life-hold`) before any other step, joining
 *    no launch in flight: no agent-director call, no trust patch, no
 *    reply-guard step, no record written. `launchSession` answers it with
 *    the uncounted `'refused'`, so the timer stays armed, and the start
 *    summary counts it under "waiting on a live-row sequence" (b.jg5
 *    SRJ-1015). A hold on the persona's own row does not hold it here: a
 *    destructive modify's same-key new half waits by the retired-key rule
 *    through its live-row sequence (step 4a; SRJ-805), and a held own row of
 *    a key that is not recorded is replaced through the live-row sequence by
 *    the ladder's `cwd` replace step or the restart path's reconnect adapter.
 *    Once no such hold is left, the launch takes the ladder unchanged; a
 *    renamed persona's new key then gets its plain first spawn (b.jg5
 *    SRJ-711). A latched persona goes on to the latched gate.
 * 1. One in-flight launch per persona (b.av2 SR-6.3): while a launch for the
 *    key is in flight, a second call joins it and receives its result instead
 *    of starting a second ladder. The start's worker pool and the restart
 *    module's `launchSession` both come through here. Keys are independent.
 * 1a. The latched gate (b.jg5 SRJ-502): a persona the installed latch
 *    (`setConflictLatch`) holds latched answers `latched` before any other
 *    step, with one log line naming its case, and nothing else runs. A call
 *    joining a launch already in flight still gets that launch's result.
 * 2. Pre-launch claude_config_dir check (bug b.g57, `checkLaunchConfigDir`),
 *    dry run included: when the directory cannot be resolved to a real path,
 *    nothing else runs (no trust patch, no reply-guard step, no
 *    agent-director call, no record written); the failure goes to the
 *    installed hook (the bring-up controller holds the persona `retrying`)
 *    and the result is `deferred`. Otherwise its real path gives the spawn's
 *    `config_dir` label.
 * 3. Dry-run: skip the rest, return synthetic success.
 * 4. Run the installed pre-launch trust patcher for the persona (b.av2
 *    SR-6.2) once, before any spawn or resume the ladder makes.
 *    Then attempt `client.spawn(...)`: a plain first spawn from
 *    `buildSpawnParams`, with no reuse flag (b.jg5 SRJ-711), so a key whose
 *    row is already there collides and step 5's `get` and `resume` keep its
 *    conversation; only the reuse launch adds the flag, and the only first
 *    launch that is a reuse is a retired key's (step 4a). On success → done. Every spawn and
 *    resume below is immediately preceded by the installed pre-launch reply
 *    guard (b.av2 SR-9.4); the optimistic spawn undoes its reply-guard steps
 *    on `ErrInstanceIdCollision`: the record and launched-with dir are
 *    restored while still its own, and the hook is re-evaluated.
 * 4a. The retired-key rule (b.jg5 SRJ-805, SRJ-806): while the installed
 *    retired-key store has the key recorded (`retiredKeyReadingOf`), marked
 *    or not, no plain spawn and no `resume` is made for it on any path, and
 *    each launch decision for it writes again a mark held only in memory
 *    after its write failed (`retiredLaunchReadingOf`). Its first launch is
 *    one reuse spawn of `cscb_<key>` in place of the plain spawn
 *    (`retiredKeyFirstLaunch`), whatever row there is: with no row an
 *    ordinary fresh spawn, which makes agent-director's pre-spawn scan (HO
 *    rev 15); on a finished row a reset to a new life. Its success answers
 *    `fresh-retired` and sets the "new life has begun" mark
 *    (`reuseSuccessAction`). A live row (`pending` included) makes it
 *    collide; the reply-guard steps are undone and step 5's collision `get`
 *    decides by the rule (`retiredKeyAtCollision`), after the `cwd` guard,
 *    as the one re-run that reuse collision gives (SRJ-112), so a reuse
 *    there that collides too is the second collision:
 *    a finished row or no row gets the replace step's reuse; with no mark a
 *    live row is the old life, and the replace step starts the live-row
 *    sequence with the retired-key flag (conversation not kept, context
 *    `recovery`) and answers `sequence-waiting`; with the mark set a live
 *    row is the new life and takes step 5's live branches as any live row,
 *    never replaced by this rule. `resumeOrFreshSpawn`, reached from those
 *    branches, makes a reuse in place of every `resume`, and the live-row
 *    sequence's start entry sets the retired-key flag, so no sequence for
 *    the key ends in a `resume`. A key that is not recorded takes steps 4
 *    to 8 as written below (SRJ-711).
 * 5. `ErrInstanceIdCollision` → `client.get(...)`, the shared own-row read
 *    (`readPersonaOwnRow`, b.jg5 SRJ-114), then:
 *    - the note check comes first, before the guards and the state branches:
 *      a read that latched the persona (its own row carries the
 *      `provenance_conflict` note and it is configured) answers `latched` at
 *      once, whatever the row's state, `cwd` or `config_dir` label: no wait,
 *      sweep, reconnect, sequence or launch, no notice, nothing counted
 *      (b.jg5 SRJ-501, SRJ-502). Any other note, or none, goes on below.
 *      `ErrSpawnNotFound` retries the plain spawn once, through the one
 *      plain-spawn outcome handler (`plainSpawnOutcomeAt`, b.jg5 SRJ-111),
 *      whose collision re-runs this step once (`plainSpawnCollisionAtLadder`;
 *      a plain spawn's collision in that re-run answers `retrying` with the
 *      retry timer armed); any other error takes the refusal row (`refusalAt`);
 *    - the row's `cwd` differs from the persona's working_directory by real
 *      path (`compareRowToPersona`) → the replace step, whatever the state
 *      and resume_enabled (b.av2 SR-6.2 as amended, b.jg5 SRJ-1503: "An
 *      existing row whose `cwd` differs from the persona's working
 *      directory, by real path, is replaced on every ladder path with no row
 *      deleted: a live row goes through the live-row sequence (b.jg5
 *      SRJ-705), then a reuse spawn; a finished row gets a reuse spawn (b.jg5
 *      SRJ-707)."). When the working directory
 *      cannot be resolved to a real path at that moment and the row's `cwd`
 *      has none either (`cwdCheckDeferred`), the row is kept instead: no
 *      replacement, `cwd-unreachable` raised and `failed` returned
 *      (b.av2 SR-6.4). Otherwise branch on state:
 *    - ended/missing + resume_enabled → resume; on ErrNoSessionId/
 *      ErrJsonlMissing/ErrJsonlNeverWritten → the no-transcript step: after
 *      ErrJsonlMissing the lost-transcript diagnosis, then one reuse spawn
 *      of the same id through the replace step's finished-row branch;
 *      nothing is deleted (`noTranscriptReuse`, `reuseFinishedRow`); on
 *      ErrSpawnNotResumable → the not-resumable step (b.jg5 SRJ-710): one
 *      re-read of the row; `pending` → the ladder's `pending` step, nothing
 *      counted or posted; another live state → the live-row sequence with
 *      the conversation kept only when the path holds dead evidence
 *      (SRJ-611); otherwise a lost race: nothing killed, deleted or
 *      launched, the retry timer armed with the lost-race cause,
 *      `retrying`; on ErrSpawnNotFound → one plain spawn through the one
 *      plain-spawn outcome handler, whose collision re-runs this step once
 *      (SRJ-113, SRJ-111). An escalate-dead verdict the restart path carried
 *      in (`deadEvidence`) is named in one line, and is void: the collision
 *      `get`'s finished read voids it for the rest of the attempt (b.jg5
 *      SRJ-611, dead evidence covers one life).
 *    - ended/missing + !resume_enabled → the replace step: a reuse spawn of
 *      the same id.
 *    - waiting → the reconnect (`reconnectMcpWithCause`, one `send-keys`,
 *      b.jg5 SRJ-118); 'dead-session', whatever its cause → the find-missing
 *      run, then resume/fresh-spawn (b.3ce), whose resume or spawn decides
 *      what holds the persona's name. The route's one line names its cause
 *      and hands it on (`deadSessionRoute`, b.jg5 SRJ-611): only a
 *      GONE-based cause (`tmux-gone`) is dead evidence, never
 *      `row-not-interactive` or `row-absent`, and the find-missing run is
 *      made for every cause; `row-not-interactive` voids a verdict the
 *      restart path carried in, and `row-absent` voids all the path holds
 *      (dead evidence covers one life); 'transient' → `latched` for a latched
 *      persona, otherwise `retrying` (b.jg5 SRJ-1015): no spawn-failure
 *      notice, no `spawn-failed` entry, nothing counted.
 *    - working → waitForWaitingAndReconnect; its outcome is mapped as the
 *      `waiting` branch maps the reconnect's ('dead-session', with the
 *      wait's cause: the reconnect's, `row-absent` or `row-read-finished`,
 *      of which only `tmux-gone` is dead evidence, and 'transient');
 *      'not-reconnected' or 'cancelled' (its teardown cancelled
 *      the wait) → `not-reconnected` (b.f2b: nothing was typed;
 *      `reconnected` only when `/mcp reconnect` was). `hooks.onWorkingRowWait`
 *      is called as the wait starts (b.f2b).
 *    - check_permission/ask_user → never typed into; one one-line
 *      `read-pane` of the persona's own row through the shared reader first
 *      (b.jdc, b.jg5 SRJ-607, `launchOnPromptRow`), with no tmux call: a
 *      pane, UNAVAILABLE, CONFIG, UNCLASSIFIED or ENVIRONMENT → no-op; GONE
 *      or the row absent (`ErrSpawnNotFound`) → findMissing sweep and a
 *      re-read, and a row now `ended` or `missing` → resume/fresh-spawn,
 *      naming `prompt-row-ladder-gone` (dead evidence) after a GONE and
 *      `row-absent` (not dead evidence) after an absent row, both void once
 *      the re-read found the row finished (b.jg5 SRJ-611)
 *      (otherwise no-op); CONFLICT or UNUSABLE NAME (the reader latched the
 *      persona) → `latched`.
 *    - pending → the ladder's `pending` step (`ladderPendingRowStep`):
 *      no-op when its `cwd` and `config_dir` label match, the persona's
 *      retry timer armed in pending-only mode (b.jg5 SRJ-409); a label
 *      missing or different (b.jg5 SRJ-411, SRJ-707) means the row is not
 *      covered, and the replace step sends it through the live-row sequence.
 *    Every resume first checks the row's `config_dir` label; a missing or
 *    different label means the replacement instead (resumeOrFreshSpawn;
 *    b.av2 SR-6.2 as amended, b.jg5 SRJ-1504). A replacement there whose
 *    path last read the row live but holds no dead evidence reads the row
 *    again first and never starts the sequence itself (`replaceAtResumeSite`,
 *    b.jg5 SRJ-609, SRJ-611).
 *    A directory that stopped resolving since step 2 keeps the row and
 *    returns `deferred` instead.
 *    The replace step (`replacePersonaRow`, b.jg5 SRJ-707) decides on the
 *    row state the path last read: `ended`, `missing` or no row → one reuse
 *    spawn of the same id (`reuseSpawnForPersona`); its collision re-runs
 *    this step 5 once, and a second collision arms the reuse-collision
 *    cause and answers `retrying`; any live state,
 *    `pending` included → the live-row sequence is started (SRJ-705,
 *    SRJ-706) and the launch answers `sequence-waiting` with no other call.
 *    Nothing in step 5 deletes or kills a row.
 * 6. A CONFLICT at any spawn or resume above latches the persona and
 *    answers `latched` (b.jg5 SRJ-501, `conflictAt`); other errors → surface
 *    to Slack + (when isStartup) startup-errors.log, except a refusal and,
 *    at a plain spawn, any error but a LAUNCH FAILURE (SRJ-111: a collision
 *    is get-then-act, and `ErrInvalidFlags` and the names a plain spawn
 *    gives no meaning are UNCLASSIFIED). An
 *    `ErrTmuxSessionCreate` (LAUNCH FAILURE, by name) at any of them is one
 *    counted launch failure (b.jg5 SRJ-602; `plainSpawnFailedAt`,
 *    `resumeFailedAt`): the notice, a `spawn-failed` entry at start, and
 *    `failed` marked `countedClass`; nothing is killed because of it, no
 *    spawn is made in its place, and the persona's retry timer is armed at
 *    once in pending-only mode (`launchFailureResult`; SRJ-301, SRJ-409).
 *    An UNAVAILABLE outcome of any spawn or resume above (a launch timeout,
 *    either form, included) is a refusal followed by one `get` of the
 *    persona's row and no launch in the attempt (`afterLaunchUnavailable`,
 *    b.jg5 SRJ-407): a covered `pending` row after a launch timeout gets the
 *    dialog approver, a row that is not covered the live-row sequence, and
 *    the launch answers `retrying`, `latched` or `sequence-waiting`.
 * 7. Steps 4 to 6 run as a launch attempt for the key (b.jg5 SRJ-301,
 *    `runInAttempt`): an agent-director error there that the arming predicate
 *    answers a cause for arms the persona's retry timer through the installed
 *    trigger sink, and a `failed` result (not `stopping`) whose attempt's
 *    last agent-director error armed it is answered as `retrying`
 *    (`retryingWhenArmed`, b.jg5 SRJ-1015). A joining call,
 *    the held and latched gates, the claude_config_dir deferral and dry run
 *    are no attempt.
 * 8. Every spawn or resume above that returns success is followed by one
 *    after-launch step (`afterLaunchSucceeded`), which arms the persona's
 *    retry timer in pending-only mode for the launch's `pending` row (b.jg5
 *    SRJ-301, SRJ-409; never for a latched persona) and starts the persona's
 *    dialog approver in its own registry (`startDialogApprover`, b.jg5
 *    SRJ-401) without awaiting it: the result is returned as soon as the
 *    launch call returns, and the launch is no longer in flight
 *    (`isLaunchInFlight`) while the approver runs. The approver runs outside
 *    the launch attempt. Besides it, only the step after a launch timeout
 *    whose `get` read a covered `pending` row starts one, through the same
 *    start entry with the launch-timeout origin (`afterLaunchUnavailable`,
 *    b.jg5 SRJ-407); no other branch, result or dry run starts one.
 *
 * `hooks` belong to the ladder this call starts; a call that joins a launch
 * already in flight gets none of them.
 *
 * `deadEvidence` is the escalate-dead verdict the restart path carries into
 * its relaunch (b.jg5 SRJ-611; absent, none): the ladder keeps it for the
 * run (decided again from its cause or verdict, `carriedDeadEvidenceOf`),
 * and every `resumeOrFreshSpawn` call it makes holds dead evidence when that
 * verdict is dead evidence or the path's own cause is, until a read of the
 * row as `ended`, `missing` or gone, or a reconnect's `row-not-interactive`
 * answer, voids it for the rest of the attempt (dead evidence covers one
 * life, `voidDeadEvidence`). A call that joins a
 * launch already in flight gets that launch's result, and its verdict is
 * dropped with one line. The held, `sequence-waiting` and old-life gates run
 * before the join check, so they answer either way; the latched gate runs after it, so
 * it answers only a call that starts a ladder (a joining call gets the
 * in-flight launch's result).
 */
export async function spawnForPersona(
  persona: Persona,
  config: PersonaConfig,
  isStartup = true,
  hooks?: LaunchHooks,
  deadEvidence?: CarriedDeadEvidence,
): Promise<SpawnPersonaResult> {
  const { key } = persona
  const ref = personaRef(persona)
  // b.jg5 SRJ-207: a persona held on ErrInvalidFlags is not launched, whoever
  // asks, and joins no launch in flight: no agent-director call, no trust
  // patch, no reply-guard step, no record. A latched persona still gets the
  // latched gate's answer.
  const held = heldResult(key, ref, 'spawnForPersona')
  if (held !== undefined) return held
  // b.jg5 SRJ-706: while P's live-row sequence runs (its own step-6 launch in
  // flight included), no other launch for P starts or joins one: no
  // agent-director call, no trust patch, no reply-guard step, no record.
  // A latched persona still gets the latched gate's answer.
  const sequenceWaiting = sequenceWaitingResult(key, ref, 'spawnForPersona')
  if (sequenceWaiting !== undefined) return sequenceWaiting
  // b.jg5 SRJ-810, SRJ-1502: while an old life may still run in P's working
  // directory, P is not brought up: no agent-director call, no trust patch,
  // no reply-guard step, no record. P is recorded as waiting, the hold's wait
  // is started and P's retry timer armed. A hold on P's own row is not this
  // gate's (SRJ-805's retired-key rule). A latched persona still gets the
  // latched gate's answer.
  const oldLifeHeld = oldLifeHoldResult(persona, ref, 'spawnForPersona')
  if (oldLifeHeld !== undefined) return oldLifeHeld
  // b.jg5 SRJ-611: decided again from its cause or verdict, so a value cast
  // past the brand carries only what its source proves.
  const carriedIn = carriedDeadEvidenceOf(deadEvidence?.source)
  const inFlight = inFlightLaunches.get(key)
  if (inFlight) {
    console.error(`[slack] spawnForPersona: launch already in flight for ${ref} — joining it`)
    if (carriedIn.source !== DEAD_EVIDENCE_NONE) console.error(joinedLaunchDropsDeadEvidenceLine(ref, carriedIn))
    return inFlight
  }

  // b.jg5 SRJ-502: a latched persona is not launched, whoever asks (the start
  // pass, the bring-up controller, an apply's bring-up, a restart, a retry):
  // no trust patch, no reply-guard step, no config-dir hold and no
  // agent-director call. A latch that cannot be read counts as latched.
  const latched = latchGateReadingOf(key)
  if (latched !== undefined) {
    const why = latched.failure === undefined ? 'it is latched' : `${latched.failure} — taken as latched`
    console.error(
      `[slack] spawnForPersona: not launching ${ref} — ${why} (case=${latched.latchCase}); no agent-director call (b.jg5 SRJ-502)`,
    )
    return { key, action: 'latched' }
  }

  const configDir = checkLaunchConfigDir(persona)
  if (!configDir.ok) {
    deferLaunchForConfigDir(persona, configDir)
    return deferredResult(persona, configDir)
  }

  if (isDryRun()) {
    console.error(`[slack] dry-run: skipping spawn for ${ref} cwd=${persona.working_directory}`)
    return { key, action: 'no-op' }
  }

  const configDirLabel = configDirLabelValue(configDir.realPath, spawnHomeDir())
  // b.f2b: the restart path's idle evidence for an earlier `working` row says
  // nothing about the session this launch brings up (and must not let the
  // health check skip its two-tick guard while it boots), and the launch's own
  // wait, if any, starts its own run of deferrals on the row. b.jdc: nor does
  // its run of deferrals on a row waiting on a prompt.
  forgetWorkingRowEvidence(key)
  endWorkingRowDeferral(key)
  endPromptRowDeferral(key)
  // b.jg5 SRJ-301, SRJ-1015: the ladder is a launch attempt; joiners get its result, `retrying` included.
  const launch = runInAttempt(key, 'launch', async (attempt) =>
    retryingWhenArmed(await runPersonaLadder(persona, config, isStartup, ref, configDirLabel, hooks, carriedIn), attempt),
  )
  inFlightLaunches.set(key, launch)
  try {
    return await launch
  } finally {
    if (inFlightLaunches.get(key) === launch) {
      inFlightLaunches.delete(key)
      // b.f2b: a teardown's cancel of this launch's wait ends with it, and
      // (b.jg5 SRJ-404) so does a stop of the approver it had not started.
      cancelledLaunchWaits.delete(key)
      cancelledComingApprovers.delete(key)
    }
  }
}

/**
 * `spawnForPersona`'s line when a call that carried an escalate-dead verdict
 * (`carried`, b.jg5 SRJ-611) joins persona `ref`'s launch already in flight:
 * it gets that launch's result, and its verdict is dropped.
 */
export function joinedLaunchDropsDeadEvidenceLine(ref: string, carried: CarriedDeadEvidence): string {
  return `[slack] spawnForPersona: the joining call for ${ref} carried an escalate-dead verdict (${describeDeadEvidence(carried)}) — dropped; it gets the launch in flight's result (b.jg5 SRJ-611)`
}

/**
 * `retrying` (b.jg5 SRJ-1015) in place of `result` when it is `failed`, not
 * marked `stopping`, and the launch attempt's last agent-director error
 * armed the persona's retry timer (b.jg5 SRJ-301), which now owns the
 * persona. Any other result is returned as it is.
 */
function retryingWhenArmed(result: SpawnPersonaResult, attempt: AttemptView): SpawnPersonaResult {
  if (result.action !== 'failed' || result.stopping === true || attempt.lastError?.armed !== true) return result
  return { key: result.key, action: SPAWN_ACTION_RETRYING }
}

/** What the ladder answered for a `transient` reconnect (`transientReconnectResult`). */
export type TransientReconnectAnswer = 'latched' | typeof SPAWN_ACTION_RETRYING | 'stopping'

/**
 * The ladder's one line for a `transient` reconnect at its `waiting` or
 * `working` branch (`state`), with what it answered (b.jg5 SRJ-118, SRJ-609).
 */
export function transientReconnectLine(ref: string, state: string, answer: TransientReconnectAnswer): string {
  const what =
    answer === 'latched'
      ? 'the persona is latched — answering latched'
      : answer === 'stopping'
        ? 'a version re-check decided that the server stops — answering failed, marked stopping'
        : 'answering retrying'
  return `[slack] spawnForPersona: the reconnect for ${ref} (state=${state}) was transient: nothing was typed; ${what}; no spawn-failure notice, no spawn-failed entry, nothing counted (b.jg5 SRJ-118)`
}

/**
 * The ladder's result for a `transient` reconnect at its `waiting` or
 * `working` branch (b.jg5 SRJ-118, SRJ-609): a `failed` result marked
 * `stopping` when a version re-check decided the stop (b.jg5 SRJ-205);
 * `latched` when the reconnect latched the persona or found it latched, or
 * the latched query (`personaLatchedNow`, b.jg5 SRJ-502) answers it latched;
 * otherwise `retrying` (b.jg5 SRJ-1015, which `launchSession` answers as
 * `'refused'` and the restart path never counts). No spawn-failure notice,
 * no `spawn-failed` entry, nothing counted,
 * and nothing more is called. One line (`transientReconnectLine`).
 */
function transientReconnectResult(
  key: string,
  ref: string,
  state: string,
  transient: { latched?: true; stopping?: true },
): SpawnPersonaResult {
  if (transient.stopping) {
    console.error(transientReconnectLine(ref, state, 'stopping'))
    return { key, action: 'failed', stopping: true }
  }
  if (transient.latched || personaLatchedNow(key)) {
    console.error(transientReconnectLine(ref, state, 'latched'))
    return { key, action: 'latched' }
  }
  console.error(transientReconnectLine(ref, state, SPAWN_ACTION_RETRYING))
  return { key, action: SPAWN_ACTION_RETRYING }
}

/** A caller's view into the collision ladder one `spawnForPersona` call starts (b.f2b). */
export interface LaunchHooks {
  /**
   * Called once, as the ladder starts waiting for a `working` row to settle
   * (`waitForWaitingAndReconnect`, up to `WAIT_FOR_WAITING_TIMEOUT_MS`). The
   * start pass stops waiting for the launch here and lets it finish in the
   * background; the launch stays in flight until it settles. Must not throw.
   */
  onWorkingRowWait?: () => void
}

/**
 * One collision ladder for a persona; `spawnForPersona` single-flights it per
 * key. `carriedDeadEvidence` is the escalate-dead verdict the restart path
 * carried in (b.jg5 SRJ-611), kept for the run (`LadderRun`).
 * Not `async` on purpose (keeps callers' microtask timing); its async-arrow caller turns a throw into a rejection.
 */
function runPersonaLadder(
  persona: Persona,
  config: PersonaConfig,
  isStartup: boolean,
  ref: string,
  configDirLabel: string,
  hooks: LaunchHooks | undefined,
  carriedDeadEvidence: CarriedDeadEvidence,
): Promise<SpawnPersonaResult> {
  const { key } = persona
  const params = buildSpawnParams(persona, config, configDirLabel)

  // b.av2 SR-6.2: the trust patch precedes every launch. Running it once here,
  // before the first agent-director spawn or resume this ladder can make,
  // covers every path below (the patch is idempotent).
  runPreLaunchTrustPatch(persona, ref)

  // b.jg5 SRJ-805, SRJ-806: while the key is recorded its first launch is a
  // reuse spawn, never a plain spawn and never a `resume`; this launch
  // decision also writes again a mark held only in memory. Its reading and
  // the key's record generation are the attempt's start, which every reuse
  // the ladder makes compares against.
  const retired = retiredLaunchReadingOf(key)
  const run: LadderRun = {
    persona,
    config,
    isStartup,
    ref,
    params,
    hooks,
    reuseCollisionRerun: false,
    plainSpawnCollisionRerun: false,
    carriedDeadEvidence,
    retiredAtStart: retiredKeyAttemptStartOf(key, retired),
  }
  if (retired.recorded) return retiredKeyFirstLaunch(run, retired)

  // Attempt fresh spawn ---
  // b.jg5 SRJ-711: the first spawn is plain (`buildSpawnParams`, no reuse
  // flag), so a key whose row is already there collides and goes on to the
  // collision `get` and `resume` below, which keep the conversation. Only the
  // reuse launch adds the flag; the only first launch that is a reuse is a
  // retired key's (SRJ-805, above).
  // b.av2 SR-9.4: the reply-guard steps run immediately before every spawn or
  // resume, never on a path that only reconnects to a live instance or does
  // nothing. This optimistic spawn is a launch only when no row exists; a
  // collision means an instance already exists, so the handler undoes its
  // steps (the record and launched-with dir restored while still this step's
  // own, and the hook re-evaluated against the persona's current config) and
  // any later spawn or resume below runs them again.
  // b.jg5 SRJ-111: SRJ-111's table through the one plain-spawn outcome
  // handler. A CONFLICT latches the persona with the refused operation
  // "plain spawn": the pre-spawn scan's refusal wrote no row, and one after
  // "duplicate session" ended the new row unless agent-director's end write
  // was not applied; nothing of the row was read before this first spawn,
  // so the latch-time `status` read gives its state. An
  // `ErrTmuxSessionCreate` (by name) is one counted launch failure: nothing
  // is killed and no spawn is made in its place, and the persona's retry
  // timer is armed at once in pending-only mode. Its `pending` row is never
  // CSCB's own launch, so the retries wait it out through the pending-row
  // rule, never killing it, and bring the persona up once it reads
  // `missing` (b.jg5 SRJ-602, SRJ-713, SRJ-409, SRJ-410). Its collision
  // leads on to get-then-act, as its first run, not a re-run, and never to
  // the spawn-failure notice (SRJ-114, SRJ-713).
  return plainSpawnOutcomeAt<SpawnPersonaResult>({
    persona,
    isStartup,
    ref,
    params,
    what: 'spawn',
    lastRead: NOTHING_READ,
    spawnedLine: (r) => `[slack] spawnForPersona: spawned ${ref} instanceId=${r.claude_instance_id}`,
    collided: () => {
      console.error(`[slack] spawnForPersona: ErrInstanceIdCollision for ${ref} — fetching current state`)
      return ladderGetThenAct(run)
    },
  })
}

/** What the ladder's lines call its retry spawn after the collision `get` answered `ErrSpawnNotFound`. */
const LADDER_RETRY_SPAWN_WHAT = 'retry-spawn'

/** What the retired-key rule's lines call the reuse spawn it makes. */
const RETIRED_KEY_REUSE_WHAT = "retired key's reuse spawn"

/** The replace step's reason for a retired key's row (b.jg5 SRJ-805). */
const RETIRED_KEY_WHY = 'its key is retired'

/** A retired key's reading in words, for a line: whether its new life has begun (b.jg5 SRJ-805, SRJ-806). */
function describeRetiredMark(retired: RetiredKeyReading): string {
  return retired.marked ? 'its new life has begun' : 'no new life has begun yet, so any row it has is the old life'
}

/**
 * The first launch of persona `run.persona` while its key is recorded
 * (b.jg5 SRJ-805; `retired`, the launch decision's reading): one line, then
 * one reuse spawn of `cscb_<key>` (`reuseSpawnForPersona`, SRJ-112) whatever
 * row there is, marked or not: never a plain spawn and never a `resume`. With
 * no row it is an ordinary fresh spawn, which makes agent-director's
 * pre-spawn scan (HO rev 15); on a finished row it resets the row to a new
 * life. Nothing of the row was read before it, so a CONFLICT or UNUSABLE
 * NAME takes the one latch-time `status` read (SRJ-501). Its success answers
 * `fresh-retired` and sets the mark (SRJ-806); every other outcome but a
 * collision is SRJ-112's. A collision (the row is live, `pending` included)
 * undoes the reply-guard steps, as the plain first spawn's does, and goes on
 * to get-then-act (`ladderGetThenAct`), whose collision `get` reads the row
 * and whose retired-key rule decides on it: an old life goes through the
 * live-row sequence, so each live old life costs one refused reuse. That
 * collision is the attempt's one reuse collision (SRJ-112), so this
 * get-then-act is marked as its one re-run (`run.reuseCollisionRerun`): a
 * reuse there that collides too re-runs nothing, arms the retry timer and
 * answers `retrying` (`reuseFinishedRow`). That get-then-act carries no
 * escalate-dead verdict (SRJ-611): a verdict handed in is void
 * (`voidDeadEvidence`, `DEAD_EVIDENCE_VOIDED_BY_RETIRED_KEY_FIRST_LAUNCH`),
 * since the launch starts a new life the verdict never saw, and a live row is
 * judged afresh at the next attempt. Never throws.
 */
async function retiredKeyFirstLaunch(run: LadderRun, retired: RetiredKeyReading): Promise<SpawnPersonaResult> {
  const { persona, config, isStartup, ref } = run
  console.error(
    `[slack] spawnForPersona: ${ref}'s key is retired (${describeRetiredMark(retired)}) — its first launch is a reuse spawn of the same id, never a plain spawn or a resume (b.jg5 SRJ-805)`,
  )
  const reused = await reuseSpawnForPersona(persona, config, {
    isStartup,
    lastRead: NOTHING_READ,
    trustPatchRan: true,
    firstLaunch: true,
    retiredAtStart: run.retiredAtStart,
  })
  if (!isReuseSpawnCollided(reused)) return reused
  // b.jg5 SRJ-112: this collision is the attempt's one reuse collision, so
  // get-then-act runs as its one re-run, and a reuse collision there is the
  // second one (`reuseFinishedRow`).
  console.error(
    `[slack] spawnForPersona: the ${RETIRED_KEY_REUSE_WHAT} of ${ref} collided — fetching current state; this is the one get-then-act a reuse collision gives (b.jg5 SRJ-805, SRJ-112)`,
  )
  // b.jg5 SRJ-611: the get-then-act carries no verdict; the new life this
  // launch starts is not the one the verdict saw.
  const voided = voidDeadEvidence(run, CARRIED_DEAD_EVIDENCE_NONE, DEAD_EVIDENCE_VOIDED_BY_RETIRED_KEY_FIRST_LAUNCH)
  return ladderGetThenAct({ ...voided.run, reuseCollisionRerun: true })
}

/**
 * The retired-key rule at the collision ladder's get-then-act (b.jg5
 * SRJ-805), for persona `run.persona` whose key the installed store has
 * recorded (`retired`), deciding on `lastRead`, the state the collision
 * `get` read (no row for `ErrSpawnNotFound`), with no further read:
 *   - finished (`ended`, `missing` or no row), marked or not: the replace
 *     step's finished-row branch, one reuse spawn of the same id, whose
 *     collision re-runs get-then-act once (`replacePersonaRow`,
 *     `reuseFinishedRow`, SRJ-112);
 *   - live (every other state, `pending` and a state CSCB does not know
 *     included) with no mark: the row is the old life, and the replace step's
 *     live branch starts the live-row sequence with the retired-key flag, the
 *     conversation not kept and alert context `recovery`, seeded with the
 *     state read; no other launch call is made, and the answer is
 *     `sequence-waiting` (`held` for a persona held on `ErrInvalidFlags`);
 *   - live with the mark set: undefined, so the ladder's own live branches
 *     handle the row as any live row of the persona (the reconnect, the
 *     `working` wait, the prompt-row read, the `pending` step); it is never
 *     replaced by this rule. A path there that reaches `resumeOrFreshSpawn`
 *     makes a reuse instead of a `resume`.
 * Never throws.
 */
function retiredKeyAtCollision(
  run: LadderRun,
  retired: RetiredKeyReading,
  lastRead: LatchRowState,
): Promise<SpawnPersonaResult> | undefined {
  if (retired.marked && !lastReadIsFinished(lastRead)) return undefined
  return replacePersonaRow(run, lastRead, `${RETIRED_KEY_WHY} and ${describeRetiredMark(retired)}`, true)
}

/**
 * The collision ladder's get-then-act (b.jg5 SRJ-114, SRJ-112): the
 * collision `get`, then the `cwd` guard and the state branches, as
 * `spawnForPersona`'s step 5 lists them. Entered once after the first
 * spawn's collision, and once more when a reuse spawn of the replace step's
 * finished-row branch collides (`run.reuseCollisionRerun`, `reuseFinishedRow`).
 * A retired key's first launch is itself a reuse, so its collision enters it
 * as that one re-run (`retiredKeyFirstLaunch`). Never throws.
 */
async function ladderGetThenAct(run: LadderRun): Promise<SpawnPersonaResult> {
  const { persona, config, isStartup, ref, params, hooks } = run
  const { key } = persona
  // Collision-handling: get-then-act ---
  // b.jg5 SRJ-114: the collision `get` is the shared own-row read. A read
  // that latched the persona (its own row reading `pending` with no launch
  // start, b.jg5 SRJ-513, whatever its `cwd`, or a `provenance_conflict`
  // note on it) ends the ladder here, before the `cwd` and `config_dir` guards and the
  // state branches: no wait, sweep, reconnect, sequence or launch, no
  // notice, nothing counted (b.jg5 SRJ-501, SRJ-502).
  const collisionRead = await readPersonaOwnRow(key, { ...COLLISION_GET_SITE, ref })
  // b.jg5 SRJ-105, SRJ-512: an UNUSABLE NAME answer latched the persona: no
  // retry spawn, sequence or launch, no notice, nothing counted.
  if (collisionRead.kind === OWN_ROW_READ_LATCHED) return { key, action: 'latched' }
  // b.jg5 SRJ-502: the get is awaited, and the persona may have latched
  // elsewhere meanwhile (the health tick's liveness read, SRJ-315): no retry
  // spawn, wait, resume, sequence or launch follows.
  if (latchedAfterOwnRowRead(key, 'spawnForPersona', 'collision get', ref)) return { key, action: 'latched' }
  if (collisionRead.kind !== OWN_ROW_READ_ROW) {
    if (collisionRead.kind === OWN_ROW_READ_ABSENT) {
      // b.jg5 SRJ-611: the collision `get` read the row gone, which voids any
      // verdict the restart path carried in for the rest of the attempt: the
      // retry spawn's collision re-run, and the retired key's reuse, carry none.
      run = voidDeadEvidence(run, CARRIED_DEAD_EVIDENCE_NONE, deadEvidenceVoidingRead(DEAD_EVIDENCE_READ_BY_COLLISION_GET, LATCH_ROW_STATE_NO_ROW)).run
      // b.jg5 SRJ-805: a retired key gets no plain spawn: the row is gone,
      // so its reuse spawn is an ordinary fresh spawn (SRJ-112).
      const retired = retiredKeyReadingOf(key)
      const retiredStep = retired.recorded ? retiredKeyAtCollision(run, retired, LATCH_ROW_STATE_NO_ROW) : undefined
      if (retiredStep !== undefined) return retiredStep
      // Race: row deleted between spawn-collision and get. Retry spawn once,
      // through the one plain-spawn outcome handler (b.jg5 SRJ-111); the
      // collision `get` read no row (SRJ-501), and a collision of this spawn
      // re-runs get-then-act once (SRJ-114, `plainSpawnCollisionAtLadder`).
      console.error(`[slack] spawnForPersona: ErrSpawnNotFound after collision for ${ref} — retrying spawn (single retry)`)
      return plainSpawnOutcomeAt<SpawnPersonaResult>({
        persona,
        isStartup,
        ref,
        params,
        what: LADDER_RETRY_SPAWN_WHAT,
        lastRead: LATCH_ROW_STATE_NO_ROW,
        spawnedLine: (r) => `[slack] spawnForPersona: retry-spawn succeeded for ${ref} instanceId=${r.claude_instance_id}`,
        collided: () => plainSpawnCollisionAtLadder(run, LADDER_RETRY_SPAWN_WHAT),
      })
    }
    // b.jg5 SRJ-105, SRJ-311, SRJ-313, SRJ-316: a read error is a refusal,
    // an ENVIRONMENT, a CONFIG and an UNCLASSIFIED answer
    // (`ErrSystemInstallDisappeared` too) included.
    const err = collisionRead.error
    const refused = refusalAt(key, err, 'get', 'spawnForPersona', 'collision get', ref)
    if (refused) return refused
    // Not reached: every `get` error but ErrSpawnNotFound and UNUSABLE NAME
    // is a refusal. Any other ends the ladder 'failed': no spawn-failure
    // notice, no `spawn-failed` entry (b.jg5 SRJ-105).
    console.error(`[slack] spawnForPersona: collision get failed for ${ref}: ${describeAgentDirectorFailure(err)} — nothing more is called`)
    return { key, action: 'failed' }
  }
  if (collisionRead.latched) return { key, action: 'latched' }
  const { row } = collisionRead

  const { state } = row
  console.error(`[slack] spawnForPersona: collision resolved, state=${state} for ${ref}`)
  // b.jg5 SRJ-501: the collision `get` is the path's last read until a later
  // read replaces it (the working-row wait's, the prompt row's re-read).
  const lastRead = latchRowStateRead(state)
  // b.jg5 SRJ-611: dead evidence covers one life. A collision `get` that
  // reads the row `ended` or `missing` voids the verdict the restart path
  // carried in, for every branch below and any re-run of get-then-act.
  const carriedIn = run.carriedDeadEvidence
  const collisionVoidedBy = lastReadIsFinished(lastRead) ? deadEvidenceVoidingRead(DEAD_EVIDENCE_READ_BY_COLLISION_GET, lastRead) : undefined
  if (collisionVoidedBy !== undefined) run = voidDeadEvidence(run, CARRIED_DEAD_EVIDENCE_NONE, collisionVoidedBy).run

  // b.av2 SR-6.2 as amended (b.jg5 SRJ-1503): a row in another directory (by
  // real path) is never resumed, reconnected or waited on, whatever its state
  // and resume_enabled: it is replaced with no row deleted, a live row
  // through the live-row sequence, then a reuse spawn; a finished row by a
  // reuse spawn (the replace step, b.jg5 SRJ-707).
  const comparison = compareRowToPersona(row, persona, spawnHomeDir())
  if (!comparison.cwdMatches) {
    if (comparison.cwdCheckDeferred) {
      // b.av2 SR-6.4: neither the working directory nor the row's cwd has a
      // real path right now, so the row cannot be shown to be in another
      // directory. Keep it (its instance and history) and fail the launch as a
      // spawn in a missing directory would: the cwd-unreachable notice, then
      // restart recovery. A row whose cwd resolves to an existing directory is
      // not deferred and is replaced below.
      console.error(
        `[slack] spawnForPersona: ${ref} working_directory=${persona.working_directory} cannot be resolved to a real path — ` +
          `keeping its row (cwd=${row.cwd || '<none>'}, state=${state}); the launch fails and is retried by the restart path`,
      )
      setOutageFlag(key, 'cwd-unreachable', persona.working_directory)
      return { key, action: 'failed' }
    }
    console.error(
      `[slack] spawnForPersona: ${ref} row cwd=${row.cwd || '<none>'} differs from working_directory=${persona.working_directory} (state=${state}) — replacing the row by a reuse spawn of the same id; nothing is deleted`,
    )
    return replacePersonaRow(run, lastRead, CWD_MISMATCH_WHY)
  }

  // b.jg5 SRJ-805: while the key is recorded the collision `get` decides by
  // the retired-key rule (read after it, since that read may have cleared
  // the entry of a marked key, SRJ-807): a finished row gets the reuse, an
  // old life the live-row sequence; a new life (mark set) that is live
  // goes on to the live branches below as any live row.
  const retired = retiredKeyReadingOf(key)
  const retiredStep = retired.recorded ? retiredKeyAtCollision(run, retired, lastRead) : undefined
  if (retiredStep !== undefined) return retiredStep

  if (state === 'ended' || state === 'missing') {
    // b.jg5 SRJ-611: an escalate-dead verdict the restart path carried in is
    // named in one line, which says that this read voided it (above); with
    // none carried the path holds none. Either way the path holds no dead
    // evidence from here on.
    if (carriedIn.source !== DEAD_EVIDENCE_NONE) {
      console.error(deadSessionRouteLine(ref, state, CARRIED_DEAD_EVIDENCE_NONE, carriedIn, collisionVoidedBy))
    }
    return resumeOrFreshSpawn(run, row, {
      lastRead,
      lastReadBy: DEAD_EVIDENCE_READ_BY_COLLISION_GET,
      deadEvidence: run.carriedDeadEvidence,
    })
  }

  if (state === 'waiting') {
    // b.jg5 SRJ-118: one `send-keys`, never retried, with the collision
    // `get`'s `waiting` as its last read. A 'dead-session' answer, whatever
    // its cause (a GONE `send-keys`, a refusal as not interactive, or no
    // row), takes the find-missing run and then resume/fresh-spawn, whose
    // resume or spawn decides what holds the persona's name (b.3ce, b.dup).
    // The route hands on its own cause: only `tmux-gone` is dead evidence;
    // `row-not-interactive` and `row-absent` are never taken as proof that
    // the worker is gone (SRJ-609, SRJ-611). A 'transient' answer types
    // nothing and counts nothing.
    const result = await reconnectMcpWithCause(key, lastRead, ref)
    if (result.outcome === 'dead-session') return deadSessionRoute(run, row, state, result.deadCause, undefined, lastRead)
    if (result.outcome === 'transient') return transientReconnectResult(key, ref, state, result)
    return { key, action: 'reconnected' }
  }

  if (state === 'working') {
    // b.3ce/b.ecw, b.jg5 SRJ-118: the same mapping as the `waiting` branch.
    // waitForWaitingAndReconnect returns 'ok' once it typed `/mcp reconnect`;
    // 'not-reconnected' (b.f2b) on live transient transitions, whenever the
    // row reads live at the deadline (a long turn isn't an error), and when
    // the timeout `status` read fails (b.jg5 SRJ-605); 'dead-session' when
    // the row reads ended or missing (or the timeout sweep + status verdict
    // says so, b.ecw; cause `row-read-finished`), when its reconnect
    // answered 'dead-session' (the reconnect's cause), or when the row is
    // absent (`ErrSpawnNotFound`, b.jg5 SRJ-605; cause `row-absent`): the
    // recovery's resume or spawn then decides what holds the name, and the
    // route hands on the wait's cause, of which only the reconnect's
    // `tmux-gone` is dead evidence (b.jg5 SRJ-611); 'transient' when its
    // reconnect was 'transient' or its findMissing sweep was refused:
    // nothing typed, nothing counted.
    // b.f2b: the wait can take up to WAIT_FOR_WAITING_TIMEOUT_MS; tell the
    // caller (the start pass lets the launch go on in the background).
    hooks?.onWorkingRowWait?.()
    const waited = await waitForWaitingAndReconnectWithCause(key, config, ref)
    const { outcome } = waited
    // b.jg5 SRJ-502, SRJ-608: the persona latched during the wait (a CONFLICT
    // or UNUSABLE NAME at a read, a note its transcript `get` read, or a
    // latch set elsewhere): nothing more for it.
    if (outcome === WAIT_OUTCOME_LATCHED) return { key, action: 'latched' }
    if (waited.outcome === 'dead-session') {
      return deadSessionRoute(run, row, state, waited.deadCause, waited.finishedState, waited.lastRead ?? lastRead)
    }
    // b.jg5 SRJ-205: the evidence read's version re-check decided the stop:
    // no post, no `spawn-failed` entry, nothing counted (as at a resume).
    if (waited.stopping) return { key, action: 'failed', stopping: true }
    // b.f2b: report the real outcome, not `reconnected`. A wait its persona's
    // teardown cancelled typed nothing either, and its session is left to
    // the teardown.
    if (outcome === 'not-reconnected' || outcome === 'cancelled') return { key, action: 'not-reconnected' }
    // b.jg5 SRJ-118: a 'transient' wait (its reconnect's, or a refused
    // findMissing sweep's) types nothing and counts nothing. A `status`
    // error in the wait never gets here (b.jg5 SRJ-605).
    if (outcome === 'transient') return transientReconnectResult(key, ref, state, waited.latched ? { latched: true } : {})
    return { key, action: 'reconnected' }
  }

  if (PROMPT_ROW_STATES.has(state)) {
    // b.jdc: never typed into (b.rmy), but its session may be gone.
    return launchOnPromptRow(run, row, state)
  }

  if (state === 'pending') {
    // b.jg5 SRJ-513: a configured persona's own `pending` row with no launch
    // start never reaches here: the collision `get` latched it first.
    // b.jg5 SRJ-409, SRJ-411: the ladder's `pending` step: a row that is not
    // covered goes through the live-row sequence; a covered row is left,
    // its retry timer armed in pending-only mode, and, at a retry of the
    // persona's timer only, gets the pending-row rule's one run of that
    // retry (b.jg5 SRJ-410); from any other origin it is only armed.
    return ladderPendingRowStep(run, row, lastRead)
  }

  console.error(`[slack] spawnForPersona: unexpected state=${state} for ${ref} — no action`)
  return { key, action: 'no-op' }
}

// ---------------------------------------------------------------------------
// The reuse spawn (b.jg5 SRJ-112, SRJ-708)
// ---------------------------------------------------------------------------

/** The prefix of the reuse spawn's own lines. */
const REUSE_SPAWN_SITE = 'reuseSpawnForPersona'

/**
 * The read name a reuse spawn's success gives the end line of the old-life
 * hold it ends for the key's new life (b.jg5 SRJ-809, SRJ-806).
 */
export const OLD_LIFE_NEW_LIFE_READ = `${REUSE_SPAWN_SITE}: reuse spawn succeeded`

/** What the reuse spawn's lines call the call. */
const REUSE_SPAWN_WHAT = 'reuse spawn'

/**
 * The reuse spawn's answer to `ErrInstanceIdCollision` (b.jg5 SRJ-112): the
 * row is live (a launch in progress included), so nothing was launched. Not
 * a launch result: no notice, no entry, nothing counted and nothing armed by
 * the reuse itself. Its caller decides what follows: the live-row sequence
 * ends without its launch and arms the reuse-collision cause; a collision
 * ladder reuse site re-runs get-then-act once, and a second collision arms
 * that cause and ends the attempt (`reuseFinishedRow`).
 */
export const REUSE_SPAWN_COLLIDED = 'reuse-collided'

/** The reuse spawn's collided answer (`REUSE_SPAWN_COLLIDED`). */
export interface ReuseSpawnCollided {
  readonly key: string
  readonly action: typeof REUSE_SPAWN_COLLIDED
}

/**
 * What the reuse spawn answers: a launch result, or the collided answer.
 * The collided answer's action is none of `SpawnPersonaResult`'s, so a
 * caller must tell it apart (`isReuseSpawnCollided`) before it can pass the
 * answer on as a launch result: no caller can count a collision by mistake.
 */
export type ReuseSpawnResult = SpawnPersonaResult | ReuseSpawnCollided

/** Whether a reuse spawn's answer is its collided answer. */
export function isReuseSpawnCollided(result: ReuseSpawnResult): result is ReuseSpawnCollided {
  return result.action === REUSE_SPAWN_COLLIDED
}

/** What the reuse spawn is told by its caller. */
export interface ReuseSpawnOptions {
  /** Whether the launch is part of the start pass (a `spawn-failed` entry is written only then). */
  readonly isStartup: boolean
  /**
   * The row state the caller last read before the reuse (`LATCH_ROW_STATE_NO_ROW`
   * included): the state a CONFLICT or UNUSABLE NAME latch records (b.jg5
   * SRJ-501). Never re-read here. Undefined only for a retired key's first
   * launch (SRJ-805), which read nothing of the row: a CONFLICT or UNUSABLE
   * NAME there takes the one latch-time `status` read, as the plain first
   * spawn's does.
   */
  readonly lastRead: LatchRowState | undefined
  /**
   * True when the caller has already run the pre-launch trust patch in this
   * launch attempt (the collision ladder at its start; a `resume` that went
   * on to the reuse). Otherwise the reuse runs it once before its call.
   */
  readonly trustPatchRan?: boolean
  /**
   * True for a retired key's first launch (b.jg5 SRJ-805): its collision
   * undoes the reply-guard steps it ran (b.av2 SR-9.4), as the plain first
   * spawn's collision does.
   */
  readonly firstLaunch?: boolean
  /**
   * The installed retired-key store's reading of the key and its record
   * generation when the launch attempt this reuse runs in started (b.jg5
   * SRJ-806): the collision ladder's (`LadderRun.retiredAtStart`) or the
   * live-row sequence's (its request's). A success sets the "new life has
   * begun" mark only when the key was recorded then and no recording has
   * named it since (`reuseSuccessAction`). Absent, for a reuse with no
   * attempt context: read just before the call.
   */
  readonly retiredAtStart?: RetiredKeyAttemptStart
}

/**
 * The reuse spawn of persona `persona`'s `cscb_<key>` (b.jg5 SRJ-112,
 * SRJ-708): agent-director's `spawn` of the same fixed id with the reuse
 * flag, which brings the persona up fresh on its own id and keeps its row as
 * an earlier life. One launch, called by every reuse site; it runs inside its
 * caller's launch or recovery attempt and opens none of its own, and its
 * caller registers the launch in flight.
 *   - The launch path's `claude_config_dir` check comes first (bug b.g57):
 *     a directory that does not resolve goes to the installed deferral hook
 *     and the answer is `deferred`, with no agent-director call.
 *   - Its parameters are `buildSpawnParams`'s, with only `reuse_finished:
 *     true` added (SRJ-708): the same template, `cwd`, labels and `extra_env`
 *     as any launch of the persona, prompt suggestions off included. No
 *     `no_pre_trust` is ever set (SRJ-413).
 *   - The pre-launch trust patch runs once before the call unless the caller
 *     ran it in this attempt (`options.trustPatchRan`), and the call is made
 *     as `launchWithReplyGuard` makes it (the reply guard immediately before
 *     it, then spawn detection, which reports an error by class).
 *   - A success logs one line naming the reuse spawn and the persona (and,
 *     when `options.lastRead` is no row, that no earlier life is kept: an
 *     ordinary fresh spawn, SRJ-112; when it is nothing read, a retired
 *     key's first launch, that any finished row is kept as an earlier life),
 *     then, for a key the installed retired-key store had recorded when the
 *     launch attempt started (`options.retiredAtStart`; when the call was
 *     made, for a reuse with no attempt context) and still has recorded,
 *     with its record generation unchanged since (no recording named it
 *     during the attempt), sets its "new life has begun" mark through the
 *     store's `mark` unless it is already set, with one line
 *     (`reuseSuccessAction`; SRJ-806, SRJ-112's success row), then runs
 *     the after-launch step (`afterLaunchSucceeded`: the `pre_trust` line
 *     naming the reuse spawn, SRJ-413, and the dialog approver on the
 *     persona's row, SRJ-401), and answers `fresh-retired` for that key
 *     (`SPAWN_ACTION_FRESH_RETIRED`) and `spawned` for any other. A key
 *     recorded while the attempt was in flight (first recorded then, or
 *     recorded again, whether that cleared its mark or wrote nothing) gets no
 *     mark and answers `spawned`, with one line: the launch was decided
 *     before that recording, so its life is the old life. Every reuse site (the collision ladder's
 *     first launch of a retired key, the replace step, the no-transcript
 *     step, the live-row sequence's final launch) gets the mark from here.
 *   - With `options.firstLaunch` (a retired key's first launch, SRJ-805) a
 *     collision undoes the reply-guard steps, as the plain first spawn's
 *     does (b.av2 SR-9.4): the row is live, so that launch was no launch.
 *   - Every failure is handled by SRJ-112's outcome table
 *     (`reuseSpawnFailedAt`).
 * Nothing here calls `delete` or `kill`, sets `include_finished`, makes a
 * second launch or says that a row was deleted. Never throws.
 */
export async function reuseSpawnForPersona(
  persona: Persona,
  config: PersonaConfig,
  options: ReuseSpawnOptions,
): Promise<ReuseSpawnResult> {
  const { key } = persona
  const ref = personaRef(persona)
  const configDir = checkLaunchConfigDir(persona)
  if (!configDir.ok) {
    deferLaunchForConfigDir(persona, configDir)
    return deferredResult(persona, configDir)
  }
  const configDirLabel = configDirLabelValue(configDir.realPath, spawnHomeDir())
  // b.jg5 SRJ-708: one derivation of the parameters; only the flag is added.
  const params: Phase1SpawnParams = { ...buildSpawnParams(persona, config, configDirLabel), reuse_finished: true }
  // b.av2 SR-6.2: the trust patch precedes every launch, once per attempt.
  if (options.trustPatchRan !== true) runPreLaunchTrustPatch(persona, ref)
  let launched: Phase1SpawnResult
  // b.av2 SR-9.4: the reply guard immediately before the call; a retired
  // key's first launch undoes it on a collision, as the plain first spawn does.
  const replyGuardUndo = runPreLaunchReplyGuard(persona, ref)
  // b.jg5 SRJ-806: the reading and record generation the launch attempt
  // started under (read now when the caller gave none); a key recorded since
  // gets no mark at the reuse's success (`reuseSuccessAction`).
  const retiredAtStart = options.retiredAtStart ?? retiredKeyAttemptStartOf(key)
  try {
    launched = await launchCallWithWindow(key, persona.working_directory, 'spawn', (client) => client.spawn(params))
  } catch (err) {
    if (options.firstLaunch === true && hasAdErrorName(err, ERR_INSTANCE_ID_COLLISION_NAME)) undoPreLaunchReplyGuard(replyGuardUndo, ref)
    return reuseSpawnFailedAt(persona, err, options.isStartup, ref, options.lastRead, retiredAtStart)
  }
  // b.jg5 SRJ-112: a reuse of an id with no row is an ordinary fresh spawn; no earlier life is kept.
  const earlierLife =
    options.lastRead === LATCH_ROW_STATE_NO_ROW
      ? 'the id had no row when last read (an ordinary fresh spawn), so no earlier life is kept'
      : options.lastRead === NOTHING_READ
        ? "nothing of its row was read before it (a retired key's first launch), so any finished row is kept as an earlier life"
        : 'its row is kept as an earlier life'
  console.error(
    `[slack] ${REUSE_SPAWN_SITE}: reuse-spawned ${ref} instanceId=${personaInstanceId(key)} — a new life on its own id; ${earlierLife} (b.jg5 SRJ-112)`,
  )
  // b.jg5 SRJ-806: for a retired key the new life has begun; its mark is set.
  const action = reuseSuccessAction(key, ref, retiredAtStart)
  afterLaunchSucceeded(key, options.isStartup, ref, LAUNCH_VERB_REUSE_SPAWN, launched)
  return { key, action }
}

/**
 * SRJ-112's outcome table for a value the reuse spawn's call threw (b.jg5
 * SRJ-112, SRJ-709, SRJ-105), classified by name (`src/ad-error-class.ts`),
 * with the refused operation "reuse spawn" and `lastRead` as the recorded
 * row state of a latch (nothing read, at a retired key's first launch: the
 * one latch-time `status` read, SRJ-501):
 *   - `ErrInstanceIdCollision`: one line and the collided answer
 *     (`REUSE_SPAWN_COLLIDED`): no notice, no entry, nothing counted; it
 *     never reaches `notifySpawnFailure`;
 *   - `ErrInvalidFlags`: one immediate version re-check (SRJ-204), and the
 *     hold decision on its answer (`decideInvalidFlagsHold`, SRJ-207): a stop
 *     answers `failed` marked `stopping`, with no post, nothing counted and no
 *     hold (the server stops, SRJ-205); a pass, a could-not-run or a
 *     not-running answer holds the persona through the installed hold, under
 *     the pass's version or the re-check's last version seen
 *     (`lastAdVersionSeen`), and answers `held`: no spawn-failure notice, no
 *     `spawn-failed` entry, nothing counted, nothing reported to the
 *     unclassified-error episode and nothing armed. Never another launch, a
 *     delete or a tmux-touching call;
 *   - CONFLICT (`conflictAt`): the persona latches with the case its
 *     description gives ("another agent-director store" and "conflicting
 *     labels" included) and `lastRead` ("no row" for a reuse of an id with
 *     no row, which the pre-spawn scan refused, writing no row); `latched`;
 *   - UNUSABLE NAME (`unusableNameAt`): latched with the refused operation
 *     none; `latched`;
 *   - UNAVAILABLE (every form, a launch timeout included), ENVIRONMENT,
 *     CONFIG and UNCLASSIFIED (`refusalAt`): one line and `failed`, which the
 *     launch answers as `retrying` when the attempt's last error armed the
 *     retry timer (`retryingWhenArmed`): never counted, no notice; the
 *     reporting point has armed the retry timer, started the condition or
 *     raised the outage, and fed the unclassified-error episode, by class.
 *     An UNAVAILABLE one is then followed by one `get` and its decision, with
 *     no launch in the attempt (`afterLaunchUnavailable`, b.jg5 SRJ-407): a
 *     reuse of a recorded key that timed out but launched, whose `get` reads
 *     this launch's row, sets the key's mark and ends its old-life hold
 *     there (SRJ-806, SRJ-809), and still answers `retrying`;
 *   - LAUNCH FAILURE (`ErrTmuxSessionCreate`): one counted launch failure
 *     (one line, the spawn-failure notice, a `spawn-failed` entry at start,
 *     `failed`), never a kill and never a spawn in its place (SRJ-602); the
 *     persona's retry timer is also armed at once in pending-only mode
 *     (`armPendingOnlyAfterLaunchFailure`; SRJ-301, SRJ-409; HO rev 28),
 *     whatever row the reuse was made over, and the result says so
 *     (`pendingOnlyArmed`); the result is marked `countedClass`;
 *   - DIRECTORY (`ErrCwdNotFound`, `ErrCwdNotADirectory`): `failed`, counted
 *     (marked `countedClass`), the wrapper having raised `cwd-unreachable`;
 *   - any other value (a GONE name, a STATE name the reuse gives no meaning):
 *     SRJ-105's UNCLASSIFIED row.
 * Never throws.
 */
async function reuseSpawnFailedAt(
  persona: Persona,
  err: unknown,
  isStartup: boolean,
  ref: string,
  lastRead: LastRowRead,
  retiredAtStart: RetiredKeyAttemptStart,
): Promise<ReuseSpawnResult> {
  const { key } = persona
  if (hasAdErrorName(err, ERR_INSTANCE_ID_COLLISION_NAME)) {
    console.error(
      `[slack] ${REUSE_SPAWN_SITE}: ${describeAgentDirectorFailure(err)} on the ${REUSE_SPAWN_WHAT} of ${ref} — its row is live, so nothing was launched; no spawn-failure notice, nothing counted (b.jg5 SRJ-112)`,
    )
    return { key, action: REUSE_SPAWN_COLLIDED }
  }
  if (isInvalidFlagsError(err)) return invalidFlagsAtReuse(key, err, ref)
  const latched =
    (await conflictAt(key, err, REFUSED_OPERATION_REUSE_SPAWN, lastRead, REUSE_SPAWN_WHAT, ref, REUSE_SPAWN_SITE)) ??
    (await unusableNameAt(key, err, lastRead, REUSE_SPAWN_SITE, REUSE_SPAWN_WHAT, ref))
  if (latched) return latched
  const refused = refusalAt(key, err, 'spawn', REUSE_SPAWN_SITE, REUSE_SPAWN_WHAT, ref)
  // b.jg5 SRJ-407, SRJ-112: an UNAVAILABLE outcome (a launch timeout, HO rev
  // 20's holder included) is followed by one `get`, and no launch, in this
  // attempt; a reuse that timed out but launched sets the key's mark there.
  if (refused) {
    return isUnavailableRefusal(refused, err)
      ? afterLaunchUnavailable(
          { persona, isStartup, ref, verb: 'spawn', what: REUSE_SPAWN_WHAT, reuseRetiredAtStart: retiredAtStart },
          err,
          refused,
        )
      : refused
  }
  const { errorClass } = classifyAdError(err)
  // The class is decided by name above; the `instanceof` check only narrows
  // the type for the describer and the notice.
  if (errorClass === AD_ERROR_CLASS_LAUNCH_FAILURE && err instanceof AgentDirectorError) {
    const described = describeAgentDirectorFailure(err)
    console.error(
      `[slack] ${REUSE_SPAWN_SITE}: ${REUSE_SPAWN_WHAT} failed for ${ref}: ${described} — a counted launch failure; nothing is killed and no spawn is made in its place (b.jg5 SRJ-112, SRJ-602)`,
    )
    if (isStartup) recordStartupError('spawn-failed', `${REUSE_SPAWN_WHAT} failed for ${ref}: ${described}`)
    notifySpawnFailure(key, err, isStartup)
    // b.jg5 SRJ-112, SRJ-301, SRJ-409 (HO rev 28): the row may read restored,
    // live, gone or still `pending`; the retry's read decides.
    return launchFailureResult(key)
  }
  // b.av2 SR-6.4: `cwd-unreachable` was raised by the spawn's wrapper; counted.
  if (errorClass === AD_ERROR_CLASS_DIRECTORY) return { key, action: 'failed', countedClass: true }
  // b.jg5 SRJ-104, SRJ-105, SRJ-313: a name the reuse gives no meaning.
  const classification = unclassifiedClassificationOf(err)
  reportUnclassifiedAtSite(key, err, 'spawn', classification)
  logRefusal(REUSE_SPAWN_SITE, REUSE_SPAWN_WHAT, ref, describeAdErrorClassification(classification))
  return { key, action: 'failed' }
}

/**
 * The reuse spawn's `ErrInvalidFlags` row (b.jg5 SRJ-112, SRJ-207, SRJ-204):
 * exactly one immediate version re-check through the `ErrInvalidFlags` step
 * (`classifyWithInvalidFlagsRecheck`), then the hold decision on its answer
 * (`decideInvalidFlagsHold`, with the re-check's last version seen,
 * `lastAdVersionSeen`):
 *   - stop: one line and `failed` marked `stopping`; nothing posted, nothing
 *     counted and no hold, since the server stops (SRJ-205);
 *   - hold (a pass, a could-not-run or a not-running answer): persona `key`
 *     is held through the installed hold (`setInvalidFlagsHold`) under the
 *     decision's version, whose set reaction in `main()` stops its retry
 *     timer and posts SRJ-1008's alert once in its episode; one line
 *     (`reuseInvalidFlagsHeldLine`), and `held`. With no hold installed the
 *     answer is the same and the line says nothing is held.
 * Either way no other launch of any kind, no delete and no tmux-touching
 * call follows; nothing is reported to the unclassified-error episode and
 * nothing is armed. Never throws.
 */
async function invalidFlagsAtReuse(key: string, err: InvalidFlagsError, ref: string): Promise<SpawnPersonaResult> {
  const step = await classifyWithInvalidFlagsRecheck(err)
  const decision = decideInvalidFlagsHold(step.recheck, lastAdVersionSeen())
  if (decision.kind === INVALID_FLAGS_HOLD_DECISION_STOP) {
    // The stop posts nothing to Slack, and a launch it ends is not counted.
    console.error(
      `[slack] ${REUSE_SPAWN_SITE}: ${REUSE_SPAWN_WHAT} failed for ${ref}: ${describeAdErrorClassification(step.classification)} (after one immediate agent-director version re-check: ${step.recheck.kind}); no other launch`,
    )
    return { key, action: 'failed', stopping: true }
  }
  let held: string
  const hold = invalidFlagsHold
  if (hold === undefined) {
    held = 'no ErrInvalidFlags hold is installed, so nothing is held'
  } else {
    try {
      hold.set(key, decision.version)
      held = `the persona is held under agent-director version ${describeHoldVersion(decision.version)}`
    } catch (thrown) {
      held = `holding the persona failed: ${describeThrownValue(thrown)}`
    }
  }
  console.error(reuseInvalidFlagsHeldLine(ref, describeAgentDirectorFailure(err), step.recheck.kind, held))
  return { key, action: 'held' }
}

/**
 * The reuse spawn's line for an `ErrInvalidFlags` whose immediate version
 * re-check answered `recheck` (a pass, could not run or not running), with
 * `held`, what holding the persona did (b.jg5 SRJ-112, SRJ-207).
 * `described` is `describeAgentDirectorFailure` of the error.
 */
export function reuseInvalidFlagsHeldLine(ref: string, described: string, recheck: string, held: string): string {
  return `[slack] ${REUSE_SPAWN_SITE}: ${REUSE_SPAWN_WHAT} of ${ref} answered ${described} (after one immediate agent-director version re-check: ${recheck}) — ${held}; answering held: no other launch, no delete, no spawn-failure notice, nothing counted (b.jg5 SRJ-112, SRJ-207)`
}

// ---------------------------------------------------------------------------
// The live-row sequence registry (b.jg5 SRJ-706)
// ---------------------------------------------------------------------------

/** The start entry's answer when no registry is installed: nothing was started. */
export const LIVE_ROW_START_NOT_INSTALLED = 'not-installed'

/** The start entry's answer for a persona held on `ErrInvalidFlags` (b.jg5 SRJ-207): nothing was started. */
export const LIVE_ROW_START_HELD = 'held'

/** What the session manager's start entry answers: the registry's answer, that none is installed, or that the persona is held. */
export type LiveRowSequenceStartEntryAnswer =
  | LiveRowSequenceStartAnswer
  | typeof LIVE_ROW_START_NOT_INSTALLED
  | typeof LIVE_ROW_START_HELD

/**
 * The installed live-row sequence registry (`createLiveRowSequenceRegistry`,
 * one per server; production: built in `main()` before the start pass). With
 * none installed (unit tests that install none) no sequence runs: the start
 * entry answers `not-installed` with one line, the running query answers
 * false and a stop does nothing.
 */
let liveRowSequenceRegistry: LiveRowSequenceRegistry | undefined

/** Removes the sequence-stop set observer from the installed latch; undefined while none is registered. */
let removeSequenceLatchObserver: (() => void) | undefined

/**
 * Install the server's live-row sequence registry, or remove it with
 * undefined (b.jg5 SRJ-706). Start sites (the collision ladder's replace
 * step, b.jg5 SRJ-707) reach it through the start entry here
 * (`startLiveRowSequence`). When a latch with `addSetObserver` is
 * installed too, one set observer stops a latched persona's running sequence
 * (`stopSequenceOnLatch`), whichever of the two is installed second.
 */
export function setLiveRowSequenceRegistry(registry: LiveRowSequenceRegistry | undefined): void {
  liveRowSequenceRegistry = registry
  syncSequenceLatchObserver()
}

/** The site the start entry's held line names. */
const LIVE_ROW_SEQUENCE_START_SITE = 'startLiveRowSequence'

/** Test-only seam: remove the installed registry and its latch observer (the registry's sequences are not stopped). */
export function _resetLiveRowSequenceRegistry(): void {
  setLiveRowSequenceRegistry(undefined)
}

/**
 * Register the sequence-stop set observer on the installed latch exactly
 * once while both a registry and a latch with `addSetObserver` are
 * installed; remove it otherwise. Called by both installers.
 */
function syncSequenceLatchObserver(): void {
  removeSequenceLatchObserver?.()
  removeSequenceLatchObserver = undefined
  const latch = conflictLatch
  if (liveRowSequenceRegistry !== undefined && latch?.addSetObserver !== undefined) {
    removeSequenceLatchObserver = latch.addSetObserver(stopSequenceOnLatch)
  }
}

/**
 * The latch's set observer for the live-row sequence (b.jg5 SRJ-502,
 * SRJ-706): stops persona `event.key`'s running sequence with the reason
 * `latched`. The stop signal is set synchronously, inside this call, so the
 * sequence makes no call after the one in progress returns. Does nothing
 * when none runs for the persona. Returns nothing to await; never throws.
 */
function stopSequenceOnLatch(event: ConflictLatchSetEvent): void {
  void stopLiveRowSequence(event.key, LIVE_ROW_STOP_LATCHED)
}

/**
 * The start entry (b.jg5 SRJ-706), used by the collision ladder's replace
 * step (`replacePersonaRow`, SRJ-707) and by later starters: forwards `request` to the
 * installed registry and answers its answer (`started`, `already-running`,
 * `closed`); the sequence runs in the background and this never waits for
 * it. A step-2 entry is the same call with the request's entry step 2. For a
 * persona held on `ErrInvalidFlags` that is not latched (the held gate,
 * b.jg5 SRJ-207): `held`, one line, nothing started and no agent-director
 * call. With no registry installed: `not-installed`, one line, nothing
 * started. While the installed retired-key store has the key recorded,
 * marked or not (`retiredKeyReadingOf`, b.jg5 SRJ-805), the request is
 * forwarded with its retired-key flag set whatever the starter passed, so
 * the sequence's step-6 launch is a reuse spawn and no sequence for the key
 * ends in a `resume` (step 6 reads the store again too, for a key recorded
 * while the sequence runs). A request with no `retiredAtStart` is forwarded
 * with the store's reading and record generation now, which the step-6
 * reuse compares against (SRJ-806). When the starter had not set the
 * retired-key flag of a recorded key, one line says so:
 *
 *   [slack] live-row-sequence: <ref>: its key is retired, so the sequence carries the retired-key flag and ends in a reuse spawn, never a resume (b.jg5 SRJ-805, SRJ-705)
 *
 * Never throws.
 */
export function startLiveRowSequence(request: LiveRowSequenceRequest): LiveRowSequenceStartEntryAnswer {
  const ref = request.ref ?? `persona=${request.key}`
  if (heldResult(request.key, ref, LIVE_ROW_SEQUENCE_START_SITE) !== undefined) {
    return LIVE_ROW_START_HELD
  }
  const registry = liveRowSequenceRegistry
  if (registry === undefined) {
    console.error(`${LIVE_ROW_SEQUENCE_LOG_PREFIX} ${ref}: no sequence registry is installed — nothing started (b.jg5 SRJ-706)`)
    return LIVE_ROW_START_NOT_INSTALLED
  }
  const answer = registry.start(retiredKeyRequest(request, ref))
  // b.jg5 SRJ-811: a request that ends in a launch refused because an
  // old-life wait runs on its id arms its persona's retry timer.
  if (answer === LIVE_ROW_START_ALREADY_RUNNING && request.launches && registry.isNoLaunchRunning(request.instanceId)) {
    oldLifeWaitRefusal(request.key, ref, LIVE_ROW_SEQUENCE_START_SITE)
  }
  return answer
}

/**
 * `request` as the start entry forwards it (b.jg5 SRJ-805, SRJ-806): its
 * retired-key flag set when the installed store has its key recorded and the
 * starter had not set it, with one line; and, when the starter gave none, the
 * store's reading of the key with its record generation now
 * (`retiredKeyAttemptStartOf`), the start of the attempt the sequence's
 * step-6 reuse compares against. Never throws.
 */
function retiredKeyRequest(request: LiveRowSequenceRequest, ref: string): LiveRowSequenceRequest {
  const reading = retiredKeyReadingOf(request.key)
  const retiredAtStart = request.retiredAtStart ?? retiredKeyAttemptStartOf(request.key, reading)
  if (request.retiredKey || !reading.recorded) return { ...request, retiredAtStart }
  console.error(
    `${LIVE_ROW_SEQUENCE_LOG_PREFIX} ${ref}: its key is retired, so the sequence carries the retired-key flag and ends in a reuse spawn, never a resume (b.jg5 SRJ-805, SRJ-705)`,
  )
  return { ...request, retiredKey: true, retiredAtStart }
}

/**
 * True while a live-row sequence runs for persona `key` (b.jg5 SRJ-706):
 * from its start's answer until it settles, its step-6 launch included.
 * False with no registry installed. While it is true every launch path for
 * the persona but the sequence's own launch answers `sequence-waiting` with
 * no agent-director call, it blocks a retry of the persona's retry timer and
 * counts as in flight for the health tick, and a lost message reports
 * `restarting`.
 */
export function isLiveRowSequenceRunning(key: string): boolean {
  return liveRowSequenceRegistry?.isRunning(key) === true
}

/**
 * Stop persona `key`'s running live-row sequence with `reason` (b.jg5
 * SRJ-706: its latch, its teardown) through the installed registry. The stop
 * signal is set before this returns; the promise resolves true once the
 * sequence has settled (its call in flight returned), false at once when
 * none runs or no registry is installed. Never rejects.
 */
export function stopLiveRowSequence(key: string, reason: LiveRowSequenceStopReason): Promise<boolean> {
  return liveRowSequenceRegistry?.stop(key, reason) ?? Promise.resolve(false)
}

/**
 * The live-row sequence gate of the launch paths (b.jg5 SRJ-706): while a
 * sequence runs for persona `key` and the persona is not latched (the
 * latched gate answers for a latched one), log one line and answer the
 * `sequence-waiting` result; otherwise undefined. The sequence's own launch
 * (`launchForLiveRowSequence`) never passes through it.
 */
function sequenceWaitingResult(key: string, ref: string, site: string): SpawnPersonaResult | undefined {
  if (!isLiveRowSequenceRunning(key)) return undefined
  if (latchGateReadingOf(key) !== undefined) return undefined
  // b.jg5 SRJ-811: an old-life wait on P's own row launches no one, so P's
  // retry timer is armed at the refusal (`oldLifeWaitRefusal`).
  if (oldLifeWaitRefusal(key, ref, site)) {
    return { key, action: 'sequence-waiting', sequenceWaitingCause: SEQUENCE_WAITING_CAUSE_OLD_LIFE_HOLD }
  }
  console.error(
    `[slack] ${site}: not launching ${ref} — its live-row sequence runs; no agent-director call (sequence-waiting; b.jg5 SRJ-706)`,
  )
  return { key, action: 'sequence-waiting' }
}

// ---------------------------------------------------------------------------
// The old-life gate (b.jg5 SRJ-810, SRJ-1502)
// ---------------------------------------------------------------------------

/** The wait on a held instance id was already running when the hold step asked: nothing was started. */
export const OLD_LIFE_HOLD_WAIT_RUNNING = 'running'

/** What the hold step did for one held instance id's wait: it was running, or `ensureOldLifeWait`'s answer. */
export type OldLifeHoldWaitStart = typeof OLD_LIFE_HOLD_WAIT_RUNNING | OldLifeWaitEnsureAnswer

/** One held instance id the hold step met, with what it did for its wait. */
export interface OldLifeHoldStepWait {
  readonly instanceId: string
  readonly wait: OldLifeHoldWaitStart
}

/**
 * The holds on persona `persona`'s working directory that hold it back
 * (b.jg5 SRJ-810 bullet 3): each hold of the installed hold set whose
 * directory is the persona's working directory by real path and whose
 * instance id is not the persona's own `cscb_<key>`. A hold on the persona's
 * own row is SRJ-810's exception (a destructive modify's same-key new half,
 * which waits by the retired-key rule through its live-row sequence,
 * SRJ-805; or a held own row the restart path's reconnect adapter replaces
 * by that sequence), so it never holds the launch back here. None with no
 * hold set installed. Never throws.
 */
function launchHoldsOn(persona: OldLifeHoldPersona): OldLifeHold[] {
  const holds = oldLifeHolds
  if (holds === undefined) return []
  try {
    const own = personaInstanceId(persona.key)
    return holds.holdsOnDirectory(persona.working_directory).filter((hold) => hold.instanceId !== own)
  } catch {
    // Not reached (the hold set never throws).
    return []
  }
}

/**
 * The old-life hold step for persona `persona` at `site` (b.jg5 SRJ-810,
 * SRJ-811, SRJ-301, SRJ-1502), shared by the launch gate in
 * `spawnForPersona` (`oldLifeHoldResult`) and the restart path's old-life
 * hook (`RestartDeps.isHeldForOldLife`, bound in `main()`): when a hold other
 * than one on the persona's own row is on its working directory
 * (`launchHoldsOn`) and the persona is not latched (a latched persona meets
 * the latched gate instead):
 *   - the persona is recorded as waiting on each such hold
 *     (`OldLifeHoldSet.recordWaiting`), so the hold's end retries it at once;
 *   - each hold's wait is started when it is not running
 *     (`ensureOldLifeWait`); a wait already running on the id is left as it
 *     is, so a second launch starts none;
 *   - the persona's retry timer is armed with the held-for-an-old-life
 *     cause, uncounted (`armOldLifeWaiter`);
 *   - one line names the persona, the held directory, every held instance id
 *     with what was done for its wait, and the timer
 *     (`oldLifeHoldLaunchLine`);
 * and it answers true. Otherwise it answers false with nothing done. Makes
 * no agent-director call: no trust patch, no reply-guard step and no record
 * write precede or follow it. Never throws.
 */
export function oldLifeHoldStep(persona: OldLifeHoldPersona, site: string, ref: string = keyRef(persona.key)): boolean {
  const holds = oldLifeHolds
  const held = launchHoldsOn(persona)
  if (holds === undefined || held.length === 0) return false
  if (personaLatchedNow(persona.key)) return false
  const waits: OldLifeHoldStepWait[] = []
  for (const hold of held) {
    try {
      holds.recordWaiting(hold.instanceId, persona.key)
    } catch {
      // Not reached (the hold set never throws).
    }
    waits.push({ instanceId: hold.instanceId, wait: startOldLifeWaitUnlessRunning(hold.instanceId) })
  }
  const armed = armOldLifeWaiter(persona.key)
  console.error(oldLifeHoldLaunchLine(site, ref, held[0]!.realDirectory, waits, armed))
  return true
}

/**
 * Start the wait on held instance id `instanceId` unless one already runs
 * there (b.jg5 SRJ-811: one wait per held instance id): `running` with no
 * call when the registry's no-launch query finds it running, otherwise
 * `ensureOldLifeWait`'s answer. Never throws.
 */
function startOldLifeWaitUnlessRunning(instanceId: string): OldLifeHoldWaitStart {
  if (liveRowSequenceRegistry?.isNoLaunchRunning(instanceId) === true) return OLD_LIFE_HOLD_WAIT_RUNNING
  return ensureOldLifeWait(instanceId)
}

/**
 * The old-life hold step's line (b.jg5 SRJ-810, SRJ-1502): the persona, the
 * held directory (its real path), each held instance id with what was done
 * for its wait (`running`, or `ensureOldLifeWait`'s answer), and whether its
 * retry timer was armed:
 *
 *   [slack] <site>: not launching <ref> — its working directory "<D>" is held for an old life that may still be running (instanceId="<id>": wait <started|running|already-running|closed|not-held|not-installed>[, …]); waiting on it, its retry timer is armed (held-for-old-life); no agent-director call (sequence-waiting; b.jg5 SRJ-810, SRJ-1502)
 *
 * `… its retry timer could not be armed …` when it was not. Pure.
 */
export function oldLifeHoldLaunchLine(
  site: string,
  ref: string,
  directory: string,
  waits: readonly OldLifeHoldStepWait[],
  armed: boolean,
): string {
  const quote = (text: string): string => JSON.stringify(renderLogMessageText(text))
  const held = waits.map((w) => `instanceId=${quote(w.instanceId)}: wait ${w.wait}`).join(', ')
  const timer = armed ? `its retry timer is armed (${UNAVAILABLE_RETRY_CAUSE_OLD_LIFE_HOLD})` : 'its retry timer could not be armed'
  return (
    `[slack] ${site}: not launching ${ref} — its working directory ${quote(directory)} is held for an old life that may still be running ` +
    `(${held}); waiting on it, ${timer}; no agent-director call (sequence-waiting; b.jg5 SRJ-810, SRJ-1502)`
  )
}

/**
 * The old-life gate of `spawnForPersona` (b.jg5 SRJ-810 bullet 3, SRJ-1502):
 * when the hold step holds persona `persona` back (`oldLifeHoldStep`), the
 * `sequence-waiting` result with the old-life cause, which `launchSession`
 * answers with the uncounted `'refused'`, so the retry timer the step armed
 * stays armed (SRJ-1015); otherwise undefined.
 */
function oldLifeHoldResult(persona: Persona, ref: string, site: string): SpawnPersonaResult | undefined {
  if (!oldLifeHoldStep(persona, site, ref)) return undefined
  return { key: persona.key, action: 'sequence-waiting', sequenceWaitingCause: SEQUENCE_WAITING_CAUSE_OLD_LIFE_HOLD }
}

/** What `createOldLifeHoldEndRetry` is given (production: `main()`). */
export interface OldLifeHoldEndRetryDeps {
  /**
   * Run persona `key`'s retry at once (production: the retry controller's
   * `runNow`, with the held-for-an-old-life cause and the hold-ended label).
   * A throw is logged and the next persona is still retried.
   */
  readonly runNow: (key: string) => unknown
  /** Whether persona `key` is in the applied configuration now (production: `getAppliedPersona`). A throw counts as not applied. */
  readonly isApplied: (key: string) => boolean
}

/**
 * The old-life hold set's end observer that retries the waiting personas
 * (b.jg5 SRJ-810: "once the hold ends, each persona that waited on it is
 * retried at once"). `main()` registers it on the hold set after the session
 * manager's own observer (`setOldLifeHolds`), so the hold's wait is stopped
 * first (SRJ-811). For each persona recorded as waiting on the hold that
 * ended (`OldLifeHold.waiting`, recorded by the hold step, by a launch
 * refused because the wait runs on the persona's own row, and by the
 * reconnect's held-row guard), in key order:
 *   - a persona whose own `cscb_<key>` is the held id, while the wait the
 *     hold's end stopped there has not settled (`pendingOldLifeHoldEndStop`),
 *     is retried once that stopped wait has settled, so neither its sequence
 *     gate nor its retry's block cause still finds the wait running; it is
 *     then checked as below, with its own line
 *     (`oldLifeHoldEndSettledRetryLine`);
 *   - any other persona still in the applied configuration, not latched,
 *     not held on `ErrInvalidFlags` and up is retried at once
 *     (`deps.runNow`); a persona torn down or removed, latched, held or not
 *     up (b.jg5 SRJ-305: each stops its timer) is not (`retryOldLifeWaiter`).
 * One line names them all:
 *
 *   [slack] old-life hold: ended for instanceId="<id>" — retrying its waiting personas at once: <keys|none>[; once the stopped wait on its own row has settled: <key>][; not retried: <key> (<not applied|latched|held on ErrInvalidFlags|not up|its retry failed: <error>>)[, …]] (b.jg5 SRJ-810)
 *
 * Makes no agent-director call itself; never throws.
 */
export function createOldLifeHoldEndRetry(deps: OldLifeHoldEndRetryDeps): OldLifeHoldEndObserver {
  return (hold) => {
    try {
      const retried: string[] = []
      const deferred: string[] = []
      const skipped: string[] = []
      const stopped = pendingOldLifeHoldEndStop(hold.instanceId)
      for (const key of hold.waiting) {
        if (stopped !== undefined && personaInstanceId(key) === hold.instanceId) {
          deferred.push(key)
          retryOldLifeWaiterOnceSettled(deps, hold.instanceId, key, stopped)
          continue
        }
        const notRetried = retryOldLifeWaiter(deps, key)
        if (notRetried === undefined) retried.push(key)
        else skipped.push(`${key} (${notRetried})`)
      }
      console.error(oldLifeHoldEndRetryLine(hold.instanceId, retried, skipped, deferred))
    } catch (err) {
      // Not reached: every step above is guarded.
      console.error(`${OLD_LIFE_HOLD_LOG_PREFIX} retrying the waiting personas of instanceId=${hold.instanceId} failed: ${describeThrownValue(err)} (b.jg5 SRJ-810)`)
    }
  }
}

/** Why a waiting persona was not retried at a hold's end: it is no longer in the applied configuration (b.jg5 SRJ-810). */
export const OLD_LIFE_HOLD_END_NOT_RETRIED_NOT_APPLIED = 'not applied'

/** Why a waiting persona was not retried at a hold's end: it is latched (b.jg5 SRJ-810, SRJ-305). */
export const OLD_LIFE_HOLD_END_NOT_RETRIED_LATCHED = 'latched'

/** Why a waiting persona was not retried at a hold's end: it is held on `ErrInvalidFlags` (b.jg5 SRJ-810, SRJ-305, SRJ-207). */
export const OLD_LIFE_HOLD_END_NOT_RETRIED_HELD = 'held on ErrInvalidFlags'

/** Why a waiting persona was not retried at a hold's end: it is not up, so its bring-up owns it (b.jg5 SRJ-810, SRJ-305). */
export const OLD_LIFE_HOLD_END_NOT_RETRIED_NOT_UP = 'not up'

/** The head of why a waiting persona was not retried at a hold's end when its retry threw; what it threw follows (b.jg5 SRJ-810). */
export const OLD_LIFE_HOLD_END_RETRY_FAILED_PREFIX = 'its retry failed: '

/** The tag that ends the end-retry observer's lines (`oldLifeHoldEndRetryLine`, `oldLifeHoldEndSettledRetryLine`). */
export const OLD_LIFE_HOLD_END_RETRY_TAG = ' (b.jg5 SRJ-810)'

/**
 * Retry persona `key`, waiting on a hold that ended, now (b.jg5 SRJ-810;
 * `createOldLifeHoldEndRetry`): when it is still in the applied
 * configuration, not latched, not held on `ErrInvalidFlags` and up,
 * `deps.runNow(key)` and undefined; otherwise why it was not retried
 * (`OLD_LIFE_HOLD_END_NOT_RETRIED_NOT_APPLIED`, `…_LATCHED`, `…_HELD`,
 * `…_NOT_UP`, or `OLD_LIFE_HOLD_END_RETRY_FAILED_PREFIX` and what the retry
 * threw). SRJ-305: the timer stays stopped while P is latched, held or not
 * up. Never throws.
 */
function retryOldLifeWaiter(deps: OldLifeHoldEndRetryDeps, key: string): string | undefined {
  let applied: boolean
  try {
    applied = deps.isApplied(key) === true
  } catch {
    applied = false
  }
  if (!applied) return OLD_LIFE_HOLD_END_NOT_RETRIED_NOT_APPLIED
  if (personaLatchedNow(key)) return OLD_LIFE_HOLD_END_NOT_RETRIED_LATCHED
  if (heldGateReadingOf(key) !== undefined) return OLD_LIFE_HOLD_END_NOT_RETRIED_HELD
  if (!personaUpNow(key)) return OLD_LIFE_HOLD_END_NOT_RETRIED_NOT_UP
  try {
    deps.runNow(key)
    return undefined
  } catch (err) {
    return `${OLD_LIFE_HOLD_END_RETRY_FAILED_PREFIX}${describeThrownValue(err)}`
  }
}

/**
 * Retry persona `key`, waiting on the hold on its own row `instanceId`, once
 * the wait the hold's end stopped there (`stopped`) has settled (b.jg5
 * SRJ-810; `createOldLifeHoldEndRetry`), with one line
 * (`oldLifeHoldEndSettledRetryLine`). Never throws; the promise it chains
 * never rejects.
 */
function retryOldLifeWaiterOnceSettled(
  deps: OldLifeHoldEndRetryDeps,
  instanceId: string,
  key: string,
  stopped: Promise<boolean>,
): void {
  const retry = (): void => {
    try {
      console.error(oldLifeHoldEndSettledRetryLine(instanceId, key, retryOldLifeWaiter(deps, key)))
    } catch (err) {
      // Not reached: `retryOldLifeWaiter` never throws.
      console.error(`${OLD_LIFE_HOLD_LOG_PREFIX} retrying persona=${key} after the wait on instanceId=${instanceId} settled failed: ${describeThrownValue(err)} (b.jg5 SRJ-810)`)
    }
  }
  void stopped.then(retry, retry)
}

/**
 * The line of a persona retried once the wait a hold's end stopped on its
 * own row has settled (b.jg5 SRJ-810; `createOldLifeHoldEndRetry`):
 * `notRetried` is undefined when it was retried, otherwise why not:
 *
 *   [slack] old-life hold: the stopped wait on instanceId="<id>" has settled — persona=<key> retried at once (b.jg5 SRJ-810)
 *   [slack] old-life hold: the stopped wait on instanceId="<id>" has settled — persona=<key> not retried (<why>) (b.jg5 SRJ-810)
 *
 * Pure.
 */
export function oldLifeHoldEndSettledRetryLine(instanceId: string, key: string, notRetried: string | undefined): string {
  const what = notRetried === undefined ? 'retried at once' : `not retried (${notRetried})`
  return `${OLD_LIFE_HOLD_LOG_PREFIX} the stopped wait on instanceId=${JSON.stringify(renderLogMessageText(instanceId))} has settled — persona=${key} ${what}${OLD_LIFE_HOLD_END_RETRY_TAG}`
}

/**
 * The end-retry observer's line (b.jg5 SRJ-810; `createOldLifeHoldEndRetry`):
 * `retried` were retried at once, `skipped` were not (each with why), and
 * `deferred` wait on the hold on their own row and are retried once the
 * wait the hold's end stopped there has settled:
 *
 *   [slack] old-life hold: ended for instanceId="<id>" — retrying its waiting personas at once: <keys|none>[; once the stopped wait on its own row has settled: <keys>][; not retried: <key> (<why>)[, …]] (b.jg5 SRJ-810)
 *
 * Pure.
 */
export function oldLifeHoldEndRetryLine(
  instanceId: string,
  retried: readonly string[],
  skipped: readonly string[],
  deferred: readonly string[] = [],
): string {
  const now = retried.length === 0 ? 'none' : retried.join(', ')
  const later = deferred.length === 0 ? '' : `; once the stopped wait on its own row has settled: ${deferred.join(', ')}`
  const not = skipped.length === 0 ? '' : `; not retried: ${skipped.join(', ')}`
  return `${OLD_LIFE_HOLD_LOG_PREFIX} ended for instanceId=${JSON.stringify(renderLogMessageText(instanceId))} — retrying its waiting personas at once: ${now}${later}${not}${OLD_LIFE_HOLD_END_RETRY_TAG}`
}

/**
 * The persona teardown's old-life step (b.jg5 SRJ-811, SRJ-715;
 * `PersonaLifecycleDeps.forgetOldLifeWaits`): forget persona `key` from
 * every hold's waiting record (`OldLifeHoldSet.forgetWaiting`), so the
 * hold's end never retries it; then, for each hold it was recorded as
 * waiting on, stop that hold's wait (the registry's `stopNoLaunch`, reason
 * `teardown`) only when no persona left in the applied configuration waits
 * on the hold: none recorded as waiting on it and still applied, and none
 * whose working directory is the held directory or whose own row is the
 * held row (`oldLifeWaitingPersonas`). A destructive modify's new half,
 * still applied under the key, counts as one that waits. One line per such
 * hold (`oldLifeWaitTeardownLine`). Resolves once each wait it stopped has
 * settled; with no hold set installed, at once. Makes no agent-director
 * call; never rejects.
 */
export async function forgetOldLifeWaits(key: string): Promise<void> {
  const holds = oldLifeHolds
  if (holds === undefined) return
  const stops: Promise<boolean>[] = []
  try {
    const waitedOn = holds.snapshot().filter((hold) => hold.waiting.includes(key))
    holds.forgetWaiting(key)
    for (const hold of waitedOn) {
      const others = remainingOldLifeWaiters(hold.instanceId)
      const registry = liveRowSequenceRegistry
      const running = registry?.isNoLaunchRunning(hold.instanceId) === true
      if (others.length === 0 && running) stops.push(registry!.stopNoLaunch(hold.instanceId, LIVE_ROW_STOP_TEARDOWN))
      console.error(oldLifeWaitTeardownLine(key, hold.instanceId, others, running))
    }
  } catch (err) {
    // Not reached (the hold set and the registry never throw).
    console.error(`${OLD_LIFE_WAIT_LOG_PREFIX} persona=${key}: forgetting its old-life waits failed: ${describeThrownValue(err)} (b.jg5 SRJ-811)`)
  }
  await Promise.all(stops.map((stop) => stop.catch(() => false)))
}

/**
 * The applied personas that still wait on the hold on `instanceId` (b.jg5
 * SRJ-811), by key, sorted: each recorded as waiting on it that the
 * installed bindings' configuration does not show outside the applied set
 * (`isKnownUnapplied`), and each the waits-on query finds
 * (`oldLifeWaitingPersonas`). Never throws.
 */
function remainingOldLifeWaiters(instanceId: string): string[] {
  const keys = new Set<string>()
  try {
    for (const key of oldLifeHolds?.holdOf(instanceId)?.waiting ?? []) if (!isKnownUnapplied(key)) keys.add(key)
    for (const persona of oldLifeWaitingPersonas(instanceId)) keys.add(persona.key)
  } catch {
    // Not reached (the hold set never throws).
  }
  return [...keys].sort()
}

/**
 * The teardown's old-life line for one hold persona `key` was recorded as
 * waiting on (b.jg5 SRJ-811; `forgetOldLifeWaits`): `others` are the applied
 * personas that still wait on it, `running` whether its wait ran:
 *
 *   [slack] old-life-wait: persona=<key> torn down — forgotten as waiting on instanceId="<id>"; the wait is stopped: no other persona waits on the hold (b.jg5 SRJ-811)
 *   [slack] old-life-wait: persona=<key> torn down — forgotten as waiting on instanceId="<id>"; no wait runs on it, and no other persona waits on the hold (b.jg5 SRJ-811)
 *   [slack] old-life-wait: persona=<key> torn down — forgotten as waiting on instanceId="<id>"; the wait goes on: <keys> still wait on the hold (b.jg5 SRJ-811)
 *   [slack] old-life-wait: persona=<key> torn down — forgotten as waiting on instanceId="<id>"; no wait runs on it; <keys> still wait on the hold (b.jg5 SRJ-811)
 *
 * Pure.
 */
export function oldLifeWaitTeardownLine(key: string, instanceId: string, others: readonly string[], running: boolean): string {
  const what =
    others.length > 0
      ? `${running ? 'the wait goes on: ' : 'no wait runs on it; '}${others.join(', ')} still wait on the hold`
      : running
        ? 'the wait is stopped: no other persona waits on the hold'
        : 'no wait runs on it, and no other persona waits on the hold'
  return `${OLD_LIFE_WAIT_LOG_PREFIX} persona=${key} torn down — forgotten as waiting on instanceId=${JSON.stringify(renderLogMessageText(instanceId))}; ${what} (b.jg5 SRJ-811)`
}

// ---------------------------------------------------------------------------
// The live-row sequence's final launch and its dependencies (b.jg5 SRJ-705)
// ---------------------------------------------------------------------------

/** What the sequence-launch entry is asked for. */
export interface LiveRowSequenceLaunchRequest {
  /** Step 6's launch kind (`decideLiveRowLaunchKind`, `src/live-row-sequence.ts`). */
  readonly kind: LiveRowSequenceLaunchKind
  /** The row state the sequence last read (`ended`, `missing` or no row): the state a latch records. */
  readonly lastRead: LatchRowState
  /**
   * The sequence's stop signal (b.jg5 SRJ-706): once it is set (P's latch,
   * its teardown, shutdown), the entry stops waiting for another launch of P
   * and makes no call. Absent: only the latched gate holds the launch back.
   */
  readonly stop?: LiveRowSequenceStopSignal
  /**
   * The store's reading of the key when the sequence's launch attempt began
   * (the request's `retiredAtStart`, b.jg5 SRJ-806), which the reuse
   * compares against at its success. Absent: read just before the reuse's call.
   */
  readonly retiredAtStart?: RetiredKeyAttemptStart
}

/** The entry's answer when it made no launch: a reuse collision, a collision of the plain spawn after `resume`'s `ErrSpawnNotFound`, `ErrSpawnNotResumable`, the sequence stopped. */
export interface LiveRowSequenceNotLaunched {
  readonly key: string
  readonly action: typeof LIVE_ROW_OUTCOME_NOT_LAUNCHED
  readonly reason: LiveRowSequenceNotLaunchedReason
}

/** What the sequence-launch entry answers: the launch's result, or that no launch was made. */
export type LiveRowSequenceLaunchEntryResult = SpawnPersonaResult | LiveRowSequenceNotLaunched

/**
 * The live-row sequence's final launch (b.jg5 SRJ-705 step 6) of persona
 * `persona`'s `cscb_<key>`, of `request.kind`. It is a launch call:
 *   - it waits for any launch still in flight for the persona to settle
 *     (never joining or overlapping it), then registers in the in-flight
 *     map `spawnForPersona` uses, so `isLaunchInFlight` is true and
 *     `whenLaunchSettled` waits for it while it runs (a teardown's wait
 *     covers it, SRJ-715); a call that joins it gets its launch result, a
 *     not-launched answer or any failure that is not stopping reading as
 *     `retrying` (b.jg5 SRJ-1015), so a failure is counted only here, once
 *     and by class;
 *   - once the sequence's stop signal (`request.stop`) is set, it stops
 *     waiting and makes no call (b.jg5 SRJ-706): one line, nothing
 *     registered, and a not-launched answer (`stopped`);
 *   - it is exempt from the `sequence-waiting` gate on the persona's launch
 *     paths (`spawnForPersona`): it is the sequence's own launch, made from
 *     inside it, and never passes through that gate;
 *   - the latched gate, the held gate (b.jg5 SRJ-207: a persona held on
 *     `ErrInvalidFlags` answers `held` with no call), the old-life gate
 *     (b.jg5 SRJ-810, SRJ-1502: a hold other than one on the persona's own
 *     row on its working directory answers `sequence-waiting` with no call,
 *     through the hold step `oldLifeHoldStep`, so the sequence ends without
 *     its launch), the pre-launch
 *     `claude_config_dir` check and dry run come first, as in
 *     `spawnForPersona`; then the launch runs as a launch attempt for the
 *     persona (SRJ-301), the trust patch once before it;
 *   - `resume`: SRJ-113's table through the one `resume` outcome handler
 *     the collision ladder's `resume` uses too (`resumeAtSite`), so every
 *     row matches `resumeOrFreshSpawn`'s but the not-resumable one: one
 *     `resume` of the id through the ladder's launch helper
 *     (`launchWithReplyGuard`: the reply guard, spawn detection, arming by
 *     class). `ErrNoSessionId`, `ErrJsonlMissing` and `ErrJsonlNeverWritten`
 *     (by name) go on to the no-transcript step (`noTranscriptReuse`,
 *     SRJ-707, SRJ-712): after `ErrJsonlMissing` the lost-transcript
 *     diagnosis first (a latched or refused diagnosis read ends the launch
 *     with no reuse), then the reuse spawn once with the row state last read
 *     (the diagnosis's read when it made one); its success answers
 *     `fresh-after-amnesia` or `fresh-after-inconclusive-amnesia` after
 *     `ErrJsonlMissing` and `spawned` otherwise, and its collision answers
 *     not launched as the `reuse` kind's does. `ErrSpawnNotResumable` takes
 *     the not-resumable step with the sequence barred
 *     (`sequenceNotResumable`, SRJ-710: one re-read, never a second
 *     sequence) and answers not launched: `not-resumable-latched` when the
 *     re-read latched the persona, `not-resumable-pending` for a `pending`
 *     row, `not-resumable` (a lost race) otherwise. `ErrSpawnNotFound` makes
 *     one plain spawn of the same id from `buildSpawnParams` (no reuse flag;
 *     agent-director's pre-spawn scan runs inside it, SRJ-111), with no
 *     spawn-failure notice for the `ErrSpawnNotFound` itself; that spawn
 *     takes SRJ-111's table through the one plain-spawn outcome handler
 *     (`plainSpawnOutcomeAt`): its collision answers not launched
 *     (`spawn-collision`, `sequenceSpawnCollision`): no further launch,
 *     nothing counted, no notice; the sequence ends without its launch and
 *     arms the persona's retry timer with the collision cause, whose run is
 *     the get-then-act; its failure takes the plain spawn's handling
 *     (`plainSpawnFailedAt`). An
 *     `ErrTmuxSessionCreate` (by class) is a counted launch failure that also
 *     arms the persona's retry timer at once in pending-only mode, through
 *     the shared `resumeFailedAt` (SRJ-113, SRJ-409), and a DIRECTORY error
 *     is a counted launch failure; any other non-success ends by class
 *     (`resumeFailedAt`: a CONFLICT or UNUSABLE NAME latches with
 *     `request.lastRead`; `ErrInvalidFlags` gets the version re-check, then
 *     UNCLASSIFIED) with no further call: no delete, no kill and no further
 *     launch;
 *   - `reuse`: the reuse spawn (`reuseSpawnForPersona`) with
 *     `request.lastRead`, its outcomes SRJ-112's (its `ErrInvalidFlags` holds
 *     the persona and answers `held`, SRJ-207). Its collision answers not
 *     launched (`reuse-collision`): no further launch, nothing counted, no
 *     notice; the sequence ends without its launch and arms the persona's
 *     retry timer with the reuse-collision cause (SRJ-112, SRJ-705, SRJ-706);
 *   - a success runs the after-launch step (`afterLaunchSucceeded`: the
 *     `pre_trust` line and the dialog approver); any other result ends the
 *     sequence without its launch (`runLiveRowSequence` arms by its rule,
 *     SRJ-301).
 * The launch's result is counted once here, as the restart path counts a
 * launch's result (`recordLaunchResultOutsideRestartWork`, b.jg5 SRJ-112,
 * SRJ-113, SRJ-602), by class: a success resets the persona's failure
 * count, and a `failed` result that is not stopping and
 * whose class is LAUNCH FAILURE (`ErrTmuxSessionCreate`) or DIRECTORY
 * (`ErrCwdNotFound`, `ErrCwdNotADirectory`), marked `countedClass` where
 * that class is handled, is one counted launch failure; any other `failed`
 * result and a retrying, stopping, latched, held, deferred or not-launched answer
 * record nothing.
 * The launch is never part of the start pass, whichever path started the
 * sequence (a start-pass collision ladder's replacement site or
 * not-resumable step included, and the abort of the persona's own stuck
 * launch, made only at a retry of its timer or at its dialog approver's
 * stop, after the stuck launch's call returned; b.jg5 SRJ-412): the
 * sequence runs detached, after its starter has answered (`sequence-waiting`
 * or "sequence started") and the start pass has counted that (b.jg5
 * SRJ-706, SRJ-1015), so every call here passes the start flag false, the
 * `resume` a recovery holding dead evidence ends in and the `resume` that
 * keeps an aborted resumed launch's conversation included.
 * No `spawn-failed`, `jsonl-transcript-lost-on-resume` or
 * `jsonl-diagnosis-inconclusive` startup-errors entry is written for it, as
 * for every launch outside the start pass (the restart path's `resume`
 * included); the lost-transcript diagnosis after its `resume`'s
 * `ErrJsonlMissing` still runs before the reuse spawn, with its log lines,
 * its persona notice and its `fresh-after-amnesia` or
 * `fresh-after-inconclusive-amnesia` result (b.jg5 SRJ-712).
 * Never calls `delete` and never sets `include_finished`. Never throws.
 */
export async function launchForLiveRowSequence(
  persona: Persona,
  config: PersonaConfig,
  request: LiveRowSequenceLaunchRequest,
): Promise<LiveRowSequenceLaunchEntryResult> {
  const { key } = persona
  const ref = personaRef(persona)
  if (inFlightLaunches.has(key)) {
    console.error(
      `${LIVE_ROW_SEQUENCE_LOG_PREFIX} a launch for ${ref} is in flight — the sequence's launch waits for it to settle (b.jg5 SRJ-705, SRJ-706)`,
    )
  }
  while (inFlightLaunches.has(key) && request.stop?.reason === undefined) await whenLaunchSettledOrStopped(key, request.stop)
  // b.jg5 SRJ-706: a sequence stopped meanwhile (its teardown, shutdown, the
  // latch) makes no call; nothing is registered as in flight.
  const stoppedFor = request.stop?.reason
  if (stoppedFor !== undefined) {
    console.error(
      `${LIVE_ROW_SEQUENCE_LOG_PREFIX} not launching ${ref} — the sequence was stopped (${stoppedFor}); no agent-director call (b.jg5 SRJ-706)`,
    )
    return { key, action: LIVE_ROW_OUTCOME_NOT_LAUNCHED, reason: LIVE_ROW_NOT_LAUNCHED_STOPPED }
  }
  const launch = sequenceLaunchAttempt(persona, config, request, ref)
  // A call that joins this launch gets a launch result; no launch, and any
  // failure that is not stopping, read as `retrying` (b.jg5 SRJ-1015).
  const asLaunch: Promise<SpawnPersonaResult> = launch.then((result) => {
    if (result.action === LIVE_ROW_OUTCOME_NOT_LAUNCHED || isUnstoppedFailure(result)) return { key, action: SPAWN_ACTION_RETRYING }
    return result
  })
  inFlightLaunches.set(key, asLaunch)
  try {
    return await launch
  } finally {
    if (inFlightLaunches.get(key) === asLaunch) {
      inFlightLaunches.delete(key)
      cancelledLaunchWaits.delete(key)
      cancelledComingApprovers.delete(key)
    }
  }
}

/**
 * Resolves once the launch in flight for persona `key` has settled, or once
 * `stop` is set, whichever comes first; at once when neither is pending.
 * Never rejects.
 */
function whenLaunchSettledOrStopped(key: string, stop: LiveRowSequenceStopSignal | undefined): Promise<void> {
  if (stop === undefined) return whenLaunchSettled(key)
  return new Promise<void>((resolve) => {
    const unsubscribe = stop.onStop(() => resolve())
    void whenLaunchSettled(key).then(() => {
      unsubscribe()
      resolve()
    })
  })
}

/** Whether `result` is `failed` and not stopping. */
function isUnstoppedFailure(result: SpawnPersonaResult): boolean {
  return result.action === 'failed' && result.stopping !== true
}

/**
 * Whether the entry counts `result` as a launch failure (b.jg5 SRJ-112,
 * SRJ-113): `failed`, not stopping, and marked `countedClass` (its class is
 * LAUNCH FAILURE or DIRECTORY).
 */
function sequenceLaunchCounted(result: SpawnPersonaResult): boolean {
  return isUnstoppedFailure(result) && result.countedClass === true
}

/** The site the sequence-launch entry's held line names. */
const LIVE_ROW_SEQUENCE_LAUNCH_SITE = 'launchForLiveRowSequence'

/** The sequence launch's gates, then its call as a launch attempt for the persona, then its count. Never throws. */
async function sequenceLaunchAttempt(
  persona: Persona,
  config: PersonaConfig,
  request: LiveRowSequenceLaunchRequest,
  ref: string,
): Promise<LiveRowSequenceLaunchEntryResult> {
  const { key } = persona
  const latched = latchGateReadingOf(key)
  if (latched !== undefined) {
    const why = latched.failure === undefined ? 'it is latched' : `${latched.failure} — taken as latched`
    console.error(
      `${LIVE_ROW_SEQUENCE_LOG_PREFIX} not launching ${ref} — ${why} (case=${latched.latchCase}); no agent-director call (b.jg5 SRJ-502)`,
    )
    return { key, action: 'latched' }
  }
  // b.jg5 SRJ-207: a persona held on ErrInvalidFlags gets no launch.
  const held = heldResult(key, ref, LIVE_ROW_SEQUENCE_LAUNCH_SITE)
  if (held !== undefined) return held
  // b.jg5 SRJ-810, SRJ-1502: nor is P launched into a working directory an
  // old life that may still run holds (a hold on P's own row excepted: the
  // sequence's own reads have ended it by now); the hold step records P as
  // waiting, starts the hold's wait and arms P's retry timer, and the
  // sequence ends without its launch.
  const oldLifeHeld = oldLifeHoldResult(persona, ref, LIVE_ROW_SEQUENCE_LAUNCH_SITE)
  if (oldLifeHeld !== undefined) return oldLifeHeld
  const configDir = checkLaunchConfigDir(persona)
  if (!configDir.ok) {
    deferLaunchForConfigDir(persona, configDir)
    return deferredResult(persona, configDir)
  }
  if (isDryRun()) {
    console.error(`[slack] dry-run: skipping the live-row sequence's ${request.kind} for ${ref}`)
    return { key, action: 'no-op' }
  }
  // The plain spawn's parameters, for the spawn after `resume`'s `ErrSpawnNotFound` (b.jg5 SRJ-113, SRJ-111).
  const params = buildSpawnParams(persona, config, configDirLabelValue(configDir.realPath, spawnHomeDir()))
  forgetWorkingRowEvidence(key)
  endWorkingRowDeferral(key)
  endPromptRowDeferral(key)
  // b.jg5 SRJ-301: the launch is a launch attempt for the persona.
  const result = await runInAttempt(key, 'launch', async (attempt) => {
    const called = await sequenceLaunchCall(persona, config, request, ref, params)
    return called.action === LIVE_ROW_OUTCOME_NOT_LAUNCHED ? called : retryingWhenArmed(called, attempt)
  })
  if (result.action !== LIVE_ROW_OUTCOME_NOT_LAUNCHED) countSequenceLaunch(key, ref, result)
  return result
}

/**
 * Count the sequence launch's `result` once (b.jg5 SRJ-112, SRJ-113,
 * SRJ-602), as the restart path counts a launch result
 * (`launchSession`'s reading), by class: a success records a success; a
 * `failed` result that is not stopping and is marked `countedClass`
 * (LAUNCH FAILURE or DIRECTORY) records one counted launch failure (the cap
 * notice at the cap); any other `failed` result and a retrying, latched,
 * held or deferred result record nothing. The step-6 launch is not routed
 * through `launchSession`, so nothing else counts it. Never throws.
 */
function countSequenceLaunch(key: string, ref: string, result: SpawnPersonaResult): void {
  const succeeded = LIVE_ROW_LAUNCH_SUCCESS_ACTIONS.has(result.action)
  if (!succeeded && !sequenceLaunchCounted(result)) return
  try {
    recordLaunchResultOutsideRestartWork(key, succeeded)
  } catch (err) {
    console.error(`${LIVE_ROW_SEQUENCE_LOG_PREFIX} counting the launch of ${ref} failed: ${describeThrownValue(err)}`)
  }
}

/**
 * The sequence launch's call: the `resume` leg through the one `resume`
 * outcome handler (`resumeAtSite`, b.jg5 SRJ-113), or the reuse. `params`
 * is the plain spawn's (`buildSpawnParams`), for the spawn after `resume`'s
 * `ErrSpawnNotFound`. Never throws.
 */
async function sequenceLaunchCall(
  persona: Persona,
  config: PersonaConfig,
  request: LiveRowSequenceLaunchRequest,
  ref: string,
  params: SpawnParams,
): Promise<LiveRowSequenceLaunchEntryResult> {
  const { key } = persona
  if (request.kind === LIVE_ROW_LAUNCH_REUSE) return sequenceReuse(persona, config, request.lastRead, false, request.retiredAtStart)
  // b.av2 SR-6.2: the trust patch precedes every launch.
  runPreLaunchTrustPatch(persona, ref)
  console.error(`${LIVE_ROW_SEQUENCE_LOG_PREFIX} resuming ${ref} (b.jg5 SRJ-705)`)
  // b.jg5 SRJ-113, SRJ-301, SRJ-409 (HO rev 28): the handler's
  // `resumeFailedAt` marks an `ErrTmuxSessionCreate` result `countedClass`
  // (`countSequenceLaunch` counts it) and arms the persona's retry timer at
  // once in pending-only mode itself; a DIRECTORY failure is marked
  // `countedClass` here; any other failure is not counted.
  return resumeAtSite<LiveRowSequenceLaunchEntryResult>({
    persona,
    isStartup: false,
    ref,
    lastRead: request.lastRead,
    params,
    head: LIVE_ROW_SEQUENCE_LOG_PREFIX,
    marksDirectoryCounted: true,
    noTranscript: async (err) => {
      console.error(
        `${LIVE_ROW_SEQUENCE_LOG_PREFIX} ${describeAgentDirectorFailure(err)} on resume for ${ref} — going on to a reuse spawn of the same id; nothing is deleted (b.jg5 SRJ-705, SRJ-707)`,
      )
      // b.jg5 SRJ-712: after ErrJsonlMissing the diagnosis runs first.
      const reused = await noTranscriptReuse(persona, config, err, {
        isStartup: false,
        lastRead: request.lastRead,
        trustPatchRan: true,
        retiredAtStart: request.retiredAtStart,
      })
      return sequenceReuseAnswer(persona, reused)
    },
    notResumable: (err) => sequenceNotResumable(key, ref, err),
    plainSpawnCollided: () => Promise.resolve(sequenceSpawnCollision(persona)),
  })
}

/**
 * The collision row of the plain spawn the live-row sequence's step-6
 * `resume` leg makes after `ErrSpawnNotFound` (b.jg5 SRJ-111, SRJ-713,
 * SRJ-705, SRJ-706): the row turned live, so nothing was launched. No
 * get-then-act runs inside the sequence, which would be a second launch path
 * for the persona while its sequence runs: one line and the not-launched
 * answer `spawn-collision`, so the sequence ends without its launch, counts
 * nothing and arms the persona's retry timer with the collision cause, and
 * that retry's run of the restart path's decision is the get-then-act (its
 * ladder's plain first spawn collides and goes on to the collision `get`),
 * as for a reuse collision there (SRJ-112). Never the spawn-failure notice.
 */
function sequenceSpawnCollision(persona: Persona): LiveRowSequenceNotLaunched {
  const { key } = persona
  console.error(
    `${LIVE_ROW_SEQUENCE_LOG_PREFIX} the ${RESUME_NOT_FOUND_SPAWN_WHAT} of ${personaRef(persona)} collided with a live row — nothing launched, no spawn-failure notice, nothing counted; the sequence ends without its launch, and the retry it arms runs get-then-act (b.jg5 SRJ-111, SRJ-705, SRJ-713)`,
  )
  return { key, action: LIVE_ROW_OUTCOME_NOT_LAUNCHED, reason: LIVE_ROW_NOT_LAUNCHED_SPAWN_COLLISION }
}

/** The outcome of the step-6 `resume`'s `ErrSpawnNotResumable` when the re-read latched the persona. */
export const SEQUENCE_NOT_RESUMABLE_LATCHED_OUTCOME = 'the persona is latched: no second sequence; the sequence stops with nothing armed'

/** The outcome of the step-6 `resume`'s `ErrSpawnNotResumable` on a row re-read `pending`. */
export const SEQUENCE_NOT_RESUMABLE_PENDING_OUTCOME =
  'a launch in progress: no second sequence and no further call; the sequence ends without its launch, nothing counted or posted'

/** The outcome of the step-6 `resume`'s `ErrSpawnNotResumable` when the re-read found a lost race. */
export const SEQUENCE_NOT_RESUMABLE_LOST_RACE_OUTCOME = `a lost race: no second sequence and no further call; the sequence ends without its launch (cause=${UNAVAILABLE_RETRY_CAUSE_LOST_RACE} unless the persona is latched), nothing counted`

/**
 * The not-resumable step at the live-row sequence's own step-6 `resume`
 * (b.jg5 SRJ-710, SRJ-705, SRJ-706): the `ErrSpawnNotResumable` starts no
 * second sequence. One re-read and its decision with the sequence barred
 * (`notResumableStep`), one line (`spawnNotResumableLine`, naming no dead
 * evidence: the sequence carries none), and a not-launched answer, so the
 * sequence ends without its launch and nothing is counted:
 *   - the re-read latched the persona: `not-resumable-latched`, which the
 *     sequence ends as stopped for the latch, nothing armed;
 *   - `pending`: `not-resumable-pending`, nothing counted or posted; the
 *     sequence's end arms the other-end cause (SRJ-301);
 *   - any other state, no row, or a refused read (the shared read's own error
 *     rows applying): `not-resumable`, a lost race; the sequence's end arms
 *     the lost-race cause.
 * No kill, delete or launch follows. Never throws.
 */
async function sequenceNotResumable(key: string, ref: string, err: unknown): Promise<LiveRowSequenceNotLaunched> {
  const decision = await notResumableStep(key, ref, { site: LIVE_ROW_SEQUENCE_SITE, sequenceBarred: true })
  const [reason, outcome]: readonly [LiveRowSequenceNotLaunchedReason, string] =
    decision.answer === NOT_RESUMABLE_LATCHED
      ? [LIVE_ROW_NOT_LAUNCHED_NOT_RESUMABLE_LATCHED, SEQUENCE_NOT_RESUMABLE_LATCHED_OUTCOME]
      : decision.answer === NOT_RESUMABLE_PENDING
        ? [LIVE_ROW_NOT_LAUNCHED_NOT_RESUMABLE_PENDING, SEQUENCE_NOT_RESUMABLE_PENDING_OUTCOME]
        : [LIVE_ROW_NOT_LAUNCHED_NOT_RESUMABLE, SEQUENCE_NOT_RESUMABLE_LOST_RACE_OUTCOME]
  console.error(spawnNotResumableLine(LIVE_ROW_SEQUENCE_LOG_PREFIX, ref, describeAgentDirectorFailure(err), decision.reread, undefined, outcome))
  return { key, action: LIVE_ROW_OUTCOME_NOT_LAUNCHED, reason }
}

/**
 * The sequence's reuse spawn (`reuseSpawnForPersona`) of the `reuse` kind,
 * with `lastRead`, the row state the sequence last read; `trustPatchRan`
 * when this attempt already ran the trust patch; `retiredAtStart`, the
 * store's reading of the key when the sequence's launch attempt began
 * (b.jg5 SRJ-806). Its answer is read as `sequenceReuseAnswer` reads it.
 * Never throws.
 */
async function sequenceReuse(
  persona: Persona,
  config: PersonaConfig,
  lastRead: LatchRowState,
  trustPatchRan: boolean,
  retiredAtStart: RetiredKeyAttemptStart | undefined,
): Promise<LiveRowSequenceLaunchEntryResult> {
  return sequenceReuseAnswer(
    persona,
    await reuseSpawnForPersona(persona, config, { isStartup: false, lastRead, trustPatchRan, retiredAtStart }),
  )
}

/**
 * A reuse spawn's answer at the sequence's launch, of either leg: its
 * collided answer becomes the not-launched answer `reuse-collision` (b.jg5
 * SRJ-112, SRJ-705): no further launch, nothing counted; any other answer is
 * the launch's result.
 */
function sequenceReuseAnswer(persona: Persona, result: ReuseSpawnResult): LiveRowSequenceLaunchEntryResult {
  const { key } = persona
  if (!isReuseSpawnCollided(result)) return result
  console.error(
    `${LIVE_ROW_SEQUENCE_LOG_PREFIX} the reuse spawn of ${personaRef(persona)} collided with a live row — no further launch, nothing counted; the sequence ends without its launch (b.jg5 SRJ-112, SRJ-705)`,
  )
  return { key, action: LIVE_ROW_OUTCOME_NOT_LAUNCHED, reason: LIVE_ROW_NOT_LAUNCHED_REUSE_COLLISION }
}

/** What the live-row sequence's dependency builder is given (per-server instances). */
export interface LiveRowSequenceDepsInput {
  /** The server's kill-failure alerts (over its episodes instance); absent: the installed ones (`setKillFailureAlerts`). */
  readonly killFailureAlerts?: KillFailureAlerts
  /** The retry controller's arm (or a recorder in front of it). */
  readonly retryArm: UnavailableRetryTriggerSink
  /** The sequence's clock: its waits and its kills' waits between tries. */
  readonly clock: NeverEarlyWaitClock
  /** Where the sequence's own lines go. */
  readonly log: (line: string) => void
  /** The applied configuration now, read at each call. */
  readonly appliedConfig: () => PersonaConfig | null | undefined
}

/**
 * The retry cause label each of the sequence's arm causes arms with (b.jg5
 * SRJ-301, SRJ-717). Its type holds each label to its cause's own string, so
 * the sequence's end line and the retry controller's lines name a cause alike.
 */
const LIVE_ROW_SEQUENCE_ARM_CAUSE_LABELS: { readonly [C in LiveRowSequenceArmCause]: C } = Object.freeze({
  [LIVE_ROW_ARM_NOT_JUDGED]: UNAVAILABLE_RETRY_CAUSE_SEQUENCE_NOT_JUDGED,
  [LIVE_ROW_ARM_ENDED]: UNAVAILABLE_RETRY_CAUSE_SEQUENCE_ENDED,
  [LIVE_ROW_ARM_REUSE_COLLISION]: UNAVAILABLE_RETRY_CAUSE_REUSE_COLLISION,
  [LIVE_ROW_ARM_LOST_RACE]: UNAVAILABLE_RETRY_CAUSE_LOST_RACE,
})

/**
 * The live-row sequence's production dependencies (b.jg5 SRJ-705, SRJ-706,
 * SRJ-717), bound to the shared entries, so `main()` and the recovery
 * harness compose the sequence identically:
 *   - each `get` through the shared own-row read (`readPersonaOwnRow`: a
 *     `provenance_conflict` note, a configured persona's own `pending` row
 *     with no launch start or an UNUSABLE NAME answer latches the persona);
 *   - each run as a bypassing run (`bypassingFindMissingSweep`) with the
 *     persona's key as its next-step `get`, read with `readFindMissingRow`;
 *   - each kill through the bounded retry over the deferred-report
 *     persona-kill binding (`retryPersonaKill`), whose between-try read is
 *     the shared own-row `status` read, with the sequence's keep-going check
 *     beside the server's and its wait between tries;
 *   - a kill's CONFLICT and UNUSABLE NAME through the latch's entries
 *     (`conflictAt`, `unusableNameAt`) with the state last read;
 *   - the alerts through the server's kill-failure alerts, with the
 *     request's context;
 *   - the latched query, P's `ad-config-malformed` flag, the G accessor
 *     (`adGraceMsInEffect`), the applied `resume_enabled`, the row
 *     comparison (`compareRowToPersona`) and the installed retired-key
 *     store's reading at step 6 (`retiredKeyReadingOf`), the sequence-launch entry
 *     (`launchForLiveRowSequence`) and the retry arm with the sequence's
 *     four causes (`UNAVAILABLE_RETRY_CAUSE_SEQUENCE_NOT_JUDGED`,
 *     `UNAVAILABLE_RETRY_CAUSE_SEQUENCE_ENDED`,
 *     `UNAVAILABLE_RETRY_CAUSE_REUSE_COLLISION`,
 *     `UNAVAILABLE_RETRY_CAUSE_LOST_RACE`).
 * Every agent-director call goes through `withOutageDetection` inside those
 * entries. The builder reads nothing and starts nothing when called.
 */
export function buildLiveRowSequenceDeps(input: LiveRowSequenceDepsInput): LiveRowSequenceDeps {
  const applied = (key: string): { readonly persona: Persona; readonly config: PersonaConfig } | undefined => {
    const config = input.appliedConfig() ?? undefined
    const persona = config?.personas.find((p) => p.key === key)
    return config !== undefined && persona !== undefined ? { persona, config } : undefined
  }
  return {
    clock: input.clock,
    log: input.log,
    isLatched: (key) => personaLatchedNow(key),
    isConfigMalformedRaised: (key) => getOutageFlags(key).has('ad-config-malformed'),
    graceMs: adGraceMsInEffect,
    readRow: (key, ref) => readSequenceRow(key, ref),
    runFindMissing: (key, instanceId, stateBefore) => runSequenceFindMissing(key, instanceId, stateBefore),
    killWithRetry: (key, options) =>
      retryPersonaKill(key, {
        rowReadLive: true,
        lastRead:
          options.lastReadState === LIVE_ROW_SEQUENCE_NO_ROW ? KILL_RETRY_SEED_NOT_LIVE_VALUE : killRetrySeedOfState(options.lastReadState),
        site: LIVE_ROW_SEQUENCE_SITE,
        ref: options.ref,
        clock: options.wait,
        keepGoing: options.keepGoing,
      }),
    latchOnKillOutcome: (key, outcome, lastRead, ref) =>
      latchOnKillOutcomeAt(key, outcome, LIVE_ROW_SEQUENCE_SITE, ref, latchRowStateOfSequenceRead(lastRead)),
    raiseKillAlert: (key, retried, context, ref, stopCause) =>
      raisePersonaKillFailureAlert(key, retried, LIVE_ROW_SEQUENCE_SITE, ref, context, input.killFailureAlerts, stopCause),
    raiseEscalationAlert: (key, context, ref) => raiseSequenceEscalationAlert(key, context, ref, input.killFailureAlerts),
    personaFacts: (key, row) => {
      const found = applied(key)
      if (found === undefined) return undefined
      const resumeEnabled = found.config.resume_enabled !== false
      // b.jg5 SRJ-805: the store read at step 6, so a key recorded while the sequence ran never ends in a `resume`.
      const retired = retiredKeyReadingOf(key).recorded
      if (row === undefined) return { resumeEnabled, cwdMatches: true, configDirMatches: true, retired }
      const comparison = compareRowToPersona({ cwd: row.cwd, labels: row.labels }, found.persona, spawnHomeDir(), undefined, _configDirFs)
      return {
        resumeEnabled,
        retired,
        // b.av2 SR-6.4: a `cwd` check that cannot be made now is no mismatch.
        cwdMatches: comparison.cwdMatches || comparison.cwdCheckDeferred,
        // Bug b.g57: an unresolvable directory gives no verdict; the launch's own check holds it.
        configDirMatches: !comparison.configDirResolved || comparison.configDirMatches === true,
      }
    },
    launch: async (key, kind, lastRead, ref, stop, retiredAtStart) => {
      const found = applied(key)
      if (found === undefined) {
        console.error(
          `${LIVE_ROW_SEQUENCE_LOG_PREFIX} ${ref}: step 6: the persona is not in the applied configuration — no launch (b.jg5 SRJ-705)`,
        )
        return { kind: LIVE_ROW_OUTCOME_NOT_LAUNCHED, reason: LIVE_ROW_NOT_LAUNCHED_NOT_APPLIED }
      }
      const result = await launchForLiveRowSequence(found.persona, found.config, {
        kind,
        lastRead: latchRowStateOfSequenceRead(lastRead),
        stop,
        retiredAtStart,
      })
      return result.action === LIVE_ROW_OUTCOME_NOT_LAUNCHED
        ? { kind: LIVE_ROW_OUTCOME_NOT_LAUNCHED, reason: result.reason }
        : { kind: LIVE_ROW_LAUNCH_ANSWER_LAUNCHED, result }
    },
    armRetry: (key, cause) => {
      try {
        input.retryArm.arm(key, { kind: LIVE_ROW_SEQUENCE_ARM_CAUSE_LABELS[cause] })
      } catch (err) {
        console.error(`${LIVE_ROW_SEQUENCE_LOG_PREFIX} persona=${key}: arming the retry timer failed: ${describeThrownValue(err)}`)
      }
    },
  }
}

/** The state a latch records for what the sequence last read. */
function latchRowStateOfSequenceRead(lastRead: LiveRowSequenceLastRead): LatchRowState {
  return lastRead.kind === LIVE_ROW_SEQUENCE_NO_ROW ? LATCH_ROW_STATE_NO_ROW : latchRowStateRead(lastRead.state)
}

/** One `get` of persona `key`'s row through the shared own-row read, as the sequence takes it. Never throws. */
async function readSequenceRow(key: string, ref: string): Promise<LiveRowSequenceRead> {
  const read = await readPersonaOwnRow(key, { site: LIVE_ROW_SEQUENCE_SITE, what: 'get', ref })
  switch (read.kind) {
    case OWN_ROW_READ_ROW:
      // The row whole, so the sequence reads its launch start and session id.
      return read.latched ? { kind: LIVE_ROW_READ_LATCHED } : { kind: LIVE_ROW_READ_ROW, row: read.row as Phase1GetResult }
    case OWN_ROW_READ_ABSENT:
      return { kind: LIVE_ROW_READ_ABSENT }
    case OWN_ROW_READ_LATCHED:
      return { kind: LIVE_ROW_READ_LATCHED }
    case OWN_ROW_READ_REFUSED:
      return { kind: LIVE_ROW_READ_REFUSED, error: read.error }
  }
}

/**
 * One bypassing run for persona `key` (`bypassingFindMissingSweep`, its key
 * as the next-step `get`), with where it put `instanceId`, last read
 * `stateBefore` (`readFindMissingRow`); or how it failed: refused by class
 * (`FIND_MISSING_REFUSED`), the persona latched (`FIND_MISSING_LATCHED`),
 * any other failure. Never throws.
 */
async function runSequenceFindMissing(key: string, instanceId: string, stateBefore: string): Promise<LiveRowSequenceRunPlacement> {
  return runPlacementOf(await bypassingFindMissingSweep(key, LIVE_ROW_SEQUENCE_SITE, key), instanceId, stateBefore)
}

/**
 * Where a bypassing run's `answer` put row `instanceId`, last read
 * `stateBefore` (`readFindMissingRow`), or how it failed: refused by class
 * (`FIND_MISSING_REFUSED`), the persona latched (`FIND_MISSING_LATCHED`), any
 * other failure. Pure; never throws.
 */
function runPlacementOf(answer: FindMissingSweepAnswer, instanceId: string, stateBefore: string): LiveRowSequenceRunPlacement {
  if (answer === FIND_MISSING_REFUSED) return LIVE_ROW_RUN_REFUSED
  if (answer === FIND_MISSING_LATCHED) return LIVE_ROW_RUN_LATCHED
  if (answer === undefined) return LIVE_ROW_RUN_FAILED
  switch (readFindMissingRow(answer, instanceId, stateBefore)) {
    case FIND_MISSING_ROW_MARKED_MISSING:
      return LIVE_ROW_RUN_MARKED_MISSING
    case FIND_MISSING_ROW_LEFT_LIVE:
      return LIVE_ROW_RUN_LEFT_LIVE
    case FIND_MISSING_ROW_NOT_JUDGED:
      return LIVE_ROW_RUN_NOT_JUDGED
    case FIND_MISSING_ROW_JUDGED_ALIVE:
      return LIVE_ROW_RUN_JUDGED_ALIVE
  }
}

/**
 * Step 5's kill-failure alert (b.jg5 SRJ-705, SRJ-704, SRJ-1007): the
 * ordinary version with no description, for persona `key`, with the
 * request's `context`, through `alerts` (the installed ones by default),
 * which route it and hold it once per episode. With no alerts installed, one
 * line instead. Never throws.
 */
function raiseSequenceEscalationAlert(
  key: string,
  context: KillFailureAlertContext,
  ref: string,
  alerts: KillFailureAlerts | undefined = killFailureAlerts,
): void {
  try {
    if (alerts === undefined) {
      console.error(
        `${LIVE_ROW_SEQUENCE_LOG_PREFIX} ${ref}: the kill-failure alert's ordinary version is not raised — no kill-failure alerts are installed (b.jg5 SRJ-704, SRJ-705)`,
      )
      return
    }
    alerts.raise({ key, decision: { kind: KILL_RETRY_ALERT_ORDINARY }, latched: personaLatchedNow(key), context })
  } catch (err) {
    console.error(`${LIVE_ROW_SEQUENCE_LOG_PREFIX} ${ref}: raising the kill-failure alert failed: ${describeThrownValue(err)}`)
  }
}

// ---------------------------------------------------------------------------
// The old-life wait (b.jg5 SRJ-811, SRJ-812, SRJ-1512)
// ---------------------------------------------------------------------------

/**
 * What `main()` gives the old-life wait (b.jg5 SRJ-811): the retry
 * controller's arm (each waiting persona's timer; never the old key's), the
 * wait's clock and line sink, the applied configuration read at each call
 * (the waiting personas), and the alert sinks the persona teardown's are
 * given: the server's kill-failure alerts (over its one episodes instance;
 * absent, the installed ones) and the startup-errors recorder (absent,
 * `recordStartupError`); and the wait's unclassified-error episodes
 * (`createOldLifeWaitUnclassifiedErrors`), keyed by the held instance id.
 */
export interface OldLifeWaitBindings {
  readonly retryArm: UnavailableRetryTriggerSink
  readonly clock: NeverEarlyWaitClock
  readonly log: (line: string) => void
  readonly appliedConfig: () => PersonaConfig | null | undefined
  readonly killFailureAlerts?: KillFailureAlerts
  readonly recordStartupError?: (classLabel: string, entry: string) => void
  /**
   * The wait's unclassified-error episodes (b.jg5 SRJ-313, SRJ-811;
   * `createOldLifeWaitUnclassifiedErrors`): each round that keeps the hold
   * reports its first UNCLASSIFIED answer under the held instance id, and the
   * hold's end ends that episode. Absent: the answer is not reported, with
   * one line (`oldLifeWaitUnclassifiedNotReportedLine`).
   */
  readonly unclassifiedErrorEpisodes?: UnclassifiedErrorEpisodes
}

/**
 * The installed old-life wait bindings. Production installs them in `main()`
 * beside the live-row sequence registry, before the start pass. With none
 * installed (unit tests that install none) no wait starts
 * (`ensureOldLifeWait` answers `not-installed`), no persona is armed by a
 * wait, and the wait queries answer false.
 */
let oldLifeWaitBindings: OldLifeWaitBindings | undefined

/** Install the old-life wait's bindings (production: `main()`), or remove them with undefined (b.jg5 SRJ-811). */
export function setOldLifeWaitBindings(bindings: OldLifeWaitBindings | undefined): void {
  oldLifeWaitBindings = bindings
}

/** Test-only seam: remove any installed old-life wait bindings. */
export function _resetOldLifeWaitBindings(): void {
  oldLifeWaitBindings = undefined
}

/** What `createOldLifeWaitUnclassifiedErrors` is given. */
export interface OldLifeWaitUnclassifiedErrorsDeps {
  /** Receives the episodes' `[slack]` lines (the server log). */
  readonly log: (line: string) => void
  /** The alert threshold in effect, in milliseconds (production: `adAlertThresholdMsInEffect`), read at each check. */
  readonly alertThresholdMs: () => number
  /** The startup-errors recorder the alert's log-only route writes through (production: `recordStartupError`). */
  readonly recordStartupError: (classLabel: string, entry: string) => void
  /** The episodes' clock; `SYSTEM_PERSONA_CONNECTION_CLOCK` by default. */
  readonly clock?: PersonaEpisodesClock
}

/** The old-life wait's unclassified-error episodes, with the close of the episodes instance they are held in (shutdown). */
export interface OldLifeWaitUnclassifiedErrors extends UnclassifiedErrorEpisodes {
  /** End every episode silently and refuse every later one (the server's shutdown). */
  close(): void
}

/**
 * The old-life wait's unclassified-error episodes (b.jg5 SRJ-313, SRJ-811,
 * SRJ-1013): E12's episodes (`createUnclassifiedErrorEpisodes`) over an
 * episodes instance of their own, so an episode keyed by a held instance id
 * never shares a persona's own, nor a persona's teardown window. Every key
 * is taken as not configured, so the one alert per episode always takes the
 * log-only route: one `persona-unclassified-error` entry through
 * `deps.recordStartupError` (which writes the server-log line too), its text
 * the wait's reference and the unescaped alert
 * (`oldLifeWaitUnclassifiedEntryText`); nothing reaches Slack. No retry
 * timer's stop, latch, cap or teardown ends an episode: only the hold's end
 * (`onOldLifeHoldEnd`) and `close`. Nothing is read, posted or logged at
 * creation.
 */
export function createOldLifeWaitUnclassifiedErrors(deps: OldLifeWaitUnclassifiedErrorsDeps): OldLifeWaitUnclassifiedErrors {
  const episodes = createPersonaEpisodes({
    // Not reached: every key takes the log-only route and no teardown window opens here.
    sink: (instanceId) => {
      deps.log(`${OLD_LIFE_WAIT_LOG_PREFIX} instanceId=${renderLogMessageText(instanceId)}: an unclassified-error notice reached no destination — the wait's alerts are log-only (b.jg5 SRJ-313, SRJ-811)`)
    },
    log: deps.log,
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
  })
  const errors = createUnclassifiedErrorEpisodes({
    episodes,
    log: deps.log,
    alertThresholdMs: deps.alertThresholdMs,
    isConfigured: () => false,
    logOnly: (instanceId, text) => deps.recordStartupError(PERSONA_UNCLASSIFIED_ERROR_LABEL, oldLifeWaitUnclassifiedEntryText(instanceId, text)),
  })
  return {
    report: (key, error, classification) => errors.report(key, error, classification),
    end: (key, reason) => errors.end(key, reason),
    retryStopped: (key, stopReason) => errors.retryStopped(key, stopReason),
    isOpen: (key) => errors.isOpen(key),
    close: () => episodes.close(),
  }
}

/**
 * The `persona-unclassified-error` entry text of an old-life wait's
 * unclassified-error alert on held row `instanceId` (b.jg5 SRJ-1007,
 * SRJ-1013): `<ref>: <text>`, `<ref>` the wait's reference
 * (`oldLifeWaitRef`) over the installed hold's old key, the instance id
 * standing in when no hold is on it. Never throws.
 */
export function oldLifeWaitUnclassifiedEntryText(instanceId: string, text: string): string {
  let oldKey = instanceId
  try {
    oldKey = oldLifeHolds?.holdOf(instanceId)?.oldKey ?? instanceId
  } catch {
    /* not reached (the hold set never throws) */
  }
  return `${oldLifeWaitRef(instanceId, oldKey)}: ${text}`
}

/**
 * The line of an UNCLASSIFIED answer a wait's round met when no
 * unclassified-error episodes are installed (b.jg5 SRJ-313, SRJ-811):
 *
 *   [slack] old-life-wait: <ref>: no unclassified-error episodes are installed — the UNCLASSIFIED answer is not reported (b.jg5 SRJ-313, SRJ-811)
 *
 * Pure.
 */
export function oldLifeWaitUnclassifiedNotReportedLine(ref: string): string {
  return `${OLD_LIFE_WAIT_LOG_PREFIX} ${ref}: no unclassified-error episodes are installed — the UNCLASSIFIED answer is not reported (b.jg5 SRJ-313, SRJ-811)`
}

/** One old-life wait's old row: its instance id and the old key (the hold's, `oldLifeKeyOf`; the instance id when it stands in). */
export interface OldLifeWaitTarget {
  readonly instanceId: string
  readonly oldKey: string
}

/**
 * Whether the wait's old row is a configured persona's own row
 * (`cscb_<key>` of a key the installed configured-persona query counts): a
 * row the start sweep swept for its `cwd`. Its `get`s and between-try reads
 * are then the shared own-row reads, so SRJ-114's and SRJ-513's row rules
 * apply (b.jg5 SRJ-811). Never throws.
 */
function isConfiguredOwnRow(target: OldLifeWaitTarget): boolean {
  return target.oldKey !== target.instanceId && personaInstanceId(target.oldKey) === target.instanceId && configuredReadingOf(target.oldKey).configured
}

/**
 * The wrapper options of every call the wait makes itself (b.jg5 SRJ-811,
 * SRJ-1512): arm nothing for the old key (no retry timer, no
 * `tmux-unresponsive` condition, no unclassified episode), and raise an
 * ENVIRONMENT or CONFIG outage under the old key only for a configured
 * persona's own row; the waiting personas' outages are raised by
 * `noteOldLifeWaitAnswer`.
 */
function oldLifeWaitCallOptions(target: OldLifeWaitTarget): OutageDetectionOptions {
  return { armsNothing: { personaConfigured: () => isConfiguredOwnRow(target) } }
}

/** What one round of a wait met, as its dependencies record it (`OldLifeWaitAnswers`, `src/old-life-wait.ts`). */
export interface OldLifeWaitRecord {
  readonly refusals: OldLifeWaitRefusal[]
  unclassified?: unknown
  lastKill?: KillRetryResult
  /** The old row's tmux session as a `get` read it, for the kill-failure alert's text; absent until read. */
  session?: string
}

/** A new, empty record for one wait round. */
export function createOldLifeWaitRecord(): OldLifeWaitRecord {
  return { refusals: [] }
}

/**
 * Whether the installed bindings' configuration shows `key` outside the
 * applied set (b.av2 SR-8.6): no applied configuration, or none of its
 * personas has the key. False with no bindings installed or when the read
 * throws, so a key is never taken as removed on a reading that could not
 * be made. Never throws.
 */
function isKnownUnapplied(key: string, bindings: OldLifeWaitBindings | undefined = oldLifeWaitBindings): boolean {
  if (bindings === undefined) return false
  try {
    const config = bindings.appliedConfig()
    return config === null || config === undefined || !config.personas.some((p) => p.key === key)
  } catch {
    return false
  }
}

/** The applied persona with key `key` (the installed bindings' configuration), or undefined. Never throws. */
function oldLifeAppliedPersona(key: string, bindings: OldLifeWaitBindings | undefined = oldLifeWaitBindings): Persona | undefined {
  try {
    return bindings?.appliedConfig()?.personas.find((p) => p.key === key)
  } catch {
    return undefined
  }
}

/**
 * The applied personas waiting on the hold on `instanceId` (b.jg5 SRJ-810,
 * SRJ-811): each persona of the applied configuration whose working
 * directory is the held directory, or whose own `cscb_<key>` is the held
 * row (the hold set's waits-on query). None with no hold set or no bindings
 * installed. Never throws.
 */
export function oldLifeWaitingPersonas(instanceId: string, bindings: OldLifeWaitBindings | undefined = oldLifeWaitBindings): Persona[] {
  const holds = oldLifeHolds
  if (holds === undefined) return []
  try {
    const personas = bindings?.appliedConfig()?.personas ?? []
    return personas.filter((p) => holds.holdsWaitedOnBy(p).some((hold) => hold.instanceId === instanceId))
  } catch (err) {
    console.error(`${OLD_LIFE_WAIT_LOG_PREFIX} the waiting personas of instanceId=${instanceId} could not be read: ${describeThrownValue(err)} — none`)
    return []
  }
}

/**
 * One answer an old-life wait's call met (b.jg5 SRJ-811, SRJ-1002), by class
 * through `src/ad-error-class.ts` (by name): a CONFLICT or an UNUSABLE NAME
 * answer is recorded for its `persona-teardown-notice` entry and latches no
 * one; an ENVIRONMENT answer raises `tmux-unavailable`, and a CONFIG answer
 * `ad-config-malformed`, for each persona waiting on the hold (hatch A3; the
 * calling agent's reading of SRJ-311 for ENVIRONMENT); the first
 * UNCLASSIFIED answer is recorded for the end handler's report to the old
 * row's unclassified-error episode. `errorClass` is the class the caller
 * decided (a kill outcome's),
 * else the classifier's. Never throws.
 */
function noteOldLifeWaitAnswer(
  target: OldLifeWaitTarget,
  record: OldLifeWaitRecord,
  err: unknown,
  at: OldLifeWaitRefusalAt,
  errorClass: string = classifyAdError(err).errorClass,
): void {
  try {
    if (errorClass === AD_ERROR_CLASS_CONFLICT || errorClass === AD_ERROR_CLASS_UNUSABLE_NAME) {
      record.refusals.push({ at, errorClass, error: err })
      return
    }
    if (errorClass === AD_ERROR_CLASS_ENVIRONMENT || errorClass === AD_ERROR_CLASS_CONFIG) {
      for (const persona of oldLifeWaitingPersonas(target.instanceId)) {
        try {
          if (errorClass === AD_ERROR_CLASS_ENVIRONMENT) raiseTmuxUnavailable(persona.key, err)
          else raiseAdConfigMalformed(persona.key, err)
        } catch (raiseErr) {
          console.error(`${OLD_LIFE_WAIT_LOG_PREFIX} raising the outage for persona=${persona.key} failed: ${describeThrownValue(raiseErr)}`)
        }
      }
      return
    }
    if (errorClass === AD_ERROR_CLASS_UNCLASSIFIED && record.unclassified === undefined) record.unclassified = err
  } catch {
    /* recording an answer never changes the call's own outcome */
  }
}

/**
 * A call the wait made itself succeeded (b.jg5 SRJ-312, SRJ-316, SRJ-811):
 * agent-director read its store, so the `ad-config-malformed` outage is
 * cleared for each persona waiting on the hold, through the outage state's
 * clear (`clearOutageFlag`), as a persona's own successful call clears it;
 * an outage not raised is left as it is. `tmux-unavailable` is not cleared
 * here: its clear stops the persona's retry timer (the condition-end entry),
 * which would drop the held-for-old-life arm the wait relies on. Never
 * throws.
 */
function clearOldLifeWaitConfigOutage(target: OldLifeWaitTarget): void {
  try {
    for (const persona of oldLifeWaitingPersonas(target.instanceId)) {
      try {
        if (getOutageFlags(persona.key).has('ad-config-malformed')) clearOutageFlag(persona.key, 'ad-config-malformed')
      } catch (clearErr) {
        console.error(`${OLD_LIFE_WAIT_LOG_PREFIX} clearing the outage for persona=${persona.key} failed: ${describeThrownValue(clearErr)}`)
      }
    }
  } catch {
    /* a clear never changes the call's own outcome */
  }
}

/** What the wait's dependency builder is given (`buildOldLifeWaitDeps`). */
export interface OldLifeWaitDepsInput {
  /** The old row. */
  readonly target: OldLifeWaitTarget
  /** Where the round records what its calls met (`createOldLifeWaitRecord`). */
  readonly record: OldLifeWaitRecord
  /** The wait's clock: its waits, pauses and its kills' waits between tries. */
  readonly clock: NeverEarlyWaitClock
  /** Where the sequence's own lines go. */
  readonly log: (line: string) => void
  /** The server's kill-failure alerts; absent: the installed ones (`setKillFailureAlerts`). */
  readonly killFailureAlerts?: KillFailureAlerts
}

/** The stop cause a wait's kill names when a shutdown stopped its tries (b.jg5 SRJ-702, SRJ-811). */
export const OLD_LIFE_WAIT_STOP_CAUSE_SHUTDOWN = 'its old-life wait was stopped: the server is shutting down'

/** The stop cause a wait's kill names when the teardown of the last persona waiting on its hold stopped its tries (b.jg5 SRJ-702, SRJ-811). */
export const OLD_LIFE_WAIT_STOP_CAUSE_TEARDOWN = 'its old-life wait was stopped: the last persona waiting on its hold was torn down'

/**
 * The stop cause a wait's kill names when the latch of the configured persona
 * whose own row the wait is on stopped its tries (b.jg5 SRJ-702, SRJ-502,
 * SRJ-811).
 */
export const OLD_LIFE_WAIT_STOP_CAUSE_LATCHED = 'its old-life wait was stopped: the persona whose own row it is latched'

/** The stop cause a wait's kill names when the sequence names no stop cause it knows (b.jg5 SRJ-702, SRJ-811). */
export const OLD_LIFE_WAIT_STOP_CAUSE_UNKNOWN = 'its old-life wait was stopped'

/**
 * The stop cause of a wait's kill for the sequence's stop cause `given`
 * (`liveRowStopCauseText`): a shutdown, the last waiter's teardown or the
 * own-row persona's latch; any other cause, or none, the neutral
 * `OLD_LIFE_WAIT_STOP_CAUSE_UNKNOWN`. Pure.
 */
function oldLifeWaitStopCause(given: string | undefined): string {
  if (given === liveRowStopCauseText(LIVE_ROW_STOP_SHUTDOWN)) return OLD_LIFE_WAIT_STOP_CAUSE_SHUTDOWN
  if (given === liveRowStopCauseText(LIVE_ROW_STOP_TEARDOWN)) return OLD_LIFE_WAIT_STOP_CAUSE_TEARDOWN
  if (given === liveRowStopCauseText(LIVE_ROW_STOP_LATCHED)) return OLD_LIFE_WAIT_STOP_CAUSE_LATCHED
  return OLD_LIFE_WAIT_STOP_CAUSE_UNKNOWN
}

/**
 * The tmux session the wait's kill-failure alert names (b.jg5 SRJ-1001,
 * SRJ-811): the one a `get` of the row read; else the one the start sweep's
 * listing named when it began or kept the hold (`noteOldLifeHoldSession`);
 * else the old key's `slack_bot_<key>` for its own `cscb_<key>` row; else
 * none (empty), which the alert builders render as `"unknown"`. An instance
 * id is never named as a session.
 */
function oldLifeWaitSession(target: OldLifeWaitTarget, record: OldLifeWaitRecord): string {
  if (record.session !== undefined) return record.session
  const listed = oldLifeSessionNames.get(target.instanceId)
  if (listed !== undefined) return listed
  return target.oldKey !== target.instanceId ? personaTmuxSessionName(target.oldKey) : ''
}

/** The line head of the wait's kill tries, reads and alerts. */
const OLD_LIFE_WAIT_KILL_LOG_PREFIX = `[slack] ${OLD_LIFE_WAIT_SITE}`

/**
 * The old-life wait's dependencies for one old row (b.jg5 SRJ-811, SRJ-705
 * steps 1 to 5 with no launch): the live-row sequence's dependency interface
 * (`LiveRowSequenceDeps`) bound to `input.target`'s instance id, so the
 * sequence's no-launch form runs on it. Every call is reported under the old
 * key (or the instance id standing in for it):
 *   - the `get`s: for a configured persona's own row, the shared own-row read
 *     (`readPersonaOwnRow`, SRJ-114, SRJ-513), its UNUSABLE NAME answer routed
 *     per SRJ-1002 (no latch); for any other id, one plain `get` that applies
 *     no row-read rule. Every answer reaches the old-life read entry
 *     (`noteOldLifeRowRead`), so a read of `ended` or `missing`, or no row,
 *     ends the hold;
 *   - the runs: the bypassing entry (`bypassingFindMissingSweep`, E14 T2),
 *     with the old key's next-step `get` only for a configured persona's own
 *     row; a run's `ids` end the hold through the run's own read entry;
 *   - each kill: the checked kill of the instance id inside the bounded retry
 *     (`runKillRetry`) in the deferred-report form: its tries and its
 *     between-try `status` reads arm nothing; the read is the shared own-row
 *     `status` step for a configured persona's own row (its UNUSABLE NAME
 *     answer latching nothing) and a plain `status` otherwise; its
 *     keep-going check is the sequence's stop and the latch query below, so
 *     a shutdown, the last waiter's teardown or the own-row persona's latch
 *     stops it, never a persona not up nor any other persona's latch (AC
 *     64), each stop naming its own cause (`oldLifeWaitStopCause`); and its hold-end query ends the tries as a success when the hold
 *     ends between tries or during a try whose UNAVAILABLE outcome would
 *     stand, or the sequence was stopped for the hold's end, even with a new
 *     hold begun on the id since (SRJ-702; option A);
 *   - the launch start: the sequence's own reader (`src/pending-row.ts`), so
 *     a `pending` row with no launch start under a key no configured persona
 *     uses gets no wait for G and latches nothing (SRJ-408);
 *   - the alerts: the kill-failure alerts with the context `old-life wait`,
 *     always on the not-configured, log-only route (a server-log line and a
 *     `persona-kill-failed` or `persona-kill-survivor` entry), naming the old
 *     row's instance id and session (`oldLifeWaitSession`); a kill whose
 *     tries a shutdown or the last waiter's teardown stopped writes its one
 *     line and the old key's `persona-kill-failed` entry with no alert text,
 *     and one whose tries the own-row persona's latch stopped writes the
 *     line only;
 *   - the latch query (`isLatched`): for a configured persona's own row, that
 *     persona's latch, so no kill or call is made for its row while it is
 *     latched (SRJ-502, SRJ-408, SRJ-513; AC 46); for any other id, never;
 *   - no latching (`latchOnKillOutcome` latches nothing), no launch and no
 *     retry arm: the no-launch form never reaches them, and the waiting
 *     personas are armed by the end handler.
 * Each answer is recorded in `input.record` (`noteOldLifeWaitAnswer`): a
 * CONFLICT or UNUSABLE NAME answer for its notice, ENVIRONMENT and CONFIG
 * raising their outage for each waiting persona, the first UNCLASSIFIED
 * answer, and the last kill's result. Each call that succeeds clears the
 * waiting personas' `ad-config-malformed` outage
 * (`clearOldLifeWaitConfigOutage`). No new `getClient()` site: every call
 * goes through `withOutageDetection` or the shared reads. The builder reads
 * nothing and starts nothing when called.
 */
export function buildOldLifeWaitDeps(input: OldLifeWaitDepsInput): LiveRowSequenceDeps {
  const { target, record } = input
  const { instanceId, oldKey } = target
  return {
    clock: input.clock,
    log: input.log,
    // SRJ-502, SRJ-408, SRJ-513: a configured persona's own row is never
    // killed or called while that persona is latched. Any other latch never
    // stops the wait (SRJ-702, SRJ-811; AC 64).
    isLatched: () => isConfiguredOwnRow(target) && personaLatchedNow(oldKey),
    isConfigMalformedRaised: () =>
      getOutageFlags(oldKey).has('ad-config-malformed') ||
      oldLifeWaitingPersonas(instanceId).some((p) => getOutageFlags(p.key).has('ad-config-malformed')),
    graceMs: adGraceMsInEffect,
    readRow: (_key, ref) => readOldLifeRow(target, record, ref),
    runFindMissing: async (_key, runInstanceId, stateBefore) => {
      const answer = await bypassingFindMissingSweep(oldKey, OLD_LIFE_WAIT_SITE, isConfiguredOwnRow(target) ? oldKey : undefined, {
        outage: oldLifeWaitCallOptions(target),
        onFailure: (err) => noteOldLifeWaitAnswer(target, record, err, OLD_LIFE_WAIT_AT_FIND_MISSING),
      })
      // A completed run (its next-step `get` included) read agent-director's store.
      if (answer !== undefined && answer !== FIND_MISSING_REFUSED && answer !== FIND_MISSING_LATCHED) clearOldLifeWaitConfigOutage(target)
      return runPlacementOf(answer, runInstanceId, stateBefore)
    },
    killWithRetry: async (_key, options) => {
      const seed =
        options.lastReadState === LIVE_ROW_SEQUENCE_NO_ROW
          ? KILL_RETRY_SEED_NOT_LIVE_VALUE
          : options.lastReadState === OLD_LIFE_WAIT_SEED_LIVE_UNREAD
            ? KILL_RETRY_SEED_LIVE_UNREAD
            : killRetrySeedOfState(options.lastReadState)
      const call = adKillCall(killRetrySeedIsLive(seed))
      const result = await runKillRetry({
        instanceId,
        kill: () => tryOldLifeKill(target, record, call),
        read: () => readOldLifeKillRow(target, record, options.ref),
        wait: options.wait,
        lastRead: seed,
        keepGoing: options.keepGoing,
        // SRJ-702, SRJ-811 (option A): the hold's end ends the tries as a
        // success, a stop for it included when a new hold has begun on the id.
        holdEnded: () => options.stoppedForHoldEnd?.() === true || oldLifeHoldEnded(instanceId),
        log: (line) => console.error(line),
        logPrefix: `${OLD_LIFE_WAIT_KILL_LOG_PREFIX} for ${options.ref}`,
      })
      record.lastKill = result
      return result
    },
    latchOnKillOutcome: async () => false,
    raiseKillAlert: (_key, retried, _context, ref, stopCause) =>
      raiseOldLifeWaitKillAlert(target, record, retried, ref, stopCause, input.killFailureAlerts),
    raiseEscalationAlert: (_key, _context, ref) => raiseOldLifeWaitEscalationAlert(target, record, ref, input.killFailureAlerts),
    personaFacts: () => undefined,
    launch: async (_key, _kind, _lastRead, ref) => {
      // Not reached: the no-launch form never reaches step 6's launch (SRJ-1512).
      console.error(`${OLD_LIFE_WAIT_LOG_PREFIX} ${ref}: the old-life wait never launches its old key — no launch (b.jg5 SRJ-811, SRJ-1512)`)
      return { kind: LIVE_ROW_OUTCOME_NOT_LAUNCHED, reason: LIVE_ROW_NOT_LAUNCHED_NOT_APPLIED }
    },
    armRetry: () => {
      /* SRJ-1512: no retry timer is armed for the old key */
    },
  }
}

/**
 * Whether the hold on `instanceId` has ended (the wait's kill's hold-end
 * query, b.jg5 SRJ-702, SRJ-811): no hold on it in the installed hold set.
 * With no hold set installed, never. Never throws.
 */
function oldLifeHoldEnded(instanceId: string): boolean {
  const holds = oldLifeHolds
  if (holds === undefined) return false
  try {
    return holds.holdOf(instanceId) === undefined
  } catch {
    return false
  }
}

/**
 * One try of a wait's kill (b.jg5 SRJ-110, SRJ-811): one checked kill of the
 * old row's instance id through `withOutageDetection` under the old key,
 * arming nothing (`oldLifeWaitCallOptions`), with the `ErrInvalidFlags`
 * re-check (`recheckKillOnInvalidFlags`). A non-success's class is recorded
 * (`noteOldLifeWaitAnswer`); an UNAVAILABLE one is the bounded retry's.
 * Never throws.
 */
async function tryOldLifeKill(target: OldLifeWaitTarget, record: OldLifeWaitRecord, call: AdKillCall): Promise<KillOutcome> {
  const outcome = await recheckKillOnInvalidFlags(
    await checkedKill(target.instanceId, async (params) => {
      const answer = await withOutageDetection(target.oldKey, undefined, call, (client) => client.kill(params), oldLifeWaitCallOptions(target))
      clearOldLifeWaitConfigOutage(target)
      return answer
    }),
  )
  if (outcome.kind === KILL_OUTCOME_NOT_KILLED && outcome.errorClass !== AD_ERROR_CLASS_UNAVAILABLE && !killOutcomeStopsServer(outcome)) {
    noteOldLifeWaitAnswer(target, record, outcome.error, OLD_LIFE_WAIT_AT_KILL, outcome.errorClass)
  }
  return outcome
}

/** Who reads, in the own-row lines of an old-life wait's `get`s of a configured persona's own row (b.jg5 SRJ-114, SRJ-811). */
const OLD_LIFE_WAIT_GET_WHAT = 'get'

/** Who reads, in the own-row lines of an old-life wait's kill's between-try `status` reads (b.jg5 SRJ-115, SRJ-811). */
const OLD_LIFE_WAIT_STATUS_WHAT = 'status read between kill tries'

/** The tmux session a `get` row names, when it is a non-empty string. */
function rowSessionName(row: unknown): string | undefined {
  try {
    const session = (row as { tmux_session_name?: unknown }).tmux_session_name
    return typeof session === 'string' && session !== '' ? session : undefined
  } catch {
    return undefined
  }
}

/**
 * One `get` of the wait's old row (b.jg5 SRJ-811), as the sequence takes it.
 * A configured persona's own row: the shared own-row read
 * (`readPersonaOwnRow`), its UNUSABLE NAME answer routed per SRJ-1002 (no
 * latch; a failed read). Any other id: one plain `get` under the old key,
 * arming nothing, that applies no row-read rule, its answer given to the
 * old-life read entry (`noteOldLifeRowRead`). A failed read's class is
 * recorded (`noteOldLifeWaitAnswer`). Never throws.
 */
async function readOldLifeRow(target: OldLifeWaitTarget, record: OldLifeWaitRecord, ref: string): Promise<LiveRowSequenceRead> {
  const { instanceId, oldKey } = target
  if (isConfiguredOwnRow(target)) {
    const read = await readPersonaOwnRow(oldKey, {
      site: OLD_LIFE_WAIT_SITE,
      what: OLD_LIFE_WAIT_GET_WHAT,
      ref,
      unusableNameRoutedIn: OLD_LIFE_WAIT_ROUTED_CONTEXT,
    })
    switch (read.kind) {
      case OWN_ROW_READ_ROW:
        record.session = rowSessionName(read.row) ?? record.session
        clearOldLifeWaitConfigOutage(target)
        return read.latched ? { kind: LIVE_ROW_READ_LATCHED } : { kind: LIVE_ROW_READ_ROW, row: read.row as Phase1GetResult }
      case OWN_ROW_READ_ABSENT:
        return { kind: LIVE_ROW_READ_ABSENT }
      case OWN_ROW_READ_LATCHED:
        return { kind: LIVE_ROW_READ_LATCHED }
      case OWN_ROW_READ_REFUSED:
        noteOldLifeWaitAnswer(target, record, read.error, OLD_LIFE_WAIT_AT_GET)
        return { kind: LIVE_ROW_READ_REFUSED, error: read.error }
    }
  }
  try {
    const row = await withOutageDetection(oldKey, undefined, 'get', (client) => client.get({ claude_instance_id: instanceId }), oldLifeWaitCallOptions(target))
    clearOldLifeWaitConfigOutage(target)
    record.session = rowSessionName(row) ?? record.session
    // b.jg5 SRJ-809: a row read `ended` or `missing` ends the hold; a live one's `cwd` becomes the held directory.
    noteOldLifeRowRead(instanceId, { kind: OLD_LIFE_ROW_READ_STATE, state: row.state, cwd: row.cwd }, `${OLD_LIFE_WAIT_SITE}: ${OLD_LIFE_WAIT_GET_WHAT}`)
    return { kind: LIVE_ROW_READ_ROW, row: row as Phase1GetResult }
  } catch (err) {
    if (hasAdErrorName(err, ERR_SPAWN_NOT_FOUND_NAME)) {
      noteOldLifeRowRead(instanceId, { kind: OLD_LIFE_ROW_READ_NO_ROW }, `${OLD_LIFE_WAIT_SITE}: ${OLD_LIFE_WAIT_GET_WHAT}`)
      return { kind: LIVE_ROW_READ_ABSENT }
    }
    noteOldLifeWaitAnswer(target, record, err, OLD_LIFE_WAIT_AT_GET)
    return { kind: LIVE_ROW_READ_REFUSED, error: err }
  }
}

/**
 * One `status` read of the wait's old row between its kill's tries (b.jg5
 * SRJ-702, SRJ-811), through `withOutageDetection` under the old key arming
 * nothing. A configured persona's own row: the own-row `status` step
 * (`applyOwnRowStatusStep`: the episode end, the old-life read entry, the
 * entry clear and SRJ-513's latch of its own `pending` row with no launch
 * start), but an UNUSABLE NAME answer is routed per SRJ-1002 and latches
 * nothing (one line). Any other id: the answer goes to the old-life read
 * entry only. A failed read's class is recorded (`noteOldLifeWaitAnswer`).
 * Never throws.
 */
async function readOldLifeKillRow(target: OldLifeWaitTarget, record: OldLifeWaitRecord, ref: string): Promise<KillRetryRead> {
  const { instanceId, oldKey } = target
  const own = isConfiguredOwnRow(target)
  const at: OwnRowReadSite = { site: OLD_LIFE_WAIT_SITE, what: OLD_LIFE_WAIT_STATUS_WHAT, ref }
  let result: Phase1StatusResult
  try {
    result = await withOutageDetection(oldKey, undefined, 'status', (client) => client.status({ claude_instance_id: instanceId }), oldLifeWaitCallOptions(target))
    clearOldLifeWaitConfigOutage(target)
  } catch (err) {
    if (hasAdErrorName(err, ERR_SPAWN_NOT_FOUND_NAME)) {
      if (own) applyOwnRowStatusStep(oldKey, { thrown: err }, at)
      else noteOldLifeRowRead(instanceId, { kind: OLD_LIFE_ROW_READ_NO_ROW }, oldLifeReadName(at))
      return { kind: KILL_RETRY_READ_NO_ROW }
    }
    if (own && isUnusableNameError(err)) {
      // b.jg5 SRJ-512, SRJ-1002: met in an old-life wait, routed, so nothing latches.
      logUnusableNameRouted(oldKey, at, OLD_LIFE_WAIT_ROUTED_CONTEXT, err)
    } else if (own) {
      applyOwnRowStatusStep(oldKey, { thrown: err }, at)
    }
    noteOldLifeWaitAnswer(target, record, err, OLD_LIFE_WAIT_AT_STATUS_READ)
    return { kind: KILL_RETRY_READ_FAILED, error: err }
  }
  if (own) {
    if (applyOwnRowStatusStep(oldKey, { result }, at)) return { kind: KILL_RETRY_READ_LATCHED }
    return { kind: KILL_RETRY_READ_STATE, state: result.state }
  }
  noteOldLifeRowRead(instanceId, { kind: OLD_LIFE_ROW_READ_STATE, state: result.state }, oldLifeReadName(at))
  return { kind: KILL_RETRY_READ_STATE, state: result.state }
}

/**
 * Raise the kill-failure alert a wait's kill decided (b.jg5 SRJ-704,
 * SRJ-1007, SRJ-811): through the kill-failure alerts (`alerts`, the
 * installed ones by default) with the context `old-life wait`, which always
 * takes the not-configured, log-only route (a server-log line and a
 * `persona-kill-failed` or `persona-kill-survivor` entry, nothing to Slack),
 * naming the old row's instance id and its session; the entry names the
 * wait's reference (`oldLifeWaitRef`: `persona=<old key>` for a
 * `cscb_<old key>` row, `instanceId=<id>` for an id standing in), as the
 * wait's other entries do. A kill whose tries a stop ended (a shutdown,
 * or the last waiter's teardown; b.jg5 SRJ-702) raises neither version: one
 * line quoting the latest survivor-naming description and the same
 * reference's `persona-kill-failed` entry with no alert text, whatever the decision (an
 * ordinary decision with no description when the tries decided none), with
 * the wait's stop cause (`oldLifeWaitStopCause`). A kill whose tries the
 * latch of the configured persona whose own row the wait is on stopped is
 * that persona's stop: the same line, with the latch's cause
 * (`OLD_LIFE_WAIT_STOP_CAUSE_LATCHED`), and no entry (SRJ-702: a configured
 * persona's stop writes the log line only). A survivor version after the
 * hold's end is raised as for any success. With no alerts installed, one
 * line instead. Never throws.
 */
function raiseOldLifeWaitKillAlert(
  target: OldLifeWaitTarget,
  record: OldLifeWaitRecord,
  retried: KillRetryResult,
  ref: string,
  stopCause: string | undefined,
  alerts: KillFailureAlerts | undefined = killFailureAlerts,
): void {
  try {
    const stopsServer = killOutcomeStopsServer(retried.outcome)
    const stopped = stopsServer || retried.end === KILL_RETRY_END_STOPPED
    if (!stopped && retried.alert.kind === KILL_RETRY_ALERT_NONE) return
    const decision: KillRetryAlert = stopped && retried.alert.kind === KILL_RETRY_ALERT_NONE ? { kind: KILL_RETRY_ALERT_ORDINARY } : retried.alert
    if (alerts === undefined) {
      console.error(
        `${OLD_LIFE_WAIT_LOG_PREFIX} ${ref}: the kill-failure alert's ${decision.kind} version is not raised — no kill-failure alerts are installed; ${describeKillFailureDescriptions(decision)} (b.jg5 SRJ-704, SRJ-811)`,
      )
      return
    }
    const { outcome } = retried
    const cause = stopsServer ? PERSONA_KILL_STOP_CAUSE_RECHECK : oldLifeWaitStopCause(stopCause)
    // SRJ-702: a configured persona's stop writes the log line only: the
    // latch of the configured persona whose own row the wait is on.
    const lineOnly = cause === OLD_LIFE_WAIT_STOP_CAUSE_LATCHED && isConfiguredOwnRow(target)
    const stop = stopped
      ? {
          stopped: true,
          lastOutcomeClass: outcome.kind === KILL_OUTCOME_NOT_KILLED ? outcome.errorClass : outcome.kind,
          stopCause: cause,
          ...(lineOnly ? { lineOnly: true } : {}),
        }
      : {}
    alerts.raise({
      key: target.oldKey,
      decision,
      latched: false,
      context: KILL_FAILURE_CONTEXT_OLD_LIFE_WAIT,
      session: oldLifeWaitSession(target, record),
      instanceId: target.instanceId,
      ref: oldLifeWaitRef(target.instanceId, target.oldKey),
      ...stop,
    })
  } catch (err) {
    console.error(`${OLD_LIFE_WAIT_LOG_PREFIX} ${ref}: raising the kill-failure alert failed: ${describeThrownValue(err)}`)
  }
}

/**
 * Step 5's kill-failure alert in a wait (b.jg5 SRJ-705, SRJ-704, SRJ-1007,
 * SRJ-811): the ordinary version with no description, context `old-life
 * wait`, on the not-configured, log-only route, naming the old row's
 * instance id and session, its entry the wait's reference
 * (`oldLifeWaitRef`). With no alerts installed, one line instead.
 * Never throws.
 */
function raiseOldLifeWaitEscalationAlert(
  target: OldLifeWaitTarget,
  record: OldLifeWaitRecord,
  ref: string,
  alerts: KillFailureAlerts | undefined = killFailureAlerts,
): void {
  try {
    if (alerts === undefined) {
      console.error(
        `${OLD_LIFE_WAIT_LOG_PREFIX} ${ref}: the kill-failure alert's ordinary version is not raised — no kill-failure alerts are installed (b.jg5 SRJ-704, SRJ-705, SRJ-811)`,
      )
      return
    }
    alerts.raise({
      key: target.oldKey,
      decision: { kind: KILL_RETRY_ALERT_ORDINARY },
      latched: false,
      context: KILL_FAILURE_CONTEXT_OLD_LIFE_WAIT,
      session: oldLifeWaitSession(target, record),
      instanceId: target.instanceId,
      ref: oldLifeWaitRef(target.instanceId, target.oldKey),
    })
  } catch (err) {
    console.error(`${OLD_LIFE_WAIT_LOG_PREFIX} ${ref}: raising the kill-failure alert failed: ${describeThrownValue(err)}`)
  }
}

/** The ensure entry's answer when no hold is on the instance id: nothing was started. */
export const OLD_LIFE_WAIT_START_NOT_HELD = 'not-held'

/** What `ensureOldLifeWait` answers: the registry's answer, that nothing is installed, or that no hold is on the id. */
export type OldLifeWaitEnsureAnswer =
  | LiveRowSequenceStartAnswer
  | typeof LIVE_ROW_START_NOT_INSTALLED
  | typeof OLD_LIFE_WAIT_START_NOT_HELD

/**
 * Make sure the hold on `instanceId` has its wait running (b.jg5 SRJ-811,
 * SRJ-1512): when the installed hold set holds the id, start, through the
 * installed live-row sequence registry, the sequence's no-launch form on it:
 * its key the hold's old key (or the instance id standing in), seeded with
 * the state last read of the row (`live, unread` when none), entry at step
 * 1, no conversation kept, no launch, alert context `old-life wait`, with
 * the wait's own dependencies (`buildOldLifeWaitDeps`) and its end handler
 * (`handleOldLifeWaitEnd`). Answers the registry's answer (`started`;
 * `already-running` when a wait or a live-row sequence runs on the id, so
 * one wait runs per held instance id and never at once with a sequence on
 * it; `closed` after the registry's close), `not-held` with one line when no
 * hold is on the id, or `not-installed` with one line when no registry or
 * no wait bindings are installed. Never blocks on the wait; never throws. A
 * wait is started only through this entry; the hold step
 * (`oldLifeHoldStep`) calls it for each hold that holds a launch back.
 *
 *   [slack] old-life-wait: instanceId=<id>: no old-life hold is on it — no wait started (b.jg5 SRJ-811)
 *   [slack] old-life-wait: instanceId=<id>: no sequence registry or wait bindings are installed — no wait started (b.jg5 SRJ-811)
 */
export function ensureOldLifeWait(instanceId: string): OldLifeWaitEnsureAnswer {
  const holds = oldLifeHolds
  let hold: OldLifeHold | undefined
  try {
    hold = holds?.holdOf(instanceId)
  } catch {
    hold = undefined
  }
  if (hold === undefined) {
    console.error(oldLifeWaitNotStartedLine(instanceId, OLD_LIFE_WAIT_START_NOT_HELD))
    return OLD_LIFE_WAIT_START_NOT_HELD
  }
  const registry = liveRowSequenceRegistry
  const bindings = oldLifeWaitBindings
  if (registry === undefined || bindings === undefined) {
    console.error(oldLifeWaitNotStartedLine(instanceId, LIVE_ROW_START_NOT_INSTALLED))
    return LIVE_ROW_START_NOT_INSTALLED
  }
  const target: OldLifeWaitTarget = { instanceId, oldKey: hold.oldKey }
  const record = createOldLifeWaitRecord()
  const request: LiveRowSequenceRequest = {
    key: hold.oldKey,
    ref: oldLifeWaitRef(instanceId, hold.oldKey),
    instanceId,
    lastReadState: oldLifeLastReadState.get(instanceId) ?? OLD_LIFE_WAIT_SEED_LIVE_UNREAD,
    entryStep: LIVE_ROW_SEQUENCE_ENTRY_KILL,
    keepsConversation: false,
    retiredKey: false,
    launches: false,
    alertContext: KILL_FAILURE_CONTEXT_OLD_LIFE_WAIT,
  }
  return registry.start(request, {
    deps: buildOldLifeWaitDeps({
      target,
      record,
      clock: bindings.clock,
      log: bindings.log,
      ...(bindings.killFailureAlerts === undefined ? {} : { killFailureAlerts: bindings.killFailureAlerts }),
    }),
    onSettled: (outcome) => handleOldLifeWaitEnd(target, record, outcome, bindings),
  })
}

/**
 * The ensure entry's line when it starts no wait (b.jg5 SRJ-811): no hold on
 * the id, or no registry or wait bindings installed:
 *
 *   [slack] old-life-wait: instanceId=<id>: no old-life hold is on it — no wait started (b.jg5 SRJ-811)
 *   [slack] old-life-wait: instanceId=<id>: no sequence registry or wait bindings are installed — no wait started (b.jg5 SRJ-811)
 *
 * Pure.
 */
export function oldLifeWaitNotStartedLine(
  instanceId: string,
  why: typeof OLD_LIFE_WAIT_START_NOT_HELD | typeof LIVE_ROW_START_NOT_INSTALLED,
): string {
  const what = why === OLD_LIFE_WAIT_START_NOT_HELD ? 'no old-life hold is on it' : 'no sequence registry or wait bindings are installed'
  return `${OLD_LIFE_WAIT_LOG_PREFIX} instanceId=${renderLogMessageText(instanceId)}: ${what} — no wait started (b.jg5 SRJ-811)`
}

/**
 * The no-launch form's end handler (b.jg5 SRJ-811, SRJ-812, SRJ-1002,
 * SRJ-1013): decides what follows the round (`decideOldLifeWaitEnd`,
 * `src/old-life-wait.ts`) and applies it:
 *   - each CONFLICT and UNUSABLE NAME answer met: one `persona-teardown-notice`
 *     entry through the startup-errors recorder (which writes the server-log
 *     line too), worded "during the wait"
 *     (`personaTeardownNoticeEntryText` with
 *     `PERSONA_TEARDOWN_NOTICE_DURING_WAIT`), naming the old key or the
 *     instance id standing in, with the kill outcome's one-line rendering
 *     (`oldLifeWaitRefusalNoticeText`); nothing latches;
 *   - the round's first UNCLASSIFIED answer, when the hold goes on: reported
 *     to the wait's unclassified-error episode on the held instance id
 *     (`OldLifeWaitBindings.unclassifiedErrorEpisodes`): the round that begins the
 *     episode writes nothing, the first round met longer than the alert
 *     threshold after it writes its one `persona-unclassified-error` entry
 *     on the log-only route, and later rounds write none;
 *   - the kill-failed mark on the hold (SRJ-812), when the round's kill
 *     decided the ordinary alert unstopped, or at step 5;
 *   - each waiting persona's retry timer armed with
 *     `UNAVAILABLE_RETRY_CAUSE_OLD_LIFE_HOLD`, uncounted, when the hold goes
 *     on; never the old key's (SRJ-1512), and never a latched persona's, a
 *     persona's held on `ErrInvalidFlags` or a persona's not up
 *     (`armOldLifeWaiter`; SRJ-305);
 * then one end line (`oldLifeWaitEndLine`). Nothing reaches Slack. Never throws.
 */
function handleOldLifeWaitEnd(
  target: OldLifeWaitTarget,
  record: OldLifeWaitRecord,
  outcome: LiveRowSequenceOutcome,
  bindings: OldLifeWaitBindings,
): void {
  try {
    const holds = oldLifeHolds
    const decision = decideOldLifeWaitEnd({ outcome, answers: record, holdEnded: holds === undefined || holds.holdOf(target.instanceId) === undefined })
    const write = bindings.recordStartupError ?? recordStartupError
    const ref = oldLifeWaitRef(target.instanceId, target.oldKey)
    for (const refusal of decision.notices) {
      write(
        PERSONA_TEARDOWN_NOTICE_LABEL,
        personaTeardownNoticeEntryText(ref, oldLifeWaitRefusalNoticeText(target.instanceId, refusal), PERSONA_TEARDOWN_NOTICE_DURING_WAIT),
      )
    }
    if (decision.reportUnclassified) {
      // SRJ-313: one report per round to the old row's episode, keyed by the held instance id.
      if (bindings.unclassifiedErrorEpisodes === undefined) console.error(oldLifeWaitUnclassifiedNotReportedLine(ref))
      else bindings.unclassifiedErrorEpisodes.report(target.instanceId, record.unclassified)
    }
    if (decision.markKillFailed && holds !== undefined) holds.markKillFailed(target.instanceId)
    const armed: string[] = []
    if (decision.armWaiting) {
      for (const persona of oldLifeWaitingPersonas(target.instanceId, bindings)) {
        if (armOldLifeWaiter(persona.key, bindings)) armed.push(persona.key)
      }
    }
    console.error(oldLifeWaitEndLine({ instanceId: target.instanceId, oldKey: target.oldKey, decision, armed }))
  } catch (err) {
    console.error(`${OLD_LIFE_WAIT_LOG_PREFIX} the end of the wait on instanceId=${target.instanceId} could not be handled: ${describeThrownValue(err)}`)
  }
}

/**
 * Arm persona `key`'s retry timer with the held-for-an-old-life cause
 * (`UNAVAILABLE_RETRY_CAUSE_OLD_LIFE_HOLD`; b.jg5 SRJ-811, SRJ-301), never
 * counted, through the installed bindings' arm. A key the bindings'
 * configuration shows outside the applied set is never armed (b.jg5
 * SRJ-1512, b.av2 SR-8.6: no retry timer for the old key), and neither is a
 * latched persona (`personaLatchedNow`; b.jg5 SRJ-305: the latch stops the
 * timer, whatever the case; SRJ-301: a sequence stopped by P's latch arms
 * nothing), a persona held on `ErrInvalidFlags` (`heldGateReadingOf`; a
 * held query that throws counts as held) or a persona not up
 * (`personaUpNow`; SRJ-305: the timer stays stopped while P is held or not
 * up, its bring-up owning a persona not up), so a wait's round that a
 * configured persona's own-row latch ended arms only the waiting personas
 * that are not latched. One line each:
 *
 *   [slack] old-life-wait: persona=<key>: not in the applied configuration — no retry timer armed (b.jg5 SRJ-1512, b.av2 SR-8.6)
 *   [slack] old-life-wait: persona=<key>: latched — no retry timer armed (b.jg5 SRJ-305, SRJ-502)
 *   [slack] old-life-wait: persona=<key>: held on ErrInvalidFlags — no retry timer armed (b.jg5 SRJ-305, SRJ-207)
 *   [slack] old-life-wait: persona=<key>: not up — no retry timer armed; its bring-up owns it (b.jg5 SRJ-305)
 *
 * Answers whether it was armed. Never throws.
 */
function armOldLifeWaiter(key: string, bindings: OldLifeWaitBindings | undefined = oldLifeWaitBindings): boolean {
  if (bindings === undefined) return false
  if (isKnownUnapplied(key, bindings)) {
    console.error(oldLifeWaitNotAppliedLine(key))
    return false
  }
  if (personaLatchedNow(key)) {
    console.error(oldLifeWaitLatchedLine(key))
    return false
  }
  if (heldGateReadingOf(key) !== undefined) {
    console.error(oldLifeWaitHeldLine(key))
    return false
  }
  if (!personaUpNow(key)) {
    console.error(oldLifeWaitNotUpLine(key))
    return false
  }
  try {
    return bindings.retryArm.arm(key, { kind: OLD_LIFE_HOLD_ARM_CAUSE_LABEL }) === true
  } catch (err) {
    console.error(`${OLD_LIFE_WAIT_LOG_PREFIX} persona=${key}: arming the retry timer failed: ${describeThrownValue(err)}`)
    return false
  }
}

/**
 * The line of a waiting persona's key the applied configuration does not
 * hold, so no retry timer is armed for it (`armOldLifeWaiter`; b.jg5
 * SRJ-1512, b.av2 SR-8.6):
 *
 *   [slack] old-life-wait: persona=<key>: not in the applied configuration — no retry timer armed (b.jg5 SRJ-1512, b.av2 SR-8.6)
 *
 * Pure.
 */
export function oldLifeWaitNotAppliedLine(key: string): string {
  return `${OLD_LIFE_WAIT_LOG_PREFIX} persona=${key}: not in the applied configuration — no retry timer armed (b.jg5 SRJ-1512, b.av2 SR-8.6)`
}

/**
 * The line of a waiting persona that is latched, so no retry timer is armed
 * for it (`armOldLifeWaiter`; b.jg5 SRJ-305, SRJ-502):
 *
 *   [slack] old-life-wait: persona=<key>: latched — no retry timer armed (b.jg5 SRJ-305, SRJ-502)
 *
 * Pure.
 */
export function oldLifeWaitLatchedLine(key: string): string {
  return `${OLD_LIFE_WAIT_LOG_PREFIX} persona=${key}: latched — no retry timer armed (b.jg5 SRJ-305, SRJ-502)`
}

/**
 * The line of a waiting persona held on `ErrInvalidFlags`, so no retry timer
 * is armed for it (`armOldLifeWaiter`; b.jg5 SRJ-305, SRJ-207):
 *
 *   [slack] old-life-wait: persona=<key>: held on ErrInvalidFlags — no retry timer armed (b.jg5 SRJ-305, SRJ-207)
 *
 * Pure.
 */
export function oldLifeWaitHeldLine(key: string): string {
  return `${OLD_LIFE_WAIT_LOG_PREFIX} persona=${key}: held on ErrInvalidFlags — no retry timer armed (b.jg5 SRJ-305, SRJ-207)`
}

/**
 * The line of a waiting persona that is not up, so no retry timer is armed
 * for it; its bring-up owns it (`armOldLifeWaiter`; b.jg5 SRJ-305):
 *
 *   [slack] old-life-wait: persona=<key>: not up — no retry timer armed; its bring-up owns it (b.jg5 SRJ-305)
 *
 * Pure.
 */
export function oldLifeWaitNotUpLine(key: string): string {
  return `${OLD_LIFE_WAIT_LOG_PREFIX} persona=${key}: not up — no retry timer armed; its bring-up owns it (b.jg5 SRJ-305)`
}

/**
 * Whether persona `key` is up now, as the server's keep-going query tells
 * (`PersonaKillKeepGoingQuery.isPersonaUp`: serving, its bring-up `up`, its
 * key applied; b.jg5 SRJ-305). With no query installed, up (nothing tells
 * otherwise); a query that throws counts as not up. Never throws.
 */
function personaUpNow(key: string): boolean {
  const query = personaKillKeepGoingQuery
  if (query === undefined) return true
  try {
    return query.isPersonaUp(key) === true
  } catch {
    return false
  }
}

/** The wait's arm cause, held to the retry controller's label by its type (the same string). */
const OLD_LIFE_HOLD_ARM_CAUSE_LABEL: typeof OLD_LIFE_WAIT_ARM_CAUSE = UNAVAILABLE_RETRY_CAUSE_OLD_LIFE_HOLD

/**
 * Whether an old-life wait step runs for a hold persona `key` waits on
 * (b.jg5 SRJ-811, SRJ-303; the glossary's "in flight for P"): the hold set's
 * waits-on query over the applied persona (its working directory, its own
 * `cscb_<key>`), each hold's instance id asked of the registry's no-launch
 * query. False with no hold set, registry or bindings installed, or for a
 * key not applied. Never throws.
 */
export function isOldLifeWaitRunningFor(key: string): boolean {
  const holds = oldLifeHolds
  const registry = liveRowSequenceRegistry
  if (holds === undefined || registry === undefined) return false
  const persona = oldLifeAppliedPersona(key)
  if (persona === undefined) return false
  try {
    return holds.holdsWaitedOnBy(persona).some((hold) => registry.isNoLaunchRunning(hold.instanceId))
  } catch {
    return false
  }
}

/**
 * Whether persona `key` waits on an old-life hold whose kill is marked failed
 * (b.jg5 SRJ-812, SRJ-1011 state 4): the hold set's `waitsOnKillFailed` over
 * the applied persona. The mark lasts until the hold ends. False with no hold
 * set or bindings installed, or for a key not applied. Never throws.
 */
export function waitsOnKillFailedHold(key: string): boolean {
  const holds = oldLifeHolds
  if (holds === undefined) return false
  const persona = oldLifeAppliedPersona(key)
  if (persona === undefined) return false
  try {
    return holds.waitsOnKillFailed(persona) === true
  } catch {
    return false
  }
}

/**
 * Whether persona `key`'s own row (`cscb_<key>`) is held for an old life
 * (b.jg5 SRJ-809, SRJ-810): the installed hold set holds that instance id. A
 * destructive modify's same-key old life and a row the start sweep swept for
 * its `cwd` whose kill did not succeed are such rows. False with no hold set
 * installed. Makes no agent-director call; never throws.
 */
export function isOwnRowOldLifeHeld(key: string): boolean {
  const holds = oldLifeHolds
  if (holds === undefined) return false
  try {
    return holds.holdOf(personaInstanceId(key)) !== undefined
  } catch {
    return false
  }
}

/**
 * The held-directory query of session admission (b.jg5 SRJ-810, SRJ-1505;
 * `SessionAdmissionOptions.heldDirectory`, `src/registry.ts`): every hold of
 * the installed hold set whose directory is `path` by real path, as the held
 * directory (the first hold's real path) and every held old instance id, in
 * begin order; undefined when none is, or with no hold set installed (before
 * `main()` has built it). A hold-set read that throws is passed on, so the
 * admission counts it as held. Makes no agent-director call.
 */
export function oldLifeHeldDirectory(path: string): SessionHeldDirectory | undefined {
  const holds = oldLifeHolds
  if (holds === undefined) return undefined
  const held = holds.holdsOnDirectory(path)
  if (held.length === 0) return undefined
  return { directory: held[0]!.realDirectory, instanceIds: held.map((hold) => hold.instanceId) }
}

/**
 * "A live-row sequence or an old-life wait step runs for P" (b.jg5 SRJ-1011,
 * SRJ-812; E15's sequence/wait input): `isLiveRowSequenceRunning` or
 * `isOldLifeWaitRunningFor`. Never throws.
 */
export function isSequenceOrOldLifeWaitRunning(key: string): boolean {
  return isLiveRowSequenceRunning(key) || isOldLifeWaitRunningFor(key)
}

/**
 * Which work in flight blocks a retry of persona `key`'s timer (b.jg5
 * SRJ-303), first that holds: a launch call (`isLaunchInFlight`); an
 * old-life wait on its own `cscb_<key>`; its live-row sequence
 * (`isLiveRowSequenceRunning`); an old-life wait step for a hold it waits on
 * (`isOldLifeWaitRunningFor`). Undefined when none does. The server's
 * "blocks a retry" is true exactly when this answers a cause. Never throws.
 */
export function personaRetryBlockCause(key: string): RetryBlockCause | undefined {
  return retryBlockCauseOf(key, false)
}

/**
 * The one list of "blocks a retry" causes (b.jg5 SRJ-303), in order, behind
 * `personaRetryBlockCause` and the pending-row rule's gate
 * (`buildPendingRowRuleDeps`): `exceptOwnLaunch` (the collision ladder's
 * `pending` step, inside the launch it belongs to, before any launch call of
 * its own) leaves the launch call in flight out and asks the other causes.
 * Never throws.
 */
function retryBlockCauseOf(key: string, exceptOwnLaunch: boolean): RetryBlockCause | undefined {
  if (!exceptOwnLaunch && isLaunchInFlight(key)) return RETRY_BLOCK_LAUNCH
  if (liveRowSequenceRegistry?.isNoLaunchRunning(personaInstanceId(key)) === true) return RETRY_BLOCK_OLD_LIFE_WAIT
  if (isLiveRowSequenceRunning(key)) return RETRY_BLOCK_LIVE_ROW_SEQUENCE
  if (isOldLifeWaitRunningFor(key)) return RETRY_BLOCK_OLD_LIFE_WAIT
  return undefined
}

/**
 * The live-row sequence gate for persona `key` at `site`, as the restart
 * path asks it (b.jg5 SRJ-706, SRJ-811): `isLiveRowSequenceRunning(key)`;
 * when what runs on its own `cscb_<key>` is an old-life wait, which launches
 * no one, the persona is recorded as waiting on that hold and its retry
 * timer is armed with the held-for-an-old-life cause too
 * (`oldLifeWaitRefusal`), so the persona is retried once the wait is over. For a key outside the applied set whose own row's old-life wait
 * runs (the wait on a removed key's row, b.jg5 SRJ-1512) the gate answers
 * false with nothing armed, so the restart path's not-up gate (the relaunch
 * gate, b.av2 SR-8.6) answers for the key. Never throws.
 */
export function liveRowSequenceGate(key: string, site: string): boolean {
  if (!isLiveRowSequenceRunning(key)) return false
  if (isKnownUnapplied(key) && liveRowSequenceRegistry?.isNoLaunchRunning(personaInstanceId(key)) === true) return false
  oldLifeWaitRefusal(key, keyRef(key), site)
  return true
}

/**
 * When an old-life wait runs on persona `key`'s own `cscb_<key>` (b.jg5
 * SRJ-811 bullet 2, SRJ-810): record the persona as waiting on that hold
 * (`recordOwnRowWaiting`), so the hold's end retries it at once and its
 * teardown forgets it there; arm its retry timer with the
 * held-for-an-old-life cause (`armOldLifeWaiter`), log one line and answer
 * true; otherwise false, with nothing done. Never throws.
 *
 *   [slack] <site>: <ref> waits on the old-life wait running on its own row — its retry timer is armed (held-for-old-life) (sequence-waiting; b.jg5 SRJ-811)
 */
function oldLifeWaitRefusal(key: string, ref: string, site: string): boolean {
  if (liveRowSequenceRegistry?.isNoLaunchRunning(personaInstanceId(key)) !== true) return false
  recordOwnRowWaiting(key)
  console.error(oldLifeWaitRefusalLine(site, ref, armOldLifeWaiter(key)))
  return true
}

/**
 * Record persona `key` as waiting on the hold on its own `cscb_<key>`
 * (b.jg5 SRJ-810; `OldLifeHoldSet.recordWaiting`), as the hold step records
 * a persona on a hold on its working directory: the hold's end then retries
 * it (`createOldLifeHoldEndRetry`), and its teardown forgets it there and
 * stops the wait when no persona left waits on the hold
 * (`forgetOldLifeWaits`). A key the installed bindings' configuration shows
 * outside the applied set is not recorded (b.jg5 SRJ-1512), nor anything
 * with no hold set installed or no hold on that id. Never throws.
 */
function recordOwnRowWaiting(key: string): void {
  const holds = oldLifeHolds
  if (holds === undefined || isKnownUnapplied(key)) return
  try {
    holds.recordWaiting(personaInstanceId(key), key)
  } catch {
    // Not reached (the hold set never throws).
  }
}

/**
 * The line of a launch refused because an old-life wait runs on the
 * persona's own row (b.jg5 SRJ-811; `armed`: whether its retry timer was
 * armed):
 *
 *   [slack] <site>: <ref> waits on the old-life wait running on its own row — its retry timer is armed (held-for-old-life) (sequence-waiting; b.jg5 SRJ-811)
 *   [slack] <site>: <ref> waits on the old-life wait running on its own row — its retry timer could not be armed (sequence-waiting; b.jg5 SRJ-811)
 *
 * Pure.
 */
export function oldLifeWaitRefusalLine(site: string, ref: string, armed: boolean): string {
  const timer = armed ? `its retry timer is armed (${UNAVAILABLE_RETRY_CAUSE_OLD_LIFE_HOLD})` : 'its retry timer could not be armed'
  return `[slack] ${site}: ${ref} waits on the old-life wait running on its own row — ${timer} (sequence-waiting; b.jg5 SRJ-811)`
}

// ---------------------------------------------------------------------------
// reconcileOrphans — the start sweep (b.av2 SR-6.3; b.jg5 SRJ-714, SRJ-1506)
// ---------------------------------------------------------------------------

/**
 * What the start sweep did, in b.jg5 SRJ-714's summary counts. Every listed
 * row is counted once, so `listed` is `killed + kept + leftForLatch`; no row
 * is ever deleted.
 */
export interface OrphanReconcileResult {
  /** Rows the sweep's one `list` returned. */
  listed: number
  /**
   * Rows whose kill's success stands: any `kill_sent`, `ErrSpawnNotFound`,
   * GONE, or a `status` read between tries that found the row finished, a
   * success after a survivor-naming failure included (b.jg5 SRJ-702).
   */
  killed: number
  /**
   * Listed rows neither killed nor left for a latch: finished rows (never
   * killed), rows that match their persona, rows whose directory check is
   * deferred, rows whose kill did not succeed (`killFailed`), and rows a
   * shutdown or a version re-check's stop left unreached.
   */
  kept: number
  /** Of `kept`, the rows given a kill that did not succeed, a kill whose tries a shutdown stopped included. */
  killFailed: number
  /**
   * Keys recorded as retired with the cause `absent-at-start`, in the sweep's
   * one batch record (`recordAbsentPersonaKeys`; b.jg5 SRJ-714, SRJ-803):
   * every key the batch named, an already-recorded key and those held only
   * in memory after a failed write included (hatch A3). 0 with no store
   * installed.
   */
  recordedAsRetired: number
  /**
   * Listed rows left unkilled because their persona latched in the sweep, or
   * was latched when it ran (`latchFromListedRows`; b.jg5 SRJ-502, SRJ-714):
   * each such persona's own row and every row labelled with it, in any state.
   */
  leftForLatch: number
}

/** A start sweep that did nothing (dry run, or a failed list). */
function emptySweepResult(): OrphanReconcileResult {
  return { listed: 0, killed: 0, kept: 0, killFailed: 0, recordedAsRetired: 0, leftForLatch: 0 }
}

/**
 * The start sweep's one summary line (b.jg5 SRJ-714), the last line of every
 * sweep that listed its rows, a sweep a shutdown stopped included:
 *
 *   [slack] reconcileOrphans: summary — listed=<n> killed=<n> kept=<n> (kill-failed=<n>) recorded-as-retired=<n> left-unkilled-for-latch=<n> (b.jg5 SRJ-714)
 *
 * Pure.
 */
export function startSweepSummaryLine(result: Readonly<OrphanReconcileResult>): string {
  return (
    `[slack] reconcileOrphans: summary — listed=${result.listed} killed=${result.killed} kept=${result.kept} ` +
    `(kill-failed=${result.killFailed}) recorded-as-retired=${result.recordedAsRetired} ` +
    `left-unkilled-for-latch=${result.leftForLatch} (b.jg5 SRJ-714)`
  )
}

/** A listed row the sweep left as it was because its persona latched (b.jg5 SRJ-502, SRJ-714). */
const SWEEP_ROW_LEFT_FOR_LATCH = 'left-for-latch'
/** A listed row given no kill and kept: finished, matching its persona, directory-deferred, or not reached after a stop. */
const SWEEP_ROW_KEPT = 'kept'
/** A listed row whose kill's success stands. */
const SWEEP_ROW_KILLED = 'killed'
/** A listed row given a kill that did not succeed: kept. */
const SWEEP_ROW_KILL_FAILED = 'kill-failed'

/** What the start sweep did with one listed row. */
type SweepRowDisposition =
  | typeof SWEEP_ROW_LEFT_FOR_LATCH
  | typeof SWEEP_ROW_KEPT
  | typeof SWEEP_ROW_KILLED
  | typeof SWEEP_ROW_KILL_FAILED

/**
 * One listed row as the start sweep handled it: the row as listed (its
 * state, `cwd`, labels and session), what the sweep did with it, and, for a
 * row given a kill, the bounded retry's result (the outcome that stands, how
 * the tries ended and the alert decision). The sweep keeps one per listed
 * row, in list order; its counts and its post-kill findMissing run are taken
 * from them.
 */
interface SweepRowRecord {
  readonly row: ListRow
  readonly disposition: SweepRowDisposition
  readonly kill?: KillRetryResult
}

/** The sweep's counts over its per-row records (`listed` = every record). Pure. */
function sweepResultOf(records: readonly SweepRowRecord[], recordedAsRetired: number): OrphanReconcileResult {
  const result = emptySweepResult()
  result.listed = records.length
  result.recordedAsRetired = recordedAsRetired
  for (const { disposition } of records) {
    if (disposition === SWEEP_ROW_LEFT_FOR_LATCH) result.leftForLatch++
    else if (disposition === SWEEP_ROW_KILLED) result.killed++
    else {
      result.kept++
      if (disposition === SWEEP_ROW_KILL_FAILED) result.killFailed++
    }
  }
  return result
}

/**
 * What the start sweep does with a row that has a `persona` label (b.av2
 * SR-6.3, SR-6.4, amended by b.jg5 SRJ-1506; b.jg5 SRJ-714): `sweep` it with
 * a reason, `keep` it, or keep it with its `cwd` check `deferred` to the
 * persona's launch. A row is kept only when its label names an applied
 * persona, its instance ID is that persona's `cscb_<key>`, and its `cwd`
 * matches the persona's working directory by real path. When that working
 * directory cannot be resolved to a real path (a directory-broken persona)
 * and the row's `cwd` has no real path either or equals the configured path
 * lexically (`cwdCheckDeferred`), the `cwd` condition cannot be evaluated and
 * is deferred; the other conditions still apply. A row whose `cwd` resolves
 * to an existing directory is swept as `wrong cwd`. A swept row is killed
 * with the result checked only when it is listed live, a finished one is
 * never killed, and no swept row is deleted (`killStartSweepRow`). A row
 * with no `persona` label never gets here: it is a pre-persona row, killed
 * when live and kept the same way.
 */
function sweepDecision(
  row: ListRow,
  persona: Persona | undefined,
  home: string,
): { action: 'sweep'; reason: string } | { action: 'keep' } | { action: 'deferred'; persona: Persona } {
  if (!persona) return { action: 'sweep', reason: 'absent persona' }
  if (row.claude_instance_id !== personaInstanceId(persona.key)) return { action: 'sweep', reason: 'wrong instance ID' }
  const comparison = compareRowToPersona(row, persona, home)
  if (comparison.cwdCheckDeferred) return { action: 'deferred', persona }
  if (!comparison.cwdMatches) return { action: 'sweep', reason: 'wrong cwd' }
  return { action: 'keep' }
}

/**
 * Which row a start-sweep kill is for, in its lines and its `orphan-cleanup`
 * entry: a swept row (`persona` is the persona reference when the persona is
 * applied, else the raw label value) or a pre-persona row (no `persona`
 * label; b.1ix), and the applied persona the row's label names
 * (`configuredKey`, undefined for an absent persona and a pre-persona row),
 * for whom an ENVIRONMENT or CONFIG answer raises its outage (b.jg5 SRJ-110;
 * hatch A3).
 */
interface StartSweepKillTarget {
  readonly persona?: string
  readonly configuredKey?: string
}

/** How a start-sweep kill's lines and entry name the row (`<what> instanceId=<id>[ persona=<persona>]`). */
function startSweepRowName(instanceId: string, persona: string | undefined): string {
  return persona === undefined ? `pre-persona row instanceId=${instanceId}` : `orphan instanceId=${instanceId} persona=${persona}`
}

/**
 * The start sweep's line for a kill of row `instanceId` (named `persona`;
 * none for a pre-persona row) whose success stands with `outcome`
 * (`killStartSweepRow`; b.jg5 SRJ-714), `<outcome>` being
 * `describeKillOutcome`'s rendering:
 *
 *   [slack] reconcileOrphans: kill succeeded for <row name> (<outcome>) — row kept
 *
 * Pure.
 */
export function startSweepKillSucceededLine(instanceId: string, persona: string | undefined, outcome: KillOutcome): string {
  return `${SWEEP_LOG_PREFIX}: kill succeeded for ${startSweepRowName(instanceId, persona)} (${describeKillOutcome(outcome)}) — row kept`
}

/** What the start sweep's swept-row line is built from (`startSweepSweepingRowLine`). */
export interface StartSweepSweepingRowLineInput {
  /** Why the row is swept: `absent persona`, `wrong instance ID` or `wrong cwd`. */
  readonly reason: string
  /** The persona reference when the persona is applied, else the row's `persona` label value. */
  readonly persona: string
  readonly instanceId: string
  readonly state: string
  /** The row's `cwd`, named for a row swept for it only. */
  readonly cwd?: string
  /** Whether the row is live, so it is killed; a finished row is never killed. */
  readonly live: boolean
}

/**
 * The start sweep's line for a swept row (b.jg5 SRJ-714): why it is swept
 * and whether it is killed; the row is kept either way:
 *
 *   [slack] reconcileOrphans: sweeping row (<reason>) persona=<persona> instanceId=<id> state=<state>[ cwd=<cwd>] — it is live, so it is killed; the row is kept (b.jg5 SRJ-714)
 *   [slack] reconcileOrphans: sweeping row (<reason>) persona=<persona> instanceId=<id> state=<state>[ cwd=<cwd>] — it is finished, so it is not killed (a finished row is never killed); the row is kept (b.jg5 SRJ-714)
 *
 * Pure.
 */
export function startSweepSweepingRowLine(input: StartSweepSweepingRowLineInput): string {
  const cwdDetail = input.cwd === undefined ? '' : ` cwd=${input.cwd}`
  const what = input.live
    ? 'it is live, so it is killed; the row is kept'
    : 'it is finished, so it is not killed (a finished row is never killed); the row is kept'
  return `${SWEEP_LOG_PREFIX}: sweeping row (${input.reason}) persona=${input.persona} instanceId=${input.instanceId} state=${input.state}${cwdDetail} — ${what} (b.jg5 SRJ-714)`
}

/** What a start-sweep kill's `orphan-cleanup` entry is built from (`startSweepKillFailedEntry`). */
export interface StartSweepKillFailedEntryInput {
  /** The row's instance id. */
  readonly instanceId: string
  /** The swept row's persona reference or label value; absent for a pre-persona row. */
  readonly persona?: string
  /** The state the sweep listed the row in. */
  readonly state: string
  /** The row's tmux session name as listed. */
  readonly session: string
  /** The outcome that stands, rendered (`describeKillOutcome`: its class, name and redacted description). */
  readonly outcome: string
  /** True when a shutdown stopped the kill's tries (b.jg5 SRJ-702, SRJ-714): no alert text follows. */
  readonly stoppedAtShutdown: boolean
}

/**
 * The text of a start-sweep kill's `orphan-cleanup` entry (b.jg5 SRJ-714,
 * SRJ-1013): the row, its listed state, its tmux session and the outcome
 * that stands with its class; for a kill whose tries a shutdown stopped, that
 * no kill-failure alert is raised:
 *
 *   kill did not succeed for <orphan instanceId=<id> persona=<persona>|pre-persona row instanceId=<id>> state=<state> tmux_session=<session>: <outcome>[; its tries were stopped because the server is shutting down, so no kill-failure alert is raised]; row kept, its session may still be running
 *
 * The sweep appends the kill-failure alert's ordinary version to it when the
 * retry decided it and no shutdown stopped the tries (`; kill-failure alert:
 * <entry>`). Pure.
 */
export function startSweepKillFailedEntry(input: StartSweepKillFailedEntryInput): string {
  const stopped = input.stoppedAtShutdown
    ? '; its tries were stopped because the server is shutting down, so no kill-failure alert is raised'
    : ''
  return (
    `kill did not succeed for ${startSweepRowName(input.instanceId, input.persona)} state=${input.state} ` +
    `tmux_session=${input.session}: ${input.outcome}${stopped}; row kept, its session may still be running`
  )
}

/** A start-sweep kill's stop cause (`startSweepStoppedKillLine`): the server began shutting down during its tries (b.jg5 SRJ-702, SRJ-714). */
export const START_SWEEP_KILL_STOP_SHUTDOWN = 'the server is shutting down'
/**
 * A start-sweep kill's stop cause (`startSweepStoppedKillLine`): the
 * `ErrInvalidFlags` re-check of the outcome that stands decided that the
 * server stops (b.jg5 SRJ-205, SRJ-714).
 */
export const START_SWEEP_KILL_STOP_RECHECK = 'the version re-check decided that the server stops; row kept; the sweep makes no further call'

/** Why a start-sweep kill's tries were stopped (`startSweepStoppedKillLine`). */
export type StartSweepKillStopCause = typeof START_SWEEP_KILL_STOP_SHUTDOWN | typeof START_SWEEP_KILL_STOP_RECHECK

/**
 * The start sweep's one line for a kill whose tries were stopped, by a
 * shutdown (`START_SWEEP_KILL_STOP_SHUTDOWN`) or by a version re-check that
 * decided that the server stops (`START_SWEEP_KILL_STOP_RECHECK`) (b.jg5
 * SRJ-205, SRJ-702, SRJ-714): the row, the context, the cause, the last
 * outcome's class, and the descriptions the retry's alert decision carries
 * (`describeKillFailureDescriptions`), the latest survivor-naming one
 * included when a try returned one; no alert is raised:
 *
 *   [slack] reconcileOrphans: kill tries for <row name> (start sweep) were stopped: <cause>; its last outcome's class: <class>; no kill-failure alert is raised; <descriptions> (b.jg5 SRJ-702, SRJ-714[, SRJ-205])
 *
 * `SRJ-205` is cited for the re-check's cause. Pure.
 */
export function startSweepStoppedKillLine(
  instanceId: string,
  persona: string | undefined,
  retried: KillRetryResult,
  cause: StartSweepKillStopCause,
): string {
  const { outcome } = retried
  const lastClass = outcome.kind === KILL_OUTCOME_NOT_KILLED ? outcome.errorClass : outcome.kind
  const refs = cause === START_SWEEP_KILL_STOP_RECHECK ? 'b.jg5 SRJ-702, SRJ-714, SRJ-205' : 'b.jg5 SRJ-702, SRJ-714'
  return (
    `${SWEEP_LOG_PREFIX}: kill tries for ${startSweepRowName(instanceId, persona)} (${KILL_FAILURE_CONTEXT_START_SWEEP}) ` +
    `were stopped: ${cause}; its last outcome's class: ${lastClass}; no kill-failure alert is raised; ` +
    `${describeKillFailureDescriptions(retried.alert)} (${refs})`
  )
}

/**
 * One start-sweep kill of a row listed live (b.jg5 SRJ-110, SRJ-701, SRJ-702,
 * SRJ-714, SRJ-1506): the bounded retry with the pass's budget, clock and
 * keep-going check (`sweepKill`), its result checked. The row is kept
 * whatever the outcome: the sweep deletes no row. A row with no `persona`
 * label (a pre-persona row, b.1ix: an id that is never a persona's
 * `cscb_<key>`, so no launch reuses or resumes it) is killed and kept the
 * same way; `expire` removes kept rows later. Answers the retry's result.
 * Never throws.
 *
 *   [slack] reconcileOrphans: killing <row name> state=<state> tmux_session=<session>; the row is kept whatever the outcome (b.jg5 SRJ-714)
 *   [slack] reconcileOrphans: kill succeeded for <row name> (<outcome>) — row kept
 *
 * `<outcome>` is `describeKillOutcome`'s rendering, `kill_sent` included; a
 * success with `kill_sent` false or absent, `ErrSpawnNotFound`, GONE and a
 * read between tries that found the row finished are successes. A kill whose
 * success stands writes the kill-failure alert's survivor version, when the
 * retry decided it, as one `persona-kill-survivor` entry naming the row
 * (`recordSweepSurvivorAlert`; b.jg5 SRJ-704, SRJ-1007). A kill that did not
 * succeed records one `orphan-cleanup` entry (`startSweepKillFailedEntry`),
 * whatever its class: a CONFLICT or an UNUSABLE NAME answer is routed so,
 * per b.jg5 SRJ-1002, and latches no one, a configured persona's own row
 * included; an ENVIRONMENT or a CONFIG answer is recorded so too, besides
 * its outage for `target.configuredKey` (`sweepKill`). The entry carries the
 * kill-failure alert's ordinary version when the retry decided it (an
 * `ErrTmuxKillFailed` that stands, or any failure after a survivor-naming
 * one; `sweepOrdinaryAlertTail`), except for a kill whose tries a shutdown
 * stopped: its entry carries no alert text, and one line quotes the
 * descriptions, the latest survivor-naming one included
 * (`startSweepStoppedKillLine`). A kill whose `ErrInvalidFlags` re-check
 * decided that the server stops (`stop.stopping` is then set) is one whose
 * tries a shutdown stopped: the same one line, with the re-check's cause, and
 * its `orphan-cleanup` entry with no alert text, and nothing more (b.jg5
 * SRJ-205, SRJ-702, SRJ-714). Nothing is posted, no retry timer is armed and
 * nothing latches.
 */
async function killStartSweepRow(pass: SweepPass, row: ListRow, target: StartSweepKillTarget): Promise<KillRetryResult> {
  const id = row.claude_instance_id
  const name = startSweepRowName(id, target.persona)
  console.error(
    `${SWEEP_LOG_PREFIX}: killing ${name} state=${row.state} tmux_session=${row.tmux_session_name}; the row is kept whatever the outcome (b.jg5 SRJ-714)`,
  )
  const retried = await sweepKill(pass, id, row.state, target.configuredKey)
  const { outcome, alert } = retried
  if (killLetsNextStepRun(outcome)) {
    console.error(startSweepKillSucceededLine(id, target.persona, outcome))
    recordSweepSurvivorAlert(row, alert)
    return retried
  }
  // b.jg5 SRJ-205, SRJ-702, SRJ-714: a kill whose version re-check decided
  // that the server stops is a kill that a shutdown stopped: its one line,
  // quoting the latest survivor-naming description, then its entry with no
  // alert text.
  const stoppedByRecheck = pass.stop.stopping
  const stoppedAtShutdown = stoppedByRecheck || (retried.end === KILL_RETRY_END_STOPPED && sweepShuttingDown(pass))
  if (stoppedAtShutdown) {
    const cause = stoppedByRecheck ? START_SWEEP_KILL_STOP_RECHECK : START_SWEEP_KILL_STOP_SHUTDOWN
    console.error(startSweepStoppedKillLine(id, target.persona, retried, cause))
  }
  const entry = startSweepKillFailedEntry({
    instanceId: id,
    ...(target.persona === undefined ? {} : { persona: target.persona }),
    state: row.state,
    session: typeof row.tmux_session_name === 'string' ? row.tmux_session_name : '',
    outcome: describeKillOutcome(outcome),
    stoppedAtShutdown,
  })
  recordStartupError(ORPHAN_CLEANUP_LABEL, stoppedAtShutdown ? entry : entry + sweepOrdinaryAlertTail(row, alert))
  return retried
}

/**
 * The kill-failure alert for a start-sweep kill of `row` (b.jg5 SRJ-704,
 * SRJ-714, SRJ-1007): the route `selectKillFailureAlertRoute` gives for the
 * start sweep (the sweep acts for no persona: no destination, no episode, no
 * retry timer) and the entry's text, `instanceId=<id> (start sweep): <text>`,
 * the text naming the row's session and its instance id (a pre-persona row's
 * id as it is) with the start sweep's closing sentence, unescaped. Undefined
 * when `alert` is not of `version`. Never throws.
 */
function sweepKillAlertEntry(
  row: ListRow,
  alert: KillRetryAlert,
  version: typeof KILL_FAILURE_VERSION_ORDINARY | typeof KILL_FAILURE_VERSION_SURVIVOR,
): { readonly classLabel: string; readonly entry: string } | undefined {
  try {
    const session = typeof row.tmux_session_name === 'string' ? row.tmux_session_name : ''
    const content = killFailureAlertContentOf(alert, session, row.claude_instance_id)
    if (content === undefined || content.version !== version) return undefined
    const route = selectKillFailureAlertRoute({ version, context: KILL_FAILURE_CONTEXT_START_SWEEP, configured: false, latched: false })
    if (route.classLabel === undefined) return undefined
    const text = killFailureAlertText(content, route.closing, false)
    return { classLabel: route.classLabel, entry: killFailureAlertEntryText(`instanceId=${row.claude_instance_id}`, KILL_FAILURE_CONTEXT_START_SWEEP, text) }
  } catch (err) {
    console.error(`${SWEEP_LOG_PREFIX}: building the kill-failure alert for instanceId=${row.claude_instance_id} failed: ${describeThrownValue(err)}`)
    return undefined
  }
}

/**
 * The tail a start-sweep kill's `orphan-cleanup` entry gains for the
 * kill-failure alert's ordinary version (b.jg5 SRJ-714, SRJ-1007):
 * `; kill-failure alert: <entry>` when the retry decided it (an
 * `ErrTmuxKillFailed` that stands, or any failure after a survivor-naming
 * one), else the empty string, so the entry stays as it was. Never throws.
 */
function sweepOrdinaryAlertTail(row: ListRow, alert: KillRetryAlert): string {
  const built = sweepKillAlertEntry(row, alert, KILL_FAILURE_VERSION_ORDINARY)
  return built === undefined ? '' : `; kill-failure alert: ${built.entry}`
}

/**
 * After a start-sweep kill whose success stands: when the retry decided the
 * survivor version (a survivor-naming `ErrTmuxKillFailed` earlier in its
 * tries; b.jg5 SRJ-702, SRJ-704, SRJ-1013), one `persona-kill-survivor`
 * entry names the row with the survivor text and the start sweep's closing
 * sentence, its writer also writing the server-log line. Nothing else is
 * done: the row counts as killed. Never throws.
 */
function recordSweepSurvivorAlert(row: ListRow, alert: KillRetryAlert): void {
  const built = sweepKillAlertEntry(row, alert, KILL_FAILURE_VERSION_SURVIVOR)
  if (built !== undefined) recordStartupError(built.classLabel, built.entry)
}

/**
 * The start sweep's stops. `stopping`: a kill's `ErrInvalidFlags` re-check
 * decided that the server stops (b.jg5 SRJ-205); once set, the sweep makes
 * no further agent-director call (no kill or findMissing sweep).
 * `shutdownLogged`: the sweep has logged its one shutdown stop line
 * (`START_SWEEP_SHUTDOWN_STOP_LINE`).
 */
interface SweepStop {
  stopping: boolean
  shutdownLogged: boolean
}

/**
 * One start sweep pass's kill context: the sweep's own client, its stops,
 * its pass budget (b.jg5 SRJ-702, AC 56: once one row's kill has used its
 * tries on UNAVAILABLE, every later kill in the pass is made once), the
 * clock its retries wait on, and the server's shutdown query
 * (`sweepShuttingDown`; b.jg5 SRJ-714).
 */
interface SweepPass {
  readonly client: Client
  readonly stop: SweepStop
  readonly budget: KillRetryPassBudget
  readonly clock: KillRetryWait
  readonly isShuttingDown: () => boolean
}

/** The start sweep's line prefix, its kill retry's lines included. */
const SWEEP_LOG_PREFIX = '[slack] reconcileOrphans'

/**
 * The start sweep's one line when it stops because the server began shutting
 * down (b.jg5 SRJ-714, SRJ-702, SRJ-205), logged once per sweep, before its
 * summary line.
 */
export const START_SWEEP_SHUTDOWN_STOP_LINE =
  `${SWEEP_LOG_PREFIX}: the server began shutting down — the sweep stops: no further kill, status read, findMissing or get, ` +
  'and no further latch, record write or clear; what it did stands, and the rows it left unkilled count as kept (b.jg5 SRJ-714, SRJ-205)'

/**
 * Whether the server has begun shutting down, by the sweep's shutdown query
 * (b.jg5 SRJ-714). A query that throws counts as shutting down, so the
 * sweep errs toward making no call. Logs nothing. Never throws.
 */
function sweepShuttingDown(pass: SweepPass): boolean {
  try {
    return pass.isShuttingDown() === true
  } catch {
    return true
  }
}

/**
 * Whether the sweep stops here because the server has begun shutting down
 * (`sweepShuttingDown`): when it has, the sweep's one stop line
 * (`START_SWEEP_SHUTDOWN_STOP_LINE`) is logged, the first time only. Never
 * throws.
 */
function sweepStopsAtShutdown(pass: SweepPass): boolean {
  if (!sweepShuttingDown(pass)) return false
  if (!pass.stop.shutdownLogged) {
    pass.stop.shutdownLogged = true
    console.error(START_SWEEP_SHUTDOWN_STOP_LINE)
  }
  return true
}

/**
 * Whether the sweep has stopped (b.jg5 SRJ-205, SRJ-714): a version re-check
 * decided that the server stops (`stop.stopping`), or the server has begun
 * shutting down (`sweepShuttingDown`). Once it has, an answer that arrives
 * raises no outage. Logs nothing. Never throws.
 */
function sweepStopped(pass: SweepPass): boolean {
  return pass.stop.stopping || sweepShuttingDown(pass)
}

/**
 * The one line for an ENVIRONMENT or CONFIG answer to a start-sweep `call`
 * (its kill, or its `status` read between tries) for configured persona
 * `key` that arrived after the sweep stopped (`sweepStopped`; b.jg5 SRJ-714):
 *
 *   [slack] reconcileOrphans: the <class> answer to the <call> for persona=<key> came after the sweep stopped — no outage is raised (b.jg5 SRJ-714)
 *
 * Pure.
 */
export function startSweepOutageNotRaisedLine(key: string, errorClass: string, call: string): string {
  return `${SWEEP_LOG_PREFIX}: the ${errorClass} answer to the ${call} for persona=${key} came after the sweep stopped — no outage is raised (b.jg5 SRJ-714)`
}

/** Log `startSweepOutageNotRaisedLine`. */
function logSweepOutageNotRaised(key: string, errorClass: string, call: string): void {
  console.error(startSweepOutageNotRaisedLine(key, errorClass, call))
}

/**
 * One start-sweep kill (b.jg5 SRJ-110, SRJ-701, SRJ-702): the bounded retry
 * (`runKillRetry`, `src/kill-retry.ts`) of `instanceId`'s kill on the
 * sweep's own client, seeded with `listedState`, the live state the sweep
 * listed the row in (a finished row is never killed, b.jg5 SRJ-714), on the
 * pass's clock and with the pass's budget: up to 3 tries 2 s apart on
 * UNAVAILABLE, until one row of the pass has used its tries that way, after
 * which every later kill in the pass is made once (AC 56). Each try is one
 * checked kill (`sweepKillTry`); before each further try, one bare `status`
 * read of the row (`sweepKillRead`). The keep-going check is the sweep's
 * shutdown query (`sweepShuttingDown`): once the server has begun shutting
 * down, no further try or read is made and the last try's outcome stands
 * (b.jg5 SRJ-702, SRJ-714). Each try and read is logged with the sweep's
 * prefix. Answers the retry's result; its caller writes the alert
 * decision's entries (`sweepOrdinaryAlertTail`, `recordSweepSurvivorAlert`;
 * b.jg5 SRJ-704, SRJ-714).
 *
 * The start sweep is no launch or recovery attempt: nothing latches (a
 * CONFLICT or an UNUSABLE NAME answer is recorded, b.jg5 SRJ-1002), no retry
 * timer is armed, no `tmux-unresponsive` condition starts and no
 * unclassified-error episode is fed (a class the kill has no row for is
 * UNCLASSIFIED and only recorded). An `ErrInvalidFlags` gets exactly one
 * immediate version re-check (`recheckKillOnInvalidFlags`; b.jg5 SRJ-104,
 * SRJ-204); when the outcome that stands is one whose re-check decided that
 * the server stops, `stop.stopping` is set and the caller records the kill
 * as one a shutdown stopped, with no further call (b.jg5 SRJ-205, SRJ-714).
 * Of the outcome that stands only (hatch A3, through the
 * tries), an ENVIRONMENT answer raises `tmux-unavailable`, and a CONFIG
 * answer `ad-config-malformed`, for `configuredKey` only: the persona of the
 * applied configuration the row's label names, `undefined` for a row of an
 * absent persona or with no persona label, whose answer is only logged and
 * recorded by the caller (b.jg5 SRJ-110, SRJ-301, SRJ-1002). Such an answer
 * raises nothing once the sweep has stopped (`sweepStopped`, asked when the
 * tries end): one line (`logSweepOutageNotRaised`; b.jg5 SRJ-714). Never
 * throws.
 */
async function sweepKill(
  pass: SweepPass,
  instanceId: string,
  listedState: string,
  configuredKey: string | undefined,
): Promise<KillRetryResult> {
  const result = await runKillRetry({
    instanceId,
    kill: () => sweepKillTry(pass.client, instanceId),
    read: () => sweepKillRead(pass, instanceId, configuredKey),
    wait: pass.clock,
    lastRead: killRetrySeedOfState(listedState),
    keepGoing: () => !sweepShuttingDown(pass),
    budget: pass.budget,
    log: (line) => console.error(line),
    logPrefix: SWEEP_LOG_PREFIX,
  })
  const { outcome } = result
  if (killOutcomeStopsServer(outcome)) pass.stop.stopping = true
  if (
    configuredKey !== undefined &&
    outcome.kind === KILL_OUTCOME_NOT_KILLED &&
    (outcome.errorClass === AD_ERROR_CLASS_ENVIRONMENT || outcome.errorClass === AD_ERROR_CLASS_CONFIG)
  ) {
    // b.jg5 SRJ-714: an answer that arrives after the sweep stopped raises nothing.
    if (sweepStopped(pass)) {
      logSweepOutageNotRaised(configuredKey, outcome.errorClass, 'kill')
      return result
    }
    try {
      if (outcome.errorClass === AD_ERROR_CLASS_ENVIRONMENT) raiseTmuxUnavailable(configuredKey, outcome.error)
      else raiseAdConfigMalformed(configuredKey, outcome.error)
    } catch (err) {
      console.error(
        `${SWEEP_LOG_PREFIX}: raising the outage for persona=${configuredKey} failed: ${describeThrownValue(err)}`,
      )
    }
  }
  return result
}

/**
 * One try of a start-sweep kill: one checked kill of `instanceId` on the
 * sweep's own client, with the `ErrInvalidFlags` re-check
 * (`recheckKillOnInvalidFlags`). Never throws.
 */
async function sweepKillTry(client: Client, instanceId: string): Promise<KillOutcome> {
  return recheckKillOnInvalidFlags(await checkedKill(instanceId, (params) => client.kill(params)))
}

/** Who reads, in the clear line of a start-sweep kill's `status` read between its tries (b.jg5 SRJ-807). */
export const START_SWEEP_KILL_STATUS_SITE: OwnRowReadSite = Object.freeze({ site: 'reconcileOrphans', what: 'status read between kill tries' })

/**
 * One `status` read of a swept row between its kill's tries (b.jg5 SRJ-702),
 * on the sweep's own client: its state, or no row for `ErrSpawnNotFound` (by
 * name), or a failed read that latches nothing (the start sweep latches only
 * from its `list`; an UNUSABLE NAME answer is a failed read). A CONFIG answer
 * raises `ad-config-malformed` for `configuredKey` only, through its raise
 * entry, arming no retry timer, and is otherwise only logged (b.jg5 SRJ-110,
 * SRJ-316; hatch A3); the retry then ends the tries when the row was last
 * read `pending`. Of the row-read rule only the entry clear applies (b.jg5
 * SRJ-807): when the row's id is a key's own (`cscb_<key>`), a read live
 * other than `pending` of a key recorded with its mark set clears its entry
 * (`decideRetiredEntryClear` with the installed store's mark,
 * `clearRetiredEntryOnRead`), the store's one line naming
 * `START_SWEEP_KILL_STATUS_SITE`. A read of `ended` or `missing`, or no row,
 * ends an old-life hold on the row (`noteOldLifeRowRead`; b.jg5 SRJ-809).
 * Once the sweep has stopped by the time the read returns (`sweepStopped`),
 * neither the clear, the hold's end nor the CONFIG answer's raise is made
 * (b.jg5 SRJ-714). What it answers is the same whatever the clear did. Never
 * throws.
 */
async function sweepKillRead(pass: SweepPass, instanceId: string, configuredKey: string | undefined): Promise<KillRetryRead> {
  try {
    const result = await pass.client.status({ claude_instance_id: instanceId })
    if (!sweepStopped(pass)) {
      clearOnSweepKillRead(instanceId, result)
      // b.jg5 SRJ-809: a row read `ended` or `missing` ends an old-life hold on it.
      noteOldLifeRowRead(instanceId, { kind: OLD_LIFE_ROW_READ_STATE, state: result.state }, oldLifeReadName(START_SWEEP_KILL_STATUS_SITE))
    }
    return { kind: KILL_RETRY_READ_STATE, state: result.state }
  } catch (err) {
    if (hasAdErrorName(err, ERR_SPAWN_NOT_FOUND_NAME)) {
      // b.jg5 SRJ-809: no row ends an old-life hold on it.
      if (!sweepStopped(pass)) {
        noteOldLifeRowRead(instanceId, { kind: OLD_LIFE_ROW_READ_NO_ROW }, oldLifeReadName(START_SWEEP_KILL_STATUS_SITE))
      }
      return { kind: KILL_RETRY_READ_NO_ROW }
    }
    if (classifyAdError(err).errorClass === AD_ERROR_CLASS_CONFIG) sweepReadConfigAnswer(pass, instanceId, configuredKey, err)
    return { kind: KILL_RETRY_READ_FAILED, error: err }
  }
}

/**
 * A CONFIG answer at a swept row's between-try read: raised for a configured
 * persona, else one line; once the sweep has stopped (`sweepStopped`) by the
 * time the read returns, nothing is raised, with one line
 * (`logSweepOutageNotRaised`; b.jg5 SRJ-714). Never throws.
 */
function sweepReadConfigAnswer(pass: SweepPass, instanceId: string, configuredKey: string | undefined, err: unknown): void {
  if (configuredKey === undefined) {
    console.error(
      `${SWEEP_LOG_PREFIX}: the status read between kill tries for instanceId=${instanceId} answered CONFIG; the row names no persona of the applied configuration, so no outage is raised — logged only (b.jg5 SRJ-110, SRJ-316)`,
    )
    return
  }
  if (sweepStopped(pass)) {
    logSweepOutageNotRaised(configuredKey, AD_ERROR_CLASS_CONFIG, 'status read between kill tries')
    return
  }
  try {
    raiseAdConfigMalformed(configuredKey, err)
  } catch (raiseErr) {
    console.error(
      `${SWEEP_LOG_PREFIX}: raising the outage for persona=${configuredKey} failed: ${describeThrownValue(raiseErr)}`,
    )
  }
}

/**
 * SRJ-807's entry clear over a start-sweep kill's between-try `status` read
 * of `instanceId` (`sweepKillRead`): only when the id is a key's own
 * (`cscb_<key>`, configured or not), through `decideRetiredEntryClear` with
 * the installed store's mark and `clearRetiredEntryOnRead` at
 * `START_SWEEP_KILL_STATUS_SITE`. No latch. Never throws.
 */
function clearOnSweepKillRead(instanceId: string, read: { readonly state: string }): void {
  try {
    const key = ownRowKeyOfRowId(instanceId)
    if (key === undefined) return
    const clear = decideRetiredEntryClear({
      key,
      row: { ...read, claude_instance_id: instanceId },
      configured: false,
      retiredMarked: retiredMarkOf(key),
    })
    if (clear !== undefined) clearRetiredEntryOnRead(key, clear, START_SWEEP_KILL_STATUS_SITE)
  } catch (err) {
    // Not reached (nothing above throws); the read's answer is unchanged.
    console.error(`${SWEEP_LOG_PREFIX}: the entry clear on the status read of instanceId=${instanceId} failed: ${describeThrownValue(err)}`)
  }
}

/**
 * The start sweep's post-kill line (b.jg5 SRJ-714, SRJ-120): what one
 * findMissing run says of the `killedCount` rows the sweep gave a kill call
 * (each read with `readFindMissingRow` and the state the sweep listed it
 * with): `missing` the rows marked missing; `not-judged` the `pending` rows in
 * neither list, which agent-director did not judge (retry later; never a
 * reason to escalate, alert or kill); `still-live` the rest, judged and left
 * live (in `unverified_ids`) or judged alive:
 *
 *   [slack] reconcileOrphans: findMissing after the kills of <n> row(s): missing=<n> [<ids>] still-live=<n> [<ids>] not-judged=<n> [<ids>] — a row that still reads live is killed again by the next start's sweep when it sweeps it; a not-judged row was pending and not judged by this run (retry later)
 *
 * Pure.
 */
export function startSweepPostKillLine(
  killedCount: number,
  missing: readonly string[],
  stillLive: readonly string[],
  notJudged: readonly string[],
): string {
  return (
    `${SWEEP_LOG_PREFIX}: findMissing after the kills of ${killedCount} row(s): ` +
    `missing=${missing.length} [${missing.join(',')}] still-live=${stillLive.length} [${stillLive.join(',')}] ` +
    `not-judged=${notJudged.length} [${notJudged.join(',')}] — a row that still reads live is killed again by the next start's sweep ` +
    'when it sweeps it; a not-judged row was pending and not judged by this run (retry later)'
  )
}

/**
 * The start sweep's post-kill line when its findMissing run failed (b.jg5
 * SRJ-714, SRJ-120), after the run's own failure line; the sweep goes on to
 * its summary:
 *
 *   [slack] reconcileOrphans: findMissing after the kills of <n> row(s) failed — each reads as it did, and a live one is killed again by the next start's sweep when it sweeps it
 *
 * Pure.
 */
export function startSweepPostKillFailedLine(killedCount: number): string {
  return (
    `${SWEEP_LOG_PREFIX}: findMissing after the kills of ${killedCount} row(s) failed — each reads as it did, ` +
    "and a live one is killed again by the next start's sweep when it sweeps it"
  )
}

/**
 * After the start sweep's kills, one findMissing run over every row the
 * sweep gave a kill call, swept and pre-persona rows alike, whatever each
 * kill's outcome (b.jg5 SRJ-714, SRJ-120): `kill` never changes a row's
 * state, so a killed row whose session is gone reads `missing` only once a
 * run marks it, and a later start then leaves it alone; a failed kill's
 * session may be gone all the same, and only the run would tell. A swept
 * `pending` row with no launch start is judged by agent-director's ordinary
 * rules (b.jg5 SRJ-408). The caller makes it once, after the last kill, only
 * when at least one kill was made and no stop came first.
 *
 * It is an ordinary run of the memoized, single-flight run every findMissing
 * caller shares (`sharedFindMissingSweep`, b.m4r, b.jg5 SRJ-120). The start
 * sweep runs before any launch and before the health check, so no earlier
 * run in this process can be reused; the launches right after it reuse this
 * one within its window. The call goes to the start sweep's client directly,
 * as its list and kills do: it acts for no persona, so no persona's outage
 * flag is raised or cleared by the call. As after any run the server makes,
 * each configured persona's own row listed in `unverified_ids` is then read
 * with one `get` through that persona's `withOutageDetection`
 * (`readListedPersonaRows`; an already-latched persona is skipped), and only
 * a `provenance_conflict` note there, or the persona's own row reading
 * `pending` with no launch start (b.jg5 SRJ-513), latches. The run is the
 * start sweep's (`startSweepRun`), so an UNUSABLE NAME answer to one of
 * those `get`s is routed per SRJ-1002 and latches nothing (b.jg5 SRJ-512):
 * its routed line, and `refused (<failure>)` in the reads' line. Those
 * `get`s are made only while the server has not begun shutting down when the
 * run returns (`postRunGetsGo`; b.jg5 SRJ-714); when it has, the sweep's one
 * stop line is logged then (`sweepStopsAtShutdown`), before its summary. The
 * same check is asked as each `get` settles: one that settles once the
 * server has begun shutting down is not acted on (no latch, clear or
 * episode end, nothing posted; `readListedPersonaRows`). A shutdown begun
 * during a run that then fails is logged by the sweep's end
 * (`endStartSweep`). Never throws.
 *
 * The run's own line, then `startSweepPostKillLine` for the killed rows, or,
 * when the run fails, its failure line and `startSweepPostKillFailedLine`.
 * The start sweep's kill decisions do not depend on these lines.
 */
async function runStartSweepPostKillFindMissing(pass: SweepPass, killed: readonly SweepRowRecord[]): Promise<void> {
  const r = await sharedFindMissingSweep(() => pass.client.findMissing({}), 'reconcileOrphans', 'the rows the start sweep killed', undefined, {
    startSweepRun: true,
    postRunGetsGo: () => !sweepStopsAtShutdown(pass),
  })
  if (!r) {
    console.error(startSweepPostKillFailedLine(killed.length))
    return
  }
  const missing: string[] = []
  const stillLive: string[] = []
  const notJudged: string[] = []
  for (const { row } of killed) {
    const id = row.claude_instance_id
    const reading = readFindMissingRow(r, id, row.state)
    if (reading === FIND_MISSING_ROW_MARKED_MISSING) missing.push(id)
    else if (reading === FIND_MISSING_ROW_NOT_JUDGED) notJudged.push(id)
    else stillLive.push(id)
  }
  console.error(startSweepPostKillLine(killed.length, missing, stillLive, notJudged))
}

/** Who reads, in the own-row lines of the start sweep's `list` rows (`reconcileOrphans`; the persona's ref is added for a configured persona; b.jg5 SRJ-116, SRJ-807). */
export const START_SWEEP_LIST_SITE: OwnRowReadSite = Object.freeze({ site: 'reconcileOrphans', what: 'start sweep list' })

/**
 * The `startup-errors.log` class of the start sweep's failed `list`
 * (`reconcileOrphans`; b.jg5 SRJ-116): one entry, after which the sweep does
 * nothing more.
 */
export const ORPHAN_CLEANUP_LIST_FAILED_LABEL = 'orphan-cleanup-list-failed'

/**
 * The start sweep's latch pass (b.jg5 SRJ-116, SRJ-501, SRJ-502, SRJ-513,
 * SRJ-714, SRJ-807), made over the whole list before any kill. Each listed
 * row whose id is a key's own (`cscb_<key>`, `ownRowKeyOfRowId`), whatever
 * its `persona` label, goes through the shared own-row read's act step
 * (`actOnOwnRowRead`) at `START_SWEEP_LIST_SITE`, as a `get` row would:
 *
 *   - a configured persona's own row (the installed `ConfiguredPersonaQuery`)
 *     that reads `pending` with no launch start latches it with "launch
 *     start not recorded", a `provenance_conflict` note too included, and
 *     one that carries `provenance_conflict` otherwise latches it with
 *     "conflicting labels", recording the state the row was listed in; the
 *     latch's notice is posted once per episode;
 *   - the own row of a key recorded as retired with its mark set, read live
 *     other than `pending`, clears the key's entry, except for a key in
 *     `recordedKeys` (the keys this sweep records, `absentPersonaKeysOf`),
 *     whose recording clears its mark instead (b.jg5 SRJ-714, SRJ-803).
 *
 * A row with another id latches no one, a row labelled P included. A
 * configured persona already latched when the sweep runs (`latchGateReadingOf`)
 * is held as well (b.jg5 SRJ-502). Answers the set of such personas' keys;
 * the caller leaves its own row and every row labelled with it unkilled for the
 * whole pass (`startSweepLatchOf`). Makes no agent-director call. One line
 * per persona, after the act step's own lines:
 *
 *   [slack] reconcileOrphans: <ref> latched from its own listed row instanceId=<id> (case=<case>) — its own row and every row labelled with it are left unkilled (b.jg5 SRJ-116, SRJ-502, SRJ-714)
 *   [slack] reconcileOrphans: <ref> is latched (case=<case>) — its own row and every row labelled with it are left unkilled (b.jg5 SRJ-502, SRJ-714)
 *
 * Never throws.
 */
function latchFromListedRows(
  rows: readonly ListRow[],
  personasByKey: ReadonlyMap<string, Persona>,
  recordedKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  const latched = new Set<string>()
  for (const row of rows) {
    const key = ownRowKeyOfRowId(row.claude_instance_id)
    if (key === undefined) continue
    const persona = personasByKey.get(key)
    const ref = persona === undefined ? keyRef(key) : personaRef(persona)
    const at: OwnRowReadSite = persona === undefined ? START_SWEEP_LIST_SITE : { ...START_SWEEP_LIST_SITE, ref }
    const decision = actOnOwnRowRead(key, row, at, !recordedKeys.has(key))
    if (decision === undefined || latched.has(key)) continue
    latched.add(key)
    console.error(startSweepLatchedFromOwnRowLine(ref, row.claude_instance_id, decision.latchCase))
  }
  for (const persona of personasByKey.values()) {
    if (latched.has(persona.key)) continue
    const reading = latchGateReadingOf(persona.key)
    if (reading === undefined) continue
    const ref = personaRef(persona)
    latched.add(persona.key)
    console.error(startSweepLatchedLine(ref, reading.latchCase))
  }
  return latched
}

/**
 * The start sweep's line for a persona latched from its own listed row
 * (`latchFromListedRows`; b.jg5 SRJ-116, SRJ-502, SRJ-714), `ref` its
 * reference:
 *
 *   [slack] reconcileOrphans: <ref> latched from its own listed row instanceId=<id> (case=<case>) — its own row and every row labelled with it are left unkilled (b.jg5 SRJ-116, SRJ-502, SRJ-714)
 *
 * Pure.
 */
export function startSweepLatchedFromOwnRowLine(ref: string, instanceId: string, latchCase: string): string {
  return `${SWEEP_LOG_PREFIX}: ${ref} latched from its own listed row instanceId=${instanceId} (case=${latchCase}) — its own row and every row labelled with it are left unkilled (b.jg5 SRJ-116, SRJ-502, SRJ-714)`
}

/**
 * The start sweep's line for a configured persona already latched when the
 * sweep runs (`latchFromListedRows`; b.jg5 SRJ-502, SRJ-714), `ref` its
 * reference:
 *
 *   [slack] reconcileOrphans: <ref> is latched (case=<case>) — its own row and every row labelled with it are left unkilled (b.jg5 SRJ-502, SRJ-714)
 *
 * Pure.
 */
export function startSweepLatchedLine(ref: string, latchCase: string): string {
  return `${SWEEP_LOG_PREFIX}: ${ref} is latched (case=${latchCase}) — its own row and every row labelled with it are left unkilled (b.jg5 SRJ-502, SRJ-714)`
}

/**
 * The key of the persona whose latch leaves `row` unkilled at the start
 * sweep (b.jg5 SRJ-502, SRJ-714): the row's own key (`cscb_<key>`) when that
 * persona latched, else its `persona` label when that persona latched;
 * undefined when neither did. Pure; never throws.
 */
function startSweepLatchOf(row: ListRow, latched: ReadonlySet<string>): string | undefined {
  const own = ownRowKeyOfRowId(row.claude_instance_id)
  if (own !== undefined && latched.has(own)) return own
  const label = row.labels?.[PERSONA_LABEL_KEY]
  return typeof label === 'string' && latched.has(label) ? label : undefined
}

/**
 * The keys the start sweep records as retired (b.jg5 SRJ-714, SRJ-803): the
 * `persona` label value of each listed row, in any state, that names no
 * persona of `personasByKey` (the applied configuration), each once, in list
 * order. A pre-persona row (no `persona` label) gives no key. Pure; never
 * throws.
 */
function absentPersonaKeysOf(rows: readonly ListRow[], personasByKey: ReadonlyMap<string, Persona>): string[] {
  const keys = new Set<string>()
  for (const row of rows) {
    const label = row.labels?.[PERSONA_LABEL_KEY]
    if (typeof label !== 'string' || label === '' || personasByKey.has(label)) continue
    keys.add(label)
  }
  return [...keys]
}

/**
 * The start sweep's one batch record (b.jg5 SRJ-714, SRJ-803): `keys`, each
 * with the cause `absent-at-start` (`RETIRED_KEY_CAUSE_ABSENT_AT_START`),
 * through the installed store's `record`, one call per sweep, made after the
 * latch pass and before the first kill. The store's rules apply: a new key
 * gets its entry, a marked key has its mark cleared, an unmarked recorded key
 * writes nothing unless it is held only in memory, and a batch that changes
 * nothing writes nothing. The store logs its write and its failure; a failed
 * write is that one line and leaves the file as it was, while the store holds
 * the keys as retired in memory for this server's life, and the sweep goes on
 * to its kills, with no `orphan-cleanup` entry; the next start's sweep
 * records them again (hatch A3). No approver needs stopping: none runs before
 * the bring-up (SRJ-808).
 *
 * Answers the keys recorded: all of `keys` once `record` returned, whatever
 * it wrote; 0 for no keys (no call), with no store installed, and when
 * `record` throws, each of the last two with one line:
 *
 *   [slack] reconcileOrphans: no retired-key store is installed, so the keys of absent personas' rows are not recorded as retired: <keys> (b.jg5 SRJ-714, SRJ-803)
 *   [slack] reconcileOrphans: recording the keys of absent personas' rows as retired failed: <error>; nothing is recorded (b.jg5 SRJ-714, SRJ-803)
 *
 * Never throws.
 */
function recordAbsentPersonaKeys(keys: readonly string[]): number {
  if (keys.length === 0) return 0
  const store = retiredKeyStore
  if (store === undefined) {
    const named = keys.map((key) => JSON.stringify(renderLogMessageText(key))).join(', ')
    console.error(
      `${SWEEP_LOG_PREFIX}: no retired-key store is installed, so the keys of absent personas' rows are not recorded as retired: ${named} (b.jg5 SRJ-714, SRJ-803)`,
    )
    return 0
  }
  try {
    store.record(keys.map((key) => ({ key, cause: RETIRED_KEY_CAUSE_ABSENT_AT_START })))
  } catch (err) {
    console.error(
      `${SWEEP_LOG_PREFIX}: recording the keys of absent personas' rows as retired failed: ${describeThrownValue(err)}; nothing is recorded (b.jg5 SRJ-714, SRJ-803)`,
    )
    return 0
  }
  return keys.length
}

/**
 * The start sweep (b.av2 SR-6.3, amended by b.jg5 SRJ-1506; b.jg5 SRJ-116,
 * SRJ-714), run by `main()` before any bring-up. It deletes no row: every
 * row is read, live strays are killed with the result checked, finished rows
 * are never killed, and pre-persona and absent-persona rows are kept and
 * never resumed until agent-director's `expire` removes them. In this order:
 *
 *   1. One `list` of every `service=cscb` row, in every state: the call
 *      carries the service label only, with no state filter (b.jg5
 *      SRJ-116). A list failure records one `orphan-cleanup-list-failed`
 *      entry and returns at once: nothing is latched, recorded, cleared or
 *      killed, no findMissing run follows and no summary line is logged; the
 *      start pass goes on.
 *   2. The latch pass over the whole list, before any kill
 *      (`latchFromListedRows`): each row whose id is a key's own goes
 *      through the shared own-row read's act step at
 *      `START_SWEEP_LIST_SITE`, so a configured persona whose own row
 *      carries `provenance_conflict` or reads `pending` with no launch start
 *      latches, with one post per latch episode, after a restart too
 *      (b.jg5 SRJ-114, SRJ-501, SRJ-504, SRJ-513), and a marked retired
 *      key's row read live other than `pending` clears its entry (SRJ-807),
 *      except for a key step 3 records. Such a persona, and one already
 *      latched when the sweep runs, has its own row and every row labelled
 *      with it left as they are for the whole pass, ahead of `sweepDecision`
 *      and the directory-broken deferral, a `cwd` or `config_dir` other
 *      than the persona's included (b.jg5 SRJ-502, AC 55); those rows are
 *      counted in `leftForLatch`.
 *   3. One batch record, before the first kill, of the key of every listed
 *      row, in any state, labelled with a persona absent from
 *      `personaConfig`, with the cause `absent-at-start`
 *      (`recordAbsentPersonaKeys`; b.jg5 SRJ-714, SRJ-803); the keys are
 *      counted in `recordedAsRetired`. A failed write leaves the file as it
 *      was, the store holds the keys in memory, and the sweep goes on.
 *      Then, still before the first kill, the listing's old-life holds
 *      (`beginStartSweepListingHolds`; b.jg5 SRJ-809, SRJ-714): every row
 *      listed live (`pending` included) whose key is recorded as retired
 *      without the "new life has begun" mark, a key just recorded included,
 *      holds its `cwd`, whether the sweep then kills it, keeps it or leaves
 *      it for a latch, so a restart restores the hold apply step 1 began (a
 *      destructive modify's same-key old life the sweep keeps included).
 *   4. Row by row in list order, of the rows step 2 left: a row with no
 *      `persona` label (a pre-persona row, b.1ix) is a stray; a labelled row
 *      is a stray when `sweepDecision` sweeps it (an absent persona, an
 *      instance ID other than `cscb_<key>`, or a `cwd` other than its
 *      persona's working directory, by real path, `compareRowToPersona`),
 *      and is kept otherwise. A stray listed live (`AGENT_DIRECTOR_LIVE_STATES`,
 *      `pending` included) is killed with the result checked
 *      (`killStartSweepRow`; b.jg5 SRJ-110, SRJ-701, SRJ-702), a swept
 *      `pending` row with no launch start included, with no wait (SRJ-408);
 *      a stray listed finished gets no call and is kept. Every kill runs
 *      through the bounded retry with one pass budget for the whole pass, so
 *      a wedged tmux delays the pass by at most one row's retries (AC 56), on
 *      `clock` (the production clock unless the caller passes its own). No
 *      kill latches anything or arms a retry timer; an ENVIRONMENT or CONFIG
 *      answer raises its outage only for a configured persona's row (hatch
 *      A3). Every row is kept, whatever its kill's outcome; a kill that did
 *      not succeed records `orphan-cleanup` and holds the row's `cwd` for
 *      an old life (`beginStartSweepKillHold`; b.jg5 SRJ-809), keeping the
 *      listing's hold when the row has one, and marks the hold kill-failed
 *      when its tries decided the ordinary kill-failure alert (SRJ-812).
 *   5. When at least one kill was made, one findMissing run over every row
 *      given a kill, whatever its outcome (`runStartSweepPostKillFindMissing`;
 *      b.jg5 SRJ-714, SRJ-120); a row in its `ids` ends its old-life hold.
 *   6. One summary line (`startSweepSummaryLine`): the rows killed, kept
 *      (with the failed kills as a sub-count), recorded as retired, and left
 *      unkilled for a latch.
 *
 * When a persona's working directory cannot be resolved to a real path (a
 * directory-broken persona, b.av2 SR-6.4), its rows whose `cwd` has no real
 * path either (or equals the configured path lexically) are kept, and one
 * line per persona says the check is deferred to its launch; a row whose
 * `cwd` resolves to an existing directory is still swept as `wrong cwd`:
 *
 *   [slack] reconcileOrphans: persona "<name>" (key=<key>) working_directory="<path>" cannot be resolved to a real path — keeping its rows; the cwd check is deferred to its launch
 *
 * A swept row gets one line saying why it is swept and whether it is killed:
 *
 *   [slack] reconcileOrphans: sweeping row (<reason>) persona=<persona> instanceId=<id> state=<state>[ cwd=<cwd>] — <it is live, so it is killed; the row is kept|it is finished, so it is not killed (a finished row is never killed); the row is kept> (b.jg5 SRJ-714)
 *
 * A `channel` label left on a row by an older spawn plays no part.
 *
 * The stops. A kill whose `ErrInvalidFlags` re-check decides that the server
 * stops ends the sweep's agent-director calls: the kill is recorded as one a
 * shutdown stopped (its `orphan-cleanup` entry with no alert text, counted
 * kept and failed), no later row is killed and no findMissing run follows
 * (b.jg5 SRJ-205, SRJ-714). `isShuttingDown`, the server's
 * shutdown query (with none, nothing counts as shutting down), is asked once
 * the `list` returns, before each row, as the bounded retry's keep-going
 * check (before each further try and read), when a between-try read returns
 * (before its entry clear or its CONFIG answer's raise), when a kill's tries
 * end (before its ENVIRONMENT or CONFIG answer's raise), before the
 * findMissing run, before its post-run `get`s, as each of those `get`s
 * settles (before its act step), and at the sweep's end, before its summary
 * (b.jg5 SRJ-714). Once it answers true the sweep makes no further
 * agent-director call (`kill`, a `status` read, `find-missing`, `get`) and
 * no further latch, record write, clear or outage raise, an answer that
 * arrives after it included; what it has done stands; a kill whose tries
 * were stopped keeps its `orphan-cleanup` entry with no alert text
 * (`startSweepStoppedKillLine`); the rows it left unkilled count as kept;
 * and it logs `START_SWEEP_SHUTDOWN_STOP_LINE` once, then its summary line.
 * Either way, a latched persona's rows still count as left for its latch.
 * Once the sweep has stopped it begins and marks no old-life hold.
 *
 * Each listed row is also a read of it for the old-life holds
 * (`noteOldLifeRowRead`; b.jg5 SRJ-809): a row listed `ended` or `missing`
 * ends a hold on it, and a live row's `cwd` becomes its held directory. Holds
 * live in server memory, so this sweep is where a restart rebuilds the ones
 * still needed.
 *
 * The sweep keeps one record per listed row (`SweepRowRecord`: the row as
 * listed, what it did with it, and its kill's result), from which its
 * counts and its findMissing run are taken.
 */
export async function reconcileOrphans(
  personaConfig: PersonaConfig,
  clock: KillRetryWait = KILL_RETRY_SYSTEM_CLOCK,
  isShuttingDown: () => boolean = () => false,
): Promise<OrphanReconcileResult> {
  if (isDryRun()) {
    console.error('[slack] dry-run: skipping orphan reconciliation')
    return emptySweepResult()
  }

  const client = getClient()
  let rows: ListRow[]
  try {
    // b.jg5 SRJ-116: the service label only, so every row in every state is listed.
    const r = await client.list({ label: [SERVICE_LABEL] })
    rows = r.spawns
  } catch (err) {
    const e = err instanceof AgentDirectorError ? err : new AgentDirectorError('list', 'UnknownError', String(err))
    recordStartupError(
      ORPHAN_CLEANUP_LIST_FAILED_LABEL,
      `failed to list spawns for orphan reconciliation: ${describeAgentDirectorFailure(e)}`,
    )
    return emptySweepResult()
  }

  const pass: SweepPass = {
    client,
    stop: { stopping: false, shutdownLogged: false },
    budget: createKillRetryPassBudget(),
    clock,
    isShuttingDown,
  }
  const records: SweepRowRecord[] = []

  // b.jg5 SRJ-714: a shutdown begun by the time the list returns means no
  // latch, no record write and no kill; every row counts as kept.
  if (sweepStopsAtShutdown(pass)) {
    for (const row of rows) records.push({ row, disposition: SWEEP_ROW_KEPT })
    return endStartSweep(pass, records, 0)
  }

  // b.jg5 SRJ-502, SRJ-714: every latch and record decision is made over the
  // whole list before the first kill.
  const personasByKey = new Map(personaConfig.personas.map((p) => [p.key, p]))
  const absentKeys = absentPersonaKeysOf(rows, personasByKey)
  const latched = latchFromListedRows(rows, personasByKey, new Set(absentKeys))
  const recordedAsRetired = recordAbsentPersonaKeys(absentKeys)
  // b.jg5 SRJ-809, SRJ-714: after the recording and before the first kill,
  // the listing's holds: every live row of a key recorded without its mark,
  // whatever the sweep then does with it.
  beginStartSweepListingHolds(pass, rows)
  // b.jg5 SRJ-809, SRJ-811: then each listed row is a read of it, through the
  // one read entry: a finished one ends an old-life hold on it, and a live
  // one's state seeds the hold's first wait (so a row listed `pending` gets
  // its wait seeded `pending`, and SRJ-316's rule applies) and its `cwd` is
  // the held directory.
  for (const row of rows) {
    noteOldLifeRowRead(
      row.claude_instance_id,
      { kind: OLD_LIFE_ROW_READ_STATE, state: row.state, cwd: row.cwd },
      oldLifeReadName(START_SWEEP_LIST_SITE),
    )
  }

  const context: StartSweepRowContext = { latched, personasByKey, home: spawnHomeDir(), deferredLogged: new Set<string>() }
  for (const row of rows) {
    const record = await sweepListedRow(pass, row, context)
    records.push(record)
    // b.jg5 SRJ-809: a kill that did not succeed holds the row's directory,
    // before the post-kill findMissing run, which can end the hold.
    beginStartSweepKillHold(pass, record)
  }

  // b.jg5 SRJ-714, SRJ-120: one findMissing run over every row given a kill.
  const killed = records.filter((record) => record.kill !== undefined)
  if (killed.length > 0 && !pass.stop.stopping && !sweepStopsAtShutdown(pass)) {
    await runStartSweepPostKillFindMissing(pass, killed)
  }
  return endStartSweep(pass, records, recordedAsRetired)
}

/**
 * The start sweep's listing holds (b.jg5 SRJ-809's third start, SRJ-714,
 * SRJ-1506), begun after its batch record and before its first kill: each
 * listed row in a live state (`AGENT_DIRECTOR_LIVE_STATES`, `pending`
 * included) whose `persona` label key the installed retired-key store answers
 * as recorded without the "new life has begun" mark (`retiredKeyReadingOf`,
 * a key this sweep has just recorded and one held only in memory included)
 * gets one hold on its `cwd`, with the cause `start-sweep-listing` and the old
 * key `oldLifeKeyOf` gives (the label, or the instance id when the id is not
 * the label's `cscb_<key>`), whatever the sweep then does with the row: kill
 * it, keep it (a destructive modify's same-key old life whose `cwd` matches
 * its persona included) or leave it for a latch. It restores after a restart
 * the hold apply step 1 began. A row whose kill then succeeds keeps the hold
 * until a read shows it finished (the post-kill findMissing run usually
 * does). A finished row, a row with no `persona` label, and a row whose key is
 * not recorded, or recorded with its mark set, get none. Nothing begins once
 * the sweep has stopped (`sweepStopped`), or with no hold set installed.
 * Each hold's begin line is the hold set's. Never throws.
 */
function beginStartSweepListingHolds(pass: SweepPass, rows: readonly ListRow[]): void {
  const holds = oldLifeHolds
  if (holds === undefined || sweepStopped(pass)) return
  for (const row of rows) {
    try {
      if (!AGENT_DIRECTOR_LIVE_STATES.has(row.state)) continue
      const label = row.labels?.[PERSONA_LABEL_KEY]
      if (typeof label !== 'string' || label === '') continue
      const reading = retiredKeyReadingOf(label)
      if (!reading.recorded || reading.marked) continue
      if (typeof row.cwd !== 'string' || row.cwd === '') continue
      holds.begin({
        instanceId: row.claude_instance_id,
        oldKey: oldLifeKeyOf(row.claude_instance_id, label),
        directory: row.cwd,
        cause: OLD_LIFE_HOLD_CAUSE_START_SWEEP_LISTING,
      })
      noteOldLifeHoldSession(row.claude_instance_id, row.tmux_session_name)
    } catch (err) {
      // Not reached (the hold set and the reading never throw).
      console.error(`${SWEEP_LOG_PREFIX}: beginning the old-life hold of instanceId=${row.claude_instance_id} failed: ${describeThrownValue(err)} (b.jg5 SRJ-809)`)
    }
  }
}

/**
 * The start sweep's kill hold for one row's record (b.jg5 SRJ-809's second
 * start, SRJ-714, SRJ-1506): a row given a kill that did not succeed
 * (`SWEEP_ROW_KILL_FAILED`: every non-success class, CONFLICT and UNUSABLE
 * NAME included) holds its `cwd`, with the cause
 * `start-sweep-kill-not-succeeded` and the old key `oldLifeKeyOf` gives (the
 * `persona` label key, or the instance id for a pre-persona row and a row
 * whose id is not the label's `cscb_<key>`): an absent persona's row, a live
 * pre-persona row, a row swept for its instance id and one swept for its
 * `cwd` alike. A row that already has a hold (the listing's) keeps that one
 * hold. Either way the hold is marked kill-failed when the kill's tries
 * decided the ordinary kill-failure alert (`markOldLifeHoldKillFailed`;
 * b.jg5 SRJ-812). A kill that succeeded begins nothing and marks nothing.
 * Nothing begins or is marked once the sweep has stopped (`sweepStopped`: a
 * shutdown, or a version re-check's stop), or with no hold set installed.
 * Never throws.
 */
function beginStartSweepKillHold(pass: SweepPass, record: SweepRowRecord): void {
  const holds = oldLifeHolds
  if (holds === undefined || record.disposition !== SWEEP_ROW_KILL_FAILED || record.kill === undefined) return
  if (sweepStopped(pass)) return
  const { row } = record
  const id = row.claude_instance_id
  try {
    if (holds.holdOf(id) === undefined) {
      if (typeof row.cwd !== 'string' || row.cwd === '') return
      holds.begin({
        instanceId: id,
        oldKey: oldLifeKeyOf(id, row.labels?.[PERSONA_LABEL_KEY]),
        directory: row.cwd,
        cause: OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL,
      })
    }
    noteOldLifeHoldSession(id, row.tmux_session_name)
  } catch (err) {
    // Not reached (the hold set never throws).
    console.error(`${SWEEP_LOG_PREFIX}: beginning the old-life hold of instanceId=${id} failed: ${describeThrownValue(err)} (b.jg5 SRJ-809)`)
    return
  }
  markOldLifeHoldKillFailed(id, record.kill)
}

/**
 * Keep the tmux session the start sweep's listing names for held row
 * `instanceId` (b.jg5 SRJ-811, SRJ-1001), when it is a non-empty string and
 * the row is held: the session a wait's kill-failure alert names until a
 * `get` of the row reads one (`oldLifeWaitSession`). A session already kept
 * for the hold stays. Never throws.
 */
function noteOldLifeHoldSession(instanceId: string, session: unknown): void {
  try {
    if (typeof session !== 'string' || session === '' || oldLifeSessionNames.has(instanceId)) return
    if (oldLifeHolds?.holdOf(instanceId) === undefined) return
    oldLifeSessionNames.set(instanceId, session)
  } catch {
    /* not reached (the hold set never throws); the alert names no session then */
  }
}

/** What the start sweep decides each listed row by, once its latch pass is done. */
interface StartSweepRowContext {
  /** The personas whose rows are left for their latch (`latchFromListedRows`). */
  readonly latched: ReadonlySet<string>
  /** The applied configuration's personas by key. */
  readonly personasByKey: ReadonlyMap<string, Persona>
  /** The home directory `compareRowToPersona` resolves `~` against. */
  readonly home: string
  /** The directory-broken personas whose deferral line has been logged. */
  readonly deferredLogged: Set<string>
}

/**
 * The start sweep's step 4 for one listed row (`reconcileOrphans`): its
 * record. A row whose persona latched is left for the latch; after a stop
 * (a version re-check's, or a shutdown begun, `sweepStopsAtShutdown`) a row
 * is kept with no call; a row `sweepDecision` keeps or defers is kept; a
 * stray listed finished is kept with no call; a stray listed live is killed
 * (`killStartSweepRow`) and kept, counted killed when the kill's success
 * stands. Never throws.
 */
async function sweepListedRow(pass: SweepPass, row: ListRow, context: StartSweepRowContext): Promise<SweepRowRecord> {
  // b.jg5 SRJ-502 (AC 55): a latched persona's rows are left as they are.
  if (startSweepLatchOf(row, context.latched) !== undefined) return { row, disposition: SWEEP_ROW_LEFT_FOR_LATCH }
  // b.jg5 SRJ-205, SRJ-714: after a stop the sweep makes no further call.
  if (pass.stop.stopping || sweepStopsAtShutdown(pass)) return { row, disposition: SWEEP_ROW_KEPT }
  const live = AGENT_DIRECTOR_LIVE_STATES.has(row.state)
  const personaLabel = row.labels?.[PERSONA_LABEL_KEY]
  let target: StartSweepKillTarget = {}
  if (personaLabel) {
    const persona = context.personasByKey.get(personaLabel)
    const decision = sweepDecision(row, persona, context.home)
    if (decision.action === 'keep') return { row, disposition: SWEEP_ROW_KEPT }
    if (decision.action === 'deferred') {
      const deferred = decision.persona
      if (!context.deferredLogged.has(deferred.key)) {
        context.deferredLogged.add(deferred.key)
        console.error(
          `${SWEEP_LOG_PREFIX}: persona ${personaRef(deferred)} working_directory="${deferred.working_directory}" ` +
            'cannot be resolved to a real path — keeping its rows; the cwd check is deferred to its launch',
        )
      }
      return { row, disposition: SWEEP_ROW_KEPT }
    }
    // The persona reference when the persona exists, else the raw label value.
    const displayPersona = persona ? personaRef(persona) : personaLabel
    console.error(
      startSweepSweepingRowLine({
        reason: decision.reason,
        persona: displayPersona,
        instanceId: row.claude_instance_id,
        state: row.state,
        ...(decision.reason === 'wrong cwd' ? { cwd: row.cwd } : {}),
        live,
      }),
    )
    target = persona ? { persona: displayPersona, configuredKey: persona.key } : { persona: displayPersona }
  }
  // b.jg5 SRJ-714, SRJ-110: a finished row is never killed.
  if (!live) return { row, disposition: SWEEP_ROW_KEPT }
  const kill = await killStartSweepRow(pass, row, target)
  return { row, disposition: killLetsNextStepRun(kill.outcome) ? SWEEP_ROW_KILLED : SWEEP_ROW_KILL_FAILED, kill }
}

/**
 * The start sweep's end (b.jg5 SRJ-714): when no version re-check stopped
 * the sweep and the server has begun shutting down by now, its one stop line
 * (`sweepStopsAtShutdown`, logged once per sweep: a shutdown begun during a
 * findMissing run that then failed, or during its post-run `get`s, is logged
 * here); then its counts over `records`, logged as its one summary line
 * (`startSweepSummaryLine`).
 */
function endStartSweep(pass: SweepPass, records: readonly SweepRowRecord[], recordedAsRetired: number): OrphanReconcileResult {
  if (!pass.stop.stopping) sweepStopsAtShutdown(pass)
  const result = sweepResultOf(records, recordedAsRetired)
  console.error(startSweepSummaryLine(result))
  return result
}

// ---------------------------------------------------------------------------
// startupSessionManager — iterate personas and dispatch per persona
// ---------------------------------------------------------------------------

/**
 * What `startupSessionManager` needs to run steps 1–3 of the SR-6.1 bring-up
 * procedure for each persona: the bring-up controller
 * (`createPersonaBringUpController`), which gives each persona its outcome and
 * runs its retries on the persona's own timers. The applied set is supplied
 * here; the launch (step 4) at start is `spawnForPersona`.
 */
export type StartupBringUpDeps = Pick<PersonaBringUpController, 'bringUp'>

/**
 * A start launch the launch pool did not start because the server had begun
 * shutting down (b.jg5 SRJ-205): no agent-director call was made for it.
 * Its own per-persona outcome, counted in no summary count and never failed.
 */
export const NOT_LAUNCHED_FOR_SHUTDOWN = 'not-launched-shutdown'

/**
 * One persona's start outcome: a spawn outcome; not brought up (steps 1–3:
 * `broken` or `retrying`) with its causes; b.f2b, a launch still waiting in
 * the background for its `working` row to settle when the pass returned; or
 * a launch the pool did not start because a shutdown had begun
 * (`NOT_LAUNCHED_FOR_SHUTDOWN`, b.jg5 SRJ-205).
 */
export type StartupPersonaOutcome =
  | { key: string; action: SpawnPersonaResult['action'] }
  | {
    key: string
    action: 'not-brought-up'
    outcome: Exclude<PersonaBringUpOutcome, 'up'>
    failures: PersonaBringUpFailure[]
  }
  | { key: string; action: 'waiting-in-background' }
  | { key: string; action: typeof NOT_LAUNCHED_FOR_SHUTDOWN }

/** b.f2b: a start launch parked while it waits for a `working` row to settle. */
const WAITING_IN_BACKGROUND = 'waiting-in-background'

/** A start launch's result as the start pass sees it (b.f2b, b.jg5 SRJ-205). */
type StartLaunchResult = SpawnPersonaResult | typeof WAITING_IN_BACKGROUND | typeof NOT_LAUNCHED_FOR_SHUTDOWN

export interface StartupSessionManagerResult {
  /**
   * Launches that left the persona's session running: `spawned`,
   * `fresh-retired`, `resumed`, `reconnected`, `not-reconnected`, `no-op`
   * and the two amnesia results. Never a `latched`, `retrying`,
   * `sequence-waiting` or `held` launch (b.jg5 SRJ-1015).
   */
  succeeded: number
  /**
   * Failed launches (`failed`), and launches that threw. Never a `latched`,
   * `retrying`, `sequence-waiting` or `held` launch (b.jg5 SRJ-1015).
   */
  failed: number
  /**
   * Personas not brought up at start: `broken` or `retrying` after steps 1–3
   * (credentials, working directory, Slack). Not launched by the start and
   * not counted as a failed spawn; a `retrying` persona is launched later
   * from its own retry, outside the pool.
   */
  notBroughtUp: number
  /** b.wrb: honest per-outcome breakdown of the succeeded personas. */
  resumed: number
  /**
   * Clean fresh spawns (no prior row / no resume attempted). A retired key's
   * reuse that began its new life is counted in `freshRetired`, never here
   * (b.jg5 SRJ-1015).
   */
  freshSpawned: number
  /** Fresh spawns that REPLACED a resume because the transcript was missing
   *  (ErrJsonlMissing amnesia) and diagnosis was CONCLUSIVE ('lost' or
   *  evidence-based 'never-created') — separated so they are never hidden in
   *  "ok". */
  freshAfterAmnesia: number
  /** b.fwu: fresh spawns that REPLACED a resume after ErrJsonlMissing amnesia
   *  where diagnosis was INCONCLUSIVE — we could not determine whether prior
   *  history was destroyed. Kept apart from freshAfterAmnesia so the operator
   *  can distinguish known-cause amnesia from undiagnosable amnesia. */
  freshAfterInconclusiveAmnesia: number
  /** `/mcp reconnect` typed into a live session. */
  reconnected: number
  /**
   * b.f2b: `not-reconnected` launches — the session runs, but the wait for
   * its `working` row ended with nothing typed. Counted in `succeeded` too,
   * as when they were reported as reconnected.
   */
  notReconnected: number
  noop: number
  /**
   * b.jg5 SRJ-1015: `latched` launches: a CONFLICT, an unusable recorded
   * name or a launch with no recorded start latched the persona, or it was
   * latched already. Counted in neither `succeeded` nor `failed`.
   */
  latched: number
  /**
   * b.jg5 SRJ-1015: `retrying` launches, handed to the persona's retry timer
   * (an UNAVAILABLE, ENVIRONMENT, CONFIG or UNCLASSIFIED outcome, a launch
   * timeout included; a reuse's second `ErrInstanceIdCollision`; SRJ-710's
   * lost race; a `transient` reconnect). Counted in neither `succeeded` nor
   * `failed`. A persona the bring-up controller holds `retrying`, a
   * `deferred` launch included, is counted under `notBroughtUp`, never here.
   */
  retrying: number
  /**
   * b.jg5 SRJ-1015: `sequence-waiting` launches, held for the persona's
   * live-row sequence or an old-life hold. Counted in neither `succeeded`
   * nor `failed`.
   */
  sequenceWaiting: number
  /**
   * b.jg5 SRJ-1015, SRJ-207: `held` launches, the persona held on
   * `ErrInvalidFlags`. Counted in neither `succeeded` nor `failed`.
   */
  held: number
  /**
   * b.jg5 SRJ-1015, SRJ-806: `fresh-retired` launches, a retired key's reuse
   * that began its new life. Counted in `succeeded` too, never in
   * `freshSpawned`.
   */
  freshRetired: number
  /**
   * b.f2b: launches still waiting in the background for a `working` row to
   * settle when the pass returned; counted in no other field. Each stays in
   * flight (`isLaunchInFlight`) until it settles, and its outcome is logged
   * then; it is counted in none of the summary's counts.
   */
  waitingInBackground: number
  /** One outcome per persona, by key. */
  perPersona: StartupPersonaOutcome[]
}

/** The counts the start summary line reports (`startupSummaryLine`). */
export type StartupSummaryCounts = Omit<StartupSessionManagerResult, 'perPersona' | 'succeeded' | 'waitingInBackground'>

/**
 * The start summary line's ending, from `failed` on (b.f2b, b.jg5 SRJ-1015):
 * `<n> failed, <n> not brought up, <n> not reconnected`, then SRJ-1015's
 * five counts in its order and words: `, <n> latched, <n> retrying, <n>
 * waiting on a live-row sequence, <n> held on invalid flags, <n> fresh as
 * retired keys`.
 */
export function startupSummaryEnding(
  counts: Pick<StartupSummaryCounts, 'failed' | 'notBroughtUp' | 'notReconnected' | 'latched' | 'retrying' | 'sequenceWaiting' | 'held' | 'freshRetired'>,
): string {
  return (
    `${counts.failed} failed, ${counts.notBroughtUp} not brought up, ${counts.notReconnected} not reconnected, ` +
    `${counts.latched} latched, ${counts.retrying} retrying, ${counts.sequenceWaiting} waiting on a live-row sequence, ` +
    `${counts.held} held on invalid flags, ${counts.freshRetired} fresh as retired keys`
  )
}

/**
 * `startupSessionManager`'s one summary line for a pass over `personaCount`
 * personas (b.wrb, b.fwu, b.f2b, b.jg5 SRJ-1015): the per-outcome counts up
 * to `not reconnected`, then SRJ-1015's five counts
 * (`startupSummaryEnding`). Each launch is counted once, in its own count.
 */
export function startupSummaryLine(personaCount: number, counts: StartupSummaryCounts): string {
  return (
    `[slack] startupSessionManager: complete — ${personaCount} persona(s): ${counts.resumed} resumed, ` +
    `${counts.freshSpawned} fresh-spawned, ${counts.freshAfterAmnesia} fresh-after-amnesia, ` +
    `${counts.freshAfterInconclusiveAmnesia} fresh-after-inconclusive-amnesia, ` +
    `${counts.reconnected} reconnected, ${counts.noop} no-op, ${startupSummaryEnding(counts)}`
  )
}

/**
 * The start pass's one line for a launch its launch pool did not start
 * because the server had begun shutting down (b.jg5 SRJ-205).
 */
export function startLaunchNotStartedForShutdownLine(ref: string): string {
  return `[slack] startupSessionManager: not launching ${ref} — the server has begun shutting down; no agent-director call, counted in no summary count (b.jg5 SRJ-205)`
}

/**
 * On server startup, bring every applied persona up once — a persona listed
 * in several channels still gets exactly one bring-up and one spawn.
 *
 * With `options.bringUp` (the server always passes its bring-up controller)
 * each persona goes through the b.av2 SR-6.1 procedure, in order: the local
 * credentials check (skipped in dry run), the working-directory check, Slack
 * validation and connection (the controller's `bringUp`, which also logs the
 * persona's `persona-start` line), then the launch (`spawnForPersona`). The
 * launch is step 4 as amended by b.jg5 SRJ-1502: "(4) launch, which waits
 * while an old life that may still be running holds the persona's working
 * directory (b.jg5 SRJ-809, SRJ-810); the persona is retried on its
 * UNAVAILABLE retry timer (b.jg5 SRJ-301) until that wait ends."
 * `spawnForPersona`'s old-life gate makes that wait: a persona whose working
 * directory such a hold holds (one on its own row excepted) makes no
 * agent-director call, starts the hold's wait, has its retry timer armed and
 * answers `sequence-waiting`, counted under "waiting on a live-row sequence"
 * (b.jg5 SRJ-1015); it is `up`, its Slack connection serving. Steps
 * 1–3 run for every persona at once, so no persona's Slack connection waits
 * behind another persona's launch; only the launches share a pool of at most
 * `concurrency` (default 3), taken in the order the personas become ready. The
 * pass returns once every persona has an outcome and every `up` persona's
 * launch has settled or is waiting for a `working` row: a `broken` or
 * `retrying` persona is not brought up and never takes a pool slot (its
 * retries run on its own timers, and a retry that succeeds launches it from
 * there). It is counted apart from spawn outcomes, records no startup error,
 * posts no notice and is not a failed spawn. Without `options.bringUp` each
 * persona is launched directly (steps 1–3 skipped), in config order through
 * the same pool; only unit tests of the launch ladder call it that way.
 *
 * b.f2b — one stuck persona must not hold up the others. A launch whose
 * collision ladder starts waiting for a `working` row to settle
 * (`waitForWaitingAndReconnect`, up to `WAIT_FOR_WAITING_TIMEOUT_MS`) is
 * parked: the pass stops waiting for it and frees its pool slot, and the
 * launch goes on in the background. It is reported as `waiting-in-background`
 * (`waitingInBackground`), stays in flight until it settles (so the health
 * check skips it, a restart joins it and a teardown waits for it, as for any
 * launch in flight), and its outcome is logged when it settles. So the health
 * check and the reload detection tick, which start once the pass returns, are
 * not held up by one persona's wait (b.av2 SR-8.2 keeps its intent: every
 * persona's bring-up has read its credentials by then).
 *
 * b.jg5 SRJ-205 — a shutdown stops the pass's launches. With
 * `options.isShuttingDown` (the server passes a query reading its
 * `shuttingDown` flag live), the launch pool asks it right before starting
 * each launch; once it answers true (a throw counts as true) no queued
 * launch starts: each is recorded `not-launched-shutdown` with one line
 * (`startLaunchNotStartedForShutdownLine`) and no agent-director call, is
 * counted in no summary count and never failed, and the pass still
 * resolves. A launch already running is not interrupted. Steps 1–3 are not
 * affected. Without the option every launch runs.
 *
 * b.jg5 SRJ-1015 — every launch result is counted once, in its own count:
 * `latched`, `retrying`, `sequence-waiting`, `held` and `fresh-retired` each
 * have their own (`fresh-retired` in `succeeded` too, never `freshSpawned`;
 * the other four in neither `succeeded` nor `failed`). A `deferred` launch is
 * counted under `notBroughtUp`, as the bring-up controller's `retrying` is.
 * The one summary line is `startupSummaryLine`'s.
 *
 * Per-persona launch failures are logged and recorded in startup-errors.log
 * but never crash the server. cozempic availability is probed in the
 * background (non-blocking).
 */
export async function startupSessionManager(
  config: PersonaConfig,
  options?: { concurrency?: number; bringUp?: StartupBringUpDeps; isShuttingDown?: () => boolean },
): Promise<StartupSessionManagerResult> {
  await checkCozempicAvailable()

  const personas = config.personas
  const concurrency = options?.concurrency ?? 3

  console.error(
    `[slack] startupSessionManager: ${personas.length} persona(s), concurrency=${concurrency}`,
  )

  const perPersona: StartupPersonaOutcome[] = []
  const bringUp = options?.bringUp
  const launchSlot = createLaunchPool(Math.max(1, concurrency), options?.isShuttingDown)
  let succeeded = 0
  let failed = 0
  let notBroughtUp = 0
  let resumed = 0
  let freshSpawned = 0
  let freshAfterAmnesia = 0
  let freshAfterInconclusiveAmnesia = 0
  let reconnected = 0
  let notReconnected = 0
  let noop = 0
  let latched = 0
  let retrying = 0
  let sequenceWaiting = 0
  let held = 0
  let freshRetired = 0
  let waitingInBackground = 0

  /** Count one launch result once, in its own count (b.jg5 SRJ-1015): every action is named. */
  function tally(action: SpawnPersonaResult['action']): void {
    switch (action) {
      case 'failed':
        failed++
        break
      case 'spawned':
        freshSpawned++
        succeeded++
        break
      case 'resumed':
        resumed++
        succeeded++
        break
      case 'not-reconnected':
        notReconnected++
        succeeded++
        break
      case 'fresh-after-amnesia':
        freshAfterAmnesia++
        succeeded++
        break
      case 'fresh-after-inconclusive-amnesia':
        freshAfterInconclusiveAmnesia++
        succeeded++
        break
      case 'reconnected':
        reconnected++
        succeeded++
        break
      case 'no-op':
        noop++
        succeeded++
        break
      case SPAWN_ACTION_FRESH_RETIRED:
        // b.jg5 SRJ-806, SRJ-1015: a retired key's reuse that began its new
        // life started its persona, but is not an ordinary fresh spawn.
        freshRetired++
        succeeded++
        break
      case 'latched':
        // b.jg5 SRJ-502, SRJ-1015: neither failed nor succeeded.
        latched++
        break
      case SPAWN_ACTION_RETRYING:
        // b.jg5 SRJ-1015, SRJ-301: handed to the retry timer; neither failed
        // nor succeeded.
        retrying++
        break
      case 'sequence-waiting':
        // b.jg5 SRJ-706, SRJ-1015: held for a live-row sequence or an
        // old-life hold; neither failed nor succeeded.
        sequenceWaiting++
        break
      case 'held':
        // b.jg5 SRJ-207, SRJ-1015: held on ErrInvalidFlags; neither failed
        // nor succeeded.
        held++
        break
      case 'deferred':
        // Bug b.g57, b.jg5 SRJ-1015: the bring-up controller holds it
        // retrying, so it is not brought up, never `retrying`.
        notBroughtUp++
        break
      default: {
        const unknown: never = action
        console.error(`[slack] startupSessionManager: unknown launch result action ${String(unknown)} — counted in no count`)
        break
      }
    }
  }

  /**
   * Steps 1–3 (with `bringUp`, outside the pool), then step 4 through the
   * launch pool; the launch alone without `bringUp`. Undefined when not
   * brought up (recorded here). `waiting-in-background` once the launch
   * waits for a `working` row (b.f2b): its pool slot is freed then.
   * `not-launched-shutdown` when the pool did not start it (b.jg5 SRJ-205).
   */
  async function launchPersona(persona: Persona): Promise<StartLaunchResult | undefined> {
    if (bringUp) {
      const started = await bringUp.bringUp(persona, personas)
      if (started.outcome !== 'up') {
        perPersona.push({ key: persona.key, action: 'not-brought-up', outcome: started.outcome, failures: started.failures })
        notBroughtUp++
        return undefined
      }
    }
    return launchSlot(() => launchOrPark(persona, config))
  }

  async function processPersona(persona: Persona): Promise<void> {
    try {
      const result = await launchPersona(persona)
      if (result === undefined) return
      if (result === WAITING_IN_BACKGROUND) {
        perPersona.push({ key: persona.key, action: WAITING_IN_BACKGROUND })
        waitingInBackground++
        return
      }
      if (result === NOT_LAUNCHED_FOR_SHUTDOWN) {
        // b.jg5 SRJ-205: no launch once a shutdown has begun; counted in no count.
        console.error(startLaunchNotStartedForShutdownLine(personaRef(persona)))
        perPersona.push({ key: persona.key, action: NOT_LAUNCHED_FOR_SHUTDOWN })
        return
      }
      if (result.action === 'deferred') {
        // Bug b.g57: its claude_config_dir cannot be resolved; the bring-up
        // controller holds it retrying and launches it once it resolves.
        const failures = result.deferredBy === undefined ? [] : [result.deferredBy]
        perPersona.push({ key: persona.key, action: 'not-brought-up', outcome: 'retrying', failures })
      } else {
        perPersona.push({ key: persona.key, action: result.action })
      }
      tally(result.action)
    } catch (err) {
      const ref = personaRef(persona)
      // Token-safe: the launch covers the persona's Slack bring-up, so the
      // thrown value's message can carry secrets. Only the describer's output
      // (type, code, message through `redactSlackLogText`, frames) reaches
      // the log and startup-errors.log.
      const cause = describeThrownValue(err)
      console.error(`[slack] startupSessionManager: unexpected error for ${ref}: ${cause}`)
      recordStartupError('spawn-failed', `unexpected error spawning ${ref}: ${cause}`)
      perPersona.push({ key: persona.key, action: 'failed' })
      failed++
    }
  }

  await Promise.all(personas.map((persona) => processPersona(persona)))

  const counts: StartupSummaryCounts = {
    failed,
    notBroughtUp,
    resumed,
    freshSpawned,
    freshAfterAmnesia,
    freshAfterInconclusiveAmnesia,
    reconnected,
    notReconnected,
    noop,
    latched,
    retrying,
    sequenceWaiting,
    held,
    freshRetired,
  }
  // b.wrb/b.fwu: honest breakdown. A fresh-spawn that replaced a resume because
  // the transcript was missing is reported separately and never folded into a
  // generic "ok". b.fwu splits that amnesia into DIAGNOSED (fresh-after-amnesia:
  // we know whether history was lost) vs UNDIAGNOSABLE
  // (fresh-after-inconclusive-amnesia: we could not tell). b.f2b: a session
  // left running but not reconnected has its own bucket after `not brought
  // up`; b.jg5 SRJ-1015's five counts follow it.
  console.error(startupSummaryLine(personas.length, counts))
  if (freshAfterAmnesia > 0) {
    // Loud, grep-friendly signal that some personas lost their resume target.
    // Per-persona "lost vs never-created" detail was already emitted (and, for
    // 'lost', recorded to startup-errors) by diagnoseJsonlMissing.
    console.error(
      `[slack] startupSessionManager: ${freshAfterAmnesia} persona(s) were fresh-spawned after ErrJsonlMissing ` +
        `(transcript could not be resumed) — see per-persona "ErrJsonlMissing diagnostic" lines above.`,
    )
  }
  if (freshAfterInconclusiveAmnesia > 0) {
    // b.fwu: a separate, louder signal — these personas were fresh-spawned but
    // the diagnosis machinery could not tell whether history was destroyed. That
    // degraded-diagnosis condition correlates with the storage faults that cause
    // real loss, so it warrants its own attention. Each was recorded to
    // startup-errors as JSONL_DIAGNOSIS_INCONCLUSIVE_ENTRY_CLASS.
    console.error(
      `[slack] startupSessionManager: ${freshAfterInconclusiveAmnesia} persona(s) were fresh-spawned after ` +
        `ErrJsonlMissing WITHOUT a conclusive diagnosis — could NOT determine whether conversation history was ` +
        `lost. See per-persona "ErrJsonlMissing diagnostic ... INCONCLUSIVE" lines and the ` +
        `'${JSONL_DIAGNOSIS_INCONCLUSIVE_ENTRY_CLASS}' startup errors above.`,
    )
  }
  if (waitingInBackground > 0) {
    console.error(
      `[slack] startupSessionManager: ${waitingInBackground} persona(s) still waiting in the background for a working row ` +
        `to settle — not counted above; each logs its outcome when it settles (b.f2b)`,
    )
  }

  return {
    succeeded,
    ...counts,
    waitingInBackground,
    perPersona,
  }
}

/**
 * b.f2b: one start launch, or `waiting-in-background` as soon as its
 * collision ladder starts waiting for a `working` row to settle. From then on
 * the launch goes on in the background, in flight until it settles, and
 * `followParkedLaunch` logs its outcome. A launch that rejects before that
 * rejects here, as before.
 */
async function launchOrPark(persona: Persona, config: PersonaConfig): Promise<StartLaunchResult> {
  let park: () => void = () => {}
  const parked = new Promise<typeof WAITING_IN_BACKGROUND>((resolve) => {
    park = () => resolve(WAITING_IN_BACKGROUND)
  })
  const launch = spawnForPersona(persona, config, true, { onWorkingRowWait: () => park() })
  const first = await Promise.race([launch, parked])
  if (first === WAITING_IN_BACKGROUND) followParkedLaunch(persona, launch)
  return first
}

/**
 * b.f2b: log that the start pass goes on without a parked launch, and its
 * outcome once it settles: its `SpawnPersonaResult` action, so `reconnected`
 * only when `/mcp reconnect` was typed and `not-reconnected` when the wait
 * gave up with the session alive (the wait's own line says what happens
 * next). A rejection is logged and recorded as the start pass records one;
 * never rethrown.
 */
function followParkedLaunch(persona: Persona, launch: Promise<SpawnPersonaResult>): void {
  const ref = personaRef(persona)
  console.error(
    `[slack] startupSessionManager: ${ref} is waiting for its working row to settle — the start pass goes on without it; its launch stays in flight in the background (b.f2b)`,
  )
  launch.then(
    (result) => console.error(`[slack] startupSessionManager: background launch for ${ref} settled: ${result.action} (b.f2b)`),
    (err: unknown) => {
      // Token-safe, as in the start pass: only the describer's output.
      const cause = describeThrownValue(err)
      console.error(`[slack] startupSessionManager: unexpected error in the background launch for ${ref}: ${cause}`)
      recordStartupError('spawn-failed', `unexpected error spawning ${ref}: ${cause}`)
    },
  )
}

/**
 * A first-in, first-out pool: `run(task)` starts `task` once fewer than
 * `size` tasks are running, in the order `run` was called, and settles with
 * its result.
 *
 * b.jg5 SRJ-205: `isShuttingDown`, when given, is asked right before each
 * task would start (one arriving while a slot is free, and a queued one when
 * a slot frees). Once it answers true (a throw counts as true) the task is
 * not started and `run` settles with `NOT_LAUNCHED_FOR_SHUTDOWN`; the slot
 * passes on at once, so the waiting queue drains and every queued caller
 * settles. A task already running is not interrupted. Without it every task
 * starts.
 */
function createLaunchPool(
  size: number,
  isShuttingDown?: () => boolean,
): <T>(task: () => Promise<T>) => Promise<T | typeof NOT_LAUNCHED_FOR_SHUTDOWN> {
  let running = 0
  const waiting: Array<() => void> = []
  const shuttingDown = (): boolean => {
    if (isShuttingDown === undefined) return false
    try {
      return isShuttingDown() === true
    } catch {
      return true
    }
  }
  return async <T>(task: () => Promise<T>): Promise<T | typeof NOT_LAUNCHED_FOR_SHUTDOWN> => {
    if (running >= size) await new Promise<void>((resolve) => waiting.push(resolve))
    else running++
    try {
      if (shuttingDown()) return NOT_LAUNCHED_FOR_SHUTDOWN
      return await task()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else running--
    }
  }
}

// ---------------------------------------------------------------------------
// launchSession — restart.ts adapter
// ---------------------------------------------------------------------------

/**
 * Restart-adapter shim for restart.ts (`RestartDeps.launchSession`): launch
 * the applied persona with this key. Runs step 4 of the start procedure only:
 * a restart never repeats the credentials, working-directory or Slack steps.
 *
 * `options.canLaunch` (the server passes `createPersonaRelaunchGate`) is
 * asked first, before the persona is looked up: when it answers false — the
 * persona is not up (its Slack connection is not serving, or its bring-up is
 * broken or retrying) or its key is no longer applied (b.av2 SR-8.6) —
 * nothing is launched and the result is `'skipped'`, which restart.ts counts
 * as neither a success nor a failure. Asking it first keeps a key a
 * confirmed apply removed from counting as a failure. restart.ts asks the
 * same gate before any kill or reconnect; this check covers a flip in
 * between.
 *
 * Returns true on any non-failed action (spawned / fresh-retired / resumed /
 * reconnected / not-reconnected / no-op; b.jg5 SRJ-806: a retired key's reuse
 * that began its new life is a success as `spawned` is; b.f2b: `not-reconnected` counts as it did when it
 * was reported as `reconnected`, so SR-25.1 counting is unchanged), false on
 * `failed` or when no applied persona has the key,
 * `'skipped'` for `deferred` (bug b.g57: its claude_config_dir cannot be
 * resolved; nothing was launched and its row is kept), for `latched` (b.jg5
 * SRJ-502, SRJ-1015: the persona is latched, or latched at this launch;
 * nothing more was launched, and the latch stops its retry timer), for
 * `held` (b.jg5 SRJ-207, SRJ-1015: the persona is held on `ErrInvalidFlags`,
 * or held at this launch; nothing more was launched, and the hold stops its
 * retry timer) and for a `failed`
 * marked `stopping` (the version re-check of a resume or of the launch wait's
 * evidence read decided the stop), which
 * count toward no failure or cap, and `'refused'` for `retrying` (b.jg5
 * SRJ-1015, SRJ-301: its retry timer owns the persona) and for
 * `sequence-waiting` (b.jg5 SRJ-706, SRJ-1015: the persona's live-row
 * sequence runs or an old-life hold holds), never `'skipped'`, which would
 * stop the retry timer; the restart path never counts either (SRJ-302). The richer `SpawnPersonaResult` is collapsed here
 * because the restart subsystem only cares about did-it-relaunch.
 *
 * `options.deadEvidence` is the escalate-dead verdict the restart path's
 * relaunch carries (b.jg5 SRJ-611), handed to `spawnForPersona` unchanged;
 * absent, the launch is as it always was.
 */
export async function launchSession(
  key: string,
  config: PersonaConfig,
  options?: { canLaunch?: (key: string) => boolean; deadEvidence?: CarriedDeadEvidence },
): Promise<boolean | 'skipped' | 'refused'> {
  if (options?.canLaunch && !options.canLaunch(key)) return 'skipped'
  const persona = config.personas.find((p) => p.key === key)
  if (!persona) return false
  const result = await spawnForPersona(persona, config, false, undefined, options?.deadEvidence)
  // b.jg5 SRJ-1015: a latched or held persona records nothing; the latch or
  // the hold stops its retry timer (SRJ-305, SRJ-207).
  if (result.action === 'deferred' || result.action === 'latched' || result.action === 'held' || result.stopping) {
    return 'skipped'
  }
  // b.jg5 SRJ-1015, SRJ-706, SRJ-811: a launch handed to P's retry timer, or
  // held for P's live-row sequence or an old-life hold or its wait (either
  // `sequenceWaitingCause`), records nothing and is a refusal at a retry,
  // which re-arms the timer (SRJ-302).
  if (result.action === SPAWN_ACTION_RETRYING || result.action === 'sequence-waiting') return 'refused'
  return result.action !== 'failed'
}
