# Integration scenarios

These documents describe behavior and verification steps. `/release-test`
reads the following local files inside a disposable Docker CI container,
in this order:

| Order | Scenario | Prerequisite | Automated counterpart |
|---|---|---|---|
| 1 | [Package install and server startup](install-startup.md) | Pre-built package tarball | `tests/integration/test-1-install-startup.sh` |
| 2 | [Dry-run startup spawn-skip verification](dry-run-spawn.md) | Scenario 1 passed | `tests/integration/test-2-dryrun-spawn-skip.sh` |
| 3 | [Cozempic availability and clean restart](cozempic-restart.md) | Scenario 2 passed | `tests/integration/test-3-cozempic-restart.sh` |

Stop at the first failure and skip its dependents. Keep every scenario's
verification steps; these files are the prose specifications for Tests 1–3.
The full automated integration gate is `/ci`.

Two separate scenarios have their own prerequisites and are not selected by
`/release-test`:

- [Resume after a simulated reboot](resume-after-reboot.md) requires
  test-workspace credentials for the full Slack path. Test 4 covers the
  resume-past-the-dialog path without Slack; the live scenario covers reboot
  recovery with Slack.
- [Live acceptance](live-acceptance.md) runs against a test Slack workspace.
  `/ci-live` automates it and records checks that require manual verification.

Never run these scenarios against a production install or the host's HOME.
