# Autonomous APL Iteration

The `/iterate-apl` system lets Claude autonomously optimize the Vengeance Demon Hunter APL through repeated simulation, hypothesis testing, and incremental improvement.

## What It Does

1. Analyzes the current APL's simulation results across 3 scenarios (1T, 5T, 10T)
2. Generates improvement hypotheses (underused abilities, wasted GCDs, buff gaps, etc.)
3. Makes one targeted APL change per iteration
4. Tests via SimC profileset comparison with tiered statistical fidelity
5. Accepts improvements, rejects regressions, regenerates hypotheses
6. Repeats until improvements are exhausted

## Starting an Overnight Run

```bash
# In Claude Code:
/iterate-apl
```

Claude will initialize state (if needed), read the methodology guide, and begin iterating autonomously. No human input required after launch.

### Prerequisites

- SimC binary built and accessible at the configured path
- `apls/baseline.simc` exists with a valid VDH APL
- `apls/profile.simc` exists with gear/talent profile

## Output Files

| File                           | Description                                     |
| ------------------------------ | ----------------------------------------------- |
| `apls/current.simc`            | The working APL (updated after each accept)     |
| `results/dashboard.md`         | DPS table, session stats, recent iterations     |
| `results/findings.md`          | Significant discoveries (>0.5% weighted delta)  |
| `results/changelog.md`         | Accepted changes in reverse chronological order |
| `results/iteration-state.json` | Full machine-readable state                     |
| `results/iteration-report.md`  | Comprehensive summary (generated on completion) |

## Monitoring Progress

While the iteration loop runs:

- **Read `results/dashboard.md`** for a quick DPS progress overview
- **Run `git log --oneline`** to see committed accepted changes
- **Run `node src/sim/iterate.js status`** for detailed console output

## Stopping and Resuming

The system stops automatically when:

- 10 consecutive rejections with no new hypotheses
- All hypothesis categories exhausted
- SimC repeated failures (3+ crashes)

To resume after a stop or crash:

1. Start a new Claude Code session
2. Run `/iterate-apl` — it detects existing state and resumes

State is persisted with atomic writes and 5 rotating backups. Corruption is auto-recovered.

## Expected Results

- Each accepted change: +0.1% to +0.5% weighted DPS improvement
- Typical session: 10-30 iterations, 3-10 accepted
- Total improvement: 1-3% over a well-tuned baseline
- Diminishing returns after initial gains — threshold sweeps and condition tuning yield the most

## CLI Reference

```bash
node src/sim/iterate.js init apls/baseline.simc   # Initialize
node src/sim/iterate.js status                     # Progress overview
node src/sim/iterate.js hypotheses                 # List improvement ideas
node src/sim/iterate.js compare apls/candidate.simc [--quick|--confirm]
node src/sim/iterate.js accept "reason" [--hypothesis "fragment"]
node src/sim/iterate.js reject "reason" [--hypothesis "fragment"]
node src/sim/iterate.js summary                    # Final report
```
