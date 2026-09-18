import * as Cesium from 'cesium';
import { registerDynamicCredit } from '../data/dataCredits.js';
import { ensureGeoidReady, geoidHeight } from '../data/geoid.js';
import { createHucklyChip, readToggle, rememberToggle } from './chip.js';

/**
 * huckly fork: 3D seabed from Allen Coral Atlas 10 m satellite-derived
 * bathymetry (0 to ~25 m), for dive areas downloaded by hand.
 *
 * Each area becomes an opaque height-field mesh placed below local mean sea
 * level (EGM96 geoid). Every vertex is coloured by depth and shaded by its
 * slope against a light from the north-west, so reef edges,
 * channels and drop-offs read like a shaded-relief chart. Depth testing is off
 * so the seabed shows through Google Photorealistic 3D Tiles' opaque water
 * surface; the data only exists under water, so it never paints over land.
 * The grid is smoothed and shaded by ~80 m slopes; relief exaggerated (default 4x, ?seabedx=1..10).
 *
 * Data: output/huckly-bathy/web/ (gitignored), produced from the Atlas
 * download ZIPs by scripts/huckly/prepare-bathymetry.py.
 * Toggle: "海底" chip, or ?seabed=1 / ?seabed=0.
 */
const BASE_URL = '/output/huckly-bathy/web/';
const STORAGE_KEY = 'huckly:seabed';
// With the grid smoothed, 4x keeps reef slopes readable without caricature.
const DEFAULT_EXAGGERATION = 4;
// Masked box-blur radius (cells, 20 m each) applied before meshing.
const SMOOTH_RADIUS = 1;
// Shading slope is measured over +/- this many cells (~80 m span at 20 m).
const SHADE_SPAN_CELLS = 2;
// Brightness spread around a flat bottom; higher = stronger relief shading.
const SHADE_GAIN = 4;
// Light from the north-west, 45 degrees up (local east/north/up axes).
const LIGHT = normalize([-0.5, 0.5, Math.SQRT1_2]);
const CREDIT = {
  html:
    'Seabed: <a href="https://allencoralatlas.org/" target="_blank" rel="noopener">' +
    '© 2018-2023 Allen Coral Atlas Partnership and Arizona State University</a> (CC BY 4.0), ' +
    'satellite-derived bathymetry; shore strip bounded by coastline ' +
    '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>',
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

/** Brightness 0.5 (facing away from the light) .. 1.15 (facing it), for shade 0..1. */
export function shadedRgb(depthM, shade) {
  const factor = 0.5 + 0.65 * shade;
  return rampRgb(depthM).map((v) => Math.min(255, Math.round(v * factor)));
}

/**
 * Masked box blur of a depth grid (cm, 0 = no data): each valid cell becomes
 * the mean of the valid cells within `radius`. Satellite-derived depth carries
 * per-pixel noise that, exaggerated, reads as a shattered mosaic.
 */
export function smoothDepth(depthCm, rows, cols, radius = SMOOTH_RADIUS) {
  const out = new Float64Array(rows * cols);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (depthCm[r * cols + c] <= 0) continue;
      let sum = 0;
      let n = 0;
      for (let rr = Math.max(0, r - radius); rr <= Math.min(rows - 1, r + radius); rr += 1) {
        for (let cc = Math.max(0, c - radius); cc <= Math.min(cols - 1, c + radius); cc += 1) {
          const v = depthCm[rr * cols + cc];
          if (v > 0) {
            sum += v;
            n += 1;
          }
        }
      }
      out[r * cols + c] = sum / n;
    }
  }
  return out;
}

/**
 * Build the seabed of one area grid as a single GeometryInstance whose colour is
 * a per-vertex attribute: depth ramp times relief shading, interpolated across
 * each triangle, so the surface reads as smooth gradients rather than facets.
 * `depthCm` should already be smoothed (see smoothDepth). Shading comes from the
 * slope over +/-SHADE_SPAN_CELLS cells around each vertex, so it follows
 * landforms rather than pixel noise. Colours are baked (no scene lighting).
 * With no instance colour attribute, PerInstanceColorAppearance's `color`
 * shader input reads this vertex attribute.
 */
export function buildSeabedInstances(meta, depthCm, seaLevelM, exaggeration) {
  const { rows, cols, west, north, dLon, dLat } = meta;
  const latMid = north - (rows * dLat) / 2;
  const dxM = dLon * 111320 * Math.cos((latMid * Math.PI) / 180);
  const dyM = dLat * 110540;
  const vertexOf = new Int32Array(rows * cols).fill(-1);
  const positions = [];
  const colors = [];
  const zAt = (r, c, fallback) => {
    if (r < 0 || c < 0 || r >= rows || c >= cols) return fallback;
    const cm = depthCm[r * cols + c];
    return cm > 0 ? (-cm / 100) * exaggeration : fallback;
  };
  const k = SHADE_SPAN_CELLS;
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
      const z = -depthM * exaggeration;
      const dzdx = (zAt(r, c + k, z) - zAt(r, c - k, z)) / (2 * k * dxM);
      const dzdy = (zAt(r - k, c, z) - zAt(r + k, c, z)) / (2 * k * dyM); // row index grows southward
      const [nx, ny, nz] = normalize([-dzdx, -dzdy, 1]);
      const lambert = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
      // Contrast relative to a flat bottom (which faces the light at LIGHT[2]).
      const shade = Math.min(1, Math.max(0, 0.5 + (lambert - LIGHT[2]) * SHADE_GAIN));
      vertexOf[r * cols + c] = positions.length / 3;
      positions.push(p.x, p.y, p.z);
      colors.push(...shadedRgb(depthM, shade), 255);
    }
  }

  const indices = [];
  for (let r = 0; r < rows - 1; r += 1) {
    for (let c = 0; c < cols - 1; c += 1) {
      const nw = vertexOf[r * cols + c];
      const ne = vertexOf[r * cols + c + 1];
      const sw = vertexOf[(r + 1) * cols + c];
      const se = vertexOf[(r + 1) * cols + c + 1];
      // Counter-clockwise seen from above (north up, east right).
      if (nw >= 0 && sw >= 0 && ne >= 0) indices.push(nw, sw, ne);
      if (ne >= 0 && sw >= 0 && se >= 0) indices.push(ne, sw, se);
    }
  }
  if (!indices.length) return [];

  const packed = new Float64Array(positions);
  return [
    new Cesium.GeometryInstance({
      id: { seabed: meta.id },
      geometry: new Cesium.Geometry({
        attributes: {
          position: new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.DOUBLE,
            componentsPerAttribute: 3,
            values: packed,
          }),
          color: new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.UNSIGNED_BYTE,
            componentsPerAttribute: 4,
            normalize: true,
            values: new Uint8Array(colors),
          }),
        },
        indices: new Uint32Array(indices),
        primitiveType: Cesium.PrimitiveType.TRIANGLES,
        boundingSphere: Cesium.BoundingSphere.fromVertices(packed),
      }),
    }),
  ];
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
      '顏色隨深度漸變並加西北光源陰影；岸邊淺水帶依 OSM 海岸線補齊。資料 CC BY 4.0';
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
        // Mesh and coral-outline heights both read the smoothed grid so they agree.
        const smoothed = smoothDepth(depthCm, meta.rows, meta.cols);
        return { meta, depthCm: smoothed, seaLevelM: geoidHeight(centerLat, centerLon) };
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
