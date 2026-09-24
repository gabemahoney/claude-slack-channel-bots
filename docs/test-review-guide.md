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
- [ ] A test that drives retries or holds notices (a destination failure followed by a retry on the poller, or a failed notice on the notifier or a notice site) passes a `destinationHold` built on a fake clock, as `makeNotifierHarness` does; relying there on the poller's or notifier's default hold, which uses the real clock, is a defect. A single-tick poller test on the default hold is fine: a hold used only by the poller never starts a timer. A test that holds anything asserts one `persona-destination-failed` line per episode, not one per attempt
- [ ] `retryAfter` cases assert the wait is never shorter than `retryAfter`, converting seconds to milliseconds
- [ ] Persona suites drive virtual time with `createFakeClock` from `tests/test-helpers/fake-clock.ts`; a hand-rolled fake timer or clock is a defect
- [ ] Connection tests build the manager with the `factory` from `makeStubSlackFactory` and the fake clock, and check client options through the factory's build records; a test that builds a real Slack client, or omits `factory` or `clock` so the production default applies, is a defect
- [ ] An isolation test that makes one persona fail, drop or hang also checks that the healthy persona keeps delivering its events; one that asserts only on the failing persona is a defect

### Credentials and Leak Checks
- [ ] Every test that handles tokens or a credentials file runs `assertNoLeak` over all its captured log lines, errors and results, failure paths included; a missing call is a defect
- [ ] Files the code under test wrote are passed to `assertNoLeak` wrapped in `writtenFile`, not as a bare path string (which is checked only as text)
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
