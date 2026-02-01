# Action List Expressions

Source: https://github.com/simulationcraft/simc/wiki/Action-List-Conditional-Expressions

## Conditional Expressions

Conditional expressions enable sophisticated condition composition, typically integrated into action priority lists via the "if" keyword:

```
actions+=/faerie_fire,if=debuff.faerie_fire.stack<3&!(debuff.sunder_armor.up|debuff.expose_armor.up)
```

This same syntax applies to `interrupt_if` action modifiers and the `sec` modifier for `wait_fixed` actions. Raid event `player_if` filters also utilize Player Expressions.

## Operators

### Simple Example

`&` represents "AND", `!` represents "NOT", and `|` represents "OR":

```
debuff.faerie_fire.stack LESS THAN 3 AND NOT(debuff.sunder_armor.up OR debuff.expose_armor.up)
```

### Operator Precedence

Complete operator precedence list (highest to lowest):

- Function calls: `floor()` `ceil()`
- Unary operators: `+` `-` `@` `!`
- Multiplication, division, modulus: `*` `%` `%%`
- Addition, subtraction: `+` `-`
- Max/min: `<?` `>?`
- Comparison: `=` `!=` `<` `<=` `>` `>=` `~` `!~`
- Logical AND: `&`
- Logical XOR: `^`
- Logical OR: `|`

### Arithmetic Operators

All expressions evaluate to double-precision floating-point numbers:

- `+` addition; as unary, no-op
- `-` subtraction; as unary, negation
- `*` multiplication
- `%` division (note: `/` is reserved as separator token)
- `%%` modulus
- `@` absolute value
- `<?` maximum of two values
- `>?` minimum of two values
- `floor(x)` greatest integer <= x
- `ceil(x)` least integer >= x

### Comparison Operators

- `=` evaluates to 1 if equal, 0 otherwise
- `!=` evaluates to 1 if unequal, 0 otherwise
- `<` `<=` `>` `>=` relational comparisons

### Logical Operators

Zero is false; any nonzero value is true:

- `&` (AND): returns 1 if both operands nonzero
- `|` (OR): returns 1 if either operand nonzero
- `^` (XOR): returns 1 if operands differ in truthiness
- `!` (NOT): returns 1 if operand is zero

### Important Note on Booleans

No distinct boolean type exists. All expressions evaluate as floating-point:

- `3&4` evaluates to `1`
- `(a==b)*c` evaluates to `c` if equal, `0` otherwise

### SpellQuery Operators

- `~` (string "in"): true if first string is substring of second
- `!~` (string "not in"): true if first string isn't substring of second

## Operands

### Actions

- `execute_time`: greater of gcd or cast_time
- `gcd`: gcd-time for current action accounting for haste
- `gcd.remains`: time until player's gcd readies
- `gcd.max`: hasted gcd-time of the player
- `cast_time`: execution duration in seconds
- `cooldown`: initial cooldown duration
- `ticking`: 1 if dot/hot active on target
- `ticks`: ticks completed since last refresh
- `ticks_remain`: remaining ticks before expiration
- `remains`: remaining duration in seconds (does NOT apply to buffs/debuffs)
- `full_recharge_time`: time until all charges fully recharge
- `tick_time`: seconds between ticks at current haste
- `travel_time`: timespan for spell to reach target
- `miss_react`: 1 if last occurrence missed or never used
- `cooldown_react`: 1 if cooldown elapsed or reaction time satisfied
- `cast_delay`: 1 if sufficient time elapsed after previous action
- `multiplier`: player's highest damage/healing multiplier for spell schools
- `casting`: 1 if action currently casting
- `channeling`: 1 if action currently channeling
- `executing`: 1 if action casting or channeling

```
actions+=/golemblood_potion,if=multiplier>1.3
```

### Buffs and Debuffs

Syntax: `buff.<aura_name>.<aura_property>` or `debuff.<aura_name>.<aura_property>`

The `debuff` syntax checks the target first, then the player; `buff` syntax checks only the player.

Properties:

- `remains`: remaining duration in seconds (zero for infinite)
- `cooldown_remains`: remaining spell cooldown
- `up`: 1 when active, 0 otherwise
- `down`: 0 when active, 1 otherwise
- `stack`: current stack count
- `max_stack`: maximum possible stacks
- `at_max_stack`: 1 when at maximum stacks
- `stack_pct`: 100 \* stack / max_stack
- `react`: stack count accounting for reaction time
- `value`: buff's value

Special buffs: "bleeding", "casting", "flying", "raid_movement", "self_movement", "stunned", "invulnerable", "vulnerable", "mortal_wounds", "damage_taken"

Potion-based buffs accessible via `potion` alias (e.g., `buff.potion.up`).

### Trinket Procs

Syntax: `trinket[.1|2|name].has_stacking_stat._stat_` or `trinket[.1|2|name].stat._stat_.<buff_expr>`

```
trinket.2.has_stacking_stat.agility
trinket.has_stat.strength
trinket.1.stacking_stat.agility.stack>10
trinket.2.stat.mastery.value>3000
```

### Trinket Cooldowns

Syntax: `trinket.(has_|)cooldown.<cooldown_expr>`

NOTE: This syntax doesn't evaluate against the 20-second lockout for on-use items. Check `trinket[1|2|name].ready_cooldown` for both cooldown and lockout.

```
actions+=/ascendance,if=!trinket.has_cooldown|trinket.cooldown.remains>10
```

### Character Properties

- `level`: player level
- `name` and `self`: unique actor index
- `in_combat`: zero when not in combat, 1 otherwise
- `ptr`: zero for live, 1 for ptr
- `bugs`: zero when disabled, 1 when enabled
- `is_add`: true if player is an add
- `is_enemy`: true if player is an enemy
- `spell_haste` and `attack_haste`: haste factors
- `attack_speed`: attack speed
- `mastery_value`: mastery value
- `position_front`/`position_back`: positional checks
- `time_to_bloodlust`: time until next bloodlust
- `raw_haste_pct`: raw haste percentage
- `incoming_damage_X`: damage taken in past X seconds
- `incoming_magic_damage_X`: magical damage taken in past X seconds
- `time_to_die`: estimated time before player dies
- `time_to_pct<health_pct>`: estimated time to reach health percentage

### Resource Expressions

- `rage`, `mana`, `energy`, `focus`, `runic_power`, `health`, `soul_shards`: current values
- `<resource>.max`: maximum amount
- `<resource>.pct`: percentage (0-100)
- `<resource>.deficit`: points lacking for full bar
- `<resource>.max_nonproc`: value before proc factors
- `<resource>.pct_nonproc`: percentage without procs
- `<resource>.regen`: points regenerated per second
- `<resource>.time_to_max`: time to fully regenerate
- `<resource>.time_to_x`: time to regenerate to x
- `<resource>.net_regen`: net regen since combat started
- `stat.<x>`: value of specific stat

```
actions+=/heroic_strike,if=rage>60
actions+=/some_expensive_spell,if=mana.pct>50
```

### Split Expressions

#### 2 Parts

- `variable.<variablename>`: current value of player's variable
- `equipped.<item_id|item_name|effect_name>`: true if equipped
- `main_hand._1h_`, `main_hand._2h_`, `off_hand._1h_`, `off_hand._2h_`: weapon type checks
- `race.<racename>`: true if race matches
- `spec.<spec_name>`: true if spec matches
- `role.<role_name>`: true if role matches (attack, heal, spell, tank)
- `stat.<stat_name>`: returns stat amount
- `using_apl.<apl_name>`: true if apl explicitly used
- `active_dot.<dot_name>`: number of dots on all targets
- `movement._remains_`/`._distance_`/`._speed_`: movement properties

#### 3 Parts

- `spell.<spell_name>._exists_`: true if spell exists
- `talent.<talent_name>._enabled_`: true if talent active
- `talent.<talent_name>._rank_`: current talent rank (0 if not talented)
- `artifact.<artifact_spell_name>._enabled_`: true if active
- `artifact.<artifact_spell_name>._rank_`: active rank

### Set Bonuses

```
actions+=/some_spell,if=set_bonus.tier21_4pc
```

### Cooldowns

Syntax: `cooldown.<spell_name>.<property>`

- `duration`: initial cooldown duration
- `remains`: remaining duration
- `up` or `ready`: cooldown is done
- `charges`: current charge count
- `charges_fractional`: charges including fractional
- `full_recharge_time`: time until all charges ready
- `max_charges`: maximum charge count
- `duration_expected`/`remains_expected`: adjusted for cooldown mechanics

```
actions+=/aimed_shot,if=cooldown.chimera_shot.remains>5
```

### Dots

Syntax: `dot.<dot_name>.<property>`

- `duration`: initial duration (0 if not ticking)
- `modifier`: damage/healing modifier
- `remains`: remaining duration
- `refreshable`: 1 if refreshing wouldn't waste duration
- `ticking`: 1 if active on target
- `ticks_added`: additional ticks while active
- `tick_dmg`: non-critical damage of last tick
- `ticks_remain`: remaining ticks
- `spell_power`/`attack_power`: last snapshot values
- `multiplier`: last multiplier excluding dynamic target multipliers
- `haste_pct`: last haste multiplier
- `current_ticks`: total ticks for current application
- `ticks`: ticks completed
- `crit_pct`/`crit_dmg`: last critical snapshot values
- `tick_time_remains`: remaining time on ongoing tick

```
actions+=/howling_blast,if=dot.frost_fever.remains<=2
```

### General

- `time`: elapsed time since fight start
- `active_enemies`: number of active enemy targets
- `expected_combat_length`: expected combat duration

```
actions+=/bloodlust,if=time>20
actions+=/consecration,if=active_enemies>=3
```

### Pet

Syntax: `pet.<pet_name>.<property>`

- `active`: 1 when active, 0 otherwise
- `remains`: remaining time if temporary

Within pet action lists, access owner via: `owner.<property>`

### Raid Events

Syntax: `raid_event.event_type.filter`

Event Types: adds, casting, damage_taken, damage, distraction, flying, heal, interrupt, invulnerable, movement, position_switch, stun, vulnerable

Filters:

- `in`: time until next event
- `amount`: event amount
- `duration`: event duration
- `cooldown`: total cooldown
- `exists`: 1 if event type exists
- `distance`/`max_distance`/`min_distance`: distance values
- `to_pct`: target health pct for heal events
- `up`: true if event currently active
- `remains`: remaining duration of active event

### Spell Flights

- `action.<spell_name>.in_flight`: 1 if flying
- `action.<spell_name>.in_flight_remains`: lowest time until hit
- `action.<spell_name>.in_flight_to_target`: 1 if flying to current target

### Swings

`swing.<weapon>.remains` where weapon is "mh", "oh", "mainhand", "offhand", "main_hand", "off_hand"

### Target Properties

- `target.level`: target's level
- `target.health_pct`: health percent (0-100)
- `target.adds`: number of adds
- `target.distance`: distance to target
- `target.current_target`: target's target
- `target.name`: target's unique identifier

## Related Settings

- **reaction_time** (global; default: 0.5): reaction time in seconds
- **skip_actions** (character; default: ""): comma-separated action names to ignore
- **default_actions** (global; default: 0): when nonzero, uses default action lists
