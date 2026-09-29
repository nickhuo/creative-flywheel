import {parseArgs} from "node:util";
import {fileURLToPath} from "node:url";

import {Client, Connection, WorkflowExecutionAlreadyStartedError} from "@temporalio/client";
import {NativeConnection, Worker} from "@temporalio/worker";

import {observeExperiment, watchExperimentInputSchema} from "../agent/durable-activities";

const {values, positionals} = parseArgs({
  allowPositionals: true,
  options: {
    "run-id": {type: "string"},
    "max-rounds": {type: "string", default: "10"},
    "poll-seconds": {type: "string", default: "3600"},
  },
});
const command = positionals[0];
if (positionals.length !== 1 || !["worker", "start", "status", "check", "cancel"].includes(command ?? "")) {
  throw new Error("Usage: bun run durable <worker|start|status|check|cancel> [--run-id <id>] [--poll-seconds 3600] [--max-rounds 10]");
}
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "creative-flywheel";
const connectionOptions = {
  address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  ...(process.env.TEMPORAL_API_KEY
    ? {apiKey: process.env.TEMPORAL_API_KEY, tls: true}
    : {}),
};

if (command === "worker") {
  const connection = await NativeConnection.connect(connectionOptions);
  try {
    const worker = await Worker.create({
      connection,
      namespace,
      taskQueue,
      workflowsPath: fileURLToPath(new URL("../agent/durable-workflow.ts", import.meta.url)),
      activities: {observeExperiment},
      maxConcurrentActivityTaskExecutions: 1,
      shutdownGraceTime: "10 seconds",
    });
    await worker.run();
  } finally {
    await connection.close();
  }
} else {
  const input = watchExperimentInputSchema.parse({
    run_id: values["run-id"],
    max_rounds: Number(values["max-rounds"]),
    poll_interval_ms: Number(values["poll-seconds"]) * 1000,
  });
  const workflowId = `statsig-observer-${input.run_id}`;
  const connection = await Connection.connect(connectionOptions);
  try {
    const client = new Client({connection, namespace});
    const handle = client.workflow.getHandle(workflowId);
    if (command === "start") {
      try {
        await client.workflow.start("watchExperiment", {
          workflowId,
          taskQueue,
          args: [input],
          workflowIdReusePolicy: "ALLOW_DUPLICATE_FAILED_ONLY",
        });
        console.log(JSON.stringify({workflow_id: workflowId, status: "started"}));
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
        console.log(JSON.stringify({workflow_id: workflowId, status: "already_exists"}));
      }
    } else if (command === "check") {
      await handle.signal("checkNow");
      console.log(JSON.stringify({workflow_id: workflowId, status: "check_requested"}));
    } else if (command === "cancel") {
      await handle.cancel();
      console.log(JSON.stringify({workflow_id: workflowId, status: "cancellation_requested"}));
    } else {
      const description = await handle.describe();
      const observation: unknown = description.status.name === "RUNNING"
        ? await handle.query("observationStatus")
        : description.status.name === "COMPLETED" ? await handle.result() : null;
      console.log(JSON.stringify({workflow_id: workflowId, status: description.status.name, observation}, null, 2));
    }
  } finally {
    await connection.close();
  }
}
