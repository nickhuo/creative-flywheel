import {expect, test} from "bun:test";
import {readdir} from "node:fs/promises";
import {resolve} from "node:path";

import {defaultHistorySource} from "../src/agent/history-store";
import {projectRoot, runsDirectory} from "../src/artifacts";
import {audienceModelSchema} from "../src/audience/model";
import {
  expectedInstallRate,
  findSimulatorOptimum,
  loadSearchRounds,
  scoreSearch,
  type SearchRound,
} from "../src/benchmark/reward";
import {
  CREATIVE_LAYER_FIELDS,
  CREATIVE_LAYER_VALUES,
  renderableCreativeManifestSchema,
} from "../src/manifest";

const model = audienceModelSchema.parse(
  await Bun.file(resolve(projectRoot, "artifacts/audience/model.json")).json(),
);
const optimum = findSimulatorOptimum(model);
const runIds = (await readdir(runsDirectory, {withFileTypes: true}))
  .filter((entry) => entry.isDirectory())
  .map(({name}) => name);
const tamperedRunId = runIds[0]!;
const baseRounds = await loadSearchRounds(tamperedRunId, defaultHistorySource);

function score(rounds: readonly SearchRound[], budget = 9) {
  return scoreSearch({optimization_run_id: tamperedRunId, rounds, model, budget});
}

test("simulator optimum beats every seed and every one-layer neighbor", async () => {
  for (const variant of ["g0_v00", "g0_v01", "g0_v02", "g0_v03", "g0_v04", "g0_v05", "g0_v06", "g0_v07"]) {
    const manifest = renderableCreativeManifestSchema.parse(
      await Bun.file(resolve(projectRoot, "manifests", `${variant}.json`)).json(),
    );
    expect(expectedInstallRate(model, manifest.layers)).toBeLessThanOrEqual(
      optimum.expected_install_rate,
    );
  }
  for (const field of CREATIVE_LAYER_FIELDS) {
    for (const value of CREATIVE_LAYER_VALUES[field]) {
      const neighbor = {...optimum.layers, [field]: value};
      expect(expectedInstallRate(model, neighbor)).toBeLessThanOrEqual(
        optimum.expected_install_rate,
      );
    }
  }
});

test("checked-in runs follow the search rules and score against the optimum", async () => {
  expect(runIds).toHaveLength(4);
  for (const runId of runIds) {
    const rounds = await loadSearchRounds(runId, defaultHistorySource);
    const reward = scoreSearch({optimization_run_id: runId, rounds, model, budget: 9});
    const finalAction = rounds.at(-1)!.action;

    expect(reward.violations).toEqual([]);
    expect(reward.valid).toBe(true);
    expect(reward.steps).toHaveLength(9);
    expect(reward.start.variant_id).toBe(rounds[0]!.control.variant_id);
    expect(finalAction.action === "terminate" && finalAction.champion_variant_id)
      .toBe(reward.steps.at(-1)!.champion.variant_id);
    expect(reward.final_regret).toBe(reward.steps.at(-1)!.regret);
    expect(reward.normalized_gain).toBeLessThanOrEqual(1);
  }
});

test("a run with the wrong number of proposals is invalid", () => {
  expect(score(baseRounds, 10).violations).toEqual([
    "Expected 10 proposals; found 9.",
  ]);
});

test("a recorded decision that contradicts the promotion rule is invalid", () => {
  const index = baseRounds.findIndex(({action}) => action.action === "stop");
  const rounds = baseRounds.map((round, roundIndex) =>
    roundIndex === index
      ? {...round, action: {...round.action, action: "promote"} as SearchRound["action"]}
      : round
  );

  expect(score(rounds).violations).toContain(
    `Round ${index + 1} recorded promote; the promotion rule gives stop.`,
  );
});

test("a challenger that repeats a tested creative is invalid", () => {
  const rounds = baseRounds.map((round, index) =>
    index === 3
      ? {
          ...round,
          treatment: {...round.treatment, layers: baseRounds[1]!.treatment.layers},
        }
      : round
  );

  expect(score(rounds).violations).toContain(
    "Round 4 challenger repeats a tested creative.",
  );
});

test("an unterminated run cannot be scored", () => {
  expect(() => score(baseRounds.slice(0, -1))).toThrow("has not terminated");
});
