import {Statsig, StatsigUser} from "@statsig/statsig-node-core";
import {z} from "zod";

import {type ExposureContext} from "../audience/model";
import {
  CLICK_EVENT,
  IMPRESSION_EVENT,
  INSTALL_EVENT,
  type ExperimentEventRecord,
  type ExperimentRun,
  type StatsigExperimentReceipt,
} from "./run";

const CONSOLE_API_VERSION = "20240601";
const DEFAULT_CONSOLE_URL = "https://statsigapi.net/console/v1";

const metricSchema = z
  .object({
    name: z.string(),
    type: z.enum(["ratio", "event_user"]),
    directionality: z.literal("increase"),
    unitTypes: z.array(z.string()),
    rollupTimeWindow: z.string().nullish(),
    metricEvents: z.array(
      z
        .object({
          name: z.string(),
          type: z.enum(["count", "count_distinct"]).optional(),
          criteria: z.array(z.unknown()).optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const experimentResponseSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    idType: z.string().min(1),
    description: z.string(),
    hypothesis: z.string(),
    permalink: z.string().url(),
    status: z.string(),
    controlGroupID: z.string().nullish(),
    allocation: z.number(),
    primaryMetrics: z.array(
      z
        .object({
          name: z.string(),
          type: z.string(),
          direction: z.string().optional(),
        })
        .passthrough(),
    ),
    secondaryMetrics: z.array(
      z
        .object({
          name: z.string(),
          type: z.string(),
          direction: z.string().optional(),
        })
        .passthrough(),
    ),
    targetExposures: z.number().int(),
    targetingGateID: z.string().nullable(),
    sequentialTesting: z.boolean(),
    bonferroniCorrection: z.boolean(),
    enabledNonProdEnvironments: z.array(z.string()).optional(),
    groups: z.array(
      z
        .object({
          id: z.string().min(1),
          name: z.string().min(1),
          size: z.number(),
          parameterValues: z.record(z.string(), z.unknown()),
          isControl: z.boolean(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type Assignment = {
  variant_id: string;
  statsig_group_name: string;
  statsig_rule_id: string;
};

export type StatsigExperimentObservation = {
  experiment: unknown;
  cumulative_exposures: unknown | null;
  diagnostics_checks: unknown | null;
  metric_results: Array<{
    name: string;
    role: "primary" | "secondary";
    response: unknown | null;
  }>;
};

export class StatsigConsoleClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;

  constructor(
    apiKey: string,
    options: {base_url?: string; fetch?: FetchLike} = {},
  ) {
    if (apiKey.trim() === "") throw new Error("Statsig Console API key is empty.");
    this.#apiKey = apiKey;
    this.#baseUrl = options.base_url ?? DEFAULT_CONSOLE_URL;
    this.#fetch = options.fetch ?? fetch;
  }

  async #ensureOutcomeMetric(
    name: string,
    eventName: string,
    type: "ratio" | "event_user",
  ): Promise<{created: boolean; raw: unknown}> {
    const path = `/metrics/${encodeURIComponent(name)}/${type}`;
    const existing = await this.#request("GET", path, undefined, true);
    if (existing !== null) {
      const metric = metricSchema.parse(unwrapData(existing));
      const eventNames = metric.metricEvents.map((event) => event.name);
      const expectedEventNames =
        type === "ratio" ? [eventName, IMPRESSION_EVENT] : [eventName];
      if (
        metric.type !== type ||
        JSON.stringify(eventNames) !== JSON.stringify(expectedEventNames) ||
        metric.metricEvents.some(
          (event) =>
            (event.type !== undefined && event.type !== "count") ||
            (event.criteria?.length ?? 0) !== 0,
        ) ||
        metric.unitTypes.length !== 1 ||
        metric.unitTypes[0] !== "userID" ||
        (type === "event_user" && metric.rollupTimeWindow !== "max")
      ) {
        throw new Error(
          `Existing Statsig metric ${name} does not match ${eventName}.`,
        );
      }
      return {created: false, raw: existing};
    }

    const metricEvents = [{name: eventName, type: "count", criteria: []}];
    if (type === "ratio") {
      metricEvents.push({name: IMPRESSION_EVENT, type: "count", criteria: []});
    }
    const raw = await this.#request("POST", "/metrics", {
      name,
      type,
      description:
        type === "ratio"
          ? `Creative Flywheel ${eventName} per ${IMPRESSION_EVENT}.`
          : `Creative Flywheel users with ${eventName}.`,
      directionality: "increase",
      unitTypes: ["userID"],
      metricEvents,
      ...(type === "event_user" ? {rollupTimeWindow: "max"} : {}),
    });
    metricSchema.parse(unwrapData(raw));
    return {created: true, raw};
  }

  async ensureExperimentMetrics(
    run: ExperimentRun,
  ): Promise<Array<{created: boolean; raw: unknown}>> {
    const install = await this.#ensureOutcomeMetric(
      run.experiment.primary_metric.name,
      INSTALL_EVENT,
      run.experiment.primary_metric.type,
    );
    const click = await this.#ensureOutcomeMetric(
      run.experiment.secondary_metrics[0].name,
      CLICK_EVENT,
      run.experiment.secondary_metrics[0].type,
    );
    return [install, click];
  }

  async ensureExperiment(
    run: ExperimentRun,
  ): Promise<{
    raw: unknown;
    receipt: StatsigExperimentReceipt;
    reused: boolean;
  }> {
    const [control, treatment] = run.experiment.arms;
    const description = `Auditable creative smoke run ${run.run_id}.`;
    const body: Record<string, unknown> = {
      name: run.experiment.name,
      id: run.experiment.name,
      description,
      hypothesis: run.experiment.hypothesis.statement,
      idType: run.experiment.assignment_unit,
      allocation: 100,
      groups: [
        {
          name: "Control",
          size: control.allocation_percent,
          parameterValues: {variant_id: control.variant_id},
        },
        {
          name: "Treatment",
          size: treatment.allocation_percent,
          parameterValues: {variant_id: treatment.variant_id},
        },
      ],
      primaryMetrics: [
        {...run.experiment.primary_metric, direction: "increase"},
      ],
      secondaryMetrics: run.experiment.secondary_metrics.map((metric) => ({
        ...metric,
        direction: "increase",
      })),
      targetExposures: run.traffic.users,
      sequentialTesting: false,
      bonferroniCorrection: false,
    };
    if (run.experiment.environment !== "production") {
      body.enabledNonProdEnvironments = [run.experiment.environment];
    }

    const path = `/experiments/${encodeURIComponent(run.experiment.name)}`;
    const existing = await this.#request("GET", path, undefined, true);
    const raw =
      existing ?? (await this.#request("POST", "/experiments", body));
    const experiment = experimentResponseSchema.parse(unwrapData(raw));
    const expectedEnvironments =
      run.experiment.environment === "production"
        ? []
        : [run.experiment.environment];
    const matchesMetric = (
      actual: {name: string; type: string; direction?: string},
      expected: {name: string; type: "ratio" | "event_user"},
    ) =>
      actual.name === expected.name &&
      actual.type === expected.type &&
      actual.direction === "increase";
    if (
      experiment.id !== run.experiment.name ||
      experiment.name !== run.experiment.name ||
      experiment.idType !== run.experiment.assignment_unit ||
      experiment.description !== description ||
      experiment.hypothesis !== run.experiment.hypothesis.statement ||
      experiment.allocation !== 100 ||
      experiment.targetExposures !== run.traffic.users ||
      (experiment.targetingGateID !== null &&
        experiment.targetingGateID !== "") ||
      experiment.sequentialTesting ||
      experiment.bonferroniCorrection ||
      JSON.stringify(experiment.enabledNonProdEnvironments ?? []) !==
        JSON.stringify(expectedEnvironments) ||
      experiment.primaryMetrics.length !== 1 ||
      !matchesMetric(
        experiment.primaryMetrics[0]!,
        run.experiment.primary_metric,
      ) ||
      !run.experiment.secondary_metrics.every((expectedMetric) =>
        experiment.secondaryMetrics.some((metric) =>
          matchesMetric(metric, expectedMetric)
        )
      ) ||
      experiment.groups.length !== 2
    ) {
      throw new Error("Existing Statsig experiment does not match run.json.");
    }
    const controlGroup = experiment.groups.find(
      (group) => group.parameterValues.variant_id === control.variant_id,
    );
    const treatmentGroup = experiment.groups.find(
      (group) => group.parameterValues.variant_id === treatment.variant_id,
    );
    if (
      controlGroup === undefined ||
      treatmentGroup === undefined ||
      controlGroup.name !== "Control" ||
      treatmentGroup.name !== "Treatment" ||
      controlGroup.size !== control.allocation_percent ||
      treatmentGroup.size !== treatment.allocation_percent ||
      Object.keys(controlGroup.parameterValues).length !== 1 ||
      Object.keys(treatmentGroup.parameterValues).length !== 1
    ) {
      throw new Error("Existing Statsig experiment does not match run.json.");
    }
    if (experiment.controlGroupID !== controlGroup.id) {
      throw new Error("Existing Statsig experiment does not match run.json.");
    }
    if (!controlGroup.isControl || treatmentGroup.isControl) {
      throw new Error("Existing Statsig experiment does not match run.json.");
    }

    return {
      raw,
      reused: existing !== null,
      receipt: {
        experiment_id: experiment.id,
        permalink: experiment.permalink,
        control_group_id: controlGroup.id,
        treatment_group_id: treatmentGroup.id,
        recorded_at: new Date().toISOString(),
        active_observed_at: null,
      },
    };
  }

  async ensureExperimentStarted(experimentId: string): Promise<{
    already_active: boolean;
    before: unknown;
    start: unknown | null;
  }> {
    const path = `/experiments/${encodeURIComponent(experimentId)}`;
    const before = await this.#request("GET", path);
    const {status} = z
      .object({status: z.string()})
      .passthrough()
      .parse(unwrapData(before));
    if (status === "active") {
      return {already_active: true, before, start: null};
    }
    if (status !== "setup") {
      throw new Error(`Statsig experiment cannot start from status ${status}.`);
    }
    const start = await this.#request("PUT", `${path}/start`);
    return {already_active: false, before, start};
  }

  async observeExperiment(
    run: ExperimentRun,
  ): Promise<StatsigExperimentObservation> {
    if (run.statsig_experiment === null) {
      throw new Error("Run has no Statsig experiment.");
    }
    const receipt = run.statsig_experiment;
    const experimentId = encodeURIComponent(receipt.experiment_id);
    const experiment = await this.#request(
      "GET",
      `/experiments/${experimentId}`,
    );
    const cumulativeExposures = await this.#request(
      "GET",
      `/experiments/${experimentId}/cumulative_exposures`,
      undefined,
      true,
    );
    const diagnosticsChecks = await this.#request(
      "GET",
      `/experiments/${experimentId}/diagnostics_checks?lastDays=7`,
      undefined,
      true,
    );
    const metrics = [
      {role: "primary" as const, ...run.experiment.primary_metric},
      ...run.experiment.secondary_metrics.map((metric) => ({
        role: "secondary" as const,
        ...metric,
      })),
    ];
    const metricResults = await Promise.all(
      metrics.map(async (metric) => {
        const query = new URLSearchParams({
          control: receipt.control_group_id,
          test: receipt.treatment_group_id,
          metricID: `${metric.name}::${metric.type}`,
          confidence: String((1 - run.statistical_design.alpha) * 100),
        });
        return {
          name: metric.name,
          role: metric.role,
          response: await this.#request(
            "GET",
            `/experiments/${experimentId}/pulse_metric_result?${query}`,
            undefined,
            true,
          ),
        };
      }),
    );

    return {
      experiment,
      cumulative_exposures: cumulativeExposures,
      diagnostics_checks: diagnosticsChecks,
      metric_results: metricResults,
    };
  }

  async #request(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
    allowNotFound = false,
  ): Promise<unknown | null> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "STATSIG-API-KEY": this.#apiKey,
        "STATSIG-API-VERSION": CONSOLE_API_VERSION,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) {
      const detail = text.replaceAll(this.#apiKey, "[REDACTED]").slice(0, 500);
      throw new Error(
        `Statsig Console API ${method} ${path} failed (${response.status}): ${detail || response.statusText}`,
      );
    }
    let payload: unknown = null;
    if (text !== "") {
      try {
        payload = JSON.parse(text);
      } catch (error) {
        throw new Error(
          `Statsig returned invalid JSON (${response.status}).`,
          {cause: error},
        );
      }
    }
    return payload;
  }
}

export class StatsigExperimentSession {
  readonly #statsig: Statsig;
  readonly #experimentId: string;
  readonly #variants: Set<string>;
  #isClosed = false;

  private constructor(
    statsig: Statsig,
    experimentId: string,
    variants: string[],
  ) {
    this.#statsig = statsig;
    this.#experimentId = experimentId;
    this.#variants = new Set(variants);
  }

  static async open(
    serverSecret: string,
    run: ExperimentRun,
  ): Promise<StatsigExperimentSession> {
    if (serverSecret.trim() === "") {
      throw new Error("Statsig Server Secret is empty.");
    }
    if (run.statsig_experiment === null) {
      throw new Error("Run has no Statsig experiment.");
    }

    const statsig = new Statsig(serverSecret, {
      environment: run.experiment.environment,
      outputLogLevel: "warn",
    });
    const initialized = await statsig.initialize();
    if (!initialized.isSuccess) {
      await statsig.shutdown();
      throw new Error(`Statsig SDK initialization failed: ${initialized.error}`);
    }

    const variants = run.experiment.arms.map((arm) => arm.variant_id);
    try {
      const groups = statsig.getExperimentGroups(
        run.statsig_experiment.experiment_id,
      );
      const configuredVariants = new Set(
        groups.groups.map((group) => group.returnValue.variant_id),
      );
      if (
        groups.isExperimentActive !== true ||
        variants.some((variant) => !configuredVariants.has(variant))
      ) {
        throw new Error(
          "Statsig experiment is not active or has not propagated both variants.",
        );
      }
    } catch (error) {
      await statsig.shutdown();
      throw error;
    }

    return new StatsigExperimentSession(
      statsig,
      run.statsig_experiment.experiment_id,
      variants,
    );
  }

  assign(context: ExposureContext): Assignment {
    if (this.#isClosed) throw new Error("Statsig session is closed.");
    const user = statsigUser(context);
    const experiment = this.#statsig.getExperiment(user, this.#experimentId, {
      disableExposureLogging: true,
    });
    const variantId = experiment.get("variant_id", "");
    if (!this.#variants.has(variantId)) {
      throw new Error(
        `Statsig returned an unknown or fallback variant for ${context.user_id}.`,
      );
    }
    if (experiment.groupName === null || experiment.ruleID === "") {
      throw new Error(`Statsig returned no group for ${context.user_id}.`);
    }
    return {
      variant_id: variantId,
      statsig_group_name: experiment.groupName,
      statsig_rule_id: experiment.ruleID,
    };
  }

  log(record: ExperimentEventRecord): void {
    if (this.#isClosed) throw new Error("Statsig session is closed.");
    const user = statsigUser(record);
    const metadata = {
      run_id: record.run_id,
      impression_id: record.impression_id,
      variant_id: record.variant_id,
      segment: record.segment,
      os: record.os,
      exposure_n: record.exposure_n,
    };
    this.#statsig.manuallyLogExperimentExposure(user, this.#experimentId);
    this.#statsig.logEvent(user, IMPRESSION_EVENT, 1, metadata);
    if (record.click === 1) {
      this.#statsig.logEvent(user, CLICK_EVENT, 1, metadata);
    }
    if (record.install === 1) {
      this.#statsig.logEvent(user, INSTALL_EVENT, 1, metadata);
    }
  }

  async close(): Promise<void> {
    if (this.#isClosed) return;
    this.#isClosed = true;
    const result = await this.#statsig.shutdown();
    if (!result.isSuccess) {
      throw new Error(`Statsig SDK shutdown failed: ${result.error}`);
    }
  }
}

function statsigUser(context: ExposureContext): StatsigUser {
  return new StatsigUser({
    userID: context.user_id,
    custom: {segment: context.segment, os: context.os},
  });
}

function unwrapData(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("data" in value)) {
    throw new Error("Statsig response is missing data.");
  }
  return value.data;
}
