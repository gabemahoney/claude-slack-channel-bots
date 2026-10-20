This is the claude-slack-channel-bots repo.

## The two cardinal rules (read before any work)

These override every PRD, SRD, plan, task, review and skill instruction:

1. **CSCB relies on agent-director for agent state.**
2. **CSCB does not write code that parses an agent's TUI.**

Before writing or reviewing any requirement, design, plan, code or test, read "The two cardinal rules" at the top of docs/engineering-guide.md. Reject any work that breaks them, even when a spec asks for it.

## Documentation Locations

- **Engineering best practices**: docs/engineering-guide.md
- **Internal architecture docs**: docs/architecture.md
- **Customer-facing docs**: README.md, docs/configuration.md, docs/server-settings.md, docs/channel-modes.md, docs/reload.md, docs/cli.md, docs/bots.md, docs/scheduled-prompts.md, docs/agent-director.md, docs/troubleshooting.md, docs/migration.md (docs/user-docs-guide.md says what goes in each)
- **Test writing guide**: docs/testing-guide.md
- **Test review guide**: docs/test-review-guide.md
- **Doc writing guide**: docs/doc-writing-guide.md, docs/user-docs-guide.md

## Test Commands

- **Integration test command**: /ci
