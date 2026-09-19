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

The first slice deliberately uses a local CSS composition and a silent AAC track.
Real image, character, font, and audio assets come after this render contract is
working end to end.

The first render downloads Remotion's pinned Chrome Headless Shell once.
