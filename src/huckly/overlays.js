import { attachCoralOverlay } from './coralOverlay.js';
import { createHucklyLegend } from './legend.js';
import { attachSeabedOverlay } from './seabedOverlay.js';

/**
 * huckly fork: single entry point for the fork's own globe overlays, so
 * src/standalone/controls.js carries one import and one call regardless of how
 * many overlays exist. Wires the coral overlay to the seabed (outline mode on
 * the seabed surface) and keeps the legend in sync. Returns one cleanup for the
 * caller's `defer()`.
 */
export function attachHucklyOverlays(viewer) {
  const coral = attachCoralOverlay(viewer, { slot: 0 });
  const seabed = attachSeabedOverlay(viewer, { slot: 1 });
  const legend = createHucklyLegend({ slot: 2 });
  const state = { coral: false, seabed: false };

  const unsubscribeCoral = coral.onChange((on) => {
    state.coral = on;
    legend.update(state);
  });
  const unsubscribeSeabed = seabed.onChange((on) => {
    state.seabed = on;
    coral.setSeabed(on, seabed.heightAt);
    legend.update(state);
  });

  return () => {
    unsubscribeCoral();
    unsubscribeSeabed();
    legend.remove();
    seabed.cleanup();
    coral.cleanup();
  };
}
