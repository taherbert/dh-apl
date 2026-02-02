Load VDH APL analysis context and prepare for an optimization session.

## Setup

1. Read the analysis methodology guide:

```
prompts/apl-analysis-guide.md
```

2. Read the ability/interaction report:

```
data/ability-report.md
```

3. If an argument was provided (`$ARGUMENTS`), read that file as the APL to analyze. Otherwise, list available APLs:

```
ls apls/
```

4. Check for recent simulation output:

```
ls results/
```

## After Loading

Summarize what was loaded:

- Guide sections available
- APL file (if loaded) — number of action lines, sub-lists found
- Recent sim results (if any) — scenarios, DPS numbers
- Data staleness — check if `data/spells.json` and `data/interactions.json` exist

Suggest analysis starting points based on what's loaded:

- If APL loaded: "Ready to analyze. Start with resource flow audit, DPGCD ranking, or cooldown alignment?"
- If no APL: "No APL specified. Pick one from `apls/` or load the reference APL from `reference/vengeance-apl.simc`."
- If sim results exist: "Sim data available — can cross-reference APL logic against actual cast counts and uptimes."

Note: Use `/simc-reference` for SimC syntax, expression details, or fight style options.
