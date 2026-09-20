import {resolve} from "node:path";

import {normalizeStatsigObservation} from "../experiment/statsig-results";
import {StatsigConsoleClient} from "../experiment/statsig";
import {experimentRunIdSchema} from "../experiment/run";
import {loadDashboardData, type DashboardData} from "./data";

const projectRoot = resolve(import.meta.dir, "../..");
const runsDirectory = resolve(projectRoot, "artifacts/runs");
const ledgerPath = resolve(
  projectRoot,
  Bun.env.SIMULA_AGENT_DB ?? "artifacts/state.sqlite",
);
const port = Number(Bun.env.DASHBOARD_PORT ?? "3000");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new RangeError("DASHBOARD_PORT must be an integer from 1 to 65535.");
}

const consoleKey = Bun.env.STATSIG_CONSOLE_API_KEY?.trim();
const statsigClient = consoleKey === undefined || consoleKey === ""
  ? null
  : new StatsigConsoleClient(consoleKey);
let cached: {expires_at: number; payload: DashboardData} | null = null;

const server = Bun.serve({
  port,
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/dashboard") {
      try {
        const shouldRefresh = url.searchParams.get("refresh") === "1";
        if (shouldRefresh || cached === null || cached.expires_at <= Date.now()) {
          const payload = await loadDashboardData({
            project_root: projectRoot,
            runs_directory: runsDirectory,
            ledger_path: ledgerPath,
            observe: statsigClient === null
              ? undefined
              : async (run) => normalizeStatsigObservation(
                  run,
                  await statsigClient.observeExperiment(run),
                  new Date().toISOString(),
                ),
          });
          cached = {expires_at: Date.now() + 30_000, payload};
        }
        return Response.json(cached.payload, {
          headers: {"Cache-Control": "no-store"},
        });
      } catch (error) {
        return Response.json(
          {
            error: error instanceof Error
              ? error.message
              : "Dashboard data could not be loaded.",
          },
          {status: 500, headers: {"Cache-Control": "no-store"}},
        );
      }
    }
    if (url.pathname === "/health") {
      return Response.json({status: "ok"});
    }
    const mediaMatch = /^\/media\/([^/]+)\/([^/]+)\.mp4$/.exec(url.pathname);
    if (mediaMatch !== null) {
      const runId = experimentRunIdSchema.safeParse(mediaMatch[1]);
      const variantId = experimentRunIdSchema.safeParse(mediaMatch[2]);
      if (!runId.success || !variantId.success) {
        return new Response("Not found", {status: 404});
      }
      const video = Bun.file(
        resolve(
          runsDirectory,
          runId.data,
          "creatives",
          variantId.data,
          "video.mp4",
        ),
      );
      if (!(await video.exists())) {
        return new Response("Not found", {status: 404});
      }
      const headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Type": "video/mp4",
      };
      const range = request.headers.get("Range");
      if (range === null) {
        return new Response(request.method === "HEAD" ? null : video, {
          headers: {...headers, "Content-Length": String(video.size)},
        });
      }
      const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (
        rangeMatch === null ||
        (rangeMatch[1] === "" && rangeMatch[2] === "")
      ) {
        return new Response(null, {
          status: 416,
          headers: {...headers, "Content-Range": `bytes */${video.size}`},
        });
      }
      const suffixLength = rangeMatch[1] === "" ? Number(rangeMatch[2]) : null;
      const start = suffixLength === null
        ? Number(rangeMatch[1])
        : Math.max(video.size - suffixLength, 0);
      const requestedEnd = rangeMatch[2] === ""
        ? video.size - 1
        : Number(rangeMatch[2]);
      const end = suffixLength === null
        ? Math.min(requestedEnd, video.size - 1)
        : video.size - 1;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start > end ||
        start >= video.size
      ) {
        return new Response(null, {
          status: 416,
          headers: {...headers, "Content-Range": `bytes */${video.size}`},
        });
      }
      return new Response(
        request.method === "HEAD" ? null : video.slice(start, end + 1),
        {
          status: 206,
          headers: {
            ...headers,
            "Content-Length": String(end - start + 1),
            "Content-Range": `bytes ${start}-${end}/${video.size}`,
          },
        },
      );
    }
    if (url.pathname === "/app.js") {
      return new Response(Bun.file(resolve(import.meta.dir, "app.js")), {
        headers: {"Content-Type": "text/javascript; charset=utf-8"},
      });
    }
    if (url.pathname === "/styles.css") {
      return new Response(Bun.file(resolve(import.meta.dir, "styles.css")), {
        headers: {"Content-Type": "text/css; charset=utf-8"},
      });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(resolve(import.meta.dir, "index.html")), {
        headers: {"Content-Type": "text/html; charset=utf-8"},
      });
    }
    return new Response("Not found", {status: 404});
  },
});

console.log(`Creative Flywheel dashboard: ${server.url}`);
