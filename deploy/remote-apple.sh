#!/usr/bin/env bash
# Runs ON the production server (called by .github/workflows/apple-config.yml over SSH).
#   usage: printf '%s' "$P8" | remote-apple.sh <deploy_path> <team_id> <key_id> <app_id|-> <apns_env> <previous_team_id|->
# Installs the APNs key (read from stdin) as secrets/AuthKey.p8, readable only by the app's
# user (uid 1000, "node"), writes the Apple values into .env and recreates the app container.
set -euo pipefail

DEPLOY_PATH="$1"
TEAM_ID="$2"
KEY_ID="$3"
APP_ID="$4"
APNS_ENV="$5"
PREVIOUS_TEAM_ID="$6"

fail() { echo "::error::$1"; exit 1; }
[[ "$TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || fail "team id must be 10 letters/digits"
[[ "$KEY_ID" =~ ^[A-Z0-9]{10}$ ]] || fail "key id must be 10 letters/digits"
[[ "$APP_ID" = "-" || "$APP_ID" =~ ^[0-9]{6,12}$ ]] || fail "app id must be the numeric App Store ID"
[[ "$APNS_ENV" = production || "$APNS_ENV" = sandbox ]] || fail "apns env must be production or sandbox"
[[ "$PREVIOUS_TEAM_ID" = "-" || "$PREVIOUS_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || fail "previous team id must be 10 letters/digits"

cd "$DEPLOY_PATH"
[ -f .env ] || fail "$DEPLOY_PATH/.env is missing"
mkdir -p secrets

key="$(cat)"
[[ "$key" == *"BEGIN PRIVATE KEY"* ]] || fail "APNS_KEY_P8 does not look like a .p8 key"

image="$(grep -E '^APP_IMAGE=' .env | tail -n1 | cut -d= -f2-)"
[ -n "$image" ] || fail "APP_IMAGE is not set in .env"

# Root inside a throwaway container of the app image (deploy is in the docker group, no sudo):
# the key never lands on the host readable by anyone but uid 1000.
printf '%s\n' "$key" | docker run --rm -i -u 0 -v "$DEPLOY_PATH/secrets:/s" --entrypoint sh "$image" -c \
  'umask 077 && cat > /s/.AuthKey.p8.new && chown 1000:1000 /s/.AuthKey.p8.new && chmod 400 /s/.AuthKey.p8.new && mv -f /s/.AuthKey.p8.new /s/AuthKey.p8'
echo "APNs key installed (secrets/AuthKey.p8, uid 1000, 0400)"

[ -z "$(tail -c1 .env)" ] || echo >> .env
set_kv() {
  if grep -qE "^$1=" .env; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}
set_kv APPLE_TEAM_ID "$TEAM_ID"
set_kv APNS_KEY_ID "$KEY_ID"
set_kv APNS_KEY_PATH /secrets/AuthKey.p8
set_kv APNS_ENV "$APNS_ENV"
[ "$APP_ID" = "-" ] || set_kv APPLE_APP_ID "$APP_ID"
if [ "$PREVIOUS_TEAM_ID" = "-" ]; then set_kv APPLE_PREVIOUS_TEAM_ID ""; else set_kv APPLE_PREVIOUS_TEAM_ID "$PREVIOUS_TEAM_ID"; fi
echo "Apple settings written to .env"

docker compose up -d --no-deps --force-recreate app

for _ in $(seq 1 20); do
  if docker compose exec -T app node -e \
    "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1; then
    echo "Healthy."
    if docker compose logs --since 2m app 2>&1 | grep -q 'APNs key could not be loaded'; then
      fail "the app could not read the APNs key"
    fi
    exit 0
  fi
  sleep 3
done
docker compose logs --tail=60 app || true
fail "app is not healthy after the Apple settings change"
