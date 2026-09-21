# Creative Flywheel

Creative Flywheel runs a complete local creative-optimization loop: it compares
two seed ads, simulates audience responses, uses an OpenAI model to propose each
new challenger, renders the videos, and shows the completed trajectory in a
local dashboard.

The dashboard summarizes the current champion and shows how install rate changes
across optimization rounds:

![](public/good-result.png)

## Deliverables

- **Code:** [renderer](src/video.tsx),
[audience model](src/audience/model.ts),
[Statsig integration](src/experiment/statsig.ts), and
[agent orchestrator](src/agent/orchestrator.ts). See the
[single-command local workflow](#run-the-end-to-end-test-locally).
- **Report**: [Report:](REPORT.md#4-agent-loop) How this works and why design like that? Limitation and next steps
- **Experiments:** [Statsig exposure stream](public/statsig-exposure-stream.png)
and [current result status](public/statsig-results-unavailable.png).
- **Creatives:** [generation-zero manifests](manifests/) and the
[render pipeline](src/video.tsx). Each local run writes the generation-zero
and final-generation videos and manifests to `artifacts/runs/`; use the
[dashboard](#open-the-dashboard) to review them.
- **Trajectory:** the [dashboard](#open-the-dashboard),
[portable trajectory model](src/agent/trajectory.ts)
- **Recording:** the 13-minute walkthrough is [here](https://drive.google.com/file/d/1xHkAf_6buwDD0y3u3jHWejWG1V3-d_3M/view?usp=sharing); the external upload link is pending. See the [productionization sketch](REPORT.md#5-productionization) and
[next steps](REPORT.md#next-steps).



## Set up the environment

Install [Bun](https://bun.sh/) 1.3.14, then install the project dependencies:

```bash
bun install --frozen-lockfile
```

Create a `.env` file in the project root:

```dotenv
OPENAI_API_KEY=your-api-key
OPENAI_MODEL=gpt-5.6-luna
```

The local end-to-end workflow does not require Statsig credentials. The API key
is used only when the agent proposes the next challenger. Each round also renders
its creatives locally; the first render downloads Remotion's pinned Chrome
Headless Shell.

## Open the dashboard

Start the dashboard to explore completed optimization runs:

```bash
bun run dashboard
```

Then open [http://localhost:3000](http://localhost:3000). The dashboard reads
runs from `artifacts/runs/` and shows each round's creatives, experiment result,
agent learning, next hypothesis, and creative lineage. Select a run from the
menu to switch between trajectories.

Set `DASHBOARD_PORT` to use a different port:

```bash
DASHBOARD_PORT=4000 bun run dashboard
```

## Statsig integration status

The Statsig path can create and start an experiment, assign users through the
Statsig SDK, and log exposures and outcome events. Result retrieval is designed
to fetch cumulative exposures, diagnostics, and metrics from the Console API,
then store normalized snapshots so the agent can resume from the latest
published state. However, the agent cannot currently retrieve this data from
Statsig. Retrieval against static experiment data is still failing and under
investigation.

This step is important for production because Statsig results are not real-time.
The agent must persist its state, wait while Statsig processes the experiment,
retry observation later, and resume safely when results become available. Data
latency is therefore part of the workflow's execution time, not just a dashboard
refresh issue.

Statsig confirms that control and treatment exposure events are arriving:

![Statsig Exposure Stream showing control and treatment assignments](public/statsig-exposure-stream.png)

However, the Results view still reports that the experiment metrics are
unavailable. This is the current blocker for agent observation and resumption:

![Statsig Results showing unavailable experiment metrics](public/statsig-results-unavailable.png)

## Run the end-to-end test locally

```bash
bun run agent run \
  --seed-control g0_v00 \
  --seed-treatment g0_v01 \
  --max-rounds 10 \
  --verbose

bun run agent run \
  --seed-control g0_v02 \
  --seed-treatment g0_v03 \
  --max-rounds 10 \
  --verbose

bun run agent run \
  --seed-control g0_v04 \
  --seed-treatment g0_v05 \
  --max-rounds 10 \
  --verbose

bun run agent run \
  --seed-control g0_v06 \
  --seed-treatment g0_v07 \
  --max-rounds 10 \
  --verbose
```

The eight generation-zero manifests are divided into four seed pairs. Each
command runs ten optimization rounds, writes a separate run to `artifacts/runs/`,
starts the local dashboard, and opens the completed run in your browser.