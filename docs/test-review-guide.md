# Test Review Guide

## Review Checklist

When reviewing tests, check for:

### Coverage
- [ ] All acceptance criteria from the SRD have corresponding tests
- [ ] Happy path tested for each public function/endpoint
- [ ] Error paths tested (invalid input, API failures, missing data)
- [ ] Edge cases from the PRD/SRD are covered
- [ ] Concurrent/parallel scenarios tested where applicable
- [ ] A rule that rejects duplicate paths is tested with a symlinked duplicate and a non-existent path (lexical fallback), both rooted inside the test's `mkdtempSync` directory, plus a non-collision control that loads
- [ ] Every path that serves a persona's instance (MCP registration, the permission poller, `/interject`, and any new endpoint, tool or poller) has a test for a persona that is not up, and an up persona beside it still served. Cross-module and integration tests build the up check with the real `createPersonaUpPredicate`; a handler unit test (such as `/interject` or the cron dispatch over it) may inject a stand-in predicate only when a source audit of `server.ts` (as in `server-startup-wiring.test.ts`) pins the production predicate to that path; a new serving path with no not-up case is a defect
- [ ] A new file that must ship in the npm package (a skill, a runtime `src/*.ts`) is asserted in `tests/packaging-completeness.test.ts`: in the `npm pack` file list, with a hermetic companion for hosts without npm. A shipped doc that must cover a closed set (such as the debugging skill's class entries) is checked against the exported constant, never a hand-copied list
- [ ] A persona whose working directory can't be resolved keeps its agent-director row: sweep and launch tests cover a missing directory and a dangling symlink, assert no kill or delete, and assert the row is reused once the directory exists; they also cover a row whose `cwd` is an existing directory elsewhere, which is still swept or replaced

### Quality
- [ ] Each test has a single clear assertion (or a small set of related assertions)
- [ ] Test names describe the scenario and expected outcome
- [ ] No false positives — tests would fail if the feature broke
- [ ] Assertions are specific (`.toBe('allow')` not `.toBeTruthy()`)
- [ ] A multi-persona delivery test asserts every persona's exact deliveries (count, `chat_id` and `via`), including the personas that get nothing; asserting only that the expected persona got at least one is a defect
- [ ] A "nothing posted there" claim (for example, a lost message posts nothing in a source conversation that is not its destination) is a zero-count assertion on that exact target, such as `expect(h.postsTo(source)).toEqual([])`, and the test's source differs from the destination; a persona's destination defaults to its first channel, so a source that is also the destination hides a source post behind the expected notice
- [ ] No hardcoded values that should come from factory functions

### Isolation
- [ ] Tests do not depend on execution order
- [ ] Module-scoped state is reset in `beforeEach`
- [ ] No shared mutable state leaking between tests
- [ ] Test servers bind to port 0 (no port conflicts)
- [ ] No test leaves a process-level listener (such as `unhandledRejection`) installed: the handler is called directly, or any listener a test registers is removed in `afterEach`
- [ ] Tests that write configuration or other state files do so only in a `mkdtempSync` directory removed in `afterEach`, pass every path (and any home directory) explicitly, and never read or write `~/.claude`, `~/.agent-director` (a real agent-director `Client` opens its `state.db`) or `~/.npm`, or start a server or run the CLI entry point against the real home
- [ ] No test sets or relies on a real Slack token: any `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` a suite sets is a fake, restored afterwards, and every token follows the fakes-only rule under Credentials and Leak Checks
- [ ] Integration scripts and their driver (`tests/integration/*.sh`, `tests/integration/fixtures/driver.ts`) are run only through the `ci` skill in the `cscb-ci` container; a change or instruction that runs them on a host is a defect

### Patterns
- [ ] Factory functions used for fixtures (not inline object literals)
- [ ] External dependencies stubbed (WebClient, tmux, etc.)
- [ ] No real network calls; file I/O only inside a `mkdtempSync` directory (see Isolation)
- [ ] No `sleep` or timing-dependent assertions longer than 100ms
- [ ] Capture arrays used to verify side effects (API calls, messages sent)
- [ ] Persona and connection suites fake Slack with `makeStubSlack` from `tests/test-helpers/slack-stub.ts` and its event factories; a hand-rolled WebClient or SocketModeClient stub in such a suite is a defect
- [ ] Notice-site tests (outage state, session manager, JSONL safeguard) assert through a recording notify sink, and destination or hold-and-flush tests use `makeNotifierHarness` from `tests/test-helpers/persona-notifier.ts`, the real `createPersonaNotifier` over one `makeStubSlack` stub per persona (see the testing guide's Persona notices entry); a hand-wired notifier over hand-built stubs, a module-scope `WebClient` stub for notices, or a `setSessionNotifier` sink left installed after the test, is a defect
- [ ] Slack failure cases use the stub's scripted outcomes with `leakMarker` set to `LEAK_SENTINEL`, and assert on the classification, not on the error text
- [ ] Backoff, retry and timeout tests never wait in real time: pure schedules are called directly, timers and clocks are injected fakes, and a never-settling call is ended through the stub or the injected clock. The one real-time wait allowed is a bounded poll (1 ms steps) for a launch through the real `spawnForPersona`, which takes no fake clock
- [ ] A test that starts bring-up retry timers cancels them in teardown (`controller.cancelAll()`, `manager.stopAll()`) and asserts the fake clock has no pending timer left
- [ ] A test that drives retries or holds notices (a destination failure followed by a retry on the poller, or a failed notice on the notifier or a notice site, or a teardown that cancels a held notice) passes a `destinationHold` built on a fake clock, as `makeNotifierHarness` does; relying there on the poller's or notifier's default hold, which uses the real clock, is a defect. A single-tick poller test on the default hold is fine: a hold used only by the poller never starts a timer. A test that holds anything asserts one `persona-destination-failed` line per episode, not one per attempt
- [ ] `retryAfter` cases assert the wait is never shorter than `retryAfter`, converting seconds to milliseconds
- [ ] Persona suites drive virtual time with `createFakeClock` from `tests/test-helpers/fake-clock.ts`; a hand-rolled fake timer or clock is a defect
- [ ] Connection tests build the manager with the `factory` from `makeStubSlackFactory` and the fake clock, and check client options through the factory's build records; a test that builds a real Slack client, or omits `factory` or `clock` so the production default applies, is a defect
- [ ] An isolation test that makes one persona fail, drop or hang also checks that the healthy persona keeps delivering its events; one that asserts only on the failing persona is a defect
- [ ] Reload-controller tests use `makeReloadHarness` from `tests/test-helpers/reload-harness.ts`: ticks are driven only through the harness's manual tick driver (`run.ticks`), and a real timer, `sleep` or timer-backed tick driver in a reload test is a defect. The one exception is the timing test that proves the first check comes 5 s after `startDetection`: it may pass the production driver on the run's fake clock through `opts.tickDriver`, never a real timer. Any other reload test using `opts.tickDriver`, or a detection test that waits on a real timer, is a defect
- [ ] A detection test asserts everything a stretch of ticks did through `run.checkpoint()` / `run.since(cp)`, compared with `NO_RUN_ACTIVITY` (or `NO_RUN_ACTIVITY` with only the expected pending-file write or delete and log lines); one that doesn't show the ticks made no lifecycle call (`run.since(cp).lifecycle` empty) is a defect
- [ ] A detection test puts a persona in a held state with `SLACK_UNREACHABLE`, `SLACK_AUTH_REJECTED` or a harness credentials or directory fixture, reverts credentials edits with `h.saveCredentials`, and compares held content through `h.credentialsDigestOf` and `run.bringUps.credentialsDigest`; printing a digest or reading a token to compare is a defect
- [ ] A real FIFO in a reload test (`h.makeFifo`) runs in a child `bun` process with a time limit and asserts the child was not killed; an in-process real FIFO is a defect
- [ ] The production tick driver is tested in `tests/reload-timer.test.ts` on `createFakeClock()` only, and where `server.ts` starts and stops detection is pinned by the source audit in `tests/reload-wiring.test.ts`; a change to that wiring with no matching audit is a defect
- [ ] A reload test builds every SR-8.1 path (`config.json`, `.pending`, `.apply`, `.last-applied`) and every credentials file and working directory through the harness, under its temp root; a hand-built reload path, or any path outside the harness's temp directory, is a defect
- [ ] Lifecycle effects in a reload test (bring-ups, launches, teardowns, reconnects, in-place updates) are asserted through the harness's lifecycle recorder, not a hand-rolled `ReloadLifecycleOps` stub
- [ ] A preview test asserts the specific SR-8.4 line kind by its exact line, prefix or keyword (the counted header, `DESTRUCTIVE:`, `INVALID:`, `no effective change`, the credentials line by persona and path, an added persona's causes); one that asserts only that some text exists, or that the pending file is non-empty, is a defect
- [ ] Preview wording is pinned in `tests/reload-preview.test.ts` with facts injected as data; a tick-path test in `tests/reload.test.ts` compares the logged preview with the pending file (`pendingWritten()`, `run.lastPreviewText()`) instead of re-pinning every sentence. New wording pinned only on the tick path, or a pure test that reads the disk for a fact it should inject, is a defect
- [ ] A preview test asserts the log carries the same preview once per pending-state change (the whole emission through `pendingWritten()`, `run.previewEmissionCount()`), and none for a rewrite caused only by a changed fact; an INVALID case asserts exactly one `reload-invalid` line and no `reload-preview` line. A test that only counts `reload-preview` lines is a defect
- [ ] A preview test shows that no lifecycle call happened before confirmation (`run.since(cp)` in full, or at least `run.since(cp).lifecycle` empty): no reconnect for a rotated token (AC 67), no bring-up for a persona broken by its credentials file once the file is created or fixed (AC 65, preview half), no teardown for a `DESTRUCTIVE:` line (AC 56). One that checks only the preview text is a defect
- [ ] A confirmation or apply test makes the gesture with `h.confirm()` (or `h.writeApplyBytes` for other apply-path content), an undeletable confirmation with `h.failRemoves`, a record write failure with `h.failWrites` and an oversized file with `h.writeOversized`; a hand-renamed or hand-written `config.json.apply`, or a permission-based failure, is a defect
- [ ] An apply test asserts that a persona the confirmed change leaves unchanged gets no lifecycle record, Slack client or Slack call from the apply; one that checks only the changed persona is a defect
- [ ] Apply step order and effects are asserted through recording `opts.applySteps` bodies and `run.appliedConfigs` / `run.appliedKeys()`; a test that stubs the controller's step runner or applied state by hand is a defect
- [ ] A test of what a confirmed change does to the personas runs the default fan-out (no `opts.applySteps`) and asserts step order through `run.lifecycle.timeline`, holding calls with `run.lifecycle.hold(op, key)`; `opts.applySteps` recording bodies are only for tests of the step runner itself
- [ ] An apply test asserts the exact recorded lifecycle calls for the changed personas (op, key and `via`) and no call for any other persona; a test that only checks a count or that a call exists is a defect
- [ ] A step-order test includes both a teardown and a bring-up in one apply, and shows every teardown settled (a held one included) before any bring-up started
- [ ] A teardown test checks every piece of per-persona state the teardown clears (b.av2 SR-6.5), for the removed key only, and a new per-persona state has a test that its forget drops only that key
- [ ] Serializer tests settle operations through controllable promises, never real delays or timers; a test holding a persona's turn submits a gated operation to the serializer the code under test uses. The only real timers accepted come from `initRestart` taking no clock: the restart module's 1 ms timer and its 1 ms-step poll (2 s cap) in the restart-module cases of `tests/persona-lifecycle.test.ts`, and the `Bun.sleep(WAIT_MS)` (50 ms) waits that `tests/restart.test.ts` uses throughout, its `RestartDeps.serialize` cases included
- [ ] A test showing an added persona's tokens come from its file uses `h.poisonTokenEnvironment()` and asserts no read of the token variables and no client built with their values
- [ ] A new launch, restart or retry path has a test showing a key outside the applied set is refused (nothing probed, spawned, patched or scheduled) while an applied key beside it proceeds, driven through the real relaunch gate over a live applied set; a path with no such test is a defect

### Credentials and Leak Checks
- [ ] Every test that handles tokens or a credentials file runs `assertNoLeak` over all its captured log lines, errors and results, failure paths included; a missing call is a defect
- [ ] Files the code under test wrote are passed to `assertNoLeak` wrapped in `writtenFile`, not as a bare path string (which is checked only as text)
- [ ] Every reload test runs `assertNoLeak(run.captured())` for each run, failure paths included, so its logs and every reload file it wrote are checked; a reload test with no `assertNoLeak` is a defect. `captured()` holds only files that still exist, so a test that asserts on the pending file's content runs the check while the file exists; one whose only leak check comes after the pending file was removed has not checked it
- [ ] Every in-process detection test asserts no Slack post was captured (`run.slackPosts()` empty, as `expectNoPostNoLeak` does) for each run; one that doesn't is a defect
- [ ] A credentials-rotation or held-state preview test runs `assertNoLeak(run.captured())` while the pending file still exists, so both the pending file and the log are checked; one with no leak check, or whose only check comes after the file was removed, is a defect. In `tests/reload-preview.test.ts` every rendered form goes through `render()`, which leak-checks the plan, the lines, the text and both log forms
- [ ] Credentials fixtures in a reload test come from the harness (`h.writeCredentials`, `h.writeCredentialsContent`), so every token is a sentinel-bearing fake
- [ ] No token literal anywhere in the test file, fake or not; every token comes from `fakeToken`, `makeCredentials` or `writeCredentialsFile` and so embeds `LEAK_SENTINEL`, and the sentinel's value is never copied in
- [ ] Credentials files and working-directory fixtures are created only under the test's `mkdtempSync` directory, never under `~/.claude/channels/slack`, `~/.agent-director` or any other real-home path
- [ ] Permission cases use the injected file-system seam so they pass as root; real-permission variants are `test.skipIf(isRoot)` with the reason in the test name

### Conciseness
- [ ] 3+ tests with the same structure and different inputs use `test.each`
- [ ] No meta-tests — tests of factories, stubs, or other test infrastructure add no value; real tests validate them
- [ ] No constants wrapping simple domain strings (`const STATUS_OPEN = 'open'`) — inline them
- [ ] Tests assert behavior (outputs, state, captured calls), not implementation (which internal function was called, with what encoding)
- [ ] No gold-plating — 80/20 rule; redundant permutations of an already-covered behavior should be removed
- [ ] No repeated multi-line setup blocks — extract to a factory or `beforeEach`

### Maintenance
- [ ] Tests are DRY but not over-abstracted — prefer clarity over brevity
- [ ] No skipped or `.todo` tests without explanation
- [ ] No commented-out tests

### Red Flags
- Test file > 500 lines with no `test.each` — likely copy-paste variants that should be parametrized
- More than 3 stubs/mocks in a single test — testing implementation, not behavior; test at a higher level instead
- Same 10+ line setup block appearing in multiple tests — belongs in a factory function or fixture
