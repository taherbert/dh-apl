#!/bin/bash
# PreCompact Hook — preserve iteration state context before auto-compact
#
# On auto-compact, injects current iteration status into the compact context
# so critical state survives context window compression.

set -euo pipefail

INPUT=$(cat)
TRIGGER=$(echo "$INPUT" | jq -r '.trigger // ""')
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')

# Only intervene on auto-compact (user controls manual compacts)
if [ "$TRIGGER" != "auto" ]; then
  exit 0
fi

[ -n "$CWD" ] && [ "$CWD" != "null" ] && cd "$CWD" 2>/dev/null || exit 0

SPEC="${SPEC:-vengeance}"
CONTEXT=""

# Check for active iteration state
if [ -f "results/$SPEC/theorycraft.db" ] && [ -f "src/sim/iterate.js" ]; then
  STATUS=$(SPEC=$SPEC node src/sim/iterate.js status 2>/dev/null | head -20 || echo "")
  if [ -n "$STATUS" ] && [ "$STATUS" != "No active iteration session." ]; then
    CONTEXT="ACTIVE ITERATION STATE (pre-compact snapshot):\n$STATUS"
  fi
fi

# Include plan summary if it exists
if [ -f "results/$SPEC/plan.md" ]; then
  PLAN=$(head -30 "results/$SPEC/plan.md" 2>/dev/null || echo "")
  if [ -n "$PLAN" ]; then
    CONTEXT="${CONTEXT:+$CONTEXT\n\n}PLAN SUMMARY:\n$PLAN"
  fi
fi

if [ -n "$CONTEXT" ]; then
  CONTEXT="${CONTEXT}\n\nAfter compact: run 'iterate.js status' to verify state, re-read plan.md, and check current.simc."
  jq -n --arg ctx "$CONTEXT" '{
    "hookSpecificOutput": {
      "hookEventName": "PreCompact",
      "additionalContext": $ctx
    }
  }'
else
  echo '{}'
fi

exit 0
