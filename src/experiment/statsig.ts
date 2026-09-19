import {Statsig, StatsigUser} from "@statsig/statsig-node-core";
import {z} from "zod";

import {type ExposureContext} from "../audience/model";
import {
  CLICK_EVENT,
  CTR_METRIC,
  IMPRESSION_EVENT,
  INSTALL_EVENT,
  INSTALL_RATE_METRIC,
  type ExperimentEventRecord,
  type ExperimentRun,
  type StatsigExperimentReceipt,
} from "./run";

const CONSOLE_API_VERSION = "20240601";
const DEFAULT_CONSOLE_URL = "https://statsigapi.net/console/v1";

const metricSchema = z
  .object({
    name: z.string(),
    type: z.literal("ratio"),
    directionality: z.literal("increase"),
    unitTypes: z.array(z.string()),
    metricEvents: z.array(
      z
        .object({
          name: z.string(),
          type: z.enum(["count", "count_distinct"]),
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

  async #ensureRatioMetric(
    name: string,
    numeratorEvent: string,
    denominatorEvent: string,
  ): Promise<{created: boolean; raw: unknown}> {
    const path = `/metrics/${encodeURIComponent(name)}/ratio`;
    const existing = await this.#request("GET", path, undefined, true);
    if (existing !== null) {
      const metric = metricSchema.parse(unwrapData(existing));
      const eventNames = metric.metricEvents.map((event) => event.name);
      if (
        eventNames[0] !== numeratorEvent ||
        eventNames[1] !== denominatorEvent ||
        metric.metricEvents.some(
          (event) =>
            event.type !== "count" || (event.criteria?.length ?? 0) !== 0,
        ) ||
        metric.metricEvents.length !== 2 ||
        metric.unitTypes.length !== 1 ||
        metric.unitTypes[0] !== "userID"
      ) {
        throw new Error(
          `Existing Statsig metric ${name} does not match ${numeratorEvent}/${denominatorEvent}.`,
        );
      }
      return {created: false, raw: existing};
    }

    const raw = await this.#request("POST", "/metrics", {
      name,
      type: "ratio",
      description: `Creative Flywheel ${numeratorEvent} per ${denominatorEvent}.`,
      directionality: "increase",
      unitTypes: ["userID"],
      metricEvents: [
        {name: numeratorEvent, type: "count", criteria: []},
        {name: denominatorEvent, type: "count", criteria: []},
      ],
    });
    metricSchema.parse(unwrapData(raw));
    return {created: true, raw};
  }

  async ensureSmokeMetrics(): Promise<unknown[]> {
    const install = await this.#ensureRatioMetric(
      INSTALL_RATE_METRIC,
      INSTALL_EVENT,
      IMPRESSION_EVENT,
    );
    const click = await this.#ensureRatioMetric(
      CTR_METRIC,
      CLICK_EVENT,
      IMPRESSION_EVENT,
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
      hypothesis: run.experiment.hypothesis,
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
      expected: {name: string; type: "ratio"},
    ) =>
      actual.name === expected.name &&
      actual.type === expected.type &&
      actual.direction === "increase";
    if (
      experiment.id !== run.experiment.name ||
      experiment.name !== run.experiment.name ||
      experiment.idType !== run.experiment.assignment_unit ||
      experiment.description !== description ||
      experiment.hypothesis !== run.experiment.hypothesis ||
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
      experiment.secondaryMetrics.length !==
        run.experiment.secondary_metrics.length ||
      !experiment.secondaryMetrics.every((metric, index) =>
        matchesMetric(metric, run.experiment.secondary_metrics[index]!),
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

  async inspectExperiment(experimentId: string): Promise<unknown> {
    const experiment = await this.#request(
      "GET",
      `/experiments/${encodeURIComponent(experimentId)}`,
    );
    const cumulativeExposures = await this.#request(
      "GET",
      `/experiments/${encodeURIComponent(experimentId)}/cumulative_exposures`,
      undefined,
      true,
    );
    return {experiment, cumulative_exposures: cumulativeExposures};
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
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) {
      throw new Error(
        `Statsig Console API ${method} ${path} failed (${response.status}): ${apiMessage(payload)}`,
      );
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

function apiMessage(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  ) {
    return value.message;
  }
  return "unknown error";
}
