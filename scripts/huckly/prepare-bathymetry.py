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

Requires: numpy, tifffile, imagecodecs (the rasters are LZW-compressed).
Usage   : python scripts/huckly/prepare-bathymetry.py [--step 2]
          --step N keeps every N-th pixel (2 -> ~20 m grid), after an NxN
          median that ignores NoData.
"""
import argparse
import glob
import json
import os
import re
import warnings
import zipfile
from datetime import datetime, timezone

import numpy as np
import tifffile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
RAW = os.path.join(ROOT, "output", "huckly-bathy", "raw")
WEB = os.path.join(ROOT, "output", "huckly-bathy", "web")
ATTRIBUTION = "© 2018-2023 Allen Coral Atlas Partnership and Arizona State University (CC BY 4.0)"


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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--step", type=int, default=2)
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
            "maxDepthCm": int(valid.max()) if valid.size else 0,
            "medianDepthCm": int(np.median(valid)) if valid.size else 0,
        }
        index["areas"].append(entry)
        print(f"[bathy] {area_id}: {rows}x{cols} cells, {valid.size} with depth, "
              f"max {entry['maxDepthCm'] / 100:.1f} m")
    with open(os.path.join(WEB, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(index, fh, ensure_ascii=False, indent=2)
    print(f"[bathy] wrote {len(index['areas'])} areas -> {os.path.relpath(WEB, ROOT)}")


if __name__ == "__main__":
    main()
