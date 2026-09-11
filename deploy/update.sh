#!/usr/bin/env bash
# Pull the fork's main branch and recreate the container when it moved.
# Intended for a systemd timer (deploy/systemd/), safe to run by hand.
#
#   deploy/update.sh            # update if origin/main moved
#   deploy/update.sh --force    # recreate even without new commits
set -euo pipefail

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_dir"

log() { printf '%s [gev-update] %s\n' "$(date -Is)" "$*"; }

# The container runs as the checkout owner so .env / caches keep their owner.
GEV_UID=$(id -u)
GEV_GID=$(id -g)
export GEV_UID GEV_GID

# Accounts outside the docker group fall back to passwordless sudo. sudo resets
# the environment, so pass the compose variables through `env` explicitly.
if docker info >/dev/null 2>&1; then
  DOCKER=(docker)
else
  DOCKER=(sudo -n env "GEV_UID=$GEV_UID" "GEV_GID=$GEV_GID" docker)
fi

compose() {
  "${DOCKER[@]}" compose -f deploy/compose.yaml "$@"
}

git fetch --quiet origin main
local_sha=$(git rev-parse HEAD)
remote_sha=$(git rev-parse origin/main)

if [ "$local_sha" = "$remote_sha" ] && [ "${1:-}" != "--force" ]; then
  log "up to date at ${local_sha:0:7}"
  exit 0
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  log "tracked files modified locally; refusing to pull. Commit to the fork instead."
  git status --short --untracked-files=no
  exit 1
fi

git merge --ff-only --quiet origin/main
log "updated ${local_sha:0:7} -> $(git rev-parse --short HEAD)"

compose up -d --force-recreate

# Wait for the healthcheck (first start may run npm ci for a few minutes).
for _ in $(seq 1 60); do
  status=$("${DOCKER[@]}" inspect -f '{{.State.Health.Status}}' "$(compose ps -q gev)" 2>/dev/null || echo unknown)
  case "$status" in
    healthy) log "healthy"; exit 0 ;;
    unhealthy) break ;;
  esac
  sleep 10
done

log "container not healthy (status: $status). Recent logs:"
compose logs --tail 60 gev
exit 1
