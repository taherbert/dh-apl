# Developer Documentation

Source: https://github.com/simulationcraft/simc/wiki/DeveloperDocumentation

## Introduction

This guide provides an architectural overview to help new developers get started with SimulationCraft.

## The Core Structure

The architecture consists of three primary layers:

**sim_t (Top Layer)**

- Parses program options
- Creates and initializes players
- Controls the event wheel
- Manages combat start/end and analysis

**player_t (Player Layer)**

- Contains player creation and initialization data
- Manages buffs, procs, stats, and resources
- Handles all player-related information

**action_t (Action Foundation)**

- Base class for all abilities
- Stores ability specifications (damage, coefficients, cooldowns)
- Implements key functions: `execute()`, `ready()`, `cost()`, `impact()`, `tick()`

## Abilities

Action inheritance hierarchy:

- `action_t` - Core foundation
  - `spell_base_t` - Common spell mechanics
    - `spell_t` (harmful), `heal_t`, `absorb_t`
  - `attack_t` - Attack mechanics
    - `melee_attack_t`, `ranged_attack_t`

## The Class Modules

Class-specific modules inherit from `player_t`. They override virtual functions to implement class-specific behavior:

```cpp
virtual double priest_t::composite_spell_power_multiplier()
{
  double m = player_t::composite_spell_power_multiplier();
  m *= 1.0 + buffs.inner_fire -> up () * buffs.inner_fire -> data().effectN( 2 ).percent();
  return m;
}
```

### Class Abilities

Ability class hierarchy follows this pattern:

```
action_t
  spell_base_t
    spell_t
      priest_action_t<spell_t>
        priest_spell_t
          mind_blast_t
```

Example - Flamestrike:

```cpp
struct flamestrike_t : public mage_spell_t
{
  flamestrike_t( mage_t* p, const std::string& options_str ) :
    mage_spell_t( "flamestrike", p, p -> find_class_spell( "Flamestrike" ) )
  {
    parse_options( NULL, options_str );
    aoe = -1;
  }
};
```

## Damage Calculations

### Direct Damage

The `action_t::calculate_direct_amount()` method follows this pseudocode:

```
direct_amount = average(base_dd_min, base_dd_max) + base_dd_adder;

if (weapon_multiplier > 0)
  direct_amount += average(weapon->min_dmg, weapon->max_dmg) + weapon->bonus_damage +
                   weapon_speed * attack_power / 3.5;
  direct_amount *= weapon_multiplier;

direct_amount += spell_power_mod.direct * spell_power;
direct_amount += attack_power_mod.direct * attack_power;

direct_amount *= action_multiplier();
direct_amount *= action_da_multiplier();
direct_amount *= player->composite_player_multiplier();
direct_amount *= player->composite_player_dd_multiplier();
direct_amount *= composite_persistent_multiplier();
direct_amount *= composite_target_da_multiplier();
direct_amount *= (composite_versatility() + player->composite_damage_versatility());
direct_amount *= 1.0 + player->buffs.resolve->current_value / 100.00;

if (crit) { tick_amount *= 1.0 + total_crit_bonus(); }
if (multistrike) { tick_amount *= composite_multistrike_multiplier(); }
```

### Periodic Damage/Healing

The `action_t::calculate_tick_amount()` method applies similar logic:

```
tick_amount = base_td + base_ta_adder;
tick_amount += spell_power_mod.tick * spell_power;
tick_amount += attack_power_mod.tick * attack_power;

tick_amount *= action_multiplier();
tick_amount *= action_ta_multiplier();
tick_amount *= player->composite_player_multiplier();
tick_amount *= player->composite_player_td_multiplier();
tick_amount *= composite_persistent_multiplier();
tick_amount *= composite_target_ta_multiplier();
tick_amount *= (composite_versatility() + player->composite_damage_versatility());
tick_amount *= 1.0 + player->buffs.resolve->current_value / 100.00;

if (crit) { tick_amount *= 1.0 + total_crit_bonus(); }
if (multistrike) { tick_amount *= composite_multistrike_multiplier(); }
```

## Various Helper Functions

- **event_t**: Custom event class; override `execute()` function
- **sample_data_t**: Data sampling utility
- **stats_t**: Statistics tracking
- **cooldown_t**: Cooldown management
- **dot_t**: Damage-over-time effects
- **gain_t**: Resource gain tracking

## Special Gotchas

### NaN Comparisons

Never compare numbers to NaN -- produces unexpected behavior with certain fast-math compiler settings.

### Buffs

Never create multiple buffs per player sharing the same name.

## External Services

SimulationCraft runs a Jenkins service that:

- Automatically builds the command-line client by polling the git repository
- Runs comprehensive test suites post-build

**Testing Split:**

- Fight style testing: highest ilevel raid simulations against HeavyMovement, HelterSkelter, and HecticAddCleave
- Class module testing: highest ilevel class/spec profiles tested with all relevant talents
