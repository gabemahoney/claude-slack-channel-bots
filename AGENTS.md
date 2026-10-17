# Agent diagnostics

- Agents MUST inspect Docker containers/images through `bun scripts/safe-docker-inspect.ts docker inspect NAME`, `bun scripts/safe-docker-inspect.ts docker container inspect NAME`, or `bun scripts/safe-docker-inspect.ts docker image inspect NAME`.
- Never run raw Docker inspection through a tool, direct pipe or log, including with `--format`. Use only the wrapper's supported projections.
- Wrapper errors fail closed: stop the inspection; never fall back to raw inspection.
- Never print credentials or environment values. Pass credentials through the environment only, never command arguments.
- The wrapper protects its callers; it does not intercept unrelated shell commands. See `docs/testing-guide.md`, Safe Docker inspection.
