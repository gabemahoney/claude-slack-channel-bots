# Test Review Guide

## Review Checklist

When reviewing tests, check for:

### Coverage
- [ ] All acceptance criteria from the SRD have corresponding tests
- [ ] Happy path tested for each public function/endpoint
- [ ] Error paths tested (invalid input, API failures, missing data)
- [ ] Edge cases from the PRD/SRD are covered
- [ ] Concurrent/parallel scenarios tested where applicable

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

### Patterns
- [ ] Factory functions used for fixtures (not inline object literals)
- [ ] External dependencies stubbed (WebClient, tmux, etc.)
- [ ] No real network calls or file I/O in unit tests
- [ ] No `sleep` or timing-dependent assertions longer than 100ms
- [ ] Capture arrays used to verify side effects (API calls, messages sent)

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
