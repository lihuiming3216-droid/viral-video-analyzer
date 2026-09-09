#!/usr/bin/env bash
# CI only: all names and disposable data are separate from production.
set -euo pipefail
[[ $# == 1 ]] || { echo "Usage: smoke-test.sh <local image>" >&2; exit 1; }
image=$1
suffix="$$"
network="viral-ci-$suffix"
mysql_container="viral-ci-mysql-$suffix"
app_container="viral-ci-app-$suffix"
cleanup() {
  docker rm -f -v "$app_container" "$mysql_container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
# Test containers can reach each other, never production or paid providers.
docker network create --internal "$network" >/dev/null
docker run -d --name "$mysql_container" --network "$network" --network-alias mysql \
  -e MYSQL_ROOT_PASSWORD=isolated-ci-only -e MYSQL_ROOT_HOST=% -e MYSQL_DATABASE=viral_video_analyzer \
  --health-cmd='MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -h127.0.0.1 -uroot -e "SELECT 1" >/dev/null 2>&1' \
  --health-interval=2s --health-timeout=3s --health-retries=40 mysql:8.0.46 >/dev/null
mysql_ready=false
for attempt in {1..60}; do
  if [[ $(docker inspect --format '{{.State.Health.Status}}' "$mysql_container") == healthy ]]; then
    mysql_ready=true
    break
  fi
  sleep 2
done
[[ $mysql_ready == true ]] || { echo "CI MySQL did not become healthy" >&2; exit 1; }
docker run -d --name "$app_container" --network "$network" \
  --tmpfs /app/.data:rw -e MYSQL_HOST=mysql -e MYSQL_USER=root \
  -e MYSQL_PASSWORD=isolated-ci-only -e MYSQL_DATABASE=viral_video_analyzer "$image" >/dev/null
for attempt in {1..30}; do
  if docker exec "$app_container" node /app/deploy/check-runtime.cjs; then
    echo "Isolated MySQL/application smoke test passed"
    exit 0
  fi
  sleep 2
done
echo "Isolated application smoke test failed" >&2
exit 1
