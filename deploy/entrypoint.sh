#!/bin/sh
# Container entrypoint: reinstall dependencies only when package-lock.json
# changed since the last install, then run the Vite dev server in foreground.
set -eu
cd /app

stamp=node_modules/.gev-lock-sha256
want=$(sha256sum package-lock.json | cut -d' ' -f1)

if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$want" ]; then
  echo "[entrypoint] package-lock.json changed -> npm ci"
  npm ci --no-audit --no-fund
  echo "$want" > "$stamp"
else
  echo "[entrypoint] dependencies up to date"
fi

# Snapshot sidecar for MJPEG-only CCTV packs (restarts itself if it crashes).
(
  while true; do
    node deploy/cctv-snapshot.mjs || true
    echo "[entrypoint] cctv-snapshot exited, restarting in 5s"
    sleep 5
  done
) &

exec node node_modules/vite/bin/vite.js --strictPort
