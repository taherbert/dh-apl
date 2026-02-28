// VDH-specific divergence fix hints and frequency estimation.
// Moved from divergence.js to keep shared code spec-agnostic.

export function estimateFrequency(opt, apl) {
  const optAbility = opt.ability;
  const aplAbility = apl.ability;

  if (optAbility === "metamorphosis" || aplAbility === "metamorphosis")
    return "Meta CD (~3min)";
  if (optAbility === "spirit_bomb" && aplAbility === "fracture")
    return "SpB window";
  if (optAbility === "spirit_bomb" || aplAbility === "spirit_bomb")
    return "SpB window (~8-10s)";
  if (optAbility === "fel_devastation" || aplAbility === "fel_devastation")
    return "FelDev CD (~30-40s)";
  if (optAbility === "fiery_brand" || aplAbility === "fiery_brand")
    return "FB CD (~60s)";
  if (optAbility === "reavers_glaive" || aplAbility === "reavers_glaive")
    return "RG proc";
  return "intermittent";
}

export function generateFixHint(opt, apl, preState, buildConfig, branchDesc) {
  const optAbility = opt.ability;
  const aplAbility = apl.ability;
  const frags = preState.soul_fragments;
  const inMeta = preState.buffs.metamorphosis > 0;
  const vfSpending = preState.buffStacks?.voidfall_spending ?? 0;
  const fbActive = (preState.dots?.fiery_brand || 0) > 0;

  if (optAbility === "spirit_bomb" && aplAbility === "fracture") {
    const base = inMeta
      ? `spb_threshold condition during Meta may be too high (frags=${frags}, threshold likely${frags >= 4 ? " correct" : ` requires ${frags}>=threshold`})`
      : fbActive
        ? `SpB under Fiery Demise: APL spb_threshold or fiery_demise_active condition may not be triggering (frags=${frags}, fb_active=${fbActive})`
        : `SpB gating condition too strict at frags=${frags}; APL chose Fracture instead`;
    return `${base}. ${branchDesc}`;
  }

  if (optAbility === "metamorphosis" && aplAbility !== "metamorphosis") {
    if (frags < 3) {
      return `APL gates Meta on soul_fragments>=3; at frags=${frags} APL delays. Consider whether pre-loading Fracture costs more than it gains. ${branchDesc}`;
    }
    if (vfSpending > 0) {
      return `APL blocks Meta during VF spending phase (spending=${vfSpending}); timing interaction with VF dump. ${branchDesc}`;
    }
    return `Meta timing: APL delays while optimal fires. ${branchDesc}`;
  }

  if (optAbility === "fel_devastation" && aplAbility !== "fel_devastation") {
    if (fbActive) {
      return `FelDev should fire under Fiery Demise (+30% fire amp); APL chose ${aplAbility} instead. ${branchDesc}`;
    }
    if (inMeta) {
      return `FelDev in Meta: APL may be gating on !apex.3|talent.darkglare_boon; verify DGB flag. ${branchDesc}`;
    }
    return `FelDev opportunity: APL chose ${aplAbility}; check cooldown priority or voidfall_spending gate. ${branchDesc}`;
  }

  if (optAbility === "fiery_brand" && !fbActive) {
    return `FB should be applied to enable Fiery Demise; APL chose ${aplAbility}. Check cooldown conditions. ${branchDesc}`;
  }

  if (optAbility === "spirit_bomb" && aplAbility === "soul_cleave") {
    const base =
      vfSpending > 0
        ? `VF spending phase: optimal wants SpB at spending=${vfSpending} but APL chose SC; check voidfall spending conditions`
        : `SpB vs SC: ${frags} frags available, optimal prefers SpB for fragment efficiency`;
    return `${base}. ${branchDesc}`;
  }

  if (isFragmentGenerator(optAbility) && isFragmentSpender(aplAbility)) {
    return `APL spending fragments when optimal would generate; frags=${frags} may be above optimal spending threshold. ${branchDesc}`;
  }

  if (isFragmentSpender(optAbility) && isFragmentGenerator(aplAbility)) {
    return `APL generating fragments when optimal would spend; frags=${frags} sufficient for ${optAbility} but APL generated more first. ${branchDesc}`;
  }

  return branchDesc;
}

function isFragmentGenerator(ability) {
  return [
    "fracture",
    "soul_carver",
    "sigil_of_spite",
    "immolation_aura",
  ].includes(ability);
}

function isFragmentSpender(ability) {
  return ["spirit_bomb", "soul_cleave"].includes(ability);
}
