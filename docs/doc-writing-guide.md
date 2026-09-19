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

## When to Update

After completing work that:
- Adds a user-facing feature → update README.md
- Changes how the system works internally → update docs/architecture.md
- Introduces new coding patterns → update relevant guide
- Adds new config fields → update both README.md and docs/architecture.md
