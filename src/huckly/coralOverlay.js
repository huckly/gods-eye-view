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
 * Mirrors the Atlas web map: all six benthic classes, the Atlas' own colours
 * (https://allencoralatlas.org/mapping/reefclasses, style_rgba, fetched
 * 2026-09-18) and a per-class checklist in the legend. Two looks:
 * - fill (seabed off): one GroundPrimitive per class, draped on the keyless
 *   globe and on Google Photorealistic 3D Tiles;
 * - outline (seabed on): one opaque polyline Primitive per class sitting on the
 *   drawn seabed, depth test off and raised above the seabed mesh.
 *
 * Data: output/huckly-coral/coral.geojsonl, produced once on the serving host by
 * scripts/huckly/fetch-coral-atlas.mjs (gitignored, never committed).
 * Toggle: the "珊瑚礁" chip (bottom-right), or ?coral=1 / ?coral=0 in the URL.
 */
const DATA_URL = '/output/huckly-coral/coral.geojsonl';
const STORAGE_KEY = 'huckly:coral';
const HIDDEN_CLASSES_KEY = 'huckly:coral-hidden-classes';
const CREDIT = {
  html:
    'Coral reefs: <a href="https://allencoralatlas.org/" target="_blank" rel="noopener">' +
    '© 2018-2023 Allen Coral Atlas Partnership and Arizona State University</a> (CC BY 4.0)',
};
// Atlas order (`sort`) and colours (`style_rgba`). Exported for the legend.
export const CORAL_CLASS_STYLE = {
  Seagrass: { color: 'rgb(102, 132, 56)', label: '海草床' },
  'Coral/Algae': { color: 'rgb(255, 97, 97)', label: '珊瑚/藻類' },
  'Microalgal Mats': { color: 'rgb(155, 204, 79)', label: '微藻墊' },
  Rock: { color: 'rgb(177, 156, 58)', label: '岩礁' },
  Rubble: { color: 'rgb(224, 208, 94)', label: '珊瑚碎屑' },
  Sand: { color: 'rgb(255, 255, 190)', label: '沙地' },
};
const FILL_ALPHA = 0.72;
const FALLBACK_STYLE = { color: 'rgb(255, 255, 255)', label: '其他' };
const OUTLINE_WIDTH_PX = 2;

const classOf = (feature) => feature.properties?.class_name || 'Other';
const styleOf = (cls) => CORAL_CLASS_STYLE[cls] || FALLBACK_STYLE;

function readHiddenClasses() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(HIDDEN_CLASSES_KEY) || '[]');
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function rememberHiddenClasses(hidden) {
  try {
    window.localStorage.setItem(HIDDEN_CLASSES_KEY, JSON.stringify([...hidden]));
  } catch {
    /* storage blocked */
  }
}

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

function groupByClass(features) {
  const groups = new Map();
  for (const feature of features) {
    const cls = classOf(feature);
    if (!groups.has(cls)) groups.set(cls, []);
    groups.get(cls).push(feature);
  }
  return groups;
}

function buildFillPrimitive(cls, features) {
  const color = Cesium.Color.fromCssColorString(styleOf(cls).color).withAlpha(FILL_ALPHA);
  const geometryInstances = [];
  for (const feature of features) {
    for (const [index, [outer, ...holes]] of polygonsOf(feature.geometry).entries()) {
      geometryInstances.push(
        new Cesium.GeometryInstance({
          id: { coral: true, name: feature.properties?.name, index },
          geometry: new Cesium.PolygonGeometry({
            polygonHierarchy: new Cesium.PolygonHierarchy(
              ringPositions(outer),
              holes.map((hole) => new Cesium.PolygonHierarchy(ringPositions(hole))),
            ),
          }),
          attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(color) },
        }),
      );
    }
  }
  return new Cesium.GroundPrimitive({
    geometryInstances,
    appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }),
    classificationType: Cesium.ClassificationType.BOTH,
    asynchronous: true,
  });
}

/** Outer rings as polylines placed on the seabed (or at mean sea level). */
export function buildOutlineInstances(features, heightAt, seaLevelAt) {
  const instances = [];
  for (const feature of features) {
    const color = Cesium.Color.fromCssColorString(styleOf(classOf(feature)).color);
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
 * Attach the coral overlay. Returns
 * `{ cleanup, onChange, setSeabed, classes, setClassVisible }`:
 * - onChange(fn) fires with `enabled` when the overlay or a class toggles;
 * - setSeabed(on, heightAt) switches between fill and on-seabed outlines;
 * - classes() lists `{ cls, label, color, visible, count }` in Atlas order.
 */
export function attachCoralOverlay(viewer, { slot = 0 } = {}) {
  const controller = new AbortController();
  const chip = createHucklyChip({ id: 'huckly-coral-chip', slot });
  const listeners = new Set();
  const hidden = readHiddenClasses();
  const fillByClass = new Map();
  const outlineByClass = new Map();
  let groups = new Map();
  let features = null;
  let loaded = null;
  let enabled = false;
  let seabedOn = false;
  let heightAt = () => null;
  let outlinesPending = null;

  const emit = () => {
    for (const listener of listeners) listener(enabled);
  };

  const render = (state) => {
    chip.textContent = `🪸 珊瑚礁 ${state}`;
    chip.title = 'Allen Coral Atlas 底質分類（6 類，可在圖例個別勾選）；開海底時改畫外框。資料 CC BY 4.0';
    chip.style.opacity = enabled ? '1' : '0.7';
  };

  const ensureLoaded = () => {
    loaded ??= loadFeatures(controller.signal).then((loadedFeatures) => {
      features = loadedFeatures;
      groups = groupByClass(loadedFeatures);
      if (viewer.isDestroyed()) return loadedFeatures;
      for (const [cls, classFeatures] of groups) {
        fillByClass.set(cls, viewer.scene.primitives.add(buildFillPrimitive(cls, classFeatures)));
      }
      registerDynamicCredit(viewer, CREDIT);
      return loadedFeatures;
    });
    return loaded;
  };

  const ensureOutlines = () => {
    if (outlineByClass.size || !features || viewer.isDestroyed()) return Promise.resolve();
    outlinesPending ??= ensureGeoidReady().then(() => {
      if (outlineByClass.size || viewer.isDestroyed()) return;
      const appearance = new Cesium.PolylineColorAppearance({
        translucent: false,
        renderState: { depthTest: { enabled: false } },
      });
      for (const [cls, classFeatures] of groups) {
        const primitive = new Cesium.Primitive({
          geometryInstances: buildOutlineInstances(classFeatures, heightAt, (lon, lat) => geoidHeight(lat, lon)),
          appearance,
          asynchronous: true,
        });
        outlineByClass.set(cls, viewer.scene.primitives.add(primitive));
      }
    });
    return outlinesPending;
  };

  const applyVisibility = async () => {
    for (const [cls, primitive] of fillByClass) primitive.show = enabled && !seabedOn && !hidden.has(cls);
    if (enabled && seabedOn) await ensureOutlines();
    for (const [cls, primitive] of outlineByClass) {
      primitive.show = enabled && seabedOn && !hidden.has(cls);
      // Opaque primitives with depth test off draw in collection order: stay above the seabed.
      if (primitive.show) viewer.scene.primitives.raiseToTop(primitive);
    }
    viewer.scene.requestRender();
  };

  const setEnabled = async (next) => {
    enabled = next;
    rememberToggle(STORAGE_KEY, next);
    if (!next) {
      await applyVisibility();
      render('關');
      emit();
      return;
    }
    render('載入中…');
    try {
      const loadedFeatures = await ensureLoaded();
      if (!enabled) return;
      await applyVisibility();
      render(`開 · ${loadedFeatures.length}`);
      emit();
    } catch (error) {
      if (controller.signal.aborted) return;
      console.warn('[huckly-coral] overlay unavailable:', error);
      loaded = null;
      enabled = false;
      render('無資料');
      emit();
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
    classes() {
      return Object.entries(CORAL_CLASS_STYLE).map(([cls, style]) => ({
        cls,
        label: style.label,
        color: style.color,
        visible: !hidden.has(cls),
        count: groups.get(cls)?.length ?? 0,
      }));
    },
    setClassVisible(cls, visible) {
      if (visible) hidden.delete(cls);
      else hidden.add(cls);
      rememberHiddenClasses(hidden);
      applyVisibility().catch((error) => console.warn('[huckly-coral] class toggle failed:', error));
      emit();
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
        for (const primitive of [...fillByClass.values(), ...outlineByClass.values()]) {
          viewer.scene.primitives.remove(primitive);
        }
      }
      fillByClass.clear();
      outlineByClass.clear();
    },
  };
}
