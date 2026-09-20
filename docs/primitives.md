# Domain primitives

This document is the review inventory for domain primitives that already exist in the codebase. Code remains the executable source of truth. This file explains each primitive's role and links to its definition. An entry here does not imply approval. A primitive must be reviewed before its name, fields, ownership, or boundary is changed.

Update this document in the same change whenever a primitive is added, renamed, or removed.

## CreativeManifest

Definitions:

- [`creativeManifestSchema` and `CreativeManifest`](../src/manifest.ts)
- [`renderableCreativeManifestSchema`](../src/manifest.ts)
- [`CREATIVE_LAYER_CATALOG`](../src/manifest.ts)
- [`CREATIVE_LAYER_VALUES`](../src/manifest.ts)

A renderable creative variant.

It owns the stable variant identity, generation lineage, and the six creative layers consumed by the renderer and audience model. Generation 0 has no parent; later generations require one.
The local optimization loop namespaces each challenger as
`{optimization_run_id}_g{generation}_v00`, so creative identity remains globally
unique while experiment run identity stays separate. Runtime creative packages
belong to their root `OptimizationRun` under
`artifacts/runs/{optimization_run_id}/creatives/{variant_id}/`; the checked-in
generation-zero manifests remain reusable source definitions.

The general schema accepts non-empty layer values so the audience model can report
unseen-value coverage. The render boundary is deliberately narrower: every layer
must belong to the catalog fitted by the checked-in audience model. The catalog is
the single source for executable values and their stable creative semantics. It has
6 backgrounds, 4 characters, 5 actions, 5 hooks, 4 CTAs, and 3 audio styles, for
7,200 deterministic combinations. Format is fixed at 1080×1920, 30 fps, and 8
seconds by `VIDEO_SPEC`; it is not a manifest dimension.

## CampaignBrief

Definition: [`CAMPAIGN_BRIEF`](../src/agent/challenger.ts)

Trusted, versioned context for the Challenger Agent. It describes the Rune
Keepers product, campaign objective, audience, and brand constraints. It does not
own the executable creative catalog, manifests, experiment results, or
audience-model parameters. Its audience motivations guide hypotheses but are not
experimental evidence.

## AudienceModel

Definition: [`audienceModelSchema` and `AudienceModel`](../src/audience/model.ts#L131-L232)

A frozen, versioned artifact fitted from historical impression data.

It owns source dataset metadata, the deterministic train/validation split, feature vocabulary, model coefficients, audience and fatigue distributions, validation metrics, and inference policies. It does not own experiment assignment or round state.

## ExposureContext

Definitions:

- [`exposureContextSchema`](../src/audience/model.ts#L112-L121)
- [`ExposureContext`](../src/audience/model.ts#L230)

The context required to score or sample one assigned creative exposure.

The experiment runner owns these values; the audience model consumes them without creating users, timestamps, impression IDs, or exposure counts.

## ImpressionOutcome

Definitions:

- [`impressionOutcomeSchema`](../src/audience/model.ts#L123-L129)
- [`ImpressionOutcome`](../src/audience/model.ts#L231)

The deterministic sampled result for one impression.

It combines an `ExposureContext` with the assigned `variant_id` and binary click/install outcomes. A view-through install (`click = 0`, `install = 1`) is valid.

## AudiencePrediction

Definition: [`AudiencePrediction`](../src/audience/model.ts#L233-L242)

The audience model's probabilities and training-data coverage for one manifest and exposure context.

It is an audit value, not an experiment result and not an input to the challenger agent.

`layer_coverage` describes only coverage of `CreativeManifest.layers`:

- `combination_seen`: the complete layer combination appeared in training data.
- `new_combination`: every layer value appeared, but not in this combination.
- `contains_unseen_values`: at least one layer value did not appear; the affected fields are listed in `unseen_layers`.

## ExperimentRun

Definition: [`experimentRunSchema` and `ExperimentRun`](../src/experiment/run.ts)

An auditable record of one experiment execution.

It owns the frozen hypothesis and layer changes, input paths, seed, two-arm
definitions, metric names and types, fixed-horizon statistical
design, calculated sample size, batch plan, current lifecycle status, and the
Statsig experiment receipt. The experiment runner may advance its status, but it
must reject changed inputs and must never persist platform credentials.

Each run fixes one exposure per synthetic user. Statsig is the assignment source
of truth for a provider run. The local simulator instead uses reproducible paired
50/50 assignment; in both cases the audience model only samples the assigned
creative's outcome.

New runs use one-time `event_user` metrics for binary install and click outcomes.
Their means are the fraction of exposed users who fired each event, matching the
one-exposure-per-user design. The schema still accepts the earlier ratio metric
names and types so existing run artifacts remain readable.

The first local run estimates its baseline from the control creative and fitted
audience mix. Each subsequent local run freezes the preceding experiment's
observed champion rate as its baseline and recalculates its fixed-horizon sample
size. Challenger generation does not own or modify the statistical design.

## OptimizationRun

Definitions:

- [`optimizationRunPlanSchema`](../src/artifacts.ts)
- [`experimentLogRecordSchema`](../src/artifacts.ts)

One complete creative-optimization trajectory.

Its immutable plan owns the optimization identity, creation time, initial
experiment, audience-model reference, and initial variants. All experiment
snapshots for the trajectory are stored in one `experiments.json` array; raw
provider and simulator observations are stored in one `observations.json` array.
Its `creatives/` directory owns the immutable manifest, video, and render
metadata packages used or generated by that optimization. SQLite indexes the
current round and champion for scheduling and lookup, while `trajectory.json`
is the portable audit export.

## ResultSnapshot

Definition: [`resultSnapshotSchema` and `ResultSnapshot`](../src/experiment/evaluation.ts)

An immutable view of the evidence available for one experiment observation. The
experiment observer owns it. Its stable `snapshot_id` is also the SQLite
idempotency key; repeated observations with the same normalized evidence reuse
the same snapshot.

It normalizes provider identity (`statsig` or the local `simulator`), analysis
method, data date, arm exposures, health issues, and primary and secondary metric
results. Raw provider responses remain in the observation log and authorization
or execution state remains in the agent ledger. A snapshot never owns a
recommendation or action.

## ChallengerProposal

Definition: [`challengerProposalSchema` and `ChallengerProposal`](../src/experiment/evaluation.ts)

A typed evaluation and creative hypothesis produced by the single Challenger
Agent for one completed `ResultSnapshot`.

It owns the agent's interpretation and learning from the completed experiment,
a structured next hypothesis, its tradeoffs, rationale, evidence references,
and complete renderable layer selection. The hypothesis separates the actual
experiment population, audience motivation, and proposed creative mechanism.
The evaluation reflects on the completed experiment after either a deterministic
`stop` or `promote` decision. It does not choose whether to stop, promote, or
terminate and has no approval or execution authority. The deterministic policy
selects the next champion before the agent is called.

## ProposedAction

Definition: [`proposedActionSchema` and `ProposedAction`](../src/experiment/evaluation.ts)

A typed workflow action assembled for exactly one `ResultSnapshot`.

It owns the deterministic `stop`, `promote`, or `terminate` result and the
evidence used by that policy. `stop` and `promote` also contain the
`ChallengerProposal` used to prepare the next experiment; `terminate` does not.
`terminate` records the final experiment's `stop` or `promote` result and the
resulting champion before ending the optimization loop.
It does not own eligibility, approval, or execution authority. Provider actions
require human review, while the local simulator approves and executes them.

## Not domain primitives

`FeatureSpec`, `LogisticModel`, `Metrics`, `PreviewRecord`, `AudienceRow`,
`EncodedRow`, `BinomialGroup`, `ExperimentEventRecord`, and `ExperimentSummary`
are implementation or audit details. They do not define the creative-loop protocol
and do not require domain-level naming.

`ExperimentLogRecord`, `ObservationLogRecord`, `EligibilityAssessment`,
`DecisionProposalRecord`, and `ActionReceiptRecord` are implementation or audit
details. `Round` and `Decision` remain planning names and are not implemented
primitives.
