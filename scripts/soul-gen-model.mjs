#!/usr/bin/env node
// GCD-budget forward model for Aldrachi Reaver soul generation.
// Tracks fragment pool (cap 6) + Art of the Glaive counter (target 20) GCD-by-GCD.
// Self-contained analytical tool - no src/ imports.

import { parseArgs } from 'node:util';

// ============================================================
// Constants
// ============================================================

const FRAG_CAP = 6;
const AOTG_TARGET = 20;
const GCD_BASE = 1.5;
const GCD_MIN = 0.75;
const FRAC_RECHARGE_BASE = 4.5;
const FRAC_MAX_CHARGES = 2;

// Soul Carver: 3 instant + 3 DoT (1/s over 3s) = 6 total
const SC_INSTANT = 3;
const SC_DOT = 3;
const SC_DOT_INTERVAL = 1.0;
const SC_CD_BASE = 30;  // Hasted

// Sigil of Spite: 3 base frags
const SOS_FRAGS = 3;
const SOS_CD_BASE = 60;  // Hasted

// Passive rates (per second, expected values)
const WQ_RATE = 0.30;
// Fallout: 0.60/target per tick, ticks every 2s = 0.30/target/s
const FALLOUT_RATE = 0.30;
const IA_DUR = 6;

// Broken Spirit bonuses
const BS_SC_BONUS = 0.20;
const BS_SOS_BONUS = 1;

// Soul Splitter: 2% multiplicative to all gen
const SOUL_SPLITTER_MULT = 1.02;

// Spender caps and cooldowns
const SPB_MAX = 5;
const SPB_CD_BASE = 25;  // Hasted cooldown
const SCLV_MAX = 2;

// ============================================================
// CLI
// ============================================================

function parseCli() {
  const { values } = parseArgs({
    options: {
      haste:            { type: 'string', default: '0.20' },
      apex:             { type: 'string', default: '3' },
      aotg:             { type: 'string', default: '0' },
      frags:            { type: 'string', default: '0' },
      meta:             { type: 'boolean', default: false },
      targets:          { type: 'string', default: '1' },
      'rm-remains':     { type: 'string', default: '20' },
      'frac-charges':   { type: 'string', default: '2' },
      'frac-cd':        { type: 'string', default: '0' },
      'sc-cd':          { type: 'string', default: '0' },
      'sos-cd':         { type: 'string', default: '999' },
      'spb-cd':         { type: 'string', default: '0' },
      'ia-active':      { type: 'boolean', default: false },
      'ia-remains':     { type: 'string', default: '0' },
      'no-wq':          { type: 'boolean', default: false },
      fallout:          { type: 'boolean', default: false },
      'broken-spirit':  { type: 'boolean', default: false },
      'soul-splitter':  { type: 'boolean', default: false },
      'max-time':       { type: 'string', default: '40' },
      verbose:          { type: 'boolean', short: 'v', default: false },
      help:             { type: 'boolean', short: 'h', default: false },
    }
  });

  if (values.help) {
    console.log(`Soul Generation GCD-Budget Model for Aldrachi Reaver

Usage: node scripts/soul-gen-model.mjs [options]

State:
  --haste <pct>         Haste as decimal (default: 0.20)
  --apex <rank>         Apex rank 0-4 (default: 3)
  --aotg <stacks>       Starting AotG stacks (default: 0)
  --frags <count>       Starting soul fragments (default: 0)
  --meta                Metamorphosis active (fracture gen 2->3)
  --targets <count>     Number of targets (default: 1)
  --rm-remains <sec>    Reaver's Mark remaining duration (default: 20)

Cooldowns:
  --frac-charges <n>    Fracture charges available (default: 2)
  --frac-cd <sec>       Fracture recharge remaining (default: 0)
  --sc-cd <sec>         Soul Carver cooldown remaining (default: 0)
  --sos-cd <sec>        Sigil of Spite cooldown remaining (default: 999)
  --spb-cd <sec>        Spirit Bomb cooldown remaining (default: 0)

Talents:
  --ia-active           Immolation Aura currently active
  --ia-remains <sec>    IA remaining duration (default: 0)
  --no-wq              Disable Wounded Quarry passive gen
  --fallout            Enable Fallout passive gen during IA
  --broken-spirit      Enable Broken Spirit (+0.20 on SC, +1 on SoS)
  --soul-splitter      Enable Soul Splitter (2% multiplicative)

Output:
  --max-time <sec>      Maximum simulation time (default: 40)
  --verbose, -v         Show GCD-by-GCD log
  --help, -h            Show this help`);
    process.exit(0);
  }

  return {
    haste: parseFloat(values.haste),
    apex: parseInt(values.apex),
    startAotg: parseInt(values.aotg),
    startFrags: parseInt(values.frags),
    meta: values.meta,
    targets: parseInt(values.targets),
    rmRemains: parseFloat(values['rm-remains']),
    fracCharges: parseInt(values['frac-charges']),
    fracCd: parseFloat(values['frac-cd']),
    scCd: parseFloat(values['sc-cd']),
    sosCd: parseFloat(values['sos-cd']),
    spbCd: parseFloat(values['spb-cd']),
    iaActive: values['ia-active'],
    iaRemains: parseFloat(values['ia-remains']),
    wq: !values['no-wq'],
    fallout: values.fallout,
    brokenSpirit: values['broken-spirit'],
    soulSplitter: values['soul-splitter'],
    maxTime: parseFloat(values['max-time']),
    verbose: values.verbose,
  };
}

// ============================================================
// Profile
// ============================================================

function buildProfile(cli) {
  const gcd = Math.max(GCD_MIN, GCD_BASE / (1 + cli.haste));
  const fracRecharge = FRAC_RECHARGE_BASE / (1 + cli.haste);
  const fracGen = cli.meta ? 3 : 2;
  const spbCd = SPB_CD_BASE / (1 + cli.haste);
  const scCdDuration = SC_CD_BASE / (1 + cli.haste);
  const sosCdDuration = SOS_CD_BASE / (1 + cli.haste);
  return { ...cli, gcd, fracRecharge, fracGen, spbCdDuration: spbCd, scCdDuration, sosCdDuration };
}

// ============================================================
// Simulation state
// ============================================================

function createState(p) {
  const s = {
    time: 0,
    frags: Math.min(p.startFrags, FRAG_CAP),
    aotg: Math.min(p.startAotg, AOTG_TARGET - 1),
    fracCharges: Math.min(p.fracCharges, FRAC_MAX_CHARGES),
    fracRechargeAt: null,
    scAvailAt: p.scCd,
    sosAvailAt: p.sosCd,
    spbAvailAt: p.spbCd,
    iaExpiresAt: p.iaActive ? p.iaRemains : -1,
    scDotQueue: [],
    passiveAccum: 0,
    lastFracGcd: -100,
  };
  // Start recharge timer if below max charges
  if (s.fracCharges < FRAC_MAX_CHARGES) {
    s.fracRechargeAt = p.fracCd;
  }
  return s;
}

function cloneState(s) {
  return { ...s, scDotQueue: [...s.scDotQueue] };
}

// Add fragments with overflow -> AotG
function addFrags(s, n) {
  let overflow = 0;
  for (let i = 0; i < n; i++) {
    if (s.frags < FRAG_CAP) {
      s.frags++;
    } else {
      s.aotg++;
      overflow++;
    }
  }
  return overflow;
}

// Consume fragments via spender -> AotG
function consumeFrags(s, max) {
  const n = Math.min(max, s.frags);
  s.frags -= n;
  s.aotg += n;
  return n;
}

// ============================================================
// Charge management
// ============================================================

function advanceCharges(s, fracRecharge) {
  while (s.fracRechargeAt !== null && s.time >= s.fracRechargeAt - 0.001) {
    s.fracCharges++;
    if (s.fracCharges < FRAC_MAX_CHARGES) {
      s.fracRechargeAt += fracRecharge;
    } else {
      s.fracRechargeAt = null;
    }
  }
}

function useFracCharge(s, fracRecharge) {
  s.fracCharges--;
  if (s.fracRechargeAt === null) {
    // Was at max — start recharge timer
    s.fracRechargeAt = s.time + fracRecharge;
  }
  // If already recharging, timer continues from its current position
}

// ============================================================
// SC DoT processing
// ============================================================

function processScDot(s) {
  let n = 0;
  while (s.scDotQueue.length && s.scDotQueue[0] <= s.time + 0.001) {
    s.scDotQueue.shift();
    addFrags(s, 1);
    n++;
  }
  return n;
}

// ============================================================
// Passive generation
// ============================================================

function getPassiveRate(p, s, conservative) {
  const scale = conservative ? 0.5 : 1.0;
  let rate = 0;
  if (p.wq) rate += WQ_RATE * scale;
  if (p.fallout && s.iaExpiresAt > s.time) {
    rate += FALLOUT_RATE * p.targets * scale;
  }
  if (p.soulSplitter) rate *= SOUL_SPLITTER_MULT;
  return rate;
}

function tickPassive(s, dt, p, conservative) {
  s.passiveAccum += getPassiveRate(p, s, conservative) * dt;
  const whole = Math.floor(s.passiveAccum);
  if (whole > 0) {
    s.passiveAccum -= whole;
    addFrags(s, whole);
  }
}

// ============================================================
// Action selection (smart greedy strategy)
//
// SpB has a 25s CD so SClv (no CD, 2 frags) is the primary spender.
// At cap, overflow via fracture is free AotG with no spend GCD needed.
// SClv between fractures converts idle frags to AotG at 2/GCD.
//
// Priority:
// 1. Spend to trigger RG (SpB if up, else SClv)
// 2. Soul Carver (6 frags for 1 GCD)
// 3. SoS (3-4 frags for 1 GCD)
// 4. SpB big batch if up and frags >= 4
// 5. At cap with charges: fracture for overflow
// 6. Fracture to generate
// 7. SClv if frags >= 2 and SpB not imminent (convert idle frags)
// 8. Filler
// ============================================================

function pickAction(s, p) {
  const deficit = AOTG_TARGET - s.aotg;
  const spbUp = s.spbAvailAt <= s.time + 0.001;
  const spbSoon = !spbUp && (s.spbAvailAt - s.time) < p.gcd * 4;

  // 1. Spend to trigger RG
  if (deficit > 0 && spbUp && Math.min(SPB_MAX, s.frags) >= deficit) {
    return 'spb';
  }
  if (deficit > 0 && Math.min(SCLV_MAX, s.frags) >= deficit) {
    return 'sclv';
  }

  // 2. Soul Carver
  if (s.scAvailAt <= s.time + 0.001) return 'sc';

  // 3. SoS
  if (s.sosAvailAt <= s.time + 0.001) return 'sos';

  // 4. At cap with charges: overflow fracture (especially valuable during SC DoT)
  if (s.frags >= FRAG_CAP && s.fracCharges > 0) return 'fracture';

  // 5. Fracture to generate (build toward cap before spending)
  if (s.fracCharges > 0) return 'fracture';

  // 6. SpB big batch when up and frags >= 4 (after exhausting fracture charges)
  if (spbUp && s.frags >= 4) return 'spb';

  // 7. SClv if frags available and SpB not about to come up
  if (s.frags >= 2 && !spbSoon) return 'sclv';

  // 8. Filler
  return 'filler';
}

// ============================================================
// Action execution
// ============================================================

function doAction(s, action, p, conservative) {
  const mult = p.soulSplitter ? SOUL_SPLITTER_MULT : 1;

  switch (action) {
    case 'fracture': {
      // Soul Splitter: 2% extra frags, fractional goes to accumulator
      const base = p.fracGen;
      const effective = base * mult;
      const whole = Math.floor(effective);
      s.passiveAccum += effective - whole;
      const ov = addFrags(s, whole);
      useFracCharge(s, p.fracRecharge);
      s.lastFracGcd = s.time;
      return ov > 0
        ? `Frac +${whole} (${ov} overflow)`
        : `Frac +${whole}`;
    }
    case 'spb': {
      const n = consumeFrags(s, SPB_MAX);
      s.spbAvailAt = s.time + p.spbCdDuration;
      return `SpB -${n}`;
    }
    case 'sclv': {
      const n = consumeFrags(s, SCLV_MAX);
      return `SClv -${n}`;
    }
    case 'sc': {
      const instant = SC_INSTANT;
      addFrags(s, instant);
      for (let i = 1; i <= SC_DOT; i++) {
        s.scDotQueue.push(s.time + i * SC_DOT_INTERVAL);
      }
      s.scAvailAt = s.time + p.scCdDuration;
      // Broken Spirit: +0.20 expected frags on SC
      if (p.brokenSpirit) {
        s.passiveAccum += conservative ? BS_SC_BONUS * 0.5 : BS_SC_BONUS;
      }
      return `SC +${instant}+${SC_DOT}dot`;
    }
    case 'sos': {
      const gen = SOS_FRAGS + (p.brokenSpirit ? BS_SOS_BONUS : 0);
      addFrags(s, gen);
      s.sosAvailAt = s.time + p.sosCdDuration;
      return `SoS +${gen}`;
    }
    case 'filler': {
      // Start IA if Fallout talent and IA not active
      if (p.fallout && s.iaExpiresAt <= s.time) {
        s.iaExpiresAt = s.time + IA_DUR;
        return 'IA (Fallout)';
      }
      return 'filler';
    }
  }
}

// ============================================================
// Forward simulation
// ============================================================

function simulate(p, conservative = false) {
  const s = createState(p);
  const log = [];
  const rgs = [];

  for (let gcd = 1; s.time < p.maxTime && rgs.length < 2; gcd++) {
    // Process between-GCD events
    advanceCharges(s, p.fracRecharge);
    processScDot(s);
    if (gcd > 1) tickPassive(s, p.gcd, p, conservative);

    // Snapshot pre-action state
    const pre = { frags: s.frags, aotg: s.aotg };

    // Choose and execute
    const action = pickAction(s, p);
    const note = doAction(s, action, p, conservative);

    // Check RG trigger
    let rg = false;
    if (s.aotg >= AOTG_TARGET) {
      rgs.push({ time: s.time, gcd });
      s.aotg -= AOTG_TARGET;
      rg = true;
    }

    log.push({
      gcd, time: s.time, action,
      fragsBefore: pre.frags, fragsAfter: s.frags,
      aotgBefore: pre.aotg, aotgAfter: rg ? pre.aotg + (s.aotg + AOTG_TARGET - pre.aotg) : s.aotg,
      note, rg,
    });

    // Advance time
    s.time += p.gcd;
  }

  return { log, rgs };
}

// ============================================================
// Analysis
// ============================================================

function analyze(p, expected, conservative) {
  const r = {};

  // Time to RG
  r.expRG = expected.rgs[0] ?? null;
  r.conRG = conservative.rgs[0] ?? null;
  r.expRG2 = expected.rgs[1] ?? null;
  r.conRG2 = conservative.rgs[1] ?? null;

  // Filler margin within RM
  r.expMargin = r.expRG ? p.rmRemains - r.expRG.time : -Infinity;
  r.conMargin = r.conRG ? p.rmRemains - r.conRG.time : -Infinity;
  r.expFillerGCDs = Math.max(0, Math.floor(r.expMargin / p.gcd));
  r.conFillerGCDs = Math.max(0, Math.floor(r.conMargin / p.gcd));

  // GCD budget breakdown (to first RG)
  const maxGcd = r.expRG?.gcd ?? Infinity;
  const breakdown = {};
  let aotgOverflow = 0, aotgSpend = 0;

  for (const e of expected.log) {
    if (e.gcd > maxGcd) break;
    breakdown[e.action] = (breakdown[e.action] || 0) + 1;

    // Track AotG sources
    const delta = e.aotgAfter - e.aotgBefore;
    if (delta > 0) {
      if (e.action === 'spb' || e.action === 'sclv') {
        aotgSpend += delta;
      } else {
        aotgOverflow += delta;
      }
    }
  }

  r.breakdown = breakdown;
  r.totalGCDs = Object.values(breakdown).reduce((a, b) => a + b, 0);
  r.aotgOverflow = aotgOverflow;
  r.aotgSpend = aotgSpend;
  r.aotgPassive = AOTG_TARGET - p.startAotg - aotgOverflow - aotgSpend;

  // Optimal sequence summary (first N key actions)
  r.sequence = expected.log
    .filter(e => e.gcd <= maxGcd && e.action !== 'filler')
    .slice(0, 8)
    .map(e => {
      const labels = {
        sc: 'SC', sos: 'SoS', fracture: 'Frac',
        spb: 'SpB', sclv: 'SClv',
      };
      return labels[e.action] || e.action;
    });

  // Passive rate summary
  const dummyState = createState(p);
  dummyState.frags = FRAG_CAP; // At cap for representative rate
  r.passivePerSec = getPassiveRate(p, dummyState, false);
  r.passivePerGCD = r.passivePerSec * p.gcd;

  return r;
}

// ============================================================
// Formatting
// ============================================================

const fmt = (n, d = 2) => n?.toFixed(d) ?? 'N/A';

function formatLog(log, maxGcd) {
  const lines = [];
  lines.push('GCD  Time    Action    Frags     AotG  Notes');
  lines.push('---  ------  --------  --------  ----  -----');
  for (const e of log) {
    if (maxGcd && e.gcd > maxGcd + 3) break;
    const marker = e.rg ? ' ** RG **' : '';
    const fragStr = `${e.fragsBefore}->${e.fragsAfter}`;
    const aotgStr = String(e.aotgAfter).padStart(2);
    lines.push(
      `${String(e.gcd).padStart(3)}  ` +
      `${fmt(e.time)}s  ` +
      `${e.action.padEnd(8)}  ` +
      `${fragStr.padEnd(8)}  ` +
      `${aotgStr}    ` +
      `${e.note}${marker}`
    );
  }
  return lines.join('\n');
}

function formatResults(p, expected, conservative, a) {
  const lines = [];

  // Header
  lines.push('=== Soul Generation GCD-Budget Analysis ===');
  lines.push(`Profile: haste=${(p.haste * 100).toFixed(0)}%, apex=${p.apex}, meta=${p.meta ? 'on' : 'off'}, targets=${p.targets}`);
  lines.push(`State:   AotG=${p.startAotg}/${AOTG_TARGET}, frags=${p.startFrags}/${FRAG_CAP}, RM=${fmt(p.rmRemains, 1)}s`);
  lines.push(`Timing:  GCD=${fmt(p.gcd)}s, fracRecharge=${fmt(p.fracRecharge)}s (${Math.round(p.fracRecharge / p.gcd)} GCDs), fracGen=${p.fracGen}`);
  lines.push(`Charges: frac=${p.fracCharges}, SC=${p.scCd < 1 ? 'ready' : fmt(p.scCd, 0) + 's'}, SoS=${p.sosCd > 100 ? 'unavail' : fmt(p.sosCd, 0) + 's'}, SpB=${p.spbCd < 1 ? 'ready' : fmt(p.spbCd, 0) + 's'} (${fmt(p.spbCdDuration, 1)}s CD)`);

  const tags = [];
  if (p.wq) tags.push('WQ');
  if (p.fallout) tags.push('Fallout');
  if (p.brokenSpirit) tags.push('BrokenSpirit');
  if (p.soulSplitter) tags.push('SoulSplitter');
  lines.push(`Passive: ${tags.length ? tags.join(', ') : 'none'} (${fmt(a.passivePerSec)}/s, ${fmt(a.passivePerGCD)}/GCD)`);
  lines.push('');

  // Expected path
  lines.push('--- Expected Path ---');
  if (p.verbose) {
    lines.push(formatLog(expected.log, a.expRG?.gcd));
    lines.push('');
  }
  if (a.expRG) {
    lines.push(`Time to RG:     ${fmt(a.expRG.time)}s (${a.expRG.gcd} GCDs)`);
  } else {
    lines.push('Time to RG:     NOT REACHED within simulation window');
  }
  if (a.expRG2) {
    lines.push(`Time to 2nd RG: ${fmt(a.expRG2.time)}s (${a.expRG2.gcd} GCDs)`);
  }
  if (a.expMargin > 0) {
    lines.push(`Filler margin:  ${fmt(a.expMargin)}s (${a.expFillerGCDs} GCDs within RM)`);
  } else if (a.expRG) {
    lines.push(`Filler margin:  NONE - RG at ${fmt(a.expRG.time)}s exceeds RM ${fmt(p.rmRemains)}s`);
  }
  lines.push('');

  // Conservative path
  lines.push('--- Conservative Path (50% passive) ---');
  if (p.verbose) {
    lines.push(formatLog(conservative.log, a.conRG?.gcd));
    lines.push('');
  }
  if (a.conRG) {
    lines.push(`Time to RG:     ${fmt(a.conRG.time)}s (${a.conRG.gcd} GCDs)`);
  } else {
    lines.push('Time to RG:     NOT REACHED within simulation window');
  }
  if (a.conMargin > 0) {
    lines.push(`Filler margin:  ${fmt(a.conMargin)}s (${a.conFillerGCDs} GCDs within RM)`);
  } else if (a.conRG) {
    lines.push(`Filler margin:  NONE - RG at ${fmt(a.conRG.time)}s exceeds RM ${fmt(p.rmRemains)}s`);
  }
  lines.push('');

  // GCD breakdown
  lines.push('--- GCD Budget (expected, to first RG) ---');
  const order = ['sc', 'sos', 'fracture', 'spb', 'sclv', 'filler'];
  const labels = { sc: 'Soul Carver', sos: 'SoS', fracture: 'Fracture', spb: 'Spirit Bomb', sclv: 'Soul Cleave', filler: 'Filler' };
  for (const key of order) {
    if (a.breakdown[key]) {
      lines.push(`  ${(labels[key] || key).padEnd(14)} ${a.breakdown[key]} GCDs`);
    }
  }
  lines.push(`  ${'TOTAL'.padEnd(14)} ${a.totalGCDs} GCDs`);
  lines.push('');

  // AotG sources
  lines.push('--- AotG Sources (expected) ---');
  lines.push(`  Overflow (gen at cap):  ${a.aotgOverflow}`);
  lines.push(`  Spend (SpB/SClv):      ${a.aotgSpend}`);
  lines.push(`  Passive + SC DoT:      ${Math.max(0, a.aotgPassive)}`);
  if (p.startAotg > 0) {
    lines.push(`  Starting stacks:       ${p.startAotg}`);
  }
  lines.push('');

  // Optimal sequence
  lines.push('--- Optimal Sequence ---');
  lines.push(`  ${a.sequence.join(' -> ')}`);
  lines.push('');

  // APL implications
  lines.push('--- APL Implications ---');
  const passiveOffset = a.passivePerGCD * (a.expRG?.gcd ?? 0);
  lines.push(`Passive frag rate:     ${fmt(a.passivePerSec)}/s = ~${fmt(a.passivePerGCD)} frags/GCD`);
  lines.push(`Total passive (to RG): ~${fmt(passiveOffset, 1)} frags over ${a.expRG?.gcd ?? '?'} GCDs`);
  lines.push(`Filler-RG feasible:    ${a.expFillerGCDs >= 1 ? 'YES' : 'NO'} (${a.expFillerGCDs} exp / ${a.conFillerGCDs} con filler GCDs)`);

  if (a.expRG && a.conRG) {
    const delta = a.conRG.time - a.expRG.time;
    lines.push(`Passive variance:      ${fmt(delta)}s (${a.conRG.gcd - a.expRG.gcd} GCDs) between expected/conservative`);
  }

  return lines.join('\n');
}

// ============================================================
// Main
// ============================================================

const cli = parseCli();
const profile = buildProfile(cli);

const expResult = simulate(profile, false);
const conResult = simulate(profile, true);
const analysis = analyze(profile, expResult, conResult);

console.log(formatResults(profile, expResult, conResult, analysis));
