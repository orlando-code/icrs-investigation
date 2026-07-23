import {
  buildDisplayPositions,
  escapeHtml,
  formatDistance,
  greatCircleArc,
  locationMatchesQuery,
  matchedSpeakersForLocation,
  speakerMatchesQuery,
} from "./utils.js";

const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const MAX_ZOOM = 10;

function isMobileLayout() {
  return window.matchMedia("(max-width: 900px)").matches;
}

function useCooperativeMapGestures() {
  return window.matchMedia("(max-width: 900px) and (pointer: coarse)").matches;
}

export function createMapView(siteData, elements, { delegateLocations = [] } = {}) {
  const speakerLocations = siteData.locations;
  let includeNonSpeakers = Boolean(delegateLocations.length);
  let locations = includeNonSpeakers
    ? [...speakerLocations, ...delegateLocations]
    : [...speakerLocations];
  const meta = siteData.meta;
  const auckland = meta.auckland;

  let searchQuery = "";
  let matchedIds = new Set(locations.map((location) => location.id));
  let matchedSpeakersByLocation = new Map();
  let selectedId = null;
  let hoveredId = null;
  let distanceMode = false;
  let connectionsSizeMode = false;
  let mapReady = false;
  let maxDistanceKm = Math.max(...locations.map((location) => location.distance_km || 0), 1);
  let maxConnectionCount = Math.max(
    ...locations.map((location) => location.connection_count || 0),
    1
  );
  let displayPositions = buildDisplayPositions(locations);

  function applyLocationPool() {
    locations = includeNonSpeakers
      ? [...speakerLocations, ...delegateLocations]
      : [...speakerLocations];
    maxDistanceKm = Math.max(...locations.map((location) => location.distance_km || 0), 1);
    maxConnectionCount = Math.max(
      ...locations.map((location) => location.connection_count || 0),
      1
    );
    displayPositions = buildDisplayPositions(locations);
    updateMatches(searchQuery);
    if (selectedId && !locationById(selectedId)) {
      selectedId = null;
      hoveredId = null;
      renderHoverCard(null);
    }
    elements.renderResults({
      searchQuery,
      matchedIds,
      selectedId,
      selectLocation,
      locationList: locations,
    });
    if (mapReady) upsertMapData();
  }

  function setIncludeNonSpeakers(enabled) {
    if (!delegateLocations.length) return;
    includeNonSpeakers = Boolean(enabled);
    applyLocationPool();
  }

  const map = new maplibregl.Map({
    container: elements.mapContainer,
    style: MAP_STYLE,
    center: [auckland.lon, auckland.lat],
    zoom: isMobileLayout() ? 1.35 : 1.9,
    minZoom: isMobileLayout() ? 0.9 : 0.5,
    maxZoom: MAX_ZOOM,
    touchPitch: false,
    cooperativeGestures: useCooperativeMapGestures(),
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

  function locationById(id) {
    return locations.find((location) => location.id === id) || null;
  }

  function displayForLocation(location) {
    return displayPositions.get(location.id) || { lat: location.lat, lon: location.lon };
  }

  function radiusForLocation(location, highlighted) {
    let base;
    if (distanceMode) {
      const distance = location.distance_km || 0;
      base = 6 + (distance / maxDistanceKm) * 24;
    } else if (connectionsSizeMode) {
      const count = Math.max(1, location.connection_count || 1);
      const scale = d3
        .scaleLog()
        .domain([1, maxConnectionCount])
        .range([6, 28])
        .clamp(true);
      base = scale(count);
    } else {
      base = Math.min(28, 6 + Math.sqrt(location.speaker_count) * 3.2);
    }
    return highlighted ? base + 2 : base;
  }

  function updateMatches(query) {
    searchQuery = query.trim();
    matchedSpeakersByLocation = new Map();
    if (!searchQuery) {
      matchedIds = new Set(locations.map((location) => location.id));
      return matchedIds;
    }

    matchedIds = new Set();
    for (const location of locations) {
      if (locationMatchesQuery(location, searchQuery)) {
        matchedIds.add(location.id);
        const speakers = matchedSpeakersForLocation(location, searchQuery);
        if (speakers.size) {
          matchedSpeakersByLocation.set(location.id, speakers);
        }
      }
    }
    return matchedIds;
  }

  function renderHoverCard(location) {
    if (!location) {
      elements.hoverCard.hidden = true;
      return;
    }

    elements.hoverCard.hidden = false;
    elements.hoverAffiliation.textContent = location.affiliation;
    if (location.delegate_only) {
      elements.hoverMeta.textContent = [
        `${location.speaker_count} non-speaking delegate${location.speaker_count === 1 ? "" : "s"}`,
        location.geocode_level || null,
        location.distance_km != null ? `${formatDistance(location.distance_km)} from Auckland` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      elements.hoverSpeakers.innerHTML =
        '<li class="status">From published delegate list (no programme talks).</li>';
      if (isMobileLayout()) {
        window.requestAnimationFrame(() => {
          elements.hoverCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
        });
      }
      return;
    }

    elements.hoverMeta.textContent = [
      `${location.speaker_count} speaker${location.speaker_count === 1 ? "" : "s"}`,
      `${location.talk_count} talk${location.talk_count === 1 ? "" : "s"}`,
      `${(location.connection_count || 0).toLocaleString()} talk${location.connection_count === 1 ? "" : "s"} on author lists`,
      `${formatDistance(location.distance_km)} from Auckland`,
      location.geocode_level ? `${location.geocode_level} geocode` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    const highlightedSpeakers = matchedSpeakersByLocation.get(location.id) || new Set();
    const searching = Boolean(searchQuery);
    elements.hoverSpeakers.innerHTML = (location.speaker_details || location.speakers.map((name) => ({ name })))
      .map((speaker) => {
        const name = speaker.name || speaker;
        const isMatch = searching && highlightedSpeakers.has(name);
        return `<li class="${isMatch ? "speaker-match" : ""}">${escapeHtml(name)}</li>`;
      })
      .join("");

    if (isMobileLayout()) {
      window.requestAnimationFrame(() => {
        elements.hoverCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    }
  }

  function locationFeatures() {
    const searching = Boolean(searchQuery);
    return locations.map((location) => {
      const highlighted = !searching || matchedIds.has(location.id);
      const display = displayForLocation(location);
      return {
        type: "Feature",
        properties: {
          id: location.id,
          affiliation: location.affiliation,
          speaker_count: location.speaker_count,
          talk_count: location.talk_count,
          connection_count: location.connection_count || 0,
          distance_km: location.distance_km,
          highlighted: highlighted ? 1 : 0,
          selected: location.id === selectedId ? 1 : 0,
          hovered: location.id === hoveredId ? 1 : 0,
          radius: radiusForLocation(location, highlighted),
        },
        geometry: {
          type: "Point",
          coordinates: [display.lon, display.lat],
        },
      };
    });
  }

  function distanceLineFeatures() {
    const showAll = distanceMode;
    return locations
      .filter((location) => showAll || location.id === selectedId)
      .map((location) => {
        const display = displayForLocation(location);
        return {
          type: "Feature",
          properties: {
            id: location.id,
            affiliation: location.affiliation,
            distance_km: location.distance_km,
            selected: location.id === selectedId ? 1 : 0,
          },
          geometry: {
            type: "LineString",
            coordinates: greatCircleArc(
              display.lat,
              display.lon,
              auckland.lat,
              auckland.lon
            ),
          },
        };
      });
  }

  function aucklandFeature() {
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { label: auckland.label },
          geometry: {
            type: "Point",
            coordinates: [auckland.lon, auckland.lat],
          },
        },
      ],
    };
  }

  function upsertMapData() {
    if (!mapReady) return;
    const showLines = distanceMode || Boolean(selectedId);
    map.getSource("locations")?.setData({
      type: "FeatureCollection",
      features: locationFeatures(),
    });
    map.getSource("distance-lines")?.setData({
      type: "FeatureCollection",
      features: showLines ? distanceLineFeatures() : [],
    });
    map.setLayoutProperty(
      "distance-lines-visible",
      "visibility",
      showLines ? "visible" : "none"
    );
    map.setLayoutProperty(
      "distance-lines-hit",
      "visibility",
      showLines ? "visible" : "none"
    );
    map.setLayoutProperty(
      "auckland-circle",
      "visibility",
      showLines ? "visible" : "none"
    );
  }

  function boundsForIds(ids) {
    const coords = locations
      .filter((location) => ids.has(location.id))
      .map((location) => [location.lon, location.lat]);
    if (!coords.length) return null;
    let minLon = coords[0][0];
    let maxLon = coords[0][0];
    let minLat = coords[0][1];
    let maxLat = coords[0][1];
    for (const [lon, lat] of coords.slice(1)) {
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    }
    return [
      [minLon, minLat],
      [maxLon, maxLat],
    ];
  }

  function flyToLocation(location, minZoom = 4) {
    if (!mapReady || !location) return;
    const display = displayForLocation(location);
    map.flyTo({
      center: [display.lon, display.lat],
      zoom: Math.max(map.getZoom(), minZoom),
      essential: true,
    });
  }

  function selectLocation(id, { fly = true, toggle = false } = {}) {
    selectedId = toggle && selectedId === id ? null : id;
    renderHoverCard(locationById(selectedId));
    elements.renderResults({
      searchQuery,
      matchedIds,
      selectedId,
      selectLocation,
      locationList: locations,
    });
    upsertMapData();
    if (fly && selectedId) flyToLocation(locationById(selectedId));
    return selectedId;
  }

  function applySearch(query, { fly = true } = {}) {
    updateMatches(query);
    const searching = Boolean(searchQuery);
    if (searching) {
      elements.setStatus(
        matchedIds.size
          ? `${matchedIds.size.toLocaleString()} location${matchedIds.size === 1 ? "" : "s"} matched`
          : "No locations matched that search.",
        !matchedIds.size
      );
    } else {
      elements.setStatus("");
    }

    if (selectedId && !matchedIds.has(selectedId)) {
      selectedId = null;
      renderHoverCard(null);
    }

    elements.renderResults({
      searchQuery,
      matchedIds,
      selectedId,
      selectLocation,
      locationList: locations,
    });
    upsertMapData();

    if (fly && searching && matchedIds.size) {
      const bounds = boundsForIds(matchedIds);
      if (bounds) {
        map.fitBounds(bounds, { padding: 80, maxZoom: 5.5, duration: 900 });
      }
    }
  }

  function buildSuggestions(query) {
    const trimmed = query.trim().toLowerCase();
    if (trimmed.length < 2) return [];

    const speakerHits = new Map();
    const affiliationHits = new Map();

    for (const location of locations) {
      if (location.affiliation.toLowerCase().includes(trimmed) && !affiliationHits.has(location.id)) {
        affiliationHits.set(location.id, {
          label: location.affiliation,
          detail: `${location.speaker_count} speakers`,
          query: location.affiliation,
          locationId: location.id,
        });
      }
      for (const speaker of location.speaker_details || []) {
        if (speakerMatchesQuery(speaker, trimmed) && !speakerHits.has(speaker.name)) {
          speakerHits.set(speaker.name, {
            label: speaker.name,
            detail: location.affiliation,
            query: speaker.name,
            locationId: location.id,
          });
        }
      }
    }

    return [...speakerHits.values(), ...affiliationHits.values()].slice(0, 8);
  }

  function renderLegend() {
    if (!elements.legend) return;

    if (distanceMode) {
      const distances = locations.map((location) => location.distance_km || 0);
      const minDistance = Math.max(0, d3.min(distances) || 0);
      const maxDistance = Math.max(minDistance + 1, d3.max(distances) || 1);
      const midDistance = Math.round((minDistance + maxDistance) / 2);
      const scale = d3.scaleLinear().domain([minDistance, maxDistance]).range([8, 32]).clamp(true);
      const samples = [
        { label: formatDistance(minDistance), size: scale(minDistance) },
        { label: formatDistance(midDistance), size: scale(midDistance) },
        { label: formatDistance(maxDistance), size: scale(maxDistance) },
      ];
      elements.legend.innerHTML = `
        <h3>Point size · distance from Auckland</h3>
        <p>Toggle on: circles and great-circle arcs show shortest-path distance to Auckland (not the actual flight paths). The emissions data is based on the actual flight routes.</p>
        ${samples
          .map(
            (sample) => `
          <div class="legend-row">
            <span class="legend-dot" style="width:${sample.size}px;height:${sample.size}px"></span>
            <span>${sample.label}</span>
          </div>`
          )
          .join("")}
      `;
      return;
    }

    if (connectionsSizeMode) {
      const counts = locations.map((location) => Math.max(1, location.connection_count || 1));
      const minCount = Math.max(1, d3.min(counts));
      const maxCount = Math.max(minCount + 1, d3.max(counts));
      const midCount = Math.round(Math.sqrt(minCount * maxCount));
      const scale = d3
        .scaleLog()
        .domain([minCount, maxCount])
        .range([8, 28])
        .clamp(true);
      const samples = [
        { label: `${minCount.toLocaleString()} talks`, size: scale(minCount) },
        { label: `${midCount.toLocaleString()} talks`, size: scale(midCount) },
        { label: `${maxCount.toLocaleString()} talks`, size: scale(maxCount) },
      ];
      elements.legend.innerHTML = `
        <h3>Point size · talks on author lists (log scale)</h3>
        <p>Circle area scales with talks where this affiliation appears on the author list.</p>
        ${samples
          .map(
            (sample) => `
          <div class="legend-row">
            <span class="legend-dot" style="width:${sample.size}px;height:${sample.size}px"></span>
            <span>${sample.label}</span>
          </div>`
          )
          .join("")}
        <p class="legend-note">Click a point to highlight its great-circle connection to Auckland.</p>
      `;
      return;
    }

    const counts = locations.map((location) => Math.max(1, location.speaker_count));
    const minCount = Math.max(1, d3.min(counts));
    const maxCount = Math.max(minCount + 1, d3.max(counts));
    const midCount = Math.round(Math.sqrt(minCount * maxCount));
    const scale = d3
      .scaleLog()
      .domain([minCount, maxCount])
      .range([8, 28])
      .clamp(true);
    const samples = [
      { label: `${minCount} speakers`, size: scale(minCount) },
      { label: `${midCount} speakers`, size: scale(midCount) },
      { label: `${maxCount} speakers`, size: scale(maxCount) },
    ];
    elements.legend.innerHTML = `
      <h3>Point size · speakers (log scale)</h3>
      <p>Default view sizes each affiliation by speaker count at that location.</p>
      ${samples
        .map(
          (sample) => `
        <div class="legend-row">
          <span class="legend-dot" style="width:${sample.size}px;height:${sample.size}px"></span>
          <span>${sample.label}</span>
        </div>`
        )
        .join("")}
      <p class="legend-note">Click a point to highlight its great-circle connection to Auckland.</p>
    `;
  }

  function setDistanceMode(enabled) {
    distanceMode = enabled;
    if (enabled) connectionsSizeMode = false;
    upsertMapData();
    renderLegend();
    return connectionsSizeMode;
  }

  function setConnectionsSize(enabled) {
    connectionsSizeMode = enabled && !distanceMode;
    upsertMapData();
    renderLegend();
    return connectionsSizeMode;
  }

  function showLineTooltip(text, point) {
    elements.lineTooltip.textContent = text;
    elements.lineTooltip.hidden = false;
    elements.lineTooltip.style.left = `${point.x + 12}px`;
    elements.lineTooltip.style.top = `${point.y + 12}px`;
  }

  function hideLineTooltip() {
    elements.lineTooltip.hidden = true;
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
    map.addSource("distance-lines", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addSource("auckland", {
      type: "geojson",
      data: aucklandFeature(),
    });

    map.addLayer({
      id: "distance-lines-visible",
      type: "line",
      source: "distance-lines",
      layout: { visibility: "none" },
      paint: {
        "line-color": "#1f6f8b",
        "line-opacity": [
          "case",
          ["==", ["get", "selected"], 1],
          0.92,
          0.14,
        ],
        "line-width": [
          "case",
          ["==", ["get", "selected"], 1],
          3,
          1.2,
        ],
      },
    });
    map.addLayer({
      id: "distance-lines-hit",
      type: "line",
      source: "distance-lines",
      layout: { visibility: "none" },
      paint: {
        "line-color": "#000000",
        "line-opacity": 0.01,
        "line-width": 10,
      },
    });
    map.addLayer({
      id: "auckland-circle",
      type: "circle",
      source: "auckland",
      layout: { visibility: "none" },
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
        "circle-radius": [
          "case",
          ["==", ["get", "selected"], 1],
          ["+", ["get", "radius"], 4],
          ["==", ["get", "hovered"], 1],
          ["+", ["get", "radius"], 2],
          ["get", "radius"],
        ],
        "circle-color": [
          "case",
          ["==", ["get", "selected"], 1],
          "#1f6f8b",
          ["==", ["get", "highlighted"], 1],
          "#d95f02",
          "#9aa5ad",
        ],
        "circle-opacity": [
          "case",
          ["==", ["get", "selected"], 1],
          0.95,
          ["==", ["get", "hovered"], 1],
          0.92,
          ["==", ["get", "highlighted"], 1],
          0.78,
          0.16,
        ],
        "circle-stroke-width": [
          "case",
          ["==", ["get", "selected"], 1],
          3,
          ["==", ["get", "hovered"], 1],
          2.5,
          ["==", ["get", "highlighted"], 1],
          1.5,
          0.5,
        ],
        "circle-stroke-color": "#ffffff",
      },
    });

    map.easeTo({
      center: [auckland.lon, auckland.lat],
      zoom: 1.9,
      duration: 0,
    });
    upsertMapData();
    renderLegend();
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
    if (!selectedId) {
      hoveredId = null;
      renderHoverCard(null);
      upsertMapData();
      return;
    }
    hoveredId = selectedId;
    renderHoverCard(locationById(selectedId));
    upsertMapData();
  });

  map.on("click", "locations-circle", (event) => {
    const id = event.features?.[0]?.properties?.id;
    if (id) selectLocation(id, { toggle: true });
  });

  map.on("click", (event) => {
    const hitLocation = map.queryRenderedFeatures(event.point, { layers: ["locations-circle"] });
    if (hitLocation.length) return;
    if (!selectedId) return;
    selectedId = null;
    hoveredId = null;
    renderHoverCard(null);
    elements.renderResults({
      searchQuery,
      matchedIds,
      selectedId,
      selectLocation,
      locationList: locations,
    });
    upsertMapData();
  });

  map.on("mouseenter", "distance-lines-hit", (event) => {
    map.getCanvas().style.cursor = "help";
    const props = event.features?.[0]?.properties;
    if (!props) return;
    showLineTooltip(
      `${props.affiliation}: ${formatDistance(Number(props.distance_km))} from Auckland`,
      event.point
    );
  });

  map.on("mousemove", "distance-lines-hit", (event) => {
    const props = event.features?.[0]?.properties;
    if (!props) return;
    showLineTooltip(
      `${props.affiliation}: ${formatDistance(Number(props.distance_km))} from Auckland`,
      event.point
    );
  });

  map.on("mouseleave", "distance-lines-hit", () => {
    map.getCanvas().style.cursor = "";
    hideLineTooltip();
  });

  return {
    applySearch,
    buildSuggestions,
    selectLocation,
    setDistanceMode,
    setConnectionsSize,
    setIncludeNonSpeakers,
    hasDelegatePool: delegateLocations.length > 0,
    getLocations: () => locations,
    getMatchedIds: () => matchedIds,
    resize: () => map.resize(),
  };
}
