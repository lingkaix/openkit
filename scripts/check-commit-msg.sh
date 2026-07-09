#!/usr/bin/env bash

set -euo pipefail

commit_msg_file=${1:?commit message file is required}
IFS= read -r first_line < "$commit_msg_file"

pattern='^(feat|fix|docs|test|refactor|perf|build|ci|chore)(\(.+\))?(!)?: .{1,}$'

if [[ ! "$first_line" =~ $pattern ]]; then
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

echo "Commit message format is valid."
