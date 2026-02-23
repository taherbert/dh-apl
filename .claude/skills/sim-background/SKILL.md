---
description: Fire-and-forget sim launch. Writes a state checkpoint, runs the sim in background, returns immediately. Use /sim-check to poll results.
argument-hint: "[candidate-path] [--quick|--confirm] [-- hypothesis description]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

Launch a background simulation with a state checkpoint so context compaction or new sessions can recover seamlessly.

## Setup

Run `node src/engine/startup-cli.js` to determine the active spec.

## Parse Arguments

From `$ARGUMENTS`, extract:

- **Candidate path** — file path ending in `.simc`. Default: `apls/{spec}/candidate.simc`
- **Fidelity flag** — `--quick` or `--confirm` if present. Default: omit (staged mode)
- **Hypothesis description** — anything after `--` or remaining text. If absent, infer from conversation context (what change was just made and why)

## Write State Checkpoint

Before launching the sim, write `results/{spec}/active-sim.json` using the Write tool:

```json
{
  "timestamp": "<ISO 8601>",
  "taskId": null,
  "candidate": "<candidate path>",
  "fidelity": "<quick|standard|confirm|staged>",
  "hypothesis": "<1-2 sentence description of what's being tested and why>",
  "expectedOutcome": "<predicted direction and reasoning>",
  "spec": "<spec name>"
}
```

**Hypothesis and expectedOutcome are critical.** These are what make recovery after context compaction instant — without them, Claude has to re-derive intent from scratch. Be specific: "Lowering Spirit Bomb threshold from 4 to 3 fragments during Meta should improve fury efficiency for Fiery Demise builds" is good. "Testing a change" is useless.

## Launch Background Sim

Run the `iterate.js compare` command with `run_in_background: true`:

```bash
SPEC={spec} node src/sim/iterate.js compare {candidate_path} {fidelity_flag}
```

Capture the task ID from the Bash tool response.

## Update Checkpoint with Task ID

Read the checkpoint file you just wrote, then Edit it to set the `taskId` field to the actual task ID string returned by the background Bash call.

## Report to User

Tell the user:

- What hypothesis is being tested
- What fidelity level
- That they can use `/sim-check` to poll results or do other work in the meantime
- The candidate file path for reference

Do NOT wait for the sim to finish. Return immediately after updating the checkpoint.
