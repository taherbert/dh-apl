# Deep Analysis Methodology

Internal reference for the deep theorycraft analysis phase within `/optimize`. Not a user-facing command.

The goal is systemic insight: understanding the resource economy, identifying conceptual tensions in the rotation, and proposing multi-part changes that address root causes rather than symptoms. Simple threshold tweaks and line reorderings are not the point — those fall out naturally once the underlying model is right.

## Phase 0: Study Reference APL Technique

Before modeling the economy, study the SimC default APL for **technique** — not priorities.

Read `reference/{spec}-apl.simc` (the extracted SimC default APL). You are NOT copying this APL or adopting its priority ordering. You are studying it for SimC syntax patterns and structural techniques that inform how to EXPRESS your own ideas.

Look for:

- **Variable patterns** — how are complex conditions factored into reusable variables? What state do the variables track (resource thresholds, burst window detection, target count breakpoints)?
- **Trinket handling** — how are trinkets pooled, condition-gated, or sync'd with burst windows? Trinket logic is notoriously complex in SimC; learn from existing implementations.
- **Accumulator / state machine encoding** — how do the APL authors express multi-step cycles (e.g., "cast A, then B, then C in sequence")?
- **Action list delegation** — how is `run_action_list` vs `call_action_list` used to structure the rotation? What sub-lists exist and why?
- **AoE breakpoint logic** — how are `spell_targets` conditions structured for scaling?
- **Cooldown sync patterns** — how are burst windows and cooldown alignment expressed?
- **Off-GCD interleaving** — how are `use_off_gcd=true` and `use_while_casting=true` used?

**Important constraints:**

- The reference APL's priority ordering may be wrong, incomplete, or based on different assumptions. Do not trust its priorities — derive yours from math.
- The reference APL's threshold values are likely tuned to one specific build. Your thresholds should come from your economic model.
- Community wisdom embedded in the reference APL is at best incomplete and at worst wrong. Treat it as background research, not ground truth.

Document any interesting techniques found for use in later phases.

## Phase 1: Model the Economy

Before looking at any individual APL line, build a mental model of the rotation as an economic system. Use the frameworks from the analysis guide (sections 1, 2, 10).

### Primary Resource Economy

Compute the equilibrium. How much primary resource enters the system per minute? How much leaves? Where is the surplus or deficit? What is the marginal damage value of 1 unit of primary resource spent on each available spender? Does the APL's spending pattern match the mathematically optimal allocation?

Key questions:

- Is the generation rate matched to the spending rate, or is one side bottlenecked?
- What is the opportunity cost of each unit spent? Compare the damage-per-resource of each spender — which is most efficient per unit, and does the APL reflect that ordering?
- During burst windows (from `SPEC_CONFIG.buffWindows`), does the resource economy shift? Does the APL adapt its spending to the amplified context?

### Secondary Resource Economy (if applicable)

If the spec has a secondary resource (check `SPEC_CONFIG.resources.secondary`), it is often the more interesting one because secondary resources tend to have dual value: direct damage via consumption and indirect effects (buff application, proc triggers). Model both.

Key questions:

- What is the steady-state generation rate? How does it change with target count?
- What is a unit of this resource worth in damage terms? This depends on HOW it's consumed — the same resource may be worth more when consumed by a high-value spender than a low-value one.
- Where does the resource get wasted? (Cap overflow, suboptimal consumption, movement waste)
- Does the APL's consumption pattern maximize the value extracted per unit?

### GCD Budget

Map the GCD allocation. With ~48 GCDs/minute at 20% haste, every ability competes for time. Some abilities are "mandatory" (high DPGCD, must use on CD), some are "discretionary" (fill remaining GCDs), and some might not be worth a GCD at all.

Key questions:

- After allocating GCDs to mandatory abilities, how many discretionary GCDs remain?
- Is every on-GCD ability in the APL actually worth its GCD cost? (Compare its effective DPGCD against the next-best alternative that would fill that GCD slot)
- Are there abilities the APL casts that have negative net value — their DPGCD is lower than the filler they displace?

## Phase 2: Identify Systemic Tensions

With the economic model built, look for structural conflicts — places where the rotation's design creates inherent tensions that no simple tweak can resolve.

### Resource Competition

Two consumers drawing from the same pool but serving different purposes. One may provide raw damage while another applies a debuff, buff, or triggers a secondary mechanic. The APL has to arbitrate between them, and the optimal choice depends on state (buff uptime, resource count, burst window active, target count).

Is the APL's arbitration logic correct? Does it account for all the relevant state, or does it use a simplified heuristic that leaves value on the table?

### Cooldown Cycle Misalignment

Map the cooldown periods of every major ability (from `SPEC_CONFIG.cooldownBuffs` and spell data). These are rarely harmonics of each other — they drift in and out of alignment.

Key questions:

- Which cooldown overlaps create multiplicative damage windows?
- Does the APL try to align them, and if so, at what cost? (Holding a cooldown delays all future casts — model the holding cost per second using the analysis guide formula)
- Are there cooldown collisions where two abilities compete for the same resource window?
- What is the LCM of the major cooldowns, and does the APL's behavior over that supercycle look coherent?

### Burst Window Utilization

During damage amplification windows (from `SPEC_CONFIG.buffWindows`), the value of every GCD increases. The APL should front-load high-value abilities into these windows.

Key questions:

- How many GCDs fit inside each burst window?
- What is the damage profile of those GCDs? Is the APL filling windows with its highest-DPGCD abilities, or are low-value fillers leaking in?
- Does the APL pre-pool resources before burst windows to ensure the window is fully utilized?
- What's the cost of pooling vs the gain from a fully-stocked burst window? (Use the opportunity cost framework)

### Second-Order Effect Chains

Trace the indirect value chains (analysis guide section 9). Some changes that look negative in isolation are positive when you follow the chain. For example, generating more of a resource than a spender immediately needs may trigger procs, buffs, or secondary effects that produce more value than the direct consumption.

Map these chains from `SPEC_CONFIG.resourceFlow` and `interactions-summary.json`. Is the APL's resource generation target accounting for these chains, or is it optimizing only for direct consumption value?

### State Machine Coherence

The hero trees (from `SPEC_CONFIG.heroTrees`) often impose their own rhythm on the rotation through state machines — cycles of ability empowerment, alternating phases, or proc chains. Does the APL's priority structure respect these rhythms, or does it fight against them?

Key questions:

- During empowered phases of a hero tree cycle, should cooldown usage or resource spending change?
- Does the hero tree's GCD rhythm align with or conflict with the spec's core resource accumulation pattern?
- Should the APL treat the hero tree cycle as a "mini burst window" and adjust resource usage accordingly?
- If the spec supports multiple hero trees, does each branch handle its state machine correctly?

## Phase 3: Generate Deep Hypotheses

For each systemic tension identified, formulate a multi-part hypothesis. Each hypothesis should:

1. **Name the systemic issue** — not "move X above Y" but "the resource economy is suboptimal because the APL treats all units of resource R as equal when their value depends on consumption context"
2. **Describe the mechanism** — trace the causal chain with numbers from the spell data
3. **Propose a multi-part solution** — this might involve new variables, restructured conditions, and changed priorities working together
4. **Compute the expected impact** — use AP coefficients and cycle frequencies to estimate DPS delta
5. **Argue the counter-case** — what assumptions could be wrong? What second-order effects might negate the gain?
6. **Describe how to test it** — what specific APL changes, and what sim result would confirm or refute the theory?

Aim for 3-5 deep hypotheses, not 15 shallow ones.

## Phase 4: Validate with Tools

Run the automated analysis engines to cross-reference your hypotheses:

```bash
node src/sim/iterate.js strategic
node src/sim/iterate.js theorycraft
```

These two commands are independent — launch them as parallel subagents to save time. Compare their output against your hypotheses. Do the engines corroborate your reasoning? Did they find issues you missed? Did your deep analysis identify things the engines can't see (because they're structural, not pattern-matched)?

Also audit the APL for logic errors (stale hardcoded values, missing talent gates, dead lines) — these should be fixed before any optimization work.

## Anti-Patterns

- **Threshold grinding** — testing small numeric variations without a theory of why a different value would matter mechanically.
- **Blind reordering** — moving one ability above another without a theory of why the current order is wrong.
- **One-dimensional analysis** — evaluating an ability's value only by its direct damage, ignoring resource generation, buff application, and state machine progression.
- **Ignoring interaction effects** — proposing a change without tracing its impact on cooldown alignment, resource flow, and burst window utilization.
- **Over-trusting the engines** — the strategic and temporal hypothesis generators are pattern matchers. They find surface-level opportunities. The deep work is identifying systemic issues they can't see.
- **Hardcoding spec knowledge** — ability names, resource names, thresholds, and cooldown values belong in the spec adapter. Reference `SPEC_CONFIG` fields, not literals.
