In the future, cladue will be iteratively running simulationcraft and modifying the APL to try to find optimization opportunities for VDH damage. Because simulation runs are slow and expensive,
we want to have a good sense of the results we expect, or what we want to try to accomplish. Typically, we will have a theory, goal, or question we are investigating. In order to accomplish
this, we should have a good non-simulated idea of the impact of various abilities, talents, buffs, debuffs, and other mechanisms on our overall damage. We want to be able to deduce insights or
come up with ideas or theories about how to improve fairly quickly and easily based on the data we have.

We already have built some systems to collect data, connect abilities and talents, and try to describe in data how they interact and connect. The goal is that this data describes not just the
presence of the interaction, but also the type of interaction (damage amp, cooldown reduction, resource generation, stat gain, etc.), and the magnitude of the interaction. This should, in
theory, help us take a look at where we could find opportunities.

Our goal is to make sure the data is structured, described, labeled, captured, loaded, etc. in a way that allows claude to perform this analysis and theorycrafting task as easily, simply, and
quickly as possible. The result should be complex, sophisticated, insightful analysis performed quickly and simply.

Here's some examples of the types of questions I might ask myself when performing theorycrafting:

- Am I avoiding cooldown waste?
- Am I overcapping on resources?
- Is cooldown usage blocked by resources? Am I failing to generate resources in time?
- WOuld I benefit from a preparation-before-spending cycle, where I prepare resources before dumping them in a big burst window?
- Am I properly maintaining buffs and debuffs? Do I have unexpected downtime?
- Do any of my abilities have travel time, such that I need to use them sooner or later? For example, if a Sigil applies a debuff but has a 1.5s activation time, I want to start the sigil 1.5s
  earlier than the current debuff runs out.
- Am I refreshing buffs and debuffs properly?
- Am I doing things "just in time", taking maximum advantage of the various effects?
- Would I benefit from stacking abilities together, even if that means holding the cooldown for some amount of time?
- Do I need to do something differently for single target, small aoe, or big aoe?
- Am I utilizing my trinkets and external resources (like power infusion) properly?
- Would it be helpful to track additional information in a varible to help me make decisions?
- Are my current major sources of damage actually the best ones?
- Am I observing anything surprising or confusing to look into?

The theorycrafting should also challenge what seems to be working, to identify things that might work but not be obvious or intuitive:

- What if I DO allow overcapping resources?
- What if I drop spirit bomb entirely?
- What if I just send everything on cooldown?
- What if my abilities aren't synced up? Or conversely, what if they ARE?
- What might be interesting to explore?
- Are there connections I see that the humans are missing? (THIS ONE IS VERY IMPORTANT)
- Are there talent combinations my current APL doesn't optimize for? (these might be even better)

Please perform an extensive, thoughtful, and sophisticated review of the data we have. Think about the kinds of data you would need to ask and answer questions like we have above. Think about
how you would ideally want that data structured. Do not feel any limitations -- sky is the limit. We can be complex or simple, as is appropriate. Where data is missing, explore and see if
there's a source for that data that we could be ingesting. Where data is present, ensure it's available to you in a way that is most helpful.

Then, create a guide for APL analysis in a markdown file that describes the methodology in my examples above. They are JUST examples, and not a comprehensive list of things to do. You should be
ideating your own additional examples, and broadening to categories of things I couldn't possibly even think of yet because of my human limitation. This is a math problem, ultimately. There IS
a right answer. There IS a perfect solution.
