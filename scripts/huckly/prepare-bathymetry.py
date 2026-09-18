#!/usr/bin/env python3
"""huckly fork: convert Allen Coral Atlas bathymetry downloads for the seabed overlay.

Input : output/huckly-bathy/raw/<Area>-<timestamp>.zip (or extracted folders), as
        delivered by the Atlas "Download data" e-mail. Only the
        "Bathymetry---composite-depth/bathymetry_*.tif" rasters are used.
        Format verified 2026-09-18: int16 GeoTIFF, EPSG:4326, ~10 m pixels,
        positive depth in centimetres, NoData 0.
Output: output/huckly-bathy/web/<area>.bin   int16 little-endian depth (cm), row-major,
                                           north-to-south, 0 = no data
        output/huckly-bathy/web/index.json  grid metadata for every area
Both stay under the gitignored output/ tree: the data is licensed CC BY 4.0 but the
Atlas site terms restrict redistribution, so it is never committed to the fork.

Shore fill: the Atlas has no depth for the surf strip next to the beach (20-60 m
wide), so the seabed stopped short of the shore. Depth is grown outward from the
measured cells, shoaling toward 0, for up to SHORE_FILL_PASSES cells, and never
across the OpenStreetMap coastline (natural=coastline, fetched once per area
from Overpass and cached in output/huckly-bathy/coast/). Without a coastline the
area is left unfilled, so the seabed never paints over land.

Requires: numpy, tifffile, imagecodecs (the rasters are LZW-compressed).
Usage   : python scripts/huckly/prepare-bathymetry.py [--step 2] [--no-shore-fill]
          --step N keeps every N-th pixel (2 -> ~20 m grid), after an NxN
          median that ignores NoData.
"""
import argparse
import glob
import json
import os
import re
import urllib.parse
import urllib.request
import warnings
import zipfile
from datetime import datetime, timezone

import numpy as np
import tifffile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
RAW = os.path.join(ROOT, "output", "huckly-bathy", "raw")
WEB = os.path.join(ROOT, "output", "huckly-bathy", "web")
COAST = os.path.join(ROOT, "output", "huckly-bathy", "coast")
ATTRIBUTION = "© 2018-2023 Allen Coral Atlas Partnership and Arizona State University (CC BY 4.0)"
OVERPASS = ("https://overpass.kumi.systems/api/interpreter", "https://overpass-api.de/api/interpreter")
SHORE_FILL_PASSES = 4    # cells (~80 m at 20 m) the fill may reach past measured depth
SHORE_SHOAL = 0.6        # each step toward shore keeps this share of the neighbour depth
SHORE_MIN_CM = 30
SHORE_MAX_EDGE_CM = 600  # only grow from shallow edges (the surf strip), not the deep-water limit


def slug(name):
    base = re.sub(r"-\d{14}$", "", name)
    return re.sub(r"[^a-z0-9]+", "-", base.lower()).strip("-")


def extract_zips():
    for path in glob.glob(os.path.join(RAW, "*.zip")):
        target = path[:-4]
        if not os.path.isdir(target):
            with zipfile.ZipFile(path) as archive:
                archive.extractall(target)


def read_raster(path):
    with tifffile.TiffFile(path) as tif:
        page = tif.pages[0]
        tags = {tag.name: tag.value for tag in page.tags.values()}
        data = page.asarray()
        geo = tif.geotiff_metadata or {}
    if str(geo.get("GeographicTypeGeoKey", "")).split(".")[-1] not in ("4326", "WGS_84"):
        raise ValueError(f"{path}: expected EPSG:4326, got {geo.get('GeographicTypeGeoKey')}")
    scale_x, scale_y = tags["ModelPixelScaleTag"][:2]
    tie = tags["ModelTiepointTag"]
    west, north = tie[3] - tie[0] * scale_x, tie[4] + tie[1] * scale_y
    nodata = int(float(str(tags.get("GDAL_NODATA", "0")).strip()))
    return data.astype(np.int32), west, north, scale_x, scale_y, nodata


def downsample(depth, step):
    if step <= 1:
        return depth
    rows, cols = (depth.shape[0] // step) * step, (depth.shape[1] // step) * step
    blocks = depth[:rows, :cols].reshape(rows // step, step, cols // step, step).swapaxes(1, 2)
    blocks = blocks.reshape(rows // step, cols // step, step * step).astype(np.float64)
    blocks[blocks <= 0] = np.nan
    with np.errstate(all="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # all-NoData blocks -> NaN -> 0
        med = np.nanmedian(blocks, axis=2)
    return np.nan_to_num(med, nan=0).round().astype(np.int32)


def load_coastline(area_id, south, west, north, east):
    """OSM coastline ways inside the grid, as lists of (lon, lat); cached per area."""
    path = os.path.join(COAST, f"{area_id}.json")
    if not os.path.exists(path):
        query = f'[out:json][timeout:60];way["natural"="coastline"]({south},{west},{north},{east});out geom;'
        body = urllib.parse.urlencode({"data": query}).encode()
        last_error = None
        for url in OVERPASS:
            request = urllib.request.Request(url, data=body, headers={
                "User-Agent": "gods-eye-view-huckly-bathy/1.0 (one-time personal download)",
                "Accept": "application/json"})
            try:
                with urllib.request.urlopen(request, timeout=90) as response:
                    payload = json.loads(response.read())
                break
            except Exception as error:  # try the next mirror
                last_error = error
        else:
            print(f"[bathy] {area_id}: coastline unavailable ({last_error}), shore fill skipped")
            return []
        os.makedirs(COAST, exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
    with open(path, encoding="utf-8") as fh:
        payload = json.load(fh)
    return [[(p["lon"], p["lat"]) for p in way.get("geometry", [])] for way in payload.get("elements", [])]


def coastline_cells(ways, rows, cols, west, north, d_lon, d_lat):
    """Cells the coastline passes through (sampled at 1/4 cell, so 8-connected)."""
    barrier = np.zeros((rows, cols), dtype=bool)
    for way in ways:
        for (x0, y0), (x1, y1) in zip(way, way[1:]):
            steps = max(1, int(np.ceil(max(abs(x1 - x0) / d_lon, abs(y1 - y0) / d_lat) * 4)))
            t = np.linspace(0, 1, steps + 1)
            c = np.floor((x0 + (x1 - x0) * t - west) / d_lon).astype(int)
            r = np.floor((north - (y0 + (y1 - y0) * t)) / d_lat).astype(int)
            keep = (r >= 0) & (r < rows) & (c >= 0) & (c < cols)
            barrier[r[keep], c[keep]] = True
    return barrier


def shore_fill(grid, barrier):
    """Grow depth into NoData cells, 4-connected so it cannot slip through an
    8-connected coastline; coastline cells are filled but never grow further."""
    grid = grid.astype(np.float64)
    source = grid > 0
    filled = 0
    for _ in range(SHORE_FILL_PASSES):
        values = np.pad(np.where(source, grid, 0), 1)
        counts = np.pad(source.astype(np.int32), 1)
        total = np.zeros_like(grid)
        n = np.zeros(grid.shape, dtype=np.int32)
        for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            total += values[1 + dr:1 + dr + grid.shape[0], 1 + dc:1 + dc + grid.shape[1]]
            n += counts[1 + dr:1 + dr + grid.shape[0], 1 + dc:1 + dc + grid.shape[1]]
        with np.errstate(invalid="ignore", divide="ignore"):
            mean = total / n
        grow = (grid <= 0) & (n > 0) & (mean <= SHORE_MAX_EDGE_CM)
        if not grow.any():
            break
        grid[grow] = np.maximum(SHORE_MIN_CM, mean[grow] * SHORE_SHOAL)
        source = source | (grow & ~barrier)
        filled += int(grow.sum())
    return grid.round().astype(np.int32), filled


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--step", type=int, default=2)
    parser.add_argument("--no-shore-fill", action="store_true")
    args = parser.parse_args()

    extract_zips()
    os.makedirs(WEB, exist_ok=True)
    index = {"attribution": ATTRIBUTION, "units": "cm", "nodata": 0,
             "generatedAt": datetime.now(timezone.utc).isoformat(), "areas": []}
    for tif in sorted(glob.glob(os.path.join(RAW, "*", "Bathymetry*", "bathymetry_*.tif"))):
        area_dir = os.path.basename(os.path.dirname(os.path.dirname(tif)))
        area_id = slug(area_dir)
        depth, west, north, sx, sy, nodata = read_raster(tif)
        depth[depth == nodata] = 0
        depth[depth < 0] = 0
        grid = downsample(depth, args.step)
        rows, cols = grid.shape
        out_sx, out_sy = sx * args.step, sy * args.step
        measured = int((grid > 0).sum())
        filled = 0
        if not args.no_shore_fill:
            ways = load_coastline(area_id, north - rows * out_sy, west, north, west + cols * out_sx)
            if ways:
                barrier = coastline_cells(ways, rows, cols, west, north, out_sx, out_sy)
                grid, filled = shore_fill(grid, barrier)
        grid.astype("<i2").tofile(os.path.join(WEB, f"{area_id}.bin"))
        valid = grid[grid > 0]
        entry = {
            "id": area_id,
            "source": area_dir,
            "file": f"{area_id}.bin",
            "rows": rows,
            "cols": cols,
            "west": west,
            "north": north,
            "dLon": out_sx,
            "dLat": out_sy,
            "validCells": int(valid.size),
            "measuredCells": measured,
            "shoreFilledCells": filled,
            "maxDepthCm": int(valid.max()) if valid.size else 0,
            "medianDepthCm": int(np.median(valid)) if valid.size else 0,
        }
        index["areas"].append(entry)
        print(f"[bathy] {area_id}: {rows}x{cols} cells, {measured} measured + {filled} shore-filled, "
              f"max {entry['maxDepthCm'] / 100:.1f} m")
    with open(os.path.join(WEB, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(index, fh, ensure_ascii=False, indent=2)
    print(f"[bathy] wrote {len(index['areas'])} areas -> {os.path.relpath(WEB, ROOT)}")


if __name__ == "__main__":
    main()
