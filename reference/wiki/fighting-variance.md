# Fighting Variance

Source: https://github.com/simulationcraft/simc/wiki/FightingVariance

SimulationCraft works according to the Law of large numbers, which states that the average of the results obtained from a large number of trials should be close to the expected value, and will tend to become closer as more trials are performed.

So if we set iterations=infinity, SimulationCraft will yield a precise result that will be perfect in comparison with theorycraft -- no assumptions, pure modelling, but definitive output.

However, this is impossible and full raid sims take quite a significant amount of time even with few iterations. Thus we have to deal with variance in our results, that's especially noticeable when we calculate scaling, i.e. small differences between two dps.

To know how close the sample mean is to the expected value, we can use the Central Limit Theorem, which states that for a sequence of n independent and identically distributed random variables with finite expectation and variance, the distribution of the sample average approaches a normal distribution with mean mu and variance sigma^2 / n.

Using this information and combining it with a Confidence Interval, we can make the following statements about the variation of the mean dps:

- 95% of the time the same simulation is run, the true (population) mean dps will be within the confidence interval, which is +-1.96 \* sigma / sqrt(n) of the mean dps.

- The same can be said about the DPS difference lying 95% of the time within 1.96 _ sqrt(1.96) _ sigma / sqrt(n) neighbourhood of difference between two average DPS values, given the same mean variation (useful for scaling simulations and spec comparisons).

To make practical use of this, we replace the population standard deviation by the standard deviation of the sample.

SimulationCraft also reports a series of statistical metrics, e.g. stddev, min and max, range, 10th and 90th percentile and #iterations needed for specific error thresholds.

It is possible to specify a custom confidence level, whereas the default remains 95%.
