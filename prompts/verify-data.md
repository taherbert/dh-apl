# Vengeance DH Data Verification

## Context

VDH APL framework for **Midnight expansion**. Project at `/Users/tom/Documents/GitHub/dh-apl`. SimC source at `/Users/tom/Documents/GitHub/simc` (branch: `midnight`).

**Pipeline:** `npm run fetch-raidbots` → `npm run extract` → `npm run talents` → `npm run interactions` → reports.
Run: `npm run build-data` (full) or `npm run verify` (checks only).

## Verification Hierarchy

```
WHAT EXISTS IN THE GAME:     Raidbots talents.json (ground truth)
HOW SIMC IMPLEMENTS IT:      sc_demon_hunter.cpp (C++ assignments)
SPELL MECHANICAL DATA:       SpellDataDump/demonhunter.txt (effects, coefficients)
SPELL QUERY DATA:            simc spell_query (runtime, limited by binary age)
```

- If something is in Raidbots but not in simc C++, it's a real talent simc hasn't implemented yet.
- If something is in simc C++ but not in Raidbots, it's dead code — exclude it.
- If something is in our data but not in Raidbots, it's stale — remove it.

## Expected Counts

From Raidbots (environment controlled by `src/config.js` `DATA_ENV`):

- **42 class nodes** (some are choice nodes with 2 entries)
- **42 spec nodes**
- **14 Aldrachi Reaver nodes** (subtree 35)
- **14 Annihilator nodes** (subtree 124)
- **10 choice nodes total** (3 class, 2 spec, 3 Aldrachi Reaver, 2 Annihilator)

## Verification Steps

### 1. Fetch fresh Raidbots data

```bash
npm run fetch-raidbots
```

Confirm node counts match expected values above.

### 2. Compare talent counts

Our `talents.json` entry counts must match Raidbots entry counts exactly. Choice nodes produce multiple entries (one per option). Run `npm run verify` and check the Raidbots Verification section.

### 3. Verify every talent name and spell ID

Every Raidbots entry's `spellId` must exist in our talent data. Any missing entry means our pipeline dropped it.

### 4. Flag stale talents

Any talent in our data whose `spellId` doesn't appear in Raidbots is stale and should be investigated.

### 5. Verify choice nodes

All choice node options must be represented. A node with 2 entries should produce 2 talent entries in our data.

### 6. Verify hero tree completeness

- Aldrachi Reaver: 14 nodes from subtree 35
- Annihilator: 14 nodes from subtree 124
- No Scarred talents in Vengeance data

### 7. Check interaction coverage

Target: 0% unknown interactions. For any unknown interactions, look up the source spell in SpellDataDump for effect data to classify it.

### 8. Cross-reference C++ assignments

Run contamination checks:

- No Havoc talents in our data
- No Devourer talents in our data
- No Scarred hero talents in our data

### 9. Verify environment consistency

All data must come from the same environment (live or ptr). Check `src/config.js` DATA_ENV matches the Raidbots data in `raidbots-talents.json`.

### 10. Run automated checks

```bash
npm run verify
```

Target: 0 failures, 0 warnings.

## Data Sources Reference

| Source           | Path/URL                                       | Authority                            |
| ---------------- | ---------------------------------------------- | ------------------------------------ |
| Raidbots         | `raidbots.com/static/data/{env}/talents.json`  | Talent tree structure (ground truth) |
| simc C++ source  | `engine/class_modules/sc_demon_hunter.cpp`     | Implementation, talent assignments   |
| SpellDataDump    | `SpellDataDump/demonhunter.txt`                | Full spell effects, coefficients     |
| simc spell_query | `/Users/tom/Documents/GitHub/simc/engine/simc` | Runtime spell data                   |

## Deliverables

1. `npm run verify` passing with 0 failures
2. Talent counts matching Raidbots exactly
3. Updated PLAN.md with findings
4. List of action items for anything unresolvable
