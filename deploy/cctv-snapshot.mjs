#!/usr/bin/env node
/**
 * huckly fork: MJPEG -> single JPEG snapshot sidecar for the Taiwan CCTV pack.
 *
 * The Freeway Bureau publishes live MJPEG streams only (no snapshot URL), while
 * the app polls /api/cctv/frame every 10 s for the active camera. Its terms ask
 * for >= 40 s between requests, so this sidecar:
 *   - serves GET /snap/<camera id> for ids registered in the pack file only
 *     (never a client-supplied URL, so it is not an open proxy),
 *   - opens the stream, cuts the first complete JPEG frame, closes the stream,
 *   - caches each camera's frame for SNAP_TTL_MS (default 60 s),
 *   - coalesces concurrent requests into one upstream fetch.
 *
 * Env: CCTV_SOURCES_FILE (default config/cctv_sources.taiwan.json),
 *      SNAP_PORT (4174), SNAP_TTL_MS (60000). Binds 127.0.0.1 only.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACK = path.resolve(ROOT, process.env.CCTV_SOURCES_FILE || 'config/cctv_sources.taiwan.json');
const PORT = Number(process.env.SNAP_PORT) || 4174;
const TTL_MS = Math.max(40_000, Number(process.env.SNAP_TTL_MS) || 60_000);
const FETCH_TIMEOUT_MS = 12_000;
const MAX_BYTES = 3 * 1024 * 1024;

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

let streams = new Map();
let packMtime = 0;

function loadPack() {
  try {
    const { mtimeMs } = fs.statSync(PACK);
    if (mtimeMs === packMtime) return;
    const rows = JSON.parse(fs.readFileSync(PACK, 'utf8'));
    streams = new Map(rows.filter((r) => r?.id && /^https:\/\//.test(r.url || '')).map((r) => [r.id, r.url]));
    packMtime = mtimeMs;
    console.log(`[cctv-snapshot] loaded ${streams.size} cameras from ${path.relative(ROOT, PACK)}`);
  } catch (error) {
    console.warn(`[cctv-snapshot] cannot read pack ${PACK}: ${error.message}`);
  }
}

/** Read the stream until one full JPEG (FFD8 ... FFD9) is buffered. */
export async function firstJpegFrame(url, { timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'gods-eye-view-huckly-snapshot/1.0' },
    });
    if (!res.ok || !res.body) throw new Error(`upstream HTTP ${res.status}`);
    let buf = Buffer.alloc(0);
    for await (const chunk of res.body) {
      buf = Buffer.concat([buf, chunk]);
      const start = buf.indexOf(SOI);
      if (start !== -1) {
        const end = buf.indexOf(EOI, start + 2);
        if (end !== -1) return buf.subarray(start, end + 2);
      }
      if (buf.length > maxBytes) throw new Error('no complete JPEG within size cap');
    }
    throw new Error('stream ended before a complete JPEG');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

const cache = new Map(); // id -> { at, body }
const inflight = new Map(); // id -> Promise<Buffer>

async function snapshot(id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.body;
  if (inflight.has(id)) return inflight.get(id);
  const job = firstJpegFrame(streams.get(id))
    .then((body) => {
      cache.set(id, { at: Date.now(), body });
      return body;
    })
    .catch((error) => {
      // Serve a stale frame rather than hammering a failing upstream.
      if (hit) {
        cache.set(id, { at: Date.now(), body: hit.body });
        return hit.body;
      }
      throw error;
    })
    .finally(() => inflight.delete(id));
  inflight.set(id, job);
  return job;
}

function serve() {
  const server = http.createServer(async (req, res) => {
    const match = /^\/snap\/([A-Za-z0-9._-]+)$/.exec(new URL(req.url, 'http://x').pathname);
    if (req.method !== 'GET' || !match) {
      res.writeHead(404).end();
      return;
    }
    loadPack();
    const id = match[1];
    if (!streams.has(id)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('unknown camera');
      return;
    }
    try {
      const body = await snapshot(id);
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': body.length,
        'Cache-Control': `max-age=${Math.floor(TTL_MS / 1000)}`,
      }).end(body);
    } catch (error) {
      console.warn(`[cctv-snapshot] ${id}: ${error.message}`);
      res.writeHead(502, { 'Content-Type': 'text/plain' }).end('snapshot failed');
    }
  });
  server.listen(PORT, '127.0.0.1', () => {
    loadPack();
    console.log(`[cctv-snapshot] listening on http://127.0.0.1:${PORT} (ttl ${TTL_MS} ms)`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) serve();
