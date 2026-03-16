---
description: Run the constraint-based gear optimization pipeline -- component sims, constraint solver, full-set validation, profile assembly. Use after changing gear candidates or when profile.simc needs updating.
argument-hint: "[--through phase<N>] [--quick|--confirm] [--reset] [--from phase<N>] [--skip-report] [--publish]"
allowed-tools: Bash, Read, Glob, Grep
---

# Gear Optimization Pipeline

Run the full gear optimization pipeline for the active spec, then generate the report dashboard.

## Usage

`/gear [--through phase<N>] [--quick|--confirm] [--reset] [--from phase<N>] [--skip-report] [--publish]`

Arguments: $ARGUMENTS

## Pipeline Phases

| Phase | Name                | Method                                                      |
| ----- | ------------------- | ----------------------------------------------------------- |
| 0     | Tier configuration  | Sim which tier slot to skip (4-of-5)                        |
| 1     | Scale factors       | EP weights + iterative reweighting + EP ranking             |
| 2a    | Embellishments      | Sim all embellishment pairs                                 |
| 2b    | Effect items        | Sim proc/on-use items (weapons)                             |
| 2c    | Mini-sets           | Sim mini-set pairs and individual pieces                    |
| 2d    | Trinket screen      | Screen individual trinket candidates                        |
| 3     | Constraint solver   | Enumerate valid 16-slot gear sets (gear-solver.js)          |
| 4     | Full-set validation | Sim top 10 complete sets from solver                        |
| 5a    | Trinket pairs       | Pair trinkets against winning gear set                      |
| 5b    | Cross-validation    | Trinket x embellishment cross-check                         |
| 6a    | Emb re-check        | Re-sim embs against winning set                             |
| 6b    | EP re-check         | Re-derive scale factors from winning set                    |
| 7a    | Gems                | EP-ranked, applied to all socketed items                    |
| 7b    | Enchants            | EP-ranked (stat); sim-based (weapon/ring)                   |
| 7c    | Final validation    | Assembled gear sim vs current profile at high fidelity      |
| 8     | Write profile       | Generate profile.simc from scratch (gear-profile-writer.js) |

## Execution

1. Determine spec from `SPEC` env var (default: vengeance).

   Start the remote sim instance before running -- most phases run sims:

   ```bash
   npm run remote:status
   ```

   If not active, start it (do not wait for user confirmation):

   ```bash
   npm run remote:start
   ```

2. Show current pipeline state:

   ```bash
   SPEC=${SPEC:-vengeance} node src/sim/gear.js status
   ```

3. Parse arguments from `$ARGUMENTS`:
   - `--through phase<N>` -- stop after phase N (0-8); omit to run all phases
   - `--from phase<N>` -- start from phase N (skip earlier phases)
   - `--reset` -- clear all gear results and start fresh
   - `--quick` -- quick fidelity (target_error=1, faster)
   - `--confirm` -- confirm fidelity (target_error=0.1, most precise)
   - `--skip-report` -- skip report generation after pipeline
   - `--publish` -- push report to GitHub Pages after generating

4. Run the pipeline:

   ```bash
   SPEC=${SPEC:-vengeance} npm run gear:run -- [--through phaseN] [--from phaseN] [--reset] [--quick|--confirm]
   ```

   The pipeline is incremental -- phases already stored in the DB are not re-run.
   Use `--reset` to clear all state and start fresh, or `--from phaseN` to resume.

5. Unless `--through` stopped before phase 8, profile.simc is written automatically
   after passing verification (gem counts, emb count = 2, crafted count <= 2).

6. Unless `--skip-report`, generate the report from cached results:

   ```bash
   SPEC=${SPEC:-vengeance} npm run report:dashboard -- --skip-sims
   ```

7. If `--publish`:
   ```bash
   SPEC=${SPEC:-vengeance} npm run report:publish
   ```

## After the Pipeline — MANDATORY VERIFICATION

You MUST verify the profile before showing results to the user. Do NOT skip this.

1. **Diff the profile**: `git diff apls/{spec}/profile.simc`
2. **Check every slot** against `data/{spec}/gear-candidates.json`:
   - Each item name must match its item ID in gear-candidates
   - Gem count per item must match socket count in gear-candidates (1 gem_id = 1 socket, NOT `gem_id=X/Y` unless gear-candidates shows 2 sockets)
   - No `embellishment=X` on items in `builtInItems` (they already count toward the 2-emb cap)
   - Total embellishments (explicit + built-in) must equal exactly 2
   - Crafted items (bonus_id=8793) count must be <= 2
3. **Verify DPS**: Run a quick single-profile sim and confirm DPS is in the expected range (60-80k ST for VDH)
4. **If ANY check fails**: Do NOT publish. Fix the issue or report it to the user.

Show the user:

- Final pipeline state: `SPEC=${SPEC:-vengeance} node src/sim/gear.js status`
- A brief diff of `apls/{spec}/profile.simc` showing what gear changed
- Verification results from the checks above
- Report location: `results/{spec}/report/index.html`

## Architecture

The pipeline has three new core modules:

- **`gear-solver.js`** -- Constraint solver. Enumerates valid 16-slot gear sets from component sim results + EP scores. Enforces: 4 tier pieces, 2 embellishments, <=2 crafted, unique-equip, ring dedup. Pure function, no I/O.
- **`gear-profile-writer.js`** -- Profile assembly. Generates profile.simc from scratch using gear-candidates.json as sole source of truth. Includes verification checks.
- **`gear.js`** -- Pipeline orchestration. Calls existing sim infrastructure, collects results into solver input, runs solver, validates, writes profile.

## Notes

- **Crafted budget:** <=2 crafted items, <=2 embellishments -- enforced by the constraint solver
- **Deterministic:** Same gear-candidates.json + same sim results = same output. No old-profile inheritance.
- **Profile from scratch:** gear-profile-writer.js generates all gear lines. Old profile provides only the preamble (talents, flask, food, overrides).
- **Refresh item pools first** if candidates are stale: `SPEC=${SPEC:-vengeance} npm run gear:fetch-candidates`
- **Legacy pipeline:** `run-legacy` CLI command runs the old sequential pipeline for comparison
