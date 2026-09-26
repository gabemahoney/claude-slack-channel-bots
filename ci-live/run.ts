#!/usr/bin/env bun
/**
 * run.ts — /ci-live: the live Slack acceptance run of CSCB (testplans/b.yko)
 * in a throwaway docker container, against the test workspace.
 *
 *   bun ci-live/run.ts [--dry-run] [--provision-only] [--stage apps|install|tokens|channels]
 *                      [--only <check ids, comma-separated>] [--keep-container] [--clean]
 *                      [--create-apps]
 *   bun ci-live/run.ts login [--second]
 *   bun ci-live/run.ts mailbox --latest|--forwarding [--show-body]
 *
 *   --dry-run          no secret is read: a local stub stands in for Slack, the
 *                      container runs the checks that need no workspace, the
 *                      others are SKIPPED (no workspace secrets)
 *   --provision-only   provision the workspace (apps, install, tokens,
 *                      channels) and validate it; no container, no checks
 *   --stage <stage>    run only that provisioning stage (implies
 *                      --provision-only; not with --dry-run)
 *   --only <ids>       run only these checks (for example 1,2,S2); the others
 *                      are SKIPPED (not selected), except the prerequisites
 *                      and the always-run checks
 *   --keep-container   leave the test container for inspection
 *   --clean            remove the results dir when the run passes
 *   --create-apps      let a real run create the four test apps when no
 *                      apps.json exists (without it, a missing apps.json is
 *                      not runnable, so a new VM makes no duplicate apps)
 *   login              sign the test human in (answering an emailed code on
 *                      the terminal if Slack asks) and save the session
 *   login --second     the same for the second workspace user (live.json
 *                      `second_user`)
 *   mailbox --latest   show the test mailbox's newest message (mailbox.json):
 *                      when it came, its sender and subject, and a
 *                      confirmation code found in it (Gmail's forwarding code
 *                      or Slack's sign-in code); nothing else of it. Exit 2
 *                      when there is no mailbox or no message
 *   mailbox --forwarding
 *                      show the newest Gmail forwarding confirmation in the
 *                      test mailbox (from google.com, subject "Forwarding
 *                      Confirmation"), even when newer mail came after it:
 *                      when it came, its sender and subject, its confirmation
 *                      code if any, and its confirm link on a line of its own
 *                      (`confirm link: https://mail-settings.google.com/…`;
 *                      never the cancel link). The link is printed on
 *                      purpose: open it to approve the forwarding. Exit 2
 *                      when there is no mailbox or no such message. Not with
 *                      --latest
 *   --show-body        (with mailbox --latest or --forwarding) print the
 *                      message's body too
 *
 * When Slack asks the test human for an emailed sign-in code during a run,
 * the runner first reads it from the test mailbox (up to 2 minutes, only mail
 * received after the sign-in attempt started) and types it; without a
 * mailbox, or without a code in time, it stops as before (exit 2: run
 * `login` once).
 *
 * The full usage is `USAGE` in lib/args.ts, which parses the command line.
 *
 * Exit 0 on PASS, 1 on FAIL, 2 when the run can't be made (missing secret,
 * docker down, refused configuration token …), with a one-line reason that
 * names the file or variable to fix and never a value.
 *
 * Install this directory's own dependencies once, without lifecycle scripts:
 *   (cd ci-live && bun install --ignore-scripts)
 */

import { main } from './main.ts'

process.exit(await main(process.argv.slice(2)))
