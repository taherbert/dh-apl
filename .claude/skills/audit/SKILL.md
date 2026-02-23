---
description: Full cross-reference data verification audit. Cross-references Raidbots, simc C++, SpellDataDump, and our data files.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, WebFetch
---

Full cross-reference data verification audit. Cross-references Raidbots, simc C++, SpellDataDump, and our data files. Reports findings and fixes what can be fixed.

## Verification Hierarchy

```
WHAT EXISTS IN THE GAME:     Raidbots talents.json (ground truth)
HOW SIMC IMPLEMENTS IT:      Class module C++ (assignments)
SPELL MECHANICAL DATA:       SpellDataDump (effects, coefficients)
SPELL QUERY DATA:            simc spell_query (runtime, limited by binary age)
```

- In Raidbots but not simc C++ -> real talent, simc hasn't implemented yet
- In simc C++ but not Raidbots -> dead code, exclude
- In our data but not Raidbots -> stale, remove

## Data Sources

| Source           | Path/URL                                              | Authority                   |
| ---------------- | ----------------------------------------------------- | --------------------------- |
| Raidbots         | `mimiron.raidbots.com/static/data/{env}/talents.json` | Talent tree (ground truth)  |
| simc C++ source  | Path from config.json                                 | Implementation, assignments |
| SpellDataDump    | `reference/spelldatadump-*.txt`                       | Spell effects, coefficients |
| simc spell_query | Binary path from config.json                          | Runtime spell data          |

## Verification Steps

**Steps 1-2: Sequential setup**

1. **Fetch fresh Raidbots data:** `npm run fetch-raidbots`. Confirm node counts match.
2. **Compare talent counts:** Our `talents.json` entry counts must match Raidbots exactly. Run `npm run verify`.

**Steps 3-9: Parallel verification groups**

After steps 1-2 complete, launch two parallel groups using the Task tool with `run_in_background: true`:

**Group A — Raidbots Data Validation** (subagent, `model: "sonnet"`):

Prompt the subagent with the spec name, paths to `data/{spec}/talents.json`, `data/{spec}/raidbots-talents.json`, and `config.json`. It performs:

3. **Verify talent names and spell IDs:** Every Raidbots entry's `spellId` must exist in our data.
4. **Flag stale talents:** Any talent whose `spellId` doesn't appear in Raidbots.
5. **Verify choice nodes:** All choice node options represented (2 entries -> 2 talent entries).
6. **Verify environment consistency:** All data from same environment (`config.json` `data.env` matches `raidbots-talents.json`).

**Group B — Source Cross-Reference** (subagent, `model: "sonnet"`):

Prompt the subagent with the spec name, paths to data files, the simc C++ source path (from config.json), and SpellDataDump path. It performs:

6. **Verify hero tree completeness:** Use `getHeroTrees()` from spec adapter. Check node counts, no sibling hero tree contamination.
7. **Check interaction coverage:** Target 0% unknown. Look up unknowns in SpellDataDump to classify.
8. **Cross-reference C++ assignments:** No sibling spec or hero tree talents in our data (use `getSiblingSpecs()`).

**Step 10: Final validation (after both groups complete)**

10. **Run automated checks:** `npm run verify`. Target: 0 failures, 0 warnings.

## Deliverables

1. `npm run verify` passing with 0 failures
2. Talent counts matching Raidbots exactly
3. List of action items for anything unresolvable
