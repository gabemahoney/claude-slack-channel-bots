/**
 * rc-client.ts — where the cscb-ci images keep the client-under-test check.
 *
 * `docker/rc-client-check.sh` swaps agent-director's release-candidate client
 * into an installed package (`--package <dir>`) or checks a client as it is
 * (`--client <dir>`), then checks it: its files equal the release
 * candidate's client tarball, it exports the three Phase 1 classes, the first
 * agent-director on PATH reports the release candidate's version and commit,
 * that version is at or above the client's floor, and `Client.create()`
 * reports it. It runs an agent-director binary, so it runs only in an image;
 * no host code runs it.
 */

/** The check's path in the image (off PATH, outside the release candidate's binary directory). */
export const RC_CLIENT_CHECK = '/opt/agent-director-rc/check/rc-client-check.sh'

/** The check's source, relative to the repo root (docker/Dockerfile.test.base copies it to `RC_CLIENT_CHECK`). */
export const RC_CLIENT_CHECK_SOURCE = 'docker/rc-client-check.sh'

/** How the check's one success line starts (it goes on to name the client, the tarball's SHA-256, the binary and the floor). */
export const RC_CLIENT_CHECK_PASSED = 'rc-client check passed: '
