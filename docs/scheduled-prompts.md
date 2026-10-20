# Scheduled Prompts (cscb_cron)

The server fires scheduled prompts into personas once per minute, reading them from a crontable. Each fire is stored in the target persona’s queue as its own injected message.

## The crontable

Schedules live in the crontable file at `cron_table_path`. Without that key the crontable is `crontab` in the state directory, `~/.config/claude-slack-channel-bots/crontab` by default, outside `~/.claude`, so a bot appending a schedule doesn't trigger Claude Code's approval prompt for writes under `~/.claude`. Set `cron_table_path` in `config.json` to put it anywhere else (see [Server-wide settings](server-settings.md#server-wide-settings)).

```sh
cat ~/.config/claude-slack-channel-bots/crontab
```

At start the server creates the state directory. It creates the crontable on first boot if it is absent, with a self-documenting comment header describing the line format. See [Crontable format](#crontable-format) below for the full reference. For a `cron_table_path` you set, the directory must already exist.

## Crontable format

On first boot the server auto-creates the crontable with this self-documenting header:

```
# CSCB crontable — scheduled prompts for the Slack channel bots.
#
# One schedule per line. Fields are positional and whitespace-delimited:
#
#   <min> <hour> <dom> <mon> <dow> <prompt-path> [<persona>[,<persona>...]]
#
#   tokens 1-5 : a standard 5-field cron expression (minute hour day-of-month
#                month day-of-week).
#   token 6    : path to the prompt file to run. It must contain NO spaces — a
#                line with more than 7 whitespace-delimited tokens is a parse
#                error (a path with spaces is unrepresentable). The prompt
#                file's content is capped at 32KB (enforced when the job fires).
#   token 7    : OPTIONAL comma-separated list of personas to target, each
#                written as the persona's name or its key. Naming a persona
#                twice (by name, by key, or both) delivers to it once. A name
#                containing whitespace or a comma cannot be written here —
#                write that persona's key instead. A bot can target itself
#                with the key in its CSCB_PERSONA environment variable. A
#                target that names no persona is logged unknown-persona.
#                Omit the token entirely to target ALL bots — that omission IS
#                the all-bots form. All-bots fan-out is not delivered yet: such
#                a line is logged fanout-deferred each time it fires. There is
#                NO all-bots wildcard: a literal '*' in the target position is
#                a parse error, not "all personas".
#
# Lines beginning with '#' and blank lines are ignored. A malformed line is
# skipped on its own; sibling lines still schedule.
#
# Example (every day at 09:00, run grooming-tick.md, target two personas):
#   0 9 * * * /home/horde/prompts/grooming-tick.md planner,reviewer
#
# Example (every hour, run standup.md, no persona list — NOT delivered yet):
#   0 * * * * /home/horde/prompts/standup.md
```

Each schedule is one line of **exactly 5 cron fields**, then the prompt-file path, then an optional comma-separated list of personas, each written as the persona's name or its key:

```
0 9 * * 1 /home/horde/prompts/weekly-report.md planner,reviewer
```

Rules:

- **Exactly 5 cron fields** (minute hour day-of-month month day-of-week). Croner's 6-field (seconds-precision) and `@macro` forms are **not** supported.
- **Name each persona by its name or its key.** A persona named twice — by name, by key, or both — receives the prompt once.
- **Use the key for a name with whitespace or a comma.** Such a name cannot be written in a crontable line.
- **Give every line a persona list.** A line with no persona list is the all-bots form, and all-bots delivery is not built yet: the line loads, but each load logs a `warn` naming it and each fire is dropped (see [The cron log](#the-cron-log)).
- **No `*` wildcard in the persona position.** A literal `*` where a persona belongs is a parse error, not "all personas".
- **Prompt paths cannot contain spaces.** A path with spaces is unrepresentable; the extra tokens make the line a parse error and it is skipped.
- **`#` comments and blank lines are allowed** and ignored.
- **A bad line is skipped and logged** (as `parse-error` in the cron log), never fatal — sibling lines still schedule.

Because the count is positional, a **6-field line silently mis-parses instead of erroring.** For example:

```
0 0 1 1 1 1 ~/prompts/p.md
```

Here the 6th field (`1`) is taken as the prompt path and the real path (`~/prompts/p.md`) is taken as the persona list. No error is raised — every slot is filled with something syntactically acceptable — so the schedule fires on a nonsense cadence against a nonsense path. Keep expressions to exactly 5 fields.

**Upgrading a crontable that names channels.** The server never rewrites an existing crontable, so channel-ID targets are not converted. Once your config defines personas, a Slack channel ID no longer names a bot, so edit each such line to a persona name or key; until you do, the target logs `unknown-persona`.

An existing crontable also keeps its old comment header, which still tells bots to write channel IDs and to leave out the target list to reach all bots. Replace that comment block by hand with the header shown above. This section is the reference for the line format, whatever a crontable's own header says.

## Path resolution

The prompt-file path resolves as follows:

- A leading `~` expands to the home directory.
- A **relative** path resolves against the **crontable's own directory** — not `$HOME`. This is a deliberate divergence from system cron's convention, so you can keep a `prompts/` directory alongside the crontable and reference it as `prompts/standup.md`. With the default location that directory is `~/.config/claude-slack-channel-bots/prompts/`.
- An **absolute** path is used as-is.

## How fires appear

The server directly queues a scheduled fire only for the target persona, as an injected message with no Slack conversation attached. Its `sender` label is `cscb-cron:<prompt-file-basename>` — for a prompt file `standup.md` the sender is `cscb-cron:standup`. This distinguishes a cron tick from a human and from peer-bot traffic. Scheduled fires never arm [Slack reply reminders](bots.md#slack-reply-reminders); like every injected message, a fire carries no `via`. Because a fire carries no channel, a prompt file that wants a Slack reply must say where to post it. Each schedule queues its own message independently, so when several schedules match the same minute for the same persona each one is its own queued item.

## The cron log

Every fire outcome is recorded in the cron log at `cron_log_path` (default `<config dir>/cron.log`, beside `config.json` wherever the crontable is; override with the `cron_log_path` key). Each attempt writes one line per persona targeted (showing the target as first written in the crontable), plus a per-fire summary line carrying `queued=N failed=M` counts. The log is plain text, so `grep queue-failed cron.log` yields readable lines.

By default the log only grows. To cap it, set `cron_log_max_bytes` in `config.json`: once the log passes that many bytes, its oldest whole lines are dropped, so the oldest fires disappear from it while the newest stay. There is no rotated copy; copy the log elsewhere if you need a longer history. Don't move or delete it yourself: the server keeps writing to the old file until that file passes the cap. A changed cap takes effect at the next server start.

The `outcome` field of each line is one of these classes:

| Outcome | What happened | What to do |
|---|---|---|
| `queued` | The prompt was durably stored for the target persona. | Nothing — storage succeeded; this is not a delivery confirmation. |
| `queue-failed` | The prompt could not be stored. | Check storage availability and permissions in the server log. |
| `unknown-persona` | No persona in the applied configuration has that name or key. | Correct the target in the crontable. |
| `prompt-missing` | The prompt file did not exist at fire time. | Create the file or correct its path in the crontable. |
| `prompt-unreadable` | The prompt file existed but could not be read (see the `errno`). | Fix file permissions or the path. |
| `prompt-oversize` | The prompt exceeds the 32KB `/interject` cap and was skipped, never truncated. | Shorten the prompt file. |
| `parse-error` | The crontable line could not be parsed. | Fix the line — see [Crontable format](#crontable-format). |
| `fanout-deferred` | A line with no persona list (all-bots) was matched but not delivered. | Add a persona list to the line — all-bots delivery is not built yet. |

Each load of the crontable, at start and after each edit, writes one line with its counts. At start it is `scheduler started, N schedules loaded, M undeliverable (no persona list)`; after an edit it is `crontable reloaded, N schedules, M undeliverable (no persona list)`. `M` counts the lines that will never be delivered, and it is written even when it is 0.

Each load also writes one `warn` line for each line with no persona list, naming its line number in the file and its prompt path:

```text
2026-10-09T15:12:00.002Z cscb-cron:grooming - warn line=34 prompt=/home/horde/prompts/grooming.md undeliverable: this crontable line names no personas, so it will never be delivered in this version …
```

Add a persona list to that line. The warning comes back at every start and every edit until you do; an unchanged crontable is not reloaded, so it is not repeated each minute. To list them in the cron log at its default location:

```sh
grep undeliverable ~/.config/claude-slack-channel-bots/cron.log
```

## Delivery semantics

- **Accepted fires stay queued.** A configured persona can accept prompts while it is down or disconnected. Every accepted fire is an independent item, never merged or dropped, and delivered in FIFO order across all sources, carrying its fire timestamp as `ts`; a failed store is logged as `queue-failed` and is not an accepted item.
- **Missed fires are skipped, not caught up.** While the server is down, no scheduled prompts fire, and they are not replayed on restart. The `scheduler started, N schedules loaded, M undeliverable (no persona list)` line in the cron log marks when scheduling resumed, bounding the outage window.
- **Edits take effect within a minute — no restart.** The scheduler checks the crontable fresh on every tick, so an edit by hand or a line appended by a bot starts (or stops) firing within about a minute. The server is never restarted for a schedule change.
- **Deleting the crontable stops all schedules.** Nothing fires from that moment, a WARN appears in the cron log, and the server re-creates the file empty (with its header) within about two minutes — detection and re-creation happen on separate once-a-minute passes, so the re-create lands up to two tick boundaries after the deletion. Add lines back and they schedule on the next check.
- **Server-local time.** Cron expressions are evaluated in the server's local timezone.
- **A line without a persona list is never delivered.** Each load logs a `warn` naming it and counts it undeliverable; each time it matches, it is logged `fanout-deferred` and dropped. Give the line a persona list to have it fire.

## Bot self-scheduling

Every managed session carries the resolved crontable path in the `CSCB_CRONTABLE_PATH` environment variable and its own persona key in `CSCB_PERSONA`, so a bot can schedule its own prompts without being told where the crontable lives or what to call itself. Discover both from inside a session:

```sh
echo $CSCB_CRONTABLE_PATH $CSCB_PERSONA
```

To schedule a prompt for itself, a bot appends a line whose persona list is its `CSCB_PERSONA` key:

```sh
echo "0 9 * * 1-5 prompts/standup.md $CSCB_PERSONA" >> "$CSCB_CRONTABLE_PATH"
```

The crontable is the single source of truth for schedules. When adding a schedule, **append** a new line — never rewrite, reorder, or delete other lines. An appended line starts firing within about a minute; no server restart is needed.
