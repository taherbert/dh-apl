// Vengeance DH base abilities granted by spec (not from talent tree).
// These are find_specialization_spell() and find_spell() calls in the simc C++ source.
export const BASE_SPELL_IDS = new Set([
  228477, // Soul Cleave
  228478, // Soul Cleave (damage component)
  258920, // Immolation Aura
  204596, // Sigil of Flame
  203720, // Demon Spikes
  203819, // Demon Spikes (buff)
  187827, // Metamorphosis (Vengeance)
  198793, // Vengeful Retreat
  185123, // Throw Glaive
  203782, // Shear
  263642, // Fracture
  189112, // Infernal Strike (impact)
  320378, // Immolation Aura CDR
  247455, // Spirit Bomb damage
  247456, // Frailty debuff
  203981, // Soul Fragments
  207744, // Fiery Brand debuff
  343010, // Fiery Brand modifier
]);

// Set bonus spells — separate from base abilities since these come from gear,
// not the spec itself. Included in spell extraction so they appear in spells.json.
export const SET_BONUS_SPELL_IDS = new Set([
  1264808, // Vengeance 12.0 Class Set 2pc
  1264809, // Vengeance 12.0 Class Set 4pc
  1276488, // Explosion of the Soul (4pc proc) — 1.8x AP Fire AoE, 12yd radius
]);
