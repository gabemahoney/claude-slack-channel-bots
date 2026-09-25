/**
 * test-helpers/reload-harness.ts — The shared reload harness (b.av2 SR-13.4):
 * the reload controller (`src/reload.ts`) over a temp configuration directory,
 * a manual tick driver, a lifecycle recorder and the real bring-up checks.
 *
 * `makeReloadHarness(opts?)` builds, under one fresh `mkdtempSync` root
 * (real-path resolved, so symlink comparisons hold):
 *
 * - `h.dir`: the configuration directory. It holds only the SR-8.1 files,
 *   named in `h.paths` (`config`, `pending`, `apply`, `lastApplied`, from
 *   `reloadFilePaths`), so `h.configDirEntries()` shows exactly what the
 *   controller left there (no temporary sibling, no stray file);
 * - `h.home`: a temp home handed to the controller, so a `~` in a
 *   test-written configuration expands under it, never the operator's home;
 * - persona fixtures: `h.persona(name, overrides?)` is a file-form persona
 *   (`makePersona`) with its own `all` channel and its credentials file and
 *   working directory under `<root>/personas/<key>/`. Nothing is created on
 *   disk until the test asks: `h.writeCredentials(persona)` writes a valid
 *   file (mode 0600, through `writeCredentialsFile`) holding a fresh
 *   sentinel-bearing token set and returns it (each call rotates: the tokens
 *   differ from every earlier set); `h.writeCredentialsContent(persona, c)`
 *   writes invalid or hand-shaped content; `h.makeWorkingDirectory(persona)`
 *   creates the directory; `h.materialize(...personas)` does both for each.
 *   `h.tokens(name)` is the persona's latest valid set. A persona whose
 *   first credentials are written after a run was built (a brand-new file
 *   created while the server runs, AC 22) is registered with that run's stub
 *   factory then, so its tokens route to its own stub (`run.stub(name)`,
 *   scripted by the run's `opts.slack[name]`);
 * - credentials rotations (b.av2 SR-8.6 credentials row): every set written
 *   has a harness label, `credentials-<n>` (`h.credentialsLabel(name)` is
 *   the latest). `h.rotateCredentials(persona, { slack? })` is
 *   `h.writeCredentials` returning `{ tokens, label }`, with `slack`
 *   scripting the new set: a live run that already routes the persona
 *   registers the new pair as another credential set of it
 *   (`addCredentials`), with its own stub, identity and script, so a
 *   reconnect builds its clients there while the old set keeps serving
 *   (`h.writeCredentials` does the same, unscripted). `run.credentialsStub(
 *   name, label?)` is a set's stub in that run, `run.currentStub(name)` the
 *   one whose socket connected last (the set serving it now), and
 *   `run.socketActivity(name)` the persona's socket clients' events in
 *   order, labelled by set (`'connected credentials-2'`, `'discarded
 *   credentials-1'`, …), which tells "new opened, then old closed" apart.
 *   Its current identity is `run.connections.manager.identity(key)`; a
 *   set's scripted one is `run.credentialsStub(name, label).identity`;
 * - configuration and record files: `h.writeConfig(input)` and
 *   `h.writeRecord(input)` write `input` as JSON in the same format (so the
 *   same input gives byte-identical files) and return the bytes;
 *   `h.writeConfigBytes` / `h.writeRecordBytes` write raw bytes (syntax
 *   errors, pre-persona shapes); `h.readConfig()` / `h.readRecord()` read
 *   them back (undefined when absent); `h.remove(path)` deletes a path and
 *   `h.replaceWithDirectory(path)` puts a directory there (unreadable as a
 *   file even as root). Every helper refuses a path outside the root;
 * - the AC 20 directory sweep: `h.serverSideFiles(...operatorWritten)` is
 *   every regular file under the root but those, keyed by root-relative
 *   path, for `assertNoLeak` (names and contents);
 * - edits between ticks (detection, b.av2 SR-8.2, SR-8.3):
 *   - config: `h.writeConfig` / `h.writeConfigBytes`, `h.deleteConfig()`,
 *     `h.replaceWithDirectory(h.paths.config)`;
 *   - credentials: `h.writeCredentials(persona)` rotates to a new valid set,
 *     `h.writeCredentialsContent(persona, c)` writes invalid content,
 *     `h.deleteCredentials(persona)`, `h.makeCredentialsUnreadable(persona)`
 *     (a directory), `h.makeFifo(path)` (guard with `mkfifoAvailable()`);
 *     `h.saveCredentials(persona)` returns a function restoring the file's
 *     exact bytes (or its absence, or the unreadable directory) and its token
 *     set, to revert an edit;
 *     `h.readCredentialsBytes(persona)`, and `h.credentialsDigestOf(persona)`,
 *     the production reader's digest or marker for the file as it stands, to
 *     compare with `run.bringUps.credentialsDigest(key)` (never print it);
 *   - the pending file: `h.pendingExists()`, `h.readPending()` /
 *     `h.readPendingText()` (undefined unless a regular file),
 *     `h.pendingFingerprint()` (`parsePendingFingerprint`), and
 *     `h.writePendingBytes(b)` for a leftover or hand-placed file;
 *   - the preview in the pending file (b.av2 SR-8.4): `h.pendingBody()` is
 *     the text after the two fingerprint lines and the blank line (found
 *     through `parsePendingFingerprint` and `composePendingFile`, not by
 *     re-parsing the layout), without the final newline, so it equals
 *     `renderPreview(plan)`; `h.pendingLines()` its lines,
 *     `h.pendingHeader()` the first (the counted header, the `no effective
 *     change` header or the `INVALID:` line) and
 *     `h.pendingDestructiveLines()` those starting `DESTRUCTIVE:`. Each is
 *     undefined when the file is absent, not a regular file or not in the
 *     pending layout;
 * - prospective bring-up fixtures, for an added persona that cannot come up
 *   (b.av2 SR-8.4, SR-6.1 steps 1 and 2):
 *   `h.preparePersona(name, { credentials?, workingDirectory? }, overrides?)`
 *   is `h.persona(name, overrides)` with its files left in the stated
 *   states: credentials `valid` (default, `h.writeCredentials`), `missing`,
 *   `invalid` (parseable, no `bot_token`) or `unreadable` (a directory);
 *   working directory `present` (default), `missing` or `file` (a plain
 *   file). Singly: `h.deleteWorkingDirectory(persona)`,
 *   `h.makeWorkingDirectoryAFile(persona)`, with `h.deleteCredentials`,
 *   `h.makeCredentialsUnreadable` and `h.writeCredentialsContent` above.
 *   The controller judges these with the real checks (below), never canned
 *   outcomes;
 * - the write-failure seam: `h.failWrites({ step?, code?, call? })` makes the
 *   controller's durable writer (`durableWriteFileSync` over an fs seam, as
 *   in production) throw an errno-style error at that `DurableWriteFs` call
 *   (default `openSync`, `EIO`) until `h.clearWriteFailure()`: every call of
 *   the step, or only its `call`-th call (1-based, counted from
 *   `failWrites`), e.g. `{ step: 'fsyncSync', call: 2 }` for the directory
 *   fsync after the rename. `h.failRemoves(...)` / `h.clearRemoveFailure()`
 *   do the same for the controller's durable delete (`durableUnlinkSync`
 *   over its own seam, default `unlinkSync`; `{ step: 'fsyncSync' }` fails
 *   the directory fsync after the unlink). The two seams count calls apart.
 *   File permissions are never the seam: the suite may run as root;
 * - confirmations (b.av2 SR-8.5): `h.confirm()` is the operator's gesture
 *   exactly, one rename of `paths.pending` to `paths.apply` with no content
 *   change (AC 73); `run.confirmPending()` is a tick that must write the
 *   pending file, that rename, then the applying tick, returned unawaited as
 *   `{ applying }`; `run.beforeApplySteps(hook)` runs `hook` once at the
 *   next apply's step 1, after the applied set was swapped and before step 2
 *   (to change the file system between the candidate's validation and steps
 *   4 and 6, b.av2 SR-1.4 apply part); `h.writeApplyBytes(b)` places any bytes at the apply
 *   path (an older copy of the pending file kept with `h.readPending()`, for
 *   the stale gesture, or garbage for a malformed one); `h.applyExists()` and
 *   `h.readApply()` show what is there. A confirmation that cannot be deleted
 *   is `h.failRemoves()` (its own unlink seam, never permissions);
 * - `h.writeOversized(path, { prefix?, size? })` writes a file larger than
 *   the 64 KiB read cap (`MAX_RELOAD_FILE_BYTES + 1` bytes by default):
 *   `prefix`, then sentinel-bearing fake-token text, so a leak of its
 *   content shows in `assertNoLeak`.
 *
 * A run (`h.build(opts?)`, or `h.start(opts?)` = build, `resolveStart`, then
 * `runStartBringUp` when the start resolved `applied`) is one server start.
 * `h.start` arms no detection tick; `h.startDetecting(opts?)` = `h.start`
 * then `run.startDetection()`, as `main()` does, and throws when nothing was
 * armed (to test a refused or early `startDetection`, call it yourself).
 * Each run builds, fresh:
 *
 * - `run.connections`: `makeConnectionHarness` over the personas the harness
 *   wrote credentials for, registering each one's latest token set with a new
 *   `makeStubSlackFactory` (so a start after a rotation routes the rotated
 *   tokens), the real connection manager and a fake clock (`run.clock`).
 *   `opts.slack` scripts a persona's stub by name: unscripted it comes up,
 *   `SLACK_UNREACHABLE` leaves it `retrying` (for good, however far the clock
 *   advances) and `SLACK_AUTH_REJECTED` (`invalid_auth`) leaves it `broken`;
 *   each holds the digest of the credentials bytes its bring-up read. A
 *   record in which two personas share one `credentials_file` (e.g.
 *   `h.persona('bravo', { credentials_file: alpha.credentials_file })`) leaves
 *   both `broken`, each holding the digest of its own path's bytes: the file
 *   is read (stat-first) only to be hashed, never parsed, and no token from
 *   it reaches a Slack client.
 *   `opts.dryRun` reaches the manager, the bring-up controller and the reload
 *   controller as a flag (`process.env` is never read or set);
 *   `opts.configFs` overrides the controller's file-system seam for reading
 *   the record, the configuration file and the pending file
 *   (`PersonaConfigFs`); `opts.credentialsFs` overrides the detection tick's
 *   credentials reads (`CredentialsFs`, e.g. an `fstatFile` reporting a FIFO);
 * - `run.bringUps`: the real `createPersonaBringUpController` over that
 *   manager and clock, so the start runs the real credentials check, the real
 *   working-directory check and the real-path "no other applied persona"
 *   rule. `opts.bringUpFs` overrides its file-system seam;
 * - `run.lifecycle`: the recorder. Its `ops` are the controller's
 *   `ReloadLifecycleOps`. The start pass (`startBringUp`) brings every
 *   applied persona up at once through `run.bringUps` and launches each one
 *   that ends `up`; a launch is only recorded (nothing is spawned; with
 *   `opts.realLaunch` it runs the real launch path, below).
 *   `bringUp` does the same for one persona; `teardown` cancels the persona's
 *   bring-up and stops its connection (for the old half of a destructive
 *   modify, whose key stays applied, it refuses a persona that has had a `dm`
 *   destination, as below); `refreshTemplate` (step 5) is recorded as a
 *   `template-refresh` record (key `TEMPLATE_REFRESH_KEY`) and calls
 *   nothing; `updateInPlace` is recorded (with the
 *   changed `settings`) and does nothing else; `reconnectCredentials` (step
 *   4) runs the real controller's `changeCredentials` over the manager (the
 *   real reconnect: new connection first, the 10 s `start()` bound and the
 *   SR-3.2 retries on `run.clock`) and records how it settled (`change`); a
 *   recovery bring-up (`{ recovery: true }`, step 6) is recorded with
 *   `recovery: true`, cancels its bring-up, stops its connection and
 *   brings it up afresh. These two stand-ins cover only what they do as the
 *   lifecycle does: they never forget a cached DM conversation (the
 *   lifecycle's forget), so a reconnect or recovery of a persona that has had
 *   a `dm` destination in this run, and a recovery of a persona no longer
 *   credentials-broken when it runs (the lifecycle applies the change as a
 *   reconnect then), need `opts.realLifecycle`: the stand-in rejects the
 *   call and `h.cleanup()` throws, naming it. With `opts.realLifecycle`, `bringUp` (a recovery
 *   included), `teardown`, `reconnectCredentials`, `updateInPlace` and
 *   `refreshTemplate` run the real composition instead (`run.composition`, see
 *   `RealLifecycleComposition`: `createPersonaLifecycle` over the run's
 *   controller and manager, a real serializer, the run's destination
 *   resolver, the real agent-director kill and delete over a `makeStubClient`
 *   stub, `opts.agentDirector`, a recorded launch, the template refresh over
 *   that stub keeping `installedTemplate`, and never shutting down). The
 *   controller's default step bodies call them for every confirmed apply run
 *   without `opts.applySteps`: step 2 tears down each removed persona and the
 *   old half of each destructive modify (`credentials_file` path,
 *   `working_directory`), step 6 brings up each added persona and the new
 *   half, so a destructive modify is a `teardown` then a `bring-up` record
 *   of the same key; step 5 runs only when the plan's config directories
 *   changed; a next-launch change (`claude_config_dir`,
 *   `stop_hook_bootstrap`) gets no record. Every call is a
 *   `ReloadLifecycleRecord` in call order (`records`, `of(op)`, `keys(op)`);
 *   a bring-up record gets its `result` (outcome `up`/`broken`/`retrying` and
 *   each failure's class) when it resolves (`outcome(key)`, `classes(key)`).
 *   `startPasses` holds the applied configuration of each start pass;
 *   `holdStartPass()` keeps the next start pass from resolving until the
 *   returned release is called, or makes it reject once `release.fail(err)`
 *   is called (a start pass that throws after its bring-ups and launches).
 *   Apply-time calls: `hold(op, key)` holds the next `teardown`,
 *   `update-in-place`, `reconnect` or `bring-up` of one persona before its body runs
 *   until `release()`, or makes it reject with `fail(err)`; `timeline` lists
 *   every apply-time teardown, in-place update, reconnect and bring-up as it started and
 *   settled or rejected, across personas and steps (b.av2 SR-8.6 step order
 *   without timing); `hold('template-refresh')` holds step 5 the same way,
 *   and `applyTimeline` is `timeline` with step 5 in its place. The bring-up controller's `onLeftUp` is server.ts's
 *   `createNotUpSessionDropper` over the real `dropPersonaSession`, so a
 *   persona that stops being up has its registered session dropped (one
 *   line). `run.serverConfig()` is `server.ts`'s `personaConfig`
 *   (`configInEffect`: the applied persona set over the start's server-wide
 *   settings), which every consumer and real launch reads; `h.readRecord()`
 *   holds a changed server-wide value, and a later `h.start()` over the same
 *   directories (the next server start) runs it. With `opts.realLifecycle` the manager gets the composition's
 *   serializer (`makeConnectionHarness`'s `serialize`, as `server.ts` passes
 *   `personaLifecycle.run`), so a b.ujn mark's network close of its detached
 *   socket waits for the persona's serializer turn (behind a lifecycle
 *   operation of that persona in flight; a `hold` gate is outside the
 *   serializer and holds no turn). Without it the manager
 *   gets no serializer, like the recorder's stand-ins (which take none), and
 *   that close runs at once;
 * - the real consumers of the applied settings (b.av2 SR-13.1), wired as
 *   `server.ts` wires them and reading the controller's applied
 *   configuration at each use: the routing (`createPersonaRouting`) behind
 *   the real event router on the manager's `onEvent`, and one destination
 *   resolver, destination hold (on its own fake clock, never the real one or
 *   `run.clock`) and notifier (`makeNotifierStack`), whose up-flush listener
 *   joins the bring-up controller on `onStatus`; with `opts.realLifecycle`
 *   the composition's `destinations.forget` is that resolver's. Post-apply
 *   drivers (b.av2 SR-13.1): `run.registerSession(name)` registers the
 *   persona's MCP session in the real registry (`run.session(name)` is it
 *   now, compared by identity to show it was kept); `run.deliver(name,
 *   event)` delivers an event on its socket stub, and `run.deliveries(name)`
 *   is what reached its session (`chat_id`, `via`, `content`);
 *   `run.notice(name, text)` raises a notice through the notifier (its Slack
 *   calls are on `run.stub(name).callLog`); `run.callTool(name, tool,
 *   args)` calls an MCP tool as its instance over `createSessionServer`.
 *   Deliver only to a persona with a registered session (a lost message
 *   would reach the restart module, which the harness does not set up).
 *   The routing and the MCP tools get the server-wide reply settings
 *   (`ack_reaction`, `reply_chunk_limit`, `reply_chunk_mode`) as server.ts's
 *   `getReplySettings` reads them: from `run.serverConfig()` at call time
 *   (so after an apply, the start's values), with no reaction, 4000 and
 *   `newline` when the config sets none; set them in the config the run
 *   starts with. A delivery makes a `users.info` call (the author's name),
 *   and, by default, no ack reaction. `run.noticeClock` is the destination
 *   hold's clock.
 *   Not-up personas (b.av2 SR-6.3, SR-6.4): `run.isUp(name)` is server.ts's
 *   up check (`createPersonaUpPredicate`), `run.admitSession(name)` its MCP
 *   admission (`decideSessionAdmission`: registers when admitted, else one
 *   refusal line), and `run.bringUps.state(key)` the up/broken/retrying
 *   state. Breaking a running persona: `run.revokeBotToken(name, opts?)`
 *   scripts `token_revoked` (or `opts.error`) at the front of every Web API
 *   queue of its current stub, so the first call a consumer makes (a notice,
 *   a tool call, a delivery's `users.info`) marks it broken (bug b.ujn);
 *   `run.refuseReopen(name, error?)` drops its socket with a refused reopen
 *   queued and resolves once it is broken. `run.linesOf(name)` is every log
 *   line naming the persona (lifecycle, bring-up, manager, diagnostics);
 * - `run.ticks`: a manual `ReloadTickDriver`. Nothing runs until the test
 *   calls `tick()` or `ticks(n)` (each awaited until the pass settles; `tick`
 *   rejects when nothing is armed); no real timer is ever armed. `armed`,
 *   `startCalls`, `stopCalls` and `ticksRun` show how the controller used it.
 *   `opts.tickDriver` swaps in another driver (the production one on
 *   `run.clock`) for the single 5 s cadence case; `run.ticks` is then unused;
 * - `run.controller`: the real `createReloadController` over `h.paths`, the
 *   recorder's ops, the seam writer and remover, `run.ticks`, the dry-run
 *   flag, `heldCredentialsDigest` bound to `run.bringUps.credentialsDigest`
 *   (as `server.ts` binds it; `opts.heldCredentialsDigest` wraps that lookup,
 *   e.g. to make it throw so a detection pass fails), `bringUpState` bound
 *   to `run.bringUps.state` (as `server.ts` binds it; `opts.bringUpState`
 *   wraps it the same way, e.g. to throw so the preview leaves a fact out),
 *   the stub factory and `h.home`. The tick's prospective checks of an
 *   added persona are the controller's own: the real credentials content
 *   check over the bytes the tick read (none in dry run) and the real
 *   working-directory check (`checkPersonaWorkingDirectory`) over the temp
 *   directory. Both seams (the credentials reads through
 *   `opts.credentialsFs` when given) are wrapped to record what the tick
 *   touched:
 *   `run.tickCredentialsReads` (every credentials path the tick opened; it
 *   stays empty in dry run, b.av2 SR-3.4, SR-8.2) and
 *   `run.tickDirectoryChecks` (every working directory it stat'd). Neither
 *   is part of `since`; slice them by length around a stretch of ticks.
 *   `run.resolveStart()` calls its `resolveStart` and keeps the outcome as
 *   `run.outcome`; `run.startDetection()` calls its `startDetection`.
 *   A confirmed apply (b.av2 SR-8.6): `opts.applySteps` is handed to the
 *   controller as its step 2–6 slots (none bound by default);
 *   `run.appliedConfigs` holds every configuration its `onApplied` was told
 *   (`opts.onApplied` is called too), and `run.appliedKeys()` is the
 *   controller's applied persona keys now (`controller.applied()`).
 *   `opts.beforeWrite(path)` runs before every writer call, e.g. to see
 *   whether `paths.apply` still exists when the record is written;
 * - captures: `run.logs` is the one `[slack]` stream (reload controller,
 *   bring-up controller and connection manager lines, in order), and
 *   `run.logsOf(label)` its lines starting `[slack] <label>: ` (a class such
 *   as `RELOAD_NOTHING_PENDING`, or `'reload'` for the unclassed failures);
 *   `run.invalidLines()` is `logsOf(RELOAD_INVALID)`;
 * - preview emissions (b.av2 SR-8.4, SR-10.3): one logged preview spans
 *   several `reload-preview` lines, the first (the header) starting
 *   `PREVIEW_EMISSION_START` (`[slack] reload-preview: ` then
 *   `PENDING_PREVIEW_TITLE`). `run.previewEmissions()` groups `run.logs`
 *   into emissions (a header and the `reload-preview` lines right after
 *   it), `run.previewEmissionCount()` counts them,
 *   `run.lastPreviewEmission()` is the latest one's full log lines and
 *   `run.lastPreviewText()` the same as body lines (prefix removed, and the
 *   header's ` (preview in "<h.paths.pending>")` suffix), which equals
 *   `h.pendingLines()` when the file was written. The exported
 *   `previewEmissions(lines)` and `previewEmissionText(emission, path)` do
 *   the same over any slice, e.g. `run.since(cp).logs`. A `reload-invalid`
 *   line is not an emission;
 * - `run.writes` every call of the controller's writer (path, success);
 *   `run.removes` every call of its durable delete as what happened to the
 *   file (`ok`: it is gone; `removed`: this call removed it; `unsynced`: it
 *   was removed but the directory sync failed, so the delete threw although
 *   the file is gone; see `ReloadRemoveRecord`); `run.pendingWrites()` /
 *   `run.pendingRemoves()` those on `h.paths.pending`;
 *   `run.slackCalls()` every Web API call by persona key and
 *   `run.slackPosts()` the `chat.postMessage` calls among them;
 *   `run.captured(extra?)` gathers the logs, statuses, lifecycle records,
 *   outcome, writer and delete calls, Slack calls and every file the run's
 *   writer wrote that still exists (as `writtenFile`, so the pending file is
 *   checked) for `assertNoLeak`. Files the test itself wrote are left out, so
 *   a test-written malformed file that holds `LEAK_SENTINEL` does not fail
 *   the check;
 * - "nothing happened": `const cp = run.checkpoint()`, drive ticks, then
 *   `run.since(cp)` is every log line, writer and delete call, lifecycle
 *   record (any op, any `via`), Slack client build and Web API call made
 *   since. `expect(run.since(cp)).toEqual(NO_RUN_ACTIVITY)` shows the ticks
 *   did nothing at all; `run.since(cp).lifecycle` alone is `[]` for "no
 *   lifecycle call from a tick" (AC 55). Bring-up retries run only when the
 *   test advances `run.clock`, so they never mix into a stretch of ticks.
 *
 * The real launch path (`opts.realLaunch`, implies `opts.realLifecycle`; see
 * the option): every launch (start pass, bring-up retry, apply bring-up,
 * `run.relaunch`) runs `spawnForPersona` over `run.serverConfig()`, with the
 * trust patch, the reply-guard steps over `h.stateDir` and the collision
 * ladder, against the composition's agent-director stub and the harness's
 * row table (`AgentDirectorRow`, shared by every run as agent-director's
 * store outlives a server restart): a spawn creates a `waiting` row, a
 * resume sets it `waiting`, a kill `ended`, a delete removes it. A launch
 * record gets the ladder's `action`. `run.composition.agentDirectorCalls` is
 * every agent-director call in order (a spawn with its `cwd`,
 * `CLAUDE_CONFIG_DIR` and `config_dir` label; each with its `result`), and
 * `instanceCallsOf(name)` the persona's spawn, resume, kill and delete.
 * `h.seedRow(persona, { state?, cwd?, configDir?, labels? })` sets or
 * changes a row before a launch, to choose its path (`h.rowOf(name)` reads
 * it); `run.relaunch(name)` is the persona's next launch through the
 * restart path (the relaunch gate, then `launchSession`, in its serializer
 * turn), with no apply. `h.stateDir` is the temp state directory, and
 * `h.replyGuardDir` its record directory (the guard's argument);
 * `h.readReplyGuardRecord(name)` reads a record. `h.configDir(name)` makes
 * a temp `claude_config_dir`; with `makeReloadHarness({ personaConfigDirs:
 * true })` every `h.persona` gets its own. A persona with none resolves to
 * the temp home's `.claude`, never the operator's. Session-manager notices
 * are `run.sessionNotices` (also raised through the run's notifier), and
 * the session manager's `console.error` lines join `run.logs`.
 *
 * Step 5 (b.av2 SR-8.6): with the real composition the refresh calls the
 * stub's `makeTemplate` (params on `run.composition.agentDirector
 * .makeTemplateCalls`) with `run.composition.installedTemplate`'s start-time
 * arguments (`buildTemplateParams` over the start configuration, built when
 * the start applies; nothing is installed at the start), and its record gets
 * how it settled (`refresh`).
 * `run.composition.failTemplateRefresh(err)` makes the next one reject (the
 * refresh logs one line and settles `failed`); `run.lifecycle.hold(
 * 'template-refresh')` keeps it pending until released.
 *
 * Call `await h.cleanup()` in `afterEach`: it stops every run (detection,
 * bring-up retries, connections) and removes the root, then throws if a
 * stand-in refused a call that needs `opts.realLifecycle`. A test that must show
 * no timer is left calls `await run.stop()` and checks
 * `run.clock.pendingCount()`.
 *
 * The token environment: `h.poisonTokenEnvironment()` sets
 * `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` to distinct sentinel-bearing fakes
 * and records every read of either through `process.env` (AC 19/22: tokens
 * come from the file, never the environment), until its `restore()` or
 * `h.cleanup()`.
 *
 * Isolation (b.av2 SR-13.2): every path is explicit and under the root; the
 * harness reads and sets no environment variable (except through
 * `h.poisonTokenEnvironment()`, restored by `h.cleanup()`), never resolves
 * the operator's home, builds no real Slack client or agent-director client,
 * arms no real timer and holds no token literal. The real composition
 * installs the outage state's module dependencies (its stub client and a
 * recording notice sink), and a registered session or delivered event
 * touches the registry and ack tracker; `h.cleanup()` resets them. A
 * realLaunch run also installs the session manager's module seams (the
 * process's agent-director client, dialog and tmux fakes, the spawn home,
 * the trust patcher, the reply guard, the claude_config_dir hook, the
 * session notifier) and captures `console.error`; `h.cleanup()` resets and
 * restores them. No launch is a startup launch, so nothing resolves the
 * state directory from the environment. It
 * spawns nothing but `mkfifo` (in `mkfifoAvailable` and `h.makeFifo`).
 *
 * SPDX-License-Identifier: MIT
 */

import { spawnSync } from 'node:child_process'
import {
  accessSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import {
  durableUnlinkSync,
  DurableUnlinkUnsyncedError,
  durableWriteFileSync,
  type DurableWriteFs,
} from '../../src/atomic-write.ts'
import {
  DM_DESTINATION,
  MAX_RELOAD_FILE_BYTES,
  replySettingsOf,
  type Persona,
  type PersonaConfig,
  type PersonaConfigFs,
  type PersonaInput,
  type ReplySettings,
} from '../../src/config.ts'
import {
  DEFAULT_WORKING_DIRECTORY_FS,
  checkPersonaConfigDir,
  type PersonaBringUpFs,
  type WorkingDirectoryFs,
} from '../../src/persona-bringup.ts'
import {
  createNotUpSessionDropper,
  createPersonaBringUpController,
  describePersonaNotUp,
  isCredentialsBroken,
  type PersonaBringUpController,
  type PersonaBringUpOutcome,
  type PersonaBringUpResultSummary,
  type PersonaBringUpState,
  type PersonaCredentialsChangeResult,
} from '../../src/persona-bringup-controller.ts'
import {
  credentialsDigest,
  DEFAULT_CREDENTIALS_FS,
  PersonaSlackTokens,
  readCredentialsFile,
  type CredentialsDigest,
  type CredentialsFs,
} from '../../src/persona-credentials.ts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { MakeTemplateParams, SpawnParams } from 'agent-director'

import { _resetAckTracker, consumeAck, forgetPersonaAcks } from '../../src/ack-tracker.ts'
import { resetClientForTests, setClientForTests } from '../../src/agent-director-client.ts'
import { buildTemplateParams, type TemplateRefreshResult } from '../../src/agent-director-template.ts'
import { personaInstanceId, personaKey, renderPersonaRef } from '../../src/persona-identity.ts'
import { createPersonaEventRouter } from '../../src/persona-event-router.ts'
import { createPersonaLifecycle, type PersonaLifecycle } from '../../src/persona-lifecycle.ts'
import { createPersonaRouting } from '../../src/persona-routing.ts'
import { createPersonaSerializer } from '../../src/persona-serializer.ts'
import {
  composePersonaStatusListeners,
  createPersonaClientLookup,
  createPersonaIdentityLookup,
  createPersonaRelaunchGate,
  createPersonaUpFlushListener,
  createPersonaUpPredicate,
} from '../../src/persona-start.ts'
import { _resetOutageState, initOutageState } from '../../src/outage-state.ts'
import {
  _resetRegistry,
  createSessionServer,
  decideSessionAdmission,
  dropPersonaSession,
  getSessionByPersona,
  registerSession,
  type SessionEntry,
  type SessionToolDeps,
} from '../../src/registry.ts'
import {
  _resetDialogPollIntervalMs,
  _resetDialogReadyTimeoutMs,
  _resetFindMissingMemo,
  _resetInFlightLaunches,
  _resetPreLaunchReplyGuard,
  _resetPreLaunchTrustPatcher,
  _resetSpawnHomeDir,
  _resetTmuxDialogHelpers,
  _resetTmuxSessionProber,
  _setDialogPollIntervalMs,
  _setDialogReadyTimeoutMs,
  _setSpawnHomeDir,
  _setTmuxCapturePane,
  _setTmuxSendEnter,
  _setTmuxSessionProber,
  checkLaunchConfigDir,
  deletePersonaInstance,
  killPersonaInstance,
  launchSession,
  personaConfigDirLabelValue,
  setConfigDirUnresolvableHook,
  setPreLaunchReplyGuard,
  setPreLaunchTrustPatcher,
  setSessionNotifier,
  spawnForPersona,
  whenLaunchSettled,
  type SpawnPersonaResult,
} from '../../src/session-manager.ts'
import {
  _resetLaunchedWithDirs,
  getLaunchedWithDir,
  preLaunchReplyGuard,
  stopHookLaunchPass,
  teardownPersonaReplyGuard,
} from '../../src/stop-hook-bootstrap.ts'
import { trustPatchPersona } from '../../src/trust-bootstrap.ts'
import type { ApplyBringUpOptions, ApplyStepSlots, InPlaceApplyInput } from '../../src/reload-apply.ts'
import { composePendingFile, parsePendingFingerprint } from '../../src/reload-fingerprint.ts'
import { DESTRUCTIVE_PREFIX, PENDING_PREVIEW_TITLE, type InPlaceSetting } from '../../src/reload-plan.ts'
import {
  configInEffect,
  createReloadController,
  RELOAD_INVALID,
  RELOAD_PREVIEW,
  reloadFilePaths,
  type ReloadController,
  type ReloadFilePaths,
  type ReloadLifecycleOps,
  type ReloadStartOutcome,
  type ReloadTick,
  type ReloadTickDriver,
} from '../../src/reload.ts'
import {
  cannedGetResult,
  errInstanceIdCollision,
  errSpawnNotFound,
  makeStubCallLog,
  makeStubClient,
  type StubCallLog,
  type StubClientOptions,
} from './agent-director-stub.ts'
import {
  APP_TOKEN_PREFIX,
  BOT_TOKEN_PREFIX,
  fakeToken,
  LEAK_SENTINEL,
  writeCredentialsFile,
  writtenFile,
  type CredentialsOverrides,
  type WrittenFile,
} from './credentials.ts'
import type { FakeClock } from './fake-clock.ts'
import { makePersona } from './persona-config.ts'
import { makeConnectionHarness, type ConnectionHarness } from './persona-connection-harness.ts'
import { makeNotifierStack } from './persona-notifier.ts'
import { makeSessionServer, makeTransport, type ChannelNotification } from './persona-routing-harness.ts'
import { REPLY_GUARD_DIR_NAME } from './reply-guard-record.ts'
import {
  INITIAL_CREDENTIALS,
  type SlackEvent,
  type StubSlack,
  type StubSlackFactory,
  type StubSlackOptions,
  type StubSlackScript,
  type StubWebCall,
  type WebApiOutcome,
} from './slack-stub.ts'

// ---------------------------------------------------------------------------
// Scripted Slack outcomes for a start
// ---------------------------------------------------------------------------

/**
 * `opts.slack` scripts that put a persona in each held-content state at the
 * start (pass under the persona's name, e.g. `{ slack: { bravo:
 * SLACK_UNREACHABLE } }`). Unscripted, a persona with a valid credentials
 * file and working directory comes up (`up`).
 *
 * - `SLACK_UNREACHABLE`: every `auth.test` fails with a network error, so the
 *   persona ends `retrying` and stays so however far `run.clock` advances;
 * - `SLACK_AUTH_REJECTED`: `auth.test` answers `invalid_auth` (a named auth
 *   error), so the persona ends `broken` with its credentials held.
 *
 * Either way the bring-up read the credentials file, so the persona holds
 * its digest (`run.bringUps.credentialsDigest(key)`).
 */
export const SLACK_UNREACHABLE: StubSlackOptions = Object.freeze({
  authTest: Object.freeze(Array.from({ length: 1_000 }, () => ({ kind: 'network' as const }))),
})

/** See `SLACK_UNREACHABLE`. */
export const SLACK_AUTH_REJECTED: StubSlackOptions = Object.freeze({
  authTest: Object.freeze([{ kind: 'platform' as const, error: 'invalid_auth' }]),
})

let mkfifoProbe: boolean | undefined

/**
 * Whether `mkfifo` is available here (probed once). Guard a real-FIFO case
 * with `test.skipIf(!mkfifoAvailable())`, the reason in the test name.
 */
export function mkfifoAvailable(): boolean {
  mkfifoProbe ??= spawnSync('mkfifo', ['--version']).status === 0
  return mkfifoProbe
}

// ---------------------------------------------------------------------------
// Manual tick driver
// ---------------------------------------------------------------------------

/**
 * A `ReloadTickDriver` driven by the test. Like the production driver it is
 * single-use: the first `start` arms the tick; a later `start`, or a `start`
 * after `stop`, is counted but arms nothing.
 */
export interface ManualTickDriver extends ReloadTickDriver {
  /** Every `start` call, armed or not. */
  readonly startCalls: number
  /** Every `stop` call. */
  readonly stopCalls: number
  /** A tick is registered and the driver is not stopped. */
  readonly armed: boolean
  /** Ticks run so far through `tick` / `ticks`. */
  readonly ticksRun: number
  /** Run the armed tick once and wait until it settles (after any tick still running). Throws if nothing is armed. */
  tick(): Promise<void>
  /** Run `n` ticks one after another, each settled before the next. */
  ticks(n: number): Promise<void>
}

/** Build a manual tick driver; see `ManualTickDriver`. */
export function createManualTickDriver(): ManualTickDriver {
  let registered: ReloadTick | undefined
  let stopped = false
  let startCalls = 0
  let stopCalls = 0
  let ticksRun = 0
  let last: Promise<void> = Promise.resolve()

  const driver: ManualTickDriver = {
    start(tick) {
      startCalls++
      if (registered === undefined && !stopped && startCalls === 1) registered = tick
    },
    stop() {
      stopCalls++
      stopped = true
      registered = undefined
    },
    get startCalls() {
      return startCalls
    },
    get stopCalls() {
      return stopCalls
    },
    get armed() {
      return registered !== undefined
    },
    get ticksRun() {
      return ticksRun
    },
    tick() {
      const tick = registered
      if (tick === undefined) {
        return Promise.reject(new Error('reload-harness: no tick is armed (the driver was never started, or was stopped)'))
      }
      ticksRun++
      const run = last.then(() => tick())
      last = run.catch(() => undefined)
      return run
    },
    async ticks(n) {
      for (let i = 0; i < n; i++) await driver.tick()
    },
  }
  return driver
}

// ---------------------------------------------------------------------------
// Lifecycle recorder
// ---------------------------------------------------------------------------

/**
 * A lifecycle call the recorder saw: a per-persona one, or apply step 5's
 * `template-refresh`, which belongs to no persona (its record's key is `''`).
 */
export type ReloadLifecycleOp = 'bring-up' | 'launch' | 'teardown' | 'reconnect' | 'update-in-place' | 'template-refresh'

/**
 * What caused it: the start pass (`start`), the bring-up controller's own
 * retry (`retry`, launches only), a lifecycle op the controller called for
 * one persona (`apply`), or the restart module's launch (`restart`, launches
 * only, `run.relaunch`).
 */
export type ReloadLifecycleVia = 'start' | 'retry' | 'apply' | 'restart'

/** The key of a `template-refresh` record and timeline entry: it belongs to no persona. */
export const TEMPLATE_REFRESH_KEY = ''

/** One lifecycle call, in call order. Holds no token. */
export interface ReloadLifecycleRecord {
  readonly op: ReloadLifecycleOp
  readonly key: string
  readonly via: ReloadLifecycleVia
  /** Bring-up only: the controller's summary, set once the bring-up resolved. */
  result?: PersonaBringUpResultSummary
  /** In-place update only: the changed settings the controller passed (`InPlaceApplyInput.settings`), in its order. */
  readonly settings?: readonly InPlaceSetting[]
  /**
   * Apply bring-up only, and only when set: the step-6 recovery bring-up of a
   * persona broken by its credentials whose credentials file changed (the
   * controller passed `{ recovery: true }`, b.av2 SR-6.4). Absent for an
   * added persona's bring-up, so its record compares as before.
   */
  readonly recovery?: true
  /** Reconnect only: how the credentials change settled (its first attempt), set once it resolved. */
  change?: PersonaCredentialsChangeResult
  /**
   * Launch only, with `opts.realLaunch`: what the real launch path
   * (`spawnForPersona`) did, set once it resolved (`spawned`, `resumed`,
   * `reconnected`, `deferred`, `failed`, …). Absent for a recorded-only launch.
   */
  action?: SpawnPersonaResult['action']
  /**
   * Launch via `restart` only (`run.relaunch`): what the restart module's
   * `launchSession` answered (`true`, `false`, or `'skipped'` when the
   * relaunch gate refused it or the launch was deferred), set once resolved.
   */
  restart?: boolean | 'skipped'
  /**
   * `template-refresh` only, with the real composition: how the refresh
   * settled (`refreshSlackChannelBotTemplate`'s result). Absent for the
   * stand-in, which calls nothing.
   */
  refresh?: TemplateRefreshResult
}

export interface ReloadLifecycleRecorder {
  /** The lifecycle operations the reload controller receives. */
  readonly ops: Required<ReloadLifecycleOps>
  /** Every per-persona call, in call order. */
  readonly records: readonly ReloadLifecycleRecord[]
  /** The applied configuration of each `startBringUp` call, in order. */
  readonly startPasses: readonly PersonaConfig[]
  /** The records of one op, in call order. */
  of(op: ReloadLifecycleOp): ReloadLifecycleRecord[]
  /** The persona keys of one op's records, in call order. */
  keys(op: ReloadLifecycleOp): string[]
  /** The outcome of the persona's latest resolved bring-up record; undefined if none resolved. */
  outcome(key: string): PersonaBringUpOutcome | undefined
  /** The failure classes of the persona's latest resolved bring-up record (credentials, directory, Slack order). */
  classes(key: string): string[]
  /**
   * Keep the next start pass from resolving (after its bring-ups and
   * launches) until the returned function is called, or make it reject with
   * `err` once its `fail(err)` is called.
   */
  holdStartPass(): StartPassHold
  /**
   * Gate the next apply-time call of `op` (`teardown`, `update-in-place`,
   * `reconnect` or `bring-up`) for the persona `key`: the call is recorded and its `start`
   * timeline entry made when it arrives, then it waits, its body not yet run,
   * until `gate.release()` (the body runs) or `gate.fail(err)` (the call
   * rejects with `err` and its body never runs). Call `fail` before the call
   * arrives to make it reject at once. Other personas' calls are not held.
   */
  hold(op: LifecycleGateOp, key: string): LifecycleGate
  /**
   * Gate the next apply step 5 (`template-refresh`) the same way: recorded
   * and its `start` entry (in `applyTimeline`) made when it arrives, then
   * held before its body (with the real composition, the `makeTemplate`
   * call) runs, so a test can show step 5 comes after step 4 settled and
   * before step 6 starts. `fail(err)` makes the lifecycle member reject,
   * which production's never does: to make the refresh itself fail (logged,
   * not fatal), script `run.composition.failTemplateRefresh(err)` instead.
   */
  hold(op: 'template-refresh'): LifecycleGate
  /**
   * The apply-time `teardown`, `update-in-place`, `reconnect` and `bring-up`
   * calls (a recovery bring-up included) in the
   * order they started and settled (`start`, then `settled` or `rejected`),
   * across personas and steps, so step order is asserted without timing
   * (b.av2 SR-8.6). A held call's `start` comes when it arrives, its
   * `settled` after its body ran. Start-pass bring-ups are not here, and
   * neither is step 5 (see `applyTimeline`).
   */
  readonly timeline: readonly LifecycleTimelineEntry[]
  /**
   * `timeline` with step 5 in its place: every apply-time call, the
   * `template-refresh` included (key `TEMPLATE_REFRESH_KEY`), in the order
   * they started and settled. For step-order cases that cover step 5.
   */
  readonly applyTimeline: readonly ApplyTimelineEntry[]
}

/** A per-persona apply-time lifecycle call a test can hold (`run.lifecycle.hold(op, key)`). */
export type LifecycleGateOp = 'teardown' | 'update-in-place' | 'reconnect' | 'bring-up'

/** One entry of `run.lifecycle.applyTimeline`: a per-persona call, or apply step 5. Holds no token. */
export type ApplyTimelineEntry =
  | LifecycleTimelineEntry
  | { readonly op: 'template-refresh'; readonly key: typeof TEMPLATE_REFRESH_KEY; readonly phase: LifecycleTimelineEntry['phase'] }

/** `run.lifecycle.hold(op, key)`'s handle. */
export interface LifecycleGate {
  /** Resolves once the held call arrived (its record and `start` entry made). */
  readonly entered: Promise<void>
  /** Let the held call run its body. */
  release(): void
  /** Make the held call reject with `err`, its body never run. */
  fail(err: Error): void
}

/** One entry of `run.lifecycle.timeline`. Holds no token. */
export interface LifecycleTimelineEntry {
  readonly op: LifecycleGateOp
  readonly key: string
  readonly phase: 'start' | 'settled' | 'rejected'
}

/**
 * The real lifecycle composition a run binds with `opts.realLifecycle`
 * (`run.composition`): `createPersonaLifecycle` (`persona-lifecycle.ts`) over
 * the run's real bring-up controller and connection manager, a real
 * per-persona serializer (shared with that controller and manager), the real `killPersonaInstance` and
 * `deletePersonaInstance` over a `makeStubClient` agent-director stub, and a
 * recording stand-in for every other dependency.
 */
export interface RealLifecycleComposition {
  /** The composition the recorder's `teardown`, `updateInPlace`, `reconnectCredentials` and `bringUp` call. */
  readonly lifecycle: PersonaLifecycle
  /** Every agent-director verb call, by verb (`killCalls`, `deleteCalls`, …). */
  readonly agentDirector: StubCallLog
  /** The agent-director `kill` and `delete` calls in call order, as `<verb> <instance ID>`. */
  readonly agentDirectorOrder: readonly string[]
  /**
   * Every call of a dependency the composition got, in call order, as
   * `[member, key]` with the member named as in `PersonaLifecycleDeps`
   * (`'bringUps.cancel'`, `'cancelRestartTimer'`, `'whenLaunchSettled'`,
   * `'connections.stop'`, `'routing.forget'`, `'forgetAcks'`, `'destinations.forget'`,
   * `'destinationHold.cancel'`, `'notifier.forget'`, `'forgetPersonaPrompts'`,
   * `'dropSession'`, `'resetOutageState'`, `'killInstance'`,
   * `'deleteInstance'`, `'forgetFailures'`, `'forgetDisconnectedStreak'`,
   * `'replyGuard.launchedWithDir'`, `'replyGuard.teardown'`,
   * `'replyGuard.launchPass'`, `'storageCheck'`, `'bringUps.bringUp'`,
   * `'bringUps.changeCredentials'`, `'connections.reconnectCredentials'`,
   * `'connections.replaceRetryTokens'`, `'launch'`) plus `'outage-notice'`
   * for a notice the outage state raised. The one query, `bringUps.state`
   * (a recovery's re-check), is not recorded.
   */
  readonly calls: ReadonlyArray<readonly [string, string]>
  /**
   * Every agent-director call the stub received, in call order, with what a
   * test needs of it (see `AgentDirectorCall`): the lifecycle's kill and
   * delete, step 5's `makeTemplate`, and with `opts.realLaunch` the launch
   * path's spawn, get, resume, status and the rest. Their full params are on
   * `agentDirector` by verb.
   */
  readonly agentDirectorCalls: readonly AgentDirectorCall[]
  /**
   * The persona's instance calls (`spawn`, `resume`, `kill`, `delete` of
   * `cscb_<key>`) among `agentDirectorCalls`, in order, with their results:
   * a relaunch from an `ended` row with an old `config_dir` label reads
   * spawn (`ErrInstanceIdCollision`), delete (`ok`), spawn (`ok`); one with
   * the current label spawn (`ErrInstanceIdCollision`), resume (`ok`).
   */
  instanceCallsOf(name: string): AgentDirectorCall[]
  /**
   * What the start's template install wrote, as the step-5 refresh keeps it
   * (`templateRefresh.installed`): `buildTemplateParams` over the start
   * configuration (its `mcp_config_path` and system-prompt settings, from the
   * record or config file the run started from; the append file probed on
   * the real file system when the start applies, in `run.resolveStart()`,
   * as `server.ts` installs it at start, never at a later read). No
   * `makeTemplate` call is made at the start. Undefined until the start
   * applied.
   */
  readonly installedTemplate: MakeTemplateParams | undefined
  /**
   * Make the next `makeTemplate` call (step 5's refresh) reject with `err`
   * (a typed agent-director error such as `errTemplateMalformed()`, or any
   * `Error`); each call queues one more failure. The refresh logs its one
   * failure line and settles `{ kind: 'failed' }`; later calls succeed.
   */
  failTemplateRefresh(err: Error): void
}

/**
 * One agent-director call in `run.composition.agentDirectorCalls`. Holds no
 * token. `id` is the instance ID (`cscb_<key>`) for a per-instance verb.
 * A `spawn` also carries its `cwd`, the `CLAUDE_CONFIG_DIR` of its spawn
 * environment (undefined when absent) and its `config_dir` label value
 * (undefined when absent). `result` is set once the call settled: `'ok'`, or
 * the rejection's agent-director error name (`ErrInstanceIdCollision` for
 * the ladder's optimistic spawn that met a row, `ErrSpawnNotFound`, …) or
 * error name. A spawn that created an instance is `{ verb: 'spawn', result:
 * 'ok' }`.
 */
export interface AgentDirectorCall {
  readonly verb: string
  readonly id?: string
  readonly cwd?: string
  readonly claudeConfigDir?: string
  readonly configDirLabel?: string
  result?: string
}

/** How a rejected agent-director call is named in `AgentDirectorCall.result`. */
function errorName(err: unknown): string {
  const errName = (err as { errName?: unknown } | undefined)?.errName
  if (typeof errName === 'string') return errName
  return err instanceof Error ? err.name : 'thrown'
}

/**
 * A persona's agent-director row in the harness's row table (shared by every
 * run, as agent-director's store outlives a server restart). With
 * `opts.realLaunch`, a spawn creates the row (`waiting`, the spawn's `cwd`
 * and labels), a resume sets it `waiting`, a kill `ended`, and a delete
 * removes it; `get` answers it and `status` its state (a `working` row
 * answers `waiting`, its turn over). `h.seedRow` sets or changes it.
 */
export interface AgentDirectorRow {
  readonly state: string
  readonly cwd: string
  /** The row's labels (`service`, `persona`, `config_dir`, …). */
  readonly labels: Readonly<Record<string, string>>
}

/** `h.seedRow`'s fields; each one given replaces the row's. */
export interface AgentDirectorRowSeed {
  /** `ended` (the default for a new row), `missing`, `waiting`, `working`, … */
  state?: string
  cwd?: string
  /**
   * The `config_dir` label, as the directory it names: its value is
   * `personaConfigDirLabelValue(configDir, h.home)`. `null` removes the
   * label. For a new row it defaults to the persona's `claude_config_dir`
   * (or the temp home's `.claude`).
   */
  configDir?: string | null
  /** Replace all labels (wins over `configDir`). */
  labels?: Record<string, string>
}

/** The verbs `instanceCallsOf` keeps: those that start, stop or remove an instance. */
const INSTANCE_VERBS: ReadonlySet<string> = new Set(['spawn', 'resume', 'kill', 'delete'])

/** The label naming a row's config dir (`config_dir=<value>`). */
const CONFIG_DIR_LABEL = 'config_dir'

/** A spawn's `KEY=VALUE` labels as a row's label record. */
function parseLabels(labels: readonly string[] | undefined): Record<string, string> {
  const parsed: Record<string, string> = {}
  for (const label of labels ?? []) {
    const at = label.indexOf('=')
    if (at > 0) parsed[label.slice(0, at)] = label.slice(at + 1)
  }
  return parsed
}

/** `h.rotateCredentials`'s options. */
export interface CredentialsRotationOptions {
  /**
   * Scripts the new credential set's stub in every live run (see
   * `h.rotateCredentials`); the leak marker is always on. Unscripted, the new
   * tokens are accepted: `auth.test` answers with the new stub's own
   * identity (a different bot user ID and bot ID from the old set's) and its
   * socket connects.
   */
  slack?: StubSlackOptions
}

/** A credential set `h.rotateCredentials` wrote. */
export interface RotatedCredentials {
  /** The new token pair (sentinel-bearing fakes; never print them). */
  readonly tokens: PersonaSlackTokens
  /**
   * The set's harness label, `credentials-<n>` (n counts the persona's
   * writes): the label `run.credentialsStub(name, label)` and
   * `run.socketActivity(name)` use for it in every run.
   */
  readonly label: string
}

/** The Web API script queues of a stub (every queue but `authTest` and `connect`). */
export type StubWebApiQueue = Exclude<keyof StubSlackScript, 'authTest' | 'connect'>

/** Every `StubWebApiQueue`, so `run.revokeBotToken` reaches whichever call a consumer makes first. */
const WEB_API_QUEUES: readonly StubWebApiQueue[] = [
  'post',
  'update',
  'upload',
  'history',
  'replies',
  'info',
  'open',
  'reactionsAdd',
  'reactionsRemove',
  'usersInfo',
  'apiCall',
]

/** `run.revokeBotToken`'s options. */
export interface BotTokenRevocation {
  /** The Slack error the next Web API call answers (default `token_revoked`; also `invalid_auth`, `account_inactive`, `not_authed`, or any other to show it is ignored). */
  error?: string
  /** The credential set whose stub answers it (harness label); default the one whose socket connected last (`run.currentStub`). */
  credentials?: string
  /** The queues scripted; default every Web API queue, so whichever call comes first answers it. */
  queues?: readonly StubWebApiQueue[]
}

/** `run.admitSession`'s answer: the registered session when the persona was admitted. */
export type ReloadSessionAdmission =
  | { readonly kind: 'admitted'; readonly session: SessionEntry }
  | { readonly kind: 'not-up' | 'unmatched' }

/** One message the routing delivered to a persona's registered session (`run.deliveries`). Holds no token. */
export interface ReloadDelivery {
  readonly chat_id: string
  /** The meta `via` (`dm`, `mention`, `broadcast`, `receive_all`, `receive_all_shared`). */
  readonly via: string | undefined
  readonly content: string
}

/** `run.callTool`'s result: whether the MCP tool answered with an error, and its text. */
export interface ReloadToolResult {
  readonly isError: boolean
  readonly text: string
}

/**
 * `h.poisonTokenEnvironment()`'s handle: the fake values it put in
 * `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` (sentinel-bearing, distinct from
 * every harness token set; never print them) and every read of either
 * variable through `process.env` since.
 */
export interface TokenEnvironmentWatch {
  readonly bot: string
  readonly app: string
  /** The names read (`SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN`), one entry per read, in order. */
  readonly reads: readonly string[]
  /** Put `process.env` and both variables back as they were. Idempotent; `h.cleanup()` calls it. */
  restore(): void
}

/** The variables `h.poisonTokenEnvironment()` sets and watches. */
const TOKEN_ENV_NAMES = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'] as const

/** `holdStartPass()`'s handle: call it to let the held start pass return, or `fail(err)` to make it throw `err`. */
export interface StartPassHold {
  (): void
  fail(err: Error): void
}

// ---------------------------------------------------------------------------
// Write-failure seam
// ---------------------------------------------------------------------------

/** A `DurableWriteFs` call the seam can fail. */
export type DurableWriteStep = keyof DurableWriteFs

/** An injected write failure: every call of `step` (or only its `call`-th) throws an error with `code`. */
export interface WriteFailure {
  step: DurableWriteStep
  /** An errno code such as `EIO`, `ENOSPC` or `EROFS`. */
  code: string
  /** Fail only this call of `step` (1-based, counted from `failWrites`); every call when unset. */
  call?: number
}

/** One call of the controller's writer. */
export interface ReloadWriteRecord {
  readonly path: string
  /** Whether the durable write returned without throwing. */
  readonly ok: boolean
}

/**
 * One call of the controller's durable delete (`durableUnlinkSync` over the
 * remove seam), recorded as what happened to the file:
 * - `{ ok: true, removed: true, unsynced: false }`: removed and its directory synced;
 * - `{ ok: true, removed: false, unsynced: false }`: the path was already absent;
 * - `{ ok: true, removed: true, unsynced: true }`: removed, but the directory
 *   open or fsync failed after the unlink (`DurableUnlinkUnsyncedError`, which
 *   the delete threw on to the controller): the file IS gone;
 * - `{ ok: false, removed: undefined, unsynced: false }`: any other throw; the
 *   file is still there.
 */
export interface ReloadRemoveRecord {
  readonly path: string
  /** Whether the file is gone after the call (removed, durably or not, or already absent). */
  readonly ok: boolean
  /** True when this call removed a file, false when the path was already absent; undefined when the unlink itself failed. */
  readonly removed: boolean | undefined
  /** The file was removed but its directory could not be synced (the delete threw `DurableUnlinkUnsyncedError`). */
  readonly unsynced: boolean
}

/** Positions in a run's captures, taken by `run.checkpoint()`; compare with `run.since(cp)`. */
export interface ReloadRunCheckpoint {
  readonly logs: number
  readonly writes: number
  readonly removes: number
  readonly lifecycle: number
  readonly slackBuilds: number
  /** Web API calls so far, per persona key. */
  readonly slackCalls: Readonly<Record<string, number>>
}

/** What a run did since a checkpoint (`run.since(cp)`). */
export interface ReloadRunActivity {
  /** `[slack]` lines logged since (reload, bring-up and manager). */
  logs: string[]
  /** Calls of the controller's writer since. */
  writes: ReloadWriteRecord[]
  /** Calls of the controller's durable delete since. */
  removes: ReloadRemoveRecord[]
  /** Lifecycle records made since (any op, any `via`). */
  lifecycle: ReloadLifecycleRecord[]
  /** Slack clients the stub factory built since (connection manager or reload controller). */
  slackBuilds: number
  /** Web API calls made since, on any persona's stub. */
  slackCalls: StubWebCall[]
}

/**
 * A run that did nothing: `expect(run.since(cp)).toEqual(NO_RUN_ACTIVITY)`
 * shows a stretch of ticks logged, wrote, deleted, called a lifecycle op,
 * built a Slack client and called Slack not at all (AC 55).
 */
export const NO_RUN_ACTIVITY: Readonly<ReloadRunActivity> = Object.freeze({
  logs: [],
  writes: [],
  removes: [],
  lifecycle: [],
  slackBuilds: 0,
  slackCalls: [],
})

// ---------------------------------------------------------------------------
// Preview emissions in the log (b.av2 SR-8.4, SR-10.3)
// ---------------------------------------------------------------------------

/** Start of every `reload-preview` log line. */
const PREVIEW_LINE_START = `[slack] ${RELOAD_PREVIEW}: `

/**
 * Start of the first log line of every preview emission: the header, which
 * opens both the counted preview and the `no effective change` one. No other
 * preview line starts with the title.
 */
export const PREVIEW_EMISSION_START = `${PREVIEW_LINE_START}${PENDING_PREVIEW_TITLE}`

/**
 * The preview emissions among `lines` (any log slice, e.g. `run.logs` or
 * `run.since(cp).logs`), in order: each is a header line (starting
 * `PREVIEW_EMISSION_START`) and the `reload-preview` lines that follow it
 * until the next header or a line of any other kind. The full log lines are
 * kept. A `reload-invalid` line is no emission (see `run.invalidLines()`).
 * A `reload-preview` line before any header is dropped (none is expected).
 */
export function previewEmissions(lines: readonly string[]): string[][] {
  const emissions: string[][] = []
  let current: string[] | undefined
  for (const line of lines) {
    if (line.startsWith(PREVIEW_EMISSION_START)) {
      current = [line]
      emissions.push(current)
    } else if (current !== undefined && line.startsWith(PREVIEW_LINE_START)) {
      current.push(line)
    } else {
      current = undefined
    }
  }
  return emissions
}

/**
 * One emission's lines as the preview body reads them: the `[slack]
 * reload-preview: ` prefix removed from each, and from the header the
 * ` (preview in "<pendingFile>")` suffix when it is exactly that. With the
 * file written, the result equals `h.pendingLines()`. A header without the
 * suffix (the write failed) is kept as it is: assert the suffix on the full
 * log line (`run.lastPreviewEmission()[0]`).
 */
export function previewEmissionText(emission: readonly string[], pendingFile: string): string[] {
  const suffix = ` (preview in ${JSON.stringify(pendingFile)})`
  return emission.map((line, i) => {
    const text = line.startsWith(PREVIEW_LINE_START) ? line.slice(PREVIEW_LINE_START.length) : line
    return i === 0 && text.endsWith(suffix) ? text.slice(0, -suffix.length) : text
  })
}

// ---------------------------------------------------------------------------
// Prospective bring-up fixtures (an added persona that cannot come up)
// ---------------------------------------------------------------------------

/**
 * The state `h.preparePersona` leaves a persona's credentials file in:
 * - `valid`: `h.writeCredentials` (a fresh fake token set);
 * - `missing`: nothing at the path;
 * - `invalid`: a parseable file without `bot_token` (`credentials file is invalid: …`);
 * - `unreadable`: an empty directory at the path (`credentials file is a directory`).
 */
export type PreparedCredentials = 'valid' | 'missing' | 'invalid' | 'unreadable'

/**
 * The state `h.preparePersona` leaves a persona's working directory in:
 * `present` (created), `missing` (nothing at the path) or `file` (a plain
 * file at the path: `working directory is not a directory`).
 */
export type PreparedWorkingDirectory = 'present' | 'missing' | 'file'

/** `h.preparePersona`'s file states; each defaults to the one that lets the persona come up. */
export interface PreparedPersonaState {
  credentials?: PreparedCredentials
  workingDirectory?: PreparedWorkingDirectory
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface ReloadRunOptions {
  /** Dry run, passed as a flag to the connection manager and the bring-up controller. */
  dryRun?: boolean
  /** Per-persona-name stub options (scripted Slack outcomes); the leak marker is always on. */
  slack?: Readonly<Record<string, StubSlackOptions>>
  /** Overrides for the bring-up controller's file-system seam (credentials and working-directory checks). */
  bringUpFs?: Partial<PersonaBringUpFs>
  /** Overrides for the reload controller's file-system seam (reading the record, the configuration file and the pending file). */
  configFs?: Partial<PersonaConfigFs>
  /**
   * Overrides for the detection tick's credentials reads (`CredentialsFs`,
   * e.g. an `fstatFile` reporting a FIFO). The bring-up's own credentials
   * reads use `bringUpFs`.
   */
  credentialsFs?: Partial<CredentialsFs>
  /**
   * Replace the manual tick driver the controller gets (`run.ticks` is then
   * never armed). Only for the one case that shows the production driver's
   * first pass comes 5 s after `startDetection`: pass
   * `({ clock, log }) => createReloadTickDriver({ clock, log })`, which runs on
   * the run's fake clock (`run.clock`), never a real timer. Every other
   * reload test drives ticks through `run.ticks`.
   */
  tickDriver?: (deps: { clock: FakeClock; log: (line: string) => void }) => ReloadTickDriver
  /**
   * Wrap the reload controller's held-digest lookup: called with the persona
   * key and the default lookup (`run.bringUps.credentialsDigest`), e.g. to
   * throw and so fail a detection pass.
   */
  heldCredentialsDigest?: (
    key: string,
    held: (key: string) => CredentialsDigest | undefined,
  ) => CredentialsDigest | undefined
  /**
   * Wrap the reload controller's bring-up state lookup: called with the
   * persona key and the default lookup (`run.bringUps.state`, as `server.ts`
   * binds it), e.g. to throw and so leave a fact out of the preview.
   */
  bringUpState?: (
    key: string,
    state: (key: string) => PersonaBringUpState | undefined,
  ) => PersonaBringUpState | undefined
  /** The controller's apply step 2–6 bodies (`ApplyStepSlots`); unbound by default, so a step does nothing. */
  applySteps?: ApplyStepSlots
  /** Also called with every configuration the controller's `onApplied` is told (after `run.appliedConfigs` records it). */
  onApplied?: (config: PersonaConfig) => void
  /**
   * Bind the real lifecycle composition (`run.composition`, see
   * `RealLifecycleComposition`) behind the recorder's `teardown`,
   * `updateInPlace`, `reconnectCredentials` and `bringUp` (a recovery
   * included), instead of the stand-ins; the bring-up
   * controller then also gets the composition's serializer and the
   * controller's live applied set, and the connection manager that
   * serializer, as `server.ts` wires them.
   */
  realLifecycle?: boolean
  /**
   * The real persona launch path (implies `realLifecycle`): every launch (the
   * start pass's, a bring-up retry's, an apply bring-up's and
   * `run.relaunch`'s) runs `spawnForPersona` (the pre-launch
   * claude_config_dir check, the collision ladder, the trust patch and the
   * reply-guard steps) over the composition's agent-director stub and the
   * harness's row table, with the configuration the server runs
   * (`run.serverConfig()`), never as a startup launch (no
   * `startup-errors.log`). The run installs, as `server.ts` does, the stub
   * as the process's agent-director client, `trustPatchPersona`, the
   * reply-guard steps over `h.stateDir` and the applied set, the bring-up
   * controller's claude_config_dir hold and re-check, and a session notifier
   * that records each notice (`run.sessionNotices`) and raises it through
   * the run's notifier; the dialog poll runs at 1 ms, tmux is faked and the
   * spawn home is `h.home`. The composition's reply-guard members are the
   * real ones over `h.stateDir`. Every `console.error` line (the session
   * manager's, the reply guard's) goes to `run.logs` while the run is the
   * latest live one. The start-time bootstraps (the sweep, the trust and
   * Stop-hook bootstraps, the template install) are not run. A new run
   * forgets the launched-with directories and in-flight launches, as a new
   * server process would; the row table and the record files persist.
   */
  realLaunch?: boolean
  /** With `realLifecycle`: options for the agent-director stub (e.g. `killError`). Its call captures are the harness's own. */
  agentDirector?: StubClientOptions
  /**
   * Called with the path before every call of the controller's writer (the
   * record, the pending file), e.g. to observe what exists when the record
   * is written.
   */
  beforeWrite?: (path: string) => void
}

/** One server start over the harness's files; see the file comment. */
export interface ReloadRun {
  /** The real reload controller. */
  readonly controller: ReloadController
  /** The real bring-up controller the start pass drives. */
  readonly bringUps: PersonaBringUpController
  /** The connection harness: the real manager over the stub factory. */
  readonly connections: ConnectionHarness
  /** The stub factory the manager and the reload controller build Slack clients from. */
  readonly slack: StubSlackFactory
  /** The fake clock of the manager and the bring-up controller's retries. */
  readonly clock: FakeClock
  readonly ticks: ManualTickDriver
  readonly lifecycle: ReloadLifecycleRecorder
  /** The `[slack]` stream: every line the reload controller, bring-up controller and manager logged, in order. */
  readonly logs: string[]
  /** Every call of the controller's writer, in order. */
  readonly writes: readonly ReloadWriteRecord[]
  /** Every call of the controller's durable delete, in order. */
  readonly removes: readonly ReloadRemoveRecord[]
  /** The latest `run.resolveStart()` outcome (also set by `h.start`). */
  readonly outcome: ReloadStartOutcome | undefined
  /** The real lifecycle composition, with `opts.realLifecycle`; undefined otherwise. */
  readonly composition: RealLifecycleComposition | undefined
  /**
   * Register an MCP session for the persona named `name` in the real
   * registry, as its instance's session: a fake transport holding its GET
   * stream and a server recording what the routing delivers
   * (`run.deliveries(name)`). A newer registration replaces the older one,
   * as in the registry. `h.cleanup()` resets the registry and ack tracker.
   */
  registerSession(name: string): SessionEntry
  /** The persona's registered session now (`getSessionByPersona`); compare by identity to show it was kept. */
  session(name: string): SessionEntry | undefined
  /** Every message the routing delivered to the persona's registered sessions, in order. */
  deliveries(name: string): ReloadDelivery[]
  /** Deliver `event` on the persona's current socket stub (`run.stub(name).socket.deliver`), through the event router and the routing. */
  deliver(name: string, event: SlackEvent): Promise<void>
  /** Raise a notice for the persona through the real notifier, as a notice site does; read the Slack calls on `run.stub(name).callLog`. */
  notice(name: string, text: string): Promise<void>
  /**
   * The destination hold's own fake clock (never `run.clock`): advance it to
   * drive the retries of a notice held after a failed post (for example one
   * refused with `token_revoked`, which the hold keeps and retries once the
   * persona has a client again).
   */
  readonly noticeClock: FakeClock
  /**
   * Call MCP tool `tool` with `args` as the persona's instance: an in-memory
   * MCP client over `createSessionServer` for its registered session (the
   * real tool handlers, whose posting scope reads the applied persona at
   * each call), with the run's client lookup. Needs `run.registerSession`
   * first. No file may be sent (the file guard refuses every path).
   */
  callTool(name: string, tool: string, args: Record<string, unknown>): Promise<ReloadToolResult>
  /** Every configuration the controller's `onApplied` was told, in order (one per confirmed apply's step 1). */
  readonly appliedConfigs: readonly PersonaConfig[]
  /** The persona keys of the controller's applied configuration now, in order; undefined before the start applied. */
  appliedKeys(): string[] | undefined
  /** `controller.resolveStart()`, keeping the outcome as `outcome`. */
  resolveStart(): ReloadStartOutcome
  /** `controller.startDetection()`: whether it armed the tick on `run.ticks`. */
  startDetection(): boolean
  /** The writer calls on `h.paths.pending`, in order. */
  pendingWrites(): ReloadWriteRecord[]
  /** The delete calls on `h.paths.pending`, in order. */
  pendingRemoves(): ReloadRemoveRecord[]
  /**
   * The logged lines of one diagnostic class or prefix label: those starting
   * `[slack] <label>: `, e.g. `logsOf(RELOAD_NOTHING_PENDING)`,
   * `logsOf(RELOAD_PREVIEW)`, or `logsOf('reload')` for the unclassed
   * `[slack] reload: …` lines (write, delete and tick failures).
   */
  logsOf(label: string): string[]
  /** `previewEmissions(run.logs)`: every preview emission so far, each as its full log lines. */
  previewEmissions(): string[][]
  /** How many times the preview was logged so far, however many lines each emission spans. */
  previewEmissionCount(): number
  /** The full log lines of the latest preview emission; undefined when none. */
  lastPreviewEmission(): string[] | undefined
  /**
   * The latest emission as the preview body reads it (`previewEmissionText`
   * over `h.paths.pending`): equals `h.pendingLines()` when the file was
   * written. Undefined when none.
   */
  lastPreviewText(): string[] | undefined
  /** `logsOf(RELOAD_INVALID)`: the `reload-invalid` lines (one per invalid pending state logged). */
  invalidLines(): string[]
  /**
   * Every path the detection tick's credentials reads opened (its
   * `CredentialsFs.openFile`, through `opts.credentialsFs` when given), in
   * order. Empty for a whole run in dry run (b.av2 SR-3.4, SR-8.2). The
   * start's bring-up reads are not here (they use `bringUpFs`). Not part of
   * `since`: slice it by length around a stretch of ticks.
   */
  readonly tickCredentialsReads: readonly string[]
  /**
   * Every path the detection tick's working-directory check stat'd (the
   * added personas' directories), in order. Not part of `since`.
   */
  readonly tickDirectoryChecks: readonly string[]
  /** Where every capture stands now; see `since`. */
  checkpoint(): ReloadRunCheckpoint
  /** Everything captured after `cp` (compare with `NO_RUN_ACTIVITY` for "did nothing"). */
  since(cp: ReloadRunCheckpoint): ReloadRunActivity
  /** The stub of the persona with this name. Throws in dry run or for a persona with no written credentials. */
  stub(name: string): StubSlack
  /** Every Web API call on every registered persona's stub, by persona key. */
  slackCalls(): Record<string, StubWebCall[]>
  /** Every `chat.postMessage` call on any persona's stub. */
  slackPosts(): StubWebCall[]
  /** Everything captured, plus `extra`, for `assertNoLeak`; written files as `writtenFile`. */
  captured(extra?: Record<string, unknown>): Record<string, unknown>
  /**
   * The operator's whole confirmation, for a change already on disk (a
   * rotated credentials file, an edited `config.json`): one tick (which must
   * write the pending file; throws otherwise), the rename (`h.confirm()`),
   * then the tick that applies it, started and returned unawaited as
   * `applying`, so a test can hold a lifecycle call or advance `run.clock`
   * while it runs (`await (await run.confirmPending()).applying`).
   */
  confirmPending(): Promise<{ applying: Promise<void> }>
  /**
   * Run `hook` once, at the next confirmed apply's step 1: after the record
   * was rewritten and the applied set swapped, before step 2 starts (the
   * moment `opts.onApplied` is called, with the same configuration). E.g. to
   * retarget a symlink so a credentials real path collides with another
   * applied persona's after the candidate was validated (b.av2 SR-1.4, apply
   * part). A throw is logged by the controller as a failed `onApplied`.
   */
  beforeApplySteps(hook: (applied: PersonaConfig) => void): void
  /**
   * The stub of the persona's credential set `label` (a harness label, see
   * `RotatedCredentials`; default the persona's latest, `h.credentialsLabel`)
   * in this run: its script queues, captures, sockets and `identity`. The
   * set the run was built with is also `run.stub(name)`. Throws for a set this
   * run does not route (written before it was built and replaced since).
   */
  credentialsStub(name: string, label?: string): StubSlack
  /**
   * The stub of the credential set whose socket most recently connected for
   * the persona (after a reconnect's swap, the new set's; before any
   * connection, `run.stub(name)`): the one serving it now.
   */
  currentStub(name: string): StubSlack
  /**
   * The persona's socket clients in the order things happened to them, as
   * `<event> <harness label>` (`built`, `started`, `connected`, `discarded`,
   * `disconnected`; see `StubClientEvent`), over the factory's activity
   * record: a credentials reconnect that opens the new connection before
   * closing the old reads `…, 'built credentials-2', 'started credentials-2',
   * 'connected credentials-2', 'discarded credentials-1', 'disconnected
   * credentials-1'`. Every kind with its build record: `run.slack.activityOf(key)`.
   */
  socketActivity(name: string): string[]
  /**
   * Make the persona's bot token look revoked to Slack (bug b.ujn): the next
   * call on each Web API queue of its current stub (`currentStub`, or
   * `opts.credentials`) answers the platform error `opts.error` (default
   * `token_revoked`), put at the front of each queue. Whichever call a
   * consumer makes first (a notice, a tool call, a delivery's `users.info`)
   * trips the watch and marks the persona broken; every later call through
   * that client is refused locally and never reaches the stub, so the other
   * scripted entries stay queued. The returned function removes the entries
   * still queued (e.g. before the same tokens are used again). Scripts only;
   * makes no call itself.
   */
  revokeBotToken(name: string, opts?: BotTokenRevocation): () => void
  /**
   * Make a running persona credentials-broken by a refused reopen (b.av2
   * SR-3.3): Slack drops its live socket and the reopen's `start()` is
   * refused with `error` (default `invalid_auth`). Resolves once the manager
   * reports it `broken` (phase `reopen`); throws if it never does. Its
   * instance is kept and its MCP session dropped (`onLeftUp`, as server.ts
   * wires it).
   */
  refuseReopen(name: string, error?: string): Promise<void>
  /**
   * The real up check (`createPersonaUpPredicate` over the manager and the
   * bring-up controller's `isUp` and `isApplied`, as server.ts builds it):
   * whether the persona's instance may register, be served and be launched.
   */
  isUp(name: string): boolean
  /**
   * The MCP admission of the persona's instance, as server.ts decides it
   * (`decideSessionAdmission` over its applied working directory, the
   * applied set and `isUp`, with `describePersonaNotUp` for the one refusal
   * line in `run.logs`): registers the session when admitted, else leaves
   * any registered session as it is.
   */
  admitSession(name: string): ReloadSessionAdmission
  /** Every `run.logs` line naming the persona (its rendered name and key: lifecycle, bring-up, manager and diagnostic lines), in order. */
  linesOf(name: string): string[]
  /**
   * The configuration the server runs now (`server.ts`'s `personaConfig`):
   * the applied persona set over the start's server-wide settings
   * (`configInEffect`), so after an apply that changed `port`, `bind`, the
   * acknowledgement or chunking settings, these still read their start-time
   * values while `h.readRecord()` holds the new ones. Every consumer the run
   * wires (routing, client and identity lookups, notices, tools) and every
   * real launch read it. Undefined before the start applied.
   */
  serverConfig(): PersonaConfig | undefined
  /**
   * The persona's next launch through the restart path (`opts.realLaunch`):
   * what `server.ts`'s restart `launchSession` adapter does, in the
   * persona's serializer turn: `launchSession(key, run.serverConfig(), {
   * canLaunch })` with the real relaunch gate (`createPersonaRelaunchGate`
   * over the manager and the bring-up controller). Recorded as a `launch`
   * via `restart` with its answer (`restart`). Set the row first
   * (`h.seedRow(persona, { state: 'ended' })`) to choose the ladder's path.
   * Resolves with the answer. Throws without `opts.realLaunch`.
   */
  relaunch(name: string): Promise<boolean | 'skipped'>
  /** Every session-manager notice raised (spawn failure, restart cap, lost history) with `opts.realLaunch`, by persona key, in order. */
  readonly sessionNotices: ReadonlyArray<{ readonly key: string; readonly text: string }>
  /** Stop detection (`controller.stopDetection()`, which stops `run.ticks`), cancel every bring-up retry and stop every connection. Idempotent. */
  stop(): Promise<void>
}

/** A run whose start was resolved (and brought up when applied) by `h.start`. */
export interface StartedReloadRun extends ReloadRun {
  readonly outcome: ReloadStartOutcome
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface ReloadHarnessOptions {
  /** Directory to create the root in; the OS temp directory by default. */
  parentDir?: string
  /**
   * Give every `h.persona` its own `claude_config_dir`, `h.configDir(<key>)`
   * (created), unless its overrides name one (`claude_config_dir:
   * undefined` for a persona that inherits the top-level default). Without
   * it a persona has none, so its effective directory is the temp home's
   * `.claude` (`h.home`), never the operator's.
   */
  personaConfigDirs?: boolean
}

/** A persona as far as the file helpers need it. */
export type ReloadPersonaFiles = Pick<PersonaInput, 'name' | 'credentials_file' | 'working_directory'>

export interface ReloadHarness {
  /** The `mkdtempSync` root (real path); every other path is under it. */
  readonly root: string
  /** The configuration directory: only the SR-8.1 files live here. */
  readonly dir: string
  /** The temp home handed to the controller for `~` expansion, and the spawn home of a real launch (nothing is created in it). */
  readonly home: string
  /** The temp state directory the reply-guard steps get (`server.ts`'s `STATE_DIR`), under the root. */
  readonly stateDir: string
  /** The reply-guard record directory, `<stateDir>/reply-guard`: the guard's argument; records are `<replyGuardDir>/<key>`. */
  readonly replyGuardDir: string
  /** The persona's reply-guard record's exact text, or undefined when there is none. */
  readReplyGuardRecord(name: string): string | undefined
  /** A temp `claude_config_dir` under the root named `name` (`<root>/claude-config/<name>`), created; returns its path. */
  configDir(name: string): string
  /**
   * Set or change the persona's agent-director row in the row table (see
   * `AgentDirectorRow`), before a launch, to choose the ladder's path: an
   * `ended` row with an old `config_dir` label is deleted and spawned fresh,
   * one with the current label resumed, a `waiting` one reconnected. A new
   * row takes `seed`'s fields, else the persona's `working_directory`, its
   * `claude_config_dir` for the label and the state `ended`; an existing row
   * changes only the fields given.
   */
  seedRow(
    persona: Pick<PersonaInput, 'name' | 'working_directory' | 'claude_config_dir'>,
    seed?: AgentDirectorRowSeed,
  ): AgentDirectorRow
  /** The persona's row in the row table now; undefined when it has none. */
  rowOf(name: string): AgentDirectorRow | undefined
  /** `reloadFilePaths(<dir>/config.json)`. */
  readonly paths: ReloadFilePaths
  /** The persona key of `name` (`personaKey`). */
  key(name: string): string
  /** A file-form persona named `name`: its own `all` channel, DMs off, paths under `<root>/personas/<key>/`. */
  persona(name: string, overrides?: Partial<PersonaInput>): PersonaInput
  /** Write `input` as JSON to `paths.config`; returns the bytes written. */
  writeConfig(input: unknown): Buffer
  /** Write raw bytes to `paths.config`; returns them. */
  writeConfigBytes(bytes: string | Uint8Array): Buffer
  /** Write `input` as JSON to `paths.lastApplied`, in `writeConfig`'s format; returns the bytes written. */
  writeRecord(input: unknown): Buffer
  /** Write raw bytes to `paths.lastApplied`; returns them. */
  writeRecordBytes(bytes: string | Uint8Array): Buffer
  /** The configuration file's bytes, or undefined when it does not exist. */
  readConfig(): Buffer | undefined
  /** The record's bytes, or undefined when it does not exist. */
  readRecord(): Buffer | undefined
  /** Delete a file or directory under the root (absent is fine). */
  remove(path: string): void
  /** Replace whatever is at `path` (under the root) with an empty directory. */
  replaceWithDirectory(path: string): void
  /** The names in the configuration directory, sorted. */
  configDirEntries(): string[]
  /**
   * The AC 20 directory sweep: every regular file under the root but
   * `excluded` (the operator-written ones: `config.json`, credentials files,
   * a hand-edited record), as a `writtenFile` keyed by its root-relative
   * path, for `assertNoLeak`, which checks both the key (the file's name)
   * and the content. That is what the server wrote anywhere under the root
   * (the pending file, the record, a leftover confirmation, reply-guard
   * records, anything under the state directory or the home). Symlinks are
   * not followed and FIFOs are skipped: the server writes only regular
   * files, so a symlink or FIFO under the root is a test fixture (a
   * `claude_config_dir` link, `h.makeFifo`), a symlink's target is swept
   * where it lives when it is under the root (and may dangle on purpose),
   * and opening a FIFO would block the test.
   */
  serverSideFiles(...excluded: string[]): Record<string, WrittenFile>
  /**
   * Write a valid credentials file for `persona` with a fresh token set;
   * returns the set (never print it). `h.rotateCredentials` without options.
   */
  writeCredentials(persona: Pick<ReloadPersonaFiles, 'name' | 'credentials_file'>): PersonaSlackTokens
  /**
   * Write a valid credentials file for `persona` with a fresh token set (a
   * rotation when it had one) and register the pair with every live run: a
   * run that already routes the persona gets it as a new credential set
   * (`addCredentials`, under the returned `label`, scripted by `opts.slack`),
   * so its old and new tokens answer apart; a run that does not route the
   * persona yet (its first file, created while the run is live) gets it as
   * the persona's set (`run.stub(name)`, scripted by `opts.slack` over the
   * run's `opts.slack[name]`). A run built afterwards routes only the latest
   * set, as `run.stub(name)`.
   */
  rotateCredentials(
    persona: Pick<ReloadPersonaFiles, 'name' | 'credentials_file'>,
    opts?: CredentialsRotationOptions,
  ): RotatedCredentials
  /** The harness label of the latest set `writeCredentials` / `rotateCredentials` wrote for `name`. Throws if none. */
  credentialsLabel(name: string): string
  /** Write `content` (see `CredentialsOverrides`) as `persona`'s credentials file; returns its path. */
  writeCredentialsContent(persona: Pick<ReloadPersonaFiles, 'credentials_file'>, content: CredentialsOverrides): string
  /** The latest token set `writeCredentials` wrote for the persona named `name`. Throws if none. */
  tokens(name: string): PersonaSlackTokens
  /** Create the persona's working directory; returns its path. */
  makeWorkingDirectory(persona: Pick<ReloadPersonaFiles, 'working_directory'>): string
  /** `writeCredentials` and `makeWorkingDirectory` for each persona. */
  materialize(...personas: ReloadPersonaFiles[]): void
  /**
   * Snapshot the persona's credentials file (its bytes, its absence, or an
   * empty directory at its path as `makeCredentialsUnreadable` leaves it) and
   * latest token set; the returned function puts both back exactly (a file
   * with mode 0600), e.g. to revert a rotation.
   */
  saveCredentials(persona: Pick<ReloadPersonaFiles, 'name' | 'credentials_file'>): () => void
  /** Delete the persona's credentials file (absent is fine). */
  deleteCredentials(persona: Pick<ReloadPersonaFiles, 'credentials_file'>): void
  /** Put an empty directory at the persona's credentials path: unreadable as a file, even as root. */
  makeCredentialsUnreadable(persona: Pick<ReloadPersonaFiles, 'credentials_file'>): void
  /** The credentials file's bytes, or undefined when it does not exist. */
  readCredentialsBytes(persona: Pick<ReloadPersonaFiles, 'credentials_file'>): Buffer | undefined
  /**
   * The digest or marker the production reader gives the persona's
   * credentials file as it stands (`credentialsDigest(readCredentialsFile(…))`),
   * to compare with `run.bringUps.credentialsDigest(key)`. Never print it.
   */
  credentialsDigestOf(persona: Pick<ReloadPersonaFiles, 'credentials_file'>): CredentialsDigest
  /** Delete `paths.config` (absent is fine). */
  deleteConfig(): void
  /** Replace whatever is at `path` (under the root) with a FIFO (`mkfifo`); guard the test with `mkfifoAvailable()`. */
  makeFifo(path: string): void
  /** Whether `paths.pending` exists (as anything). */
  pendingExists(): boolean
  /** `paths.pending`'s bytes, or undefined when it is not a readable file. */
  readPending(): Buffer | undefined
  /** `paths.pending` as UTF-8 text, or undefined when it is not a readable file. */
  readPendingText(): string | undefined
  /** The fingerprint `paths.pending` records (`parsePendingFingerprint`), or undefined when absent or not in the pending layout. */
  pendingFingerprint(): string | undefined
  /** Write raw bytes to `paths.pending` (a leftover or hand-placed file); returns them. */
  writePendingBytes(bytes: string | Uint8Array): Buffer
  /**
   * The operator's confirmation gesture (b.av2 SR-8.5, AC 73): rename
   * `paths.pending` to `paths.apply`, content unchanged. Throws when there is
   * no pending file.
   */
  confirm(): void
  /** Write raw bytes to `paths.apply` (an older pending copy, a malformed confirmation); returns them. */
  writeApplyBytes(bytes: string | Uint8Array): Buffer
  /** Whether `paths.apply` exists (as anything). */
  applyExists(): boolean
  /** `paths.apply`'s bytes, or undefined when it is not a readable file. */
  readApply(): Buffer | undefined
  /**
   * Write a file larger than the 64 KiB read cap at `path` (under the root):
   * `prefix` (none by default), then sentinel-bearing fake-token text, `size`
   * bytes in all (`MAX_RELOAD_FILE_BYTES + 1` by default). Returns the bytes.
   */
  writeOversized(path: string, opts?: { prefix?: string | Uint8Array; size?: number }): Buffer
  /**
   * The preview body of `paths.pending`: the text after its two fingerprint
   * lines and the blank line (found through `parsePendingFingerprint` and
   * `composePendingFile`), without the file's final newline, so it equals
   * `renderPreview(plan)`. Undefined when the file is absent, not a regular
   * file, or not in the pending layout.
   */
  pendingBody(): string | undefined
  /** `pendingBody()` split into its lines; undefined when there is no body. */
  pendingLines(): string[] | undefined
  /** The preview's first line (the header, or the `INVALID:` line); undefined when there is no body. */
  pendingHeader(): string | undefined
  /** The body's lines starting `DESTRUCTIVE:` (`DESTRUCTIVE_PREFIX`), in order; undefined when there is no body. */
  pendingDestructiveLines(): string[] | undefined
  /**
   * A file-form persona (`h.persona(name, overrides)`) whose credentials
   * file and working directory are left in the given states (see
   * `PreparedCredentials`, `PreparedWorkingDirectory`; by default `valid`
   * and `present`, so it can come up). Whatever was at either path is
   * replaced. For an added persona that cannot come up, e.g.
   * `h.preparePersona('delta', { credentials: 'missing', workingDirectory: 'missing' })`.
   */
  preparePersona(name: string, state?: PreparedPersonaState, overrides?: Partial<PersonaInput>): PersonaInput
  /** Delete the persona's working directory (absent is fine). */
  deleteWorkingDirectory(persona: Pick<ReloadPersonaFiles, 'working_directory'>): void
  /** Put a plain empty file at the persona's working-directory path (replacing whatever was there). */
  makeWorkingDirectoryAFile(persona: Pick<ReloadPersonaFiles, 'working_directory'>): void
  /** Make the controller's durable writer fail (default every `openSync` call, `EIO`) until cleared. */
  failWrites(failure?: Partial<WriteFailure>): void
  /** Let the controller's durable writer succeed again. */
  clearWriteFailure(): void
  /**
   * Make the controller's durable delete fail (default every `unlinkSync`
   * call, `EIO`) until cleared: its own seam, counted apart from
   * `failWrites`. `{ step: 'fsyncSync' }` fails the directory fsync after
   * the unlink (the file is then gone).
   */
  failRemoves(failure?: Partial<WriteFailure>): void
  /** Let the controller's durable delete succeed again. */
  clearRemoveFailure(): void
  /**
   * Set `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` to distinct sentinel-bearing
   * fakes and record every read of them through `process.env` (a proxy over
   * it), until the returned watch's `restore()` or `h.cleanup()`: to show
   * that nothing uses or reads the token environment. At most one at a time.
   */
  poisonTokenEnvironment(): TokenEnvironmentWatch
  /** Build a run without resolving its start. */
  build(opts?: ReloadRunOptions): ReloadRun
  /** Build a run, resolve its start and, when applied, run the start bring-up pass. */
  start(opts?: ReloadRunOptions): Promise<StartedReloadRun>
  /**
   * `start`, then `run.startDetection()`, as `main()` does. Throws when the
   * tick was not armed (a refused start); use `start` and
   * `run.startDetection()` to test that.
   */
  startDetecting(opts?: ReloadRunOptions): Promise<StartedReloadRun>
  /** Every run built, in order. */
  readonly runs: readonly ReloadRun[]
  /** Stop every run and remove the root; then throw if a stand-in refused a call that needs `opts.realLifecycle`. */
  cleanup(): Promise<void>
}

/** First part of every channel ID `h.persona` assigns. */
const CHANNEL_ID_STEM = 'C0RLD'

/** An errno-style error for the write-failure seam. */
function injectedWriteError(failure: WriteFailure): Error {
  return Object.assign(new Error(`${failure.code}: reload-harness injected ${failure.step} failure`), {
    code: failure.code,
  })
}

/** A `DurableWriteFs` over the real calls, each failing while the armed failure names it. */
interface FailureSeam {
  readonly fs: DurableWriteFs
  fail(failure?: Partial<WriteFailure>): void
  clear(): void
}

function makeFailureSeam(defaultStep: DurableWriteStep): FailureSeam {
  let failure: WriteFailure | undefined
  /** Calls of `failure.step` since `fail`. */
  let failingStepCalls = 0

  function seamCall<A extends unknown[], R>(step: DurableWriteStep, call: (...args: A) => R): (...args: A) => R {
    return (...args) => {
      if (failure?.step === step) {
        failingStepCalls++
        if (failure.call === undefined || failure.call === failingStepCalls) throw injectedWriteError(failure)
      }
      return call(...args)
    }
  }

  return {
    fs: {
      openSync: seamCall('openSync', (path: string, flags: string) => openSync(path, flags)),
      writeSync: seamCall('writeSync', (fd: number, buffer: Uint8Array, offset: number, length: number) =>
        writeSync(fd, buffer, offset, length),
      ),
      fsyncSync: seamCall('fsyncSync', (fd: number) => fsyncSync(fd)),
      closeSync: seamCall('closeSync', (fd: number) => closeSync(fd)),
      renameSync: seamCall('renameSync', (from: string, to: string) => renameSync(from, to)),
      unlinkSync: seamCall('unlinkSync', (path: string) => unlinkSync(path)),
    },
    fail(f = {}) {
      failure = { step: f.step ?? defaultStep, code: f.code ?? 'EIO', call: f.call }
      failingStepCalls = 0
    },
    clear() {
      failure = undefined
    },
  }
}

/** Build the harness described in the file comment. */
export function makeReloadHarness(opts: ReloadHarnessOptions = {}): ReloadHarness {
  const root = realpathSync(mkdtempSync(join(opts.parentDir ?? tmpdir(), 'reload-harness-')))
  const dir = join(root, 'config')
  const home = join(root, 'home')
  mkdirSync(dir)
  mkdirSync(home)
  const stateDir = join(root, 'state')
  const replyGuardDir = join(stateDir, REPLY_GUARD_DIR_NAME)
  mkdirSync(stateDir)
  const paths = reloadFilePaths(join(dir, 'config.json'))

  /** The agent-director row table, by instance ID: shared by every run (see `AgentDirectorRow`). */
  const rows = new Map<string, { state: string; cwd: string; labels: Record<string, string> }>()
  /** A realLaunch run installed the session manager's module seams: reset them at cleanup. */
  let launchSeamsInstalled = false
  /** `console.error` before the harness captured it (a realLaunch run), restored at cleanup. */
  const originalConsoleError = console.error
  let consoleCaptured = false
  /** Where captured console lines go: the latest live realLaunch run's log. */
  const consoleSinks: Array<{ readonly lines: string[]; readonly live: () => boolean }> = []

  function captureConsole(sink: { readonly lines: string[]; readonly live: () => boolean }): void {
    consoleSinks.push(sink)
    if (consoleCaptured) return
    consoleCaptured = true
    console.error = (...args: unknown[]) => {
      const target = [...consoleSinks].reverse().find((s) => s.live())
      if (target === undefined) return originalConsoleError(...args)
      target.lines.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' '))
    }
  }

  const channels = new Map<string, string>()
  const tokensByName = new Map<string, PersonaSlackTokens>()
  /** The harness label (`credentials-<n>`) of each persona's latest token set, by name. */
  const labelsByName = new Map<string, string>()
  const credentialWrites = new Map<string, number>()
  const runs: ReloadRun[] = []
  /** Per run: register a token set written after the run was built with its stub factory. */
  const lateRegistrations: Array<
    (name: string, tokens: PersonaSlackTokens, label: string, slack: StubSlackOptions | undefined) => void
  > = []
  let outageStateInstalled = false
  /** A run registered an MCP session (or delivered through the routing): reset the registry and ack tracker at cleanup. */
  let registryTouched = false
  let tokenWatch: TokenEnvironmentWatch | undefined
  /**
   * Every stand-in call refused because it needs `opts.realLifecycle`. The
   * refusal otherwise shows only as the controller's one line for a rejected
   * lifecycle call, so `h.cleanup()` throws these.
   */
  const standInRefusals: string[] = []

  /** `path`, resolved, if it is strictly under the root; throws otherwise. */
  function inside(path: string): string {
    const full = resolve(root, path)
    const rel = relative(root, full)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`reload-harness: path must be under the harness root, got ${JSON.stringify(path)}`)
    }
    return full
  }

  function serialize(input: unknown): Buffer {
    return Buffer.from(JSON.stringify(input, null, 2), 'utf-8')
  }

  function writeBytes(path: string, bytes: string | Uint8Array): Buffer {
    const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf-8') : Buffer.from(bytes)
    writeFileSync(inside(path), buf)
    return buf
  }

  function readIfPresent(path: string): Buffer | undefined {
    return existsSync(path) ? readFileSync(path) : undefined
  }

  /** A regular file's bytes; undefined when absent or not a regular file (a directory, a FIFO: never opened). */
  function readFileIfPresent(path: string): Buffer | undefined {
    try {
      if (!statSync(path).isFile()) return undefined
    } catch {
      return undefined
    }
    return readFileSync(path)
  }

  const writeSeam = makeFailureSeam('openSync')
  const removeSeam = makeFailureSeam('unlinkSync')

  function build(runOpts: ReloadRunOptions = {}): ReloadRun {
    const dryRun = runOpts.dryRun ?? false
    const realLaunch = runOpts.realLaunch === true
    const realLifecycle = runOpts.realLifecycle === true || realLaunch
    // With the real composition, one serializer shared by the manager, the
    // bring-up controller and the lifecycle, as server.ts shares its one.
    const serializer = realLifecycle ? createPersonaSerializer() : undefined
    const connections = makeConnectionHarness(
      [...tokensByName.keys()].map((name) => ({ name })),
      root,
      {
        dryRun,
        stubOptions: runOpts.slack,
        tokens: Object.fromEntries(tokensByName),
        ...(serializer === undefined ? {} : { serialize: serializer.run }),
      },
    )
    const logs = connections.lines
    const log = (line: string) => void logs.push(line)
    const records: ReloadLifecycleRecord[] = []
    const startPasses: PersonaConfig[] = []
    const writes: ReloadWriteRecord[] = []
    const removes: ReloadRemoveRecord[] = []
    const appliedConfigs: PersonaConfig[] = []
    let startHold: Promise<void> | undefined
    let outcome: ReloadStartOutcome | undefined
    /** The configuration the start applied (`run.resolveStart()`): its server-wide settings stay in effect. */
    let startConfig: PersonaConfig | undefined
    let installedTemplateCache: MakeTemplateParams | undefined
    const sessionNotices: Array<{ key: string; text: string }> = []

    /** The start's configuration: what `run.resolveStart()` applied, else the start pass's. */
    function startTimeConfig(): PersonaConfig | undefined {
      return startConfig ?? startPasses[0]
    }

    function record(
      op: ReloadLifecycleOp,
      key: string,
      via: ReloadLifecycleVia,
      extra: Pick<ReloadLifecycleRecord, 'recovery'> = {},
    ): ReloadLifecycleRecord {
      const entry: ReloadLifecycleRecord = { op, key, via, ...extra }
      records.push(entry)
      return entry
    }

    // Declared before the bring-up controller, whose applied-set getter reads it (late).
    let controller!: ReloadController

    /** `server.ts`'s `personaConfig`: the applied persona set over the start's server-wide settings. */
    function serverConfig(): PersonaConfig | undefined {
      const applied = controller.applied()?.config
      if (applied === undefined) return undefined
      const start = startTimeConfig()
      return start === undefined ? applied : configInEffect(start, applied)
    }

    /**
     * One launch of `persona`, recorded; with `opts.realLaunch` the real
     * launch path over the configuration the server runs (never a startup
     * launch, so nothing reaches `startup-errors.log`).
     */
    async function launch(persona: Persona, via: ReloadLifecycleVia): Promise<void> {
      const entry = record('launch', persona.key, via)
      if (!realLaunch) return
      const config = serverConfig()
      if (config === undefined) throw new Error('reload-harness: a real launch ran before the start applied a configuration')
      entry.action = (await spawnForPersona(persona, config, false)).action
    }

    const bringUps = createPersonaBringUpController({
      connections: {
        bringUp: (persona, tokens) => connections.connections.bringUp(persona, tokens),
        status: (key) => connections.manager.status(key),
        // As server.ts wires it (the manager itself): a claude_config_dir
        // hold that starts later closes the persona's connection (bug b.g57).
        stop: (key) => connections.manager.stop(key),
      },
      clock: connections.clock,
      dryRun,
      log,
      fs: runOpts.bringUpFs,
      launch: (persona) => launch(persona, 'retry'),
      // As server.ts wires it: a persona's claude_config_dir is checked
      // before its Slack step, and re-checked while it is held, exactly as
      // the launch checks it (bug b.g57). Without a real launch, against the
      // temp home as the reload controller checks it, never the process home.
      checkConfigDir: realLaunch ? checkLaunchConfigDir : (persona) => checkPersonaConfigDir(persona, { home }),
      // As server.ts wires it: a persona that stops being up (a refused
      // reopen, a Web API call refused for its bot token) has its registered
      // MCP session dropped; its instance is kept.
      onLeftUp: createNotUpSessionDropper({ drop: dropPersonaSession, log }),
      // As server.ts wires it, with the real composition only.
      ...(serializer === undefined
        ? {}
        : { serialize: serializer.run, appliedPersonas: () => controller.applied()?.config.personas ?? [] }),
    })

    // The consumers of the applied settings, as server.ts wires them: each
    // reads the server's `personaConfig` (the applied persona set over the
    // start's server-wide settings) at call time.
    const appliedConfig = () => serverConfig() ?? null
    const getAppliedPersona = (key: string): Persona | undefined => appliedConfig()?.personas.find((p) => p.key === key)
    const clientFor = createPersonaClientLookup(connections.manager, appliedConfig)
    const identityFor = createPersonaIdentityLookup(connections.manager, appliedConfig)
    // server.ts's one up check (MCP admission, the poller's skip, /interject).
    const isPersonaUp = createPersonaUpPredicate(connections.manager, {
      isUp: (key) => bringUps.isUp(key),
      isApplied: (key) => bringUps.isApplied(key),
    })
    // server.ts's relaunch gate (the restart module and its launch).
    const relaunchGate = createPersonaRelaunchGate(connections.manager, log, bringUps)
    const resolveUserName = async (key: string, userId: string): Promise<string> => {
      const client = clientFor(key)
      if (!client) return userId
      const res = await client.users.info({ user: userId })
      return res.user?.profile?.display_name || userId
    }
    const noticeStack = makeNotifierStack({ getPersona: getAppliedPersona, clientFor, log, isDryRun: () => dryRun })
    // server.ts's getReplySettings: config.ts's replySettingsOf over
    // `personaConfig` at call time, so after an apply the start's values
    // (configInEffect). No ack reaction unless the start's config sets one.
    const getReplySettings = (): ReplySettings => replySettingsOf(serverConfig())
    const routing = createPersonaRouting({
      getPersonaConfig: appliedConfig,
      getBotIdentity: identityFor,
      clientFor,
      resolveUserName,
      archive: () => undefined,
      getReplySettings,
      notify: (key, text, options) => noticeStack.notifier.notify(key, text, options),
      log,
      dedupeClock: () => connections.clock.now(),
      // As server.ts wires it: a lost message for a persona that is not up restarts nothing.
      isPersonaUp,
    })
    connections.onEvent = createPersonaEventRouter({ routing, clientFor, getPersona: getAppliedPersona, log })
    connections.onStatus = composePersonaStatusListeners(
      createPersonaUpFlushListener(noticeStack.notifier),
      (key, status) => bringUps.onConnectionStatus(key, status),
    )

    const composition = realLifecycle ? buildComposition() : undefined

    /** The real composition over this run (`opts.realLifecycle`); see `RealLifecycleComposition`. */
    function buildComposition(): RealLifecycleComposition & { readonly client: unknown } {
      const calls: Array<readonly [string, string]> = []
      const agentDirector = makeStubCallLog()
      const agentDirectorOrder: string[] = []
      const agentDirectorCalls: AgentDirectorCall[] = []
      const templateFailures: Error[] = []
      const stub = makeStubClient({ ...runOpts.agentDirector, ...agentDirector })
      /** Log `call`, run `body`, and note on `call` how it ended. */
      async function tracked<T>(call: AgentDirectorCall, body: () => Promise<T>): Promise<T> {
        agentDirectorCalls.push(call)
        try {
          const result = await body()
          call.result = 'ok'
          return result
        } catch (err) {
          call.result = errorName(err)
          throw err
        }
      }
      /** A row the table holds for `id`, or ErrSpawnNotFound (agent-director's answer for an unknown instance). */
      const rowFor = (id: string) => {
        const row = rows.get(id)
        if (row === undefined) throw errSpawnNotFound()
        return row
      }
      // The stub behind the harness's row table: each verb goes through the
      // stub first (its captures and scripted outcomes), then acts on the row.
      const client = {
        ...stub,
        kill(params: Parameters<typeof stub.kill>[0]) {
          const id = params.claude_instance_id
          agentDirectorOrder.push(`kill ${id}`)
          return tracked({ verb: 'kill', id }, async () => {
            const result = await stub.kill(params)
            const row = rows.get(id)
            if (row !== undefined) row.state = 'ended'
            return result
          })
        },
        delete(params: Parameters<typeof stub.delete>[0]) {
          const ids = params.claude_instance_id
          agentDirectorOrder.push(`delete ${ids.join(',')}`)
          return tracked({ verb: 'delete', id: ids.join(',') }, async () => {
            const result = await stub.delete(params)
            for (const id of ids) rows.delete(id)
            return result
          })
        },
        spawn(params: SpawnParams) {
          const id = String(params.claude_instance_id)
          const labels = parseLabels(params.label)
          const call: AgentDirectorCall = {
            verb: 'spawn',
            id,
            cwd: params.cwd,
            claudeConfigDir: params.extra_env?.['CLAUDE_CONFIG_DIR'],
            configDirLabel: labels[CONFIG_DIR_LABEL],
          }
          return tracked(call, async () => {
            if (rows.has(id)) {
              agentDirector.spawnCalls.push(params)
              throw errInstanceIdCollision()
            }
            const result = await stub.spawn(params)
            rows.set(id, { state: 'waiting', cwd: params.cwd, labels })
            return result
          })
        },
        resume(params: Parameters<typeof stub.resume>[0]) {
          const id = params.claude_instance_id
          return tracked({ verb: 'resume', id }, async () => {
            const result = await stub.resume(params)
            rowFor(id).state = 'waiting'
            return result
          })
        },
        get(params: Parameters<typeof stub.get>[0]) {
          const id = params.claude_instance_id
          return tracked({ verb: 'get', id }, async () => {
            agentDirector.getCalls.push(params)
            const row = rowFor(id)
            return cannedGetResult({ claude_instance_id: id, state: row.state, cwd: row.cwd, labels: { ...row.labels } })
          })
        },
        status(params: Parameters<typeof stub.status>[0]) {
          const id = params.claude_instance_id
          return tracked({ verb: 'status', id }, async () => {
            agentDirector.statusCalls.push(params)
            const row = rowFor(id)
            // A working instance's turn is over by the first poll.
            if (row.state === 'working') row.state = 'waiting'
            return { state: row.state }
          })
        },
        sendKeys: (params: Parameters<typeof stub.sendKeys>[0]) =>
          tracked({ verb: 'sendKeys', id: params.claude_instance_id }, () => stub.sendKeys(params)),
        readPane: (params: Parameters<typeof stub.readPane>[0]) =>
          tracked({ verb: 'readPane', id: params.claude_instance_id }, () => stub.readPane(params)),
        findMissing: (params: Parameters<typeof stub.findMissing>[0]) =>
          tracked({ verb: 'findMissing' }, () => stub.findMissing(params)),
        makeTemplate: (params: MakeTemplateParams) =>
          tracked({ verb: 'makeTemplate' }, async () => {
            const failure = templateFailures.shift()
            if (failure === undefined) return stub.makeTemplate(params)
            agentDirector.makeTemplateCalls.push(params)
            throw failure
          }),
      }
      // The real kill and delete run through withOutageDetection, whose
      // module state this installs (reset by `h.cleanup()`).
      initOutageState({
        getClient: () => client as unknown as ReturnType<Parameters<typeof initOutageState>[0]['getClient']>,
        notify: (key) => void calls.push(['outage-notice', key]),
      })
      outageStateInstalled = true
      /** A recording dependency: logs `[member, key]`, then returns `result(key)`. */
      const rec =
        <R>(member: string, result: (key: string) => R = () => undefined as R) =>
        (key: string): R => {
          calls.push([member, key])
          return result(key)
        }
      const lifecycle = createPersonaLifecycle({
        serialize: serializer!.run,
        bringUps: {
          bringUp: (persona, applied) => {
            calls.push(['bringUps.bringUp', persona.key])
            return bringUps.bringUp(persona, applied)
          },
          cancel: rec('bringUps.cancel', (key) => bringUps.cancel(key)),
          // A query (a recovery's re-check): not recorded.
          state: (key) => bringUps.state(key),
          changeCredentials: (persona, applied, changeConnections, hooks) => {
            calls.push(['bringUps.changeCredentials', persona.key])
            return bringUps.changeCredentials(persona, applied, changeConnections, hooks)
          },
        },
        connections: {
          stop: rec('connections.stop', (key) => connections.manager.stop(key)),
          // Every argument forwarded: the lifecycle's DM forget runs in `beforeSwap`.
          reconnectCredentials: (key, tokens, onLaterOutcome, beforeSwap) => {
            calls.push(['connections.reconnectCredentials', key])
            return connections.manager.reconnectCredentials(key, tokens, onLaterOutcome, beforeSwap)
          },
          replaceRetryTokens: (key, tokens) => {
            calls.push(['connections.replaceRetryTokens', key])
            return connections.manager.replaceRetryTokens(key, tokens)
          },
        },
        routing: { forget: rec('routing.forget') },
        // The real tracker's per-key forget, as server.ts binds it, so a key
        // added again starts with no ack-reaction entry.
        forgetAcks: rec('forgetAcks', (key) => forgetPersonaAcks(key)),
        // The run's one destination resolver, which the notices post through.
        destinations: { forget: rec('destinations.forget', (key) => noticeStack.destinations.forget(key)) },
        destinationHold: { cancel: rec('destinationHold.cancel') },
        notifier: { forget: rec('notifier.forget', () => 0) },
        appliedPersonas: () => controller.applied()?.config.personas ?? [],
        dryRun,
        // An apply here never runs during shutdown.
        isShuttingDown: () => false,
        log,
        whenLaunchSettled: rec('whenLaunchSettled', (key) => whenLaunchSettled(key)),
        cancelRestartTimer: rec('cancelRestartTimer', () => false),
        forgetFailures: rec('forgetFailures'),
        forgetDisconnectedStreak: rec('forgetDisconnectedStreak'),
        resetOutageState: (keys) => {
          for (const key of keys) calls.push(['resetOutageState', key])
        },
        forgetPersonaPrompts: rec('forgetPersonaPrompts', () => 0),
        dropSession: rec('dropSession', async () => undefined),
        killInstance: (key) => {
          calls.push(['killInstance', key])
          return killPersonaInstance(key)
        },
        deleteInstance: (key) => {
          calls.push(['deleteInstance', key])
          return deletePersonaInstance(key)
        },
        // With the real launch path, the real reply-guard members over the
        // harness's state directory, as server.ts binds them; else recorders.
        replyGuard: {
          launchedWithDir: rec<string | undefined>('replyGuard.launchedWithDir', (key) =>
            realLaunch ? getLaunchedWithDir(key) : undefined,
          ),
          teardown: rec('replyGuard.teardown', (key) => (realLaunch ? teardownPersonaReplyGuard(stateDir, key) : undefined)),
          launchPass: (dirs, personas) => {
            calls.push(['replyGuard.launchPass', personas.map((p) => p.key).join(',')])
            if (realLaunch) stopHookLaunchPass(dirs, personas, stateDir)
          },
        },
        storageCheck: (persona) => void calls.push(['storageCheck', persona.key]),
        launch: async (persona) => {
          calls.push(['launch', persona.key])
          await launch(persona, 'apply')
        },
        // Step 5 keeps what the start's install wrote, read when it runs.
        templateRefresh: {
          get installed() {
            const installed = installedTemplate()
            if (installed === undefined) throw new Error('reload-harness: a template refresh ran before the start applied')
            return installed
          },
          getClient: () => client,
        },
      })
      return {
        lifecycle,
        agentDirector,
        agentDirectorOrder,
        calls,
        agentDirectorCalls,
        instanceCallsOf: (name) => {
          const id = personaInstanceId(personaKey(name))
          return agentDirectorCalls.filter((c) => c.id === id && INSTANCE_VERBS.has(c.verb))
        },
        get installedTemplate() {
          return installedTemplate()
        },
        failTemplateRefresh: (err) => void templateFailures.push(err),
        client,
      }
    }

    /**
     * The template params the start's install writes, over the start
     * configuration; see `installedTemplate`. Built once, when the start
     * applies (`run.resolveStart()`), as `server.ts` installs it at start: the
     * append file is probed then, never at a later read.
     */
    function installTemplateAtStart(start: PersonaConfig): void {
      installedTemplateCache = buildTemplateParams(start, {
        accessSync: (path, mode) => accessSync(path, mode),
        stderrWrite: log,
      })
    }

    /** What the start's install wrote; undefined until the start applied. */
    function installedTemplate(): MakeTemplateParams | undefined {
      return installedTemplateCache
    }

    const timeline: LifecycleTimelineEntry[] = []
    const applyTimeline: ApplyTimelineEntry[] = []
    const gates = new Map<string, { enter: () => void; wait: Promise<void> }>()

    /** One `timeline` / `applyTimeline` entry (step 5's only in the latter). */
    function onTimeline(op: LifecycleGateOp | 'template-refresh', key: string, phase: LifecycleTimelineEntry['phase']): void {
      if (op === 'template-refresh') {
        applyTimeline.push({ op, key: TEMPLATE_REFRESH_KEY, phase })
        return
      }
      const entry: LifecycleTimelineEntry = { op, key, phase }
      timeline.push(entry)
      applyTimeline.push(entry)
    }

    /**
     * One apply-time call of `op` for `key`: its `start` entry, then the
     * test's gate (if one was set with `hold`), then `body`, then `settled`
     * or `rejected`.
     */
    async function gated<T>(op: LifecycleGateOp | 'template-refresh', key: string, body: () => Promise<T>): Promise<T> {
      onTimeline(op, key, 'start')
      let result: T
      try {
        const gate = gates.get(`${op} ${key}`)
        if (gate !== undefined) {
          gates.delete(`${op} ${key}`)
          gate.enter()
          await gate.wait
        }
        result = await body()
      } catch (err) {
        onTimeline(op, key, 'rejected')
        throw err
      }
      onTimeline(op, key, 'settled')
      return result
    }

    /** One persona's bring-up through the real controller, then its recorded launch when up. */
    async function bringUpAndLaunch(
      persona: Persona,
      applied: PersonaConfig,
      via: ReloadLifecycleVia,
      entry: ReloadLifecycleRecord = record('bring-up', persona.key, via),
    ): Promise<void> {
      entry.result = await bringUps.bringUp(persona, applied.personas)
      if (entry.result.outcome === 'up') await launch(persona, via)
    }

    /**
     * Refuse a stand-in call that would diverge from the lifecycle
     * (`createPersonaLifecycle`): recorded for `h.cleanup()`, then thrown.
     */
    function needsRealLifecycle(what: string, persona: Persona, reason: string): never {
      const message = `reload-harness: the stand-in ${what} of ${JSON.stringify(persona.name)} would diverge from the lifecycle (${reason}): pass opts.realLifecycle`
      standInRefusals.push(message)
      throw new Error(message)
    }

    /**
     * Whether the persona has had a `dm` destination in this run (the start
     * configuration, any applied one or the entry the call got): the run's
     * destination resolver may then hold a cached DM conversation for it,
     * which the lifecycle forgets and the stand-ins do not. A channel
     * destination never caches one.
     */
    function mayHaveCachedDm(persona: Persona): boolean {
      const entries = [...startPasses, ...appliedConfigs].flatMap((c) => c.personas.filter((p) => p.key === persona.key))
      return [persona, ...entries].some((p) => p.permission_prompts === DM_DESTINATION)
    }

    /**
     * The stand-in recovery bring-up (no composition), for a persona still
     * broken by its credentials when it runs: its bring-up state cancelled
     * and its connection stopped, then brought up afresh, as the lifecycle
     * does. A persona no longer broken by its credentials (the lifecycle
     * applies the change as a reconnect), or one that may hold a cached DM
     * conversation (the lifecycle forgets it), needs the real composition.
     */
    async function standInRecovery(persona: Persona, applied: PersonaConfig, entry: ReloadLifecycleRecord): Promise<void> {
      if (!isCredentialsBroken(bringUps.state(persona.key))) {
        needsRealLifecycle('recovery bring-up', persona, 'it is no longer broken by its credentials')
      }
      if (mayHaveCachedDm(persona)) needsRealLifecycle('recovery bring-up', persona, 'it has had a dm destination')
      bringUps.cancel(persona.key)
      await connections.manager.stop(persona.key)
      await bringUpAndLaunch(persona, applied, 'apply', entry)
    }

    const ops: Required<ReloadLifecycleOps> = {
      async startBringUp(applied) {
        startPasses.push(applied)
        connections.config = applied
        await Promise.all(applied.personas.map((persona) => bringUpAndLaunch(persona, applied, 'start')))
        if (startHold !== undefined) await startHold
      },
      async bringUp(persona, applied, options?: ApplyBringUpOptions) {
        connections.config = applied
        const recovery = options?.recovery === true
        if (composition === undefined && !recovery) {
          await gated('bring-up', persona.key, () => bringUpAndLaunch(persona, applied, 'apply'))
          return
        }
        const entry = record('bring-up', persona.key, 'apply', recovery ? { recovery: true } : {})
        await gated('bring-up', persona.key, async () => {
          if (composition === undefined) await standInRecovery(persona, applied, entry)
          else entry.result = await composition.lifecycle.bringUp(persona, applied, options)
        })
      },
      async teardown(persona) {
        record('teardown', persona.key, 'apply')
        await gated('teardown', persona.key, async () => {
          if (composition !== undefined) {
            await composition.lifecycle.teardown(persona)
            return
          }
          // The old half of a destructive modify keeps its key applied, so
          // its new half would post through a DM conversation the lifecycle
          // forgets and the stand-in does not.
          const stillApplied = controller.applied()?.config.personas.some((p) => p.key === persona.key) === true
          if (stillApplied && mayHaveCachedDm(persona)) {
            needsRealLifecycle('destructive-modify teardown', persona, 'it has had a dm destination')
          }
          bringUps.cancel(persona.key)
          await connections.manager.stop(persona.key)
        })
      },
      async refreshTemplate(applied) {
        const entry = record('template-refresh', TEMPLATE_REFRESH_KEY, 'apply')
        return gated('template-refresh', TEMPLATE_REFRESH_KEY, async () => {
          // The stand-in calls nothing: only the record and timeline show it.
          if (composition === undefined) return undefined
          entry.refresh = await composition.lifecycle.refreshTemplate(applied)
          return entry.refresh
        })
      },
      async reconnectCredentials(persona, applied) {
        connections.config = applied
        const entry = record('reconnect', persona.key, 'apply')
        // The result goes back to the step bodies: a `credentials-broken` one
        // leaves the persona to step 6's recovery bring-up.
        return gated('reconnect', persona.key, async () => {
          if (composition !== undefined) {
            entry.change = await composition.lifecycle.reconnectCredentials(persona, applied)
            return entry.change
          }
          // The stand-in: the real controller's change over the manager. The
          // lifecycle also forgets the cached DM conversation right before the
          // swap; a persona that may hold one needs the real composition.
          if (mayHaveCachedDm(persona)) needsRealLifecycle('credentials reconnect', persona, 'it has had a dm destination')
          entry.change = await bringUps.changeCredentials(persona, applied.personas, connections.manager)
          return entry.change
        })
      },
      async updateInPlace(change: InPlaceApplyInput) {
        const { key } = change.persona
        records.push({ op: 'update-in-place', key, via: 'apply', settings: [...change.settings] })
        await gated('update-in-place', key, async () => {
          if (composition !== undefined) await composition.lifecycle.updateInPlace(change)
        })
      },
    }

    function latestResolvedBringUp(key: string): ReloadLifecycleRecord | undefined {
      return records.filter((r) => r.op === 'bring-up' && r.key === key && r.result !== undefined).at(-1)
    }

    const lifecycle: ReloadLifecycleRecorder = {
      ops,
      records,
      startPasses,
      timeline,
      applyTimeline,
      of: (op) => records.filter((r) => r.op === op),
      keys: (op) => records.filter((r) => r.op === op).map((r) => r.key),
      outcome: (key) => latestResolvedBringUp(key)?.result?.outcome,
      classes: (key) => latestResolvedBringUp(key)?.result?.failures.map((f) => f.class) ?? [],
      holdStartPass() {
        let release!: () => void
        let fail!: (err: Error) => void
        startHold = new Promise<void>((done, reject) => {
          release = done
          fail = reject
        })
        // Handled here too, so a `fail` before the pass reaches its await is no unhandled rejection.
        startHold.catch(() => undefined)
        return Object.assign(() => release(), { fail })
      },
      hold(op: LifecycleGateOp | 'template-refresh', key: string = TEMPLATE_REFRESH_KEY) {
        let enter!: () => void
        let release!: () => void
        let fail!: (err: Error) => void
        const entered = new Promise<void>((done) => (enter = done))
        const wait = new Promise<void>((done, reject) => {
          release = done
          fail = reject
        })
        // Handled here too, so a `fail` before the call arrives is no unhandled rejection.
        wait.catch(() => undefined)
        gates.set(`${op} ${key}`, { enter, wait })
        return { entered, release: () => release(), fail: (err) => fail(err) }
      },
    }

    const ticks = createManualTickDriver()
    const tickCredentialsReads: string[] = []
    const tickDirectoryChecks: string[] = []
    const credentialsFs: Partial<CredentialsFs> = {
      ...runOpts.credentialsFs,
      openFile: (path) => {
        tickCredentialsReads.push(path)
        return (runOpts.credentialsFs?.openFile ?? DEFAULT_CREDENTIALS_FS.openFile)(path)
      },
    }
    const workingDirectoryFs: Partial<WorkingDirectoryFs> = {
      stat: (path) => {
        tickDirectoryChecks.push(path)
        return DEFAULT_WORKING_DIRECTORY_FS.stat(path)
      },
    }
    controller = createReloadController({
      paths,
      lifecycle: ops,
      log,
      write: (path, bytes) => {
        runOpts.beforeWrite?.(path)
        try {
          durableWriteFileSync(path, bytes, writeSeam.fs)
        } catch (err) {
          writes.push({ path, ok: false })
          throw err
        }
        writes.push({ path, ok: true })
      },
      remove: (path) => {
        let removed: boolean
        try {
          removed = durableUnlinkSync(path, removeSeam.fs)
        } catch (err) {
          const unsynced = err instanceof DurableUnlinkUnsyncedError
          removes.push(unsynced ? { path, ok: true, removed: true, unsynced } : { path, ok: false, removed: undefined, unsynced })
          throw err
        }
        removes.push({ path, ok: true, removed, unsynced: false })
        return removed
      },
      tickDriver: runOpts.tickDriver?.({ clock: connections.clock, log }) ?? ticks,
      dryRun,
      heldCredentialsDigest: (key) => {
        const held = (k: string) => bringUps.credentialsDigest(k)
        return runOpts.heldCredentialsDigest === undefined ? held(key) : runOpts.heldCredentialsDigest(key, held)
      },
      bringUpState: (key) => {
        const state = (k: string) => bringUps.state(k)
        return runOpts.bringUpState === undefined ? state(key) : runOpts.bringUpState(key, state)
      },
      credentialsFs,
      workingDirectoryFs,
      slackClientFactory: connections.slack.factory,
      home,
      configFs: runOpts.configFs,
      applySteps: runOpts.applySteps,
      onApplied: (config) => {
        appliedConfigs.push(config)
        runOpts.onApplied?.(config)
        const hook = applyHook
        applyHook = undefined
        hook?.(config)
      },
    })

    /** Every persona key with a stub: those registered at build, then those whose credentials were written later. */
    const stubKeys = dryRun ? [] : connections.personas.map((p) => p.key)
    /** Per key: the harness label of the set registered as the persona's `INITIAL_CREDENTIALS` set in this run. */
    const initialLabels = new Map<string, string>(
      dryRun ? [] : connections.personas.map((p) => [p.key, labelsByName.get(p.name)!] as const),
    )
    lateRegistrations.push((name, tokens, label, slack) => {
      const key = personaKey(name)
      if (dryRun || stopped) return
      if (stubKeys.includes(key)) {
        connections.slack.addCredentials(key, label, tokens, { leakMarker: LEAK_SENTINEL, ...slack })
        return
      }
      connections.slack.addPersona(key, tokens, { leakMarker: LEAK_SENTINEL, ...runOpts.slack?.[name], ...slack })
      stubKeys.push(key)
      initialLabels.set(key, label)
    })

    /** The factory's label of a harness label in this run. */
    function factoryLabel(key: string, label: string): string {
      return initialLabels.get(key) === label ? INITIAL_CREDENTIALS : label
    }

    /** The harness label of a factory label in this run. */
    function harnessLabel(key: string, label: string | undefined): string {
      return label === INITIAL_CREDENTIALS ? (initialLabels.get(key) ?? label) : String(label)
    }

    let applyHook: ((applied: PersonaConfig) => void) | undefined

    function slackCalls(): Record<string, StubWebCall[]> {
      return Object.fromEntries(stubKeys.map((key) => [key, [...connections.slack.persona(key).callLog]]))
    }

    function checkpoint(): ReloadRunCheckpoint {
      return {
        logs: logs.length,
        writes: writes.length,
        removes: removes.length,
        lifecycle: records.length,
        slackBuilds: connections.slack.builds.length,
        slackCalls: Object.fromEntries(Object.entries(slackCalls()).map(([key, calls]) => [key, calls.length])),
      }
    }

    function since(cp: ReloadRunCheckpoint): ReloadRunActivity {
      return {
        logs: logs.slice(cp.logs),
        writes: writes.slice(cp.writes),
        removes: removes.slice(cp.removes),
        lifecycle: records.slice(cp.lifecycle),
        slackBuilds: connections.slack.builds.length - cp.slackBuilds,
        slackCalls: Object.entries(slackCalls()).flatMap(([key, calls]) => calls.slice(cp.slackCalls[key] ?? 0)),
      }
    }

    // MCP sessions in the real registry, and the tool clients opened on them.
    const notificationsByKey = new Map<string, ChannelNotification[]>()
    const toolClients = new Map<SessionEntry, Client>()
    let sessionSeq = 0
    const toolDeps: SessionToolDeps = {
      assertSendable: (path) => {
        throw new Error(`reload-harness: no file may be sent (${JSON.stringify(path)})`)
      },
      getReplySettings,
      getPersona: getAppliedPersona,
      clientFor,
      inboxDir: join(root, 'inbox'),
      resolveUserName,
      consumeAck,
      serverPort: 0,
    }

    function registerRunSession(name: string): SessionEntry {
      const key = personaKey(name)
      registryTouched = true
      let captured = notificationsByKey.get(key)
      if (captured === undefined) {
        captured = []
        notificationsByKey.set(key, captured)
      }
      const cwd = getAppliedPersona(key)?.working_directory ?? join(root, 'sessions', key)
      return registerSession(cwd, key, makeTransport(`mcp-${key}-${++sessionSeq}`), makeSessionServer(captured))
    }

    async function toolClientFor(name: string): Promise<Client> {
      const entry = getSessionByPersona(personaKey(name))
      if (entry === undefined) throw new Error(`reload-harness: no session registered for ${JSON.stringify(name)}`)
      let client = toolClients.get(entry)
      if (client === undefined) {
        const server = createSessionServer(entry, toolDeps)
        const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
        await server.connect(serverTransport)
        client = new Client({ name: 'reload-harness', version: '1.0.0' }, { capabilities: {} })
        await client.connect(clientTransport)
        toolClients.set(entry, client)
      }
      return client
    }

    let stopped = false
    const run: ReloadRun = {
      controller,
      bringUps,
      connections,
      slack: connections.slack,
      clock: connections.clock,
      ticks,
      lifecycle,
      logs,
      writes,
      removes,
      get outcome() {
        return outcome
      },
      composition,
      registerSession: registerRunSession,
      session: (name) => getSessionByPersona(personaKey(name)),
      deliveries: (name) =>
        (notificationsByKey.get(personaKey(name)) ?? []).map((n) => ({
          chat_id: n.params.meta['chat_id']!,
          via: n.params.meta['via'],
          content: n.params.content,
        })),
      async deliver(name, event) {
        registryTouched = true
        await run.stub(name).socket.deliver(event)
      },
      notice: (name, text) => Promise.resolve(noticeStack.notifier.notify(personaKey(name), text)),
      noticeClock: noticeStack.clock,
      async callTool(name, tool, args) {
        const client = await toolClientFor(name)
        const result = (await client.callTool({ name: tool, arguments: args })) as {
          isError?: boolean
          content: Array<{ type: string; text?: string }>
        }
        return { isError: result.isError === true, text: result.content.map((c) => c.text ?? '').join('\n') }
      },
      appliedConfigs,
      appliedKeys: () => controller.applied()?.config.personas.map((p) => p.key),
      resolveStart() {
        outcome = controller.resolveStart()
        if (outcome.kind === 'applied') {
          startConfig = outcome.config
          installTemplateAtStart(outcome.config)
        }
        return outcome
      },
      startDetection: () => controller.startDetection(),
      pendingWrites: () => writes.filter((w) => w.path === paths.pending),
      pendingRemoves: () => removes.filter((r) => r.path === paths.pending),
      logsOf: (label) => logs.filter((line) => line.startsWith(`[slack] ${label}: `)),
      previewEmissions: () => previewEmissions(logs),
      previewEmissionCount: () => previewEmissions(logs).length,
      lastPreviewEmission: () => previewEmissions(logs).at(-1),
      lastPreviewText() {
        const last = run.lastPreviewEmission()
        return last === undefined ? undefined : previewEmissionText(last, paths.pending)
      },
      invalidLines: () => run.logsOf(RELOAD_INVALID),
      tickCredentialsReads,
      tickDirectoryChecks,
      checkpoint,
      since,
      stub: (name) => connections.slack.persona(personaKey(name)),
      slackCalls,
      slackPosts: () => Object.values(slackCalls()).flat().filter((c) => c.method === 'chat.postMessage'),
      captured: (extra = {}) => ({
        logs,
        statuses: connections.statuses,
        lifecycle: records,
        outcome,
        writes,
        removes,
        slack: slackCalls(),
        written: [...new Set(writes.filter((w) => w.ok).map((w) => w.path))]
          .filter((path) => existsSync(path))
          .map((path) => writtenFile(path)),
        ...extra,
      }),
      async confirmPending() {
        await ticks.tick()
        if (!existsSync(paths.pending)) throw new Error('reload-harness: confirmPending(): the tick wrote no pending file')
        renameSync(paths.pending, paths.apply)
        return { applying: ticks.tick() }
      },
      beforeApplySteps(hook) {
        applyHook = hook
      },
      credentialsStub(name, label = h.credentialsLabel(name)) {
        const key = personaKey(name)
        return connections.slack.credentials(key, factoryLabel(key, label))
      },
      currentStub(name) {
        const key = personaKey(name)
        const connected = connections.slack
          .activityOf(key)
          .filter((a) => a.kind === 'socket' && a.event === 'connected')
          .at(-1)
        return connected === undefined ? run.stub(name) : connections.slack.credentials(key, connected.credentials!)
      },
      socketActivity(name) {
        const key = personaKey(name)
        return connections.slack
          .activityOf(key)
          .filter((a) => a.kind === 'socket')
          .map((a) => `${a.event} ${harnessLabel(key, a.credentials)}`)
      },
      revokeBotToken(name, opts = {}) {
        const stub = opts.credentials === undefined ? run.currentStub(name) : run.credentialsStub(name, opts.credentials)
        const outcome: WebApiOutcome = { kind: 'platform', error: opts.error ?? 'token_revoked' }
        const queues = opts.queues ?? WEB_API_QUEUES
        for (const queue of queues) stub.script[queue].unshift(outcome)
        return () => {
          for (const queue of queues) {
            const list = stub.script[queue]
            for (let i = list.indexOf(outcome); i !== -1; i = list.indexOf(outcome)) list.splice(i, 1)
          }
        }
      },
      async refuseReopen(name, error = 'invalid_auth') {
        const key = personaKey(name)
        const stub = run.currentStub(name)
        stub.script.connect.unshift({ kind: 'platform', error })
        stub.socket.drop()
        const broken = () => connections.manager.status(key)?.state === 'broken'
        // Event-loop turns only, no timer: the reopen starts on the drop itself.
        for (let i = 0; i < 1_000 && !broken(); i++) await new Promise((done) => setImmediate(done))
        if (!broken()) throw new Error(`reload-harness: refuseReopen(${JSON.stringify(name)}): the persona did not end broken`)
      },
      isUp: (name) => isPersonaUp(personaKey(name)),
      admitSession(name) {
        const key = personaKey(name)
        const persona = getAppliedPersona(key)
        if (persona === undefined) throw new Error(`reload-harness: admitSession(${JSON.stringify(name)}): not applied`)
        registryTouched = true
        const admission = decideSessionAdmission(persona.working_directory, appliedConfig()?.personas ?? [], {
          isPersonaUp,
          describeNotUp: (k) => describePersonaNotUp(bringUps.state(k)),
          log,
        })
        if (admission.kind !== 'admitted') return { kind: admission.kind }
        return { kind: 'admitted', session: registerRunSession(admission.persona.name) }
      },
      linesOf(name) {
        const ref = renderPersonaRef(name, personaKey(name))
        return logs.filter((line) => line.includes(ref))
      },
      serverConfig,
      async relaunch(name) {
        if (!realLaunch || serializer === undefined) throw new Error('reload-harness: run.relaunch() needs opts.realLaunch')
        const key = personaKey(name)
        const entry = record('launch', key, 'restart')
        // As server.ts's restart adapter, in the persona's turn (the restart module's serialize).
        entry.restart = await serializer.run(key, async () => {
          const config = serverConfig()
          return config === undefined ? false : launchSession(key, config, { canLaunch: relaunchGate })
        })
        return entry.restart
      },
      sessionNotices,
      async stop() {
        if (stopped) return
        stopped = true
        controller.stopDetection()
        bringUps.cancelAll()
        noticeStack.hold.cancelAll()
        for (const client of toolClients.values()) await client.close()
        await connections.manager.stopAll()
      },
    }
    if (realLaunch) installLaunchSeams()
    runs.push(run)
    return run

    /**
     * The session manager's module seams, pointed at this run as `server.ts`
     * installs them (see `opts.realLaunch`); the latest realLaunch run owns
     * them, and `h.cleanup()` resets them.
     */
    function installLaunchSeams(): void {
      launchSeamsInstalled = true
      captureConsole({ lines: logs, live: () => !stopped })
      setClientForTests(composition!.client as Parameters<typeof setClientForTests>[0])
      _setDialogPollIntervalMs(1)
      _setDialogReadyTimeoutMs(200)
      _setTmuxCapturePane(async () => '')
      _setTmuxSendEnter(async () => {})
      _setTmuxSessionProber(async () => true)
      _setSpawnHomeDir(home)
      // A new server process: nothing in flight, no launched-with dir known.
      _resetInFlightLaunches()
      _resetLaunchedWithDirs()
      _resetFindMissingMemo()
      setPreLaunchTrustPatcher(trustPatchPersona)
      setPreLaunchReplyGuard((persona) => {
        const config = serverConfig()
        return config === undefined ? undefined : preLaunchReplyGuard(persona, () => serverConfig()?.personas, stateDir)
      })
      setConfigDirUnresolvableHook((persona, failure) => bringUps.holdForConfigDir(persona, failure))
      setSessionNotifier((key, text, options) => {
        sessionNotices.push({ key, text })
        return noticeStack.notifier.notify(key, text, options)
      })
    }
  }

  const h: ReloadHarness = {
    root,
    dir,
    home,
    stateDir,
    replyGuardDir,
    readReplyGuardRecord(name) {
      const path = join(replyGuardDir, personaKey(name))
      return existsSync(path) ? readFileSync(path, 'utf-8') : undefined
    },
    configDir(name) {
      const path = inside(join('claude-config', name))
      mkdirSync(path, { recursive: true })
      return path
    },
    seedRow(persona, seed = {}) {
      const id = personaInstanceId(personaKey(persona.name))
      const existing = rows.get(id)
      const row = existing ?? {
        state: 'ended',
        cwd: persona.working_directory,
        labels: {
          service: 'cscb',
          persona: personaKey(persona.name),
          [CONFIG_DIR_LABEL]: personaConfigDirLabelValue(persona.claude_config_dir, home),
        },
      }
      if (seed.state !== undefined) row.state = seed.state
      if (seed.cwd !== undefined) row.cwd = seed.cwd
      if (seed.configDir === null) delete row.labels[CONFIG_DIR_LABEL]
      else if (seed.configDir !== undefined) row.labels[CONFIG_DIR_LABEL] = personaConfigDirLabelValue(seed.configDir, home)
      if (seed.labels !== undefined) row.labels = { ...seed.labels }
      rows.set(id, row)
      return h.rowOf(persona.name)!
    },
    rowOf(name) {
      const row = rows.get(personaInstanceId(personaKey(name)))
      return row === undefined ? undefined : { state: row.state, cwd: row.cwd, labels: { ...row.labels } }
    },
    paths,
    key: (name) => personaKey(name),
    persona(name, overrides = {}) {
      let channel = channels.get(name)
      if (channel === undefined) {
        channel = `${CHANNEL_ID_STEM}${String(channels.size + 1).padStart(3, '0')}`
        channels.set(name, channel)
      }
      const configDir =
        opts.personaConfigDirs === true && !('claude_config_dir' in overrides)
          ? { claude_config_dir: h.configDir(personaKey(name)) }
          : {}
      return makePersona(
        { name, channels: [{ id: channel, delivery: 'all' }], permission_prompts: channel, ...configDir, ...overrides },
        root,
      )
    },
    writeConfig: (input) => writeBytes(paths.config, serialize(input)),
    writeConfigBytes: (bytes) => writeBytes(paths.config, bytes),
    writeRecord: (input) => writeBytes(paths.lastApplied, serialize(input)),
    writeRecordBytes: (bytes) => writeBytes(paths.lastApplied, bytes),
    readConfig: () => readIfPresent(paths.config),
    readRecord: () => readIfPresent(paths.lastApplied),
    remove: (path) => rmSync(inside(path), { recursive: true, force: true }),
    replaceWithDirectory(path) {
      const full = inside(path)
      rmSync(full, { recursive: true, force: true })
      mkdirSync(full, { recursive: true })
    },
    configDirEntries: () => readdirSync(dir).sort(),
    serverSideFiles(...excluded) {
      const files: Record<string, WrittenFile> = {}
      const walk = (at: string): void => {
        for (const entry of readdirSync(at, { withFileTypes: true })) {
          const path = join(at, entry.name)
          if (entry.isDirectory()) walk(path)
          else if (entry.isFile() && !excluded.includes(path)) files[relative(root, path)] = writtenFile(path)
        }
      }
      walk(root)
      return files
    },
    writeCredentials: (persona) => h.rotateCredentials(persona).tokens,
    rotateCredentials(persona, rotation = {}) {
      const key = personaKey(persona.name)
      const n = (credentialWrites.get(key) ?? 0) + 1
      credentialWrites.set(key, n)
      const tokens = new PersonaSlackTokens(
        fakeToken(BOT_TOKEN_PREFIX, `${key}-bot-${n}`),
        fakeToken(APP_TOKEN_PREFIX, `${key}-app-${n}`),
      )
      const label = `credentials-${n}`
      writeCredentialsFile(root, relative(root, inside(persona.credentials_file)), {
        bot_token: tokens.botToken,
        app_token: tokens.appToken,
      })
      tokensByName.set(persona.name, tokens)
      labelsByName.set(persona.name, label)
      for (const register of lateRegistrations) register(persona.name, tokens, label, rotation.slack)
      return { tokens, label }
    },
    credentialsLabel(name) {
      const label = labelsByName.get(name)
      if (label === undefined) throw new Error(`reload-harness: no credentials written for ${JSON.stringify(name)}`)
      return label
    },
    writeCredentialsContent: (persona, content) =>
      writeCredentialsFile(root, relative(root, inside(persona.credentials_file)), content),
    tokens(name) {
      const tokens = tokensByName.get(name)
      if (tokens === undefined) throw new Error(`reload-harness: no credentials written for ${JSON.stringify(name)}`)
      return tokens
    },
    makeWorkingDirectory(persona) {
      const full = inside(persona.working_directory)
      mkdirSync(full, { recursive: true })
      return full
    },
    materialize(...personas) {
      for (const persona of personas) {
        h.writeCredentials(persona)
        h.makeWorkingDirectory(persona)
      }
    },
    saveCredentials(persona) {
      const path = inside(persona.credentials_file)
      const bytes = readFileIfPresent(path)
      const wasDirectory = bytes === undefined && existsSync(path) && statSync(path).isDirectory()
      const tokens = tokensByName.get(persona.name)
      const label = labelsByName.get(persona.name)
      return () => {
        rmSync(path, { recursive: true, force: true })
        if (wasDirectory) mkdirSync(path, { recursive: true })
        if (bytes !== undefined) {
          mkdirSync(dirname(path), { recursive: true })
          writeFileSync(path, bytes, { mode: 0o600 })
          chmodSync(path, 0o600)
        }
        if (tokens === undefined) tokensByName.delete(persona.name)
        else tokensByName.set(persona.name, tokens)
        if (label === undefined) labelsByName.delete(persona.name)
        else labelsByName.set(persona.name, label)
      }
    },
    deleteCredentials: (persona) => h.remove(persona.credentials_file),
    makeCredentialsUnreadable: (persona) => h.replaceWithDirectory(persona.credentials_file),
    readCredentialsBytes: (persona) => readFileIfPresent(inside(persona.credentials_file)),
    credentialsDigestOf: (persona) => credentialsDigest(readCredentialsFile(inside(persona.credentials_file))),
    deleteConfig: () => h.remove(paths.config),
    makeFifo(path) {
      const full = inside(path)
      rmSync(full, { recursive: true, force: true })
      mkdirSync(dirname(full), { recursive: true })
      const made = spawnSync('mkfifo', [full])
      if (made.status !== 0) throw new Error('reload-harness: mkfifo failed (guard the test with mkfifoAvailable())')
    },
    pendingExists: () => existsSync(paths.pending),
    readPending: () => readFileIfPresent(paths.pending),
    readPendingText: () => readFileIfPresent(paths.pending)?.toString('utf-8'),
    pendingFingerprint() {
      const text = h.readPendingText()
      return text === undefined ? undefined : parsePendingFingerprint(text)
    },
    writePendingBytes: (bytes) => writeBytes(paths.pending, bytes),
    confirm() {
      if (!existsSync(paths.pending)) throw new Error('reload-harness: confirm() needs a pending file to rename')
      renameSync(paths.pending, paths.apply)
    },
    writeApplyBytes: (bytes) => writeBytes(paths.apply, bytes),
    applyExists: () => existsSync(paths.apply),
    readApply: () => readFileIfPresent(paths.apply),
    writeOversized(path, { prefix = '', size = MAX_RELOAD_FILE_BYTES + 1 } = {}) {
      const head = typeof prefix === 'string' ? Buffer.from(prefix, 'utf-8') : Buffer.from(prefix)
      const filler = Buffer.from(`${fakeToken(BOT_TOKEN_PREFIX, 'oversized')}\n`, 'utf-8')
      const bytes = Buffer.alloc(size)
      head.copy(bytes, 0, 0, Math.min(head.length, size))
      for (let at = head.length; at < size; at += filler.length) filler.copy(bytes, at, 0, Math.min(filler.length, size - at))
      mkdirSync(dirname(inside(path)), { recursive: true })
      return writeBytes(path, bytes)
    },
    pendingBody() {
      const text = h.readPendingText()
      const fingerprint = text === undefined ? undefined : parsePendingFingerprint(text)
      if (text === undefined || fingerprint === undefined) return undefined
      // The layout before the body, exactly as the writer composes it.
      const head = composePendingFile(fingerprint, '')
      if (!text.startsWith(head)) return undefined
      const body = text.slice(head.length)
      return body.endsWith('\n') ? body.slice(0, -1) : body
    },
    pendingLines: () => h.pendingBody()?.split('\n'),
    pendingHeader: () => h.pendingLines()?.[0],
    pendingDestructiveLines: () => h.pendingLines()?.filter((line) => line.startsWith(DESTRUCTIVE_PREFIX)),
    preparePersona(name, state = {}, overrides = {}) {
      const persona = h.persona(name, overrides)
      switch (state.credentials ?? 'valid') {
        case 'valid':
          h.deleteCredentials(persona)
          h.writeCredentials(persona)
          break
        case 'missing':
          h.deleteCredentials(persona)
          break
        case 'invalid':
          h.deleteCredentials(persona)
          h.writeCredentialsContent(persona, { bot_token: undefined })
          break
        case 'unreadable':
          h.makeCredentialsUnreadable(persona)
          break
      }
      switch (state.workingDirectory ?? 'present') {
        case 'present':
          h.deleteWorkingDirectory(persona)
          h.makeWorkingDirectory(persona)
          break
        case 'missing':
          h.deleteWorkingDirectory(persona)
          break
        case 'file':
          h.makeWorkingDirectoryAFile(persona)
          break
      }
      return persona
    },
    deleteWorkingDirectory: (persona) => h.remove(persona.working_directory),
    makeWorkingDirectoryAFile(persona) {
      const full = inside(persona.working_directory)
      rmSync(full, { recursive: true, force: true })
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, '')
    },
    failWrites: (failure) => writeSeam.fail(failure),
    clearWriteFailure: () => writeSeam.clear(),
    failRemoves: (failure) => removeSeam.fail(failure),
    clearRemoveFailure: () => removeSeam.clear(),
    poisonTokenEnvironment() {
      if (tokenWatch !== undefined) throw new Error('reload-harness: the token environment is already poisoned')
      const original = process.env
      const previous = TOKEN_ENV_NAMES.map((name) => [name, original[name]] as const)
      const bot = fakeToken(BOT_TOKEN_PREFIX, 'environment-bot')
      const app = fakeToken(APP_TOKEN_PREFIX, 'environment-app')
      original['SLACK_BOT_TOKEN'] = bot
      original['SLACK_APP_TOKEN'] = app
      const reads: string[] = []
      const watched: ReadonlySet<string> = new Set(TOKEN_ENV_NAMES)
      process.env = new Proxy(original, {
        get(target, name, receiver) {
          if (typeof name === 'string' && watched.has(name)) reads.push(name)
          return Reflect.get(target, name, receiver)
        },
      })
      let restored = false
      const watch: TokenEnvironmentWatch = {
        bot,
        app,
        reads,
        restore() {
          if (restored) return
          restored = true
          process.env = original
          for (const [name, value] of previous) {
            if (value === undefined) delete original[name]
            else original[name] = value
          }
          tokenWatch = undefined
        },
      }
      tokenWatch = watch
      return watch
    },
    build,
    async start(runOpts) {
      const run = build(runOpts)
      const outcome = run.resolveStart()
      if (outcome.kind === 'applied') await run.controller.runStartBringUp()
      return run as StartedReloadRun
    },
    async startDetecting(runOpts) {
      const run = await h.start(runOpts)
      if (!run.startDetection()) {
        throw new Error(`reload-harness: startDetection() armed nothing (start outcome: ${run.outcome.kind})`)
      }
      return run
    },
    runs,
    async cleanup() {
      try {
        for (const run of runs) await run.stop()
      } finally {
        tokenWatch?.restore()
        if (consoleCaptured) console.error = originalConsoleError
        if (launchSeamsInstalled) {
          resetClientForTests()
          _resetDialogPollIntervalMs()
          _resetDialogReadyTimeoutMs()
          _resetTmuxDialogHelpers()
          _resetTmuxSessionProber()
          _resetSpawnHomeDir()
          _resetInFlightLaunches()
          _resetLaunchedWithDirs()
          _resetFindMissingMemo()
          _resetPreLaunchTrustPatcher()
          _resetPreLaunchReplyGuard()
          setConfigDirUnresolvableHook(undefined)
          setSessionNotifier(undefined)
        }
        if (outageStateInstalled) _resetOutageState()
        if (registryTouched) {
          _resetRegistry()
          _resetAckTracker()
        }
        rmSync(root, { recursive: true, force: true })
      }
      if (standInRefusals.length > 0) throw new Error(standInRefusals.join('\n'))
    },
  }
  return h
}
