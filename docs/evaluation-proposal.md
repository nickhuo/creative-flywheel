# Agent Evaluation Proposal

## Objective

Find better creatives within a fixed budget, approaching the simulator’s highest expected install rate.

| Capability | Core question |
| --- | --- |
| Evidence Use | Can the Agent find and correctly interpret relevant evidence? |
| **Hypothesis Formation — evaluate first** | Does it choose better creative changes than random selection? |
| Reflection & Adaptation | Does feedback improve its next proposal? |

## Budget and baseline

- **Budget:** ten challenger proposals per strategy per run. Record exposures and model cost separately.
- **Random baseline:** after promotion, change one random layer; otherwise, change two or three with equal probability. Select layers and replacement values uniformly from legal choices.
- Both strategies use the same simulator, promotion rules, and duplicate restrictions.

## Paired comparisons

```mermaid
flowchart TD
    S[Same starting champion and initial result] --> A[Agent: 10 proposals]
    S --> R[Random: 10 proposals]
    K[Same simulation seed within each comparison] -.-> A
    K -.-> R
    A --> AC[Agent final champion]
    R --> RC[Random final champion]
    AC --> D[Compare expected install rates]
    RC --> D
    D --> REPEAT[Restart with a new seed: 20 comparisons per starting pair]
```

- Use all four existing starting pairs. Freeze the model, audience, catalog, and Agent version.
- Comparison 1 uses seed 1 for both strategies; comparison 2 uses seed 2, and so on. Seeds reproduce simulator randomness, not LLM responses or identical outcomes.
- Give Agent runs the same starting history; keep subsequent histories separate. Reserve unused seeds for final evaluation after tuning.

## Calculate the simulator optimum

For each creative and audience group, the model predicts both installation paths:

```mermaid
flowchart LR
    C[Creative + audience group] --> CLICK[Click: probability q]
    C --> NOCLICK[No click: probability 1-q]
    CLICK --> I1[Install given click: probability a]
    NOCLICK --> I0[Install without click: probability b]
    I1 --> P["Group install probability: q × a + (1 − q) × b"]
    I0 --> P
    P --> W[Weighted average across audience groups]
    W --> RATE[Expected install rate for this creative]
    RATE --> MAX[Repeat for all 7,200 creatives; take the maximum]
```

**Formula:** `p_install = q × a + (1 − q) × b`.

Audience groups are segment × operating system; use frozen audience weights summing to 1 and first exposure (`exposure_n = 1`).

**Example:** 60% of users have a 2% install probability; 40% have 1%. The creative’s expected rate is **0.6 × 2% + 0.4 × 1% = 1.6%**.

These scores use probabilities directly, without sampled outcomes. Keep them hidden from both strategies during search.

## Read the results

| Result | Meaning |
| --- | --- |
| Agent champion rate − random champion rate | Positive means the Agent wins that comparison |
| Best possible rate − current champion rate | Zero means the simulator optimum has been reached |

Report average paired advantage with a 95% confidence interval, accounting for starting-pair groups. Plot distance to the optimum after each proposal: faster decline means more efficient search.