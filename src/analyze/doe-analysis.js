// Post-simulation DoE analysis: fits OLS regression with main effects and
// 2-way interactions, predicts optimal builds, and generates diagnostics.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");

// --- OLS regression ---

// Solve normal equations: β = (X'X)^(-1) X'y
// X is the design matrix (n × p), y is the response vector (n × 1)
// Returns coefficient vector β (p × 1)
function solveOLS(X, y) {
  const n = X.length;
  const p = X[0].length;

  // Compute X'X (p × p)
  const XtX = Array.from({ length: p }, () => new Float64Array(p));
  for (let i = 0; i < p; i++) {
    for (let j = i; j < p; j++) {
      let sum = 0;
      for (let k = 0; k < n; k++) sum += X[k][i] * X[k][j];
      XtX[i][j] = sum;
      XtX[j][i] = sum;
    }
  }

  // Compute X'y (p × 1)
  const Xty = new Float64Array(p);
  for (let i = 0; i < p; i++) {
    let sum = 0;
    for (let k = 0; k < n; k++) sum += X[k][i] * y[k];
    Xty[i] = sum;
  }

  // Solve via Cholesky decomposition (XtX is positive semi-definite)
  // Add small ridge for numerical stability
  const ridge = 1e-8;
  for (let i = 0; i < p; i++) XtX[i][i] += ridge;

  const L = choleskyDecomp(XtX, p);
  if (!L) return null;

  // Forward substitution: L * z = Xty
  const z = new Float64Array(p);
  for (let i = 0; i < p; i++) {
    let sum = Xty[i];
    for (let j = 0; j < i; j++) sum -= L[i][j] * z[j];
    z[i] = sum / L[i][i];
  }

  // Back substitution: L' * β = z
  const beta = new Float64Array(p);
  for (let i = p - 1; i >= 0; i--) {
    let sum = z[i];
    for (let j = i + 1; j < p; j++) sum -= L[j][i] * beta[j];
    beta[i] = sum / L[i][i];
  }

  return beta;
}

function choleskyDecomp(A, n) {
  const L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        if (sum <= 0) return null; // Not positive definite
        L[i][j] = Math.sqrt(sum);
      } else {
        L[i][j] = sum / L[j][j];
      }
    }
  }
  return L;
}

// Build the regression matrix: intercept + main effects + 2-way interactions
function buildRegressionMatrix(factorMatrix) {
  const n = factorMatrix.length;
  const K = factorMatrix[0].length;

  // Column layout: [intercept, x1, x2, ..., xK, x1*x2, x1*x3, ..., x(K-1)*xK]
  const nInteractions = (K * (K - 1)) / 2;
  const p = 1 + K + nInteractions;
  const X = [];

  for (let row = 0; row < n; row++) {
    const xRow = new Float64Array(p);
    xRow[0] = 1; // intercept

    // Main effects (centered: -1/+1 coding)
    for (let j = 0; j < K; j++) {
      xRow[1 + j] = factorMatrix[row][j] * 2 - 1; // 0→-1, 1→+1
    }

    // 2-way interactions
    let idx = 1 + K;
    for (let i = 0; i < K; i++) {
      for (let j = i + 1; j < K; j++) {
        xRow[idx++] = xRow[1 + i] * xRow[1 + j];
      }
    }

    X.push(xRow);
  }

  return { X, p, K, nInteractions };
}

// --- Model fitting ---

export function fitModel(factors, designMatrix, dpsResults) {
  const n = designMatrix.length;
  const K = factors.length;

  const { X, p, nInteractions } = buildRegressionMatrix(designMatrix);

  const beta = solveOLS(X, dpsResults);
  if (!beta) return { error: "OLS solve failed (singular matrix)" };

  // Predictions and residuals
  const yHat = X.map((row) => {
    let sum = 0;
    for (let j = 0; j < p; j++) sum += row[j] * beta[j];
    return sum;
  });

  const residuals = dpsResults.map((y, i) => y - yHat[i]);
  const yMean = dpsResults.reduce((s, v) => s + v, 0) / n;
  const ssTot = dpsResults.reduce((s, v) => s + (v - yMean) ** 2, 0);
  const ssRes = residuals.reduce((s, v) => s + v ** 2, 0);
  const rSquared = 1 - ssRes / ssTot;
  const adjRSquared = 1 - ((1 - rSquared) * (n - 1)) / (n - p - 1);
  const rmse = Math.sqrt(ssRes / (n - p));

  // Extract coefficients
  const intercept = beta[0];
  const mainEffects = [];
  for (let i = 0; i < K; i++) {
    mainEffects.push({
      factor: factors[i].name,
      nodeId: factors[i].nodeId,
      type: factors[i].type,
      coefficient: beta[1 + i],
      dpsImpact: beta[1 + i] * 2, // Full swing from -1 to +1
    });
  }

  const interactions = [];
  let idx = 1 + K;
  for (let i = 0; i < K; i++) {
    for (let j = i + 1; j < K; j++) {
      const coeff = beta[idx++];
      if (Math.abs(coeff) > rmse * 0.1) {
        // Only report interactions above noise floor
        interactions.push({
          factorA: factors[i].name,
          factorB: factors[j].name,
          nodeIdA: factors[i].nodeId,
          nodeIdB: factors[j].nodeId,
          coefficient: coeff,
          dpsImpact: coeff * 4, // Full swing of interaction term
        });
      }
    }
  }

  // Sort by absolute DPS impact
  mainEffects.sort((a, b) => Math.abs(b.dpsImpact) - Math.abs(a.dpsImpact));
  interactions.sort((a, b) => Math.abs(b.dpsImpact) - Math.abs(a.dpsImpact));

  return {
    intercept,
    mainEffects,
    interactions,
    rSquared,
    adjRSquared,
    rmse,
    n,
    p,
    K,
    nInteractions,
  };
}

// --- Optimal build prediction ---

export function predictOptimal(model, factors) {
  if (!model || model.error) return null;

  // Greedy: set each factor to the level that maximizes predicted DPS,
  // considering main effects and interactions with already-set factors.
  // Start from the highest-impact factors.
  const settings = new Array(factors.length).fill(0);

  // Sort factors by absolute main effect (largest first)
  const order = model.mainEffects
    .map((e, i) => ({
      idx: factors.findIndex(
        (f) => f.nodeId === e.nodeId && f.name === e.factor,
      ),
      impact: e.dpsImpact,
    }))
    .filter((e) => e.idx >= 0)
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));

  for (const { idx, impact } of order) {
    // Try both levels, pick the one with higher predicted DPS
    settings[idx] = 0;
    const dps0 = predictDPS(model, factors, settings);
    settings[idx] = 1;
    const dps1 = predictDPS(model, factors, settings);
    settings[idx] = dps1 >= dps0 ? 1 : 0;
  }

  const predictedDPS = predictDPS(model, factors, settings);

  return {
    settings: Object.fromEntries(factors.map((f, i) => [f.name, settings[i]])),
    predictedDPS,
  };
}

function predictDPS(model, factors, settings) {
  const K = factors.length;
  let dps = model.intercept;

  // Main effects
  for (let i = 0; i < K; i++) {
    const x = settings[i] * 2 - 1;
    const effect = model.mainEffects.find((e) => e.factor === factors[i].name);
    if (effect) dps += effect.coefficient * x;
  }

  // Interactions
  for (const inter of model.interactions) {
    const iA = factors.findIndex((f) => f.name === inter.factorA);
    const iB = factors.findIndex((f) => f.name === inter.factorB);
    if (iA >= 0 && iB >= 0) {
      const xA = settings[iA] * 2 - 1;
      const xB = settings[iB] * 2 - 1;
      dps += inter.coefficient * xA * xB;
    }
  }

  return dps;
}

// --- Confirmation builds ---

export function generateConfirmationBuilds(model, factors, topN = 10) {
  if (!model || model.error) return [];

  // Generate top N builds by trying variations of the optimal
  const optimal = predictOptimal(model, factors);
  if (!optimal) return [];

  const builds = [{ ...optimal, rank: 1, type: "optimal" }];

  // Generate variations by flipping each factor from optimal
  const variations = [];
  for (let i = 0; i < factors.length; i++) {
    const settings = Object.values(optimal.settings);
    settings[i] = 1 - settings[i]; // flip
    const dps = predictDPS(model, factors, settings);
    variations.push({
      settings: Object.fromEntries(
        factors.map((f, j) => [f.name, settings[j]]),
      ),
      predictedDPS: dps,
      flippedFactor: factors[i].name,
      type: "variation",
    });
  }

  // Sort by predicted DPS and take top N
  variations.sort((a, b) => b.predictedDPS - a.predictedDPS);
  for (let i = 0; i < Math.min(topN - 1, variations.length); i++) {
    builds.push({ ...variations[i], rank: i + 2 });
  }

  return builds;
}

// --- Diagnostics ---

export function diagnostics(model) {
  if (!model || model.error) return model;

  return {
    modelFit: {
      rSquared: model.rSquared,
      adjRSquared: model.adjRSquared,
      rmse: model.rmse,
      observations: model.n,
      parameters: model.p,
    },
    topMainEffects: model.mainEffects.slice(0, 20).map((e) => ({
      talent: e.factor,
      dpsImpact: Math.round(e.dpsImpact),
      direction: e.dpsImpact > 0 ? "positive" : "negative",
    })),
    topInteractions: model.interactions.slice(0, 20).map((i) => ({
      talentA: i.factorA,
      talentB: i.factorB,
      dpsImpact: Math.round(i.dpsImpact),
      synergy: i.dpsImpact > 0 ? "synergy" : "anti-synergy",
    })),
    warnings: [
      ...(model.rSquared < 0.8
        ? [
            `Low R² (${model.rSquared.toFixed(3)}): model explains < 80% of DPS variance. ` +
              `Higher-order interactions or non-linear effects likely present.`,
          ]
        : []),
      ...(model.n < model.p * 2
        ? [
            `Underdetermined: ${model.n} observations for ${model.p} parameters. ` +
              `Results may be unreliable.`,
          ]
        : []),
    ],
  };
}

// --- CLI entry point ---

if (import.meta.url === `file://${process.argv[1]}`) {
  // Load talent combos data
  const combosData = JSON.parse(
    readFileSync(join(DATA_DIR, "talent-combos.json"), "utf8"),
  );

  const factors = combosData.factors.spec;

  // Check for simulation results
  const resultsPath = join(DATA_DIR, "..", "results", "doe-results.json");
  let dpsResults;
  try {
    dpsResults = JSON.parse(readFileSync(resultsPath, "utf8"));
  } catch {
    // Generate synthetic data for testing
    console.log(
      "No simulation results found. Generating synthetic test data...",
    );
    const builds = combosData.builds;
    dpsResults = builds.map((b) => {
      // Synthetic DPS based on known-good talents with noise
      let dps = 3000000;
      const specNodes = new Set(b.specNodes || []);
      // Spirit Bomb = big DPS boost
      if (specNodes.has(90970)) dps += 150000;
      // Fiery Demise = moderate boost
      if (specNodes.has(90958)) dps += 80000;
      // Soul Carver = moderate
      if (specNodes.has(90982)) dps += 60000;
      // Noise
      dps += (Math.random() - 0.5) * 50000;
      return { buildName: b.name, dps: Math.round(dps) };
    });
    console.log(`Generated ${dpsResults.length} synthetic DPS values\n`);
  }

  // Build factor matrix from builds
  const builds = combosData.builds;
  const factorMatrix = builds.map((b) =>
    factors.map((f) => {
      const specNodes = new Set(b.specNodes || []);
      const specRanks = b.specRanks || {};
      if (f.type === "choice") return b.specChoices?.[f.nodeId] || 0;
      if (f.type === "multi_rank_r2")
        return (specRanks[f.nodeId] || 0) >= 2 ? 1 : 0;
      if (f.type === "multi_rank_r1")
        return (specRanks[f.nodeId] || 0) >= 1 ? 1 : 0;
      return specNodes.has(f.nodeId) ? 1 : 0;
    }),
  );

  const dpsValues = dpsResults.map((r) => r.dps);

  // Fit model
  const model = fitModel(factors, factorMatrix, dpsValues);
  if (model.error) {
    console.error("Model fitting failed:", model.error);
    process.exit(1);
  }

  // Diagnostics
  const diag = diagnostics(model);
  console.log("=== DoE Analysis Results ===\n");
  console.log(
    `Model fit: R² = ${diag.modelFit.rSquared.toFixed(4)}, adj R² = ${diag.modelFit.adjRSquared.toFixed(4)}`,
  );
  console.log(`RMSE: ${Math.round(diag.modelFit.rmse)} DPS`);
  console.log(
    `Observations: ${diag.modelFit.observations}, Parameters: ${diag.modelFit.parameters}\n`,
  );

  if (diag.warnings.length > 0) {
    console.log("Warnings:");
    for (const w of diag.warnings) console.log(`  ⚠ ${w}`);
    console.log();
  }

  console.log("Top main effects (DPS impact of taking talent):");
  for (const e of diag.topMainEffects.slice(0, 15)) {
    const sign = e.dpsImpact > 0 ? "+" : "";
    console.log(`  ${sign}${e.dpsImpact} ${e.talent}`);
  }

  console.log("\nTop interactions:");
  for (const i of diag.topInteractions.slice(0, 10)) {
    const sign = i.dpsImpact > 0 ? "+" : "";
    console.log(
      `  ${sign}${i.dpsImpact} ${i.talentA} × ${i.talentB} (${i.synergy})`,
    );
  }

  // Predict optimal
  const optimal = predictOptimal(model, factors);
  if (optimal) {
    console.log(`\nPredicted optimal DPS: ${Math.round(optimal.predictedDPS)}`);
    const taken = Object.entries(optimal.settings)
      .filter(([, v]) => v === 1)
      .map(([k]) => k);
    console.log(`Talents taken (${taken.length}): ${taken.join(", ")}`);
  }

  // Confirmation builds
  const confirms = generateConfirmationBuilds(model, factors, 5);
  if (confirms.length > 0) {
    console.log("\nTop confirmation builds:");
    for (const c of confirms) {
      console.log(
        `  #${c.rank} ${Math.round(c.predictedDPS)} DPS (${c.type}${c.flippedFactor ? `: flip ${c.flippedFactor}` : ""})`,
      );
    }
  }

  // Save analysis
  const output = {
    model: {
      rSquared: model.rSquared,
      adjRSquared: model.adjRSquared,
      rmse: model.rmse,
    },
    mainEffects: model.mainEffects,
    interactions: model.interactions.slice(0, 50),
    optimal,
    confirmationBuilds: confirms,
    diagnostics: diag,
  };

  writeFileSync(
    join(DATA_DIR, "doe-analysis.json"),
    JSON.stringify(output, null, 2),
  );
  console.log("\nWrote analysis to data/doe-analysis.json");
}
