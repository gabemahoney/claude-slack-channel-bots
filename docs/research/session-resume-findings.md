# Session Resume Research Findings

**Epic**: t1.xir.6w — Session Resume Research Spike
**Date**: 2026-03-30
**Status**: Complete

---

## 1. Session ID Format

Session IDs are standard UUID v4, in `8-4-4-4-12` hex format.

Example: `8d223edc-f565-48b3-9638-00d2cd214c40`

All observed session IDs follow this format. Claude validates UUID format client-side when `--resume` is invoked — non-UUID strings are rejected immediately with an error.

---

## 2. State Storage Location

### Session Registry

Path: `~/.claude/sessions/<pid>.json` — one file per active or recent Claude process, named by OS PID.

Schema:

```json
{
  "pid": 12345,
  "sessionId": "8d223edc-f565-48b3-9638-00d2cd214c40",
  "cwd": "/home/user/myproject",
  "startedAt": 1743289200000,
  "kind": "interactive",
  "entrypoint": "cli"
}
```

- Written within ~1 second of process start, before the safety prompt appears
- Files are NOT cleaned up on process exit (including SIGKILL) — dead PID files persist on disk

### Conversation Transcripts

Path: `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`

- CWD path encoded with slashes replaced by hyphens
- Full conversation history in JSONL format
- Each record includes `sessionId`, `cwd`, `type` (user/assistant), and message content
- Entries written per-turn as the conversation progresses

### Runtime Data

Path: `/tmp/claude-<uid>/<encoded-cwd>/` — mirrors project structure for temporary files.

---

## 3. Recommended Capture Method

**Method: Read `~/.claude/sessions/<pid>.json` from disk**

After launching Claude in a tmux session, poll `~/.claude/sessions/` for a new JSON file whose `cwd` field matches the route's working directory and whose `startedAt` is after the launch timestamp. Read the `sessionId` field.

Rationale:
- Works with interactive sessions (which the Slack bot uses)
- Available within ~1 second of launch, before the safety prompt is dismissed
- Contains the UUID directly in the `sessionId` field

The PID can alternatively be obtained via:

```sh
tmux list-panes -t <session> -F '#{pane_pid}'
```

Note: this may return the shell PID rather than the Claude process PID — implementation should verify and prefer the `cwd`-match approach when possible.

### Alternatives Considered

| Method | Verdict | Reason |
|--------|---------|--------|
| tmux `capture-pane` | NOT viable | Session ID does not appear anywhere in tmux pane output |
| `--output-format=stream-json` | NOT applicable | Only works with `--print` mode AND requires `--verbose`; not applicable to interactive sessions |

---

## 4. Resume Startup Behavior

- `--resume <uuid>` resumes a specific session by UUID, loading conversation history from the JSONL transcript
- In `--print` mode, resume returns a context-aware response with exit 0. No safety prompt appears.
- In interactive mode, safety prompt behavior on resume is **unknown** — requires testing during implementation.

The existing timeout fallback in `launchSession` (polls for prompt text, falls back to `isClaudeRunning()` on timeout) should handle either case without modification.

### Related Flags

| Flag | Behavior |
|------|----------|
| `--resume <uuid>` | Resume a specific session by UUID |
| `--continue` | Resume the most recent session in the current directory |
| `--fork-session` | Resume session history but assign a new UUID |
| `--session-id <uuid>` | Pre-assign a UUID (used internally by SDK for subagents) |
| `--no-session-persistence` | Disable disk writes (only valid with `--print`) |

---

## 5. Resume Failure Behavior

Two distinct failure modes:

| Scenario | Error message | Exit code |
|----------|---------------|-----------|
| Non-UUID string | `--resume requires a valid session ID when used with --print. Session IDs must be in UUID format` | 1 |
| Valid UUID, nonexistent session | `No conversation found with session ID: <uuid>` | 1 |

Key observations:
- Claude does NOT automatically fall back to a fresh session on resume failure
- Both failures are fast (within ~3 seconds) — no hanging
- The implementation must handle fallback to fresh launch explicitly

---

## 6. Success/Failure Detection Method

**For `--print` mode**: Check exit code (0 = success, 1 = failure) and parse error messages from stderr.

**For interactive mode (Slack bot use case)**: Extend the existing `launchSession` polling approach:

1. Launch with `--resume <id>` in tmux
2. Poll `~/.claude/sessions/` for a new session file matching the CWD
3. If a new session file appears AND `isClaudeRunning()` returns true → resume succeeded
4. If the process exits quickly (within seconds) → resume failed, fall back to fresh launch
5. Safety prompt handling: poll for prompt text as today; if timeout expires but Claude is running, accept the session

---

## 7. PRD Assumption Validation

| Assumption | Result |
|------------|--------|
| `--resume` works after SIGKILL | **VALIDATED** — session `.json` and `.jsonl` files persist on disk after process death. Dead PID session files found on disk with intact conversation transcripts. A resumed session successfully loaded prior conversation context. |
| Session state is stored on disk, not solely in memory | **VALIDATED** — `~/.claude/sessions/<pid>.json` written at startup, `~/.claude/projects/<cwd>/<uuid>.jsonl` written per-turn. Both survive process exit. |

---

## 8. Open Items for Implementation

The following items were identified during research but require resolution during Epic 2 (t1.xir.ov):

1. **Safety prompt on interactive resume**: Does the "I am using this for local development" prompt appear when resuming in interactive mode? If not, `launchSession` polling timeout will still succeed via the `isClaudeRunning()` fallback, but polling duration would be wasted.

2. **PID capture from tmux**: Whether `tmux list-panes -F '#{pane_pid}'` returns the Claude process PID or the shell PID needs verification. Alternative: scan session files by `cwd` match.

3. **PID file recycling**: A stale session file with a recycled PID could cause a false match. Mitigate by checking `startedAt` timestamp in addition to `cwd`.
