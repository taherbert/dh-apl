#!/usr/bin/env node
// Comprehensive audit: APL AR look-ahead variables vs GCD-budget model ground truth.
// Tests current APL + proposed fixes across all scenarios.

import { execSync } from 'node:child_process';

// ============================================================
// Constants (must match model + SimC)
// ============================================================
const GCD_BASE = 1.5;
const GCD_MIN = 0.75;
const FRAC_RECHARGE_BASE = 4.5;
const AOTG_TARGET = 20;
const FRAG_CAP = 6;

// ============================================================
// APL Variable Emulator — parameterized for testing variants
// ============================================================
function computeAplVars(s, opts = {}) {
  const gcd = Math.max(GCD_MIN, GCD_BASE / (1 + s.haste));
  const fracDuration = FRAC_RECHARGE_BASE / (1 + s.haste);
  const apex3 = s.apex >= 3 ? 1 : 0;

  const frac_souls = 2 + (s.meta ? 1 : 0);
  const base_deficit = Math.max(AOTG_TARGET - s.aotg - s.frags, 0);
  const fracs_base = Math.ceil(base_deficit / frac_souls);
  const eff_recharge = s.fracCd + (s.fracCharges >= 2 ? 1 : 0) * fracDuration;

  function genTime(fracs) {
    if (fracs <= 0) return 0;
    if (fracs <= s.fracCharges) {
      return fracs * (1 + apex3) * gcd;
    }
    const burstTime = Math.max(s.fracCharges * (1 + apex3) * gcd, eff_recharge);
    const extraFracs = Math.max(fracs - s.fracCharges - 1, 0);
    return burstTime + extraFracs * fracDuration + gcd;
  }

  const base_gen_time = genTime(fracs_base);
  const passive_per_sec = 0.30 + (s.fallout && s.iaActive ? 1 : 0) * 0.30 * s.targets;

  if (opts.mode === 'twopass') {
    // TWO-PASS APPROACH: Correct overhead + convergent passive
    // Overhead = 1 GCD (final SpB dump after last fracture)
    // Burst spends are already in genTime (1+apex3 factor)
    // Recharge spends fit in fracDuration wait time (3.75s > gcd)
    const OH = 1;

    // --- PASS 1: No passive, determine SC/SoS usability and initial time ---
    const sc1 = s.scTalented && s.scCd < base_gen_time ? 1 : 0;
    const net1 = Math.max(base_deficit - sc1 * 6, 0);
    const fracs1 = Math.ceil(net1 / frac_souls);
    const gt1 = genTime(fracs1);
    const sos1 = s.sosTalented && s.sosCd < gt1 ? 1 : 0;
    const N1 = net1 - sos1 * 3;
    const fracs_np = Math.ceil(Math.max(N1, 0) / frac_souls);
    const gt_np = genTime(fracs_np);
    const T1 = OH * gcd + gt_np + sc1 * gcd + sos1 * gcd;

    // --- PASS 2: Use T1 as passive window, re-check SC/SoS ---
    const sc2 = s.scTalented && s.scCd < T1 ? 1 : 0;
    const net2 = Math.max(base_deficit - sc2 * 6, 0);
    const fracs2 = Math.ceil(net2 / frac_souls);
    const gt2 = genTime(fracs2);
    const sos2 = s.sosTalented && s.sosCd < gt2 ? 1 : 0;
    const N2 = net2 - sos2 * 3;
    const passive2 = passive_per_sec * T1;
    const adj2 = Math.max(N2 - passive2, 0);
    const fracs_p2 = Math.ceil(adj2 / frac_souls);
    const gt_p2 = genTime(fracs_p2);
    const T2 = OH * gcd + gt_p2 + sc2 * gcd + sos2 * gcd;

    // If oscillating (T2 < T1 significantly), take max for safety
    const time_to_next_glaive = Math.max(T2, 0);
    const time_to_next_rm_application = time_to_next_glaive + 2 * gcd;

    return {
      gcd, frac_souls, base_deficit, fracs_base, eff_recharge,
      base_gen_time, sc_usable: sc2, net_deficit: net2, fracs_raw: fracs2,
      gen_time_raw: gt2, sos_usable: sos2, passive_per_sec,
      adj_deficit: adj2, fracs_needed: fracs_p2, gen_time: gt_p2,
      overhead_net: OH, overhead_final: OH,
      time_to_next_glaive, time_to_next_rm_application,
      _T1: T1, _T2: T2,
    };
  }

  if (opts.mode === 'twopass_converge') {
    // THREE-PASS with max(T2, T3) — eliminates optimistic errors
    const OH = 1;
    const sc1 = s.scTalented && s.scCd < base_gen_time ? 1 : 0;
    const net1 = Math.max(base_deficit - sc1 * 6, 0);
    const sos1 = s.sosTalented && s.sosCd < genTime(Math.ceil(net1 / frac_souls)) ? 1 : 0;
    const N1 = Math.max(net1 - sos1 * 3, 0);
    const T1 = OH * gcd + genTime(Math.ceil(N1 / frac_souls)) + sc1 * gcd + sos1 * gcd;

    const sc2 = s.scTalented && s.scCd < T1 ? 1 : 0;
    const net2 = Math.max(base_deficit - sc2 * 6, 0);
    const sos2 = s.sosTalented && s.sosCd < genTime(Math.ceil(net2 / frac_souls)) ? 1 : 0;
    const N2 = Math.max(net2 - sos2 * 3, 0);
    const adj2 = Math.max(N2 - passive_per_sec * T1, 0);
    const T2 = OH * gcd + genTime(Math.ceil(adj2 / frac_souls)) + sc2 * gcd + sos2 * gcd;

    const sc3 = s.scTalented && s.scCd < T2 ? 1 : 0;
    const net3 = Math.max(base_deficit - sc3 * 6, 0);
    const sos3 = s.sosTalented && s.sosCd < genTime(Math.ceil(net3 / frac_souls)) ? 1 : 0;
    const N3 = Math.max(net3 - sos3 * 3, 0);
    const adj3 = Math.max(N3 - passive_per_sec * T2, 0);
    const T3 = OH * gcd + genTime(Math.ceil(adj3 / frac_souls)) + sc3 * gcd + sos3 * gcd;

    const time_to_next_glaive = Math.max(T2, T3);
    const time_to_next_rm_application = time_to_next_glaive + 2 * gcd;
    return {
      gcd, frac_souls, base_deficit, fracs_base, eff_recharge,
      base_gen_time, sc_usable: sc3, net_deficit: net3, fracs_raw: Math.ceil(net3 / frac_souls),
      gen_time_raw: genTime(Math.ceil(net3 / frac_souls)), sos_usable: sos3, passive_per_sec,
      adj_deficit: adj3, fracs_needed: Math.ceil(adj3 / frac_souls), gen_time: genTime(Math.ceil(adj3 / frac_souls)),
      overhead_net: OH, overhead_final: OH,
      time_to_next_glaive, time_to_next_rm_application,
    };
  }

  if (opts.mode === 'propsc_avg') {
    // Proportional SC + averaged passive window to tame oscillation
    // OH modes:
    //   'spend': ceil(base_deficit / FRAG_CAP) — models total SpB casts
    //   'spend_net': ceil(base_deficit/CAP) minus burst spends already in genTime
    //   number: fixed overhead
    const ohMode = opts.oh ?? 1;

    function calcOH(fracs_needed_val) {
      if (ohMode === 'spend') {
        // Total SpB casts needed for the entire cycle
        return base_deficit > 0 ? Math.ceil(base_deficit / FRAG_CAP) : 0;
      }
      if (ohMode === 'spend_net') {
        // Total SpB minus those already in genTime burst pairs + recharge fits
        const total_spb = base_deficit > 0 ? Math.ceil(base_deficit / FRAG_CAP) : 0;
        const burst_spends = Math.min(s.fracCharges, fracs_needed_val);
        const recharge_fracs = Math.max(fracs_needed_val - s.fracCharges, 0);
        return Math.max(total_spb - burst_spends - recharge_fracs, 1);
      }
      return ohMode; // numeric
    }

    // Pass 1: no passive → T1 (reference for SC proportion + passive average)
    const sc1 = s.scTalented && s.scCd < base_gen_time ? 1 : 0;
    const net1 = Math.max(base_deficit - sc1 * 6, 0);
    const sos1 = s.sosTalented && s.sosCd < genTime(Math.ceil(net1 / frac_souls)) ? 1 : 0;
    const N1 = Math.max(net1 - sos1 * 3, 0);
    const fracs_np = Math.ceil(N1 / frac_souls);
    const T1 = calcOH(fracs_np) * gcd + genTime(fracs_np) + sc1 * gcd + sos1 * gcd;

    // SC credit proportional to how early it arrives in T1
    const sc_prop = s.scTalented && s.scCd < T1 ? Math.max(1 - s.scCd / T1, 0) : 0;
    const sc_credit_prop = 6 * sc_prop;
    const net_p = Math.max(base_deficit - sc_credit_prop, 0);
    const fracs_p = Math.ceil(net_p / frac_souls);
    const gt_p = genTime(fracs_p);
    const sos_p = s.sosTalented && s.sosCd < gt_p ? 1 : 0;
    const N_p = Math.max(net_p - sos_p * 3, 0);

    // Pass 2: passive over T1 → T2
    const adj2 = Math.max(N_p - passive_per_sec * T1, 0);
    const fracs_p2 = Math.ceil(adj2 / frac_souls);
    const T2 = calcOH(fracs_p2) * gcd + genTime(fracs_p2) + (sc_prop > 0 ? 1 : 0) * gcd + sos_p * gcd;

    // Average window = (T1 + T2) / 2 — compromise between no-passive and full-passive
    const T_avg = (T1 + T2) / 2;
    const adj_f = Math.max(N_p - passive_per_sec * T_avg, 0);
    const fracs_f = Math.ceil(adj_f / frac_souls);
    const gt_f = genTime(fracs_f);
    const oh_f = calcOH(fracs_f);
    let time_to_next_glaive = oh_f * gcd + gt_f + (sc_prop > 0 ? 1 : 0) * gcd + sos_p * gcd;

    // Passive delivery floor: when passive alone covers the full deficit
    // (0 fracs needed), time can't be less than passive arrival time (GCD-aligned)
    if (fracs_f === 0 && passive_per_sec > 0 && N_p > 0) {
      const passive_floor = Math.ceil(N_p / passive_per_sec / gcd) * gcd;
      time_to_next_glaive = Math.max(time_to_next_glaive, passive_floor);
    }

    const time_to_next_rm_application = time_to_next_glaive + 2 * gcd;

    return {
      gcd, frac_souls, base_deficit, fracs_base, eff_recharge,
      base_gen_time, sc_usable: sc_prop > 0 ? 1 : 0, net_deficit: net_p,
      fracs_raw: fracs_p, gen_time_raw: gt_p, sos_usable: sos_p, passive_per_sec,
      adj_deficit: adj_f, fracs_needed: fracs_f, gen_time: gt_f,
      overhead_net: oh_f, overhead_final: oh_f,
      time_to_next_glaive, time_to_next_rm_application,
    };
  }

  if (opts.mode === 'propsc_fixed') {
    // Proportional SC + passive from T1 only (no feedback, no oscillation)
    const OH = 1;
    const sc1 = s.scTalented && s.scCd < base_gen_time ? 1 : 0;
    const net1 = Math.max(base_deficit - sc1 * 6, 0);
    const sos1 = s.sosTalented && s.sosCd < genTime(Math.ceil(net1 / frac_souls)) ? 1 : 0;
    const N1 = Math.max(net1 - sos1 * 3, 0);
    const T1 = OH * gcd + genTime(Math.ceil(N1 / frac_souls)) + sc1 * gcd + sos1 * gcd;

    // Proportional SC from T1
    const sc_prop = s.scTalented && s.scCd < T1 ? Math.max(1 - s.scCd / T1, 0) : 0;
    const sc_credit_prop = 6 * sc_prop;
    const net_p = Math.max(base_deficit - sc_credit_prop, 0);
    const fracs_p = Math.ceil(net_p / frac_souls);
    const gt_p = genTime(fracs_p);
    const sos_p = s.sosTalented && s.sosCd < gt_p ? 1 : 0;
    const N_p = Math.max(net_p - sos_p * 3, 0);

    // Passive from T1 (fixed, no circular feedback)
    const adj_f = Math.max(N_p - passive_per_sec * T1, 0);
    const fracs_f = Math.ceil(adj_f / frac_souls);
    const gt_f = genTime(fracs_f);
    const time_to_next_glaive = OH * gcd + gt_f + (sc_prop > 0 ? 1 : 0) * gcd + sos_p * gcd;
    const time_to_next_rm_application = time_to_next_glaive + 2 * gcd;

    return {
      gcd, frac_souls, base_deficit, fracs_base, eff_recharge,
      base_gen_time, sc_usable: sc_prop > 0 ? 1 : 0, net_deficit: net_p,
      fracs_raw: fracs_p, gen_time_raw: gt_p, sos_usable: sos_p, passive_per_sec,
      adj_deficit: adj_f, fracs_needed: fracs_f, gen_time: gt_f,
      overhead_net: OH, overhead_final: OH,
      time_to_next_glaive, time_to_next_rm_application,
    };
  }

  // --- CURRENT (original) formula ---
  let sc_usable, sc_credit;
  if (opts.scGate === 'tight') {
    sc_usable = s.scTalented && s.scCd < base_gen_time * 0.5 ? 1 : 0;
  } else {
    sc_usable = s.scTalented && s.scCd < base_gen_time ? 1 : 0;
  }
  sc_credit = sc_usable * 6;
  const net_deficit = Math.max(base_deficit - sc_credit, 0);
  const fracs_raw = Math.ceil(net_deficit / frac_souls);
  const gen_time_raw = genTime(fracs_raw);
  const sos_usable = s.sosTalented && s.sosCd < gen_time_raw ? 1 : 0;

  const overhead_net = Math.min(net_deficit, 5);

  let passiveWindow;
  if (opts.passiveWindow === 'genraw') {
    passiveWindow = gen_time_raw;
  } else if (opts.passiveWindow === 'genraw_sc') {
    passiveWindow = gen_time_raw + sc_usable * gcd + sos_usable * gcd;
  } else {
    passiveWindow = gen_time_raw + overhead_net * gcd + sc_usable * gcd + sos_usable * gcd;
  }
  let raw_passive_gen = passive_per_sec * passiveWindow;

  const N = net_deficit - sos_usable * 3;

  const dampFactor = opts.dampPassive ?? 1.0;
  let adj_deficit = Math.max(N - raw_passive_gen * dampFactor, 0);
  const fracs_needed = Math.ceil(adj_deficit / frac_souls);
  const gen_time = genTime(fracs_needed);

  const overhead_final = overhead_net;

  const time_to_next_glaive = overhead_final * gcd + gen_time + sc_usable * gcd + sos_usable * gcd;
  const time_to_next_rm_application = time_to_next_glaive + 2 * gcd;

  return {
    gcd, frac_souls, base_deficit, fracs_base, eff_recharge,
    base_gen_time, sc_usable, net_deficit, fracs_raw, gen_time_raw,
    sos_usable, passive_per_sec, adj_deficit, fracs_needed, gen_time,
    overhead_net, overhead_final, time_to_next_glaive, time_to_next_rm_application,
  };
}

// ============================================================
// Model Runner
// ============================================================
function runModel(s) {
  const args = [
    `--haste ${s.haste}`,
    `--apex ${s.apex}`,
    `--aotg ${s.aotg}`,
    `--frags ${s.frags}`,
    `--targets ${s.targets}`,
    `--rm-remains ${s.rmRemains}`,
    `--frac-charges ${s.fracCharges}`,
    `--frac-cd ${s.fracCd}`,
    `--sc-cd ${s.scCd}`,
    `--sos-cd ${s.sosCd}`,
    `--spb-cd ${s.spbCd}`,
    `--max-time 60`,
  ];
  if (s.meta) args.push('--meta');
  if (s.iaActive) args.push('--ia-active', `--ia-remains ${s.iaRemains || 6}`);
  if (s.fallout) args.push('--fallout');
  if (!s.wq) args.push('--no-wq');

  const cmd = `node scripts/soul-gen-model.mjs ${args.join(' ')}`;
  const out = execSync(cmd, { encoding: 'utf8', cwd: process.cwd() });

  const rgMatch = out.match(/--- Expected Path ---[\s\S]*?Time to RG:\s+([\d.]+)s\s+\((\d+) GCDs?\)/);
  return {
    rgTime: rgMatch ? parseFloat(rgMatch[1]) : null,
    rgGCDs: rgMatch ? parseInt(rgMatch[2]) : null,
  };
}

// ============================================================
// Scenarios
// ============================================================
const BASE = {
  haste: 0.20, apex: 3, meta: false, targets: 1,
  aotg: 0, frags: 0, rmRemains: 20,
  fracCharges: 2, fracCd: 0,
  scTalented: true, scCd: 0,
  sosTalented: true, sosCd: 999,
  spbCd: 0,
  iaActive: false, iaRemains: 0,
  fallout: false, wq: true,
};

function scenario(name, overrides) {
  return { name, ...BASE, ...overrides };
}

const scenarios = [
  // CYCLE POSITION
  scenario('Fresh (SC rdy, no SoS)',
    { aotg: 0, frags: 0, scCd: 0 }),
  scenario('Fresh + SoS ready',
    { aotg: 0, frags: 0, scCd: 0, sosCd: 0 }),
  scenario('Fresh + Meta',
    { aotg: 0, frags: 0, scCd: 0, meta: true }),
  scenario('Fresh + Meta + SoS',
    { aotg: 0, frags: 0, scCd: 0, sosCd: 0, meta: true }),
  scenario('Fresh, all CDs down',
    { aotg: 0, frags: 0, scCd: 20, sosCd: 40, fracCharges: 0, fracCd: 3 }),

  // EARLY CYCLE
  scenario('Early (6,2) SC on CD',
    { aotg: 6, frags: 2, scCd: 22, fracCharges: 1, fracCd: 2 }),
  scenario('Early (6,2) SoS imm',
    { aotg: 6, frags: 2, scCd: 22, sosCd: 5, fracCharges: 1, fracCd: 2 }),
  scenario('Early (4,6) at cap',
    { aotg: 4, frags: 6, scCd: 18, fracCharges: 2 }),

  // MID CYCLE
  scenario('Mid (10,3) SC rdy',
    { aotg: 10, frags: 3, scCd: 0, fracCharges: 2 }),
  scenario('Mid (10,3) SC+SoS rdy',
    { aotg: 10, frags: 3, scCd: 0, sosCd: 0, fracCharges: 2 }),
  scenario('Mid (10,4) no chrg',
    { aotg: 10, frags: 4, scCd: 15, fracCharges: 0, fracCd: 2 }),
  scenario('Mid (10,3) + Meta',
    { aotg: 10, frags: 3, scCd: 0, meta: true, fracCharges: 2 }),
  scenario('Mid (10,2) all CD',
    { aotg: 10, frags: 2, scCd: 18, sosCd: 30, fracCharges: 2 }),

  // NEAR COMPLETION
  scenario('Near (17,2)',
    { aotg: 17, frags: 2, scCd: 20, fracCharges: 1, fracCd: 1 }),
  scenario('Near (16,6) cap',
    { aotg: 16, frags: 6, scCd: 20, fracCharges: 2 }),
  scenario('Near (18,0)',
    { aotg: 18, frags: 0, scCd: 25, fracCharges: 2 }),
  scenario('Near (15,1) SC rdy',
    { aotg: 15, frags: 1, scCd: 0, fracCharges: 2 }),

  // POST-RG
  scenario('Post-RG (2,1) SC=10',
    { aotg: 2, frags: 1, scCd: 10, fracCharges: 1, fracCd: 2 }),
  scenario('Post-RG (2,0) SoS rdy',
    { aotg: 2, frags: 0, scCd: 15, sosCd: 0, fracCharges: 2 }),
  scenario('Post-RG empty all CD',
    { aotg: 0, frags: 0, scCd: 25, sosCd: 45, fracCharges: 0, fracCd: 3, spbCd: 15 }),

  // FILLER WINDOWS
  scenario('Filler: RM=20 fresh',
    { aotg: 0, frags: 0, scCd: 0, rmRemains: 20 }),
  scenario('Filler: RM=15 SC CD',
    { aotg: 0, frags: 0, scCd: 15, rmRemains: 15 }),
  scenario('Filler: RM=12 mid',
    { aotg: 8, frags: 2, scCd: 10, rmRemains: 12 }),
  scenario('Filler: RM=8 tight',
    { aotg: 10, frags: 3, scCd: 0, rmRemains: 8 }),
  scenario('Filler: RM=5 vtight',
    { aotg: 14, frags: 4, scCd: 15, rmRemains: 5 }),

  // COOLDOWN MATRIX
  scenario('SC+SoS+SpB rdy',
    { scCd: 0, sosCd: 0, spbCd: 0, fracCharges: 2 }),
  scenario('SC rdy, SoS CD',
    { scCd: 0, sosCd: 30, spbCd: 0, fracCharges: 2 }),
  scenario('SC CD, SoS rdy',
    { scCd: 15, sosCd: 0, spbCd: 0, fracCharges: 2 }),
  scenario('SC imm (CD=2)',
    { scCd: 2, sosCd: 999, fracCharges: 2 }),
  scenario('SoS imm (CD=3)',
    { scCd: 0, sosCd: 3, fracCharges: 2 }),

  // RESOURCE STATES
  scenario('0 frags 0 chrg',
    { aotg: 5, frags: 0, fracCharges: 0, fracCd: 3, scCd: 20 }),
  scenario('6 frags 2 chrg',
    { aotg: 5, frags: 6, fracCharges: 2, scCd: 20 }),
  scenario('1 chrg recharging',
    { aotg: 5, frags: 0, scCd: 10, fracCharges: 1, fracCd: 2 }),

  // META
  scenario('Meta fresh',
    { aotg: 0, frags: 0, scCd: 0, meta: true, fracCharges: 2 }),
  scenario('Meta mid (10,4)',
    { aotg: 10, frags: 4, scCd: 5, meta: true, fracCharges: 2 }),
  scenario('Meta near (16,3)',
    { aotg: 16, frags: 3, scCd: 15, meta: true, fracCharges: 2 }),

  // AOE / PASSIVE
  scenario('AoE 3T IA+Fallout',
    { aotg: 0, frags: 0, scCd: 0, targets: 3, iaActive: true, iaRemains: 6, fallout: true }),
  scenario('AoE 5T IA+Fallout',
    { aotg: 0, frags: 0, scCd: 0, targets: 5, iaActive: true, iaRemains: 6, fallout: true }),

  // HASTE
  scenario('Low haste 10%',
    { haste: 0.10, aotg: 0, frags: 0, scCd: 0 }),
  scenario('High haste 35%',
    { haste: 0.35, aotg: 0, frags: 0, scCd: 0 }),

  // APEX
  scenario('Apex 0',
    { apex: 0, aotg: 0, frags: 0, scCd: 0 }),
  scenario('Apex 1',
    { apex: 1, aotg: 0, frags: 0, scCd: 0 }),

  // EDGE CASES
  scenario('AotG=20 (done)',
    { aotg: 20, frags: 0, scCd: 20 }),
  scenario('AotG=19 frags=1',
    { aotg: 19, frags: 1, scCd: 20, fracCharges: 2 }),
  scenario('AotG=19 frags=0',
    { aotg: 19, frags: 0, scCd: 20, fracCharges: 1, fracCd: 0 }),
  scenario('SpB long CD',
    { aotg: 0, frags: 0, scCd: 0, spbCd: 18, fracCharges: 2 }),
];

// ============================================================
// Variant definitions
// ============================================================
const VARIANTS = [
  { label: 'Current', opts: {} },
  { label: 'PA_oh1', opts: { mode: 'propsc_avg', oh: 1 } },
  { label: 'PA_snet', opts: { mode: 'propsc_avg', oh: 'spend_net' } },
];

// ============================================================
// Run
// ============================================================
const fmt = (n, d = 1) => n == null ? 'N/R' : n.toFixed(d);

// First, run the model for all scenarios (slow part)
console.log(`Running ${scenarios.length} model simulations...`);
const modelResults = scenarios.map(s => runModel(s));
console.log('Done.\n');

// Compute all variants
console.log(`AR Variable Audit — ${scenarios.length} scenarios x ${VARIANTS.length} variants`);
console.log('='.repeat(130));
console.log('');

// Per-variant stats
const variantStats = VARIANTS.map(v => ({
  label: v.label,
  deltas: [],
  fillerMismatches: 0,
  fillerFalsePos: 0,  // APL says yes, model says no (dangerous)
  fillerFalseNeg: 0,  // APL says no, model says yes (safe)
}));

// Print comparison table
const nameW = 26;
const colW = 8;
const hdrCols = [
  'Scenario'.padEnd(nameW),
  'Model'.padStart(colW),
  ...VARIANTS.map(v => v.label.padStart(colW)),
];
console.log(hdrCols.join(' | '));
console.log(hdrCols.map(h => '-'.repeat(h.length)).join('-+-'));

for (let i = 0; i < scenarios.length; i++) {
  const s = scenarios[i];
  const model = modelResults[i];
  const modelT = model.rgTime;

  const cols = [s.name.padEnd(nameW), fmt(modelT).padStart(colW)];

  for (let vi = 0; vi < VARIANTS.length; vi++) {
    const apl = computeAplVars(s, VARIANTS[vi].opts);
    const aplT = apl.time_to_next_glaive;
    const delta = modelT != null ? aplT - modelT : null;

    if (delta != null) {
      variantStats[vi].deltas.push(delta);
    }

    // Filler accuracy (only for scenarios with mark active in practice)
    if (modelT != null) {
      const aplFillerOk = apl.time_to_next_rm_application < s.rmRemains;
      const modelFillerOk = modelT + 2 * apl.gcd < s.rmRemains;
      if (aplFillerOk !== modelFillerOk) {
        variantStats[vi].fillerMismatches++;
        if (aplFillerOk && !modelFillerOk) variantStats[vi].fillerFalsePos++;
        if (!aplFillerOk && modelFillerOk) variantStats[vi].fillerFalseNeg++;
      }
    }

    // Format: delta with sign and direction indicator
    if (delta != null) {
      const sign = delta >= 0 ? '+' : '';
      const marker = Math.abs(delta) <= 1.3 ? ' ' : (delta < 0 ? '!' : '.');
      cols.push(`${marker}${sign}${fmt(delta)}`.padStart(colW));
    } else {
      cols.push('N/A'.padStart(colW));
    }
  }

  console.log(cols.join(' | '));
}

console.log('');
console.log('Legend: ! = optimistic error > 1.3s (risky), . = pessimistic error > 1.3s (safe), space = within 1 GCD');
console.log('');

// ============================================================
// Summary comparison
// ============================================================
console.log('='.repeat(130));
console.log('');
console.log('VARIANT COMPARISON SUMMARY');
console.log('');

const summaryHdr = [
  'Metric'.padEnd(30),
  ...VARIANTS.map(v => v.label.padStart(12)),
];
console.log(summaryHdr.join(' | '));
console.log(summaryHdr.map(h => '-'.repeat(h.length)).join('-+-'));

function statRow(label, fn) {
  const cols = [label.padEnd(30)];
  for (const vs of variantStats) {
    cols.push(fn(vs).padStart(12));
  }
  console.log(cols.join(' | '));
}

statRow('Mean delta', vs => {
  const m = vs.deltas.reduce((a, b) => a + b, 0) / vs.deltas.length;
  return `${m >= 0 ? '+' : ''}${fmt(m)}s`;
});
statRow('Mean |delta|', vs => {
  const m = vs.deltas.reduce((a, b) => a + Math.abs(b), 0) / vs.deltas.length;
  return `${fmt(m)}s`;
});
statRow('Max optimistic', vs => {
  const m = Math.min(...vs.deltas);
  return `${fmt(m)}s`;
});
statRow('Max pessimistic', vs => {
  const m = Math.max(...vs.deltas);
  return `${fmt(m)}s`;
});
statRow('Within 1 GCD', vs => {
  const n = vs.deltas.filter(d => Math.abs(d) <= 1.3).length;
  return `${n}/${vs.deltas.length}`;
});
statRow('Optimistic > 1 GCD', vs => {
  return String(vs.deltas.filter(d => d < -1.3).length);
});
statRow('Pessimistic > 1 GCD', vs => {
  return String(vs.deltas.filter(d => d > 1.3).length);
});
statRow('Filler mismatches', vs => String(vs.fillerMismatches));
statRow('  false pos (danger)', vs => String(vs.fillerFalsePos));
statRow('  false neg (safe)', vs => String(vs.fillerFalseNeg));

// ============================================================
// Best variant analysis
// ============================================================
console.log('');
console.log('KEY: Lower mean |delta| = more accurate. Fewer filler false positives = safer.');
console.log('False positives trigger filler glaives that waste mark. False negatives miss fillers (small DPS loss).');
console.log('');

// Show worst optimistic for each variant
for (const v of VARIANTS) {
  const vi = VARIANTS.indexOf(v);
  const pairs = scenarios.map((s, i) => ({
    name: s.name,
    delta: modelResults[i].rgTime != null
      ? computeAplVars(s, v.opts).time_to_next_glaive - modelResults[i].rgTime
      : null,
  })).filter(p => p.delta != null);

  const worst3 = pairs.sort((a, b) => a.delta - b.delta).slice(0, 3);
  console.log(`${v.label} worst optimistic: ${worst3.map(p => `${p.name} (${fmt(p.delta)}s)`).join(', ')}`);
}
