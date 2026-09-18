import * as Cesium from 'cesium';
import { registerDynamicCredit } from '../data/dataCredits.js';
import { ensureGeoidReady, geoidHeight } from '../data/geoid.js';
import { createHucklyChip, readToggle, rememberToggle } from './chip.js';

/**
 * huckly fork: 3D seabed from Allen Coral Atlas 10 m satellite-derived
 * bathymetry (0 to ~25 m), for dive areas downloaded by hand.
 *
 * Each area becomes a shaded height-field mesh placed below local mean sea
 * level (EGM96 geoid) and coloured in 2 m depth bands. Depth testing is off so
 * the seabed shows through Google Photorealistic 3D Tiles' opaque water surface
 * and through the keyless globe; the data only exists under water, so it never
 * paints over land. Relief is exaggerated (default 6x) and the mesh is translucent so the coral overlay stays visible.
 *
 * Data: output/huckly-bathy/web/ (gitignored), produced from the Atlas
 * download ZIPs by scripts/huckly/prepare-bathymetry.py.
 * Toggle: "海底" chip, or ?seabed=1 / ?seabed=0; exaggeration ?seabedx=1..10.
 */
const BASE_URL = '/output/huckly-bathy/web/';
const STORAGE_KEY = 'huckly:seabed';
const BAND_M = 2;
// Shallow reef flats are gentle; 6x makes 1-2 m relief readable from ~1 km.
const DEFAULT_EXAGGERATION = 6;
// Translucent so the coral overlay (drawn on the 3D tiles' water surface) and
// the seabed read together; the seabed alone ignores depth to show through water.
const SEABED_ALPHA = 0.55;
const CREDIT = {
  html:
    'Seabed: <a href="https://allencoralatlas.org/" target="_blank" rel="noopener">' +
    '© 2018-2023 Allen Coral Atlas Partnership and Arizona State University</a> (CC BY 4.0), ' +
    'satellite-derived bathymetry',
};
// Shallow → deep colour ramp (metres).
const RAMP = [
  [0, [184, 245, 255]],
  [4, [111, 227, 240]],
  [8, [47, 181, 217]],
  [12, [31, 127, 199]],
  [16, [42, 79, 174]],
  [20, [43, 47, 143]],
  [26, [28, 26, 94]],
];

function readExaggeration() {
  try {
    const value = Number(new URLSearchParams(window.location.search).get('seabedx'));
    return Number.isFinite(value) && value >= 1 && value <= 10 ? value : DEFAULT_EXAGGERATION;
  } catch {
    return DEFAULT_EXAGGERATION;
  }
}

function rampColor(depthM) {
  for (let i = 1; i < RAMP.length; i += 1) {
    const [d1, c1] = RAMP[i];
    const [d0, c0] = RAMP[i - 1];
    if (depthM <= d1 || i === RAMP.length - 1) {
      const t = Math.min(1, Math.max(0, (depthM - d0) / (d1 - d0)));
      const [r, g, b] = c0.map((v, k) => Math.round(v + (c1[k] - v) * t));
      return Cesium.Color.fromBytes(r, g, b, Math.round(SEABED_ALPHA * 255));
    }
  }
  return Cesium.Color.WHITE;
}

/** Build one GeometryInstance per 2 m depth band for an area grid. */
export function buildSeabedInstances(meta, depthCm, seaLevelM, exaggeration) {
  const { rows, cols, west, north, dLon, dLat } = meta;
  const vertexOf = new Int32Array(rows * cols).fill(-1);
  const positions = [];
  const depths = [];
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
    }
  }

  const bands = new Map();
  const pushTriangle = (a, b, c) => {
    const band = Math.floor((depths[a] + depths[b] + depths[c]) / 3 / BAND_M);
    if (!bands.has(band)) bands.set(band, []);
    bands.get(band).push(a, b, c);
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
  for (const [band, globalIndices] of bands) {
    localOf.fill(-1);
    const local = [];
    const indices = new Uint32Array(globalIndices.length);
    for (let i = 0; i < globalIndices.length; i += 1) {
      const g = globalIndices[i];
      if (localOf[g] < 0) {
        localOf[g] = local.length / 3;
        local.push(positions[g * 3], positions[g * 3 + 1], positions[g * 3 + 2]);
      }
      indices[i] = localOf[g];
    }
    const values = new Float64Array(local);
    const geometry = Cesium.GeometryPipeline.computeNormal(
      new Cesium.Geometry({
        attributes: {
          position: new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.DOUBLE,
            componentsPerAttribute: 3,
            values,
          }),
        },
        indices,
        primitiveType: Cesium.PrimitiveType.TRIANGLES,
        boundingSphere: Cesium.BoundingSphere.fromVertices(values),
      }),
    );
    instances.push(
      new Cesium.GeometryInstance({
        id: { seabed: meta.id, band },
        geometry,
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(rampColor((band + 0.5) * BAND_M)),
        },
      }),
    );
  }
  return instances;
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

/** Attach the seabed overlay; returns a cleanup for the caller's `defer()`. */
export function attachSeabedOverlay(viewer, { slot = 1 } = {}) {
  const controller = new AbortController();
  const chip = createHucklyChip({ id: 'huckly-seabed-chip', slot });
  const exaggeration = readExaggeration();
  let primitives = [];
  let loaded = null;
  let enabled = false;

  const render = (state) => {
    chip.textContent = `🌊 海底 ${state}`;
    chip.title =
      `Allen Coral Atlas 衛星推算水深（10 m 格網、約 0–25 m），垂直放大 ${exaggeration}x，` +
      '每 2 m 一色：淺青 → 深藍。資料 CC BY 4.0';
    chip.style.opacity = enabled ? '1' : '0.7';
  };

  const ensureLoaded = () => {
    loaded ??= Promise.all([loadAreas(controller.signal), ensureGeoidReady()]).then(([areas]) => {
      if (viewer.isDestroyed()) return areas;
      const appearance = new Cesium.PerInstanceColorAppearance({
        flat: false,
        translucent: true,
        renderState: {
          depthTest: { enabled: false },
          cull: { enabled: true, face: Cesium.CullFace.BACK },
        },
      });
      for (const { meta, depthCm } of areas) {
        const centerLat = meta.north - (meta.rows * meta.dLat) / 2;
        const centerLon = meta.west + (meta.cols * meta.dLon) / 2;
        const seaLevelM = geoidHeight(centerLat, centerLon);
        const primitive = new Cesium.Primitive({
          geometryInstances: buildSeabedInstances(meta, depthCm, seaLevelM, exaggeration),
          appearance,
          asynchronous: false,
          releaseGeometryInstances: true,
        });
        primitives.push(viewer.scene.primitives.add(primitive));
      }
      registerDynamicCredit(viewer, CREDIT);
      return areas;
    });
    return loaded;
  };

  const setEnabled = async (next) => {
    enabled = next;
    rememberToggle(STORAGE_KEY, next);
    if (!next) {
      for (const primitive of primitives) primitive.show = false;
      render('關');
      viewer.scene.requestRender();
      return;
    }
    render('載入中…');
    try {
      const areas = await ensureLoaded();
      if (!enabled) return;
      for (const primitive of primitives) primitive.show = true;
      render(`開 · ${areas.length} 區`);
      viewer.scene.requestRender();
    } catch (error) {
      if (controller.signal.aborted) return;
      console.warn('[huckly-seabed] overlay unavailable:', error);
      loaded = null;
      enabled = false;
      render('無資料');
    }
  };

  chip.addEventListener('click', () => setEnabled(!enabled));
  render('關');
  if (readToggle('seabed', STORAGE_KEY)) setEnabled(true);

  return () => {
    controller.abort();
    chip.remove();
    if (!viewer.isDestroyed()) {
      for (const primitive of primitives) viewer.scene.primitives.remove(primitive);
    }
    primitives = [];
  };
}
