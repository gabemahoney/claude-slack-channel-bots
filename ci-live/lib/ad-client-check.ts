/**
 * ad-client-check.ts — where the cscb-ci images keep the client-under-test check.
 *
 * `docker/ad-client-check.sh` checks, without changing anything, the
 * agent-director client an installed package resolves (`--package <dir>`) or
 * a client as it is (`--client <dir>`): the npm client tarball the base image
 * fetched has its pinned SHA-256, the client is the release's version (with
 * `--package`, exactly the package's pin and its Phase 1 floor), its files
 * equal that tarball's, it exports the three Phase 1 classes, the first
 * agent-director on PATH reports the release's version and commit, that
 * version is at or above the client's floor, and `Client.create()` reports
 * it. It runs an agent-director binary, so it runs only in an image; no host
 * code runs it.
 */

/** The check's path in the image (off PATH, outside the default agent-director binary's directory). */
export const AD_CLIENT_CHECK = '/opt/agent-director/check/ad-client-check.sh'

/** The check's source, relative to the repo root (docker/Dockerfile.test.base copies it to `AD_CLIENT_CHECK`). */
export const AD_CLIENT_CHECK_SOURCE = 'docker/ad-client-check.sh'

/** How the check's one success line starts (it goes on to name the client, the tarball's SHA-256, the binary and the floor). */
export const AD_CLIENT_CHECK_PASSED = 'ad-client check passed: '
