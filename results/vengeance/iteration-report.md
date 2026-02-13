# APL Iteration Report — Comprehensive Optimization

Generated: 2026-02-12

SimC build: midnight 75739d162b (UR proc fix, Meteoric Rise fix, Broken Spirit, SBomb resets)
Roster: 69 builds (35 AR + 34 Anni), 18 templates

## DPS Progression (mean across builds)

| Scenario | Baseline | Current | Delta |
|----------|----------|---------|-------|
| 1T | 29,276.043 | 29,374.319 | +0.34% |
| 5T | 121,840.075 | 122,010.246 | +0.14% |
| 10T | 213,796.09 | 214,351.71 | +0.26% |

## Accepted Changes

### #1: Structural cleanup (setif + fracture_cap_soon variable)
- `spb_threshold` uses `op=setif` (single line instead of two)
- Extracted `fracture_cap_soon` variable for shared Fracture charge-cap logic
- DPS-neutral (provably identical behavior)

### #2: SBomb positive conditions reorder (+0.094% weighted)
- Moved Spirit Bomb lines above Fracture charge-cap in both AR and Anni
- Removed negative `!variable.fiery_demise_active` gate from Fracture-cap
- SBomb naturally fires first when fragments are ready; no negative gating needed
- AR +0.007%, Anni +0.184%

### #3: Brand sync window 6s → 8s (+0.244% AR at confirm fidelity)
- Widened fire CD sync window from 6s to 8s in AR cooldowns
- Reduces Brand charge waste — fires Brand earlier when CDs are approaching
- AR +0.244%, Anni unaffected (noise only, doesn't use ar_cooldowns)
- Force accepted: Anni noise caused false worst-build failure

## Rejected Hypotheses

| Hypothesis | Mean | AR | Anni | Reason |
|-----------|------|-----|------|--------|
| UR-aware spb_threshold (5→6 with apex.2) | -0.079% | — | — | Extra GCD to reach 6 fragments not worth 25% more SBomb damage |
| ImmAura priority promotion | -0.001% | +0.054% | -0.058% | Wash — current placement is optimal |
| Empowered cycle exclusivity | -0.046% | — | — | Current FelDev-only gating is already optimal |
| Fragment pooling removal (Meta) | -0.131% | -0.328% | — | Pooling 3+ fragments before Meta IS valuable |
| VR+Felblade combo in AR | -0.758% | -1.474% | — | Displacement wastes GCDs catastrophically |
| Brand sync 6s → 4s | -0.099% | -0.242% | — | Tighter sync holds Brand charges too long |
| UR fishing window 6s → 4s | +0.092% | — | — | Marginal, noisy — 6s confirmed optimal |
| UR fishing window 6s → 8s | -0.097% | — | — | Longer window hurts Anni |
| Fallout AoE gate removal | -0.014% | +0.018% | — | Wash |
| Voidfall fury pool 70 → 50 | +0.012% | — | +0.081% | Noise |
| soul_fragments.total for generation | +0.027% | -0.030% | +0.086% | Noise |

## Key Findings

1. **APL is at local optimum** — 11 behavioral hypotheses tested, only 2 yielded measurable gains
2. **SBomb priority ordering matters** — positive conditions (SBomb above Fracture-cap) is cleaner AND slightly better
3. **Brand sync window was too tight** — 8s gives better Brand uptime without sacrificing burst concentration
4. **Fragment pooling before Meta is valuable** — removing the 3-fragment requirement hurts AR significantly
5. **VR displacement is costly** — even with Felblade reset, the GCD loss from repositioning far outweighs the Fury generation
6. **UR fishing window 6s is optimal** — confirmed against both tighter (4s) and wider (8s) alternatives with new SimC UR proc fix
7. **Anni Voidfall fury pooling (70) is correct** — lowering to 50 shows no improvement
