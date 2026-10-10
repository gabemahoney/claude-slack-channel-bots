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
- Shipped descriptions are the README, every file under `skills/` (`skills/EXAMPLE_CLAUDE.md` included), `slack-app-manifest.yml`, the MCP instruction text (`MCP_INSTRUCTIONS` in `src/registry.ts`) and `set_channel_delivery`'s exported texts (`SET_CHANNEL_DELIVERY_DESCRIPTION`, `SET_CHANNEL_DELIVERY_CHANNEL_DESCRIPTION` and `SET_CHANNEL_DELIVERY_DELIVERY_DESCRIPTION`); they describe personas and nothing else (AC 46)
- Use persona terms: personas, their `channels` and `delivery`, `dm`, `permission_prompts`, credentials files, the confirmed reload, and for the channel modes the switch `allow_invited_channels`, declarative and fungible mode, `invited.permission_prompts`, channel delivery, a stored choice and `set_channel_delivery`. Never describe the pre-persona shape (`routes`, `default_route`, `default_dm_session`, per-route or routing-config wording), the token environment variables (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `export` lines), a token on a command line, or the access-control file and its model (`access.json`, `allowFrom`, `dmPolicy`, allowlist or pairing wording)
- The one place a pre-persona key may appear is the debugging skill's `## Pre-persona configuration` entry, which names `routes`, `default_route` and `default_dm_session` only to say they are rejected; keep that heading as written
- The README's two runbook sections, the switch-over runbook and the rollback runbook under `## Migration`, may name `access.json`, and only as the previous CSCB's file to save (switch-over) or restore (rollback); it stays banned in every other section and file. Nothing else is allowed in them: the runbooks say "the Slack token environment variables" and never name one, and carry no token `export` line, access-control model wording or pre-persona key. Keep both headings as written; a renamed or moved heading fails the audit
- The runbooks, and the `## Migration` items beside them, name nothing that exists on one host only. A step names the host's sweep schedule (whatever runs `agent-director find-missing` on a schedule) and the shared orchestrator prompt by their role, with an example (a cron entry, a systemd timer or a loop script; the file `append_system_prompt_file` names), never by one host's script or file path. Each has one name throughout, defined where the runbook first uses it; `tests/shipped-docs.test.ts` fails on the paths in its `HOST_SPECIFIC_PATHS`, in both runbooks, their CHANGELOG copies and the README's `## Migration` section
- The skills point to the runbooks by section title and link, and do not repeat their steps
- Describe no persona-name format rule; a persona name is used as written
- The MCP instruction text and `set_channel_delivery`'s texts (its description, input descriptions and every refusal and result text its builders return) carry no reload wording (the terms in `RELOAD_TERMS`) and nothing that triggers, confirms or describes a configuration apply; the README and skills may describe the rename gesture. For `set_channel_delivery`, the AC 74 and AC 47 cases in `tests/registry.test.ts` check the tool definition the tool list gives, its description and input descriptions; check the refusal and result texts by hand
- `tests/shipped-docs.test.ts` enforces these rules for every text its `SHIPPED_TEXTS` lists; check a shipped text it does not list by hand against the same rules. Its `FORBIDDEN_TERMS` list is the full set. Its three exemptions (the SR-1.7 entry and the two runbook sections above) are the only ones. If it flags your text anywhere else, rewrite the text; never add an exemption (see the testing guide's Shipped-Description Audit)
- What changed from an earlier release, a retired file or setting included, goes in CHANGELOG.md. The forbidden-term audit does not scan it (`SHIPPED_TEXTS` holds neither the CHANGELOG nor `docs/`); the release-entry checks in the same test read it through `OPERATOR_TEXTS` (see Release notes below)

### Release notes (CHANGELOG.md)
- Target audience: operators upgrading from an earlier release
- Covers: what's new and breaking changes, one `##` entry per release. The next release's notes go under one "Unreleased" heading, the file's first `##` entry, until the release is cut; a published release's heading is its version and release date, as in `## 0.11.0 (2026-10-06)`
- The coupled switch-over and rollback runbooks, copied from the README, sit in the 0.11.0 entry, the release that introduced them. A later runbook change is made in that copy in place, and the "Unreleased" entry says what changed
- No "Upgrade steps" section: the two runbooks are the upgrade and its way back. No operator text (the README, the three skills, `docs/architecture.md`, `docs/engineering-guide.md`, the CHANGELOG) has a heading of that title or a link to one
- The README's two runbook sections are the maintained copy. Change the README first, then the CHANGELOG copy: each copy opens with one line naming its README section as the maintained copy, by a `README.md#` link, and otherwise matches the README section word for word, headings included. A same-file link to a runbook heading stays a same-file link to the copy's own heading; only a link to a README section the CHANGELOG does not carry is written as a `README.md#` link. Like the README, a copy says "the Slack token environment variables" and never names one
- A retired file the previous release reads is kept until rollback is no longer wanted. That file's bullet under Breaking changes says so, with the reason (the previous CSCB reads it), and nothing in the file tells the operator to delete it
- The one place for what changed from an earlier release; the README describes only the current state
- A new command, file, log label or start-summary count a release note introduces is written as a code span, spelled as `src/` writes it
- Every link resolves: a same-file anchor to a CHANGELOG heading, a repository link to an existing file and heading
- `tests/shipped-docs.test.ts` checks some of these rules through `OPERATOR_TEXTS` (see the testing guide's Shipped-Description Audit): one "Unreleased" entry, first; no "Upgrade steps" heading or link; the breaking note's parts; the keep-until-rollback sentence and no delete instruction for the retired file; each runbook copy's maintained-copy line, its word-for-word match and no named token variable; and every link resolving. The code-span rule is checked only for the names the hatch notes introduce (`HATCH_NOTE_NAMES`); the rest are kept by review
- Not in the npm tarball (not in `package.json`'s `files`)
- Never rename the "Unreleased" heading by hand: `/publish prepare` does it in the release commit, turning the first `## Unreleased` heading into `## <version> (<UTC date>)` under a fresh empty `## Unreleased` entry, set off by a `---` rule. Prepare stops (`SR-3.1 (changelog)`, exit 20) when the file has no `## Unreleased` heading, so keep one first even when it holds no notes

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
- Changes the README's switch-over or rollback runbook → make the same change to its CHANGELOG copy
- Changes shipped text (README, skills, manifest, MCP instructions) → keep `tests/shipped-docs.test.ts` green by rewriting the text, never by adding an exemption
