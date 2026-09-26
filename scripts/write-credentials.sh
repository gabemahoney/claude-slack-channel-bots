#!/usr/bin/env bash
# scripts/write-credentials.sh — write one persona's credentials file from the
# operator's own terminal (b.av2 SR-12, SR-1.4 part).
#
# Usage: write-credentials.sh <credentials file path>
#
# `claude-slack-channel-bots credentials <persona>` runs it with bash, passing
# the persona's `credentials_file` from config.json; the setup wizard hands the
# operator that one line. It works under bash or zsh (linux-x64,
# darwin-arm64) and needs `curl`, `mktemp`, `mkdir`, `chmod`, `mv` and `rm`.
#
# What it does, in order:
# - Turns off command tracing and automatic export (`set +xa`), so no token
#   reaches a trace or a child's environment.
# - Checks the path (absolute or `~/…`, naming a file, not a directory; exit
#   2 otherwise), then that `curl` is installed (exit 1), before asking
#   anything.
# - If the file already exists, asks for `yes` to replace it; anything else,
#   an empty answer included, exits 1 and leaves the file untouched.
# - Reads the bot token, then the app-level token, without echo. On a
#   terminal an empty answer (a stray Enter) asks again. When standard input
#   isn't a terminal it reads one value per line in the same order: `yes`
#   (only when the file exists), the bot token, the app token.
# - Checks each locally (not empty, `xoxb-` / `xapp-` prefix, only letters,
#   digits and dashes); a failure names the key and the rule, and nothing is
#   sent to Slack.
# - Validates `bot_token` with Slack `auth.test` and `app_token` with
#   `apps.connections.open` (30-second limit each). A check passes only when
#   the first field of Slack's reply is `"ok":true`; otherwise it prints
#   Slack's error code when that is plain letters, digits, `_` and `.`, else
#   `unexpected response`, or `could not reach Slack`. A token reaches curl
#   only on its standard input, as a `--config -` header line, never in its
#   arguments or environment, and is never printed; `curl -q` ignores the
#   operator's `~/.curlrc`.
# - Only when both pass, writes the file: a JSON object with exactly
#   `bot_token` and `app_token`, mode 0600 from creation whatever the umask
#   (an exclusive `mktemp` file beside the target, then one rename). A trap
#   removes the temporary file on any failure or interrupt. If the target
#   changed while it ran (appeared, vanished, became or stopped being a
#   symlink, or became a directory, including just before the rename),
#   nothing is written. It creates a missing parent directory, checks that
#   the result is a regular, non-empty file, and prints the path and mode.
# - The rename replaces a symlink at the path with a regular file; the file
#   the symlink pointed to keeps the old tokens.
#
# Exit status: 0 when the file was written; 2 for a usage or path error; 1
# for anything else. Output: prompts and failures on stderr, the `ok` lines
# and the success line on stdout.
#
# SPDX-License-Identifier: MIT

set +xa
if [ "$#" -ne 1 ]; then
  printf '%s\n' 'usage: write-credentials.sh <credentials file path>' >&2
  exit 2
fi
creds_file=$1
f='credentials file:'
cscb_die() {
  printf '%s\n' "$2" >&2
  exit "$1"
}
case "$creds_file" in
  "~") creds_file="$HOME" ;;
  "~/"*) creds_file="$HOME/${creds_file#"~/"}" ;;
esac
m="$f the path must be absolute or start with ~/"
case "$creds_file" in
  /*[^/]) ;;
  *) cscb_die 2 "$m and name a file: $creds_file" ;;
esac
if [ -d "$creds_file" ]; then
  cscb_die 2 "$f $creds_file is a directory"
fi
command -v curl >/dev/null 2>&1 ||
  cscb_die 1 'curl: not found; install it, then run again'
umask 077

# Prompt with $1 on stderr and read one line into `val`; $2 is `s` to read
# without echo. On a terminal, an empty silent answer asks again.
cscb_ask() {
  while :; do
    printf '%s' "$1" >&2
    val='' e=0
    read "-r$2" val || e=1
    [ -t 0 ] && [ -z "$2" ] || printf '\n' >&2
    [ -t 0 ] && [ -n "$2" ] && [ -z "$val" ] &&
      [ "$e" = 0 ] || return 0
  done
}

# What is at the target now: L (a symlink), e (anything else) or 0 (nothing).
cscb_kind() {
  if [ -L "$creds_file" ]; then kind=L
  elif [ -e "$creds_file" ]; then kind=e
  else kind=0
  fi
}
cscb_kind
had=$kind
if [ "$had" = 0 ]; then :; else
  q="$creds_file already exists."
  cscb_ask "$q Type yes to replace it: " ''
  [ "$val" = yes ] ||
    cscb_die 1 "Not replaced: $creds_file is unchanged."
fi
p='bot_token (Bot User OAuth Token, starts with xoxb-): '
cscb_ask "$p" s
bot=$val
p='app_token (app-level token, starts with xapp-): '
cscb_ask "$p" s
app=$val
val=''

# Local checks: nothing is sent to Slack unless both pass.
bad=0
cscb_bad() {
  printf '%s: %s\n' "$1" "$2" >&2
  bad=1
}
c='may hold only letters, digits and dashes'
r='followed by the rest of the token'
case "$bot" in
  '') cscb_bad bot_token empty ;;
  *[^A-Za-z0-9-]*) cscb_bad bot_token "$c" ;;
  xoxb-?*) ;;
  *) cscb_bad bot_token "must start with xoxb- $r" ;;
esac
case "$app" in
  '') cscb_bad app_token empty ;;
  *[^A-Za-z0-9-]*) cscb_bad app_token "$c" ;;
  xapp-?*) ;;
  *) cscb_bad app_token "must start with xapp- $r" ;;
esac
[ "$bad" = 0 ] ||
  cscb_die 1 'Nothing written and nothing sent to Slack.'

# Validate one token ($2, named $1) with Slack method $3. The token goes to
# curl only as a header line of its config, on its standard input.
cscb_check() {
  u="https://slack.com/api/$3"
  h='header = "Authorization: Bearer %s"\n'
  resp=$(
    { printf "$h" "$2" |
      command curl -q -s -X POST -d '' -m 30 --config - "$u"
    } 2>/dev/null
  )
  rc=$?
  flat=${resp//[[:space:]]/}
  err='unexpected response'
  if [ "$rc" -ne 0 ] || [ -z "$flat" ]; then
    err='could not reach Slack'
  fi
  case "$rc$flat" in
    0'{"ok":true,'*|0'{"ok":true}'*)
      printf '%s: ok (%s)\n' "$1" "$3"
      return 0 ;;
    0'{"ok":false,'*'"error":"'*)
      code=${flat#*'"error":"'}
      code=${code%%'"'*}
      case "$code" in
        ''|*[^A-Za-z0-9_.]*) ;;
        *) err=$code ;;
      esac ;;
  esac
  printf '%s: failed (%s: %s)\n' "$1" "$3" "$err" >&2
  return 1
}
bad=0
cscb_check bot_token "$bot" auth.test || bad=1
cscb_check app_token "$app" apps.connections.open ||
  bad=1
[ "$bad" = 0 ] || cscb_die 1 'Nothing written.'

# Write: an exclusive temp file beside the target, mode 0600 from creation,
# then one rename. The trap removes the temp file on failure or interrupt.
dir=${creds_file%/*}
[ -n "$dir" ] || dir=/
mkdir -p "$dir" ||
  cscb_die 1 "$f cannot create the directory $dir"
w="$f cannot write $creds_file; nothing written."
tmp=$(mktemp "$dir/.cscb-credentials.XXXXXXXX") ||
  cscb_die 1 "$w"
trap 'rm -f "$tmp"' EXIT
trap 'rm -f "$tmp"; exit 1' HUP INT TERM
chmod 600 "$tmp" || cscb_die 1 "$w"
{
  printf '{\n  "bot_token": "%s",\n' "$bot"
  printf '  "app_token": "%s"\n}\n' "$app"
} 2>/dev/null >| "$tmp" || cscb_die 1 "$w"
[ -s "$tmp" ] || cscb_die 1 "$w"
cscb_kind
ch="$f $creds_file changed; nothing written."
[ "$kind" = "$had" ] || cscb_die 1 "$ch"
if [ -d "$creds_file" ]; then cscb_die 1 "$ch"; fi
mv -f "$tmp" "$creds_file" || cscb_die 1 "$w"
trap - EXIT HUP INT TERM
if [ -d "$creds_file" ]; then
  rm -f "$creds_file/${tmp##*/}"
  cscb_die 1 "$ch"
fi
[ -f "$creds_file" ] && [ -s "$creds_file" ] ||
  cscb_die 1 "$w"
s='bot_token and app_token both validated.'
printf 'Wrote %s with mode 0600. %s\n' "$creds_file" "$s"
