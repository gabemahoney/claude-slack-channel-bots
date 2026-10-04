# Documentation Writing Guide

## Document Types

### README.md (Customer-facing)
- Target audience: operators setting up and running the Slack Channel Router
- Covers: installation, configuration, connecting sessions, available tools, hook setup
- Tone: practical, step-by-step, assumes technical competence but no familiarity with the codebase
- Format: H2 sections separated by `---`, H3 subsections, fenced code blocks for commands and config
- Keep it short and focused on the happy path — how to install and how to use; don't document theoretical error cases or alternative install methods
- No implementation details or source code in the README; commands are fine and should be concrete and copy-pasteable
- Document the current state only — never describe legacy or removed behavior
- Don't explain common tools (bash, tmux, npm, etc.) — assume the operator knows them

### Shipped descriptions (README, skills, manifest, MCP instructions)
- Shipped descriptions are the README, every file under `skills/` (`skills/EXAMPLE_CLAUDE.md` included), `slack-app-manifest.yml` and the MCP instruction text (`MCP_INSTRUCTIONS` in `src/registry.ts`); they describe personas and nothing else (AC 46)
- Use persona terms: personas, their `channels` and `delivery`, `dm`, `permission_prompts`, credentials files, the confirmed reload. Never describe the pre-persona shape (`routes`, `default_route`, `default_dm_session`, per-route or routing-config wording), the token environment variables (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `export` lines), a token on a command line, or the access-control file and its model (`access.json`, `allowFrom`, `dmPolicy`, allowlist or pairing wording)
- The one place a pre-persona key may appear is the debugging skill's `## Pre-persona configuration` entry, which names `routes`, `default_route` and `default_dm_session` only to say they are rejected; keep that heading as written
- The README's two runbook sections, the switch-over runbook and the rollback runbook under `## Migration`, may name `access.json`, and only as the previous CSCB's file to save (switch-over) or restore (rollback); it stays banned in every other section and file. Nothing else is allowed in them: the runbooks say "the Slack token environment variables" and never name one, and carry no `export` line, access-control model wording or pre-persona key. Keep both headings as written; a renamed or moved heading fails the audit
- The skills point to the runbooks by section title and link, and do not repeat their steps
- Describe no persona-name format rule; a persona name is used as written
- The MCP instruction text carries no reload wording; the README and skills may describe the rename gesture
- `tests/shipped-docs.test.ts` enforces these rules: its `FORBIDDEN_TERMS` list is the full set. Its three exemptions (the SR-1.7 entry and the two runbook sections above) are the only ones. If it flags your text anywhere else, rewrite the text; never add an exemption (see the testing guide's Shipped-Description Audit)
- Upgrade notes about retired files or settings go in CHANGELOG.md, which the audit does not scan

### Release notes (CHANGELOG.md)
- Target audience: operators upgrading from an earlier release
- Covers: what's new, breaking changes and upgrade steps, under an "Unreleased" heading until the release is cut
- The one place for what changed from an earlier release, such as a retired file an upgraded host keeps; the README describes only the current state
- Not in the npm tarball (not in `package.json`'s `files`), and `/publish` does not read it

### Architecture docs (Internal, docs/architecture.md)
- Target audience: developers working on the codebase
- Covers: module map, data flow, session lifecycle, configuration schema, security model
- Tone: concise technical reference — describe what exists and how it connects
- Avoid pasting source code — readers (human or AI) can read the code itself; describe the design and point at the module
- Update whenever: modules are added/renamed, data flow changes, new config fields are added, security boundaries change

### Guide docs (Internal, docs/*.md)
- Target audience: AI agents and developers contributing to the project
- Covers: coding patterns, testing conventions, review checklists
- Tone: prescriptive — "do this, not that" with rationale
- Update whenever: conventions change or new patterns emerge

## Style Rules

- Use fenced code blocks with language tags (```sh, ```json, ```jsonc, ```typescript)
- Use tables for structured comparisons (tools, config fields, test files)
- Keep paragraphs short — 2-3 sentences max
- Lead with the most important information
- No marketing language — state facts
- Use relative paths from the repo root when referencing files
- Secrets: show no token value, only placeholders (`<bot token, starts with xoxb->`). No shipped doc or skill asks the operator to paste, type or show a token in a chat; tokens go only into the setup wizard's credentials command, run in the operator's own terminal (`## Credentials command` in `skills/setup-slack-channel-bots/SKILL.md`)

## When to Update

After completing work that:
- Adds a user-facing feature → update README.md
- Changes how the system works internally → update docs/architecture.md
- Introduces new coding patterns → update relevant guide
- Adds new config fields → update both README.md and docs/architecture.md
- Changes behaviour an upgrading operator must act on → add an entry to CHANGELOG.md
- Changes shipped text (README, skills, manifest, MCP instructions) → keep `tests/shipped-docs.test.ts` green by rewriting the text, never by adding an exemption
