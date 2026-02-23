---
description: Check on a background sim launched by /sim-background. Shows progress or presents results with accept/reject recommendation.
argument-hint: "[--wait]"
allowed-tools: Bash, Read, Glob, Grep, Task
---

Check the status of a background simulation launched by `/sim-background`. If the sim is done, present results and recommend accept/reject. If still running, report what's being tested.

## Setup

Run `node src/engine/startup-cli.js` to determine the active spec.

## Read Checkpoint

Read `results/{spec}/active-sim.json`. If the file doesn't exist, fall back:

1. Run `SPEC={spec} node src/sim/iterate.js status` and report the current iteration state
2. Tell the user no background sim is tracked — they can use `/sim-background` to launch one

If the checkpoint exists, report the hypothesis and expected outcome to restore context.

## Check Task Status

Use the TaskOutput tool with `block: false` to check the background task:

```
TaskOutput(task_id=<checkpoint.taskId>, block=false, timeout=5000)
```

### If still running

Report to the user:

- **Testing:** the hypothesis from the checkpoint
- **Candidate:** the file path
- **Fidelity:** the level
- **Started:** how long ago (from checkpoint timestamp)

If `$ARGUMENTS` contains `--wait`, use `TaskOutput` with `block: true, timeout: 600000` (10 min) to wait for completion, then proceed to the "If complete" section below.

Otherwise, remind the user they can run `/sim-check` again later or `/sim-check --wait` to block until done.

### If complete

Read the full output from the TaskOutput result. Parse the sim results:

1. **Per-build table** — show the full build-by-build breakdown
2. **Aggregate metrics** — mean weighted, worst build, hero tree averages
3. **Accept criteria** — mean > 0 AND worst > -1%
4. **Recommendation** — ACCEPT, REJECT, or GATE (if mixed results suggest build-specific branching)

For mixed results (some builds gain, others regress), briefly note which discriminator axes might explain the split (hero tree, apex rank, cluster). Don't do full Partial Gains Protocol analysis — just flag the pattern for the user.

### If task not found

The task ID may be stale (from a previous session). Report:

- The hypothesis that was being tested (from checkpoint)
- That the task is no longer tracked
- Suggest running `SPEC={spec} node src/sim/iterate.js status` to check if results were already accepted/rejected
- Suggest re-running the sim with `/sim-background` if needed

## Cleanup

After presenting completed results, do NOT delete the checkpoint — leave it for reference. It will be overwritten by the next `/sim-background` call.
