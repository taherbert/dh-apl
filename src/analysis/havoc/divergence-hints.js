// Havoc-specific divergence fix hints.
// Minimal starter — expand during /optimize when divergence data is available.

export function estimateFrequency(opt, apl) {
  const optAbility = opt.ability;
  const aplAbility = apl.ability;

  if (optAbility === "metamorphosis" || aplAbility === "metamorphosis")
    return "Meta CD (~4min)";
  if (optAbility === "eye_beam" || aplAbility === "eye_beam")
    return "Eye Beam CD (~40s)";
  if (optAbility === "essence_break" || aplAbility === "essence_break")
    return "EB CD (~25s)";
  if (optAbility === "the_hunt" || aplAbility === "the_hunt")
    return "Hunt CD (~90s)";
  return "intermittent";
}

export function generateFixHint(opt, apl, preState, buildConfig, branchDesc) {
  return branchDesc;
}
