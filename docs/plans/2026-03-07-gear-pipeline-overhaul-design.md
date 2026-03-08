# Gear Pipeline Overhaul

## Problem

The gear pipeline produces ~5% worse gear than Raidbots Top Gear. Root causes:

1. **EP self-reinforcing bias** — Scale factors computed at current gear point lock the pipeline into a local stat optimum (Haste/Vers) instead of the global one (Crit/Mastery). The pipeline already computes `gear_stat_curves` (DPS plot data) but never uses them.
2. **Gem diversity unmodeled** — Eversong Diamond grants +0.15% crit effectiveness per unique Midnight gem color, but is scored as just 23 agi. Pipeline picks one gem type and fills all sockets.
3. **Missing data** — No `back` slot candidates, no foot/cloak/shoulder enchants, missing `vers_mastery` crafted stat pair.
4. **ST-only, single-build scale factors** — Scale factors computed for one scenario and one build, but used for multi-scenario weighted ranking across all builds.

## Approach: Iterative EP Reweighting + Combinatorial Validation

Keep the EP-based architecture but fix the bias via iterative reweighting, add a combinatorial validation phase for stat synergies, and fix data gaps.

## Changes

### 1. Iterative EP Reweighting (Phase 1b) — HIGH

After Phase 1 computes scale factors and stat curves:

- EP-rank all items using current scale factors
- Compute total stat budget of EP-selected gear
- Look up DPS derivatives at that stat point from `gear_stat_curves` (interpolate between plotted points)
- Recompute EP weights from interpolated derivatives
- Re-rank items with new weights
- Repeat until item selection stabilizes (max 5 iterations)
- Store converged scale factors as authoritative EP weights

Key file: `src/sim/gear.js` — new function after `cmdScaleFactors`, called from `cmdEpRank`.

### 2. Combinatorial Validation Phase (Phase 3b) — HIGH

After EP ranking stabilizes:

- Take top-2 candidates per EP-ranked slot (~8 slots)
- Generate all combinations (~2^8 = 256)
- Sim via profileset across all 4 scenarios using representative builds
- Pick the globally best combination
- Store as Phase 3b results; assembly uses these over Phase 3 EP results

Key file: `src/sim/gear.js` — new `cmdCombinatorialValidation` function.

### 3. Gem Diversity Optimization (Phase 9 rewrite) — HIGH

Replace pure EP gem ranking with sim-based evaluation:

- Model Eversong Diamond crit effectiveness bonus as function of unique gem color count
- Generate candidate configurations: all-same for each color, max-diversity with Eversong Diamond
- Sim top 3-4 configurations via profileset (small cost: ~4 x 4 scenarios)
- Pick best configuration

Key file: `src/sim/gear.js` `cmdGems` function.

### 4. Data Completeness — MODERATE

In `data/havoc/gear-candidates.json`:

- Add `back` slot with all available cloaks from Raidbots candidate pool
- Add `foot`, `cloak`, `shoulder` enchant sections
- Add `vers_mastery` crafted stat pair (`"crafted_stats": "40/49"`) to `CRAFTED_STAT_PAIRS`
- Ensure all item simc strings include proper `bonus_id` for Myth track

### 5. Multi-Scenario Scale Factors (Phase 1 enhancement) — MODERATE

- Run scale factor sim for each scenario (ST, dungeon_route, small_aoe, big_aoe)
- Combine using `SCENARIO_WEIGHTS` to get weighted EP values
- Pass weighted scale factors to all downstream phases

Increases Phase 1 sim cost by 4x but ensures EP reflects full content mix.

### 6. Multi-Build Scale Factors (Phase 1 enhancement) — LOW

- Use top 3 roster builds (covering both hero trees) instead of roster[0]
- Average scale factors across builds
- Prevents gear optimization for one talent config only

## Implementation Order

1. Data completeness fixes (Phase 4 prerequisite, no code risk)
2. Multi-scenario scale factors (Phase 1)
3. Iterative EP reweighting (Phase 1b)
4. Combinatorial validation (Phase 3b)
5. Gem diversity (Phase 9)
6. Multi-build scale factors (Phase 1, lowest priority)

## Validation

After implementing, run the full gear pipeline on havoc and compare:

- Assembled profile DPS vs current Raidbots reference profile (101k ST target)
- Stat distribution should converge toward Crit/Mastery, away from Haste/Vers
- Gem selection should include diverse Midnight colors with Eversong Diamond
- Phase 11 validation should show parity or improvement vs baseline

## Files Modified

- `src/sim/gear.js` — Phases 1, 1b (new), 3b (new), 9 rewrite
- `data/havoc/gear-candidates.json` — back slot, enchant sections, bonus_ids
- `data/havoc/gear-config.json` — if tier alternatives need updating
