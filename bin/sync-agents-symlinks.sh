#!/usr/bin/env bash
set -euo pipefail

# Run from repository root regardless of current working directory.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

created=0
updated=0
skipped=0

while IFS= read -r claude_path; do
  dir="$(dirname "$claude_path")"
  agent_path="$dir/AGENTS.md"
  desired_target="CLAUDE.md"

  if [ -L "$agent_path" ]; then
    current_target="$(readlink "$agent_path")"
    if [ "$current_target" = "$desired_target" ]; then
      skipped=$((skipped + 1))
      continue
    fi

    ln -sfn "$desired_target" "$agent_path"
    updated=$((updated + 1))
    echo "UPDATED $agent_path -> $desired_target"
    continue
  fi

  if [ -e "$agent_path" ]; then
    skipped=$((skipped + 1))
    echo "SKIPPED $agent_path (exists and is not a symlink)"
    continue
  fi

  ln -s "$desired_target" "$agent_path"
  created=$((created + 1))
  echo "CREATED $agent_path -> $desired_target"
done < <(rg --files -g '**/CLAUDE.md')

echo "Done. created=$created updated=$updated skipped=$skipped"
