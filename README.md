# Creative Flywheel

Turn every experiment into better creative.

Implemented domain primitives and their source definitions are maintained in
[`docs/primitives.md`](docs/primitives.md).

## Run

```bash
bun install --frozen-lockfile
bun run check
bun run render manifests/g0_v00.json
bun run render manifests/g0_v01.json
```

Rendered videos are written to `renders/{variant_id}.mp4`.
Generation zero contains eight manifests (`g0_v00` through `g0_v07`) that cover
all values in the six-layer render catalog. The renderer is deterministic and
uses only local CSS, animation, text, and reviewed audio assets; no generation API
is required. The three audio styles use checked-in CC0 loops documented in
[`public/audio/README.md`](public/audio/README.md).

Fit and preview the deterministic audience model with:

```bash
bun run audience fit --csv scratchpad/creative_performance.csv --out artifacts/audience/model.json
bun run audience sample --model artifacts/audience/model.json --manifests manifests/g0_v00.json,manifests/g0_v01.json --per-variant 100 --seed 42 --out artifacts/audience/sample.json
```

The preview uses matched audience contexts for inspection only. Statsig assignment
and experiment results belong to the next stage of the loop.

## Experiment smoke run

Copy `.env.example` to `.env` and set a Statsig Console API Key, Server Secret,
and environment. The two keys have separate responsibilities and are never
written to artifacts.

Run each boundary separately so its artifact can be reviewed before continuing:

```bash
bun run experiment prepare --run-id smoke_001
bun run experiment create --run-id smoke_001
bun run experiment serve --run-id smoke_001
bun run experiment inspect --run-id smoke_001
```

`prepare` freezes the hypothesis and statistical design. By default it estimates
the control creative's marginal install rate from the fitted audience model, uses
an absolute MDE of 0.0025, alpha 0.05, power 0.8, and rounds the calculated
fixed-horizon sample size up to a complete 500-user batch. Override these
assumptions with `--baseline-rate`, `--mde`, `--alpha`, `--power`, `--batch-size`,
or `--hypothesis`. Each later simulator round uses the preceding experiment's
observed champion rate as its baseline and recalculates its fixed sample size.

`prepare` is offline. `create` ensures the install-rate and CTR ratio metrics,
creates a 50/50 Statsig experiment, and starts it explicitly. `serve` asks Statsig
for every user’s arm, samples exactly one impression from the frozen audience
model, logs outcome events, and flushes the SDK. `inspect` saves raw platform
state; it deliberately does not turn that response into a decision or normalized
result yet.

Artifacts live under `artifacts/experiments/{run_id}/`.
`statsig-create.raw.json` preserves the create/start responses; `events.jsonl`
and `summary.json` are local reconciliation evidence. Statsig remains the source
of experiment results. Synthetic user IDs are namespaced by run so a later smoke
run cannot add outcome events to an earlier experiment's cohort.

Before logging traffic, `serve` writes `events.pending.jsonl` and advances the run
to `serving`. If sending or flushing then fails, it intentionally refuses an
automatic retry because Statsig may already hold a partial batch. Keep the pending
artifact for diagnosis and prepare a new run; resumable delivery belongs to the
later round-ledger step.

Open the Remotion Studio with:

```bash
bun run dev
```

The first slice deliberately uses a local CSS composition. Background, character,
action, hook, and CTA each change the rendered frames; `audio_style` selects a
local soundtrack or silence. Real image, character, font, and mastered audio
assets can replace these mappings without changing the manifest contract.

The first render downloads Remotion's pinned Chrome Headless Shell once.

## Creative optimization agent

Set `OPENAI_API_KEY` and `OPENAI_MODEL` in `.env`, then run one observation tick:

```bash
bun run agent tick --run-id smoke_001
```

Run a multi-round optimization entirely against the local audience simulator:

```bash
bun run agent simulate --run-id smoke_001 --max-rounds 10
```

The simulator adds one reproducible 50/50 batch at a time and records every
cumulative snapshot. The deterministic gate advances intermediate batches without
calling the model. At the calculated fixed horizon, deterministic policy chooses
`stop` or `promote`. Unless the maximum round has been reached, one Challenger
Agent call uses the updated champion, complete experiment history, and a versioned
Rune Keepers campaign brief to propose the next hypothesis and renderable layer
combination. The local executor prepares the next run and repeats until
deterministic `terminate`.

Without `--run-id`, the command scans every `served` or `awaiting_results`
experiment under `artifacts/experiments/`. A scheduler can call it hourly:

```bash
bun run agent tick
```

The tick fetches cumulative exposures, diagnostics, and Statsig metric results,
appends the raw response to `observations.jsonl`, and stores an immutable normalized
snapshot in `artifacts/agent/state.sqlite`. The current experiments use a fixed
horizon, so the deterministic decision runs only after target exposure is met,
the primary metric is ready, and health checks pass. The model is called only to
propose a challenger after `stop` or `promote`; it never chooses the experiment
outcome. Repeating a tick with unchanged provider evidence does not call the model
again.

Inspect and review proposals with:

```bash
bun run agent proposals --status pending
bun run agent approve --proposal-id <id> --reviewed-by <actor>
bun run agent reject --proposal-id <id> --reviewed-by <actor> --note <reason>
```

The fixed-horizon action space is `stop`, `promote`, and `terminate`; there is no
`continue`. Provider actions require human approval. Their external executors are
not implemented yet, so approval records intent without mutating Statsig or
publishing creative. The local simulator auto-approves actions and prepares the
next experiment so the optimization trajectory can be reproduced end to end.
