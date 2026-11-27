#!/usr/bin/env bash

set -euo pipefail

# pnpm's script shorthand forwards its option separator to the script.
if [[ "${1:-}" == "--" ]]; then
  shift
fi

metadata_only=false
if [[ "${1:-}" == "--metadata-only" ]]; then
  metadata_only=true
  shift
fi

if [[ $# != 1 || -d "$1" ]] || ! { exec 3< "$1"; } 2>/dev/null; then
  echo "Commit message could not be read."
  exit 2
fi

if [[ $metadata_only == false ]]; then
  IFS= read -r first_line <&3 || true
  subject='^(feat|fix|docs|test|refactor|perf|build|ci|chore)(\(.+\))?(!)?: .{1,}$'
  if [[ ! "$first_line" =~ $subject ]]; then
    echo "Invalid commit message format."
    echo
    echo "Commit message must follow Conventional Commits:"
    echo "  <type>[optional scope]: <description>"
    echo
    echo "Valid types: feat, fix, docs, test, refactor, perf, build, ci, chore"
    echo
    echo "Examples:"
    echo "  feat(api): add user authentication"
    echo "  fix(ui): resolve button click handler"
    echo "  docs: update README"
    echo
    echo "To skip validation, use: git commit --no-verify"
    exit 1
  fi
fi

trailers='(co-authored-by|signed-off-by|generated-by|made-with|claude-session)[[:blank:]]*:'
signatures='^([^[:alnum:]]|[0-9]+[.)][[:blank:]])*(generated[[:blank:]]+(with|by)|made[[:blank:]]+with)([[:space:][:punct:]]|$)'
# A Markdown backtick alone does not supply a local part. A hostname's final
# label starts with a letter so numeric versions cannot supply the domain.
local_part='([^][[:space:]<>(),;:@`"]+`?|"[^"]*")'
domain_letters=$'[:alpha:]\200-\377'
domain_chars="[:digit:]$domain_letters"
hostname="([$domain_chars][$domain_chars-]*\\.)*[$domain_letters][$domain_chars-]*\\.?"
address="$local_part@($hostname|\\[[^][]+\\])([^$domain_chars._/-]|$)"

# Include the subject already consumed from the descriptor. Let grep drain the
# input so a match cannot hide a read error or cause a broken pipe.
# Separate profile markers from the URL path slash while preserving query text.
if {
  if [[ $metadata_only == false ]]; then
    printf '%s\n' "$first_line"
  fi
  cat <&3 2>/dev/null
} | LC_ALL=C sed -E 's|(https?://[^/?#@[:space:]<>]+(/[^?#@[:space:]<>]*)?)/@|\1/ @|g' 2>/dev/null |
  LC_ALL=C grep -aiE -e "$trailers" -e "$signatures" -e "$address" >/dev/null 2>&1; then
  echo "Commit message contains prohibited attribution metadata."
  exit 1
else
  scan_status=("${PIPESTATUS[@]}")
fi

if [[ ${scan_status[0]} != 0 || ${scan_status[1]} != 0 || ${scan_status[2]} != 1 ]]; then
  echo "Commit message could not be read."
  exit 2
fi

if [[ $metadata_only == false ]]; then
  echo "Commit message format is valid."
fi
