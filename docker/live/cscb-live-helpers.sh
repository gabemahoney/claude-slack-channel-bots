# shellcheck shell=bash
# b.yko shell helpers, adapted to the /ci-live container (testplans/b.yko
# Part 1.3). The entrypoint installs this file as ~/cscb-live-helpers.sh with
# TEST_HOST set to the container's hostname; the runner loads it before every
# command it runs in the container (`docker exec … bash -c 'source …'`).
#
# Changes from the plan's file: TEST_HOST / TEST_USER are the container's,
# PATH includes the test user's bun global bin (where the customer install
# puts `claude-slack-channel-bots`), missing files read as empty, and two
# read-only helpers the runner uses (`tmark`, `rows`) are added.
# Every helper only reads, except `guard`, which only decides. None prints a
# token: `showpending` and `showsafe` show text only after counting zero
# token-shaped matches in it.
TEST_HOST='@TEST_HOST@'   # the container's hostname
TEST_USER='testuser'
export PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
S=~/.claude/channels/slack
LOG="$S/server.log"
TRAIL="$S/permission-trail.jsonl"

# The installed package root, found as the setup wizard's Step 1 finds it.
PKG=''
for d in "$HOME/.bun/install/global/node_modules/claude-slack-channel-bots" \
         "$(npm root -g 2>/dev/null)/claude-slack-channel-bots"; do
  [ -z "$PKG" ] && [ -f "$d/README.md" ] && PKG="$d"
done

# guard: succeeds only on the test host, as its user, in a shell with no
# SLACK_STATE_DIR and no token variable (AC 47).
guard() {
  [ -n "${BASH_VERSION:-}" ] || { echo 'not a bash shell - stop'; return 1; }
  [ "$(hostname)" = "$TEST_HOST" ] && [ "$(whoami)" = "$TEST_USER" ] \
    || { echo 'NOT THE TEST HOST - stop'; return 1; }
  [ -z "${SLACK_STATE_DIR:-}" ] || { echo 'SLACK_STATE_DIR is set - stop'; return 1; }
  [ "$(env | cut -d= -f1 | grep -cE '^SLACK_(BOT|APP)_TOKEN$')" = 0 ] \
    || { echo 'a token variable is set - stop'; return 1; }
}

# mark: where server.log ends now, as <inode>:<line count>.
mark() { echo "$(stat -c %i "$LOG"):$(wc -l < "$LOG")"; }

# since MARK: the server log's lines after MARK (one rotation followed).
since() {
  case "$1" in *:*) ;; *) echo "SINCE FAILED: '$1' is not a mark made by mark" >&2; return 2 ;; esac
  local ino="${1%%:*}" n="${1#*:}"
  if [ "$(stat -c %i "$LOG")" = "$ino" ]; then
    tail -n +"$((n + 1))" "$LOG"
  elif [ -e "$LOG.1" ] && [ "$(stat -c %i "$LOG.1")" = "$ino" ]; then
    tail -n +"$((n + 1))" "$LOG.1"; cat "$LOG"
  else
    echo "SINCE FAILED: server.log rotated more than once since mark $1; read server.log.2 and later by hand" >&2
    return 1
  fi
}

# tags a|b|c|d TS: every <channel …> tag delivered to that persona for the
# message with that ts, from the persona's current session transcript. A
# delivered message is a user entry, or, when it arrived while the persona
# was mid-turn, a queued_command attachment (its prompt a string or content
# blocks); Claude Code writes one or the other, never both. The
# queue-operation entries, which hold every message again, are not read.
tags() {
  local t
  t="$(ls -t ~/.claude/projects/*-cscb-live-"$1"/*.jsonl 2>/dev/null | head -1)"
  [ -n "$t" ] || return 0
  jq -r 'if .type == "user" then .message.content
         elif .type == "attachment" and .attachment.type? == "queued_command" then .attachment.prompt
         else empty end
         | if type == "string" then . else (.[]? | .text? // empty) end' "$t" \
    | grep -oE '<channel source="slack[^"]*"[^>]*>' | grep -F " ts=\"$2\""
}

# tagstext a|b|c|d 'TEXT': the tag of every delivered message whose content
# contains TEXT (for an edited message, whose tag may carry another ts). It
# reads the same entries as tags.
tagstext() {
  local t
  t="$(ls -t ~/.claude/projects/*-cscb-live-"$1"/*.jsonl 2>/dev/null | head -1)"
  [ -n "$t" ] || return 0
  jq -r --arg s "$2" 'if .type == "user" then .message.content
         elif .type == "attachment" and .attachment.type? == "queued_command" then .attachment.prompt
         else empty end
         | if type == "string" then . else (.[]? | .text? // empty) end
         | select(contains($s))' "$t" \
    | grep -oE '<channel source="slack[^"]*"[^>]*>'
}

# replies a|b|c|d: every reply tool call in the persona's current
# transcript, with its target and the result the server returned.
replies() {
  local t
  t="$(ls -t ~/.claude/projects/*-cscb-live-"$1"/*.jsonl 2>/dev/null | head -1)"
  [ -n "$t" ] || return 0
  jq -rs '
    [ .[] | select(.type == "assistant") | .message.content | arrays | .[]
      | select(.type? == "tool_use" and (.name | endswith("__reply"))) ] as $calls
    | [ .[] | select(.type == "user") | .message.content | arrays | .[]
        | select(.type? == "tool_result") ] as $results
    | $calls[] | . as $c
    | ([ $results[] | select(.tool_use_id == $c.id) ] | first) as $r
    | "chat_id=\($c.input.chat_id) error=\($r.is_error // false) result=\(
        $r.content | if type == "string" then .
                     elif type == "array" then ([ .[] | .text? // empty ] | join(" "))
                     else "(no result yet)" end)"' "$t"
}

# posts TMARK: every permission-prompt post in the permission trail after
# line TMARK: instance, conversation, ok, error.
posts() {
  [ -e "$TRAIL" ] || return 0
  tail -n +"$(($1 + 1))" "$TRAIL" \
    | jq -c 'select(.event == "cscb.chat_post.attempted") | {claude_instance_id, channel, ok, error}'
}

# tmark: where the permission trail ends now (its line count; 0 when absent).
tmark() { if [ -e "$TRAIL" ]; then wc -l < "$TRAIL"; else echo 0; fi; }

# tokcount FILE...: how many lines of the files hold token-shaped text.
tokcount() { cat -- "$@" 2>/dev/null | grep -cE 'xox[a-z]-[0-9]|xapp-[0-9]'; }

# showsafe: pass stdin through only when it holds no token-shaped text.
showsafe() {
  local t; t="$(cat)"
  if [ "$(printf '%s\n' "$t" | tokcount)" = 0 ]; then
    [ -n "$t" ] && printf '%s\n' "$t"; return 0
  fi
  echo 'TOKEN-SHAPED TEXT - not shown; this fails the check' >&2; return 1
}

# showpending: print config.json.pending only after counting no token-shaped text.
showpending() {
  [ -e "$S/config.json.pending" ] || { echo 'config.json.pending does not exist'; return 1; }
  [ "$(tokcount "$S/config.json.pending")" = 0 ] && cat "$S/config.json.pending" \
    || { echo 'TOKEN-SHAPED TEXT in config.json.pending - not shown; this fails the check' >&2; return 1; }
}

# leakcount FILE...: per file, how many times any token held in a persona
# credentials file under ~/.config/cscb/ occurs in it (read inside bun, never printed).
leakcount() {
  bun -e '
    const fs = require("fs")
    const dir = process.env.HOME + "/.config/cscb"
    const tokens = []
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith("-credentials.json")) continue
      try {
        const c = JSON.parse(fs.readFileSync(dir + "/" + f, "utf8"))
        for (const t of [c.bot_token, c.app_token]) if (typeof t === "string" && t.length >= 20) tokens.push(t)
      } catch {}
    }
    console.log("tokens checked: " + tokens.length)
    for (const file of process.argv.slice(1)) {
      if (!fs.existsSync(file)) { console.log(file + ": absent"); continue }
      const text = fs.readFileSync(file, "latin1")
      let n = 0
      for (const t of tokens) n += text.split(t).length - 1
      console.log(file + ": " + n)
    }' "$@"
}

# --- runner additions (read-only) -------------------------------------------

# rows: the service=cscb agent-director rows, one "<instance id> <persona label> <state>" per line.
rows() {
  agent-director list --label service=cscb \
    | jq -r '(.spawns // [])[] | "\(.claude_instance_id) \(.labels.persona // "-") \(.state)"'
}
