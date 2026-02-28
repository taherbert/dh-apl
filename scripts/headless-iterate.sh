#!/usr/bin/env bash
set -euo pipefail

# Headless iteration loop: calls claude -p once per hypothesis cycle.
# Each invocation gets a fresh context window, reads all state from SQLite,
# picks one hypothesis, writes a candidate, sims it, and accepts/rejects.
#
# Usage: scripts/headless-iterate.sh [options]
#   --max-iterations N     Stop after N iterations (default: 20)
#   --max-rejections N     Stop after N consecutive rejections (default: 5)
#   --max-budget USD       Per-invocation budget cap (default: 5.00)
#   --dry-run              Print the prompt and flags but don't invoke Claude
#
# Env vars:
#   SPEC                   Spec name (default: vengeance)
#   MAX_ITERATIONS         Same as --max-iterations
#   MAX_REJECTIONS         Same as --max-rejections

SPEC="${SPEC:-vengeance}"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$(cd "$(dirname "$0")/.." && pwd)")"
PROMPT_FILE="$REPO_ROOT/scripts/headless-iterate-prompt.txt"

# Defaults
MAX_ITERATIONS="${MAX_ITERATIONS:-20}"
MAX_REJECTIONS="${MAX_REJECTIONS:-5}"
MAX_BUDGET="5.00"
DRY_RUN=false

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-iterations)
      [[ $# -ge 2 ]] || { echo "Error: --max-iterations requires a value"; exit 1; }
      MAX_ITERATIONS="$2"; shift 2 ;;
    --max-rejections)
      [[ $# -ge 2 ]] || { echo "Error: --max-rejections requires a value"; exit 1; }
      MAX_REJECTIONS="$2"; shift 2 ;;
    --max-budget)
      [[ $# -ge 2 ]] || { echo "Error: --max-budget requires a value"; exit 1; }
      MAX_BUDGET="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "Error: Prompt file not found at $PROMPT_FILE"
  exit 1
fi

# Verify iterate state exists
if ! SPEC="$SPEC" node "$REPO_ROOT/src/sim/iterate.js" status &>/dev/null; then
  echo "Error: No iteration state. Run 'iterate.js init <apl.simc>' first."
  exit 1
fi

# JSON schema for structured output
JSON_SCHEMA='{
  "type": "object",
  "properties": {
    "decision": {
      "type": "string",
      "enum": ["accepted", "rejected", "skipped"]
    },
    "hypothesis_summary": { "type": "string" },
    "mean_weighted_pct": { "type": "number" },
    "reason": { "type": "string" }
  },
  "required": ["decision", "hypothesis_summary", "mean_weighted_pct", "reason"],
  "additionalProperties": false
}'

PROMPT=$(sed "s|{SPEC}|$SPEC|g" "$PROMPT_FILE")

# Allowed tools — scoped for safety:
# - Write only to candidate.simc (cannot touch the main APL or current.simc)
# - No Edit (candidate is written from scratch)
# - No git (outer script handles commits)
ALLOWED_TOOLS=(
  "Bash(SPEC=$SPEC node src/sim/iterate.js *)"
  "Bash(SPEC=$SPEC npm run data:query *)"
  "Bash(npm run data:query *)"
  "Read"
  "Write(/apls/$SPEC/candidate.simc)"
  "Grep"
  "Glob"
)


STDERR_LOG="$REPO_ROOT/results/$SPEC/headless-stderr.log"

# Count pending hypotheses from iterate.js output (first line: "N pending, M rejected (DB):")
pending_count() {
  SPEC="$SPEC" node "$REPO_ROOT/src/sim/iterate.js" hypotheses 2>/dev/null \
    | head -1 | grep -oE '^[0-9]+' || echo "0"
}

echo "============================================"
echo "  Headless APL Iteration"
echo "  Spec: $SPEC"
echo "  Max iterations: $MAX_ITERATIONS"
echo "  Max consecutive rejections: $MAX_REJECTIONS"
echo "  Per-invocation budget: \$$MAX_BUDGET"
echo "============================================"
echo ""

# Show starting state
SPEC="$SPEC" node "$REPO_ROOT/src/sim/iterate.js" status
echo ""

# Counters
iteration=0
consecutive_rejections=0
total_accepted=0
total_rejected=0
total_skipped=0

# Results log
RESULTS_LOG="$REPO_ROOT/results/$SPEC/headless-iteration-log.jsonl"

while true; do
  iteration=$((iteration + 1))

  # Check caps
  if [[ $iteration -gt $MAX_ITERATIONS ]]; then
    echo "Reached max iterations ($MAX_ITERATIONS). Stopping."
    break
  fi

  if [[ $consecutive_rejections -ge $MAX_REJECTIONS ]]; then
    echo "Reached $MAX_REJECTIONS consecutive rejections. Stopping."
    break
  fi

  echo "--- Iteration $iteration / $MAX_ITERATIONS (consec. rejects: $consecutive_rejections / $MAX_REJECTIONS) ---"

  # Check hypothesis queue depth
  PENDING_COUNT=$(pending_count)
  if [[ "$PENDING_COUNT" == "0" ]]; then
    echo "Hypothesis queue empty. Replenishing..."
    SPEC="$SPEC" node "$REPO_ROOT/src/sim/iterate.js" strategic 2>&1 || true
    SPEC="$SPEC" node "$REPO_ROOT/src/sim/iterate.js" theorycraft 2>&1 || true
    SPEC="$SPEC" node "$REPO_ROOT/src/sim/iterate.js" unify 2>&1 || true

    PENDING_COUNT=$(pending_count)
    if [[ "$PENDING_COUNT" == "0" ]]; then
      echo "No hypotheses after replenishment. Stopping."
      break
    fi
    echo "Replenished: $PENDING_COUNT pending hypotheses."
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[DRY RUN] Would invoke claude -p with:"
    echo "  --max-turns 30"
    echo "  --model opus"
    echo "  --max-budget-usd $MAX_BUDGET"
    echo "  --json-schema (structured output)"
    echo "  Prompt: (from $PROMPT_FILE)"
    break
  fi

  # Invoke Claude for one hypothesis cycle
  START_TIME=$(date +%s)
  RESULT=$(claude -p "$PROMPT" \
    --allowedTools "${ALLOWED_TOOLS[@]}" \
    --output-format json \
    --json-schema "$JSON_SCHEMA" \
    --max-turns 30 \
    --max-budget-usd "$MAX_BUDGET" \
    --model opus \
    --append-system-prompt "Spec is $SPEC. Working directory is $REPO_ROOT. All state in results/$SPEC/theorycraft.db. Follow CLAUDE.md APL conventions." \
    2>"$STDERR_LOG") || {
    echo "Warning: claude invocation failed (exit $?)."
    [[ -s "$STDERR_LOG" ]] && echo "stderr:" && cat "$STDERR_LOG"
    echo "Stopping."
    break
  }
  END_TIME=$(date +%s)
  ELAPSED=$((END_TIME - START_TIME))

  # Parse structured output from the JSON envelope (.structured_output field)
  DECISION=$(echo "$RESULT" | jq -r '.structured_output.decision // "error"')
  HYPOTHESIS=$(echo "$RESULT" | jq -r '.structured_output.hypothesis_summary // "unknown"')
  MEAN_PCT=$(echo "$RESULT" | jq -r '.structured_output.mean_weighted_pct // 0')
  REASON=$(echo "$RESULT" | jq -r '.structured_output.reason // "no reason"')

  # Log to JSONL (use jq for safe JSON construction)
  jq -nc \
    --argjson iter "$iteration" \
    --arg dec "$DECISION" \
    --arg hyp "$HYPOTHESIS" \
    --argjson pct "${MEAN_PCT:-0}" \
    --arg rsn "$REASON" \
    --argjson elapsed "$ELAPSED" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{iteration:$iter,decision:$dec,hypothesis:$hyp,mean_weighted_pct:$pct,reason:$rsn,elapsed_s:$elapsed,timestamp:$ts}' \
    >> "$RESULTS_LOG"

  # Print summary
  case "$DECISION" in
    accepted)
      total_accepted=$((total_accepted + 1))
      consecutive_rejections=0
      echo "  ACCEPTED ($MEAN_PCT%): $HYPOTHESIS"
      echo "  Reason: $REASON"
      ;;
    rejected)
      total_rejected=$((total_rejected + 1))
      consecutive_rejections=$((consecutive_rejections + 1))
      echo "  REJECTED ($MEAN_PCT%): $HYPOTHESIS"
      echo "  Reason: $REASON"
      ;;
    skipped)
      total_skipped=$((total_skipped + 1))
      consecutive_rejections=0
      echo "  SKIPPED: $REASON"
      if [[ "$REASON" == *"no pending"* ]]; then
        echo "Queue exhausted. Stopping."
        break
      fi
      ;;
    *)
      echo "  ERROR: Unexpected decision '$DECISION'. Stopping."
      echo "  Raw output: $(echo "$RESULT" | jq -c '.structured_output // .result // "null"')"
      break
      ;;
  esac
  echo "  (${ELAPSED}s)"
  echo ""
done

echo ""
echo "============================================"
echo "  Iteration Summary"
echo "  Total: $((total_accepted + total_rejected + total_skipped)) iterations"
echo "  Accepted: $total_accepted"
echo "  Rejected: $total_rejected"
echo "  Skipped: $total_skipped"
echo "============================================"

# Show final state
echo ""
SPEC="$SPEC" node "$REPO_ROOT/src/sim/iterate.js" status

if [[ -f "$RESULTS_LOG" ]]; then
  echo ""
  echo "Full log: $RESULTS_LOG"
fi
