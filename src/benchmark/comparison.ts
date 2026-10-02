import {standardNormalQuantile} from "../experiment/statistics";
import {type Reward} from "./reward";

export const STRATEGIES = ["agent", "random"] as const;
export type Strategy = (typeof STRATEGIES)[number];

export type TrialReward = Readonly<{
  starting_pair: string;
  seed: number;
  strategy: Strategy;
  reward: Reward;
}>;

export type ComparisonSummary = {
  comparisons: number;
  invalid_trials: string[];
  advantage: {
    mean: number;
    confidence_interval: {lower: number; upper: number; level: number};
    agent_wins: number;
    ties: number;
    by_starting_pair: Record<string, {comparisons: number; mean: number}>;
  };
  strategies: Record<Strategy, {
    mean_final_rate: number;
    mean_normalized_gain: number;
    mean_exposures: number;
    mean_regret_by_proposal: number[];
  }>;
  optimum_rate: number;
};

/**
 * Pairs agent and random trials by starting pair and seed. Advantage is the
 * agent's final champion expected rate minus random's. Starting pairs are
 * fixed strata: the estimate averages per-pair means with equal weight.
 */
export function summarizeComparison(
  trials: readonly TrialReward[],
  level = 0.95,
): ComparisonSummary {
  const invalidTrials = trials
    .filter(({reward}) => !reward.valid)
    .map(({starting_pair, seed, strategy}) => `${strategy}/${starting_pair}/s${seed}`);
  const byKey = new Map<string, Partial<Record<Strategy, Reward>>>();
  for (const trial of trials.filter(({reward}) => reward.valid)) {
    const key = `${trial.starting_pair}|${trial.seed}`;
    byKey.set(key, {...byKey.get(key), [trial.strategy]: trial.reward});
  }
  const pairs = [...byKey.entries()].flatMap(([key, rewards]) =>
    rewards.agent === undefined || rewards.random === undefined
      ? []
      : [{starting_pair: key.split("|")[0]!, agent: rewards.agent, random: rewards.random}]
  );
  if (pairs.length === 0) throw new Error("No complete agent/random comparisons.");

  const finalRate = (reward: Reward) =>
    reward.optimum.expected_install_rate - reward.final_regret;
  const differences = new Map<string, number[]>();
  for (const pair of pairs) {
    const values = differences.get(pair.starting_pair) ?? [];
    values.push(finalRate(pair.agent) - finalRate(pair.random));
    differences.set(pair.starting_pair, values);
  }
  const strata = [...differences.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  );
  const mean = (values: readonly number[]) =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const sampleVariance = (values: readonly number[]) => {
    const center = mean(values);
    return values.reduce((sum, value) => sum + (value - center) ** 2, 0) /
      (values.length - 1);
  };
  const estimate = mean(strata.map(([, values]) => mean(values)));
  const standardError = Math.sqrt(
    strata.reduce(
      (sum, [, values]) =>
        sum + (values.length > 1 ? sampleVariance(values) / values.length : 0),
      0,
    ) / strata.length ** 2,
  );
  const margin = standardNormalQuantile(1 - (1 - level) / 2) * standardError;
  const allDifferences = strata.flatMap(([, values]) => values);

  const strategySummary = (strategy: Strategy) => {
    const rewards = pairs.map((pair) => pair[strategy]);
    const curves = rewards.map((reward) => [
      reward.optimum.expected_install_rate - reward.start.expected_install_rate,
      ...reward.steps.map(({regret}) => regret),
    ]);
    return {
      mean_final_rate: mean(rewards.map(finalRate)),
      mean_normalized_gain: mean(rewards.map(({normalized_gain}) => normalized_gain)),
      mean_exposures: mean(rewards.map(({exposures}) => exposures)),
      mean_regret_by_proposal: curves[0]!.map((_, step) =>
        mean(curves.map((curve) => curve[step]!))
      ),
    };
  };

  return {
    comparisons: pairs.length,
    invalid_trials: invalidTrials,
    advantage: {
      mean: estimate,
      confidence_interval: {lower: estimate - margin, upper: estimate + margin, level},
      agent_wins: allDifferences.filter((value) => value > 0).length,
      ties: allDifferences.filter((value) => value === 0).length,
      by_starting_pair: Object.fromEntries(
        strata.map(([pair, values]) => [pair, {comparisons: values.length, mean: mean(values)}]),
      ),
    },
    strategies: {agent: strategySummary("agent"), random: strategySummary("random")},
    optimum_rate: pairs[0]!.agent.optimum.expected_install_rate,
  };
}
