// Semantic fingerprinting for hypothesis identity matching.
// Detects when different sources flag the same underlying APL issue
// by extracting a canonical identity from heterogeneous hypothesis formats.

// Normalize ability name: lowercase, strip suffixes, collapse variants
function normalizeAbility(name) {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/ damage$/, "")
    .replace(/ heal$/, "");
}

// Extract phase from hypothesis metadata or text
function extractPhase(h) {
  if (h.phase) return h.phase;
  const text = (h.summary || h.hypothesis || h.title || "").toLowerCase();
  if (text.includes("opener")) return "opener";
  if (text.includes("execute") || text.includes("time_to_die"))
    return "execute";
  if (
    text.includes("burst") ||
    text.includes("fiery_brand") ||
    text.includes("fiery brand")
  )
    return "burst";
  return "midFight";
}

// Build fingerprint from a divergence-style hypothesis (optAbility vs actAbility)
function fingerprintFromDivergence(h) {
  const meta = h.metadata || {};
  const opt = normalizeAbility(meta.optAbility || meta.optimalAbility);
  const act = normalizeAbility(meta.actAbility || meta.actualAbility);
  if (opt && act) {
    const phase = extractPhase(h);
    return `swap:${opt}:over:${act}:${phase}`;
  }
  return null;
}

// Build fingerprint from a strategic/theorycraft hypothesis (mutation-based)
function fingerprintFromMutation(h) {
  let mutation = h.mutation || h.aplMutation;
  if (!mutation) return null;

  // DB stores mutations as JSON strings
  if (typeof mutation === "string") {
    try {
      mutation = JSON.parse(mutation);
    } catch {
      return null;
    }
  }

  const type = (mutation.type || "").toLowerCase();
  const ability = normalizeAbility(mutation.ability);
  const list = (mutation.list || "").toLowerCase();

  if ((type === "move_up" || type === "move_down") && ability) {
    const dir = type === "move_up" ? "up" : "down";
    const phase = extractPhase(h);
    return `priority:${ability}:${dir}:${list || "default"}:${phase}`;
  }
  if ((type === "add_condition" || type === "remove_condition") && ability) {
    const buff = normalizeAbility(
      mutation.targetBuff || mutation.condition || "",
    );
    return `condition:${ability}:${type}:${buff}`;
  }
  if ((type === "relax_threshold" || type === "tighten_threshold") && ability) {
    const resource = (mutation.resource || "").toLowerCase();
    return `threshold:${ability}:${resource}:${type}`;
  }
  if (type === "insert_action" && ability) {
    return `insert:${ability}:${list || "default"}`;
  }
  if (type === "delete_action" && ability) {
    return `delete:${ability}:${list || "default"}`;
  }

  return `mutation:${type}:${ability || "unknown"}`;
}

// Build fingerprint from text-based hypothesis (theory-generator, synthesizer)
function fingerprintFromText(h) {
  const text = (
    h.summary ||
    h.hypothesis ||
    h.title ||
    h.normalizedId ||
    ""
  ).toLowerCase();

  // "X should be used instead of Y" / "X preferred over Y"
  const swapMatch = text.match(
    /(\w[\w\s]*?)\s+(?:preferred over|instead of|over|replaces?)\s+(\w[\w\s]*?)(?:\s|$|,|\()/,
  );
  if (swapMatch) {
    const opt = normalizeAbility(swapMatch[1]);
    const act = normalizeAbility(swapMatch[2]);
    const phase = extractPhase(h);
    return `swap:${opt}:over:${act}:${phase}`;
  }

  // "Prioritize X" / "X should be higher priority"
  const prioMatch = text.match(
    /(?:prioritize|raise priority of|move up)\s+(\w[\w\s]*?)(?:\s|$|,)/,
  );
  if (prioMatch) {
    return `priority:${normalizeAbility(prioMatch[1])}:up:default:${extractPhase(h)}`;
  }

  // "Resource overflow for X"
  const overflowMatch = text.match(
    /(?:overflow|waste|cap)\s+(?:for |of |on )?(\w+)/,
  );
  if (overflowMatch) {
    return `resource:${overflowMatch[1].toLowerCase()}:overflow`;
  }

  // "CD alignment: X should sync with Y"
  const syncMatch = text.match(
    /(?:align|sync)\s+(\w[\w\s]*?)\s+(?:with|during)\s+(\w[\w\s]*?)(?:\s|$|,)/,
  );
  if (syncMatch) {
    return `sync:${normalizeAbility(syncMatch[1])}:with:${normalizeAbility(syncMatch[2])}`;
  }

  return null;
}

// Main fingerprinting function: extract canonical identity from any hypothesis format
export function fingerprintHypothesis(hypothesis) {
  // Try mutation-based first (most precise)
  const mutFp = fingerprintFromMutation(hypothesis);
  if (mutFp) return mutFp;

  // Try divergence metadata (structured ability pairs)
  const divFp = fingerprintFromDivergence(hypothesis);
  if (divFp) return divFp;

  // Try synthesizer's normalizedId
  if (hypothesis.normalizedId) {
    return `synth:${hypothesis.normalizedId}`;
  }

  // Try text-based extraction
  const textFp = fingerprintFromText(hypothesis);
  if (textFp) return textFp;

  // Fallback: hash the summary
  const text = (
    hypothesis.summary ||
    hypothesis.hypothesis ||
    hypothesis.title ||
    ""
  )
    .toLowerCase()
    .replace(/[\d.]+%?/g, "N")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 80);
  return `text:${text}`;
}

// Group hypotheses by their fingerprint
export function matchHypotheses(hypotheses) {
  const groups = new Map();

  for (const h of hypotheses) {
    const fp = fingerprintHypothesis(h);
    if (!groups.has(fp)) {
      groups.set(fp, []);
    }
    groups.get(fp).push(h);
  }

  return groups;
}
