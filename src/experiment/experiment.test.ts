import {describe, expect, test} from "bun:test";

import {audienceModelSchema} from "../audience/model";
import {creativeManifestSchema} from "../manifest";
import {
  buildExposureContexts,
  experimentEventRecordSchema,
  experimentRunSchema,
  prepareExperimentRun,
  summarizeExperimentEvents,
  verifyRunInputs,
  type ExperimentEventRecord,
} from "./run";
import {StatsigConsoleClient} from "./statsig";

const model = audienceModelSchema.parse(
  await Bun.file(
    new URL("../../artifacts/audience/model.json", import.meta.url),
  ).json(),
);
const control = creativeManifestSchema.parse(
  await Bun.file(
    new URL("../../manifests/g0_v00.json", import.meta.url),
  ).json(),
);
const treatment = creativeManifestSchema.parse(
  await Bun.file(
    new URL("../../manifests/g0_v01.json", import.meta.url),
  ).json(),
);
const run = prepareExperimentRun({
  run_id: "smoke_001",
  prepared_at: "2026-09-18T12:00:00.000Z",
  seed: 42,
  users: 4,
  environment: "development",
  audience_model_path: "artifacts/audience/model.json",
  audience_model: model,
  control_manifest_path: "manifests/g0_v00.json",
  control_manifest: control,
  treatment_manifest_path: "manifests/g0_v01.json",
  treatment_manifest: treatment,
});
const statsigExperimentData = {
  id: "creative_flywheel_smoke_001",
  name: "creative_flywheel_smoke_001",
  idType: "userID",
  description: "Auditable creative smoke run smoke_001.",
  hypothesis:
    "Changing the opening hook changes install rate for otherwise matched creative.",
  permalink:
    "https://console.statsig.com/experiment/creative_flywheel_smoke_001",
  status: "setup",
  controlGroupID: "control_group",
  allocation: 100,
  primaryMetrics: [
    {name: "install_rate", type: "ratio", direction: "increase"},
  ],
  secondaryMetrics: [
    {name: "ctr", type: "ratio", direction: "increase"},
  ],
  targetExposures: 4,
  targetingGateID: null,
  sequentialTesting: false,
  bonferroniCorrection: false,
  enabledNonProdEnvironments: ["development"],
  groups: [
    {
      id: "control_group",
      name: "Control",
      isControl: true,
      size: 50,
      parameterValues: {variant_id: "g0_v00"},
    },
    {
      id: "treatment_group",
      name: "Treatment",
      isControl: false,
      size: 50,
      parameterValues: {variant_id: "g0_v01"},
    },
  ],
};

describe("experiment run", () => {
  test("freezes the inputs and deterministic cohort", () => {
    const exposureTime = "2026-09-18T13:00:00.000Z";
    const first = buildExposureContexts(run, model, exposureTime);
    const second = buildExposureContexts(run, model, exposureTime);
    const nextRun = experimentRunSchema.parse({
      ...run,
      run_id: "smoke_002",
      prepared_at: "2026-09-19T12:00:00.000Z",
      experiment: {...run.experiment, name: "creative_flywheel_smoke_002"},
    });
    const nextRound = buildExposureContexts(
      nextRun,
      model,
      "2026-09-19T13:00:00.000Z",
    );

    expect(first).toEqual(second);
    expect(first).toHaveLength(4);
    expect(new Set(first.map(({user_id}) => user_id)).size).toBe(4);
    expect(first.every(({exposure_n}) => exposure_n === 1)).toBe(true);
    expect(first.every(({ts_utc}) => ts_utc === exposureTime)).toBe(true);
    expect(first.map(({segment, os}) => ({segment, os}))).toEqual(
      nextRound.map(({segment, os}) => ({segment, os})),
    );
    expect(first.map(({user_id}) => user_id)).not.toEqual(
      nextRound.map(({user_id}) => user_id),
    );
    expect(first[0]!.impression_id).not.toBe(nextRound[0]!.impression_id);
    expect(run.experiment.arms.map(({variant_id}) => variant_id)).toEqual([
      "g0_v00",
      "g0_v01",
    ]);
    expect(experimentRunSchema.parse(run)).toEqual(run);
  });

  test("rejects changed inputs before a remote action", () => {
    const changedTreatment = {
      ...treatment,
      layers: {...treatment.layers, hook_text: "A changed hook"},
    };

    expect(() => verifyRunInputs(run, model, control, treatment)).not.toThrow();
    expect(() =>
      verifyRunInputs(run, model, control, changedTreatment),
    ).toThrow("Treatment manifest no longer matches run.json.");
  });

  test("reconciles only complete, known, unique events", () => {
    const contexts = buildExposureContexts(
      run,
      model,
      "2026-09-18T13:00:00.000Z",
    );
    const records = contexts.map((context, index) =>
      experimentEventRecordSchema.parse({
        ...context,
        run_id: run.run_id,
        variant_id: index % 2 === 0 ? "g0_v00" : "g0_v01",
        click: index < 2 ? 1 : 0,
        install: index === 0 ? 1 : 0,
        statsig_group_name: index % 2 === 0 ? "Control" : "Treatment",
        statsig_rule_id: index % 2 === 0 ? "control_id" : "treatment_id",
      }),
    );

    expect(summarizeExperimentEvents(run, records)).toMatchObject({
      users: 4,
      impressions: 4,
      clicks: 2,
      installs: 1,
      arms: [
        {variant_id: "g0_v00", impressions: 2, clicks: 1, installs: 1},
        {variant_id: "g0_v01", impressions: 2, clicks: 1, installs: 0},
      ],
    });

    const duplicate = records.map((record) => ({...record}));
    duplicate[1]!.user_id = duplicate[0]!.user_id;
    expect(() => summarizeExperimentEvents(run, duplicate)).toThrow(
      "Experiment event users must be unique.",
    );

    const unknown: ExperimentEventRecord[] = records.map((record) => ({
      ...record,
    }));
    unknown[0]!.variant_id = "unknown";
    expect(() => summarizeExperimentEvents(run, unknown)).toThrow(
      "Experiment events contain an unknown variant.",
    );
  });

  test("requires a Statsig receipt after preparation", () => {
    const receipt = {
      experiment_id: "exp",
      permalink: "https://console.statsig.com/exp",
      control_group_id: "control",
      treatment_group_id: "treatment",
      recorded_at: "2026-09-18T12:00:00.000Z",
      active_observed_at: null,
    };
    expect(
      experimentRunSchema.safeParse({...run, status: "created"}).success,
    ).toBe(false);
    expect(
      experimentRunSchema.safeParse({
        ...run,
        statsig_experiment: receipt,
      }).success,
    ).toBe(false);
    expect(
      experimentRunSchema.safeParse({
        ...run,
        status: "created",
        statsig_experiment: receipt,
      }).success,
    ).toBe(true);
    expect(
      experimentRunSchema.safeParse({
        ...run,
        status: "serving",
        statsig_experiment: receipt,
      }).success,
    ).toBe(false);
  });
});

describe("Statsig Console boundary", () => {
  test("creates the two ratio metrics when they are absent", async () => {
    const calls: Array<{url: string; init?: RequestInit}> = [];
    const client = new StatsigConsoleClient("console-test", {
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({url, init});
        if (init?.method === "GET") {
          return Response.json({message: "not found"}, {status: 404});
        }
        const body: unknown = JSON.parse(String(init?.body));
        return Response.json({data: body}, {status: 201});
      },
    });

    await client.ensureSmokeMetrics();

    expect(calls).toHaveLength(4);
    const creates = calls.filter(({init}) => init?.method === "POST");
    expect(creates.map(({init}) => JSON.parse(String(init?.body)))).toEqual([
      expect.objectContaining({
        name: "install_rate",
        type: "ratio",
        metricEvents: [
          {name: "ad_install", type: "count", criteria: []},
          {name: "ad_impression", type: "count", criteria: []},
        ],
      }),
      expect.objectContaining({
        name: "ctr",
        type: "ratio",
        metricEvents: [
          {name: "ad_click", type: "count", criteria: []},
          {name: "ad_impression", type: "count", criteria: []},
        ],
      }),
    ]);
    expect(
      new Headers(creates[0]!.init?.headers).get("STATSIG-API-VERSION"),
    ).toBe("20240601");
  });

  test("creates a setup 50/50 experiment and extracts its receipt", async () => {
    let requestBody: unknown;
    const client = new StatsigConsoleClient("console-test", {
      fetch: async (_input, init) => {
        if (init?.method === "GET") {
          return Response.json({message: "not found"}, {status: 404});
        }
        requestBody = JSON.parse(String(init?.body));
        return Response.json(
          {data: statsigExperimentData},
          {status: 201},
        );
      },
    });

    const created = await client.ensureExperiment(run);

    expect(requestBody).toMatchObject({
      name: "creative_flywheel_smoke_001",
      id: "creative_flywheel_smoke_001",
      idType: "userID",
      allocation: 100,
      targetExposures: 4,
      enabledNonProdEnvironments: ["development"],
      groups: [
        {size: 50, parameterValues: {variant_id: "g0_v00"}},
        {size: 50, parameterValues: {variant_id: "g0_v01"}},
      ],
    });
    expect(requestBody).not.toHaveProperty("targetApps");
    expect(requestBody).not.toHaveProperty("duration");
    expect(created.receipt).toMatchObject({
      experiment_id: "creative_flywheel_smoke_001",
      control_group_id: "control_group",
      treatment_group_id: "treatment_group",
      active_observed_at: null,
    });
    expect(created.reused).toBe(false);
  });

  test("reuses a matching stable experiment ID after a local crash", async () => {
    const methods: string[] = [];
    const client = new StatsigConsoleClient("console-test", {
      fetch: async (_input, init) => {
        methods.push(init?.method ?? "GET");
        return Response.json({data: statsigExperimentData});
      },
    });

    const created = await client.ensureExperiment(run);

    expect(methods).toEqual(["GET"]);
    expect(created.reused).toBe(true);
  });

  test("treats an empty targeting gate ID as no targeting gate", async () => {
    const client = new StatsigConsoleClient("console-test", {
      fetch: async () =>
        Response.json({
          data: {...statsigExperimentData, targetingGateID: ""},
        }),
    });

    const created = await client.ensureExperiment(run);

    expect(created.reused).toBe(true);
  });

  test("rejects a stable experiment ID with a different configuration", async () => {
    const client = new StatsigConsoleClient("console-test", {
      fetch: async () =>
        Response.json({
          data: {
            ...statsigExperimentData,
            groups: statsigExperimentData.groups.map((group, index) => ({
              ...group,
              size: index === 0 ? 90 : 10,
            })),
          },
        }),
    });

    await expect(client.ensureExperiment(run)).rejects.toThrow(
      "Existing Statsig experiment does not match run.json.",
    );
  });

  test("rejects a stable experiment ID with different analysis settings", async () => {
    const client = new StatsigConsoleClient("console-test", {
      fetch: async () =>
        Response.json({
          data: {...statsigExperimentData, sequentialTesting: true},
        }),
    });

    await expect(client.ensureExperiment(run)).rejects.toThrow(
      "Existing Statsig experiment does not match run.json.",
    );
  });

  test("starts only an experiment that is still in setup", async () => {
    const methods: string[] = [];
    const client = new StatsigConsoleClient("console-test", {
      fetch: async (_input, init) => {
        methods.push(init?.method ?? "GET");
        if (init?.method === "GET") {
          return Response.json({data: {status: "setup"}});
        }
        return Response.json({message: "started"});
      },
    });

    const started = await client.ensureExperimentStarted(
      "creative_flywheel_smoke_001",
    );

    expect(methods).toEqual(["GET", "PUT"]);
    expect(started.already_active).toBe(false);
  });

  test("does not restart an experiment that is already active", async () => {
    const methods: string[] = [];
    const client = new StatsigConsoleClient("console-test", {
      fetch: async (_input, init) => {
        methods.push(init?.method ?? "GET");
        return Response.json({data: {status: "active"}});
      },
    });

    const started = await client.ensureExperimentStarted(
      "creative_flywheel_smoke_001",
    );

    expect(methods).toEqual(["GET"]);
    expect(started).toMatchObject({already_active: true, start: null});
  });
});
