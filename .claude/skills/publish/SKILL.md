---
name: publish
description: Build, verify, and publish claude-slack-channel-bots to npm
version: 1.0.0
user-invocable: true
argument-hint: "[patch|minor|major]"
allowed-tools: [Bash, Read]
---

# /publish

Publish claude-slack-channel-bots to npm. Runs pre-publish checks, bumps the
version, commits, tags, pushes, and publishes.

## Steps

### 1 — Pre-publish checks

Run all of these. Stop if any fail.

```bash
bun test
bun run typecheck
```

### 2 — Version bump

The user can pass `patch`, `minor`, or `major` as an argument. Default to
`patch` if no argument is given.

Read the current version from `package.json`, compute the next version, and
update the `version` field. Use `npm version <patch|minor|major> --no-git-tag-version`
to bump it cleanly.

Show the user: `Publishing x.y.z → a.b.c`

### 3 — Commit and tag

```bash
git add package.json
git commit -m "Release vA.B.C"
git tag vA.B.C
```

### 4 — Publish to npm

```bash
npm publish
```

If this fails (e.g. not logged in), show the user `npm login` instructions and
stop. Do not push the tag if publish fails.

### 5 — Push to GitHub

```bash
git push origin main --tags
```

### 6 — Summary

Print:
- Published version
- npm URL: https://www.npmjs.com/package/claude-slack-channel-bots
- GitHub tag URL
