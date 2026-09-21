const dashboard = globalThis.document?.querySelector("#dashboard") ?? null;
const runSelect = globalThis.document?.querySelector("#run-select") ?? null;
const state = {data: null, selectedRunId: null};
const requestedOptimizationRunId = typeof globalThis.location === "undefined"
  ? null
  : new URLSearchParams(globalThis.location.search).get("run");

if (dashboard !== null && runSelect !== null) {
  dashboard.addEventListener("click", (event) => {
    const button = event.target.closest("[data-run-id]");
    if (!(button instanceof HTMLButtonElement)) return;
    state.selectedRunId = button.dataset.runId;
    render();
    document.querySelector(
      `[data-run-id="${CSS.escape(state.selectedRunId)}"]`,
    )?.focus();
  });

  runSelect.addEventListener("change", () => {
    const track = state.data?.tracks.find(
      ({optimization_run_id: optimizationRunId}) =>
        optimizationRunId === runSelect.value,
    );
    const latestRun = track?.rounds.at(-1);
    if (latestRun === undefined) return;
    state.selectedRunId = latestRun.run_id;
    render();
  });
}

async function loadDashboard() {
  runSelect.disabled = true;
  dashboard.setAttribute("aria-busy", "true");
  try {
    const response = await fetch("/api/dashboard?refresh=1", {
      headers: {Accept: "application/json"},
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error ?? `Request failed (${response.status})`);
    }
    state.data = payload;
    const rounds = payload.tracks.flatMap((track) => track.rounds);
    if (!rounds.some((run) => run.run_id === state.selectedRunId)) {
      const requestedTrack = payload.tracks.find(
        ({optimization_run_id: optimizationRunId}) =>
          optimizationRunId === requestedOptimizationRunId,
      );
      state.selectedRunId = requestedTrack?.rounds.at(-1)?.run_id ??
        payload.tracks[0]?.rounds.at(-1)?.run_id ?? null;
    }
    render();
  } catch (error) {
    dashboard.innerHTML = `
      <section class="card error-panel" role="alert">
        <div><h2>Unable to load experiment data</h2><p>${escapeHtml(error instanceof Error ? error.message : "Unknown error")}</p></div>
      </section>`;
    runSelect.innerHTML = `<option>Runs unavailable</option>`;
  } finally {
    dashboard.setAttribute("aria-busy", "false");
  }
}

function render() {
  if (state.data === null) return;
  if (state.data.tracks.length === 0) {
    runSelect.innerHTML = `<option>No runs</option>`;
    runSelect.disabled = true;
    dashboard.innerHTML = `
      <section class="card empty-dashboard">
        <div><h2>No optimization runs yet</h2><p>Run <code>bun run experiment prepare --run-id &lt;id&gt;</code> to create the first trajectory.</p></div>
      </section>`;
    return;
  }

  const allRounds = state.data.tracks.flatMap((track) => track.rounds);
  const selectedRun = allRounds.find(
    (run) => run.run_id === state.selectedRunId,
  ) ?? state.data.tracks[0].rounds.at(-1);
  const selectedTrack = state.data.tracks.find(
    ({optimization_run_id: optimizationRunId}) =>
      optimizationRunId === selectedRun.optimization_run_id,
  ) ?? state.data.tracks[0];
  const trackRounds = selectedTrack.rounds;
  const finalRun = trackRounds.at(-1);
  const finalMetric = readyPrimaryMetric(finalRun);
  const finalSecondaryMetric = finalRun?.snapshots.at(-1)?.secondary_metrics.find(
    ({status}) => status === "ready",
  ) ?? null;
  const initialMetric = readyPrimaryMetric(trackRounds[0]);
  const finalChampionRate = finalMetric === null
    ? null
    : championRate(finalRun, finalMetric);
  const finalChampionCtr = finalSecondaryMetric === null
    ? null
    : championRate(finalRun, finalSecondaryMetric);
  const baselineRate = initialMetric?.control.mean ?? null;
  const cumulativeExposures = trackRounds.reduce(
    (total, run) => total + totalExposures(run),
    0,
  );
  const agentUpdates = trackRounds.filter(
    ({decision}) => decision !== null && decision.action.action !== "terminate",
  ).length;
  const sourceLabel = trackRounds.every(
    ({evidence_source: source}) => source === "simulator",
  ) ? "Audience model" : "Statsig";
  const trackLift = finalChampionRate === null || baselineRate === null
    ? null
    : finalChampionRate / baselineRate - 1;
  const finalChampion = finalRun === undefined ? null : championVariant(finalRun);
  runSelect.innerHTML = state.data.tracks.map((track) =>
    `<option value="${escapeHtml(track.optimization_run_id)}">${escapeHtml(track.optimization_run_id)}</option>`
  ).join("");
  runSelect.value = selectedTrack.optimization_run_id;
  runSelect.disabled = false;

  dashboard.innerHTML = `
    <section class="card overview" aria-label="Optimization trajectory overview">
      <div class="overview-primary">
        <div class="overview-label">Current champion${finalChampion === null ? "" : ` · <span>${escapeHtml(finalChampion)}</span>`}</div>
        ${finalChampionRate === null
          ? `<div class="overview-value pending">Awaiting results</div><p class="overview-copy">This track does not have a ready primary metric yet.</p>`
          : `<div class="overview-metrics"><div class="overview-metric primary"><strong>${formatPercent(finalChampionRate)}</strong><span>Install rate</span></div><div class="overview-metric"><strong>${finalChampionCtr === null ? "—" : formatPercent(finalChampionCtr)}</strong><span>CTR</span></div></div><p class="overview-copy">${trackLift === null ? "" : `<strong>${formatSignedPercent(trackLift)}</strong> install lift vs. Round 1 · `}${formatInteger(cumulativeExposures)} total exposures</p>`}
      </div>
    </section>

    <article class="card panel trend-panel">
      <div class="panel-header"><div><h2>Optimization trend</h2><p class="panel-kicker">Observed arms and the Champion path across rounds</p></div><span class="pill ${sourceLabel === "Audience model" ? "simulator" : "live"}">${escapeHtml(sourceLabel)}</span></div>
      ${renderOptimizationTrend(trackRounds, selectedRun.run_id)}
    </article>

    <div class="section-heading trajectory-heading"><div><h2>Agent evolution</h2><p>Evidence → interpretation → learning → next hypothesis → creative change</p></div><span>${agentUpdates} belief updates</span></div>
    ${renderTrajectoryLog(trackRounds, selectedRun.run_id)}`;
}

export function renderTrajectoryLog(runs, selectedRunId) {
  return `<section class="trajectory-log" aria-label="Agent evolution by experiment round">${runs.map((run, index) => {
    const metric = readyPrimaryMetric(run);
    const action = run.decision?.action ?? null;
    const nextChallenger = action !== null && action.action !== "terminate"
      ? action.next_challenger
      : null;
    const [control, treatment] = run.arms;
    const champion = didPromote(run) ? treatment : control;
    const nextVariant = runs[index + 1]?.arms[1]?.variant_id ?? null;
    const proposedChanges = nextChallenger === null || champion === undefined
      ? []
      : Object.entries(nextChallenger.layers).flatMap(([layer, value]) =>
          champion.layers[layer] === value
            ? []
            : [{layer, control_value: champion.layers[layer], treatment_value: value}]
        );
    const creativeComparison = `<div class="creative-comparison">${run.arms.map((arm) => {
      const label = arm.role === "control" ? "Control video" : "Challenger video";
      return arm.video_url === null
        ? `<div class="creative-link unavailable"><span><b>${label}</b><small>${escapeHtml(arm.variant_id)} · unavailable</small></span></div>`
        : `<figure class="creative-video"><video controls playsinline preload="metadata" aria-label="${escapeHtml(label)} for ${escapeHtml(arm.variant_id)}"><source src="${escapeHtml(arm.video_url)}" type="video/mp4"></video><figcaption><span><b>${label}</b><small>${escapeHtml(arm.variant_id)}.mp4</small></span><a class="creative-open" href="${escapeHtml(arm.video_url)}" target="_blank" rel="noopener">Open <span aria-hidden="true">↗</span></a></figcaption></figure>`;
    }).join("")}</div>`;
    const allocation = run.arms.map(({allocation_percent: percent}) => percent).join(" / ");
    const experimentConfig = `
      <dl class="experiment-config" aria-label="Experiment configuration">
        <div><dt>Sample</dt><dd>${formatInteger(run.required_users)} users</dd></div>
        <div><dt>Split</dt><dd>${escapeHtml(allocation)}</dd></div>
        <div><dt>MDE</dt><dd>${formatPercentagePoints(run.minimum_detectable_effect)}</dd></div>
        <div><dt>α / power</dt><dd>${run.alpha.toFixed(2)} / ${formatPercent(run.power, 0)}</dd></div>
        <div><dt>Batch</dt><dd>${formatInteger(run.batch_size)}</dd></div>
      </dl>`;
    const result = metric === null
      ? `<p class="trajectory-empty">Waiting for the primary metric</p>`
      : `<div class="trajectory-result-values"><span><small>Control</small>${formatPercent(metric.control.mean)}</span><span><small>Challenger</small>${formatPercent(metric.treatment.mean)}</span><span class="${metric.absolute_effect >= 0 ? "positive" : "negative"}"><small>Effect</small>${formatPercentagePoints(metric.absolute_effect)}</span></div><p class="trajectory-confidence">p ${metric.p_value.toFixed(3)} · 95% CI ${formatPercentagePoints(metric.confidence_interval.lower)} to ${formatPercentagePoints(metric.confidence_interval.upper)}</p>`;
    return `
      <article class="trajectory-entry ${run.run_id === selectedRunId ? "selected" : ""}">
        <div class="trajectory-marker"><span>R${run.round}</span></div>
        <div class="card trajectory-card">
          <button class="trajectory-select" type="button" data-run-id="${escapeHtml(run.run_id)}" aria-current="${run.run_id === selectedRunId ? "true" : "false"}">
            <span class="arm-pair"><small>Control</small><strong>${escapeHtml(control?.variant_id ?? "—")}</strong><i>vs</i><small>Challenger</small><strong>${escapeHtml(treatment?.variant_id ?? "—")}</strong></span>
            ${renderDecisionPill(run)}
          </button>
          <div class="trajectory-story">
            <section class="trajectory-block tested-block">
              <span class="story-step">01 · Tested</span>
              ${creativeComparison}
              ${experimentConfig}
              ${renderLayerChanges(run.hypothesis_changes)}
            </section>
            <section class="trajectory-block result-block">
              <span class="story-step">02 · Result</span>
              ${result}
              <p class="decision-copy">${action === null ? "No decision yet." : escapeHtml(action.summary)}</p>
            </section>
            <section class="trajectory-block learning-block">
              <span class="story-step">03 · Interpretation → learning</span>
              ${nextChallenger === null
                ? `<h3>Optimization complete</h3><p>${action === null ? "Waiting for the agent decision." : escapeHtml(action.rationale)}</p>`
                : `<p>${escapeHtml(nextChallenger.evaluation.interpretation)}</p><div class="learning-callout"><small>Belief update</small><strong>${escapeHtml(nextChallenger.evaluation.learning)}</strong></div>`}
            </section>
            <section class="trajectory-block next-block">
              <span class="story-step">04 · Next hypothesis → creative</span>
              ${nextChallenger === null
                ? `<h3>No next challenger</h3><p>Final champion · ${escapeHtml(champion?.variant_id ?? "—")}</p>`
                : `<h3>${escapeHtml(nextChallenger.hypothesis.statement)}</h3><p>${escapeHtml(nextChallenger.hypothesis.mechanism)}</p><p class="next-variant">${escapeHtml(champion?.variant_id ?? "—")} → ${escapeHtml(nextVariant ?? "next variant")}</p>${renderLayerChanges(proposedChanges)}`}
            </section>
          </div>
        </div>
      </article>`;
  }).join("")}</section>`;
}

function renderLayerChanges(changes) {
  if (changes.length === 0) {
    return `<div class="change-list"><span class="change-chip unchanged">No layer change</span></div>`;
  }
  return `<div class="change-list">${changes.map((change) => `
    <span class="change-chip"><b>${escapeHtml(change.layer)}</b>${escapeHtml(change.control_value)} <i>→</i> ${escapeHtml(change.treatment_value)}</span>
  `).join("")}</div>`;
}

export function renderOptimizationTrend(runs, selectedRunId) {
  const observations = runs.flatMap((run) => {
    const metric = readyPrimaryMetric(run);
    return metric === null
      ? []
      : [{
          run,
          control: metric.control.mean,
          challenger: metric.treatment.mean,
          champion: championRate(run, metric),
        }];
  });
  if (observations.length === 0) {
    return `<div class="empty-evidence compact"><div><span class="empty-icon" aria-hidden="true">⌁</span><h3>Waiting for trend data</h3><p>This track does not have a ready primary metric yet.</p></div></div>`;
  }

  const width = 820;
  const height = 310;
  const left = 52;
  const right = 20;
  const top = 28;
  const bottom = 48;
  const values = observations.flatMap(
    ({control, challenger, champion}) => [control, challenger, champion],
  );
  const rawMinimum = Math.min(...values);
  const rawMaximum = Math.max(...values);
  const padding = Math.max((rawMaximum - rawMinimum) * .18, .0006);
  const minimum = Math.max(0, rawMinimum - padding);
  const maximum = rawMaximum + padding;
  const x = (index) => observations.length === 1
    ? (left + width - right) / 2
    : left + index / (observations.length - 1) * (width - left - right);
  const y = (value) => top + (maximum - value) / (maximum - minimum) *
    (height - top - bottom);
  const controlPoints = observations.map(({control}, index) => [x(index), y(control)]);
  const challengerPoints = observations.map(({challenger}, index) => [x(index), y(challenger)]);
  const championPoints = observations.map(({champion}, index) => [x(index), y(champion)]);
  const path = (points) => points.map(([pointX, pointY], index) =>
    `${index === 0 ? "M" : "L"}${pointX.toFixed(1)} ${pointY.toFixed(1)}`
  ).join(" ");
  const grid = Array.from({length: 4}, (_, index) => {
    const ratio = index / 3;
    const gridY = top + ratio * (height - top - bottom);
    const value = maximum - ratio * (maximum - minimum);
    return `<line class="grid-line" x1="${left}" y1="${gridY}" x2="${width - right}" y2="${gridY}"/><text class="axis-label" x="2" y="${gridY + 4}">${formatPercent(value)}</text>`;
  }).join("");
  const selectedIndex = observations.findIndex(({run}) => run.run_id === selectedRunId);
  const selectedMarker = selectedIndex === -1
    ? ""
    : `<line class="selected-round-line" x1="${x(selectedIndex)}" y1="${top}" x2="${x(selectedIndex)}" y2="${height - bottom}"/>`;
  const points = observations.map(({run}, index) => `
    <circle class="trend-dot control" cx="${controlPoints[index][0]}" cy="${controlPoints[index][1]}" r="4"/>
    <circle class="trend-dot challenger" cx="${challengerPoints[index][0]}" cy="${challengerPoints[index][1]}" r="4"/>
    <circle class="trend-dot champion" cx="${championPoints[index][0]}" cy="${championPoints[index][1]}" r="7"/>
    <text class="axis-label round-label" x="${x(index)}" y="${height - 19}" text-anchor="middle">R${run.round ?? index + 1}</text>
  `).join("");

  const dataTable = observations.map(({run, control, challenger, champion}) =>
    `<tr><th scope="row">R${run.round}</th><td>${formatPercent(control)}</td><td>${formatPercent(challenger)}</td><td>${formatPercent(champion)}</td></tr>`
  ).join("");

  return `
    <div class="trend-legend"><span><i class="legend-line control"></i>Control observed</span><span><i class="legend-line challenger"></i>Challenger observed</span><span><i class="legend-line champion"></i>Champion path</span></div>
    <svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="trend-title trend-description">
      <title id="trend-title">Optimization trend</title>
      <desc id="trend-description">Control, Challenger, and Champion install rates across optimization rounds.</desc>
      ${grid}${selectedMarker}
      <path class="control-trend" d="${path(controlPoints)}"/>
      <path class="challenger-trend" d="${path(challengerPoints)}"/>
      <path class="champion-trend" d="${path(championPoints)}"/>
      ${points}
    </svg>
    <details class="trend-data">
      <summary>View exact trend values</summary>
      <div class="table-scroll"><table><caption>Install rate by optimization round</caption><thead><tr><th scope="col">Round</th><th scope="col">Control</th><th scope="col">Challenger</th><th scope="col">Champion</th></tr></thead><tbody>${dataTable}</tbody></table></div>
    </details>`;
}

function renderDecisionPill(run) {
  const action = run.decision?.action.action;
  if (action === undefined) return `<span class="pill prepared">Pending</span>`;
  return `<span class="pill ${decisionClass(action)}">${escapeHtml(action)}</span>`;
}

function readyPrimaryMetric(run) {
  const metric = run?.snapshots.at(-1)?.primary_metric;
  return metric?.status === "ready" ? metric : null;
}

function championRate(run, metric) {
  return didPromote(run) ? metric.treatment.mean : metric.control.mean;
}

function championVariant(run) {
  const [control, treatment] = run.arms;
  const action = run.decision?.action;
  if (action?.action === "terminate") return action.champion_variant_id;
  return didPromote(run)
    ? treatment?.variant_id ?? null
    : control?.variant_id ?? null;
}

function didPromote(run) {
  const action = run.decision?.action;
  return action?.action === "promote" ||
    (action?.action === "terminate" && action.final_experiment_action === "promote");
}

function decisionClass(action) {
  if (action === "promote") return "promote";
  if (action === "stop") return "stop";
  if (action === "terminate") return "terminate";
  return "prepared";
}

function totalExposures(run) {
  const snapshot = run?.snapshots.at(-1);
  return snapshot === undefined
    ? 0
    : snapshot.exposure_groups.reduce(
        (total, group) => total + group.exposures,
        0,
      );
}

function formatInteger(value) {
  return new Intl.NumberFormat("en-US", {maximumFractionDigits: 0}).format(value);
}

function formatPercent(value, digits = 2) {
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function formatSignedPercent(value) {
  if (value === null) return "n/a";
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    signDisplay: "always",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

function formatPercentagePoints(value) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(2)} pp`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]);
}

if (dashboard !== null && runSelect !== null) await loadDashboard();
