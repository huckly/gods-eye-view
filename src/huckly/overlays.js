import { attachCoralOverlay } from './coralOverlay.js';
import { attachSeabedOverlay } from './seabedOverlay.js';

/**
 * huckly fork: single entry point for the fork's own globe overlays, so
 * src/standalone/controls.js carries one import and one call regardless of how
 * many overlays exist. Returns one cleanup for the caller's `defer()`.
 */
export function attachHucklyOverlays(viewer) {
  const cleanups = [attachCoralOverlay(viewer, { slot: 0 }), attachSeabedOverlay(viewer, { slot: 1 })];
  return () => {
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}
