# CLAUDE.md

## Project

Multi-spec SimulationCraft APL framework for World of Warcraft. Currently targeting **Vengeance Demon Hunter** (tank spec).

## Domain Context

- **Multi-spec architecture:** Spec is selected via `--spec <name>` CLI flag or `SPEC` env var. Global settings live in `config.json`, per-spec overrides in `config.{spec}.json` (deep-merged at runtime). Per-spec data: `data/{spec}/`, `results/{spec}/`, `apls/{spec}/`. The spec adapter (`src/spec/{spec}.js`) provides all spec-specific knowledge via `SPEC_CONFIG`.
- **DPS only.** Optimize exclusively for damage output. Defensives maintained for SimC realism but never at the expense of DPS.
- Never hardcode ability names in analysis modules — read from `getSpecAdapter().getSpecConfig()`.

## SimC APL Syntax Reference

```
actions=auto_attack
actions+=/ability_name,if=condition1&condition2
actions+=/run_action_list,name=sub_list,if=condition
actions+=/call_action_list,name=sub_list,if=condition
```

Common condition expressions: `fury>=30`, `soul_fragments>=4`, `buff.demon_spikes.up`, `talent.spirit_bomb.enabled`, `cooldown.fiery_brand.ready`, `health.pct<50`, `active_enemies>=3`.

**Min/Max operators (CRITICAL — do not confuse):**

- `<?` is the **MAX** operator: `x<?y` = the **greater** of x and y. Example: `(deficit)<?0` = max(deficit, 0) = clamp non-negative.
- `>?` is the **MIN** operator: `x>?y` = the **lesser** of x and y. Example: `(time_a)>?(time_b)` = min(time_a, time_b) = take the shorter.

**Apex talents:** Apex talents (pinnacle talents at the bottom of the tree) use `apex.N` where N is the rank number (e.g., `apex.1`, `apex.2`). Do NOT use `talent.apex_name` — always use the `apex.N` syntax.

**Variable `op=ceil`/`op=floor` gotcha:** These operations apply to the variable's current value, NOT the `value=` expression. `variable,name=X,op=ceil,value=expr` ignores `expr`. Must split into two lines: `variable,name=X,value=expr` then `variable,name=X,op=ceil`.

**APL variables:** Use `variable,name=X,value=expr` to extract shared logic out of action conditions. Variables keep action statements focused on "what to cast" while variables handle "is the situation right." If a condition or sub-expression appears in more than one action line, it should be a variable. Computed state (target counts, resource thresholds, buff windows, talent-dependent flags) belongs in variables — not duplicated inline across action conditions.

**Action list delegation:** Two mechanisms with different control flow:

- **`run_action_list,name=X`** — Swaps the active list to `X`; remaining caller actions are skipped. Use for mutually exclusive branches (e.g., hero tree routing).
- **`call_action_list,name=X`** — Evaluates `X` inline; if nothing fires, falls through to next caller line. Use for optional sub-routines and shared logic.

**Multi-file structure:** `input=<filename>` includes one file from another (paths relative to CWD). APL files use `input=apls/{spec}/profile.simc` for the shared character setup. `resolveInputDirectives()` in `profilesets.js` inlines these for self-contained profileset output.

## Session Protocol

1. Run `node src/engine/startup-cli.js` to check config and simc sync status
2. Run `npm run db:status` to check theorycraft DB contents

## Data File Selection

**Prefer targeted queries over reading full files.** Use `npm run data:query` for specific lookups:

```bash
npm run data:query -- spell "soul cleave"        # Spell by name (fuzzy) or ID
npm run data:query -- talent "spirit bomb"        # Talent node by name or ID
npm run data:query -- interaction "fiery brand"   # Interactions for a spell
npm run data:query -- search "soul fragment"      # Full-text search across all data
```

Only read summary files directly when broad analysis is needed (e.g., building a full ability inventory):

- **`spells-summary.json`** (~57KB): id, name, school, resource, cooldown, charges, duration, GCD, AoE radius, generates, resolved descriptions.
- **`interactions-summary.json`** (~329KB): `bySpell`, `byTalent`, `talentCategories`, `bySetBonus` views with magnitude, proc info, application type. **Avoid reading this file in full — use `data:query interaction` instead.**
- **`talents.json`** (~91KB): Talent tree definitions.

Only read the full files (`spells.json` 548KB, `interactions.json` 1.4MB) when you need raw spell effect data (coefficients, effect subtypes). For a specific spell, use `Grep` on the full file rather than reading it entirely.

## Persistence — DB-First Architecture

All mutable state lives in **`results/{spec}/theorycraft.db`** (SQLite). JSON files are only extraction pipeline outputs, not mutable state. Key tables: builds, archetypes, factors, synergies, findings, hypotheses, iterations, session_state, talent_clusters, cluster_synergies, tension_points.

Use `npm run db:status` to check DB contents. Use `npm run db:dump` for formatted summary.

## Gear Optimization Pipeline

Gear optimization is **separate from APL optimization** and uses a constraint-based pipeline (`src/sim/gear.js`). It sims components (embellishments, weapons, trinkets, mini-sets), feeds results + EP into a constraint solver (`src/sim/gear-solver.js`) that enumerates valid full gear sets, validates top candidates, and writes the profile from scratch (`src/sim/gear-profile-writer.js`).

Key files: `data/{spec}/gear-candidates.json` (item pools + enchants + gems) and `apls/{spec}/profile.simc` (assembled output). The pipeline writes results to session_state and gear_results in the DB.

Use the **`/gear`** skill to run the full pipeline and regenerate the report. Use `npm run gear:status` to inspect pipeline progress. See REFERENCE.md for all individual phase commands.

**Constraint solver:** `gear-solver.js` enumerates valid 16-slot gear sets subject to hard constraints: exactly 4 tier pieces (from 5 possible), exactly 2 embellishments, at most 2 crafted items, unique-equip restrictions, ring dedup. Scores by summing component sim DPS + EP. Returns top 10 configurations for validation.

**Profile writer:** `gear-profile-writer.js` generates profile.simc from scratch using gear-candidates.json as sole source of truth. Old profile provides only the preamble (talents, consumables, overrides). Includes verification: gem counts match socket counts, emb count = 2, crafted count <= 2.

**Stat ID mapping (WoW ItemStatType):** 32=Crit, 36=Haste, 40=Vers, 49=Mastery. Note that 35 is NOT haste (it's resilience, removed in WoD). Wrong stat IDs silently corrupt all downstream EP/ranking data.

**Embellishment stacking:** Items with built-in embellishments (e.g. crafted items that already have an emb effect) cannot have `embellishment=X` applied -- they already count toward the 2-emb cap. The `builtInItems` array in `gear-config.json` excludes these from the regular crafted pool.

**Pipeline resume flags:** `npm run gear:run -- --reset` clears all gear results and starts fresh. `--from phase<N>` starts from phase N. `--through phase<N>` stops after phase N.

**Profile verification (MANDATORY after every gear run):** The profile writer verifies output automatically. After every run, check: (1) each item's gem count matches gear-candidates.json socket count, (2) total embellishments = 2 (explicit + built-in), (3) total crafted <= 2, (4) DPS sanity check via quick single-profile sim (VDH should be 60-80k ST).

## Key Paths

- **SimC source:** `/Users/tom/Documents/GitHub/simc` (branch: `midnight`)
- **SimC binary:** `bin/simc` (local copy) or `<simc dir>/engine/simc`

Targeting **Midnight** expansion. The simc `midnight` branch may have new abilities or mechanic reworks vs TWW.

## Commands

All commands require a spec. Use `SPEC=vengeance` env var or `--spec vengeance` flag.

See **[REFERENCE.md](REFERENCE.md)** for the complete command list, architecture diagram, data sources, and other reference material. **Talent build rules are MANDATORY** — consult REFERENCE.md before generating or modifying builds.

Key commands:

```bash
# Data pipeline
npm run build-data                           # Run full data pipeline
npm run discover -- --quick                  # Build discovery (~2-5 min)
npm run roster generate                      # Generate cluster-based roster
npm run roster show                          # Show roster with validation
npm run db:status                            # Show DB record counts

# APL iteration
node src/sim/iterate.js status               # Iteration state
node src/sim/iterate.js compare <candidate>  # Test candidate APL

# Gear optimization
SPEC=vengeance npm run gear:run              # Full gear pipeline (all phases)
SPEC=vengeance npm run gear:status           # Pipeline progress
SPEC=vengeance npm run gear:fetch-candidates # Refresh item pool data
SPEC=vengeance npm run report:dashboard      # Generate report from DB
SPEC=vengeance npm run report:update         # gear:run + report:dashboard
SPEC=vengeance npm run report:publish        # Push report to GitHub Pages
```

**Remote sim routing:** Standard/confirm sims auto-route to EC2 when `remote:start` is active; quick sims always run locally. **If remote is not active and you need standard/confirm sims, start one with `npm run remote:start`.** Never run large sims locally.

**Subagent model policy:** Use `model: "opus"` for domain agents (theorist, apl-engineer, sim-runner, reviewer) and any agent writing APL or analyzing sim data. Use `model: "sonnet"` for Explore, Plan, and general research subagents. Use `model: "haiku"` only for simple read-only tasks (file search, code exploration, grep-based lookups).

## Conventions

- APL files use `.simc` extension.
- Use action list names that describe purpose (e.g., `defensives`, `cooldowns`, `aoe`, `single_target`).
- Comment non-obvious conditions with `#` lines explaining the "why." **APL comments must be plain ASCII and never consecutive.** No em dashes (`—`), arrows (`→`), curly quotes, double quotes, or decorative characters like `===` / `---`. Use `-` instead of `—`, `->` instead of `→`. Never place two `#` comment lines in a row — `ConvertAPL.py` concatenates consecutive comments into a single C++ string literal, producing garbled output. Each action gets at most one comment line directly before it.
- Keep the default action list short — delegate to sub-lists via `run_action_list` (mutually exclusive branches) or `call_action_list` (optional sub-routines that fall through).
- **Never `git add -f` generated outputs.** The `results/` gitignore is intentional — only `SCHEMA.md` is tracked. Analysis JSONs, showcase HTML, iteration reports, and session state all regenerate on demand. If a file is gitignored, it stays gitignored.
- **Always test against ALL builds.** The APL is shared by all talent builds. Verify the build roster covers all templates: `npm run roster show`. The roster is generated via `npm run roster generate` (cluster-based from SPEC_CONFIG). `iterate.js` requires the roster and refuses single-build mode.
- **Partial gains are NOT rejects — they are gating opportunities.** When a change helps some builds but hurts others, this is a branching signal, not a rejection. **Before rejecting ANY hypothesis with mixed per-build results, you MUST:**
  1. Sort all builds by weighted delta and examine the top/bottom 10
  2. Check each discriminator axis: hero tree, apex rank, hero variant, cluster presence/absence
  3. If any axis shows a clean split (gainers share a trait losers lack), create a gated condition using that SimC expression and re-test
  4. At standard fidelity, only deltas above ±0.5% are meaningful — don't gate on noise
  5. Document what discriminators you checked and why none worked before marking as rejected

  Only reject a hypothesis if NO subset of builds benefits meaningfully above the noise floor, or if no valid SimC expression can discriminate the benefiting builds after systematic analysis. **Never reject based on mean-weighted alone** — always examine the per-build distribution.

- **Significance threshold.** A change with mean weighted impact less than the sim's target_error is indistinguishable from noise — do not accept it. At quick fidelity (te=0.5), changes below ±0.5% are noise. At standard (te=0.25), below ±0.25%. At confirm (te=0.1), below ±0.1%. Always confirm marginal changes at a fidelity where the expected impact exceeds the target_error before accepting.
- **Theory before simulation.** Before changing any ability's placement, conditions, or priority, read it in context. Understand _why_ it is where it is, what role it plays in the resource/GCD/cooldown economy, and what downstream effects a change would cause. Form a clear theory — "this change should improve X because Y" — before creating a candidate or running a sim. Never shotgun changes to see what sticks.
- **Deep reasoning drives automation.** Every analysis session must start with deep mechanical reasoning using the full knowledge base (the canonical data source list is in `/optimize` Phase 0e). Automated hypothesis generators (`strategic`, `theorycraft`, `synthesize`) are heuristic screeners that serve the deep theory, not replacements for it. A shallow observation like "buff uptime is low" is only useful when paired with reasoning about _why_ it's low and what the real fix costs. Never run automated screeners in isolation — always frame their output within a deeper understanding of the system.
- **Audit existing logic for errors.** APL variables and conditions encode assumptions about game mechanics — caps, thresholds, talent interactions. These assumptions can become wrong when talents change the rules (e.g., an apex talent raising the soul fragment cap from 5 to 6). Actively look for hardcoded values or implicit assumptions that don't account for the current talent build. When you find one, trace the downstream effects: a corrected cap may change fragment thresholds, spender conditions, and target-count breakpoints.
- **Divergence accountability.** When the optimal timeline diverges from the APL, one of the two must change. Either the timeline's scoring/modeling has a bug (fix the framework), or the APL has a real suboptimality (fix the APL). Never leave a significant divergence unresolved — classify every high-delta divergence as either a framework bug or an APL improvement opportunity, then act on it.
- All JS uses ESM (`import`/`export`), Node.js 23+.
