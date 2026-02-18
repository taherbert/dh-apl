// Deterministic game state engine for VDH Annihilation gap analysis.
// Models all relevant game state (resources, buffs, cooldowns) without RNG.
// Proc rates (VF building stacks, Fallout) are modeled as expected value.
//
// buildConfig shape:
//   heroTree: "annihilator" | "aldrachi_reaver"
//   apexRank: 0-3 (Untethered Rage ranks)
//   haste: 0.0-1.0 (e.g. 0.20 = 20% haste)
//   target_count: integer (number of targets)
//   talents: { [name]: boolean } — talent flags

// GCD duration in seconds (min 0.75 by game rules)
export function gcdDuration(haste) {
  return Math.max(0.75, 1.5 / (1 + haste));
}

// Fragment cap: 5 base (SPEC_CONFIG resource cap is 6, but effective max before UR is 5)
// With apex.3 (UR), consume up to 6 fragments with SpB
function fragCap(buildConfig) {
  return 6; // Always 6 hard cap; SpB consume limit differs
}

function spbMaxConsume(buildConfig) {
  return buildConfig.apexRank >= 3 ? 6 : 5;
}

// ---------------------------------------------------------------------------
// State factory
// ---------------------------------------------------------------------------

export function createInitialState(buildConfig) {
  const haste = buildConfig.haste ?? 0.2;
  const target_count = buildConfig.target_count ?? 1;

  return {
    t: 0,
    fury: 20, // Approximate post-precombat fury
    soul_fragments: 0,

    // Voidfall state machine (Annihilator)
    // Both are tracked as buff stacks in the main buffs dict
    // and separately for easy access
    vf_building: 0, // 0-3 stacks of voidfall_building
    vf_spending: 0, // 0-3 stacks of voidfall_spending

    // VF proc accumulator for deterministic 35% Fracture proc
    _vf_frac: 0,

    // Buff remaining durations (seconds; 0 = inactive)
    buffs: {
      metamorphosis: 0,
      untethered_rage: 0,
      immolation_aura: 0,
      seething_anger: 0, // stacking BLP buff; stacks tracked separately
      voidfall_building: 0, // not time-based, but tracked for compat
      voidfall_spending: 0,
    },

    // Stack counts for stacking buffs
    buffStacks: {
      voidfall_building: 0,
      voidfall_spending: 0,
      seething_anger: 0,
    },

    // DoTs on target (remaining duration)
    dots: {
      fiery_brand: 0,
    },

    // Debuffs on target
    debuffs: {
      frailty: 0,
    },

    // Cooldown remaining (seconds; 0 = ready)
    // Reflects post-precombat state: SoF was cast in precombat (~30s CD remaining),
    // SoS/SC/FB/FelDev/Meta all start ready (none used precombat).
    cooldowns: {
      metamorphosis: 0,
      fel_devastation: 0,
      fiery_brand: 0,
      soul_carver: 0,
      sigil_of_spite: 0,
      sigil_of_flame: 30, // Cast in precombat
      felblade: 0,
    },

    // Multi-charge spell tracking
    // One IA charge used in precombat; one remaining with recharge started.
    charges: {
      fracture: 2,
      immolation_aura: 1,
    },

    // Time until next charge (only relevant when charges < max)
    recharge: {
      fracture: 4.5,
      immolation_aura: 28, // ~2s into recharge after precombat cast
    },

    // Previous GCDs for prev_gcd.N.ability checks
    prev_gcd: null,
    prev_gcd_2: null,

    // Fury cap changes in Meta
    fury_cap: 100,

    // Simulation config (immutable)
    buildConfig,
    gcd: gcdDuration(haste),
    target_count,
  };
}

// ---------------------------------------------------------------------------
// Time advance — tick all timers by dt seconds
// ---------------------------------------------------------------------------

export function advanceTime(state, dt) {
  if (dt <= 0) return state;
  const s = cloneState(state);

  s.t += dt;

  // Tick cooldowns (floor at 0)
  for (const key of Object.keys(s.cooldowns)) {
    s.cooldowns[key] = Math.max(0, s.cooldowns[key] - dt);
  }

  // Tick buff durations
  for (const key of Object.keys(s.buffs)) {
    if (s.buffs[key] > 0) {
      s.buffs[key] = Math.max(0, s.buffs[key] - dt);
      if (s.buffs[key] === 0) {
        // Buff expired
        if (key === "metamorphosis") {
          s.fury_cap = 100;
        }
      }
    }
  }

  // Tick DoTs
  for (const key of Object.keys(s.dots)) {
    if (s.dots[key] > 0) {
      s.dots[key] = Math.max(0, s.dots[key] - dt);
    }
  }

  // Tick debuffs
  for (const key of Object.keys(s.debuffs)) {
    if (s.debuffs[key] > 0) {
      s.debuffs[key] = Math.max(0, s.debuffs[key] - dt);
    }
  }

  // Tick Immolation Aura: fury generation (+3/s while active)
  if (s.buffs.immolation_aura > 0) {
    const iaFury = Math.min(dt * 3, s.fury_cap - s.fury);
    s.fury = Math.min(s.fury_cap, s.fury + iaFury);

    // Fallout: 60% chance per tick to grant 1 soul fragment
    // Expected value: +0.6 frags/s while IA is active
    const falloutFrac = dt * 0.6;
    s._fallout_frac = (s._fallout_frac || 0) + falloutFrac;
    while (
      s._fallout_frac >= 1.0 &&
      s.soul_fragments < fragCap(s.buildConfig)
    ) {
      s._fallout_frac -= 1.0;
      s.soul_fragments++;
    }

    // Charred Flesh: each tick extends Fiery Brand by 0.25s
    if (s.buildConfig.talents?.charred_flesh && s.dots.fiery_brand > 0) {
      s.dots.fiery_brand += dt * 0.25;
    }
  }

  // Recharge multi-charge spells
  for (const spell of ["fracture", "immolation_aura"]) {
    if (s.charges[spell] < 2) {
      s.recharge[spell] -= dt;
      const baseRecharge = spell === "fracture" ? 4.5 : 30;
      while (s.recharge[spell] <= 0 && s.charges[spell] < 2) {
        s.charges[spell]++;
        if (s.charges[spell] < 2) {
          s.recharge[spell] += baseRecharge;
        } else {
          s.recharge[spell] = baseRecharge;
        }
      }
    }
  }

  // Sync vf_building / vf_spending from buffStacks (keep in sync)
  s.vf_building = s.buffStacks.voidfall_building;
  s.vf_spending = s.buffStacks.voidfall_spending;

  return s;
}

// ---------------------------------------------------------------------------
// Apply ability — returns new state after casting the ability
// ---------------------------------------------------------------------------

export function applyAbility(state, abilityId) {
  const s = cloneState(state);
  const cfg = s.buildConfig;
  const inMeta = s.buffs.metamorphosis > 0;

  // Shift prev_gcd history (off-GCD abilities don't shift)
  const isOffGcd = OFF_GCD_ABILITIES.has(abilityId);
  if (!isOffGcd) {
    s.prev_gcd_2 = s.prev_gcd;
    s.prev_gcd = abilityId;
  }

  switch (abilityId) {
    case "fracture": {
      const furyGain = inMeta ? 40 : 25;
      const fragGain = inMeta ? 3 : 2;

      s.fury = Math.min(s.fury_cap, s.fury + furyGain);
      s.soul_fragments = Math.min(fragCap(cfg), s.soul_fragments + fragGain);

      // Consume a charge
      _consumeCharge(s, "fracture", 4.5);

      // VF building: 35% proc chance per Fracture (expected value model)
      if (s.buffStacks.voidfall_spending === 0) {
        s._vf_frac += 0.35;
        while (s._vf_frac >= 1.0) {
          s._vf_frac -= 1.0;
          if (s.buffStacks.voidfall_building < 3) {
            s.buffStacks.voidfall_building++;
          }
        }
      }
      break;
    }

    case "spirit_bomb": {
      if (s.fury < 40) break; // Can't cast — not enough fury
      s.fury -= 40;

      // Consume fragments (up to 5 or 6 depending on apex)
      const maxConsume = spbMaxConsume(cfg);
      const consumed = Math.min(s.soul_fragments, maxConsume);
      s.soul_fragments = Math.max(0, s.soul_fragments - consumed);

      // Apply Frailty debuff (~6s)
      s.debuffs.frailty = 6;

      // VF state machine transitions
      _applyVfSpender(s, "spirit_bomb");
      break;
    }

    case "soul_cleave": {
      if (s.fury < 35) break;
      s.fury -= 35;

      // Consume up to 2 fragments
      const consumed = Math.min(2, s.soul_fragments);
      s.soul_fragments = Math.max(0, s.soul_fragments - consumed);

      // VF spending increment
      _applyVfSpender(s, "soul_cleave");
      break;
    }

    case "metamorphosis": {
      // Off-GCD: doesn't consume GCD or shift prev_gcd
      s.buffs.metamorphosis = 15;
      s.cooldowns.metamorphosis = 180;
      s.fury_cap = 120; // Chaotic Transformation: +20 fury cap

      // Mass Acceleration: reset Fracture charges
      s.charges.fracture = 2;
      s.recharge.fracture = 4.5;

      // Instantly grant 3 VF building stacks (if not in spending)
      if (s.buffStacks.voidfall_spending === 0) {
        s.buffStacks.voidfall_building = 3;
      }

      // Consume Untethered Rage buff if it was the trigger
      if (s.buffs.untethered_rage > 0) {
        s.buffs.untethered_rage = 0;
        s.buffStacks.seething_anger = 0;
      }

      // Clear seething_anger BLP stacks on Meta cast
      s.buffStacks.seething_anger = 0;
      break;
    }

    case "fel_devastation": {
      if (s.fury < 50) break;
      s.fury -= 50;

      // Meteoric Rise: +3 soul fragments from FelDev
      if (cfg.talents?.meteoric_rise) {
        s.soul_fragments = Math.min(fragCap(cfg), s.soul_fragments + 3);
      }

      // Darkglare Boon: refunds ~25% of CD on average (40s × 0.75 = 30s)
      const baseCd = 40;
      const effectiveCd = cfg.talents?.darkglare_boon ? baseCd * 0.75 : baseCd;
      s.cooldowns.fel_devastation = effectiveCd;

      // FelDev is a 2s channel — caller should advance time by 2s after this
      // We set a flag for the interpreter to handle
      s._feldev_channel = 2;
      break;
    }

    case "fiery_brand": {
      s.dots.fiery_brand = 10; // Base 10s, extended by Charred Flesh
      s.cooldowns.fiery_brand = 60;
      break;
    }

    case "soul_carver": {
      s.soul_fragments = Math.min(fragCap(cfg), s.soul_fragments + 3);
      s.cooldowns.soul_carver = 60; // Base 60s; Soul Carver CD (30s in spec resourceModels — likely wrong there, use 60)
      break;
    }

    case "sigil_of_spite": {
      // 3 frags, +1 with Soul Sigils talent
      const fragGain = cfg.talents?.soul_sigils ? 4 : 3;
      s.soul_fragments = Math.min(fragCap(cfg), s.soul_fragments + fragGain);
      s.cooldowns.sigil_of_spite = 60;
      break;
    }

    case "immolation_aura": {
      _consumeCharge(s, "immolation_aura", 30);
      s.buffs.immolation_aura = 6;
      // Fury ticking handled by advanceTime
      break;
    }

    case "sigil_of_flame": {
      s.cooldowns.sigil_of_flame = 30;
      // SoF generates frags via Fallout — modeled via IA-like proc in advanceTime
      // Direct damage is minor; soul fragments arrive with travel time
      // For simplicity, model as small immediate fragment chance
      if (cfg.talents?.fallout) {
        s.soul_fragments = Math.min(fragCap(cfg), s.soul_fragments + 1);
      }
      break;
    }

    case "felblade": {
      s.fury = Math.min(s.fury_cap, s.fury + 15);
      s.cooldowns.felblade = 15;
      break;
    }

    case "throw_glaive": {
      // Minor damage, no resource interaction
      s.cooldowns.throw_glaive = 9;
      break;
    }

    case "demon_spikes":
    case "infernal_strike":
    case "auto_attack":
    case "disrupt":
      // Defensives/utility — no APL-relevant resource changes
      break;
  }

  // Sync vf fields from buffStacks for easy access
  s.vf_building = s.buffStacks.voidfall_building;
  s.vf_spending = s.buffStacks.voidfall_spending;

  return s;
}

// VF spender state machine: handles spirit_bomb and soul_cleave transitions
function _applyVfSpender(s, ability) {
  if (
    s.buffStacks.voidfall_building === 3 &&
    s.buffStacks.voidfall_spending === 0
  ) {
    // Building → Spending transition
    s.buffStacks.voidfall_building = 0;
    s.buffStacks.voidfall_spending = 1;
  } else if (
    s.buffStacks.voidfall_spending > 0 &&
    s.buffStacks.voidfall_spending < 3
  ) {
    // Spending phase: increment stacks
    s.buffStacks.voidfall_spending++;
  } else if (s.buffStacks.voidfall_spending === 3) {
    // Final dump (SpB only for big hit) — clear spending phase
    if (ability === "spirit_bomb") {
      s.buffStacks.voidfall_spending = 0;
    }
    // SC at spending=3 shouldn't happen per APL, but handle gracefully
  }
  // If building < 3 and spending = 0: no VF effect on this cast
}

// Consume one charge of a multi-charge spell
function _consumeCharge(s, spell, rechargeBase) {
  if (s.charges[spell] > 0) {
    if (s.charges[spell] === 2) {
      // Had full charges: start recharge
      s.recharge[spell] = rechargeBase;
    }
    // else recharge is already running; next charge adds rechargeBase to it
    s.charges[spell]--;
  }
}

// ---------------------------------------------------------------------------
// Get available abilities — list of abilities that can be cast right now
// ---------------------------------------------------------------------------

export function getAvailable(state) {
  const available = [];
  const s = state;
  const cfg = s.buildConfig;

  // Fracture: requires charges
  if (s.charges.fracture > 0) available.push("fracture");

  // Spirit Bomb: requires fury + fragments
  if (s.fury >= 40 && s.soul_fragments >= 1) available.push("spirit_bomb");

  // Soul Cleave: requires fury
  if (s.fury >= 35) available.push("soul_cleave");

  // Metamorphosis: off-GCD, requires CD ready
  if (s.cooldowns.metamorphosis <= 0) available.push("metamorphosis");

  // Fel Devastation: requires fury + CD
  if (s.fury >= 50 && s.cooldowns.fel_devastation <= 0)
    available.push("fel_devastation");

  // Fiery Brand: requires CD + talent
  if (cfg.talents?.fiery_brand !== false && s.cooldowns.fiery_brand <= 0)
    available.push("fiery_brand");

  // Soul Carver: requires CD + talent
  if (cfg.talents?.soul_carver && s.cooldowns.soul_carver <= 0)
    available.push("soul_carver");

  // Sigil of Spite: requires CD
  if (s.cooldowns.sigil_of_spite <= 0) available.push("sigil_of_spite");

  // Immolation Aura: requires charges
  if (s.charges.immolation_aura > 0) available.push("immolation_aura");

  // Sigil of Flame: requires CD
  if (s.cooldowns.sigil_of_flame <= 0) available.push("sigil_of_flame");

  // Felblade: requires CD
  if (s.cooldowns.felblade <= 0) available.push("felblade");

  // Throw Glaive: always available as filler
  available.push("throw_glaive");

  return available;
}

// ---------------------------------------------------------------------------
// DPGCD scoring — relative damage per GCD for scoring purposes
// Fire abilities benefit from Fiery Demise (+30% fire amp while FB DoT is up)
// ---------------------------------------------------------------------------

// Abilities that deal Fire school damage (benefit from Fiery Demise)
const FIRE_ABILITIES = new Set([
  "fel_devastation",
  "soul_carver",
  "immolation_aura",
  "sigil_of_flame",
  "fiery_brand",
]);

// Base DPGCD scores (Fracture = 100 reference)
// Derived from AP coefficients in SPEC_CONFIG.domainOverrides:
//   Fracture: 1.035 AP → 100 units
//   SpB: 0.4 AP × frags → scales with frags
//   SC: 1.29 AP
//   FelDev: 1.54 AP
//   Soul Carver: 2.08 AP
//   SoS: 6.92 AP
export function scoreDpgcd(state, abilityId) {
  const s = state;
  const cfg = s.buildConfig;
  const inMeta = s.buffs.metamorphosis > 0;
  const fbActive = s.dots.fiery_brand > 0 && cfg.talents?.fiery_demise;
  const vfSpending = s.buffStacks?.voidfall_spending ?? s.vf_spending ?? 0;

  const fireAmp = fbActive ? 1.3 : 1.0;
  const metaAmp = inMeta ? 1.2 : 1.0;

  let score = 0;

  switch (abilityId) {
    case "fracture":
      // 1.035 AP coefficient; generates fury/frags (future value captured by rollout)
      score = 100 * metaAmp;
      break;

    case "spirit_bomb": {
      const consumed = Math.min(s.soul_fragments, spbMaxConsume(cfg));
      // 0.4 AP per fragment consumed (from SPEC_CONFIG)
      // Normalized: at 5 frags = 193, at 4 = 154, at 3 = 116
      score = Math.max(0, consumed) * 38.5;
      // Voidfall dump (spending=3): triggers Catastrophe (extra Soul Cleave hit).
      // Soul Cleave = 1.29 AP → ~125 normalized (vs Fracture 1.035 = 100 base).
      // Using the actual Catastrophe AP equivalent keeps scoring calibrated.
      if (vfSpending === 3) score += 125;
      break;
    }

    case "soul_cleave":
      // 1.29 AP → 125 relative to Fracture
      score = 125 * metaAmp;
      // During Voidfall spending phase (pre-dump): SC increments spending stack
      // while preserving fragments for the dump SpB. Needs enough bonus to beat
      // SpB's immediate score at any typical frag count (SpB max = 5×38.5=192.5).
      if (vfSpending > 0 && vfSpending < 3) score += 100;
      break;

    case "fel_devastation":
      // 1.54 AP → 149, fire school → fire amp applies
      score = 149 * fireAmp * metaAmp;
      // Meteoric Rise frags add future SpB value; captured by rollout
      break;

    case "soul_carver":
      // 2.08 AP → 201, fire school
      score = 201 * fireAmp * metaAmp;
      break;

    case "sigil_of_spite":
      // 6.92 AP → 669, but not fire school
      score = 669 * metaAmp;
      break;

    case "fiery_brand":
      // Modest immediate damage (~1.0 AP) but enables fire amp for future casts
      // Future value captured by rollout (it sees FelDev/SC firing at 1.3×)
      score = 100 * fireAmp;
      break;

    case "immolation_aura":
      // ~1.0 AP immediate + fury regen + Charred Flesh extension + Fallout frags
      score = 95 * fireAmp * metaAmp;
      break;

    case "sigil_of_flame":
      // 0.792 AP → 77, fire school
      score = 77 * fireAmp * metaAmp;
      break;

    case "felblade":
      // Small damage + fury gen (future value in SpB capability)
      score = 60 * metaAmp;
      break;

    case "throw_glaive":
      score = 40 * metaAmp;
      break;

    case "metamorphosis":
      // Off-GCD: grants Meta window value; immediate = 0 damage but enables massive future
      // Capture as large rollout bonus, not immediate score
      score = 0;
      break;

    default:
      score = 0;
  }

  return score;
}

// ---------------------------------------------------------------------------
// Ability metadata
// ---------------------------------------------------------------------------

// Abilities that don't consume a GCD (use_off_gcd=1 in SimC APL)
export const OFF_GCD_ABILITIES = new Set(["metamorphosis", "infernal_strike"]);

// Ability GCD consumption (in seconds; 0 = no GCD)
export function getAbilityGcd(state, abilityId) {
  if (OFF_GCD_ABILITIES.has(abilityId)) return 0;
  return state.gcd;
}

// Is this ability currently castable?
export function isCastable(state, abilityId) {
  return getAvailable(state).includes(abilityId);
}

// Human-readable ability name
export function abilityLabel(id) {
  return id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// State cloning (shallow with nested copies for mutable fields)
// ---------------------------------------------------------------------------

function cloneState(s) {
  return {
    ...s,
    buffs: { ...s.buffs },
    buffStacks: { ...s.buffStacks },
    dots: { ...s.dots },
    debuffs: { ...s.debuffs },
    cooldowns: { ...s.cooldowns },
    charges: { ...s.charges },
    recharge: { ...s.recharge },
    // buildConfig is immutable, share the reference
  };
}

export { cloneState };

// ---------------------------------------------------------------------------
// Off-GCD trigger — VDH-specific logic for when Meta should fire.
// Returns "metamorphosis" if Meta should fire this GCD, null otherwise.
// Called by the optimal-timeline rollout before each on-GCD decision.
// ---------------------------------------------------------------------------

export function getOffGcdTrigger(state) {
  const cfg = state.buildConfig;
  const metaReady = state.cooldowns.metamorphosis <= 0;
  const inMeta = state.buffs.metamorphosis > 0;
  const vfSpending = state.buffStacks.voidfall_spending;

  if (!metaReady) return null;
  if (vfSpending > 0) return null; // Never interrupt VF spending phase

  // UR proc: fire immediately — any delay risks losing the 12s buff
  if (state.buffs.untethered_rage > 0) return "metamorphosis";

  // Standard Meta: not in Meta, frags >= 3 for immediate SpB on entry
  if (!inMeta && state.soul_fragments >= 3) return "metamorphosis";

  // Standard Meta: not in Meta, burst SpB was just cast (prev_gcd guard)
  if (!inMeta && state.prev_gcd === "spirit_bomb") return "metamorphosis";

  // Meta chaining (apex.3 only): hardcast during active Meta when vf_building=0
  if (inMeta && cfg.apexRank >= 3 && state.buffStacks.voidfall_building === 0) {
    return "metamorphosis";
  }

  return null;
}
