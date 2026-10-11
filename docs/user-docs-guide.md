# User Docs Guide

Where each piece of operator documentation goes, and the rules every user doc follows. The writing style is in [doc-writing-guide.md](doc-writing-guide.md); the rules for shipped text (persona terms, banned terms, secrets) are its "Shipped descriptions" section.

## The user docs

User docs are for operators who install and run CSCB. Each page covers one task. Put a fact on the page whose task needs it, and link to it from anywhere else.

| File | Holds | Budget |
|---|---|---|
| `README.md` | What CSCB is, Quick Start (install), Prerequisites, a first configuration, everyday commands, and the table of the pages below | ~400 lines |
| `docs/configuration.md` | `config.json`: every persona field and server-wide setting, credentials files, load-time rules, environment variables, `slack-mcp.json`, the two channel modes | ~200 lines |
| `docs/reload.md` | Changing the configuration of a running server: the preview, the confirmation, what each kind of change does | ~200 lines |
| `docs/cli.md` | Every CLI subcommand: what it does, what it prints, its exit codes | ~200 lines |
| `docs/bots.md` | What a persona can do and how messages reach it: tools, message tags, `/interject`, the permission relay, the Slack Reply Guard | ~200 lines |
| `docs/scheduled-prompts.md` | The crontable, its format, the cron log | ~200 lines |
| `docs/agent-director.md` | Checking the agent-director install, the `install-cscb` skill, agent-director's settings and the call timeout | ~200 lines |
| `docs/troubleshooting.md` | Symptoms and their fixes, the server log, the startup-error classes | ~200 lines |
| `docs/migration.md` | Installing this release over an earlier one, and rolling it back | ~200 lines |

Not user docs: `CONTRIBUTING.md` (working on CSCB, cutting a release), `CHANGELOG.md` (see the doc-writing guide), the internal guides in `docs/`, and the skills. The `debug-slack-channel-bots` skill is the full reference, with an entry for every persona log class, every `config.json` rejection and each recovery step; `docs/troubleshooting.md` covers the common symptoms and points to it.

## Rules

- **The README is install and the happy path.** Everything else goes on its page; the README links to it.
- **Keep to the budget.** A page over its budget is cut before anything is added: move per-log-line or per-notice detail into the debug skill, and drop what a test already holds. Several pages are over budget today (`docs/troubleshooting.md` most of all); shrink a page when you touch it, never grow it. The two runbooks in `docs/migration.md` are copied word for word into `CHANGELOG.md` and followed step by step by an integration test, so cut around them, not inside them.
- **A bug's lesson goes in its test, not a guide.** Don't write up a past failure, a workaround's history or why a fix was made. Pin the behaviour with a test; document only what an operator does now.
- **Few, task-shaped pages.** Add a page only when no existing page fits the task. A new page goes in this table, in the README's Documentation table and in `package.json`'s `files`.
- **Current state only.** What changed between releases goes in `CHANGELOG.md`.
- **No implementation detail and no testing.** No source paths, function names or modules; nothing about how CSCB is tested.
- **Error cases live in two places only:** `docs/troubleshooting.md` and the debug skill. Other pages link there.
- **Links resolve.** Link with relative paths and heading anchors. When you move or rename a heading, fix every link to it: the user docs, the skills, `CHANGELOG.md` and `docs/architecture.md`.
- **Runtime messages name pages.** Some server and script messages name a page and a section by title (for example `PHASE1_RUNBOOK_DOC` and `PHASE1_RUNBOOK_SECTION_TITLE` in `src/ad-version-gate.ts`). Moving that section means changing the constant and the tests that pin it.
- **The pages ship in the npm package,** because the skills and the server's messages point to them. `tests/shipped-docs.test.ts` audits them as shipped text.
