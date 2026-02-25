---
description: Run the full EP-based gear optimization pipeline — scale factors, EP ranking, proc eval, trinkets, rings, embellishments, gems, enchants — then generate the report. Use after changing gear candidates or when profile.simc needs updating.
argument-hint: "[--through phase<N>] [--quick|--confirm] [--skip-report] [--publish]"
allowed-tools: Bash, Read, Glob, Grep
---

# Gear Optimization Pipeline

Run the full gear optimization pipeline for the active spec, then generate the report dashboard.

## Usage

`/gear [--through phase<N>] [--quick|--confirm] [--skip-report] [--publish]`

Arguments: $ARGUMENTS

## Pipeline Phases

| Phase | Name                 | Method                                                 |
| ----- | -------------------- | ------------------------------------------------------ |
| 0     | Tier configuration   | Sim-based                                              |
| 1     | Scale factors        | Single SimC sim → EP weights saved to session_state    |
| 2     | Stat allocation      | Optimize crafted item stat budgets                     |
| 3     | EP ranking           | Pure math — no sims — for stat-stick items             |
| 4     | Proc evaluation      | Sim proc/effect items vs EP winners                    |
| 5     | Trinkets             | Screen + pair sims                                     |
| 6     | Rings                | Screen + pair sims                                     |
| 7     | Embellishments       | Screen + pair sims                                     |
| 8     | Stat re-optimization | Re-run Phase 2 if embellishments changed crafted slots |
| 9     | Gems                 | EP-ranked, applied to all socketed items               |
| 10    | Enchants             | EP-ranked (cloak/wrist/foot); sim-based (weapon/ring)  |
| 11    | Validation           | Assembled gear sim vs current profile                  |

## Execution

1. Determine spec from `SPEC` env var (default: vengeance).

2. Show current pipeline state:

   ```bash
   SPEC=${SPEC:-vengeance} node src/sim/gear.js status
   ```

3. Parse arguments from `$ARGUMENTS`:
   - `--through phase<N>` — stop after phase N (0–11); omit to run all phases
   - `--quick` — quick fidelity (target_error=1, faster)
   - `--confirm` — confirm fidelity (target_error=0.1, most precise)
   - `--skip-report` — skip report generation after pipeline
   - `--publish` — push report to GitHub Pages after generating

4. Run the pipeline (pass `--through`, `--quick`/`--confirm` if provided):

   ```bash
   SPEC=${SPEC:-vengeance} npm run gear:run -- [--through phaseN] [--quick|--confirm]
   ```

   The pipeline is incremental — phases already stored in the DB are not re-run.

5. Unless `--through` stopped before phase 11, profile.simc is written automatically.
   If the pipeline was stopped early and the profile should be written anyway:

   ```bash
   SPEC=${SPEC:-vengeance} npm run gear:write-profile
   ```

6. Unless `--skip-report`, generate the report from cached results:

   ```bash
   SPEC=${SPEC:-vengeance} npm run report:dashboard -- --skip-sims
   ```

7. If `--publish`:
   ```bash
   SPEC=${SPEC:-vengeance} npm run report:publish
   ```

## After the Pipeline

Show the user:

- Final pipeline state: `SPEC=${SPEC:-vengeance} node src/sim/gear.js status`
- A brief diff of `apls/{spec}/profile.simc` showing what gear changed
- Report location: `results/{spec}/report/index.html`

## Notes

- **Crafted budget:** ≤2 crafted items, ≤2 embellishments — enforced globally in Phase 7
- **Proc-tagged items** in `gear-candidates.json` get sim-based evaluation in Phase 4; all others are EP-ranked in Phase 3
- **Refresh item pools first** if candidates are stale: `SPEC=${SPEC:-vengeance} npm run gear:fetch-candidates`
- **EP weights** (Phase 1) must complete before EP ranking (Phase 3) — they are saved to `gear_scale_factors` in session_state
- **Phase 8** re-runs stat allocation only if embellishments changed which crafted slots are in play
