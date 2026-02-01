# Vengeance DH Data Verification

## Context

VDH APL framework for **Midnight expansion**. Project at `/Users/tom/Documents/GitHub/dh-apl`. SimC source at `/Users/tom/Documents/GitHub/simc` (branch: `midnight`).

**Pipeline:** `simc spell_query` → `spells.json` → `talents.json` → `interactions.json` → reports.
Run: `npm run build-data` (full) or `npm run verify` (checks only).

## Critical Lesson: No Single Source of Truth

**The DBC, the C++ source, and the SpellDataDump are all partially stale.**

- **DBC talent dump** (`simc spell_query=talent`): Contains removed/outdated talents (e.g., Bulk Extraction, Illuminated Sigils). Only as current as the compiled binary.
- **C++ source** (`sc_demon_hunter.cpp`): Retains code for removed abilities because it doesn't hurt to keep them. New abilities may be coded before DBC data exists.
- **SpellDataDump** (`SpellDataDump/demonhunter.txt`): Updated more frequently than the binary. Contains spell data for new abilities before they appear in `spell_query`.
- **Wowhead** (`wowhead.com/ptr/talent-calc/demon-hunter/vengeance`): The closest thing to ground truth for what's actually in the current Midnight talent tree.

**Verification requires cross-referencing ALL sources.** Something that appears in only one source is suspect. Something in all sources is confirmed. Something in none is gone.

## Current Architecture Understanding

- **Three DH specs:** Havoc (melee DPS), Vengeance (tank), Devourer (Intellect caster — NEW in Midnight)
- **Vengeance hero trees:** Aldrachi Reaver, Annihilator (NEW — replaces Fel-Scarred)
- **Havoc/Devourer hero tree:** Scarred (renamed from Fel-Scarred)
- **DBC subtree IDs are NOT hero tree identifiers** — both subtrees (34, 35) contain mixed talents from different hero trees. Hero tree identity comes from C++ `talent.{tree_name}.*` assignments.
- **Annihilator:** 16 talents exist in C++ and SpellDataDump but not in the compiled binary's talent query (binary predates DBC updates). Rebuild simc to fix.

## Verification Steps

### 1. Rebuild simc if stale

Check if the binary predates SpellDataDump updates:

```bash
ls -la /Users/tom/Documents/GitHub/simc/engine/simc  # binary date
git -C /Users/tom/Documents/GitHub/simc log --oneline -1 -- SpellDataDump/  # last DBC update
```

If the binary is older, rebuilding will bring in new talent data (especially Annihilator). After rebuild, re-run `npm run build-data`.

### 2. Cross-reference talent lists against Wowhead

For each talent in `talents.json`, verify it actually exists in the current Midnight talent tree on Wowhead (`wowhead.com/ptr/talent-calc/demon-hunter/vengeance`). Flag any talent that:

- Exists in our data but NOT on Wowhead → likely stale, remove
- Exists on Wowhead but NOT in our data → missing, add

Pay special attention to talents that appear in only ONE of: DBC dump, C++ source, Wowhead. A talent in C++ but not Wowhead may be leftover code. A talent in DBC but not Wowhead may be a removed talent still in game data.

### 3. Verify hero tree assignments

Hero tree identity comes from C++ `talent.aldrachi_reaver.*` and `talent.annihilator.*` assignments, NOT from DBC subtree IDs.

Check:

- Every Aldrachi Reaver talent in C++ maps to a DBC talent entry
- Every Annihilator talent in C++ has a corresponding spell in SpellDataDump
- No Scarred talents contaminate Vengeance data
- No Devourer talents contaminate Vengeance data

### 4. Verify base spec abilities

Cross-reference `BASE_SPELL_IDS` against:

- `find_specialization_spell()` calls in C++ (Vengeance section)
- `find_spell(..., DEMON_HUNTER_VENGEANCE)` calls
- Actual abilities on Wowhead's Vengeance spellbook

### 5. Verify interaction classification

Every interaction should have a type other than "unknown". If any are unknown:

1. Check if the source spell exists in SpellDataDump — it has full effect data
2. If the source spell has effects, classify based on effect type
3. If no effects, classify by the spell's known role (check C++ implementation)

### 6. Identify stale data

Flag anything that:

- Is in `talents.json` but not in the current Wowhead talent tree
- Is in `BASE_SPELL_IDS` but not a current Vengeance base ability
- Is a Scarred/Fel-Scarred talent still attached to Vengeance
- References Demonsurge, Burning Blades, or other Scarred abilities as Vengeance

### 7. Run automated checks

```bash
npm run verify
```

This checks: talent coverage vs C++, contamination (Havoc/Devourer/Scarred), base spell presence, interaction quality, key spell presence, and simc version.

## Data Sources Reference

| Source            | Path                                                 | Freshness      | Authority                          |
| ----------------- | ---------------------------------------------------- | -------------- | ---------------------------------- |
| simc binary       | `/Users/tom/Documents/GitHub/simc/engine/simc`       | Check `ls -la` | Talent query, spell query          |
| C++ source        | `engine/class_modules/sc_demon_hunter.cpp`           | git HEAD       | Talent assignments, spec abilities |
| SpellDataDump     | `SpellDataDump/demonhunter.txt`                      | git log        | Full spell data, effects           |
| SpellDataDump PTR | `SpellDataDump/demonhunter_ptr.txt`                  | git log        | Beta/PTR spell data                |
| APL source        | `engine/class_modules/apl/apl_demon_hunter.cpp`      | git HEAD       | What simc actually simulates       |
| Wowhead           | `wowhead.com/ptr/talent-calc/demon-hunter/vengeance` | Live           | Ground truth for current tree      |

## Known Gaps (to close)

- Annihilator hero tree: 0 talents in data, 16 in C++. Needs simc rebuild or SpellDataDump parsing.
- 8 new Vengeance talents in C++ not yet in DBC (Quickened Sigils, Tempered Steel, Felfire Fist, etc.)
- 12 stale talents in DBC not in C++ (Bulk Extraction, Illuminated Sigils, etc.) — should be removed
- SpellDataDump contains modifier spell data we don't currently fetch — could eliminate need for name-based interaction classification

## Deliverables

1. Updated data files with stale entries removed
2. Verification script passing with 0 failures, 0 warnings
3. Updated PLAN.md with findings
4. List of action items for anything that can't be resolved now (e.g., simc rebuild)
