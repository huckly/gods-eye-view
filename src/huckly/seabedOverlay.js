import * as Cesium from 'cesium';
import { registerDynamicCredit } from '../data/dataCredits.js';
import { ensureGeoidReady, geoidHeight } from '../data/geoid.js';
import { createHucklyChip, readToggle, rememberToggle } from './chip.js';

/**
 * huckly fork: 3D seabed from Allen Coral Atlas 10 m satellite-derived
 * bathymetry (0 to ~25 m), for dive areas downloaded by hand.
 *
 * Each area becomes an opaque height-field mesh placed below local mean sea
 * level (EGM96 geoid). Every triangle is coloured by depth (1 m steps) and
 * shaded by its slope against a light from the north-west, so reef edges,
 * channels and drop-offs read like a shaded-relief chart. Depth testing is off
 * so the seabed shows through Google Photorealistic 3D Tiles' opaque water
 * surface; the data only exists under water, so it never paints over land.
 * Relief is exaggerated (default 6x, ?seabedx=1..10).
 *
 * Data: output/huckly-bathy/web/ (gitignored), produced from the Atlas
 * download ZIPs by scripts/huckly/prepare-bathymetry.py.
 * Toggle: "海底" chip, or ?seabed=1 / ?seabed=0.
 */
const BASE_URL = '/output/huckly-bathy/web/';
const STORAGE_KEY = 'huckly:seabed';
const BAND_M = 1;
const SHADE_LEVELS = 6;
// Shallow reef flats are gentle; 6x makes 1-2 m relief readable from ~1 km.
const DEFAULT_EXAGGERATION = 6;
// Light from the north-west, 45 degrees up (local east/north/up axes).
const LIGHT = normalize([-0.5, 0.5, Math.SQRT1_2]);
const CREDIT = {
  html:
    'Seabed: <a href="https://allencoralatlas.org/" target="_blank" rel="noopener">' +
    '© 2018-2023 Allen Coral Atlas Partnership and Arizona State University</a> (CC BY 4.0), ' +
    'satellite-derived bathymetry',
};
// Shallow → deep colour ramp (metres). Exported for the legend.
export const SEABED_RAMP = [
  [0, [184, 245, 255]],
  [4, [111, 227, 240]],
  [8, [47, 181, 217]],
  [12, [31, 127, 199]],
  [16, [42, 79, 174]],
  [20, [43, 47, 143]],
  [26, [28, 26, 94]],
];

function normalize([x, y, z]) {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

function readExaggeration() {
  try {
    const value = Number(new URLSearchParams(window.location.search).get('seabedx'));
    return Number.isFinite(value) && value >= 1 && value <= 10 ? value : DEFAULT_EXAGGERATION;
  } catch {
    return DEFAULT_EXAGGERATION;
  }
}

export function rampRgb(depthM) {
  for (let i = 1; i < SEABED_RAMP.length; i += 1) {
    const [d1, c1] = SEABED_RAMP[i];
    const [d0, c0] = SEABED_RAMP[i - 1];
    if (depthM <= d1 || i === SEABED_RAMP.length - 1) {
      const t = Math.min(1, Math.max(0, (depthM - d0) / (d1 - d0)));
      return c0.map((v, k) => Math.round(v + (c1[k] - v) * t));
    }
  }
  return [255, 255, 255];
}

function shadedColor(band, shadeLevel) {
  // Brightness 0.5 (facing away from the light) .. 1.15 (facing it).
  const factor = 0.5 + (0.65 * shadeLevel) / (SHADE_LEVELS - 1);
  const [r, g, b] = rampRgb((band + 0.5) * BAND_M).map((v) => Math.min(255, Math.round(v * factor)));
  return Cesium.Color.fromBytes(r, g, b, 255);
}

/**
 * Build one GeometryInstance per (depth band x shade level) for an area grid.
 * Colours are baked per triangle, so the appearance needs no scene lighting.
 */
export function buildSeabedInstances(meta, depthCm, seaLevelM, exaggeration) {
  const { rows, cols, west, north, dLon, dLat } = meta;
  const latMid = north - (rows * dLat) / 2;
  const dxM = dLon * 111320 * Math.cos((latMid * Math.PI) / 180);
  const dyM = dLat * 110540;
  const vertexOf = new Int32Array(rows * cols).fill(-1);
  const positions = [];
  const depths = [];
  const local = []; // x east, y north, z up (metres, exaggerated)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const cm = depthCm[r * cols + c];
      if (cm <= 0) continue;
      const depthM = cm / 100;
      const p = Cesium.Cartesian3.fromDegrees(
        west + (c + 0.5) * dLon,
        north - (r + 0.5) * dLat,
        seaLevelM - depthM * exaggeration,
      );
      vertexOf[r * cols + c] = depths.length;
      positions.push(p.x, p.y, p.z);
      depths.push(depthM);
      local.push(c * dxM, -r * dyM, -depthM * exaggeration);
    }
  }

  const buckets = new Map();
  const pushTriangle = (a, b, c) => {
    const ax = local[a * 3];
    const ay = local[a * 3 + 1];
    const az = local[a * 3 + 2];
    const u = [local[b * 3] - ax, local[b * 3 + 1] - ay, local[b * 3 + 2] - az];
    const v = [local[c * 3] - ax, local[c * 3 + 1] - ay, local[c * 3 + 2] - az];
    const n = normalize([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]);
    const up = n[2] < 0 ? n.map((k) => -k) : n;
    const lambert = Math.max(0, up[0] * LIGHT[0] + up[1] * LIGHT[1] + up[2] * LIGHT[2]);
    const shadeLevel = Math.min(SHADE_LEVELS - 1, Math.round(lambert * (SHADE_LEVELS - 1)));
    const band = Math.floor((depths[a] + depths[b] + depths[c]) / 3 / BAND_M);
    const key = band * SHADE_LEVELS + shadeLevel;
    if (!buckets.has(key)) buckets.set(key, { band, shadeLevel, indices: [] });
    buckets.get(key).indices.push(a, b, c);
  };
  for (let r = 0; r < rows - 1; r += 1) {
    for (let c = 0; c < cols - 1; c += 1) {
      const nw = vertexOf[r * cols + c];
      const ne = vertexOf[r * cols + c + 1];
      const sw = vertexOf[(r + 1) * cols + c];
      const se = vertexOf[(r + 1) * cols + c + 1];
      // Counter-clockwise seen from above (north up, east right).
      if (nw >= 0 && sw >= 0 && ne >= 0) pushTriangle(nw, sw, ne);
      if (ne >= 0 && sw >= 0 && se >= 0) pushTriangle(ne, sw, se);
    }
  }

  const instances = [];
  const localOf = new Int32Array(depths.length);
  for (const { band, shadeLevel, indices: globalIndices } of buckets.values()) {
    localOf.fill(-1);
    const values = [];
    const indices = new Uint32Array(globalIndices.length);
    for (let i = 0; i < globalIndices.length; i += 1) {
      const g = globalIndices[i];
      if (localOf[g] < 0) {
        localOf[g] = values.length / 3;
        values.push(positions[g * 3], positions[g * 3 + 1], positions[g * 3 + 2]);
      }
      indices[i] = localOf[g];
    }
    const packed = new Float64Array(values);
    instances.push(
      new Cesium.GeometryInstance({
        id: { seabed: meta.id, band, shadeLevel },
        geometry: new Cesium.Geometry({
          attributes: {
            position: new Cesium.GeometryAttribute({
              componentDatatype: Cesium.ComponentDatatype.DOUBLE,
              componentsPerAttribute: 3,
              values: packed,
            }),
          },
          indices,
          primitiveType: Cesium.PrimitiveType.TRIANGLES,
          boundingSphere: Cesium.BoundingSphere.fromVertices(packed),
        }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(shadedColor(band, shadeLevel)),
        },
      }),
    );
  }
  return instances;
}

/** Nearest valid depth (m) at lon/lat within one area grid, or null. */
export function sampleDepthM(meta, depthCm, lon, lat) {
  const { rows, cols, west, north, dLon, dLat } = meta;
  const c0 = Math.round((lon - west) / dLon - 0.5);
  const r0 = Math.round((north - lat) / dLat - 0.5);
  if (c0 < -1 || r0 < -1 || c0 > cols || r0 > rows) return null;
  let best = null;
  let bestD2 = Infinity;
  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      const r = r0 + dr;
      const c = c0 + dc;
      if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
      const cm = depthCm[r * cols + c];
      if (cm > 0 && dr * dr + dc * dc < bestD2) {
        best = cm / 100;
        bestD2 = dr * dr + dc * dc;
      }
    }
  }
  return best;
}

async function loadAreas(signal) {
  const response = await fetch(`${BASE_URL}index.json`, { signal, cache: 'no-cache' });
  if (!response.ok) throw new Error(`seabed index HTTP ${response.status}`);
  const index = await response.json();
  const areas = [];
  for (const meta of index.areas || []) {
    const res = await fetch(`${BASE_URL}${meta.file}`, { signal });
    if (!res.ok) throw new Error(`seabed ${meta.id} HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    areas.push({ meta, depthCm: new Int16Array(buffer) });
  }
  return areas;
}

/**
 * Attach the seabed overlay. Returns `{ cleanup, onChange, heightAt }`:
 * - onChange(fn) is called with `true/false` whenever the seabed is shown/hidden
 *   (after its primitives exist), so the coral overlay can switch to outlines;
 * - heightAt(lon, lat) is the ellipsoidal height of the drawn seabed there, or null.
 */
export function attachSeabedOverlay(viewer, { slot = 1 } = {}) {
  const controller = new AbortController();
  const chip = createHucklyChip({ id: 'huckly-seabed-chip', slot });
  const exaggeration = readExaggeration();
  const listeners = new Set();
  let primitives = [];
  let areas = [];
  let loaded = null;
  let enabled = false;

  const emit = (state) => {
    for (const listener of listeners) listener(state);
  };

  const render = (state) => {
    chip.textContent = `🌊 海底 ${state}`;
    chip.title =
      `Allen Coral Atlas 衛星推算水深（10 m 格網、約 0–25 m），垂直放大 ${exaggeration}x，` +
      '每 1 m 一色並加西北光源陰影。資料 CC BY 4.0';
    chip.style.opacity = enabled ? '1' : '0.7';
  };

  const heightAt = (lon, lat) => {
    for (const { meta, depthCm, seaLevelM } of areas) {
      const depthM = sampleDepthM(meta, depthCm, lon, lat);
      if (depthM !== null) return seaLevelM - depthM * exaggeration;
    }
    return null;
  };

  const ensureLoaded = () => {
    loaded ??= Promise.all([loadAreas(controller.signal), ensureGeoidReady()]).then(([loadedAreas]) => {
      if (viewer.isDestroyed()) return loadedAreas;
      const appearance = new Cesium.PerInstanceColorAppearance({
        flat: true,
        translucent: false,
        renderState: {
          depthTest: { enabled: false },
          cull: { enabled: true, face: Cesium.CullFace.BACK },
        },
      });
      areas = loadedAreas.map(({ meta, depthCm }) => {
        const centerLat = meta.north - (meta.rows * meta.dLat) / 2;
        const centerLon = meta.west + (meta.cols * meta.dLon) / 2;
        return { meta, depthCm, seaLevelM: geoidHeight(centerLat, centerLon) };
      });
      for (const { meta, depthCm, seaLevelM } of areas) {
        const primitive = new Cesium.Primitive({
          geometryInstances: buildSeabedInstances(meta, depthCm, seaLevelM, exaggeration),
          appearance,
          asynchronous: false,
          releaseGeometryInstances: true,
        });
        primitives.push(viewer.scene.primitives.add(primitive));
      }
      registerDynamicCredit(viewer, CREDIT);
      return loadedAreas;
    });
    return loaded;
  };

  const setEnabled = async (next) => {
    enabled = next;
    rememberToggle(STORAGE_KEY, next);
    if (!next) {
      for (const primitive of primitives) primitive.show = false;
      render('關');
      emit(false);
      viewer.scene.requestRender();
      return;
    }
    render('載入中…');
    try {
      const loadedAreas = await ensureLoaded();
      if (!enabled) return;
      for (const primitive of primitives) primitive.show = true;
      render(`開 · ${loadedAreas.length} 區`);
      emit(true);
      viewer.scene.requestRender();
    } catch (error) {
      if (controller.signal.aborted) return;
      console.warn('[huckly-seabed] overlay unavailable:', error);
      loaded = null;
      enabled = false;
      render('無資料');
      emit(false);
    }
  };

  chip.addEventListener('click', () => setEnabled(!enabled));
  render('關');
  if (readToggle('seabed', STORAGE_KEY)) setEnabled(true);

  return {
    heightAt,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cleanup() {
      controller.abort();
      listeners.clear();
      chip.remove();
      if (!viewer.isDestroyed()) {
        for (const primitive of primitives) viewer.scene.primitives.remove(primitive);
      }
      primitives = [];
    },
  };
}
