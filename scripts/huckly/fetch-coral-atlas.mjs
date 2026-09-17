#!/usr/bin/env node
/**
 * huckly fork: one-time download of Allen Coral Atlas benthic habitat for dive
 * areas, written as JSON Lines for the local "Coral Reefs" layer.
 *
 * Source: Allen Coral Atlas GeoServer WFS (coral-atlas:benthic_data_verbose),
 *   © 2018-2023 Allen Coral Atlas Partnership and Arizona State University,
 *   licensed CC BY 4.0 (https://allencoralatlas.org/).
 *
 * The output goes to output/huckly-coral/ (gitignored). The data is NOT
 * committed to the public fork: the site's terms restrict redistribution and
 * automated access, so run this by hand, once, on the host that serves the app.
 *
 *   node scripts/huckly/fetch-coral-atlas.mjs            # all areas
 *   node scripts/huckly/fetch-coral-atlas.mjs kenting    # selected areas
 *
 * Env: CORAL_CLASSES (default "Coral/Algae,Seagrass"),
 *      CORAL_SIMPLIFY_M (default 2, Douglas-Peucker tolerance in metres),
 *      CORAL_MIN_AREA_M2 (default 0, drop smaller patches).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = path.join(ROOT, 'output', 'huckly-coral');
const WFS = 'https://allencoralatlas.org/geoserver/ows';
const LAYER = 'coral-atlas:benthic_data_verbose';
const REQUEST_GAP_MS = 3000;

// [west, south, east, north] in lon/lat (GeoServer reads EPSG:4326 bbox as x,y).
export const AREAS = [
  { id: 'dongbeijiao', name: '東北角', bbox: [121.8, 25.0, 122.02, 25.14] },
  { id: 'keelung-islet', name: '基隆嶼', bbox: [121.7, 25.14, 121.86, 25.25] },
  { id: 'kenting', name: '墾丁', bbox: [120.68, 21.88, 120.9, 22.1] },
  { id: 'green-island', name: '綠島', bbox: [121.46, 22.63, 121.51, 22.69] },
  { id: 'orchid-island', name: '蘭嶼', bbox: [121.48, 21.93, 121.63, 22.1] },
  { id: 'penghu', name: '澎湖', bbox: [119.3, 23.15, 119.75, 23.8] },
  { id: 'xiaoliuqiu', name: '小琉球', bbox: [120.3, 22.28, 120.45, 22.4] },
  { id: 'romblon', name: 'Romblon', bbox: [122.22, 12.52, 122.32, 12.63] },
  { id: 'anilao', name: 'Anilao', bbox: [120.82, 13.6, 121.02, 13.8] },
  { id: 'puerto-galera', name: 'Puerto Galera (Sabang)', bbox: [120.88, 13.47, 121.02, 13.56] },
];

const CLASS_LABELS = {
  'Coral/Algae': '珊瑚/藻類',
  Seagrass: '海草床',
  Rubble: '珊瑚碎屑',
  Rock: '岩礁',
  Sand: '沙地',
  'Microalgal Mats': '微藻墊',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Douglas-Peucker on a lon/lat ring using an equirectangular metre scale. */
export function simplifyRing(ring, toleranceM) {
  if (ring.length <= 4 || toleranceM <= 0) return ring;
  const lat0 = (ring[0][1] * Math.PI) / 180;
  const mx = 111320 * Math.cos(lat0);
  const my = 110540;
  const pts = ring.map(([x, y]) => [x * mx, y * my]);
  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  const tol2 = toleranceM * toleranceM;
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstD2 = tol2;
    for (let i = a + 1; i < b; i += 1) {
      const [px, py] = pts[i];
      let d2;
      if (len2 === 0) {
        d2 = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d2 = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
      }
      if (d2 > worstD2) {
        worst = i;
        worstD2 = d2;
      }
    }
    if (worst !== -1) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : null;
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

function compactMultiPolygon(geometry, toleranceM) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const kept = [];
  for (const polygon of polygons) {
    const [outer, ...holes] = polygon;
    const simpleOuter = simplifyRing(outer, toleranceM);
    if (!simpleOuter) continue;
    const rings = [simpleOuter, ...holes.map((h) => simplifyRing(h, toleranceM)).filter(Boolean)];
    kept.push(rings.map((ring) => ring.map(([x, y]) => [round6(x), round6(y)])));
  }
  if (!kept.length) return null;
  return kept.length === 1
    ? { type: 'Polygon', coordinates: kept[0] }
    : { type: 'MultiPolygon', coordinates: kept };
}

async function fetchArea(area) {
  const url = new URL(WFS);
  url.search = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: LAYER,
    outputFormat: 'application/json',
    bbox: `${area.bbox.join(',')},EPSG:4326`,
  }).toString();
  const res = await fetch(url, {
    headers: { 'User-Agent': 'gods-eye-view-huckly-coral/1.0 (one-time personal download)' },
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`${area.id}: WFS HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const wanted = new Set(process.argv.slice(2));
  const areas = wanted.size ? AREAS.filter((a) => wanted.has(a.id)) : AREAS;
  const classes = new Set(
    (process.env.CORAL_CLASSES || 'Coral/Algae,Seagrass').split(',').map((s) => s.trim()).filter(Boolean),
  );
  const toleranceM = Number(process.env.CORAL_SIMPLIFY_M ?? 2);
  const minAreaM2 = Number(process.env.CORAL_MIN_AREA_M2 ?? 0);

  await mkdir(OUT_DIR, { recursive: true });
  const lines = [];
  const summary = [];
  for (const [index, area] of areas.entries()) {
    if (index) await sleep(REQUEST_GAP_MS);
    const collection = await fetchArea(area);
    const features = collection.features || [];
    let kept = 0;
    for (const [n, feature] of features.entries()) {
      const cls = feature.properties?.class_name;
      const areaM2 = Math.round((feature.properties?.area_sqkm || 0) * 1e6);
      if (!classes.has(cls) || areaM2 < minAreaM2) continue;
      const geometry = compactMultiPolygon(feature.geometry, toleranceM);
      if (!geometry) continue;
      kept += 1;
      lines.push(
        JSON.stringify({
          type: 'Feature',
          id: `coral-${area.id}-${n}`,
          properties: {
            name: `${CLASS_LABELS[cls] || cls} · ${area.name}`,
            class_name: cls,
            area_m2: areaM2,
            site: area.name,
          },
          geometry,
        }),
      );
    }
    summary.push({ id: area.id, name: area.name, downloaded: features.length, kept });
    console.log(`[coral] ${area.name}: downloaded ${features.length}, kept ${kept}`);
  }

  const outFile = path.join(OUT_DIR, 'coral.geojsonl');
  const body = `${lines.join('\n')}\n`;
  await writeFile(outFile, body);
  await writeFile(
    path.join(OUT_DIR, 'SOURCE.json'),
    `${JSON.stringify(
      {
        source: 'Allen Coral Atlas — benthic habitat (WFS coral-atlas:benthic_data_verbose)',
        license: 'CC BY 4.0',
        attribution: '© 2018-2023 Allen Coral Atlas Partnership and Arizona State University',
        url: 'https://allencoralatlas.org/',
        fetchedAt: new Date().toISOString(),
        classes: [...classes],
        simplifyToleranceM: toleranceM,
        minAreaM2,
        areas: summary,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`[coral] wrote ${lines.length} features, ${(body.length / 1e6).toFixed(2)} MB -> ${path.relative(ROOT, outFile)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[coral] failed: ${error.message}`);
    process.exit(1);
  });
}
