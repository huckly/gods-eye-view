/**
 * huckly fork: keyless location search fallback.
 *
 * Upstream searchAndFlyTo() requires GOOGLE_MAPS_API_KEY and throws without it,
 * so the location bar shows "Search failed". When no key is configured this
 * resolves the query with OpenStreetMap Nominatim instead and flies there,
 * returning the same shape as upstream: { label, navigationMode, rangeM },
 * CANCELLED_SEARCH, or null when nothing matched.
 *
 * Nominatim usage policy: <= 1 request/second, identify the app (browsers send
 * Referer automatically), show "(c) OpenStreetMap contributors" attribution.
 */
import { flyToLandmark, CANCELLED_SEARCH } from '../locations.js';

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const MIN_INTERVAL_MS = 1100;
const MIN_RANGE_M = 600;
const MAX_RANGE_M = 2_500_000;
const AREA_RANGE_M = 20_000;

let lastRequestAt = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function finitePositive(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

/** Approximate the bounding box diagonal in metres. */
function bboxDiagonalM([south, north, west, east]) {
  const R = 6_371_000;
  const toRad = Math.PI / 180;
  const dLat = (north - south) * toRad;
  const dLon = (east - west) * toRad * Math.cos(((north + south) / 2) * toRad);
  return R * Math.hypot(dLat, dLon);
}

function rangeForHit(hit) {
  const bbox = (hit.boundingbox || []).map(Number);
  if (bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) return 1500;
  return Math.min(MAX_RANGE_M, Math.max(MIN_RANGE_M, bboxDiagonalM(bbox) * 1.6));
}

function acceptLanguage() {
  const lang = window.hucklyI18n?.lang;
  return lang && lang !== 'en' ? `${lang},en` : 'en';
}

export async function keylessSearchAndFlyTo(viewer, query, options = {}) {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();

  const url = `${ENDPOINT}?format=jsonv2&limit=1&accept-language=${encodeURIComponent(acceptLanguage())}`
    + `&q=${encodeURIComponent(query)}`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Nominatim HTTP ${response.status}`);
  const [hit] = await response.json();
  if (!hit) return null;

  const lat = Number(hit.lat);
  const lon = Number(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const range = finitePositive(options.range) || rangeForHit(hit);
  const isArea = range > AREA_RANGE_M;

  if (typeof options.beforeFly === 'function' && options.beforeFly() === false) {
    return CANCELLED_SEARCH;
  }
  const flight = flyToLandmark(viewer, lat, lon, {
    range,
    pitch: isArea ? -55 : -30,
    heading: isArea ? 0 : 30,
    buildingHeight: isArea ? 0 : 30,
    duration: finitePositive(options.duration) || 3.0,
    onStart: options.onStart,
    onComplete: options.onComplete,
    onCancel: options.onCancel,
  });

  return {
    label: hit.name || hit.display_name || query,
    navigationMode: finitePositive(options.range) ? 'explicit-range' : (isArea ? 'area-overview' : 'precise-place'),
    rangeM: Math.round(flight?.range ?? range),
  };
}
