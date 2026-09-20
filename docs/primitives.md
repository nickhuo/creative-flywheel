# Domain primitives

This document is the review inventory for domain primitives that already exist in the codebase. Code remains the executable source of truth. This file explains each primitive's role and links to its definition. An entry here does not imply approval. A primitive must be reviewed before its name, fields, ownership, or boundary is changed.

Update this document in the same change whenever a primitive is added, renamed, or removed.

## CreativeManifest

Definitions:

- [`creativeManifestSchema` and `CreativeManifest`](../src/manifest.ts)
- [`renderableCreativeManifestSchema`](../src/manifest.ts)
- [`CREATIVE_LAYER_VALUES`](../src/manifest.ts)

A renderable creative variant.

It owns the stable variant identity, generation lineage, and the six creative layers consumed by the renderer and audience model. Generation 0 has no parent; later generations require one.
The local optimization loop names its single challenger in each generation
`g{generation}_v00`; experiment run identity remains separate from creative
identity.

The general schema accepts non-empty layer values so the audience model can report
unseen-value coverage. The render boundary is deliberately narrower: every layer
must belong to the catalog fitted by the checked-in audience model. The catalog has
6 backgrounds, 4 characters, 5 actions, 5 hooks, 4 CTAs, and 4 audio styles, for
9,600 deterministic combinations. Format is fixed at 1080×1920, 30 fps, and 8
seconds by `VIDEO_SPEC`; it is not a manifest dimension.

## AudienceModel

Definition: [`audienceModelSchema` and `AudienceModel`](../src/audience/model.ts#L131-L232)

A frozen, versioned artifact fitted from historical impression data.

It owns the source fingerprint, deterministic train/validation split, feature vocabulary, model coefficients, audience and fatigue distributions, validation metrics, and inference policies. It does not own experiment assignment or round state.

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

It is an audit value, not an experiment result and not an input to the decision agent.

`layer_coverage` describes only coverage of `CreativeManifest.layers`:

- `combination_seen`: the complete layer combination appeared in training data.
- `new_combination`: every layer value appeared, but not in this combination.
- `contains_unseen_values`: at least one layer value did not appear; the affected fields are listed in `unseen_layers`.

## ExperimentRun

Definition: [`experimentRunSchema` and `ExperimentRun`](../src/experiment/run.ts)

An auditable record of one experiment execution.

It owns the frozen hypothesis and layer changes, input paths and fingerprints,
seed, two-arm definitions, metric names, fixed-horizon statistical design,
calculated sample size, batch plan, current lifecycle status, and the Statsig
experiment receipt. The experiment runner may advance its status, but it must
reject changed inputs and must never persist platform credentials.

Each run fixes one exposure per synthetic user. Statsig is the assignment source
of truth for a provider run. The local simulator instead uses reproducible paired
50/50 assignment; in both cases the audience model only samples the assigned
creative's outcome.

## Not domain primitives

`FeatureSpec`, `LogisticModel`, `Metrics`, `PreviewRecord`, `AudienceRow`,
`EncodedRow`, `BinomialGroup`, `ExperimentEventRecord`, and `ExperimentSummary`
are implementation or audit details. They do not define the creative-loop protocol
and do not require domain-level naming.

`Round`, `ResultSnapshot`, and `Decision` are planning names only. They are not implemented primitives and must be reviewed before implementation.
