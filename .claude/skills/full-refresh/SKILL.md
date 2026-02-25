---
description: Full end-to-end refresh — simc update, data pipeline, roster, gear pipeline with sims, and report. Run after game patches or simc updates.
argument-hint: "[--publish] [--quick] [--skip-simc] [--skip-gear]"
allowed-tools: Bash, Read, Glob, Grep
---

# Full Refresh

Runs: simc binary update → data pipeline → roster rebuild → gear pipeline → report generation.

## Arguments

`$ARGUMENTS`

- `--publish` — push report to GitHub Pages after generating
- `--quick` — quick fidelity for gear sims (faster, less precise); default is standard
- `--skip-simc` — skip simc binary update and data pipeline (use when only gear candidates changed)
- `--skip-gear` — skip gear pipeline and profile rebuild (data refresh only)

---

## Step 0: Pre-flight

Read current state before making any changes:

```bash
node src/engine/startup-cli.js
SPEC=vengeance npm run db:status
```

Read `reference/.refresh-metadata.json` and note the current `simc.commit` short hash and `refreshed_at`. You will compare at the end to summarize what changed.

Check for in-progress iteration:

```bash
SPEC=vengeance node src/sim/iterate.js status
```

If an active iteration exists, note it but do not block — a data refresh does not invalidate iteration state. Mention it in the final summary.

---

## Step 1: Remote EC2

Read `config.local.json` for the presence of a `remote` block (keys: `host`, `instanceId`, or `keyPath`). If remote is configured AND `--skip-gear` is not set:

```bash
npm run remote:status
```

If stopped, start it now so the instance is warm before gear sims begin:

```bash
npm run remote:start
```

Standard/confirm fidelity sims auto-route to remote when active. Quick sims always run locally.

---

## Step 2: simc + Data Refresh

Skip this step if `--skip-simc` was passed.

```bash
SPEC=vengeance npm run refresh
```

This runs in sequence:

- `git pull` + rebuild simc binary (`midnight` branch, all CPU cores)
- Extract reference APL from C++ source
- Sync wiki docs
- Extract SimC C++ talent variables and proc data
- Regenerate SpellDataDump
- Full data pipeline: Raidbots talent fetch → spell extraction → talents → cpp-interactions → cpp-effects → cpp-procs → interactions → text report → graph → effects-gap → context summaries
- `npm run verify` (failures logged but don't abort)
- Write `reference/.refresh-metadata.json`

**Verify gate:** After refresh completes, check verify output. Pre-existing failures ("null target IDs on non-buff targets", "2 null target IDs") are noise — ignore them. Any NEW failures (missing spell IDs, unknown abilities, broken talent nodes) must be investigated before continuing to the gear pipeline.

**Nothing changed:** If `git diff --stat` shows minimal changes, simc and Raidbots were already current. That is expected — continue.

---

## Step 3: Roster

Talent data may have changed. Rebuild the full cluster-based roster:

```bash
SPEC=vengeance npm run roster generate
SPEC=vengeance npm run roster validate
SPEC=vengeance npm run roster show
```

**Validation gate:** If any builds fail validation (invalid talent hashes, gate requirement failures), stop and fix them before continuing. An invalid roster produces silently wrong gear sim results.

Regenerate display names:

```bash
SPEC=vengeance npm run roster generate-names
```

Refresh the SimC default APL comparison build. After a simc update the default APL may have changed — this ensures report comparisons are current:

```bash
SPEC=vengeance npm run roster import-baseline
```

---

## Step 4: Gear Candidates

Refresh item data from Raidbots (picks up new gear, stat changes, new items):

```bash
SPEC=vengeance npm run gear:fetch-candidates
```

---

## Step 5: Gear Pipeline

Skip this step if `--skip-gear` was passed.

```bash
SPEC=vengeance npm run gear:run [--quick if --quick was passed]
```

Runs all 12 phases (0–11). Standard fidelity by default. Writes `apls/vengeance/profile.simc` on completion.

| Phase | What it does                                        |
| ----- | --------------------------------------------------- |
| 0     | Tier set configuration (sim)                        |
| 1     | Scale factors → EP weights                          |
| 2     | Crafted item stat budget optimization               |
| 3     | EP-rank stat-stick items (no sims)                  |
| 4     | Proc/effect item evaluation (sim)                   |
| 5     | Trinket screen + pair sims                          |
| 6     | Ring screen + pair sims                             |
| 7     | Embellishment sims                                  |
| 8     | Stat re-opt if embellishments changed crafted slots |
| 9     | Gem selection (EP-ranked)                           |
| 10    | Enchant selection (EP-ranked + weapon/ring sims)    |
| 11    | Full-roster validation sim                          |

**On phase failure:** Run `SPEC=vengeance npm run gear:status` to see which phase errored. Fix the issue and re-run — the pipeline is incremental and resumes from where it failed. If Phase 1 (scale factors) failed, all downstream EP rankings are invalid — it must complete successfully.

---

## Step 6: Report

Run the full build benchmark and generate the HTML dashboard. This sims all roster builds with the current APL at standard fidelity via profileset mode:

```bash
SPEC=vengeance npm run report:dashboard
```

Writes `results/vengeance/report/index.html`. The report includes:

- Build rankings (all roster builds, all scenarios)
- Hero tree comparison
- Trinket rankings (gear phase 5 results)
- Ring rankings (gear phase 6 results)
- Embellishment rankings (gear phase 7 results)
- Talent impact (cluster costs, defensive policy)
- Optimization history (accepted iterations)

If `--publish` was passed:

```bash
SPEC=vengeance npm run report:publish
```

Pushes to the `gh-pages` branch. Report will be live at https://taherbert.github.io/dh-apl/

---

## Step 7: Stop Remote

If remote was started in Step 1:

```bash
npm run remote:stop
```

---

## Step 8: Commit

Stage all tracked files that changed:

```bash
git add data/vengeance/ reference/ apls/vengeance/profile.simc apls/vengeance/baseline.simc
git diff --stat HEAD
```

Do NOT `git add -f` anything in `results/` — that directory is gitignored.

Read the new `simc.commit` from `reference/.refresh-metadata.json`. Commit message format:

```
refresh: simc <new-hash>, <data.env> — gear + report updated
```

If simc did not change (same commit), use:

```
refresh: data + gear rebuild (<data.env>)
```

---

## Final Summary

Report to the user:

- **simc:** old commit → new commit (or "no change, already current")
- **Data:** which files changed (talents, spells, interactions — with counts if available)
- **Roster:** N builds total, any validation issues, baseline imported
- **Gear:** phase completion, notable winners (best trinket pair, rings, embellishments)
- **profile.simc:** what gear changed (brief `git diff apls/vengeance/profile.simc`)
- **Report:** path to `results/vengeance/report/index.html` and publish URL if applicable
