import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";

import type {ObservationStep, WatchExperimentInput, observeExperiment} from "./durable-activities";

export const checkNow = defineSignal("checkNow");
export const observationStatus = defineQuery<ObservationStep | null>("observationStatus");

const activities = proxyActivities<{observeExperiment: typeof observeExperiment}>({
  startToCloseTimeout: "5 minutes",
  heartbeatTimeout: "30 seconds",
  retry: {
    initialInterval: "10 seconds",
    backoffCoefficient: 2,
    maximumInterval: "5 minutes",
    maximumAttempts: 5,
  },
});

export async function watchExperiment(input: WatchExperimentInput): Promise<ObservationStep> {
  let shouldCheck = false;
  let latest: ObservationStep | null = null;
  setHandler(checkNow, () => { shouldCheck = true; });
  setHandler(observationStatus, () => latest);

  while (true) {
    shouldCheck = false;
    latest = await activities.observeExperiment(input);
    if (latest.status === "completed") return latest;
    if (latest.status === "blocked") {
      await condition(() => shouldCheck);
    } else {
      await condition(() => shouldCheck, input.poll_interval_ms);
    }
    if (workflowInfo().continueAsNewSuggested) {
      await continueAsNew<typeof watchExperiment>(input);
    }
  }
}
