import {execFile} from "node:child_process";
import {fileURLToPath} from "node:url";

import {ApplicationFailure, Context} from "@temporalio/activity";
import {z} from "zod";

export const watchExperimentInputSchema = z.object({
  run_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  max_rounds: z.number().int().positive().default(10),
  poll_interval_ms: z.number().int().min(1000).default(60 * 60 * 1000),
}).strict();

export type WatchExperimentInput = z.infer<typeof watchExperimentInputSchema>;
export type ObservationStep = {
  status: "waiting" | "completed" | "blocked";
  reasons: string[];
  proposal_id: string | null;
};

const tickResponseSchema = z.object({
  outcomes: z.array(z.discriminatedUnion("status", [
    z.object({
      run_id: z.string(),
      status: z.literal("observed"),
      eligibility: z.object({
        status: z.enum(["ready", "waiting", "blocked"]),
        reason_codes: z.array(z.string()),
      }),
      proposal: z.object({proposal_id: z.string()}).nullable(),
    }),
    z.object({run_id: z.string(), status: z.literal("already_claimed")}),
    z.object({
      run_id: z.string(), status: z.literal("proposal_exists"), proposal_id: z.string(),
    }),
    z.object({run_id: z.string(), status: z.literal("blocked"), error: z.string()}),
    z.object({run_id: z.string(), status: z.literal("failed"), error: z.string()}),
  ])).length(1),
});

export async function observeExperiment(input: WatchExperimentInput): Promise<ObservationStep> {
  const options = watchExperimentInputSchema.parse(input);
  const context = Context.current();
  const heartbeat = setInterval(() => context.heartbeat(), 10_000);
  try {
    // The ledger and artifact readers require Bun; the Temporal Worker runs on Node.
    const response = await new Promise<string>((resolve, reject) => {
      execFile(process.env.BUN_EXECUTABLE ?? "bun", [
        "run", "src/cli/agent.ts", "tick", "--durable",
        "--run-id", options.run_id,
        "--max-rounds", String(options.max_rounds),
        "--trigger", "provider_event",
      ], {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        signal: context.cancellationSignal,
        timeout: 4 * 60 * 1000,
        killSignal: "SIGKILL",
        maxBuffer: 2 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (context.cancellationSignal.aborted) {
          reject(context.cancellationSignal.reason);
        } else if (error !== null && (error.killed || stdout.trim() === "")) {
          reject(new Error(`Observation process failed: ${stderr.slice(-2000) || error.message}`));
        } else {
          resolve(stdout);
        }
      });
    });
    const {outcomes} = tickResponseSchema.parse(JSON.parse(response));
    const outcome = outcomes[0]!;
    if (outcome.run_id !== options.run_id) {
      throw ApplicationFailure.nonRetryable("Observation returned another run.");
    }
    if (outcome.status === "failed") {
      if (/failed \((401|403)\)/.test(outcome.error)) {
        throw ApplicationFailure.nonRetryable(outcome.error, "StatsigAuthorizationError");
      }
      throw ApplicationFailure.retryable(outcome.error, "ObservationError");
    }
    if (outcome.status === "proposal_exists") {
      return {status: "completed", reasons: [], proposal_id: outcome.proposal_id};
    }
    if (outcome.status === "blocked") {
      return {status: "blocked", reasons: [outcome.error], proposal_id: null};
    }
    if (outcome.status === "already_claimed") {
      return {status: "waiting", reasons: ["already_claimed"], proposal_id: null};
    }
    return {
      status: outcome.proposal !== null
        ? "completed"
        : outcome.eligibility.status === "blocked" ? "blocked" : "waiting",
      reasons: outcome.eligibility.reason_codes,
      proposal_id: outcome.proposal?.proposal_id ?? null,
    };
  } finally {
    clearInterval(heartbeat);
  }
}
