#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DOCKER_DIR="$REPO_ROOT/docker"

echo "==> Setting up traffic-one edge function"

# 1. Copy edge function files into the Docker volumes directory
# (Symlinks don't work because the target is outside the Docker mount)
FUNC_TARGET="$DOCKER_DIR/volumes/functions/traffic-one"
if [ -L "$FUNC_TARGET" ]; then
  rm "$FUNC_TARGET"
fi
rm -rf "$FUNC_TARGET"
cp -r "$SCRIPT_DIR/functions" "$FUNC_TARGET"
echo "    Copied function to: $FUNC_TARGET"

# 2. Check that TRAFFIC_DB_URL is in docker-compose.yml
if grep -q "TRAFFIC_DB_URL" "$DOCKER_DIR/docker-compose.yml"; then
  echo "    TRAFFIC_DB_URL already in docker-compose.yml"
else
  echo "    WARNING: TRAFFIC_DB_URL not found in docker-compose.yml"
  echo "    Please add it to the functions service environment section:"
  echo '    TRAFFIC_DB_URL: postgresql://traffic_api:${TRAFFIC_API_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}'
fi

# 3. Generate TRAFFIC_API_PASSWORD if not set in .env
ENV_FILE="$DOCKER_DIR/.env"
if [ -f "$ENV_FILE" ] && grep -q "TRAFFIC_API_PASSWORD" "$ENV_FILE"; then
  echo "    TRAFFIC_API_PASSWORD already in .env"
else
  TRAFFIC_API_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)
  echo "" >> "$ENV_FILE"
  echo "# Traffic API restricted role password" >> "$ENV_FILE"
  echo "TRAFFIC_API_PASSWORD=$TRAFFIC_API_PASSWORD" >> "$ENV_FILE"
  echo "    Generated TRAFFIC_API_PASSWORD in .env"
fi

# Source the .env file for variable expansion
set -a
source "$ENV_FILE"
set +a

# 4. Run SQL migrations
echo "==> Running migrations"
SUPERUSER_DB_URL="postgresql://postgres:${POSTGRES_PASSWORD}@${POSTGRES_HOST:-127.0.0.1}:${POSTGRES_PORT:-5432}/${POSTGRES_DB:-postgres}"

TRAFFIC_API_PASS="${TRAFFIC_API_PASSWORD:-changeme}"

for migration in "$SCRIPT_DIR"/migrations/*.sql; do
  echo "    Running: $(basename "$migration")"
  psql "$SUPERUSER_DB_URL" \
    -v traffic_api_pass="$TRAFFIC_API_PASS" \
    -f "$migration" 2>&1 | sed 's/^/    /'
done

# 5. Restart relevant containers
echo "==> Restarting kong and functions containers"
cd "$DOCKER_DIR"
docker compose restart kong functions 2>&1 | sed 's/^/    /'

echo "==> Done! traffic-one edge function deployed."
echo "    Test: curl http://localhost:8000/api/platform/profile"
