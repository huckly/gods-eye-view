import * as Cesium from 'cesium';
import { registerDynamicCredit } from '../data/dataCredits.js';
import { createHucklyChip, readToggle, rememberToggle } from './chip.js';

/**
 * huckly fork: Allen Coral Atlas benthic habitat overlay for dive areas.
 *
 * Deliberately NOT a DataLayerManager layer: upstream seals a fixed layer-state
 * registry (layerState.js, voice-tool enums, scene policies), so a new managed
 * layer would touch many upstream files. This overlay owns its own toggle chip
 * and batches every patch into one GroundPrimitive per habitat class, which
 * drapes on both the keyless globe and Google Photorealistic 3D Tiles.
 *
 * Data: output/huckly-coral/coral.geojsonl, produced once on the serving host by
 * scripts/huckly/fetch-coral-atlas.mjs (gitignored, never committed).
 *
 * Toggle: the "珊瑚礁" chip (bottom-right), or ?coral=1 / ?coral=0 in the URL.
 */
const DATA_URL = '/output/huckly-coral/coral.geojsonl';
const STORAGE_KEY = 'huckly:coral';
const CREDIT = {
  html:
    'Coral reefs: <a href="https://allencoralatlas.org/" target="_blank" rel="noopener">' +
    '© 2018-2023 Allen Coral Atlas Partnership and Arizona State University</a> (CC BY 4.0)',
};
const CLASS_STYLE = {
  'Coral/Algae': { color: '#ff5fa2', alpha: 0.6, label: '珊瑚/藻類' },
  Seagrass: { color: '#39d98a', alpha: 0.5, label: '海草床' },
  Rubble: { color: '#c8b27a', alpha: 0.45, label: '珊瑚碎屑' },
  Rock: { color: '#8c8c8c', alpha: 0.4, label: '岩礁' },
  Sand: { color: '#f2e3b3', alpha: 0.35, label: '沙地' },
};
const FALLBACK_STYLE = { color: '#ffffff', alpha: 0.4, label: '其他' };

function ringPositions(ring) {
  return Cesium.Cartesian3.fromDegreesArray(ring.flat());
}

function polygonHierarchies(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.map(
    ([outer, ...holes]) =>
      new Cesium.PolygonHierarchy(
        ringPositions(outer),
        holes.map((hole) => new Cesium.PolygonHierarchy(ringPositions(hole))),
      ),
  );
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

function buildPrimitives(features) {
  const byClass = new Map();
  for (const feature of features) {
    const cls = feature.properties?.class_name || 'Other';
    const style = CLASS_STYLE[cls] || FALLBACK_STYLE;
    const color = Cesium.Color.fromCssColorString(style.color).withAlpha(style.alpha);
    for (const [index, hierarchy] of polygonHierarchies(feature.geometry).entries()) {
      const instance = new Cesium.GeometryInstance({
        id: { coral: true, name: feature.properties?.name, index },
        geometry: new Cesium.PolygonGeometry({ polygonHierarchy: hierarchy }),
        attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(color) },
      });
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

/**
 * Attach the coral overlay to a viewer. Returns a cleanup for the caller's
 * `defer()` so it tears down with the rest of the standalone controls.
 */
export function attachCoralOverlay(viewer, { slot = 0 } = {}) {
  const controller = new AbortController();
  const chip = createHucklyChip({ id: 'huckly-coral-chip', slot });
  let primitives = [];
  let loaded = null;
  let enabled = false;
  let creditRegistered = false;

  const render = (state) => {
    const legend = Object.values(CLASS_STYLE)
      .map((style) => style.label)
      .join(' / ');
    chip.textContent = `🪸 珊瑚礁 ${state}`;
    chip.title = `Allen Coral Atlas 底質分類（${legend}），資料 CC BY 4.0`;
    chip.style.opacity = enabled ? '1' : '0.7';
  };

  const ensureLoaded = () => {
    loaded ??= loadFeatures(controller.signal).then((features) => {
      if (viewer.isDestroyed()) return features;
      primitives = buildPrimitives(features).map((primitive) => viewer.scene.primitives.add(primitive));
      if (!creditRegistered) {
        registerDynamicCredit(viewer, CREDIT);
        creditRegistered = true;
      }
      return features;
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
      const features = await ensureLoaded();
      if (!enabled) return;
      for (const primitive of primitives) primitive.show = true;
      render(`開 · ${features.length}`);
      viewer.scene.requestRender();
    } catch (error) {
      if (controller.signal.aborted) return;
      console.warn('[huckly-coral] overlay unavailable:', error);
      loaded = null;
      enabled = false;
      render('無資料');
    }
  };

  chip.addEventListener('click', () => setEnabled(!enabled));
  render('關');
  if (readToggle('coral', STORAGE_KEY)) setEnabled(true);

  return () => {
    controller.abort();
    chip.remove();
    if (!viewer.isDestroyed()) {
      for (const primitive of primitives) viewer.scene.primitives.remove(primitive);
    }
    primitives = [];
  };
}
