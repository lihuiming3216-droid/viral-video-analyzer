#!/usr/bin/env bash
# Update only the app in the existing production stack. Never initialize MySQL.
set -Eeuo pipefail

fail() { printf '%s\n' "$*" >&2; return 1; }
[[ $# == 2 && ( $1 == --check || $1 == --apply ) && $2 =~ ^[a-f0-9]{40}$ ]] \
  || fail "Usage: update-server.sh --check|--apply <40-character commit SHA>"
mode=$1
revision=$2
deploy_root=${VIRAL_DEPLOY_ROOT:-/opt/viral-video-analyzer}
[[ -d "$deploy_root" ]] || fail "Deployment directory is missing"
deploy_root=$(cd "$deploy_root" && pwd -P)
release_dir="$deploy_root/releases/$revision"
env_file="$deploy_root/.env"
active_compose="$deploy_root/docker-compose.yml"
image="viral-video-analyzer:$revision"

for executable in docker sha256sum flock; do
  command -v "$executable" >/dev/null || fail "Required command is missing: $executable"
done
[[ -s "$env_file" && -f "$active_compose" && -f "$release_dir/docker-compose.yml" ]] \
  || fail "Server env, active configuration, or release bundle is missing"

# Serialize the complete apply/rollback section. --check is strictly read-only.
if [[ $mode == --apply ]]; then
  exec 9>"$deploy_root/.deploy.lock"
  flock -n 9 || fail "Another deployment is in progress"
fi

cd "$release_dir"
sha256sum --check --strict --status release.sha256 || fail "Release checksum verification failed"
compose=(docker compose --project-name viral-video-analyzer --project-directory "$deploy_root" --env-file "$env_file")
VIRAL_APP_IMAGE="$image" "${compose[@]}" -f docker-compose.yml config --quiet

for volume in viral-video-analyzer_mysql_data viral-video-analyzer_viral_data; do
  docker volume inspect "$volume" >/dev/null || fail "Expected production data volume is missing"
done
docker network inspect viral-video-analyzer_default >/dev/null || fail "Expected production network is missing"

check_container() {
  local container=$1 service=$2 destination=$3 volume=$4
  [[ $(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}/{{index .Config.Labels "com.docker.compose.service"}}' "$container") == "viral-video-analyzer/$service" ]] \
    || fail "Container is not owned by the expected Compose project: $container"
  local mounted
  mounted=$(docker inspect --format "{{range .Mounts}}{{if eq .Destination \"$destination\"}}{{.Name}}{{end}}{{end}}" "$container")
  [[ $mounted == "$volume" ]] || fail "Unexpected data volume on $container"
}
check_container viral-mysql mysql /var/lib/mysql viral-video-analyzer_mysql_data
check_container viral-video-analyzer viral-analyzer /app/.data viral-video-analyzer_viral_data
[[ $(docker inspect --format '{{.State.Health.Status}}' viral-mysql) == healthy ]] || fail "MySQL is not healthy"
mysql_state=$(docker inspect --format '{{.Id}}/{{.State.StartedAt}}' viral-mysql)
previous_image=$(docker inspect --format '{{.Image}}' viral-video-analyzer)
[[ $previous_image =~ ^sha256:[a-f0-9]{64}$ ]] || fail "Cannot identify the current application image"

if [[ $mode == --check ]]; then
  printf '%s\n' "Preflight passed; no container, data, configuration, or secret was changed"
  exit 0
fi

docker load --input viral-video-analyzer.tar.gz >/dev/null
[[ $(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image") == "$revision" ]] \
  || fail "Release image revision does not match the requested commit"
cp -p "$active_compose" previous-compose.yml

rollback() {
  trap - ERR INT TERM
  set +e
  printf '%s\n' "Release failed; restoring the previous application image" >&2
  # Covers both legacy fixed :latest and the new configurable image reference.
  if docker tag "$previous_image" viral-video-analyzer:latest \
    && VIRAL_APP_IMAGE="$previous_image" "${compose[@]}" -f previous-compose.yml \
      up -d --no-build --no-deps --pull never --wait --wait-timeout 180 viral-analyzer \
    && install -m 644 previous-compose.yml "$active_compose"; then
    printf '%s\n' "Previous application restored; failed release retained for inspection" >&2
  else
    printf '%s\n' "Automatic application rollback failed; operator attention required" >&2
  fi
  exit 1
}
trap rollback ERR INT TERM

VIRAL_APP_IMAGE="$image" "${compose[@]}" -f docker-compose.yml \
  up -d --no-build --no-deps --pull never --wait --wait-timeout 180 viral-analyzer

# HTTP /api/health alone does not check the database. No model/Feishu calls here.
ready=false
for attempt in {1..10}; do
  if docker exec viral-video-analyzer node /app/deploy/check-runtime.cjs; then
    ready=true
    break
  fi
  sleep 2
done
[[ $ready == true ]] || rollback
[[ $(docker inspect --format '{{.Id}}/{{.State.StartedAt}}' viral-mysql) == "$mysql_state" ]] || rollback
check_container viral-video-analyzer viral-analyzer /app/.data viral-video-analyzer_viral_data

docker tag "$image" viral-video-analyzer:latest
install -m 644 docker-compose.yml "$active_compose"
trap - ERR INT TERM
printf '%s\n' "Application deployed: $revision; MySQL and both data volumes preserved"
# Only the verified transfer archive is disposable; images/data are not pruned.
if ! rm -- "$release_dir/viral-video-analyzer.tar.gz"; then
  printf '%s\n' "Deployment succeeded, but its transfer archive needs manual cleanup" >&2
fi
