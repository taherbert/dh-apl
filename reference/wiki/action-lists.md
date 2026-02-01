# Action Lists

Source: https://github.com/simulationcraft/simc/wiki/ActionLists

## Default Action Lists

Most specializations provide two built-in action lists: a default action list maintained by the community for SimC and the Blizzard Assisted Combat (Single-Button Assist, One-Button Rotation).

### Default

Default APLs are provided if no actions are explicitly provided and Assisted Combat options are not provided. They are maintained as a part of SimC. Implementations may be found in the engine/class_modules/apl directory.

### Assisted Combat

Starting in 11.1.7, Blizzard provides Assisted Combat rotations, otherwise known as Single-Button Assist or One-Button Rotation. These options are actor-scope and must occur after an actor is created.

#### Enable Basic Assisted Combat APL

```
use_blizzard_action_list=1
```

#### Enable Basic Cooldowns

```
use_cds_with_blizzard_action_list=1
```

#### One-Button Mode

Enables the Global Cooldown penalty inherent when using Assisted Combat in One-Button mode.

```
one_button_mode=1
```

#### Enable Spell Queue

```
enable_spell_queue=1
```

#### Spell Queue Window

```
spell_queue_window=400
```

#### Print Full Action List

```
save_full_blizzard_apl=1
save_actions=filename.simc
```

## Behaviour

Actions lists are priorities lists: periodically, Simulationcraft scans your character's actions list, starting with the first action (the highest priority) and continuing until an available action is found.

Example warrior actions list:

```
actions=flask,type=greater_draenic_strength_flask
actions+=/potion,name=draenic_strength,if=(target.health.pct<20&buff.recklessness.up)|target.time_to_die<=25
actions+=/auto_attack
actions+=/recklessness
actions+=/bloodthirst
actions+=/colossus_smash
actions+=/execute
actions+=/raging_blow,if=target.health_pct>=20
```

Key advice: Do not forget it is priority-based, focus on correctly modeling desired gameplay, and use combat logs for verification.

## Syntax

**actions** (scope: current character; default: depends on class and spec) is the list of actions your character will follow. It is a multi-line string and a sequence of commands using the "/" separator.

```
actions=dosomething
actions+=/dosomethingelse
```

## Available Actions

### Basics

- **auto_attack**: Triggers auto-attack when not already activated
  - _sync_weapons_ (optional, default: 0): Synchronizes weapon swings for ambidextrous classes

```
actions+=/auto_attack,sync_weapons=1
```

- **snapshot_stats**: Captures buffed stats values before combat begins

```
actions+=/snapshot_stats
```

- **cancel_buff**: Cancels a buff
  - _name_: Name of the buff to cancel

```
actions+=/cancel_buff,name=raging_blow,if=buff.raging_blow.stack=2
```

- **use_item**: Triggers the use of an item
  - _name_: Item's name
  - Alternatively, specify by _slot_ or on-use _effect_name_

```
actions+=/use_item,name=shard_of_woe,if=cooldown.evocation.remains>86
```

- **restore_mana**: Forcefully and instantly restores mana
  - _mana_ (default: 0): Amount of mana to restore

```
actions+=/restore_mana,mana=500
```

### Spells

Spells are added on a per-class basis where white spaces are replaced with underscores and non-alphanumeric characters are ignored.

```
actions+=/tigers_fury
```

### Racials

- _arcane_torrent_: Blood elf racial
- _berserking_: Troll racial
- _blood_fury_: Orc racial
- _stoneform_: Dwarf racial

```
actions+=/arcane_torrent
```

### Pets

Pets' actions use syntax: `<petname>:<petaction>`

```
actions+=/spider:wolverine_bite
actions+=/wolverine_bite
```

### External Buffs

External buffs like Power Infusion can be called and set up for an APL/profile. Implemented buffs:

- Power Infusion
- Symbol of Hope

```
external_buffs.pool=buff_name1:cooldown:quantity/buff_name2:cooldown:quantity
actions+=/invoke_external_buff,name=buff_name1,if=condition
```

Example:

```
actions+=/invoke_external_buff,name=power_infusion,if=buff.dancing_rune_weapon.up|!talent.dancing_rune_weapon
```

### Consumables

```
actions+=/potion,type=elemental_potion_of_power_3
actions+=/food,type=blackrock_barbecue
actions+=/flask,type=greater_draenic_strength_flask
actions+=/health_stone,trigger=60000
actions+=/potion,name=draenic_strength,if=!in_combat|buff.bloodlust.react
actions+=/augmentation,type=focus
actions+=/oralius_whispering_crystal
actions+=/crystal_of_infinity
```

### Movement

- **start_moving**: Triggers a movement phase
- **stop_moving**: Ends the movement phase

```
actions+=/stop_moving,health_percentage<=25,if=cooldown.shadow_word_death.remains>=0.2
actions+=/start_moving,health_percentage<=25,if=cooldown.shadow_word_death.remains<=0.1
```

### Sequences

Actions sequences are sub-actions chains to execute in a given order.

- **sequence**: Declares and triggers a sequence of actions
  - _name_ (optional, default: "default"): Names the sequence

```
actions+=/yellow
actions+=/sequence,red:blue
```

Once one sub-action has been performed, Simulationcraft restarts at the beginning of the whole actions list, not the sequence.

- **restart_sequence**: Restarts the specified sequence
  - _name_: Name of the sequence to restart

```
actions+=/sequence,name=attack:fire_melee:fire_nova:fire_blast
actions+=/restart_sequence,name=attack,moving=0
```

### Strict Sequences

Strict Sequences do not need to be reset. When started, they cannot be stopped under normal circumstances. A strict sequence requires all actions in the sequence to be ready for the duration.

```
actions+=/strict_sequence,name=swifty:recklessness:bloodbath:colossus_smash:mortal_strike:whirlwind
```

### Waits

- **wait**: Stops processing the actions list for a given time
  - _sec_ (default: 1): Number of seconds to wait

```
actions+=/wait,sec=5
actions+=/wait,sec=buff.somebuff.remains-2
```

- **wait_until_ready**: Stops processing until some cooldown or dot expires
  - _sec_ (default: 1): Maximum time in seconds

```
actions+=/wait_until_ready,sec=0.5
```

### Resources

- **pool_resource**: Stops processing while the resource is restored
  - _wait_ (default: 0.251): Time in seconds to wait
  - _for_next_ (default: 0): Waits until player has enough resources for the following action
  - _extra_amount_ (default: 0): Requires additional resource generation

```
actions+=/pool_resource,if=energy<60&buff.slice_and_dice.remains<5
actions+=/slice_and_dice,if=combo_points>=3&buff.slice_and_dice.remains<2

actions+=/pool_resource,for_next=1,extra_amount=85
actions+=/shadow_dance,if=energy>=85&combo_points<5&buff.stealthed.down
```

### APL Variables

APL variables take the general form of:

```
variable,name=,<default=>,<value=>,<op=>,<delay=>,<condition=>,<if=>
```

If all optional values are omitted the variable will default to the _set_ operation.

- _name_: User assigned name for the variable
- _default_: Initial value of the variable (default: 0)
- _value_: Value for the operation (supports expressions)
- _op_: Operation to perform. Possible values:
  - _print_: Prints current value to log
  - _reset_: Resets to _default_
  - _floor_: Floor operation
  - _ceil_: Ceil operation
  - _set_: Sets the value
  - _add_: Adds _value_ to current value
  - _sub_: Subtracts _value_ from current value
  - _mul_: Multiplies _value_ by current value
  - _div_: Divides current value by _value_
  - _pow_: Raises current value to the power of _value_
  - _mod_: Modulo operation
  - _min_: Min operation
  - _max_: Max operation
  - _setif_: Conditional set (requires _value_else_ parameter)
  - _report_: Reports changes to the variable in the HTML report

- _delay_: Delay before the variable action can be executed again
- _if_: Conditional expressions to control execution

```
apl_variable.aoe_threshold=5
```

For multi-target sims, _cycling_variable_ can be used:

```
actions+=/variable,name=agony_over_5_count,op=reset
actions+=/cycling_variable,name=agony_over_5_count,op=add,value=dot.agony.remains>=5
```

## Actions Modifiers

### Selecting the Target

- **target** (default: ""): Action's target. When empty, it will be the default target

```
actions+=/power_infusion,target=John
actions+=/holy_prism,target=self
```

- **cycle_targets**: Cycles the action through all available targets when set to 1

```
actions+=/moonfire,cycle_targets=1,if=!ticking
```

- **max_cycle_targets**: Sets maximum amount of targets to cycle through

```
actions+=/moonfire,cycle_targets=1,max_cycle_targets=3,if=!ticking
```

- **target_if**: Selects a target based on expression value
  - _first_ (default): Selects first target for which expression is nonzero
  - _min_: Selects target with minimal expression value
  - _max_: Selects target with maximal expression value

```
actions+=/agony,target_if=refreshable
actions+=/agony,target_if=min:remains,if=refreshable
```

### Usage on Specific Events Only

- **buff.bloodlust.react** (default: 0): Action usable only when bloodlust is active

```
actions+=/recklessness,if=buff.bloodlust.react=1
```

- **target.debuff.invulnerable.react** (default: 0): Action usable only when target is invulnerable

```
actions+=/wait,sec=0.5,target.debuff.invulnerable.react=1
```

- **target.debuff.vulnerable.react** (default: 0): Action usable only when target is vulnerable

```
actions+=/recklessness,if=target.debuff.vulnerable.react=1
```

- **target.debuff.flying.react** (default: 0): Action usable only when target is flying

```
actions+=/black_arrow,if=target.debuff.flying.react=1
actions+=/explosive_trap,if=target.debuff.flying.react=0
```

- **moving** (default: -1): Action usable only when players are moving (_moving=1_) or not moving (_moving=0_)

```
actions+=/typhoon,moving=1
```

- **prev**: Returns the previous foreground action executed

```
actions+=/pyroblast,if=prev.fireball
```

- **prev_gcd**: Returns only the previous action that used a GCD

```
actions+=/whirlwind,if=prev_gcd.1.whirlwind
```

- **prev_off_gcd**: Returns all off gcd actions since previous gcd was executed

```
actions+=/recklessness,if=prev_off_gcd.bloodbath
```

### Time-Based Usages

- **time**: Action usable only when elapsed time is between specified bounds

```
actions+=/bloodlust,if=time>=20
```

- **time_to_Xpct**: Action usable when estimated remaining time is between specified bounds
  - time_to_die converts to time_to_0pct

```
actions+=/bloodlust,if=time_to_die<60
actions+=/recklessness,if=time_to_20pct>180
```

- **line_cd**: Forces length of time to pass after executing an action before it can execute again

```
actions+=/soulburn,line_cd=20,if=buff.dark_soul.up
actions+=/soulburn,if=target.health.pct<=20&dot.unstable_affliction.ticks_remain<=1
```

### Cooldowns Synchronization

- **sync** (default: ""): Flags an action as unusable while another specified action is not ready

```
actions+=/recklessness,sync=death_wish
```

### Health Restrictions

- **target.health.pct**: Action usable only when target's health percentage is between specified bounds

```
actions+=/bloodlust,target.health.pct<25
```

### Channeling

- **interrupt**: When set to non-zero, interrupts channeling when another action with higher priority is ready

```
actions+=/mind_flay,interrupt=1
```

- **interrupt_if**: Interrupts channeling if higher priority action is ready, GCD has elapsed, and conditions are met

```
actions+=/mind_flay,interrupt_if=cooldown.mind_blast.remains<1
```

- **interrupt_immediate**: Immediately interrupts channeled action with _interrupt_if_ expression, even if GCD has not elapsed

- **chain**: Re-casts a channeled spell at the beginning of its last tick

```
actions+=/mind_flay,chain=1
```

- **early_chain_if**: Same as _chain_ but only chains if expression is true and can chain at any tick

```
actions+=/mind_flay_insanity,interrupt=1,chain=1,early_chain_if=dot.devouring_plague_tick.remains<=tick_time
```

- **interrupt_global**: When set to 1 (default 0), forces lookup for higher priority action in global action list

### Non-Standard Timing

Use _use_off_gcd_ for off-GCD actions:

```
actions+=/freeze,use_off_gcd=1,if=action.ice_lance.in_flight
```

Use _use_while_casting_ for actions during casts:

```
actions+=/combustion,use_while_casting=1,if=action.pyroblast.executing&action.pyroblast.execute_remains<0.5
```

### Tweaking Out the Flight Speed

- **travel_speed** (default: in-game flight speed): Flight speed in yards per second

```
actions+=/fireball,travel_speed=0
```

### Sequences Behaviour

- **wait_on_ready** (default: -1): When equal to 1, restarts at beginning if spell is not ready

```
actions+=/wrath,wait_on_ready=1,if=eclipse_dir=-1
actions+=/starfire
actions+=/wild_mushroom,moving=1,if=buff.wild_mushroom.stack<3
actions+=/moonfire,moving=1
actions+=/sunfire,moving=1
```

## Raid Event Expressions

Current list of raid event types:

- _adds_
- _move_enemy_
- _casting_
- _distraction_
- _invul_ or _invulnerable_
- _interrupt_
- _movement_ or _moving_
- _damage_
- _heal_
- _stun_
- _position_switch_
- _flying_
- _damage_taken_debuff_
- _damage_done_buff_

Available expressions for raid events:

- _in_: How long until next raid event
- _duration_: How long the event will last
- _cooldown_: How long until cooldown ends
- _distance_: How far away the event is
- _max_distance_: Max distance during active event
- _min_distance_: Min distance during active event
- _amount_: Amount of damage (damage events only)
- _to_pct_: Healing event expression
- _count_: How many adds are active (add events only)
- _up_: Returns 1 if event is currently active
- _exists_: Returns 1 if event exists at some point
- _remains_: How long current event will last, or 0

### Examples

```
actions+=/unholy_nova,if=!raid_event.adds.up|raid_event.adds.remains>=15
actions+=/shadow_crash,if=raid_event.adds.in>10
actions+=/void_torrent,if=raid_event.movement.in>3
```

## Conditional Expressions

See the article on Conditional expressions for an in-depth guide on how to conditionally filter actions in an action priority list.
