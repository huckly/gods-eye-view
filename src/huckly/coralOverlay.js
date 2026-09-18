import * as Cesium from 'cesium';
import { registerDynamicCredit } from '../data/dataCredits.js';
import { ensureGeoidReady, geoidHeight } from '../data/geoid.js';
import { createHucklyChip, readToggle, rememberToggle } from './chip.js';

/**
 * huckly fork: Allen Coral Atlas benthic habitat overlay for dive areas.
 *
 * Deliberately NOT a DataLayerManager layer: upstream seals a fixed layer-state
 * registry (layerState.js, voice-tool enums, scene policies), so a new managed
 * layer would touch many upstream files. This overlay owns its own toggle chip.
 *
 * Two looks:
 * - fill (seabed off): one GroundPrimitive per habitat class, draped on the
 *   keyless globe and on Google Photorealistic 3D Tiles;
 * - outline (seabed on): opaque polylines sitting on the drawn seabed, depth
 *   test off and raised above the seabed mesh, so patches stay pink/green
 *   instead of blending into the blue depth ramp.
 *
 * Data: output/huckly-coral/coral.geojsonl, produced once on the serving host by
 * scripts/huckly/fetch-coral-atlas.mjs (gitignored, never committed).
 * Toggle: the "珊瑚礁" chip (bottom-right), or ?coral=1 / ?coral=0 in the URL.
 */
const DATA_URL = '/output/huckly-coral/coral.geojsonl';
const STORAGE_KEY = 'huckly:coral';
const CREDIT = {
  html:
    'Coral reefs: <a href="https://allencoralatlas.org/" target="_blank" rel="noopener">' +
    '© 2018-2023 Allen Coral Atlas Partnership and Arizona State University</a> (CC BY 4.0)',
};
// Exported for the legend.
export const CORAL_CLASS_STYLE = {
  'Coral/Algae': { color: '#ff5fa2', alpha: 0.6, label: '珊瑚/藻類' },
  Seagrass: { color: '#39d98a', alpha: 0.5, label: '海草床' },
  Rubble: { color: '#c8b27a', alpha: 0.45, label: '珊瑚碎屑' },
  Rock: { color: '#8c8c8c', alpha: 0.4, label: '岩礁' },
  Sand: { color: '#f2e3b3', alpha: 0.35, label: '沙地' },
};
const FALLBACK_STYLE = { color: '#ffffff', alpha: 0.4, label: '其他' };
const OUTLINE_WIDTH_PX = 2;

const styleFor = (feature) => CORAL_CLASS_STYLE[feature.properties?.class_name] || FALLBACK_STYLE;

function ringPositions(ring) {
  return Cesium.Cartesian3.fromDegreesArray(ring.flat());
}

function polygonsOf(geometry) {
  return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
}

async function loadFeatures(signal) {
  const response = await fetch(DATA_URL, { signal, cache: 'no-cache' });
  if (!response.ok) throw new Error(`coral data HTTP ${response.status}`);
  const text = await response.text();
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function buildFillPrimitives(features) {
  const byClass = new Map();
  for (const feature of features) {
    const style = styleFor(feature);
    const color = Cesium.Color.fromCssColorString(style.color).withAlpha(style.alpha);
    for (const [index, [outer, ...holes]] of polygonsOf(feature.geometry).entries()) {
      const hierarchy = new Cesium.PolygonHierarchy(
        ringPositions(outer),
        holes.map((hole) => new Cesium.PolygonHierarchy(ringPositions(hole))),
      );
      const instance = new Cesium.GeometryInstance({
        id: { coral: true, name: feature.properties?.name, index },
        geometry: new Cesium.PolygonGeometry({ polygonHierarchy: hierarchy }),
        attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(color) },
      });
      const cls = feature.properties?.class_name || 'Other';
      if (!byClass.has(cls)) byClass.set(cls, []);
      byClass.get(cls).push(instance);
    }
  }
  return [...byClass.values()].map(
    (geometryInstances) =>
      new Cesium.GroundPrimitive({
        geometryInstances,
        appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }),
        classificationType: Cesium.ClassificationType.BOTH,
        asynchronous: true,
      }),
  );
}

/** Outer rings as polylines placed on the seabed (or at mean sea level). */
export function buildOutlineInstances(features, heightAt, seaLevelAt) {
  const instances = [];
  for (const feature of features) {
    const color = Cesium.Color.fromCssColorString(styleFor(feature).color);
    for (const [index, [outer]] of polygonsOf(feature.geometry).entries()) {
      const unique = new Set(outer.map(([lon, lat]) => `${lon},${lat}`));
      if (unique.size < 3) continue;
      // Vertices off the bathymetry grid (~1/3 at the Atlas' own edges) take the
      // ring's mean seabed height, so an outline never spikes up to sea level.
      const sampled = outer.map(([lon, lat]) => heightAt(lon, lat));
      const known = sampled.filter((h) => h !== null);
      const ringFallback = known.length ? known.reduce((sum, h) => sum + h, 0) / known.length : null;
      const positions = outer.map(([lon, lat], i) =>
        Cesium.Cartesian3.fromDegrees(lon, lat, sampled[i] ?? ringFallback ?? seaLevelAt(lon, lat)),
      );
      instances.push(
        new Cesium.GeometryInstance({
          id: { coral: true, outline: true, name: feature.properties?.name, index },
          geometry: new Cesium.PolylineGeometry({
            positions,
            width: OUTLINE_WIDTH_PX,
            arcType: Cesium.ArcType.NONE,
            vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
          }),
          attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(color) },
        }),
      );
    }
  }
  return instances;
}

/**
 * Attach the coral overlay. Returns `{ cleanup, onChange, setSeabed }`:
 * - onChange(fn) is called with `true/false` when the overlay is shown/hidden;
 * - setSeabed(on, heightAt) switches between fill and on-seabed outlines.
 */
export function attachCoralOverlay(viewer, { slot = 0 } = {}) {
  const controller = new AbortController();
  const chip = createHucklyChip({ id: 'huckly-coral-chip', slot });
  const listeners = new Set();
  let fillPrimitives = [];
  let outlinePrimitive = null;
  let features = null;
  let loaded = null;
  let enabled = false;
  let seabedOn = false;
  let heightAt = () => null;

  const emit = (state) => {
    for (const listener of listeners) listener(state);
  };

  const render = (state) => {
    const legend = Object.values(CORAL_CLASS_STYLE)
      .map((style) => style.label)
      .join(' / ');
    chip.textContent = `🪸 珊瑚礁 ${state}`;
    chip.title = `Allen Coral Atlas 底質分類（${legend}）；開海底時改畫外框。資料 CC BY 4.0`;
    chip.style.opacity = enabled ? '1' : '0.7';
  };

  const ensureLoaded = () => {
    loaded ??= loadFeatures(controller.signal).then((loadedFeatures) => {
      features = loadedFeatures;
      if (viewer.isDestroyed()) return loadedFeatures;
      fillPrimitives = buildFillPrimitives(loadedFeatures).map((primitive) => viewer.scene.primitives.add(primitive));
      registerDynamicCredit(viewer, CREDIT);
      return loadedFeatures;
    });
    return loaded;
  };

  const ensureOutline = async () => {
    if (outlinePrimitive || !features || viewer.isDestroyed()) return;
    await ensureGeoidReady();
    if (outlinePrimitive || viewer.isDestroyed()) return;
    outlinePrimitive = viewer.scene.primitives.add(
      new Cesium.Primitive({
        geometryInstances: buildOutlineInstances(features, heightAt, (lon, lat) => geoidHeight(lat, lon)),
        appearance: new Cesium.PolylineColorAppearance({
          translucent: false,
          renderState: { depthTest: { enabled: false } },
        }),
        asynchronous: true,
      }),
    );
    // Opaque primitives with depth test off draw in collection order: stay above the seabed.
    viewer.scene.primitives.raiseToTop(outlinePrimitive);
  };

  const applyVisibility = async () => {
    for (const primitive of fillPrimitives) primitive.show = enabled && !seabedOn;
    if (enabled && seabedOn) await ensureOutline();
    if (outlinePrimitive) {
      outlinePrimitive.show = enabled && seabedOn;
      if (outlinePrimitive.show) viewer.scene.primitives.raiseToTop(outlinePrimitive);
    }
    viewer.scene.requestRender();
  };

  const setEnabled = async (next) => {
    enabled = next;
    rememberToggle(STORAGE_KEY, next);
    if (!next) {
      await applyVisibility();
      render('關');
      emit(false);
      return;
    }
    render('載入中…');
    try {
      const loadedFeatures = await ensureLoaded();
      if (!enabled) return;
      await applyVisibility();
      render(`開 · ${loadedFeatures.length}`);
      emit(true);
    } catch (error) {
      if (controller.signal.aborted) return;
      console.warn('[huckly-coral] overlay unavailable:', error);
      loaded = null;
      enabled = false;
      render('無資料');
      emit(false);
    }
  };

  chip.addEventListener('click', () => setEnabled(!enabled));
  render('關');
  if (readToggle('coral', STORAGE_KEY)) setEnabled(true);

  return {
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setSeabed(on, seabedHeightAt) {
      seabedOn = on;
      if (seabedHeightAt) heightAt = seabedHeightAt;
      applyVisibility().catch((error) => console.warn('[huckly-coral] outline failed:', error));
    },
    cleanup() {
      controller.abort();
      listeners.clear();
      chip.remove();
      if (!viewer.isDestroyed()) {
        for (const primitive of fillPrimitives) viewer.scene.primitives.remove(primitive);
        if (outlinePrimitive) viewer.scene.primitives.remove(outlinePrimitive);
      }
      fillPrimitives = [];
      outlinePrimitive = null;
    },
  };
}
