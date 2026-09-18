/**
 * huckly fork: round the staircase edges of Allen Coral Atlas polygons, which
 * are vectorised from ~5 m satellite pixels. A Douglas-Peucker pass first turns
 * each stair run into a straight diagonal, then Chaikin corner cutting rounds
 * the corners. Edges move by at most a few metres; shared edges between two
 * neighbouring classes are smoothed the same way, so they stay close.
 */
const SIMPLIFY_M = 5;
const CHAIKIN_ITERATIONS = 2;
const CUT_MAX_M = 4;

/** Douglas-Peucker on an open lon/lat polyline, tolerance in metres. */
function simplify(points, toleranceM) {
  if (points.length <= 3) return points;
  const lat0 = (points[0][1] * Math.PI) / 180;
  const mx = 111320 * Math.cos(lat0);
  const my = 110540;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const tol2 = toleranceM * toleranceM;
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = points[a][0] * mx;
    const ay = points[a][1] * my;
    const dx = points[b][0] * mx - ax;
    const dy = points[b][1] * my - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstD2 = tol2;
    for (let i = a + 1; i < b; i += 1) {
      const px = points[i][0] * mx - ax;
      const py = points[i][1] * my - ay;
      const t = len2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
      const d2 = (px - t * dx) ** 2 + (py - t * dy) ** 2;
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
  return points.filter((_, i) => keep[i]);
}

/**
 * Chaikin corner cutting on a closed ring given without its closing point. Each
 * cut is a quarter of the edge but at most CUT_MAX_M, so long edges (after
 * simplification) keep their corners in place instead of losing tens of metres.
 */
function chaikin(open) {
  const lat0 = (open[0][1] * Math.PI) / 180;
  const mx = 111320 * Math.cos(lat0);
  const my = 110540;
  const out = [];
  for (let i = 0; i < open.length; i += 1) {
    const [x0, y0] = open[i];
    const [x1, y1] = open[(i + 1) % open.length];
    const lengthM = Math.hypot((x1 - x0) * mx, (y1 - y0) * my);
    const t = lengthM > 0 ? Math.min(0.25, CUT_MAX_M / lengthM) : 0.25;
    out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t], [x1 + (x0 - x1) * t, y1 + (y0 - y1) * t]);
  }
  return out;
}

/** Smooth a closed GeoJSON ring ([lon, lat][], first == last). */
export function smoothRing(ring) {
  if (ring.length < 5) return ring;
  let open = simplify(ring, SIMPLIFY_M).slice(0, -1);
  if (open.length < 4) return ring; // too thin to simplify safely: keep the original
  for (let i = 0; i < CHAIKIN_ITERATIONS; i += 1) open = chaikin(open);
  return [...open, open[0]];
}

/** Smooth every ring of a GeoJSON Polygon / MultiPolygon geometry. */
export function smoothGeometry(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const smoothed = polygons.map((polygon) => polygon.map(smoothRing));
  return geometry.type === 'Polygon'
    ? { type: 'Polygon', coordinates: smoothed[0] }
    : { type: 'MultiPolygon', coordinates: smoothed };
}
