# SimC Key Struct Definitions

Extracted from simc `midnight` branch for reference.

## `trait_data_t` (engine/dbc/trait_data.hpp)

The core talent data structure. Each talent node entry in the game maps to one `trait_data_t`.

```cpp
struct trait_data_t
{
  unsigned    tree_index;
  unsigned    id_class;
  unsigned    id_trait_node_entry;
  unsigned    id_node;
  unsigned    max_ranks;
  unsigned    req_points;
  unsigned    id_trait_definition;
  unsigned    id_spell;
  unsigned    id_replace_spell;   // id_spell replaces id_replace_spell
  unsigned    id_override_spell;  // id_spell is overridden by id_override_spell for display/activation
  short       row;
  short       col;
  short       selection_index;
  const char* name;
  std::array<unsigned, 4> id_spec;
  std::array<unsigned, 4> id_spec_starter;
  unsigned    id_sub_tree;  // hero talent tree
  unsigned    node_type;    // 0=normal, 1=tiered, 2=choice, 3=sub tree selection
};
```

### Key Static Methods

- `find(trait_node_entry_id)` — Lookup by node entry ID
- `find(tree, name, class_id, spec)` — Lookup by name within a tree
- `find_by_spell(tree, spell_id, class_id, spec)` — Reverse lookup from spell ID
- `get_hero_tree_name(id_sub_tree)` — Get hero tree name from subtree ID
- `get_valid_hero_tree_ids(spec)` — List valid hero trees for a spec

## `player_talent_t` (engine/player/talent.hpp)

The runtime talent wrapper used in class modules. Wraps `trait_data_t` with rank info.

```cpp
class player_talent_t
{
  const player_t*     m_player;
  const trait_data_t* m_trait;
  const spell_data_t* m_spell;
  unsigned            m_rank;

public:
  bool enabled() const;     // rank > 0 && spell->ok()
  bool ok() const;          // alias for enabled()
  unsigned rank() const;
  const trait_data_t* trait() const;
  const spell_data_t* spell() const;
  const spell_data_t* operator->() const;  // access spell data directly
  const spell_data_t* find_override_spell(bool require_talent = true) const;
};
```

### Usage in Class Modules

```cpp
// Declaration in talent struct
player_talent_t spirit_bomb;

// Initialization via find_talent_spell
talent.vengeance.spirit_bomb = find_talent_spell(talent_tree::SPECIALIZATION, "Spirit Bomb");

// Usage in conditions
if (talent.vengeance.spirit_bomb.ok()) { ... }
auto spell = talent.vengeance.spirit_bomb.spell();
unsigned ranks = talent.vengeance.spirit_bomb.rank();
```

## `soul_fragment` enum (sc_demon_hunter.cpp)

Bitmask enum for soul fragment types. Vengeance-specific mechanic.

```cpp
enum class soul_fragment : unsigned
{
  GREATER         = 0x01,
  LESSER          = 0x02,
  GREATER_DEMON   = 0x04,
  EMPOWERED_DEMON = 0x08,

  ANY_GREATER = ( GREATER | GREATER_DEMON | EMPOWERED_DEMON ),
  ANY_DEMON   = ( GREATER_DEMON | EMPOWERED_DEMON ),
  ANY         = 0xFF
};
```

Fragment types: `GREATER` (standard), `LESSER` (weaker), `GREATER_DEMON` (from demon kills), `EMPOWERED_DEMON` (enhanced).
