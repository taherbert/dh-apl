# Data Verification Guide

## Context

Spec-agnostic APL framework targeting the expansion configured in `config.json`. Project at `/Users/tom/Documents/GitHub/dh-apl`. SimC source path read from `config.json`.

**Pipeline:** `npm run fetch-raidbots` -> `npm run extract` -> `npm run talents` -> `npm run interactions` -> reports.
Run: `npm run build-data` (full) or `npm run verify` (checks only).

## Verification Hierarchy

```
WHAT EXISTS IN THE GAME:     Raidbots talents.json (ground truth)
HOW SIMC IMPLEMENTS IT:      Class module C++ (assignments)
SPELL MECHANICAL DATA:       SpellDataDump (effects, coefficients)
SPELL QUERY DATA:            simc spell_query (runtime, limited by binary age)
```

- If something is in Raidbots but not in simc C++, it's a real talent simc hasn't implemented yet.
- If something is in simc C++ but not in Raidbots, it's dead code — exclude it.
- If something is in our data but not in Raidbots, it's stale — remove it.

## Loading Spec Context

Read `config.json` for the active spec (`spec.className`, `spec.specName`, `spec.specId`). Load the spec adapter via `getSpecAdapter()` for:

- Hero tree names and subtree IDs (`getHeroTrees()`)
- Sibling specs for contamination checks (`getSiblingSpecs()`)
- Key spell IDs for interaction coverage (`getKeySpellIds()`)

## Verification Steps

### 1. Fetch fresh Raidbots data

```bash
npm run fetch-raidbots
```

Confirm node counts match the Raidbots data for the loaded spec. The expected counts come from Raidbots itself — do not hardcode them.

### 2. Compare talent counts

Our `talents.json` entry counts must match Raidbots entry counts exactly. Choice nodes produce multiple entries (one per option). Run `npm run verify` and check the Raidbots Verification section.

### 3. Verify every talent name and spell ID

Every Raidbots entry's `spellId` must exist in our talent data. Any missing entry means our pipeline dropped it.

### 4. Flag stale talents

Any talent in our data whose `spellId` doesn't appear in Raidbots is stale and should be investigated.

### 5. Verify choice nodes

All choice node options must be represented. A node with 2 entries should produce 2 talent entries in our data.

### 6. Verify hero tree completeness

Use `getHeroTrees()` from the spec adapter to get the hero tree names and subtree IDs. Verify that:

- Each hero tree has the expected number of nodes from Raidbots
- No talents from sibling hero trees (via `getSiblingSpecs()`) are present in our data

### 7. Check interaction coverage

Target: 0% unknown interactions. For any unknown interactions, look up the source spell in SpellDataDump for effect data to classify it.

### 8. Cross-reference C++ assignments

Run contamination checks using `getSiblingSpecs()`:

- No sibling spec talents in our data
- No sibling hero tree talents in our data

### 9. Verify environment consistency

All data must come from the same environment (live, ptr, or beta). Check `config.json` `data.env` matches the Raidbots data in `raidbots-talents.json`.

### 10. Run automated checks

```bash
npm run verify
```

Target: 0 failures, 0 warnings.

## Data Sources Reference

| Source           | Path/URL                                      | Authority                            |
| ---------------- | --------------------------------------------- | ------------------------------------ |
| Raidbots         | `raidbots.com/static/data/{env}/talents.json` | Talent tree structure (ground truth) |
| simc C++ source  | Read path from config.json                    | Implementation, talent assignments   |
| SpellDataDump    | `reference/spelldatadump-*.txt`               | Full spell effects, coefficients     |
| simc spell_query | simc binary path from config.json             | Runtime spell data                   |

## Deliverables

1. `npm run verify` passing with 0 failures
2. Talent counts matching Raidbots exactly
3. Updated PLAN.md with findings
4. List of action items for anything unresolvable
