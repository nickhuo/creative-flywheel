import {expect, test} from "bun:test";

import {assessEligibility} from "../src/experiment/evaluation";
import {prepareExperimentRun, type ExperimentRun} from "../src/experiment/run";
import {StatsigConsoleClient, type StatsigExperimentObservation} from "../src/experiment/statsig";
import {normalizeStatsigObservation} from "../src/experiment/statsig-results";
import {renderableCreativeManifestSchema} from "../src/manifest";

const observedAt = "2026-09-21T12:00:00.000Z";
const controlManifest = renderableCreativeManifestSchema.parse(
  await Bun.file(new URL("../manifests/g0_v00.json", import.meta.url)).json(),
);
const treatmentManifest = renderableCreativeManifestSchema.parse(
  await Bun.file(new URL("../manifests/g0_v01.json", import.meta.url)).json(),
);
const prepared = prepareExperimentRun({
  run_id: "statsig_results_test",
  prepared_at: observedAt,
  seed: 42,
  batch_size: 2,
  baseline_rate: 0.01,
  minimum_detectable_effect: 0.5,
  alpha: 0.1,
  power: 0.8,
  hypothesis: "Test result retrieval.",
  environment: "development",
  audience_model_path: "artifacts/audience/model.json",
  control_manifest_path: "manifests/g0_v00.json",
  control_manifest: controlManifest,
  treatment_manifest_path: "manifests/g0_v01.json",
  treatment_manifest: treatmentManifest,
});
const run: ExperimentRun = {
  ...prepared,
  status: "awaiting_results",
  statsig_experiment: {
    experiment_id: prepared.experiment.name,
    permalink: "https://example.com/experiment",
    control_group_id: "control-group",
    treatment_group_id: "treatment-group",
    recorded_at: observedAt,
    active_observed_at: observedAt,
  },
};
const pendingObservation: StatsigExperimentObservation = {
  experiment: {data: {sequentialTesting: false}},
  cumulative_exposures: null,
  diagnostics_checks: null,
  metric_results: [
    {role: "primary", name: run.experiment.primary_metric.name, response: null},
    {role: "secondary", name: run.experiment.secondary_metrics[0].name, response: null},
  ],
};

test("reports HTTP failures before parsing JSON and redacts credentials", async () => {
  for (const status of [401, 403, 429, 500]) {
    const client = new StatsigConsoleClient("test-console-key", {
      fetch: async () => new Response("Unauthorized test-console-key", {status}),
    });
    await expect(client.observeExperiment(run)).rejects.toThrow(
      `failed (${status}): Unauthorized [REDACTED]`,
    );
  }
  const client = new StatsigConsoleClient("test-console-key", {
    fetch: async () => new Response("not JSON", {status: 200}),
  });
  await expect(client.observeExperiment(run)).rejects.toThrow("invalid JSON (200)");
});

test("unpublished results remain waiting, including plain-text 404 responses", async () => {
  const client = new StatsigConsoleClient("test-console-key", {
    fetch: async (input) => new URL(String(input)).pathname.endsWith(run.experiment.name)
      ? Response.json(pendingObservation.experiment)
      : new Response("Not Found", {status: 404}),
  });
  const observation = await client.observeExperiment(run);
  expect(observation).toEqual(pendingObservation);
  for (const cumulativeExposures of [null, {data: []}]) {
    const snapshot = normalizeStatsigObservation(
      run, {...observation, cumulative_exposures: cumulativeExposures}, observedAt,
    );
    expect(snapshot.health_issues.some(({level}) => level === "error")).toBe(false);
    expect(assessEligibility(run, snapshot, {
      previousSnapshotId: null,
      hasPendingProposal: false,
      cooldownUntil: null,
      now: observedAt,
    })).toMatchObject({status: "waiting"});
  }
});

test("missing experiments and unauthorized result endpoints are not pending data", async () => {
  const missing = new StatsigConsoleClient("test-console-key", {
    fetch: async () => new Response("Not Found", {status: 404}),
  });
  await expect(missing.observeExperiment(run)).rejects.toThrow("failed (404)");
  const unauthorized = new StatsigConsoleClient("test-console-key", {
    fetch: async (input) => new URL(String(input)).pathname.endsWith(run.experiment.name)
      ? Response.json(pendingObservation.experiment)
      : new Response("Unauthorized", {status: 401}),
  });
  await expect(unauthorized.observeExperiment(run)).rejects.toThrow("failed (401)");
});

test("retrieves metrics using group IDs and the configured confidence level", async () => {
  const requestedMetrics: string[] = [];
  const client = new StatsigConsoleClient("test-console-key", {
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("pulse_metric_result")) {
        expect(url.searchParams.get("control")).toBe("control-group");
        expect(url.searchParams.get("test")).toBe("treatment-group");
        expect(url.searchParams.get("confidence")).toBe("90");
        const metricId = url.searchParams.get("metricID")!;
        requestedMetrics.push(metricId);
        return Response.json({data: {
          ds: "2026-09-20",
          dimensionResults: [{
            dimension: "!statsig_topline",
            dimension_value: "!statsig_topline",
            metric: {
              metricName: metricId.split("::")[0],
              controlMean: 0.01,
              testMean: 0.02,
              controlUnits: 100,
              testUnits: 100,
              confidenceInterval: {lower: 0.001, upper: 0.019},
              pValue: 0.04,
            },
          }],
        }});
      }
      if (url.pathname.endsWith("cumulative_exposures")) {
        return Response.json({data: ["control-group", "treatment-group"].map((groupID) => ({
          groupID,
          groupName: groupID,
          results: [
            {date: "2026-09-20", exposures: 100},
            {date: "2026-09-19", exposures: 50},
          ],
        }))});
      }
      if (url.pathname.endsWith("diagnostics_checks")) {
        return Response.json({data: {is_realtime: false}});
      }
      return Response.json(pendingObservation.experiment);
    },
  });
  const snapshot = normalizeStatsigObservation(run, await client.observeExperiment(run), observedAt);
  expect(requestedMetrics.sort()).toEqual(["ctr_user::event_user", "install_rate_user::event_user"]);
  expect(snapshot.health_issues).toEqual([]);
  expect(snapshot.exposure_groups.map(({exposures}) => exposures)).toEqual([100, 100]);
  expect(snapshot.primary_metric).toMatchObject({
    status: "ready",
    confidence_interval: {level: 0.9},
    absolute_effect: 0.01,
  });
  expect(snapshot.data_through).toBe("2026-09-20");
});

test("malformed exposures and partially missing groups remain errors", () => {
  for (const cumulativeExposures of [
    {data: "invalid"},
    {data: [{groupID: "control-group", groupName: "Control", results: []}]},
  ]) {
    const snapshot = normalizeStatsigObservation(run, {
      ...pendingObservation,
      cumulative_exposures: cumulativeExposures,
    }, observedAt);
    expect(snapshot.health_issues.some(({level}) => level === "error")).toBe(true);
  }
});

test("metric processing delays stay pending while provider setup errors block", () => {
  for (const error of ["no_data", "echidna_unripe", "setup_incomplete"]) {
    const snapshot = normalizeStatsigObservation(run, {
      ...pendingObservation,
      metric_results: [{
        role: "primary",
        name: run.experiment.primary_metric.name,
        response: {data: {
          ds: "2026-09-20",
          dimensionResults: [{
            dimension: "!statsig_topline",
            dimension_value: "!statsig_topline",
            metric: {metricName: run.experiment.primary_metric.name, error},
          }],
        }},
      }],
    }, observedAt);
    expect(snapshot.primary_metric).toMatchObject({status: "pending"});
    expect(snapshot.health_issues.some(({level}) => level === "error"))
      .toBe(error === "setup_incomplete");
  }
});
