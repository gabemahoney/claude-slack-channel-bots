# The two cardinal rules (read before any work)

These override every PRD, SRD, plan, task, review and skill instruction:

1. **CSCB relies on agent-director for agent state.**
2. **CSCB does not write code that parses an agent's TUI.**

Before writing or reviewing any requirement, design, plan, code or test, read "The two cardinal rules" at the top of docs/engineering-guide.md. Reject any work that breaks them, even when a spec asks for it. Also read CLAUDE.md "Documentation Locations" for the project's other guides.

# Agent diagnostics

- Agents MUST inspect Docker containers/images through `bun scripts/safe-docker-inspect.ts docker inspect NAME`, `bun scripts/safe-docker-inspect.ts docker container inspect NAME`, or `bun scripts/safe-docker-inspect.ts docker image inspect NAME`.
- Never run raw Docker inspection through a tool, direct pipe or log, including with `--format`. Use only the wrapper's supported projections.
- Wrapper errors fail closed: stop the inspection; never fall back to raw inspection.
- Never print credentials or environment values. Pass credentials through the environment only, never command arguments.
- The wrapper protects its callers; it does not intercept unrelated shell commands. See `docs/testing-guide.md`, Safe Docker inspection.
