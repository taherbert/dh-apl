# APL Scaffold Analysis Report

## Spec: vengeance

## Identified Abilities

| Ability | Category | Cooldown | Resource | Notes |
|---------|----------|----------|----------|-------|
| Throw Glaive | spender | - | 25 fury |  |
| Metamorphosis | filler | 1s | - | Buff, Off-GCD |
| Fiery Brand | filler | - | - |  |
| Sigil of Flame | filler | - | - | AoE, Buff |
| Sigil of Flame | filler | - | - | AoE, Buff, Off-GCD |
| Soul Carver | major_cooldown | 60s | +3 soul | Buff |
| Fiery Brand | filler | - | - | Debuff, Off-GCD |
| Fiery Brand | filler | - | - | Debuff, Off-GCD |
| Fel Devastation | spender | 40s | 50 fury | Buff |
| Fel Devastation | filler | - | - | AoE, Off-GCD |
| Fel Devastation | filler | - | - | Off-GCD |
| Felblade | generator | - | +15 fury | Off-GCD |
| Soul Carver | major_cooldown | 60s | - |  |
| Fracture | filler | - | - | Off-GCD |
| Fracture | filler | - | - | Off-GCD |
| Soul Cleave | spender | - | 35 fury |  |
| Soul Cleave | filler | - | - | AoE, Off-GCD |
| Felblade | filler | 12s | - |  |
| Spirit Bomb | spender | 25s | 40 fury | Buff |
| Spirit Bomb | filler | - | - | AoE, Off-GCD |
| Immolation Aura | generator | 1.5s | +20 fury, 8 fury | Buff |
| Immolation Aura | filler | - | - | AoE, Off-GCD |
| Immolation Aura | generator | - | +4 fury, 2 fury | AoE, Off-GCD |
| Fracture | generator | - | +25 fury, 2 soul |  |
| Throw Glaive | filler | - | - | Off-GCD |
| Sigil of Flame | generator | - | +25 fury | Off-GCD |
| Sigil of Spite | filler | - | - | AoE, Off-GCD |
| Sigil of Spite | filler | - | - | AoE, Buff |
| Immolation Aura | generator | - | +20 fury, 8 fury | Buff, Off-GCD |
| Immolation Aura | generator | - | +20 fury, 8 fury | Buff, Off-GCD |
| Immolation Aura | generator | - | +20 fury, 8 fury | Buff, Off-GCD |
| Immolation Aura | filler | - | - |  |
| Immolation Aura | filler | - | - | Buff |
| Immolation Aura | filler | - | - | Buff |
| Immolation Aura | filler | - | - | Buff |
| Void Metamorphosis | filler | - | - |  |

## Missing Information

The scaffold generator cannot determine:
1. **Talent gates** — which abilities require specific talents
2. **Hero tree routing** — which abilities belong to which hero tree
3. **Buff/debuff windows** — optimal timing for damage amplifiers
4. **Resource thresholds** — optimal fragment counts, fury pooling points
5. **Priority ordering** — which spenders beat which generators in practice

These require manual analysis or simulation to determine.