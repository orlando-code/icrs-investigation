import {
  buildDisplayPositions,
  escapeHtml,
  formatDistance,
  formatEmissions,
  formatTonnes,
} from "./utils.js";

const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const MAX_ZOOM = 10;
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

function isMobileLayout() {
  return window.matchMedia("(max-width: 900px)").matches;
}

function mapProjection() {
  return isMobileLayout() ? undefined : { type: "globe" };
}

function countryLabel(code) {
  try {
    return regionNames.of(code) || code;
  } catch {
    return code;
  }
}

function formatCount(value) {
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function normalizeEmissionsData(data) {
  if (data?.speakers) {
    return {
      meta: data.meta || {},
      speakers: data.speakers,
      all_delegates: data.all_delegates || data.speakers,
    };
  }
  return {
    meta: { generated_at: data.meta?.generated_at, delegate_meta: {} },
    speakers: data,
    all_delegates: data,
  };
}

export function createEmissionsView(rawEmissionsData, siteData, elements) {
  const normalized = normalizeEmissionsData(rawEmissionsData);
  const delegateMeta = normalized.meta.delegate_meta || {};
  const hasDelegatePool =
    Boolean(delegateMeta.non_speaker_count) &&
    normalized.all_delegates?.meta?.headline?.attendees_estimated !==
      normalized.speakers?.meta?.headline?.attendees_estimated;

  let includeNonSpeakers = false;
  let emissionsData = normalized.speakers;
  let locations = [];
  let allLocations = [];
  let headline = {};
  let rankings = [];
  let byCountry = [];
  let context = {};
  let positiveCo2e = [];
  let maxCo2e = 1;
  let minCo2e = 1;
  let sizeScale = null;
  let emissionNorm = null;
  let displayPositions = new Map();

  const auckland = siteData.meta.auckland;
  let rankMode = "affiliation";
  let selectedId = null;
  let hoveredId = null;
  let mapReady = false;

  const colorScale = (value) =>
    d3.interpolateRgb("#f7dcc8", "#c43c01")(emissionNorm(Math.max(value, minCo2e)));

  const map = new maplibregl.Map({
    container: elements.mapContainer,
    style: MAP_STYLE,
    center: [auckland.lon, auckland.lat],
    zoom: isMobileLayout() ? 1.35 : 1.9,
    minZoom: isMobileLayout() ? 0.9 : 0.5,
    maxZoom: MAX_ZOOM,
    projection: mapProjection(),
    touchPitch: false,
    cooperativeGestures: isMobileLayout(),
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

  function attendeeLabel() {
    return headline.attendee_label || (includeNonSpeakers ? "delegates" : "speakers");
  }

  function applyPool() {
    emissionsData = includeNonSpeakers ? normalized.all_delegates : normalized.speakers;
    allLocations = emissionsData.locations || [];
    locations = allLocations.filter((location) => location.co2e_kg > 0);
    headline = emissionsData.meta.headline || {};
    rankings = emissionsData.rankings || [];
    byCountry = emissionsData.by_country || [];
    context = emissionsData.meta.context || {};

    positiveCo2e = locations.map((location) => location.co2e_kg);
    maxCo2e = Math.max(...positiveCo2e, 1);
    minCo2e = Math.max(1, Math.min(...positiveCo2e));

    sizeScale = d3
      .scaleLog()
      .domain([minCo2e, maxCo2e])
      .range([7, 30])
      .clamp(true);
    emissionNorm = d3
      .scaleLog()
      .domain([minCo2e, maxCo2e])
      .range([0, 1])
      .clamp(true);
    displayPositions = buildDisplayPositions(allLocations);
    selectedId = null;
    hoveredId = null;
  }

  function locationById(id) {
    return allLocations.find((location) => location.id === id) || null;
  }

  function displayForLocation(location) {
    return displayPositions.get(location.id) || { lat: location.lat, lon: location.lon };
  }

  function radiusFor(location) {
    if (!location.co2e_kg) return 4;
    return sizeScale(location.co2e_kg);
  }

  function colorFor(location, highlighted) {
    if (!location.co2e_kg) return "#b8c4cc";
    if (location.id === selectedId) return "#1f6f8b";
    if (!highlighted) return "#b8c4cc";
    return colorScale(location.co2e_kg);
  }

  function renderHeadline() {
    const low = formatTonnes(headline.co2e_low_kg);
    const high = formatTonnes(headline.co2e_high_kg);
    const label = attendeeLabel();
    const delegateNote =
      includeNonSpeakers && delegateMeta.non_speaker_count
        ? ` · includes <strong>${formatCount(delegateMeta.non_speaker_count)}</strong> non-speaking delegates from the published list`
        : "";
    elements.headline.innerHTML = `
      <p class="emissions-kicker">Estimated return travel to Auckland</p>
      <p class="emissions-total">${formatTonnes(headline.co2e_kg)}</p>
      <p class="emissions-range">${low} – ${high}</p>
      <p class="emissions-meta">
        <strong>${headline.attendees_estimated.toLocaleString()}</strong> ${label} with geocoded affiliations ·
        <strong>${headline.attendees_missing_location.toLocaleString()}</strong> excluded (no location)${delegateNote}
      </p>
    `;
  }

  function formatRatioPhrase(ratio) {
    if (ratio >= 1.05) {
      const rounded = ratio >= 10 ? Math.round(ratio).toLocaleString() : ratio.toFixed(1);
      return `<strong>${rounded}×</strong> higher than`;
    }
    if (ratio <= 0.95) {
      return `<strong>${ratio.toFixed(1)}×</strong> (about ${Math.round(ratio * 100)}% of)`;
    }
    return `<strong>about the same as</strong>`;
  }

  function formatNationalTonnes(tonnes) {
    if (tonnes == null) return "—";
    return `${Number(tonnes).toLocaleString(undefined, { maximumFractionDigits: 2 })} t/person`;
  }

  function renderContext() {
    if (!elements.context) return;
    const bullets = [];
    const year = context.national_per_capita_year || 2022;
    const minN = context.country_avg_min_attendees || 3;
    const label = attendeeLabel();
    const travelSource = (context.sources || []).find((item) => item.id === "travel");
    const treeSource = (context.sources || []).find((item) => item.id === "tree_uptake");
    const nationalSource = (context.sources || []).find((item) => item.id === "national_per_capita");

    // Helper for [source] snippet if available
    function sourceLink(source) {
      return source
        ? ` [<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener">source</a>]`
        : "";
    }

    if (context.tree_years) {
      const kgPerTree = context.tree_kg_per_year_assumption || 22;
      bullets.push(
        `About <strong>${formatCount(context.tree_years)} tree-years</strong> of CO₂ uptake to offset this total (≈${kgPerTree} kg per mature tree per year${sourceLink(treeSource)}).`
      );
    }

    if (context.per_attendee_kg) {
      bullets.push(
        `Averaged across geocoded ${label}: <strong>${formatEmissions(context.per_attendee_kg, { compact: true })}</strong> estimated return travel per person${sourceLink(travelSource)}.`
      );
    }

    const nationalNote = nationalSource
      ? ` ([<a href="${escapeHtml(nationalSource.url)}" target="_blank" rel="noopener">World Bank ${year}</a>])`
      : ` (World Bank ${year})`;

    if (context.lowest_national_per_capita) {
      const row = context.lowest_national_per_capita;
      bullets.push(
        `Among countries with ≥${minN} ${label}, <strong>${escapeHtml(countryLabel(row.origin_country))}</strong> has the lowest national per-capita emissions (${formatNationalTonnes(row.national_tonnes_per_capita)}${nationalNote}). ${label.charAt(0).toUpperCase() + label.slice(1)} from ${escapeHtml(countryLabel(row.origin_country))} averaged ${formatRatioPhrase(row.ratio_vs_national_annual)} that annual footprint in return travel alone (${formatEmissions(row.co2e_per_attendee_kg, { compact: true })}/person, n=${row.attendee_count}).`
      );
    }

    if (context.highest_national_per_capita) {
      const row = context.highest_national_per_capita;
      bullets.push(
        `<strong>${escapeHtml(countryLabel(row.origin_country))}</strong> has the highest national per-capita emissions among represented countries (${formatNationalTonnes(row.national_tonnes_per_capita)}${nationalNote}). ${label.charAt(0).toUpperCase() + label.slice(1)} from ${escapeHtml(countryLabel(row.origin_country))} averaged ${formatRatioPhrase(row.ratio_vs_national_annual)} that annual footprint (${formatEmissions(row.co2e_per_attendee_kg, { compact: true })}/person, n=${row.attendee_count}).`
      );
    }

    if (context.conference_vs_lowest_national && context.conference_vs_highest_national) {
      const low = context.conference_vs_lowest_national;
      const high = context.conference_vs_highest_national;
      bullets.push(
        `Conference-wide average return travel (${formatEmissions(context.per_attendee_kg, { compact: true })}/person) is ${formatRatioPhrase(low.ratio_vs_national_annual)} ${escapeHtml(countryLabel(low.origin_country))}'s annual per-capita and ${formatRatioPhrase(high.ratio_vs_national_annual)} ${escapeHtml(countryLabel(high.origin_country))}'s annual per-capita.`
      );
    }

    for (const row of context.illustrative_per_capita || []) {
      const labelText =
        row.role === "illustrative_low"
          ? `For comparison, ${escapeHtml(countryLabel(row.origin_country))}'s national per-capita is ${formatNationalTonnes(row.national_tonnes_per_capita)}${nationalNote}: the conference average return trip is ${formatRatioPhrase(row.ratio_vs_national_annual)} that annual footprint.`
          : `${escapeHtml(countryLabel(row.origin_country))}'s national per-capita is ${formatNationalTonnes(row.national_tonnes_per_capita)}${nationalNote}; the conference average return trip is ${formatRatioPhrase(row.ratio_vs_national_annual)} that annual footprint.`;
      bullets.push(labelText);
    }

    const sources = context.sources || [];
    const sourcesHtml = sources.length
      ? `<div class="emissions-sources"><h3>Sources</h3><ul>${sources
        .map(
          (source) =>
            `<li><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener">${escapeHtml(source.label)}</a>${source.note ? `<span> — ${escapeHtml(source.note)}</span>` : ""}</li>`
        )
        .join("")}</ul></div>`
      : "";

    elements.context.innerHTML = bullets.length
      ? `<h3>Putting it in context</h3><ul class="emissions-context-list">${bullets.map((item) => `<li>${item}</li>`).join("")}</ul>${sourcesHtml}`
      : sourcesHtml;
  }

  function renderModeBreakdown() {
    const modes = emissionsData.meta.by_transport_mode || [];
    elements.modeBreakdown.innerHTML = modes
      .map((row) => {
        const label = row.transport_mode === "car" ? "NZ shared car" : "Return flights";
        const share = headline.co2e_kg
          ? Math.round((row.co2e_kg / headline.co2e_kg) * 100)
          : 0;
        return `<div class="emissions-mode-row">
          <span>${label}</span>
          <strong>${formatEmissions(row.co2e_kg, { compact: true })}</strong>
          <span class="emissions-mode-share">${share}%</span>
        </div>`;
      })
      .join("");
  }

  function renderLegend() {
    const samples = [
      { label: formatEmissions(minCo2e, { compact: true }), size: sizeScale(minCo2e), color: colorScale(minCo2e) },
      {
        label: formatEmissions(Math.sqrt(minCo2e * maxCo2e), { compact: true }),
        size: sizeScale(Math.sqrt(minCo2e * maxCo2e)),
        color: colorScale(Math.sqrt(minCo2e * maxCo2e)),
      },
      { label: formatEmissions(maxCo2e, { compact: true }), size: sizeScale(maxCo2e), color: colorScale(maxCo2e) },
    ];
    elements.legend.innerHTML = `
      <h3>Point size &amp; colour · travel CO₂e</h3>
      <p>Return-trip estimates per affiliation (economy flights; NZ by shared car).</p>
      ${samples
        .map(
          (sample) => `
        <div class="legend-row">
          <span class="legend-dot" style="width:${sample.size}px;height:${sample.size}px;background:${sample.color}"></span>
          <span>${sample.label}</span>
        </div>`
        )
        .join("")}
      <p class="legend-note">Click a bar or list item to focus the map.</p>
    `;
  }

  function renderBarChart() {
    if (rankMode === "affiliation") {
      const maxValue = rankings[0]?.co2e_kg || 1;
      elements.barChart.innerHTML = rankings
        .slice(0, 15)
        .map((row) => {
          const width = Math.max(4, (row.co2e_kg / maxValue) * 100);
          const selected = row.id === selectedId;
          return `
          <div class="bar-row${selected ? " selected" : ""}">
            <button type="button" data-id="${escapeHtml(row.id)}">${escapeHtml(row.affiliation)}</button>
            <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
            <span class="bar-count">${formatEmissions(row.co2e_kg, { compact: true })}</span>
          </div>`;
        })
        .join("");

      elements.barChart.querySelectorAll("button[data-id]").forEach((button) => {
        button.addEventListener("click", () => selectLocation(button.dataset.id, { fly: true, toggle: true }));
      });
      return;
    }

    const maxValue = byCountry[0]?.co2e_kg || 1;
    elements.barChart.innerHTML = byCountry
      .slice(0, 15)
      .map((row) => {
        const width = Math.max(4, (row.co2e_kg / maxValue) * 100);
        return `
        <div class="bar-row">
          <button type="button" disabled>${escapeHtml(countryLabel(row.origin_country))}</button>
          <div class="bar-track"><div class="bar-fill emissions-country-fill" style="width:${width}%"></div></div>
          <span class="bar-count">${formatEmissions(row.co2e_kg, { compact: true })}</span>
        </div>`;
      })
      .join("");
  }

  function renderRankings() {
    const personLabel = attendeeLabel().replace(/s$/, "");
    if (rankMode === "affiliation") {
      elements.resultsTitle.textContent = "Top affiliations by emissions";
      elements.results.innerHTML = rankings
        .slice(0, 30)
        .map((row) => {
          const selected = row.id === selectedId;
          return `
          <button type="button" class="result-item${selected ? " selected" : ""}" data-id="${escapeHtml(row.id)}">
            <div class="affiliation">${escapeHtml(row.affiliation)}</div>
            <div class="meta">
              ${formatEmissions(row.co2e_kg, { compact: true })} total ·
              ${row.travel_attendees} attendee${row.travel_attendees === 1 ? "" : "s"} ·
              ${formatEmissions(row.co2e_per_speaker_kg, { compact: true })}/person ·
              ${formatDistance(row.distance_km)} from Auckland
            </div>
          </button>`;
        })
        .join("");

      elements.results.querySelectorAll("button[data-id]").forEach((button) => {
        button.addEventListener("click", () => selectLocation(button.dataset.id, { fly: true, toggle: true }));
      });
      return;
    }

    elements.resultsTitle.textContent = "Top countries by emissions";
    elements.results.innerHTML = byCountry
      .slice(0, 30)
      .map((row, index) => {
        const perPerson =
          row.co2e_per_attendee_kg != null
            ? `${formatEmissions(row.co2e_per_attendee_kg, { compact: true })}/person · `
            : "";
        const attendees =
          row.attendee_count != null
            ? `${row.attendee_count} ${personLabel}${row.attendee_count === 1 ? "" : "s"} · `
            : "";
        return `
        <div class="result-item emissions-country-row">
          <div class="affiliation">${index + 1}. ${escapeHtml(countryLabel(row.origin_country))}</div>
          <div class="meta">
            ${formatEmissions(row.co2e_kg, { compact: true })} total ·
            ${attendees}${perPerson}
            ${formatEmissions(row.co2e_low_kg, { compact: true })} – ${formatEmissions(row.co2e_high_kg, { compact: true })}
          </div>
        </div>`;
      })
      .join("");
  }

  function renderAssumptions() {
    const notes = emissionsData.meta.uncertainty?.notes || [];
    elements.assumptions.innerHTML = `
      <p>${escapeHtml(emissionsData.meta.assumptions?.non_nz_transport || "")}</p>
      <p>${escapeHtml(emissionsData.meta.assumptions?.nz_transport || "")}</p>
      ${notes.map((note) => `<p>${escapeHtml(note)}</p>`).join("")}
    `;
  }

  function renderHoverCard(location) {
    if (!location) {
      elements.hoverCard.hidden = true;
      return;
    }
    elements.hoverCard.hidden = false;
    elements.hoverAffiliation.textContent = location.affiliation;
    elements.hoverMeta.textContent = [
      formatEmissions(location.co2e_kg, { compact: true }),
      `${location.travel_attendees} attendee${location.travel_attendees === 1 ? "" : "s"}`,
      `${formatEmissions(location.co2e_per_speaker_kg, { compact: true })}/person`,
      formatDistance(location.distance_km),
    ].join(" · ");

    if (isMobileLayout()) {
      window.requestAnimationFrame(() => {
        elements.hoverCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    }
  }

  function locationFeatures() {
    return allLocations.map((location) => {
      const highlighted = location.co2e_kg > 0;
      const display = displayForLocation(location);
      const radius = radiusFor(location);
      const selected = location.id === selectedId;
      const hovered = location.id === hoveredId;
      return {
        type: "Feature",
        properties: {
          id: location.id,
          affiliation: location.affiliation,
          co2e_kg: location.co2e_kg,
          highlighted: highlighted ? 1 : 0,
          selected: selected ? 1 : 0,
          hovered: hovered ? 1 : 0,
          radius: selected ? radius + 3 : hovered ? radius + 2 : radius,
          color: colorFor(location, highlighted),
          opacity: highlighted ? (selected ? 0.95 : hovered ? 0.9 : 0.82) : 0.2,
        },
        geometry: {
          type: "Point",
          coordinates: [display.lon, display.lat],
        },
      };
    });
  }

  function upsertMapData() {
    if (!mapReady) return;
    map.getSource("locations")?.setData({
      type: "FeatureCollection",
      features: locationFeatures(),
    });
  }

  function flyToLocation(location) {
    if (!mapReady || !location) return;
    const display = displayForLocation(location);
    map.flyTo({
      center: [display.lon, display.lat],
      zoom: Math.max(map.getZoom(), 4),
      essential: true,
    });
  }

  function selectLocation(id, { fly = false, toggle = false } = {}) {
    selectedId = toggle && selectedId === id ? null : id;
    renderHoverCard(locationById(selectedId));
    renderBarChart();
    renderRankings();
    upsertMapData();
    if (fly && selectedId) flyToLocation(locationById(selectedId));
    return selectedId;
  }

  function setRankMode(mode) {
    rankMode = mode;
    renderBarChart();
    renderRankings();
  }

  function setIncludeNonSpeakers(enabled) {
    if (!hasDelegatePool) return;
    includeNonSpeakers = Boolean(enabled);
    applyPool();
    renderSidebar();
    upsertMapData();
    renderHoverCard(null);
  }

  function renderSidebar() {
    renderHeadline();
    renderContext();
    renderModeBreakdown();
    renderLegend();
    renderBarChart();
    renderRankings();
    renderAssumptions();
  }

  map.on("load", () => {
    mapReady = true;
    map.setSky?.({
      "sky-color": "#87CEEB",
      "sky-horizon-blend": 0.6,
      "horizon-color": "#ffffff",
      "horizon-fog-blend": 0.4,
      "fog-color": "#ffffff",
      "fog-ground-blend": 0.3,
    });

    map.addSource("locations", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addSource("auckland", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { label: auckland.label },
            geometry: { type: "Point", coordinates: [auckland.lon, auckland.lat] },
          },
        ],
      },
    });

    map.addLayer({
      id: "auckland-circle",
      type: "circle",
      source: "auckland",
      paint: {
        "circle-radius": 7,
        "circle-color": "#1f6f8b",
        "circle-stroke-width": 2,
        "circle-stroke-color": "#ffffff",
      },
    });

    map.addLayer({
      id: "locations-circle",
      type: "circle",
      source: "locations",
      paint: {
        "circle-radius": ["get", "radius"],
        "circle-color": ["get", "color"],
        "circle-opacity": ["get", "opacity"],
        "circle-stroke-width": [
          "case",
          ["==", ["get", "selected"], 1],
          3,
          ["==", ["get", "hovered"], 1],
          2.5,
          1.5,
        ],
        "circle-stroke-color": "#ffffff",
      },
    });

    upsertMapData();
  });

  map.on("mouseenter", "locations-circle", (event) => {
    map.getCanvas().style.cursor = "pointer";
    const id = event.features?.[0]?.properties?.id;
    if (!id || id === hoveredId) return;
    hoveredId = id;
    renderHoverCard(locationById(id));
    upsertMapData();
  });

  map.on("mouseleave", "locations-circle", () => {
    map.getCanvas().style.cursor = "";
    hoveredId = selectedId;
    renderHoverCard(locationById(hoveredId));
    upsertMapData();
  });

  map.on("click", "locations-circle", (event) => {
    const id = event.features?.[0]?.properties?.id;
    if (id) selectLocation(id, { fly: true, toggle: true });
  });

  map.on("click", (event) => {
    const hit = map.queryRenderedFeatures(event.point, { layers: ["locations-circle"] });
    if (hit.length) return;
    if (!selectedId) return;
    selectedId = null;
    hoveredId = null;
    renderHoverCard(null);
    renderBarChart();
    renderRankings();
    upsertMapData();
  });

  applyPool();
  renderSidebar();

  return {
    setRankMode,
    setIncludeNonSpeakers,
    hasDelegatePool,
    selectLocation,
    renderSidebar,
    resize: () => {
      map.resize();
      try {
        if (isMobileLayout() && map.getProjection()?.type === "globe") {
          map.setProjection(undefined);
        } else if (!isMobileLayout() && map.getProjection()?.type !== "globe") {
          map.setProjection({ type: "globe" });
        }
      } catch {
        /* projection API unavailable */
      }
    },
  };
}
