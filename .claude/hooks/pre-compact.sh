#!/bin/bash
# PreCompact Hook — auto-checkpoint + recovery manifest before context compaction
#
# On auto-compact:
# 1. Runs iterate.js checkpoint to persist full state to DB + file
# 2. Captures orchestrator phase, iteration status, and plan
# 3. Injects a recovery manifest so post-compact context can resume precisely

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
ORCH_PHASE=""
STATUS=""

# Run all iterate.js operations if DB + script are present
if [ -f "results/$SPEC/theorycraft.db" ] && [ -f "src/sim/iterate.js" ]; then
  # 1. Auto-checkpoint (persists to DB + checkpoint.md)
  SPEC=$SPEC node src/sim/iterate.js checkpoint --notes "auto-checkpoint before context compaction" 2>/dev/null || true
  # 2. Capture orchestrator phase
  ORCH_PHASE=$(SPEC=$SPEC node src/sim/iterate.js phase 2>/dev/null || echo "")
  # 3. Capture iteration status (exits 1 with no state, clear STATUS on failure)
  STATUS=$(SPEC=$SPEC node src/sim/iterate.js status 2>/dev/null | head -25) || STATUS=""
fi

# 4. Build recovery manifest
if [ -n "$ORCH_PHASE" ] && [ "$ORCH_PHASE" != "not set" ]; then
  CONTEXT="ORCHESTRATOR PHASE: $ORCH_PHASE"
fi

if [ -n "$STATUS" ]; then
  CONTEXT="${CONTEXT:+$CONTEXT\n\n}ITERATION STATE (auto-checkpointed):\n$STATUS"
fi

# Include checkpoint summary if it exists
if [ -f "results/$SPEC/checkpoint.md" ]; then
  CHECKPOINT=$(head -40 "results/$SPEC/checkpoint.md" 2>/dev/null || echo "")
  if [ -n "$CHECKPOINT" ]; then
    CONTEXT="${CONTEXT:+$CONTEXT\n\n}CHECKPOINT:\n$CHECKPOINT"
  fi
fi

# Include plan summary if it exists
if [ -f "results/$SPEC/plan.md" ]; then
  PLAN=$(head -30 "results/$SPEC/plan.md" 2>/dev/null || echo "")
  if [ -n "$PLAN" ]; then
    CONTEXT="${CONTEXT:+$CONTEXT\n\n}PLAN:\n$PLAN"
  fi
fi

# 5. Add resume instructions
if [ -n "$CONTEXT" ]; then
  RESUME="RESUME PROTOCOL: You are the /optimize orchestrator using the phase-as-subagent architecture."
  RESUME="$RESUME Each phase runs in its own subagent — the main thread stays lean."
  RESUME="$RESUME To resume: (1) run 'iterate.js status' to verify state,"
  RESUME="$RESUME (2) run 'iterate.js phase' to confirm orchestrator phase,"
  RESUME="$RESUME (3) read plan.md and checkpoint.md for context,"
  RESUME="$RESUME (4) launch the appropriate phase subagent to continue."
  RESUME="$RESUME All state is in theorycraft.db. Specialist outputs are in results/{spec}/analysis_*.json."
  RESUME="$RESUME Deep reasoning is in results/{spec}/deep_reasoning.md."
  CONTEXT="${CONTEXT}\n\n${RESUME}"

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
