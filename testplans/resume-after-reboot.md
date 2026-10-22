# Resume after a simulated reboot

Verify that a persona resumes its existing conversation and reconnects to
CSCB after the container restarts. Run only in the disposable Docker CI
container with the prerequisites below.

## Checks

1. The resumed agent reports SessionStart through agent-director.
2. CSCB reconnects the persona to its MCP session.
3. The native launch clears pre-session dialogs and becomes ready.
4. Queued Slack messages flow after resume.

## Preconditions: row provenance

The start sweep and the collision ladder are keyed by persona. A row is resumed only when it was created by this build for the same persona, working directory and config dir. Before the simulated reboot, every row under test must:

- have been spawned by this build, so it carries the `persona=<key>` and `config_dir=<hex>` labels and the instance ID `cscb_<key>`;
- have a `cwd` whose real path is the persona's working directory at restart (don't move or re-point it between spawn and restart);
- carry the `config_dir` label of the effective `claude_config_dir` in the config used at restart (don't change it between spawn and restart).

Otherwise the persona starts fresh instead of resuming, and the scenario tests nothing. A live row naming an absent persona, with another instance ID or with another `cwd` is killed with the result checked and kept by the start sweep, never deleted (`[slack] reconcileOrphans: sweeping row (<reason>) …`); a finished one is not killed. A row with no `persona` label (for example left over from an older build) is killed if it is live and kept, never deleted (`[slack] reconcileOrphans: killing pre-persona row instanceId=…`). A row whose `config_dir` label is missing or different is replaced by a reuse spawn of the same id, never resumed and never deleted (`… config_dir label missing …` or `… config_dir label changed … — not resuming; replacing its row by a reuse spawn of the same id`). Start from a clean agent-director store in the container, or check that none of these lines appears for the persona under test.

Run only in the Docker CI container, never against the real HOME or a production install.

## Simulated-reboot scenario

Runnable without rebooting production: kill all `slack_bot_*` tmux sessions leaving AD rows `waiting`/`working` → plain `start` brings every previously-active persona back **with context via resume** — verify `[slack] spawnForPersona: resumed "<name>" (key=<key>)` appears in server.log for each persona, and that no `reconcileOrphans: sweeping row`, `replacing the row` or `not resuming; spawning fresh` line appears for it — on a machine with no per-host hygiene script. After the resume, `agent-director list --label service=cscb` shows one row per persona, with instance ID `cscb_<key>` and the labels `persona=<key>` and `config_dir=<hex>` unchanged. Also assert no `ErrSpawnNotResumable` at startup recovery (the findMissing-first path holds).

## Notes

- Requires an agent-director binary ≥ 0.8.0 in the container (SessionStart persistence of `jsonl_path`/`extra_env` is what makes resume viable).
- Each persona under test must have some activity after spawn so the transcript file actually exists; an idle-since-spawn session hits the expected `ErrJsonlMissing` nothing-to-lose path instead.
- **Blocked: this scenario cannot run in the CI container yet.** It needs a non-dry-run `start`, which launches a persona only after its credentials file is read and its Slack validation passes. The container has no test-workspace credentials, so no persona is brought up and nothing resumes. It stays blocked until the container can get a credentials file for a test-workspace app per persona. Until then, the live home for this resume check is the Reboot section of the live acceptance plan. Never write a token into this document, a script or a log. Test 4 (`tests/integration/test-4-resume-dialog.sh`) covers the resume-past-the-dialog lap without Slack by calling `spawnForPersona` directly.
