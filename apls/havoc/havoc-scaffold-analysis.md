# APL Scaffold Analysis Report

## Spec: havoc

## Identified Abilities

| Ability | Category | Cooldown | Resource | Notes |
|---------|----------|----------|----------|-------|
| Metamorphosis | filler | - | - | Buff, Off-GCD |
| Chaos Strike | spender | - | 40 fury |  |
| Chaos Nova | spender | 45s | 25 fury | AoE, Buff |
| Throw Glaive | spender | - | 25 fury |  |
| Blade Dance | spender | 15s | 35 fury | AoE, Buff |
| Metamorphosis | major_cooldown | 120s | - | AoE |
| Fel Rush | filler | - | - | AoE, Off-GCD |
| Chaos Strike | generator | - | +20 fury | Off-GCD |
| Fel Rush | filler | 1s | - |  |
| Eye Beam | spender | 30s | 30 fury | Buff |
| Vengeful Retreat | filler | 0.5s | - | Buff, Off-GCD |
| Vengeful Retreat | filler | - | - | AoE, Buff, Off-GCD |
| Chaos Strike | filler | - | - | Off-GCD |
| Blade Dance | filler | - | - | AoE, Off-GCD |
| Metamorphosis | filler | - | - | AoE, Buff, Off-GCD |
| Annihilation | spender | - | 40 fury |  |
| Annihilation | filler | - | - | Off-GCD |
| Death Sweep | spender | 9s | 35 fury | AoE |
| Death Sweep | filler | - | - | AoE, Off-GCD |
| Felblade | generator | - | +15 fury | Off-GCD |
| Chaos Strike | filler | - | - | Off-GCD |
| Annihilation | filler | - | - | Off-GCD |
| Felblade | filler | 12s | - |  |
| Metamorphosis | filler | - | - | Buff, Off-GCD |
| Essence Break | minor_cooldown | 40s | - | AoE |
| Immolation Aura | generator | 1.5s | +20 fury, 8 fury | Buff |
| Immolation Aura | filler | - | - | AoE, Off-GCD |
| Immolation Aura | generator | - | +4 fury, 2 fury | AoE, Off-GCD |
| Essence Break | filler | - | - | Buff, Off-GCD |
| Throw Glaive | filler | - | - | Off-GCD |
| The Hunt | major_cooldown | 90s | - | Buff |
| The Hunt | filler | - | - | Off-GCD |
| The Hunt | filler | - | - | Buff |
| The Hunt | filler | - | - | Buff, Off-GCD |
| The Hunt | filler | - | - | Buff, Off-GCD |
| Eye Beam | filler | - | - | Buff |
| Eye Beam | filler | - | - | AoE, Off-GCD |
| Immolation Aura | filler | - | - |  |
| Immolation Aura | filler | - | - | Buff |
| Immolation Aura | filler | - | - | Buff |
| Immolation Aura | filler | - | - | Buff |
| Void Metamorphosis | filler | - | - |  |
| Essence Break | filler | - | - | Off-GCD |

## Missing Information

The scaffold generator cannot determine:
1. **Talent gates** — which abilities require specific talents
2. **Hero tree routing** — which abilities belong to which hero tree
3. **Buff/debuff windows** — optimal timing for damage amplifiers
4. **Resource thresholds** — optimal fragment counts, fury pooling points
5. **Priority ordering** — which spenders beat which generators in practice

These require manual analysis or simulation to determine.