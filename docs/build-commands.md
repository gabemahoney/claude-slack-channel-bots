# Build commands

This is `guide:build-commands.md`, resolved by the host's Apiary setup. One code folder: the checkout root (`../` from this file). Run each command from that root. Document and skill links below resolve relative to this file's folder.

## Compile

`bun run typecheck` (`tsc --noEmit`).

## Lint

none: the repo has no linter or formatter configured; `bun run check:mocks` runs as part of `bun test`'s pretest.

## Unit tests

`bun test`, with a fresh scratch HOME and `SLACK_STATE_DIR` as required by [the test instructions](../tests/README.md#running-the-unit-suite).

## Integration tests

The repo's [/ci skill](../.claude/skills/ci/SKILL.md) (`$ci` on Codex): Docker-sharded run of `tests/integration`. Never pass `ANTHROPIC_*` env to it; use `CI_ANTHROPIC_*`. The live Slack acceptance run is `/ci-live`, only when a task asks for it.

## Model check

TLA+ ([PersonaDelivery.tla](../spec/tla/PersonaDelivery.tla)), checked with TLC through `bash spec/tla/ci/run_ci.sh` (`bun run tla`), which runs SANY locally and TLC only on the job scheduler. See [the model instructions](../spec/tla/README.md).
