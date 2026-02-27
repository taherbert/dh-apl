// Havoc Demon Hunter state engine — placeholder.
// Needed before analysis tools (apl-interpreter, divergence, optimal-timeline)
// can run for Havoc. Will be populated during /optimize.

export function gcdDuration(haste) {
  return Math.max(0.75, 1.5 / (1 + haste));
}

export function createInitialState(buildConfig) {
  const haste = buildConfig.haste ?? 0.2;
  const target_count = buildConfig.target_count ?? 1;

  return {
    t: 0,
    fight_end: Infinity,
    fury: 20,
    gcd: gcdDuration(haste),
    target_count,
    prev_gcd: null,
    prev_gcd_2: null,
    buffs: {},
    dots: {},
    debuffs: {},
    cooldowns: {},
    charges: {},
    recharge: {},
    buffStacks: {},
  };
}

export const OFF_GCD_ABILITIES = new Set([]);

export function getAvailable() {
  return [];
}

export function applyAbility(state) {
  return state;
}

export function advanceTime(state, dt) {
  return { ...state, t: state.t + dt };
}

export function getAbilityGcd(state) {
  return state.gcd;
}

export function scoreDpgcd() {
  return 0;
}

export function getOffGcdTrigger() {
  return null;
}
