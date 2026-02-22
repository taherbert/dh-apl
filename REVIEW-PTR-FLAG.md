# Review: ptr=1 Was Missing from Multi-Actor Sims

## The Bug

`buildOverrides()` in `src/sim/runner.js` adds `ptr=1` when `DATA_ENV === "beta"` (which it is — we target the Midnight expansion). This flag enables PTR/beta spell data tuning in SimC.

**`runMultiActorAsync()`** in `runner.js` built its args manually and omitted `ptr=1`. It's used by `updateAllDps()` in `build-roster.js` for roster DPS updates.

The other two sim paths were fine:

- **`runSim()`** called `buildOverrides()` — had `ptr=1`
- **`prepareProfileset()`** had its own `ptr=1` check — had `ptr=1`

## What This Means

| Sim Path               | Used By                                | Had `ptr=1`?             |
| ---------------------- | -------------------------------------- | ------------------------ |
| `runSim()`             | `npm run sim`, single-build runs       | Yes                      |
| `runMultiActorAsync()` | `updateAllDps()`, roster DPS           | **No** (fixed in PR #86) |
| `prepareProfileset()`  | `iterate.js compare`, all optimization | Yes                      |

## Impact on Optimization Decisions

**All optimization decisions from `iterate.js` are valid.** `prepareProfileset()` always had `ptr=1`, so both baseline and candidate sims used correct beta spell data. Accept/reject decisions are sound.

The only affected path was `updateAllDps()` via `runMultiActorAsync()` — roster DPS display values were simmed without `ptr=1`, meaning they used non-ptr spell tuning. This only affects the absolute DPS numbers shown in `npm run roster show` and the report dashboard, NOT any optimization comparisons.

## Action Items

- [x] Fix `runMultiActorAsync()` to include ptr=1 (done in PR #86 — now calls `buildOverrides()`)
- [ ] Re-sim roster DPS: `SPEC=vengeance npm run roster update-dps` to get correct absolute numbers
- [ ] Re-initialize iteration baseline: `SPEC=vengeance node src/sim/iterate.js init apls/vengeance/vengeance.simc` to align baseline with new DungeonRoute scenario
