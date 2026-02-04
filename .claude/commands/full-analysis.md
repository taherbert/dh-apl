Deep theorycraft analysis of the VDH APL. Not a checklist — a thinking session.

The goal is systemic insight: understanding the resource economy, identifying conceptual tensions in the rotation, and proposing multi-part changes that address root causes rather than symptoms. Simple threshold tweaks and line reorderings are not the point — those fall out naturally once the underlying model is right.

## Setup

1. Read the analysis methodology: `prompts/apl-analysis-guide.md`
2. Read the APL to analyze. Use `$ARGUMENTS` if provided, else `apls/vengeance.simc`, else `apls/baseline.simc`.
3. Read spell data: `data/spells-summary.json`, `data/interactions-summary.json`, `data/cpp-proc-mechanics.json`
4. Read from-scratch modeling work: `plans/apl-from-scratch-v2.md` (sections 1.1–1.5 contain the resource value analysis, state machine models, GCD budget, and burst window math)
5. Check for sim results: `ls results/`. If none exist, run `node src/sim/runner.js <apl-file>` to establish a baseline.

## Phase 1: Model the Economy

Before looking at any individual APL line, build a mental model of the rotation as an economic system. Use the frameworks from the analysis guide (sections 1, 2, 10).

### Fury Economy

Compute the equilibrium. How much Fury enters the system per minute? How much leaves? Where is the surplus or deficit? What is the marginal damage value of 1 Fury spent on each available spender? Does the APL's spending pattern match the mathematically optimal allocation?

Key questions:

- Is the Fury generation rate matched to the spending rate, or is one side bottlenecked?
- What is the opportunity cost of each Fury spent? (Soul Cleave at 30 Fury vs Spirit Bomb at 40 Fury — what's the damage-per-Fury of each?)
- During burst windows (Fiery Demise, Meta), does the Fury economy shift? Does the APL adapt?

### Fragment Economy

Fragments are the more interesting resource because they have dual value: direct damage (Spirit Bomb/Soul Cleave consumption) and secondary effects (Frailty uptime, Untethered Rage procs). Model both.

Key questions:

- What is the steady-state fragment generation rate? How does it change with target count (Fallout quadratic scaling)?
- What is a fragment worth in damage terms? This depends on HOW it's consumed — 1 fragment in a 5-fragment Spirit Bomb is worth more than 1 fragment consumed by Soul Cleave.
- Where do fragments get wasted? (Cap overflow, suboptimal consumption, movement consumption)
- Does the APL's fragment consumption pattern maximize the value extracted per fragment?

### GCD Budget

Map the GCD allocation. With ~48 GCDs/minute at 20% haste, every ability competes for time. Some abilities are "mandatory" (high DPGCD, must use on CD), some are "discretionary" (fill remaining GCDs), and some might not be worth a GCD at all.

Key questions:

- After allocating GCDs to mandatory abilities, how many discretionary GCDs remain?
- Is every on-GCD ability in the APL actually worth its GCD cost? (Compare its effective DPGCD against the next-best alternative that would fill that GCD slot)
- Are there abilities the APL casts that have negative net value — their DPGCD is lower than the filler they displace?

## Phase 2: Identify Systemic Tensions

With the economic model built, look for structural conflicts — places where the rotation's design creates inherent tensions that no simple tweak can resolve.

### Resource Competition

Two consumers drawing from the same pool but serving different purposes. Example: Soul Cleave and Spirit Bomb both consume fragments, but Spirit Bomb applies Frailty (secondary value) while Soul Cleave is raw damage per Fury. The APL has to arbitrate between them, and the optimal choice depends on state (Frailty uptime, fragment count, burst window active, target count).

Is the APL's arbitration logic correct? Does it account for all the relevant state, or does it use a simplified heuristic that leaves value on the table?

### Cooldown Cycle Misalignment

Map the cooldown periods: Spirit Bomb 25s, Fel Devastation 40s, Fiery Brand 60s, Soul Carver 60s, Sigil of Spite 60s, Metamorphosis 120s. These are not harmonics of each other — they drift in and out of alignment.

Key questions:

- Which cooldown overlaps create multiplicative damage windows? (Fiery Demise + Meta is the big one)
- Does the APL try to align them, and if so, at what cost? (Holding a cooldown delays all future casts — model the holding cost per second using the analysis guide formula)
- Are there cooldown collisions where two abilities compete for the same resource window?
- What is the LCM of the major cooldowns, and does the APL's behavior over that supercycle look coherent?

### Burst Window Utilization

During damage amplification windows (Fiery Demise, Metamorphosis, Thrill of the Fight), the value of every GCD increases. The APL should front-load high-value abilities into these windows.

Key questions:

- How many GCDs fit inside each burst window?
- What is the damage profile of those GCDs? Is the APL filling windows with its highest-DPGCD abilities, or are low-value fillers leaking in?
- Does the APL pre-pool resources (Fury, fragments) before burst windows to ensure the window is fully utilized?
- What's the cost of pooling vs the gain from a fully-stocked burst window? (Use the opportunity cost framework)

### Second-Order Effect Chains

Trace the indirect value chains (analysis guide section 9). Some changes that look negative in isolation are positive when you follow the chain:

```
Example: Generating more fragments than needed for Spirit Bomb
  → More Untethered Rage procs (10% per fragment consumed)
    → More haste/damage buffs
      → More casts per minute → more Fury → more spending
```

Is the APL's fragment generation target accounting for these chains, or is it optimizing only for the direct Spirit Bomb value?

### State Machine Coherence (AR / Anni)

The hero tree state machines (Art of the Glaive cycle for AR, Voidfall cycle for Anni) impose their own rhythm on the rotation. Does the APL's priority structure respect these rhythms, or does it fight against them?

Key questions:

- During the AR empowered phase (Rending Strike + Glaive Flurry), should cooldown usage change?
- Does the AR cycle's ~4 GCD rhythm align with or conflict with Spirit Bomb's fragment accumulation pattern?
- Should the APL treat the AR cycle as a "mini burst window" and adjust resource usage accordingly?

## Phase 3: Generate Deep Hypotheses

For each systemic tension identified, formulate a multi-part hypothesis. Each hypothesis should:

1. **Name the systemic issue** — not "move X above Y" but "the fragment economy is suboptimal because the APL treats all fragments as equal when their value depends on consumption context"
2. **Describe the mechanism** — trace the causal chain with numbers from the spell data
3. **Propose a multi-part solution** — this might involve new variables, restructured conditions, and changed priorities working together
4. **Compute the expected impact** — use AP coefficients and cycle frequencies to estimate DPS delta
5. **Argue the counter-case** — what assumptions could be wrong? What second-order effects might negate the gain?
6. **Describe how to test it** — what specific APL changes, and what sim result would confirm or refute the theory?

Aim for 3-5 deep hypotheses, not 15 shallow ones.

## Phase 4: Validate with Tools

NOW run the automated analysis engines to cross-reference:

```bash
node src/sim/iterate.js strategic
node src/sim/iterate.js theorycraft
```

Compare their output against your hypotheses. Do the engines corroborate your reasoning? Did they find issues you missed? Did your deep analysis identify things the engines can't see (because they're structural, not pattern-matched)?

Also audit the APL for logic errors (stale hardcoded values, missing talent gates, dead lines) — these should be fixed before any optimization work.

## Phase 5: Test

Present the ranked hypothesis list and wait for user confirmation before iterating.

For each hypothesis, use the `/iterate-apl` methodology:

- Translate the multi-part hypothesis into a sequence of testable APL changes
- If the hypothesis is truly multi-part (components are interdependent), test them together — a single "iteration" can be a coherent set of changes that implement one conceptual idea
- Quick screen first, escalate if promising
- When a hypothesis is confirmed, document WHY it worked — the mechanism, not just the delta

## Phase 6: Synthesize

After testing, step back and look at what was learned:

- Did the economic model's predictions match reality?
- What does the rotation look like now — has the character of it changed, or just the edges?
- What systemic tensions remain? What would require a fundamentally different APL structure to address?
- What questions remain unanswered that future analysis should investigate?

Run `node src/sim/iterate.js summary` and commit final state.

## Anti-Patterns to Avoid

- **Threshold grinding** — testing `fury>=38` vs `fury>=40` vs `fury>=42` is not theorycraft. If you can't explain WHY a different threshold would matter mechanically, don't test it.
- **Blind reordering** — "move Fracture above Soul Cleave" without a theory of why the current order is wrong.
- **One-dimensional analysis** — evaluating an ability's value only by its direct damage, ignoring resource generation, buff application, and state machine progression.
- **Ignoring interaction effects** — proposing a change without tracing its impact on cooldown alignment, resource flow, and burst window utilization.
- **Over-trusting the engines** — the strategic and temporal hypothesis generators are pattern matchers. They find surface-level opportunities. The deep work is identifying systemic issues they can't see.
