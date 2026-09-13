import * as Cesium from 'cesium';

/**
 * huckly fork: default home view. Mirrors upstream flyToAustin() in camera.js
 * (high top-down setView, then a cinematic fly-in, returns a cleanup that
 * cancels the pending flight) but lands over Taipei.
 * Kept in its own module so upstream edits to camera.js never conflict;
 * src/standalone/controls.js imports it as `flyToAustin`.
 */
export const HOME = Object.freeze({
  label: 'Taipei, Taiwan',
  lat: 25.0339,
  lon: 121.5645,
  highM: 60000,
  lowM: 2200,
  heading: 200,
  pitch: -25,
});

export function flyToHome(viewer) {
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(HOME.lon, HOME.lat, HOME.highM),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-90),
      roll: 0.0,
    },
  });

  const timer = setTimeout(() => {
    if (viewer.isDestroyed()) return;
    viewer.camera.flyTo({
      // Offset the eye north-east of the tower so a heading of ~200 deg frames it.
      destination: Cesium.Cartesian3.fromDegrees(HOME.lon + 0.008, HOME.lat + 0.016, HOME.lowM),
      orientation: {
        heading: Cesium.Math.toRadians(HOME.heading),
        pitch: Cesium.Math.toRadians(HOME.pitch),
        roll: 0.0,
      },
      duration: 4.0,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
  }, 500);
  return () => {
    clearTimeout(timer);
    if (!viewer.isDestroyed()) viewer.camera.cancelFlight();
  };
}
