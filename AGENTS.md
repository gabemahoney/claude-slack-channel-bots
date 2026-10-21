# The two cardinal rules (read before any work)

These override every other project instruction:

1. **CSCB relies on agent-director for agent state.**
2. **CSCB does not write code that parses an agent's TUI.**

Project guides live in docs/.

# Agent diagnostics

- Agents MUST inspect Docker containers/images through `bun scripts/safe-docker-inspect.ts docker inspect NAME`, `bun scripts/safe-docker-inspect.ts docker container inspect NAME`, or `bun scripts/safe-docker-inspect.ts docker image inspect NAME`.
- Never run raw Docker inspection through a tool, direct pipe or log, including with `--format`. Use only the wrapper's supported projections.
- Wrapper errors fail closed: stop the inspection; never fall back to raw inspection.
- Never print credentials or environment values. Pass credentials through the environment only, never command arguments.
- The wrapper protects its callers; it does not intercept unrelated shell commands. See `docs/testing-guide.md`, Safe Docker inspection.
