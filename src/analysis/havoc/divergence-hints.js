// Havoc-specific divergence fix hints and frequency estimation.
// Minimal starter - expand during /optimize.

export function estimateFrequency(opt, apl) {
  const optAbility = opt.ability;
  const aplAbility = apl.ability;

  if (optAbility === "metamorphosis" || aplAbility === "metamorphosis")
    return "Meta CD (~4min)";
  if (optAbility === "eye_beam" || aplAbility === "eye_beam")
    return "Eye Beam CD (~40s)";
  if (optAbility === "essence_break" || aplAbility === "essence_break")
    return "Essence Break CD (~25s)";
  if (optAbility === "the_hunt" || aplAbility === "the_hunt")
    return "The Hunt CD (~90s)";
  return "intermittent";
}

export function generateFixHint(_opt, _apl, _preState, _buildConfig, branchDesc) {
  return branchDesc;
}
