// Batch-create first-principles theories and derived hypotheses in theorycraft DB.
// Run: SPEC=vengeance node scripts/create-first-principles-theories.js

import { initSpec } from "../src/engine/startup.js";
import { addTheory, addHypothesis } from "../src/util/db.js";

await initSpec("vengeance");

const theories = [
  {
    title: "Multiplier Window Density",
    category: "burst_windows",
    confidence: 0.7,
    tags: [
      "fiery_demise",
      "brand",
      "soul_carver",
      "fel_devastation",
      "fire_school",
    ],
    reasoning: `Fire damage under Fiery Demise (+15%) during Meta (+20%) gets 1.38x compound amplification. DPS-optimal behavior maximizes fire-school damage concentration inside overlapping Brand+Meta windows.

Predicted optimal sequencing inside Brand:
1. SBomb@3+ (applies Frailty debuff — amplifies all subsequent damage)
2. ImmAura (Charred Flesh extends Brand + Fallout frags)
3. Soul Carver (2.08 AP instant fire + 4-6 fragment burst)
4. FelDev (1.54 AP fire, only if Brand has 4+ seconds remaining)
5. SBomb again (consumes Soul Carver fragments under Brand amp)

Current APL matches on: Frailty-first sequencing, Charred Flesh ImmAura, Soul Carver priority.

Gaps identified:
1. FelDev in Brand window has no duration check (dot.fiery_brand.remains>4)
2. Sigil of Spite (Chaos school) in AR Brand sync condition provides no fire amp benefit
3. Anni has no Brand+fire CD sync at all`,
    evidence: [
      {
        type: "source_verified",
        detail: "Fiery Demise +15% fire amp confirmed in SPEC_CONFIG",
        at: "2026-02-12",
      },
      {
        type: "source_verified",
        detail: "Spite is Chaos school, confirmed in spells-summary.json",
        at: "2026-02-12",
      },
      {
        type: "apl_audit",
        detail: "ar_brand_window sequencing is Frailty→ImmAura→SC→Spite→FelDev",
        at: "2026-02-12",
      },
    ],
    hypotheses: [
      {
        summary: "Gate FelDev in Brand window by Brand remaining time (>4s)",
        implementation:
          "Add dot.fiery_brand.remains>4 to FelDev in ar_brand_window",
        category: "burst_windows",
        priority: 6.0,
        source: "first-principles-T1",
      },
      {
        summary:
          "Remove Sigil of Spite from AR Brand sync condition (Chaos school, no FD benefit)",
        implementation:
          "Remove cooldown.sigil_of_spite.remains<6 from ar_cooldowns Brand condition",
        category: "burst_windows",
        priority: 5.5,
        source: "first-principles-T1",
      },
    ],
  },
  {
    title: "Meta GCD Budget Allocation",
    category: "resource_management",
    confidence: 0.75,
    tags: ["metamorphosis", "fel_devastation", "dpgcd", "gcd_budget"],
    reasoning: `Meta is a finite window (~10-13 GCDs). FelDev channel = 3.5 GCD-equivalents at 0.53 AP/GCD during Meta — the worst on-GCD ability. Alternative Fracture+SBomb rotation during those 3.5 GCDs produces 5.02 AP vs FelDev's 1.85 AP. Opportunity cost: -3.17 AP per FelDev during Meta.

Even with Brand amp (FelDev+Brand+Meta = 2.13 AP), the alternative combo at 5.02 AP is still -2.89 AP better.

Exception: Anni Meteoric Rise FelDev during Voidfall spending at stack=3 when fragment-starved is correctly gated — meteor damage justifies it.

Current APL has no Meta gate on FelDev in either AR or Anni main rotation. FelDev can fire during Meta when no empowered cycle or Brand window is active.

C++ source verified: Meta buff provides +20% damage amp (multiplicative).`,
    evidence: [
      {
        type: "calculation",
        detail:
          "FelDev DPGCD: 1.85/3.5=0.53. Fracture+SBomb@4 DPGCD: 5.02/3.5=1.43. Delta: -3.17 AP",
        at: "2026-02-12",
      },
      {
        type: "apl_audit",
        detail:
          "ar_cooldowns: FelDev gated by empowered cycle only, no Meta check",
        at: "2026-02-12",
      },
      {
        type: "apl_audit",
        detail: "anni: FelDev gated by !voidfall_spending only, no Meta check",
        at: "2026-02-12",
      },
    ],
    hypotheses: [
      {
        summary:
          "Gate FelDev by !buff.metamorphosis.up to avoid wasting Meta GCDs on low-DPGCD channel",
        implementation:
          "Add !buff.metamorphosis.up to FelDev in ar_cooldowns and anni main list. Allow exception: variable.fiery_demise_active&soul_fragments<variable.spb_threshold (Brand+Meta overlap where fire amp + frag gen is justified)",
        category: "resource_management",
        priority: 7.5,
        source: "first-principles-T2",
      },
    ],
  },
  {
    title: "Fragment Economy — Dual-Resource Coupling",
    category: "resource_management",
    confidence: 0.65,
    tags: [
      "soul_fragments",
      "fury",
      "fracture",
      "overcap",
      "soul_carver",
      "pipeline",
    ],
    reasoning: `Fracture is the sole dual-resource generator (Fury + Fragments). The fragment bottleneck analysis:
- Normal: 2.5 Fractures for 5 frags vs 1.6 for 40 Fury → fragment-bottlenecked
- Meta: 1.33 Fractures for 4 frags vs 1.0 for 40 Fury → fragment-bottlenecked (barely)

Per-fragment value: ~1.15 AP (0.4 AP direct SBomb contribution + 0.75 AP pipeline acceleration from saved Fracture GCDs).

Fragment overcap cost: Soul Carver generates 4-6 frags over DoT. At 4+ existing frags outside Brand, 2+ frags overcap = 2.3 AP lost. Soul Carver direct damage is 2.08 AP. Net loss when overcapping heavily.

Current APL: Anni gates Soul Carver at soul_fragments<=3. AR does NOT gate Soul Carver outside Brand — only during Brand is it unconditional (justified by 1.15x fire amp offsetting overcap cost).

Fracture charge management has an FD exception in ST that can allow charge cap during Brand windows.`,
    evidence: [
      {
        type: "calculation",
        detail: "Per-frag value: 0.4 AP (SBomb) + 0.75 AP (pipeline) = 1.15 AP",
        at: "2026-02-12",
      },
      {
        type: "calculation",
        detail:
          "SC overcap at 4 existing frags: 2+ frags wasted = 2.3 AP lost vs 2.08 AP direct",
        at: "2026-02-12",
      },
      {
        type: "apl_audit",
        detail:
          "AR Soul Carver in ar_cooldowns: gated by FD only, no fragment check",
        at: "2026-02-12",
      },
      {
        type: "apl_audit",
        detail: "Anni Soul Carver: soul_fragments<=3 gate is correct",
        at: "2026-02-12",
      },
    ],
    hypotheses: [
      {
        summary:
          "Add soul_fragments<=3 gate to AR Soul Carver outside Brand window",
        implementation:
          "In ar_cooldowns, change soul_carver condition to: soul_carver,if=(!talent.fiery_demise|variable.fiery_demise_active)&(variable.fiery_demise_active|soul_fragments<=3)",
        category: "resource_management",
        priority: 6.5,
        source: "first-principles-T3",
      },
    ],
  },
  {
    title: "Cooldown Cadence — Natural Alignment",
    category: "cooldown_management",
    confidence: 0.8,
    tags: ["cooldowns", "alignment", "brand", "meta", "cadence"],
    reasoning: `CD timings create a natural rhythm: Meta(120s), Brand(48-60s w/DiF), Soul Carver(60s), FelDev(40s), SBomb(~25s), Spite(60s).

Key cadence insights:
1. FelDev (40s) aligns with Brand only at t=0 and t=120. Holding from t=40→48 wastes 8s of CD time. ~1 lost cast over 5min = 1.54 AP. NOT worth holding.
2. Soul Carver (60s) naturally aligns with Brand. Hold up to 6s costs zero casts. Always sync.
3. Meta (120s) should never be delayed. 1s delay = 1.2 AP lost.
4. Spite (60s) is Chaos school — Brand sync provides no fire amp. Free-run on CD.
5. Brand charges (2 via DiF): Using on CD ensures a charge available by Meta convergence.

Current APL matches on: Meta never delayed, FelDev free-runs, Soul Carver held for Brand (via ar_cooldowns FD gate).

Gaps: Spite in Brand sync (Chaos school, no benefit). Brand charge reservation for Meta is implicit only.`,
    evidence: [
      {
        type: "calculation",
        detail:
          "FelDev hold cost: 8s delay = ~0.2 casts lost per 120s cycle = 0.31 AP/min",
        at: "2026-02-12",
      },
      {
        type: "calculation",
        detail: "Meta delay cost: 1s = 0.20 * 6 AP/s = 1.2 AP",
        at: "2026-02-12",
      },
      {
        type: "apl_audit",
        detail:
          "Meta fires on CD in both AR and Anni. FelDev free-runs. Brand syncs to fire CDs.",
        at: "2026-02-12",
      },
    ],
    hypotheses: [],
  },
  {
    title: "Hero State Machine Priority Integration",
    category: "state_machines",
    confidence: 0.85,
    tags: [
      "aldrachi_reaver",
      "annihilator",
      "empowered_cycle",
      "voidfall",
      "state_machine",
    ],
    reasoning: `AR empowered cycle and Anni Voidfall state machine are overlaid on base rotation.

AR Analysis: Empowered cycle (Physical school) fires BEFORE Brand window. This is correct:
- 3-GCD cycle applies Reaver's Mark (7-14% amp) which amplifies subsequent fire CDs
- Brand-first would waste Brand duration on Physical-school empowered abilities
- 4.5s cycle cost out of 10-12s Brand leaves 5.5-7.5s for fire CDs
- Confirmed optimal by +2.73% empowered cycle ordering fix

Anni Analysis: Voidfall spending correctly gates FelDev and Meta. However:
- During spending at stack 1-2, only Soul Cleave triggers meteors
- If Fury-starved, Soul Cleave can't fire
- Fracture (generates Fury+frags) is gated by !voidfall_spending in main list
- Safety-net ungated Fracture exists but is very low priority (below Felblade/ImmAura/SoF)
- Spending phase could stall if Fury generation delayed by filler priorities

Current APL is correct on all major state machine priorities. Minor gap on Anni Fracture priority during spending.`,
    evidence: [
      {
        type: "validated",
        detail:
          "AR empowered ordering confirmed +2.73% weighted DPS in iteration",
        at: "2026-02-12",
      },
      {
        type: "validated",
        detail: "Anni Meta at building<2 confirmed +0.105% in iteration",
        at: "2026-02-12",
      },
      {
        type: "apl_audit",
        detail:
          "Anni ungated Fracture is below Felblade/ImmAura/SoF in priority",
        at: "2026-02-12",
      },
    ],
    hypotheses: [
      {
        summary:
          "Move Fracture higher in Anni priority during Voidfall spending when Fury-starved",
        implementation:
          "Add fracture,if=buff.voidfall_spending.up&fury<40 before felblade in anni list",
        category: "state_machines",
        priority: 4.5,
        source: "first-principles-T5",
      },
    ],
  },
  {
    title: "The Filler Problem — Downtime Rotation Efficiency",
    category: "rotation_efficiency",
    confidence: 0.7,
    tags: ["filler", "fracture", "felblade", "immolation_aura", "dpgcd"],
    reasoning: `~60% of fight time is outside burst windows. Filler efficiency determines the baseline.

On-GCD DPGCD hierarchy (including resource value):
1. Fracture: 1.035 AP + pipeline value (~2.30 AP) = 3.34 effective DPGCD
2. SBomb@5: 2.00 AP direct
3. Soul Cleave: 1.29 AP - overcap only
4. Felblade: 1.00 AP at 0.5 GCD = 4.00 AP/GCD-second (highest efficiency!)
5. Sigil of Flame: 0.792 AP + 25 Fury + DoT = ~1.50 effective DPGCD
6. Throw Glaive: 0.60-0.73 AP (absolute last resort)

Fracture > Felblade ordering is correct despite Felblade's superior per-GCD efficiency because Fracture generates fragments that enable SBomb (the real damage dealer). Pipeline value dominates.

ImmAura is zero-GCD (off-GCD or instant?) and generates ~38-47 Fury total. Current APL has it in fillers list (unconditional) and conditionally in main lists (talent.fallout). This works via fallthrough but ImmAura uptime could be improved by higher priority in non-Fallout builds.

Soul Cleave correctly positioned as overcap valve (bottom of priority).`,
    evidence: [
      {
        type: "calculation",
        detail:
          "Felblade: 1.0 AP / 0.5 GCD = 4.0 AP/GCD. Fracture: 3.34 AP/GCD with pipeline",
        at: "2026-02-12",
      },
      {
        type: "calculation",
        detail:
          "Soul Cleave overcap prevention: +3.59 AP vs -2.30 AP frag waste",
        at: "2026-02-12",
      },
      {
        type: "apl_audit",
        detail: "Filler ordering matches theoretical hierarchy",
        at: "2026-02-12",
      },
    ],
    hypotheses: [],
  },
  {
    title: "Untethered Rage — Structural vs Fishing Value",
    category: "proc_management",
    confidence: 0.6,
    tags: [
      "untethered_rage",
      "seething_anger",
      "fishing",
      "metamorphosis",
      "blp",
    ],
    reasoning: `UR proc mechanic verified from SimC C++ source (sc_demon_hunter.cpp:2526):
chance = souls_consumed * 0.0075 * pow(1.35, seething_anger_stacks)

Single roll per cast, probability scaled by fragments consumed. NOT per-fragment individually.

Fishing analysis (proc attempts per GCD):
- SBomb@5 cycle: 0.0375/3.5 GCDs = 0.0107 chance/GCD
- SBomb@3 + SC weaving: (0.0225+0.015)/3 GCDs = 0.0125 chance/GCD
- Fishing wins by +17% proc rate per GCD — approach is mechanically correct

Fishing EV at different SA stacks:
- SA=6: +5% absolute proc chance, -3.0 AP damage loss. Net: -2.4 AP (negative)
- SA=8: +12% proc chance, -3.0 AP loss. Net: -1.56 AP (negative)
- SA=10: +24.5% proc chance, -3.0 AP loss. Net: -0.06 AP (breakeven)

The fishing window (6s remaining Meta) may not accumulate enough SA stacks to be profitable. Historical 8s→6s shortening was correct (less time at low SA). Adding an SA minimum threshold would filter out unprofitable fishing attempts.

Current APL has buff.seething_anger.up as minimum (SA>=1) but no stack threshold.`,
    evidence: [
      {
        type: "source_verified",
        detail:
          "UR proc: chance = souls * 0.0075 * 1.35^SA. Single roll per cast.",
        source: "sc_demon_hunter.cpp:2532",
        at: "2026-02-12",
      },
      {
        type: "source_verified",
        detail:
          "Seething Anger BLP: +1 stack per failed attempt during Meta (UR3 talented)",
        source: "sc_demon_hunter.cpp:2541-2543",
        at: "2026-02-12",
      },
      {
        type: "validated",
        detail: "UR fishing 8s->6s accepted +0.035% in iteration (PR #73)",
        at: "2026-02-12",
      },
      {
        type: "calculation",
        detail:
          "Fishing EV breakeven at SA~10. Current 6s window typically reaches SA=6-8.",
        at: "2026-02-12",
      },
    ],
    hypotheses: [
      {
        summary:
          "Add Seething Anger stack minimum (>=8) to UR fishing entry condition",
        implementation:
          "Change ur_fishing variable to: talent.untethered_rage&buff.metamorphosis.up&buff.metamorphosis.remains<6&!buff.untethered_rage.up&buff.seething_anger.stack>=8",
        category: "proc_management",
        priority: 5.0,
        source: "first-principles-T7",
      },
    ],
  },
];

let theoryCount = 0;
let hypothesisCount = 0;

for (const t of theories) {
  const theoryId = addTheory({
    spec: "vengeance",
    title: t.title,
    reasoning: t.reasoning,
    category: t.category,
    evidence: t.evidence,
    tags: t.tags,
    confidence: t.confidence,
  });
  theoryCount++;
  console.log(`Theory ${theoryId}: ${t.title} (confidence: ${t.confidence})`);

  for (const h of t.hypotheses || []) {
    const hypId = addHypothesis({
      theoryId,
      spec: "vengeance",
      summary: h.summary,
      implementation: h.implementation,
      category: h.category,
      priority: h.priority,
      source: h.source,
    });
    hypothesisCount++;
    console.log(`  Hypothesis ${hypId}: ${h.summary}`);
  }
}

console.log(
  `\nCreated ${theoryCount} theories and ${hypothesisCount} hypotheses.`,
);
