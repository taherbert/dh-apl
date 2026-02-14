# VDH APL Structural Audit — 2026-02-14

## Bug Fixes Applied
1. Removed dead `vengeful_retreat,if=talent.unhindered_assault` from Anni list (Unhindered Assault is AR-only hero talent)
2. Added `use_off_gcd=1` to AR AoE `vengeful_retreat` for consistency with AR main list

## Hypotheses Tested (8 iterations, 1 accepted, 7 rejected)

| # | Hypothesis | Mean | Worst | Verdict |
|---|-----------|------|-------|---------|
| 1 | H1: Lower spb_threshold to 3 during Meta for apex.3 | +0.02% | -1.98% | Noise |
| 2 | H4: Move IA above Felblade in AR/Anni core | +0.02% | -1.48% | Noise |
| 3 | H2: Expand UR fishing window to 8s for apex.3 | -0.02% | -1.86% | Noise |
| 4 | H6+H8: Fallout-gated IA + Anni Brand Voidfall gate | +0.02% | -1.29% | Noise |
| 5 | SC during Voidfall spending in Anni core | -0.05% | -1.70% | Noise |
| 6 | Remove AR Meta 3-fragment gate | -0.40% (AR) | -1.13% | Reject — gate is load-bearing |
| 7 | IA on cooldown for both hero trees | +0.08% | — | Hero tree split detected → gated |
| 8 | **AR-only IA on cooldown** | **+0.10%** | **-0.96%** | **Accepted** (+0.167% AR mean) |

## Not Tested
- H3 (UR fishing on SA stacks): Same mechanism as H2
- H5 (IA at 2 targets): No 2-target scenario
- H7 (Brand+UR overlap SBomb threshold): Already implemented at 3 frags

## Conclusion
APL near local optimum. One sim-verified improvement found: elevating Immolation Aura to high priority in AR (cast on cooldown after sub-list calls). AR has no state machine to disrupt, so IA's passive damage + fury generation fills gaps between empowered cycles. Anni left unchanged — Voidfall state machine makes IA elevation neutral/negative.

## Key Findings
- AR Meta 3-fragment gate is load-bearing (-0.40% if removed). Meta GCDs are more valuable for SBomb consumption than fragment generation.
- IA priority shows a clear hero tree split: AR benefits (+0.167%) while Anni is neutral (+0.030%). The asymmetry is mechanical — AR's deterministic empowered cycle has natural gaps where IA fits, while Anni's Voidfall state machine has no such gaps.
- All seething anger / apex.3 hypotheses (H1-H3) produced noise, confirming the existing Meta/UR fishing logic is well-calibrated.
