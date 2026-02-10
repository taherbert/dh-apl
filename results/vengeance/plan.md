# Optimization Session — 2026-02-09

## Phase 0: Setup ✅
- Spec: Vengeance Demon Hunter
- Roster: 69 builds (34 Anni + 35 AR), 18 templates, apex 0-4
- Baseline: Complete (69 builds × 3 scenarios: 1T, 5T, 10T)
- Fixed: startup.js TLA circular import deadlock → startup-cli.js wrapper

## Phase 1: Deep Reasoning + Specialists ✅
### Root Theories
1. Anni Meta hold at building>=2 — validated in prior session, not re-tested
2. AR brand window AoE reorder — already partially implemented
3. Anni FD-aware SBomb threshold — exhaustively rejected in prior sessions

### Critical User Finding
- AR empowered cycle ordering was BACKWARD: Bladecraft (12 slashes) should be AoE-first, RM stacks (14% amp) should be ST-first
- State Machine specialist MISSED this bug (claimed correct at 0.95 confidence)

## Phase 2: Synthesis ✅
- Cross-referenced 4 specialist outputs with root theories

## Phase 3: Iteration ✅
- 4 iterations: 1 accepted, 3 rejected

### Iteration #1 ✅ ACCEPTED — AR empowered cycle swap (+2.73% mean)
- Swapped Bladecraft (12 slashes) to AoE, RM stacks to ST
- AR mean: +5.36%, Anni: +0.01%, Overall: +2.73%
- Fixed SBomb chain comment (Mass Acceleration is Anni-only)

### Iteration #2 ❌ REJECTED — Anni Fallout ImmAura elevation (noise)
- Elevating ImmAura for AoE Fallout fragment gen — +0.005% mean (noise)

### Iteration #3 ❌ REJECTED — AR AoE FD SBomb at 3 (-0.06%)
- With Fallout AoE, fragments arrive fast enough that threshold beats 3-frag dumps

### Iteration #4 ❌ REJECTED — Anni AoE SBomb threshold at 3 (-0.11%)
- Theoretical efficiency (1.33 vs 1.25 frag-units/GCD) doesn't overcome per-cast damage loss

## Phase 4: Report ✅

## Final DPS Progress
| Scenario | Baseline | Current | Delta |
|----------|----------|---------|-------|
| 1T       | 28,044   | 28,154  | +0.39% |
| 5T       | 109,150  | 112,904 | +3.44% |
| 10T      | 190,669  | 199,844 | +4.81% |

## Key Change
AR empowered cycle: Bladecraft (12 FotA slashes × N targets) in AoE, RM stacks (14% single-target amp) in ST. This was a fundamental ordering bug where the AoE and ST abilities were swapped.
