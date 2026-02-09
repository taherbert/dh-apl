#!/bin/bash
# Pre-simulation sanity check.
# Verifies SPEC is set and config files exist before running sims.
# Catches worktree config bleed before it wastes a sim run.

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')

# Only check simulation-related commands
if ! echo "$COMMAND" | grep -qE '(node src/sim/|npm run (sim|discover|roster)|iterate\.js|runner\.js|build-roster\.js|build-discovery\.js)'; then
  exit 0
fi

# Extract SPEC from the command itself (SPEC=xxx prefix) or fall back to env
SPEC_FROM_CMD=$(echo "$COMMAND" | sed -n 's/.*SPEC=\([a-zA-Z_]*\).*/\1/p')
ACTIVE_SPEC="${SPEC_FROM_CMD:-$SPEC}"

if [ -z "$ACTIVE_SPEC" ]; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: "WARNING: No SPEC environment variable detected for this simulation command. Set SPEC=<spec> to avoid running against the wrong spec. This has caused worktree config bleed in the past."
    }
  }'
  exit 0
fi

# Verify per-spec config file exists
SPEC_CONFIG="${CWD}/config.${ACTIVE_SPEC}.json"
if [ ! -f "$SPEC_CONFIG" ]; then
  jq -n --arg spec "$ACTIVE_SPEC" --arg path "$SPEC_CONFIG" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: ("WARNING: config." + $spec + ".json not found at " + $path + ". Is this the right spec/worktree?")
    }
  }'
  exit 0
fi

exit 0
