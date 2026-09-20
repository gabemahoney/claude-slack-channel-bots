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

CSCB's resume-success path (`action: 'resumed'`, `src/session-manager.ts:1104-1112`) has **never once executed in production**. Before trusting it at the next reboot, exercise it in a controlled environment. This is an integration scenario, not a unit test — run it via **/release-test inside the Docker CI container**.

## Unknowns to verify (from b.nk5 work item 3)

1. The resumed claude re-fires SessionStart and reconnects to CSCB's MCP server.
2. The registry re-maps the new MCP session id to the channel.
3. `approvePreSessionDialogs` drives the dev-channels dialog on a resumed pane (b.vub notes the row is still `missing`/`ended` at that point).
4. Queued Slack messages flow after resume.

## Simulated-reboot scenario (from b.nk5's acceptance criteria, carried from b.m6u)

Runnable without rebooting production: kill all `slack_bot_*` tmux sessions leaving AD rows `waiting`/`working` → plain `start` brings every previously-active channel back **with context via resume** — verify `spawnForRoute: resumed` appears in server.log — on a machine with no per-host hygiene script. Also assert no `ErrSpawnNotResumable` at startup recovery (the findMissing-first path holds).

## Notes

- Requires an agent-director binary ≥ 0.8.0 in the container (SessionStart persistence of `jsonl_path`/`extra_env` is what makes resume viable).
- The channel must have some activity after spawn so the transcript file actually exists; an idle-since-spawn session hits the expected `ErrJsonlMissing` nothing-to-lose path instead.

## Evidence

See umbrella ticket **b.nk5** work item 3 and its acceptance criteria.

