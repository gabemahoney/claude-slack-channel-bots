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

### Quality
- [ ] Each test has a single clear assertion (or a small set of related assertions)
- [ ] Test names describe the scenario and expected outcome
- [ ] No false positives — tests would fail if the feature broke
- [ ] Assertions are specific (`.toBe('allow')` not `.toBeTruthy()`)
- [ ] No hardcoded values that should come from factory functions

### Isolation
- [ ] Tests do not depend on execution order
- [ ] Module-scoped state is reset in `beforeEach`
- [ ] No shared mutable state leaking between tests
- [ ] Test servers bind to port 0 (no port conflicts)
- [ ] Tests that write configuration or other state files do so only in a `mkdtempSync` directory removed in `afterEach`, pass every path (and any home directory) explicitly, and never read or write `~/.claude/channels/slack` or `~/.agent-director` or start a server against the real home

### Patterns
- [ ] Factory functions used for fixtures (not inline object literals)
- [ ] External dependencies stubbed (WebClient, tmux, etc.)
- [ ] No real network calls; file I/O only inside a `mkdtempSync` directory (see Isolation)
- [ ] No `sleep` or timing-dependent assertions longer than 100ms
- [ ] Capture arrays used to verify side effects (API calls, messages sent)
- [ ] Persona and connection suites fake Slack with `makeStubSlack` from `tests/test-helpers/slack-stub.ts` and its event factories; a hand-rolled WebClient or SocketModeClient stub in such a suite is a defect
- [ ] Slack failure cases use the stub's scripted outcomes with `leakMarker` set to `LEAK_SENTINEL`, and assert on the classification, not on the error text
- [ ] Backoff, retry and timeout tests never wait in real time: pure schedules are called directly, timers and clocks are injected fakes, and a never-settling call is ended through the stub or the injected clock
- [ ] `retryAfter` cases assert the wait is never shorter than `retryAfter`, converting seconds to milliseconds

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
