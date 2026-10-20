#!/bin/sh
# Run on the NAS from the repository copy: cd /volume4/v4/toll-sim/src && sh deploy/nas.sh <command>
#
#   secrets   create ../.env with fresh random secrets (only if it doesn't exist)
#   up        build the images and start (or update) everything
#   down      stop everything (data is kept)
#   ps        status
#   logs      follow logs (add a service name: sh deploy/nas.sh logs sim)
#   reset     wipe the demo database now (it also happens nightly at 03:00 CAT)
set -eu

DATA_DIR=${DATA_DIR:-/volume4/v4/toll-sim}
ENV_FILE="$DATA_DIR/.env"
cd "$(dirname "$0")/.."
compose() { DATA_DIR="$DATA_DIR" docker compose -p toll-sim --env-file "$ENV_FILE" -f deploy/docker-compose.nas.yml "$@"; }

secrets() {
  if [ -f "$ENV_FILE" ]; then echo "$ENV_FILE exists; leaving it alone"; return; fi
  umask 077
  {
    echo "# Generated on $(date -u +%Y-%m-%dT%H:%MZ). Never commit or share."
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 32)"
    echo "ADMIN_API_KEY=$(openssl rand -hex 32)"
    echo "INGEST_API_KEY=$(openssl rand -hex 32)"
    echo "MOMO_WEBHOOK_SECRET=$(openssl rand -hex 32)"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "wrote $ENV_FILE"
}

case "${1:-}" in
  secrets) secrets ;;
  up)
    secrets
    mkdir -p "$DATA_DIR/pg" "$DATA_DIR/sim-data" && chmod 0777 "$DATA_DIR/sim-data"
    compose up -d --build --remove-orphans
    docker image prune -f >/dev/null
    compose ps
    ;;
  down) compose down ;;
  ps) compose ps ;;
  logs) shift; compose logs -f --tail 100 "$@" ;;
  reset)
    compose stop sim
    compose exec db psql -U toll -d toll -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
    compose restart api
    compose start sim
    ;;
  *) sed -n '2,11p' "$0"; exit 1 ;;
esac
