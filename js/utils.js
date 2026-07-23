export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const EARTH_RADIUS_KM = 6371;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

/** East-west separation in degrees along the shorter arc. */
export function shortestLonDelta(lon1, lon2) {
  let delta = lon2 - lon1;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return delta;
}

/** Great-circle distance on a sphere (shortest path). */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(shortestLonDelta(lon1, lon2));
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function unwrapLongitudes(coords) {
  const out = [[coords[0][0], coords[0][1]]];
  for (let i = 1; i < coords.length; i += 1) {
    let [lon, lat] = coords[i];
    const prevLon = out[i - 1][0];
    while (lon - prevLon > 180) lon -= 360;
    while (lon - prevLon < -180) lon += 360;
    out.push([lon, lat]);
  }
  return out;
}

/** GeoJSON [lon, lat] coordinates along the shorter great-circle arc. */
export function greatCircleArc(lat1, lon1, lat2, lon2, numPoints = 64) {
  const dLon = shortestLonDelta(lon1, lon2);
  const lambda1 = toRad(lon1);
  const phi1 = toRad(lat1);
  const lambda2 = toRad(lon1 + dLon);
  const phi2 = toRad(lat2);

  const sinHalfSigma = Math.sqrt(
    Math.sin((phi2 - phi1) / 2) ** 2 +
      Math.cos(phi1) * Math.cos(phi2) * Math.sin((lambda2 - lambda1) / 2) ** 2
  );
  const sigma = 2 * Math.asin(Math.min(1, sinHalfSigma));

  if (sigma === 0) {
    return [
      [lon1, lat1],
      [lon2, lat2],
    ];
  }

  const sinSigmaInv = 1 / Math.sin(sigma);
  const x1 = Math.cos(phi1) * Math.cos(lambda1);
  const y1 = Math.cos(phi1) * Math.sin(lambda1);
  const z1 = Math.sin(phi1);
  const x2 = Math.cos(phi2) * Math.cos(lambda2);
  const y2 = Math.cos(phi2) * Math.sin(lambda2);
  const z2 = Math.sin(phi2);

  const coords = [];
  for (let i = 0; i <= numPoints; i += 1) {
    const t = i / numPoints;
    const a = Math.sin((1 - t) * sigma) * sinSigmaInv;
    const b = Math.sin(t * sigma) * sinSigmaInv;
    const x = a * x1 + b * x2;
    const y = a * y1 + b * y2;
    const z = a * z1 + b * z2;
    coords.push([toDeg(Math.atan2(y, x)), toDeg(Math.atan2(z, Math.sqrt(x * x + y * y)))]);
  }

  return unwrapLongitudes(coords);
}

export function formatDistance(km) {
  if (km == null || Number.isNaN(km)) return "—";
  if (km < 1) return `${Math.round(km * 1000).toLocaleString()} m`;
  return `${Math.round(km).toLocaleString()} km`;
}

export function formatEmissions(kg, { compact = false } = {}) {
  if (kg == null || Number.isNaN(kg)) return "—";
  const value = Number(kg);
  if (value === 0) return "0 kg";
  if (compact) {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M kg`;
    if (value >= 10_000) return `${(value / 1000).toFixed(0)} t`;
    if (value >= 1000) return `${(value / 1000).toFixed(1)} t`;
  }
  if (value >= 1000) {
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 0 })} kg`;
  }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg`;
}

export function formatTonnes(kg) {
  if (kg == null || Number.isNaN(kg)) return "—";
  return `${(Number(kg) / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} t CO₂e`;
}

export function speakerMatchesQuery(speaker, query) {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return false;
  if (speaker.name.toLowerCase().includes(trimmed)) return true;
  return speaker.search_text.includes(trimmed);
}

export function matchedSpeakersForLocation(location, query) {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return new Set();
  const matched = new Set();
  for (const speaker of location.speaker_details || []) {
    if (speakerMatchesQuery(speaker, trimmed)) {
      matched.add(speaker.name);
    }
  }
  return matched;
}

export function locationMatchesQuery(location, query) {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  if (location.affiliation.toLowerCase().includes(trimmed)) return true;
  if (location.search_text.includes(trimmed)) return true;
  return matchedSpeakersForLocation(location, query).size > 0;
}

/** Spread coincident affiliation points so each remains clickable. */
export function buildDisplayPositions(locations, { precision = 5, ringRadius = 0.055 } = {}) {
  const keyFor = (location) =>
    `${location.lat.toFixed(precision)}:${location.lon.toFixed(precision)}`;
  const groups = new Map();

  for (const location of locations) {
    const key = keyFor(location);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(location);
  }

  const display = new Map();
  for (const group of groups.values()) {
    if (group.length === 1) {
      const [location] = group;
      display.set(location.id, { lat: location.lat, lon: location.lon });
      continue;
    }

    group.sort((a, b) => a.affiliation.localeCompare(b.affiliation, undefined, { sensitivity: "base" }));
    const baseLat = group[0].lat;
    const baseLon = group[0].lon;
    const latRad = toRad(baseLat);
    const radius = ringRadius + Math.min(group.length, 10) * 0.008;

    group.forEach((location, index) => {
      const angle = (2 * Math.PI * index) / group.length - Math.PI / 2;
      const dLat = radius * Math.cos(angle);
      const dLon = (radius * Math.sin(angle)) / Math.max(Math.cos(latRad), 0.25);
      display.set(location.id, {
        lat: baseLat + dLat,
        lon: baseLon + dLon,
      });
    });
  }

  return display;
}
