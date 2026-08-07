#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
git fetch origin
git reset --hard origin/main
docker compose up -d --build --remove-orphans
docker image prune -f
docker compose ps
