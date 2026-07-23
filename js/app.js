import { SITE_DATA } from "./locations.js";
import { EMISSIONS_DATA } from "./emissions-data.js";
import { createMapView } from "./map.js";
import { createNetworkView } from "./network.js";
import { createEmissionsView } from "./emissions-view.js";
import { createShareView } from "./share.js";
import { escapeHtml, formatDistance } from "./utils.js";

const locations = SITE_DATA.locations;
const meta = SITE_DATA.meta;

const $ = (id) => document.getElementById(id);
const els = {
  title: $("site-title"),
  summary: $("site-summary"),
  query: $("search-query"),
  suggestions: $("search-suggestions"),
  status: $("search-status"),
  form: $("search-form"),
  clear: $("btn-clear-search"),
  stats: $("stats-card"),
  mapLegend: $("map-legend"),
  resultsTitle: $("results-title"),
  results: $("results-list"),
  hoverCard: $("hover-card"),
  hoverAffiliation: $("hover-affiliation"),
  hoverMeta: $("hover-meta"),
  hoverSpeakers: $("hover-speakers"),
  distanceToggle: $("distance-toggle"),
  connectionsSizeToggle: $("connections-size-toggle"),
  mapPanel: $("map-panel"),
  networkPanel: $("network-panel"),
  emissionsPanel: $("emissions-panel"),
  sharePanel: $("share-panel"),
  mapStage: $("map-stage"),
  networkStage: $("network-stage"),
  emissionsStage: $("emissions-stage"),
  shareStage: $("share-stage"),
  mapContainer: $("map"),
  networkSvg: $("network-svg"),
  lineTooltip: $("line-tooltip"),
  networkSummary: $("network-summary"),
  networkCard: $("network-card"),
  networkCardTitle: $("network-card-title"),
  networkCardMeta: $("network-card-meta"),
  resetZoom: $("network-reset-zoom"),
  clearSelection: $("network-clear-selection"),
  clearSelectionMobile: $("network-clear-selection-mobile"),
  selectionBadge: $("network-selection-badge"),
  selectionLabel: $("network-selection-label"),
  networkSearch: $("network-search-query"),
  networkSuggestions: $("network-suggestions"),
  networkSearchStatus: $("network-search-status"),
  networkSearchBtn: $("network-search-btn"),
  networkClearSearch: $("network-clear-search"),
  networkLegend: $("network-legend"),
  networkBarChart: $("network-bar-chart"),
  networkResults: $("network-results"),
  networkResultsTitle: $("network-results-title"),
  shareQr: $("share-qr"),
  shareUrl: $("share-url"),
  shareUrlInput: $("share-url-input"),
  sharePushBtn: $("share-push-btn"),
  shareCopyBtn: $("share-copy-btn"),
  shareStatus: $("share-status"),
  emissionsHeadline: $("emissions-headline"),
  emissionsModeBreakdown: $("emissions-mode-breakdown"),
  emissionsLegend: $("emissions-legend"),
  emissionsBarChart: $("emissions-bar-chart"),
  emissionsResults: $("emissions-results"),
  emissionsResultsTitle: $("emissions-results-title"),
  emissionsAssumptions: $("emissions-assumptions"),
  emissionsMap: $("emissions-map"),
  emissionsHoverCard: $("emissions-hover-card"),
  emissionsHoverAffiliation: $("emissions-hover-affiliation"),
  emissionsHoverMeta: $("emissions-hover-meta"),
  tabButtons: [...document.querySelectorAll("[data-tab]")],
  networkModeButtons: [...document.querySelectorAll("[data-network-mode]")],
  emissionsModeButtons: [...document.querySelectorAll("[data-emissions-mode]")],
};

function renderStats() {
  const stats = meta.stats;
  els.title.textContent = meta.title;
  els.stats.innerHTML = [
    `<strong>${stats.location_count.toLocaleString()}</strong> affiliation locations on the map`,
    `<strong>${stats.mapped_speakers.toLocaleString()}</strong> / ${stats.total_speakers.toLocaleString()} speakers geocoded`,
    `<strong>${stats.mapped_talks.toLocaleString()}</strong> / ${stats.total_talks.toLocaleString()} talks geocoded`,
  ].join("<br>");
}

function renderResults({ searchQuery, matchedIds, selectedId, selectLocation }) {
  const searching = Boolean(searchQuery);
  const ordered = [...locations].sort((a, b) => {
    const aMatch = matchedIds.has(a.id) ? 0 : 1;
    const bMatch = matchedIds.has(b.id) ? 0 : 1;
    if (aMatch !== bMatch) return aMatch - bMatch;
    if (b.speaker_count !== a.speaker_count) return b.speaker_count - a.speaker_count;
    return a.affiliation.localeCompare(b.affiliation, undefined, { sensitivity: "base" });
  });

  const visible = searching ? ordered.filter((location) => matchedIds.has(location.id)) : ordered;
  els.resultsTitle.textContent = searching
    ? `${visible.length.toLocaleString()} matching location${visible.length === 1 ? "" : "s"}`
    : "All locations";

  els.results.innerHTML = "";
  if (!visible.length) {
    els.results.innerHTML = `<p class="status">No locations match that search.</p>`;
    return;
  }

  for (const location of visible.slice(0, 200)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "result-item";
    btn.dataset.id = location.id;
    btn.classList.toggle("selected", location.id === selectedId);
    btn.classList.toggle("dimmed", searching && !matchedIds.has(location.id));
    btn.innerHTML = `
      <div class="affiliation">${escapeHtml(location.affiliation)}</div>
      <div class="meta">${location.speaker_count} speaker${location.speaker_count === 1 ? "" : "s"} · ${location.talk_count} talk${location.talk_count === 1 ? "" : "s"} · ${(location.connection_count || 0).toLocaleString()} connections · ${formatDistance(location.distance_km)} from Auckland</div>
    `;
    btn.addEventListener("click", () => selectLocation(location.id));
    els.results.appendChild(btn);
  }

  if (visible.length > 200) {
    const note = document.createElement("p");
    note.className = "status";
    note.textContent = `Showing first 200 of ${visible.length.toLocaleString()} matches. Refine your search to narrow further.`;
    els.results.appendChild(note);
  }
}

function setStatus(message, isError = false) {
  els.status.textContent = message || "";
  els.status.classList.toggle("error", isError);
}

const mapView = createMapView(SITE_DATA, {
  mapContainer: els.mapContainer,
  hoverCard: els.hoverCard,
  hoverAffiliation: els.hoverAffiliation,
  hoverMeta: els.hoverMeta,
  hoverSpeakers: els.hoverSpeakers,
  lineTooltip: els.lineTooltip,
  legend: els.mapLegend,
  setStatus,
  renderResults,
});

const networkView = createNetworkView(SITE_DATA, {
  stage: els.networkStage,
  networkSvg: els.networkSvg,
  summary: els.networkSummary,
  card: els.networkCard,
  cardTitle: els.networkCardTitle,
  cardMeta: els.networkCardMeta,
  resetZoom: els.resetZoom,
  clearSelection: els.clearSelection,
  clearSelectionMobile: els.clearSelectionMobile,
  selectionBadge: els.selectionBadge,
  selectionLabel: els.selectionLabel,
  legend: els.networkLegend,
  barChart: els.networkBarChart,
  results: els.networkResults,
  resultsTitle: els.networkResultsTitle,
  searchInput: els.networkSearch,
  searchStatus: els.networkSearchStatus,
});

const shareView = createShareView(SITE_DATA, {
  qrCanvas: els.shareQr,
  url: els.shareUrl,
  urlInput: els.shareUrlInput,
  pushBtn: els.sharePushBtn,
  copyBtn: els.shareCopyBtn,
  status: els.shareStatus,
});

const emissionsView = createEmissionsView(EMISSIONS_DATA, SITE_DATA, {
  mapContainer: els.emissionsMap,
  headline: els.emissionsHeadline,
  modeBreakdown: els.emissionsModeBreakdown,
  legend: els.emissionsLegend,
  barChart: els.emissionsBarChart,
  results: els.emissionsResults,
  resultsTitle: els.emissionsResultsTitle,
  assumptions: els.emissionsAssumptions,
  hoverCard: els.emissionsHoverCard,
  hoverAffiliation: els.emissionsHoverAffiliation,
  hoverMeta: els.emissionsHoverMeta,
});

let activeTab = "map";

function setTab(tab) {
  activeTab = tab;
  els.tabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  els.mapPanel.hidden = tab !== "map";
  els.networkPanel.hidden = tab !== "network";
  els.emissionsPanel.hidden = tab !== "emissions";
  els.sharePanel.hidden = tab !== "share";
  els.mapStage.hidden = tab !== "map";
  els.networkStage.hidden = tab !== "network";
  els.emissionsStage.hidden = tab !== "emissions";
  els.shareStage.hidden = tab !== "share";
  if (tab === "map") {
    mapView.resize();
  } else if (tab === "network") {
    networkView.resize();
  } else if (tab === "emissions") {
    emissionsView.resize();
  } else if (tab === "share") {
    shareView.render();
  }
}

els.tabButtons.forEach((button) => {
  button.addEventListener("click", () => setTab(button.dataset.tab));
});

els.networkModeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    els.networkModeButtons.forEach((item) => {
      item.classList.toggle("active", item === button);
    });
    networkView.setMode(button.dataset.networkMode);
  });
});

els.emissionsModeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    els.emissionsModeButtons.forEach((item) => {
      item.classList.toggle("active", item === button);
    });
    emissionsView.setRankMode(button.dataset.emissionsMode);
  });
});

els.distanceToggle.addEventListener("change", (event) => {
  if (event.target.checked) {
    els.connectionsSizeToggle.checked = false;
    mapView.setConnectionsSize(false);
  }
  mapView.setDistanceMode(event.target.checked);
});

els.connectionsSizeToggle.addEventListener("change", (event) => {
  if (event.target.checked) {
    els.distanceToggle.checked = false;
    mapView.setDistanceMode(false);
  }
  const enabled = mapView.setConnectionsSize(event.target.checked);
  els.connectionsSizeToggle.checked = enabled;
});

let suggestionTimer = null;
els.query.addEventListener("input", () => {
  clearTimeout(suggestionTimer);
  const query = els.query.value;
  suggestionTimer = setTimeout(() => {
    renderSuggestions(mapView.buildSuggestions(query));
    mapView.applySearch(query, { fly: false });
  }, 180);
});

function renderSuggestions(items) {
  els.suggestions.innerHTML = "";
  if (!items.length) {
    els.suggestions.classList.remove("open");
    return;
  }

  items.forEach((item, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "suggestion" + (index === 0 ? " active" : "");
    btn.innerHTML = `${escapeHtml(item.label)}<small>${escapeHtml(item.detail)}</small>`;
    btn.addEventListener("mousedown", (event) => {
      event.preventDefault();
      els.query.value = item.query;
      mapView.applySearch(item.query);
      mapView.selectLocation(item.locationId);
      els.suggestions.classList.remove("open");
    });
    els.suggestions.appendChild(btn);
  });
  els.suggestions.classList.add("open");
}

document.addEventListener("click", (event) => {
  if (!els.suggestions.contains(event.target) && event.target !== els.query) {
    els.suggestions.classList.remove("open");
  }
});

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  mapView.applySearch(els.query.value);
});

els.clear.addEventListener("click", () => {
  els.query.value = "";
  mapView.applySearch("");
  els.suggestions.classList.remove("open");
});

let networkSuggestionTimer = null;
els.networkSearch?.addEventListener("input", () => {
  clearTimeout(networkSuggestionTimer);
  const query = els.networkSearch.value;
  networkSuggestionTimer = setTimeout(() => {
    renderNetworkSuggestions(networkView.buildSuggestions(query));
    networkView.applySearch(query, { focus: false });
  }, 180);
});

els.networkSearchBtn?.addEventListener("click", () => {
  networkView.applySearch(els.networkSearch.value);
});

els.networkClearSearch?.addEventListener("click", () => {
  els.networkSearch.value = "";
  networkView.applySearch("");
  els.networkSuggestions?.classList.remove("open");
});

function renderNetworkSuggestions(items) {
  if (!els.networkSuggestions) return;
  els.networkSuggestions.innerHTML = "";
  if (!items.length) {
    els.networkSuggestions.classList.remove("open");
    return;
  }

  items.forEach((item, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "suggestion" + (index === 0 ? " active" : "");
    btn.innerHTML = `${escapeHtml(item.label)}<small>${escapeHtml(item.detail)}</small>`;
    btn.addEventListener("mousedown", (event) => {
      event.preventDefault();
      els.networkSearch.value = item.query;
      networkView.applySearch(item.query);
      networkView.selectNode(item.nodeId, { focus: true });
      els.networkSuggestions.classList.remove("open");
    });
    els.networkSuggestions.appendChild(btn);
  });
  els.networkSuggestions.classList.add("open");
}

document.addEventListener("click", (event) => {
  if (
    els.networkSuggestions &&
    !els.networkSuggestions.contains(event.target) &&
    event.target !== els.networkSearch
  ) {
    els.networkSuggestions.classList.remove("open");
  }
});

window.addEventListener("resize", () => {
  if (activeTab === "map") mapView.resize();
  else if (activeTab === "network") networkView.resize();
  else if (activeTab === "emissions") emissionsView.resize();
});

renderStats();
renderResults({
  searchQuery: "",
  matchedIds: mapView.getMatchedIds(),
  selectedId: null,
  selectLocation: mapView.selectLocation,
});
mapView.applySearch("", { fly: false });
setTab("map");
