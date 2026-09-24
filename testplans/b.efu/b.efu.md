---
id: b.efu
type: bee
title: 'Test: resume-success path end to end (simulated reboot, never executed in production)'
tags:
- cscb
- resume
- integration-test
- from-b.nk5
status: pupa
created_at: '2026-09-20T08:38:56.309500'
schema_version: '0.1'
reference_materials: null
guid: efu3kjgtw9f1rp69vkpw4mrpsrbh24fo
---

# Test: verify the never-executed resume-success path end to end

## Goal, in plain English

CSCB's resume-success path (`action: 'resumed'`, the `resume` call at the end of `resumeOrFreshSpawn` in `src/session-manager.ts`) has **never once executed in production**. Before trusting it at the next reboot, exercise it in a controlled environment. This is an integration scenario, not a unit test — run it via **/release-test inside the Docker CI container**.

## Unknowns to verify (from b.nk5 work item 3)

1. The resumed claude re-fires SessionStart and reconnects to CSCB's MCP server.
2. The registry re-maps the new MCP session id to the persona: the server matches the session's roots directory to the persona's working directory and logs `[slack] Session connected: persona "<name>" (key=<key>) cwd="<working directory>"`.
3. `approvePreSessionDialogs` drives the dev-channels dialog on a resumed pane (b.vub notes the row is still `missing`/`ended` at that point).
4. Queued Slack messages flow after resume.

## Preconditions: row provenance

The start sweep and the collision ladder are keyed by persona (b.av2 SR-6.2, SR-6.3). A row is resumed only when it was created by this build for the same persona, working directory and config dir. Before the simulated reboot, every row under test must:

- have been spawned by this build, so it carries the `persona=<key>` and `config_dir=<hex>` labels and the instance ID `cscb_<key>`;
- have a `cwd` whose real path is the persona's working directory at restart (don't move or re-point it between spawn and restart);
- carry the `config_dir` label of the effective `claude_config_dir` in the config used at restart (don't change it between spawn and restart).

Otherwise the persona starts fresh instead of resuming, and the scenario tests nothing. A row with no `persona` label (for example left over from an older build), naming an absent persona, with another instance ID or with another `cwd` is killed and deleted by the start sweep (`[slack] reconcileOrphans: sweeping row (<reason>) …`). A row whose `config_dir` label is missing or different is deleted and spawned fresh (`… config_dir label missing …` or `… config_dir label changed … — not resuming; spawning fresh`). Start from a clean agent-director store in the container, or check that none of these lines appears for the persona under test.

Run only in the Docker CI container, never against the real HOME or a production install (b.av2 SR-13.2).

## Simulated-reboot scenario (from b.nk5's acceptance criteria, carried from b.m6u)

Runnable without rebooting production: kill all `slack_bot_*` tmux sessions leaving AD rows `waiting`/`working` → plain `start` brings every previously-active persona back **with context via resume** — verify `[slack] spawnForPersona: resumed "<name>" (key=<key>)` appears in server.log for each persona, and that no `reconcileOrphans: sweeping row`, `replacing the row` or `not resuming; spawning fresh` line appears for it — on a machine with no per-host hygiene script. After the resume, `agent-director list --label service=cscb` shows one row per persona, with instance ID `cscb_<key>` and the labels `persona=<key>` and `config_dir=<hex>` unchanged. Also assert no `ErrSpawnNotResumable` at startup recovery (the findMissing-first path holds).

## Notes

- Requires an agent-director binary ≥ 0.8.0 in the container (SessionStart persistence of `jsonl_path`/`extra_env` is what makes resume viable).
- Each persona under test must have some activity after spawn so the transcript file actually exists; an idle-since-spawn session hits the expected `ErrJsonlMissing` nothing-to-lose path instead.
- **Blocked: this scenario cannot run in the CI container yet.** It needs a non-dry-run `start`, which launches a persona only after its credentials file is read and its Slack validation passes (b.av2 SR-6.1). The container has no test-workspace credentials, so no persona is brought up and nothing resumes. It stays blocked until the container can get a credentials file for a test-workspace app per persona. Until then, the live home for this resume check is the Reboot section (appended by E11) of the live acceptance plan b.yko. Never write a token into this ticket, a script or a log. Test 4 (`tests/integration/test-4-resume-dialog.sh`) covers the resume-past-the-dialog lap without Slack by calling `spawnForPersona` directly.

## Evidence

See umbrella ticket **b.nk5** work item 3 and its acceptance criteria.

