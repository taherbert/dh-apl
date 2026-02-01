# Demon Hunters

Source: https://github.com/simulationcraft/simc/wiki/DemonHunters

## Textual Configuration Interface

This section is part of the TCI (TextualConfigurationInterface) reference.

### Options

- **initial_fury** (0-120, default: 0): Amount of fury the demon hunter is initialized with.
- **target_reach** (default: -1.0): Override for target's hitbox size, relevant for Fel Rush and Vengeful Retreat. -1.0 uses default SimC value.
- **movement_direction_factor** (1.0-2.0, default: 1.8): Relative directionality for movement events, 1.0 being directly away and 2.0 being perpendicular.
- **wounded_quarry_chance_vengeance** (0.0-1.0, default: 0.3): Chance for Wounded Quarry to shatter a Lesser Soul Fragment for Vengeance.
- **wounded_quarry_chance_havoc** (0.0-1.0, default: 0.1): Chance for Wounded Quarry to shatter a Lesser Soul Fragment for Havoc.
- **felblade_lockout_from_vengeful_retreat** (0.0-1.0, default: 0.6): How many seconds that Vengeful Retreat locks out Felblade.
- **void_metamorphosis_initial_drain** (0.0-100.0, default: 10.0): Base value for Void Metamorphosis Fury drain.
- **void_metamorphosis_drain_per_stack** (0.0-100.0, default: 0.012): How much to increase Void Metamorphosis Fury drain per tick.

### Expressions

- **soul_fragments**: The number of active, consumable soul fragments.
- **greater_soul_fragments**: The number of active, consumable greater soul fragments.
- **lesser_soul_fragments**: The number of active, consumable lesser soul fragments.
- **demon_soul_fragments**: The number of active, consumable demon soul fragments.

All soul fragment expressions can be modified via filters in the form `soul_fragments.X` where `X` is:

- **active**: The number of active, consumable soul fragments (identical to using no filter).
- **inactive**: The number of soul fragments which have been spawned but are not yet activated.
- **total**: The total number of spawned soul fragments (active and inactive).

#### Havoc

- **cooldown.bd_ds_shared.remains**: The remaining cooldown on Blade Dance / Death Sweep. The two spells share a cooldown.

### Special Actions

- **pick_up_fragment**: Move to and consume a nearby Soul Fragment. Any if expression (if provided) will be evaluated at both the start of the movement and when reaching the fragment, which may result in the action being executed without a fragment being consumed.

### Action Options

- **metamorphosis,landing_distance=x**: How far away from the target to land with Havoc's Metamorphosis. Valid range: 0-40.
- **pick_up_fragment,type=x**: The type of soul fragment to be picked up. Valid options: _greater_, _lesser_, _demon_, _all_ or _any_. Default: _all_
- **pick_up_fragment,mode=x**: The mode that determines which fragments should be prioritized. Valid options: _closest_ or _nearest_ or _close_ or _near_, _newest_ or _new_, _oldest_ or _old_. Default: _oldest_

## Reporting

### Procs

#### General

- **delayed_aa_out_of_range**: An auto-attack was delayed due to the player being outside of melee range of the target.
- **soul_fragment_greater**: A greater soul fragment was consumed.
- **soul_fragment_greater_demon**: A greater demon soul fragment was consumed.
- **soul_fragment_empowered_demon**: An empowered (Fodder to the Flame) demon soul was consumed.
- **soul_fragment_lesser**: A lesser soul fragment was consumed.
- **felblade_reset**: Felblade's cooldown was reset.
- **soul_fragment_from_soul_sigils**: A lesser soul fragment was created from Soul Sigils.

#### Havoc

- **demonic_appetite**: A soul fragment was spawned by a Demonic Appetite proc.
- **demons_bite_in_meta**: Demon's Bite was used during Metamorphosis.
- **chaos_strike_in_essence_break**: Chaos Strike was used during Essence Break.
- **annihilation_in_essence_break**: Annihilation was used during Essence Break.
- **blade_dance_in_essence_break**: Blade Dance was used during Essence Break.
- **death_sweep_in_essence_break**: Death Sweep was used during Essence Break.
- **chaos_strike_in_serrated_glaive**: Chaos Strike was used during Serrated Glaive.
- **annihilation_in_serrated_glaive**: Annihilation was used during Serrated Glaive.
- **throw_glaive_in_serrated_glaive**: Throw Glaive was used during Serrated Glaive.
- **shattered_destiny**: The duration of Metamorphosis was extended by Shattered Destiny.
- **eye_beam_canceled**: Eye Beam was canceled early.

#### Vengeance

- **soul_fragment_expire**: A soul fragment expired without being consumed.
- **soul_fragment_overflow**: A soul fragment was spawned while at maximum count.
- **soul_fragment_from_shear**: A soul fragment was spawned from Shear.
- **soul_fragment_from_fracture**: A soul fragment was spawned from Fracture.
- **soul_fragment_from_fallout**: A soul fragment was spawned from Fallout.
- **soul_fragment_from_sigil_of_spite**: A soul fragment was spawned from Sigil of Spite.
- **soul_fragment_from_meta**: An additional soul fragment was spawned from Shear or Fracture during Metamorphosis.
- **soul_fragment_from_bulk_extraction**: A soul fragment was spawned from Bulk Extraction.

#### Aldrachi Reaver

- **soul_fragment_from_aldrachi_tactics**: A soul fragment was spawned from Aldrachi Tactics.
- **soul_fragment_from_wounded_quarry**: A soul fragment was spawned from Wounded Quarry.

#### Fel-scarred

(No entries listed)

#### Set Bonuses

- **soul_fragment_from_vengeance_twws1_2pc**: A soul fragment was spawned from the TWW S1 Vengeance 2pc.
- **metamorphosis_from_tww2_vengeance_2pc**: Metamorphosis was triggered by the TWW S2 Vengeance 2pc.
- **the_hunt_reset_from_tww2_vengeance_4pc**: The Hunt's cooldown was reset by the TWW S2 Vengeance 4pc.
- **the_hunt_reset_wasted_from_tww2_vengeance_4pc**: The cooldown reset on The Hunt from the TWW S2 Vengeance 4pc was wasted.
- **winning_streak_drop_from_tww2_havoc_2pc**: Winning Streak! was dropped by casting Chaos Strike or Blade Dance from the TWW2 Havoc 2pc.
- **winning_streak_drop_wasted_from_tww2_havoc_2pc**: Winning Streak! stack drop was wasted due to residual Winning Streak! having higher stacks.
- **winning_streak_wasted_from_tww2_havoc_4pc**: Winning Streak! stacks from the TWW2 Havoc 4pc were wasted.
- **necessary_sacrifice_wasted_from_tww2_havoc_4pc**: Potential Necessary Sacrifice stacks from the TWW2 Havoc 4pc were wasted.
