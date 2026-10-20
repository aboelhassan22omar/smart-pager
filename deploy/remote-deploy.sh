#!/usr/bin/env bash
# Runs ON the production server (called by .github/workflows/cd.yml over SSH).
#   usage: echo "$GHCR_TOKEN" | remote-deploy.sh <deploy_path> <ghcr_user> <new_image|-> <health_tries>
# Reads the registry token from stdin. Rolls back APP_IMAGE when /health fails.
set -euo pipefail

DEPLOY_PATH="$1"
GHCR_USER="$2"
NEW_IMAGE="$3"
TRIES="${4:-20}"

cd "$DEPLOY_PATH"
if [ ! -f .env ]; then
  echo "::error::$DEPLOY_PATH/.env is missing. Copy .env.example to .env and fill it in (see README)."
  exit 1
fi
mkdir -p secrets

docker login ghcr.io -u "$GHCR_USER" --password-stdin
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT

PREV_IMAGE="$(grep -E '^APP_IMAGE=' .env | tail -n1 | cut -d= -f2- || true)"

set_image() {
  if grep -qE '^APP_IMAGE=' .env; then
    sed -i "s|^APP_IMAGE=.*|APP_IMAGE=$1|" .env
  else
    printf '\nAPP_IMAGE=%s\n' "$1" >> .env
  fi
}

healthy() {
  for _ in $(seq 1 "$TRIES"); do
    if docker compose exec -T app node -e \
      "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
      >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  return 1
}

if [ "$NEW_IMAGE" != "-" ]; then
  echo "Deploying $NEW_IMAGE (previous: ${PREV_IMAGE:-none})"
  set_image "$NEW_IMAGE"
else
  echo "App image unchanged (${PREV_IMAGE:-none}); applying infra changes only"
fi

docker compose pull
docker compose up -d --remove-orphans

if healthy; then
  echo "Healthy."
  docker image prune -f >/dev/null || true
  exit 0
fi

echo "::error::Health check failed."
docker compose logs --tail=80 app || true
if [ "$NEW_IMAGE" != "-" ] && [ -n "$PREV_IMAGE" ] && [ "$PREV_IMAGE" != "$NEW_IMAGE" ]; then
  echo "Rolling back to $PREV_IMAGE"
  set_image "$PREV_IMAGE"
  docker compose pull app || true
  docker compose up -d --remove-orphans
  if healthy; then
    echo "::warning::Rolled back to $PREV_IMAGE"
  else
    echo "::error::Rollback is unhealthy too"
  fi
fi
exit 1
