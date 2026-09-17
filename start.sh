#!/usr/bin/env bash
# 9router launcher — supports SQLite (default) and MariaDB modes.
#
#   ./start.sh              build + run (mode from DB_MODE in .env, default sqlite)
#   ./start.sh up           same as above
#   ./start.sh down         stop + remove app (and MariaDB sidecar)
#   ./start.sh down --volumes   also remove named volumes (DESTRUCTIVE)
#   ./start.sh restart      recreate the app container
#   ./start.sh logs [svc]   tail logs (svc = 9router | 9router-mariadb)
#   ./start.sh migrate      force a one-time SQLite -> MariaDB copy
#   ./start.sh prune        drop dangling 9router images + build cache + idle network
#   ./start.sh status       show container status
#   ./start.sh help         this help
#
# Dual-mode behaviour:
#   DB_MODE=sqlite  -> app container with a local SQLite file (named volume 9router-data)
#   DB_MODE=mariadb -> MariaDB sidecar container + app container pointed at it.
#                      On first boot with an existing SQLite file, the app
#                      auto-migrates that data into MariaDB (one-time).
#
# Fast swap (near-zero downtime): the image is built BEFORE the running
# container is replaced, so the only gap is the stop -> start swap (a few
# seconds), not the whole build. `up` waits until the app accepts connections.
set -euo pipefail

# ─── Config (overridable via environment) ────────────────────────────────
ENV_FILE="${ENV_FILE:-.env}"

# ─── Helpers ─────────────────────────────────────────────────────────────
log()  { printf '\033[1;36m[9router]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[9router]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[9router] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Load .env WITHOUT clobbering already-set environment variables.
# Handles: KEY=value, KEY="value with spaces", KEY='value', comments, blank lines.
# Runs BEFORE defaults are applied so .env values take effect.
load_env() {
  [ -f "$ENV_FILE" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    # strip leading whitespace
    line="${line#"${line%%[![:space:]]*}"}"
    # skip blanks and comments
    case "$line" in ""|\#*) continue ;; esac
    # must look like KEY=...
    case "$line" in *=*) ;; *) continue ;; esac
    # strip an optional leading "export "
    line="${line#export }"
    local key="${line%%=*}"
    local val="${line#*=}"
    # trim key whitespace
    key="${key%"${key##*[![:space:]]}"}"
    [ -n "$key" ] || continue
    # strip surrounding quotes from value
    case "$val" in
      \"*\") val="${val#\"}"; val="${val%\"}" ;;
      \'*\') val="${val#\'}"; val="${val%\'}" ;;
    esac
    # only set if not already present in the environment
    if [ -z "${!key+x}" ]; then
      export "$key=$val"
    fi
  done < "$ENV_FILE"
}

load_env

# ─── Config defaults (env / .env values win) ─────────────────────────────
APP_NAME="${APP_NAME:-9router}"
APP_IMAGE="${APP_IMAGE:-9router}"
APP_PORT="${PORT:-20128}"
APP_DATA_VOLUME="${APP_DATA_VOLUME:-9router-data}"

MARIA_IMAGE="${MARIA_IMAGE:-mariadb:11}"
MARIA_CONTAINER="${MARIA_CONTAINER:-9router-mariadb}"
MARIA_VOLUME="${MARIA_VOLUME:-9router-mariadb-data}"
NETWORK="${NETWORK:-9router-net}"

DB_MODE="${DB_MODE:-sqlite}"
DB_NAME="${DB_NAME:-9router}"
DB_USER="${DB_USER:-9router}"

DB_PORT="${DB_PORT:-3306}"
MARIA_HOST_PORT="${MARIA_HOST_PORT:-$DB_PORT}"

# When true, also prune BuildKit cache older than 7 days after each build.
PRUNE_BUILD_CACHE="${PRUNE_BUILD_CACHE:-false}"

# ─── Helpers ─────────────────────────────────────────────────────────────
usage() {
  # Print the leading comment block (after the shebang, up to first non-comment).
  awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH."
  docker info >/dev/null 2>&1 || die "docker daemon is not reachable (is it running?)."
}

container_exists() { docker ps -a --format '{{.Names}}' | grep -qx "$1"; }
container_running() { docker ps --format '{{.Names}}' | grep -qx "$1"; }

ensure_network() {
  if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
    log "Creating docker network: $NETWORK"
    docker network create "$NETWORK" >/dev/null
  fi
}

stop_app() {
  if container_exists "$APP_NAME"; then
    log "Stopping app container: $APP_NAME"
    docker stop "$APP_NAME" >/dev/null 2>&1 || true
    docker rm "$APP_NAME" >/dev/null 2>&1 || true
  fi
}

stop_maria() {
  if container_exists "$MARIA_CONTAINER"; then
    log "Stopping MariaDB container: $MARIA_CONTAINER"
    docker stop "$MARIA_CONTAINER" >/dev/null 2>&1 || true
    docker rm "$MARIA_CONTAINER" >/dev/null 2>&1 || true
  fi
}

# Remove the previously-tagged app image (now dangling) after a successful swap.
remove_old_image() {
  local old_id="${1:-}"
  [ -n "$old_id" ] || return 0
  local new_id
  new_id="$(docker image inspect -f '{{.Id}}' "$APP_IMAGE" 2>/dev/null || true)"
  if [ -n "$new_id" ] && [ "$old_id" = "$new_id" ]; then
    return 0   # cache hit — same image, nothing to drop
  fi
  docker image rm "$old_id" >/dev/null 2>&1 || true
}

# Prune ONLY dangling images that belong to this project (label-scoped, safe).
cleanup_dangling() {
  docker image prune -f --filter "label=com.9router.managed=true" >/dev/null 2>&1 || true
}

# Remove the project network if no containers are attached to it.
cleanup_network() {
  docker network inspect "$NETWORK" >/dev/null 2>&1 || return 0
  local attached
  attached="$(docker network inspect -f '{{len .Containers}}' "$NETWORK" 2>/dev/null || echo 0)"
  if [ "$attached" = "0" ]; then
    docker network rm "$NETWORK" >/dev/null 2>&1 || true
  fi
}

# Persist DB_PASSWORD to .env if missing, so it is stable across runs.
ensure_db_password() {
  if [ -n "${DB_PASSWORD:-}" ]; then return 0; fi
  # try to read a previously-generated value from .env
  if [ -f "$ENV_FILE" ] && grep -qE '^DB_PASSWORD=' "$ENV_FILE"; then
    DB_PASSWORD="$(grep -E '^DB_PASSWORD=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
  fi
  if [ -z "${DB_PASSWORD:-}" ]; then
    DB_PASSWORD="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24 || true)"
    log "Generated DB_PASSWORD and appending to $ENV_FILE"
    {
      echo ""
      echo "# Auto-generated by start.sh (MariaDB mode)"
      echo "DB_MODE=mariadb"
      echo "DB_PASSWORD=$DB_PASSWORD"
    } >> "$ENV_FILE"
  fi
  export DB_PASSWORD
}

# Wait until the MariaDB sidecar accepts connections.
wait_for_maria() {
  local tries=0 max=60
  log "Waiting for MariaDB to be ready..."
  until docker exec "$MARIA_CONTAINER" mariadb-admin ping -h 127.0.0.1 -P "${DB_PORT}" -u root -p"${DB_ROOT_PASSWORD}" >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge "$max" ]; then
      die "MariaDB did not become ready in time (${max} attempts). Check: docker logs $MARIA_CONTAINER"
    fi
    printf '.'
    sleep 2
  done
  printf '\n'
  log "MariaDB is ready."
}

# Poll the published app port until it accepts connections (or timeout).
# Uses bash's built-in /dev/tcp so it needs no host curl/wget.
wait_for_app() {
  local tries=0 max=60
  log "Waiting for app to be ready on port ${APP_PORT}..."
  until (echo >"/dev/tcp/127.0.0.1/${APP_PORT}") 2>/dev/null; do
    tries=$((tries + 1))
    if [ "$tries" -ge "$max" ]; then
      warn "App did not accept connections within $((max * 2))s — check: docker logs $APP_NAME"
      return 0
    fi
    printf '.'
    sleep 2
  done
  printf '\n'
  log "App is ready."
}

# ─── Modes ───────────────────────────────────────────────────────────────
run_sqlite() {
  log "Mode: sqlite"
  # Clean up any MariaDB sidecar so switching back to sqlite is clean.
  stop_maria

  # Remember the current image so we can drop it after a successful swap
  # (re-tagging below would otherwise leave it behind as <none>:<none>).
  local old_image_id
  old_image_id="$(docker image inspect -f '{{.Id}}' "$APP_IMAGE" 2>/dev/null || true)"

  # Build the new image FIRST while the current container keeps serving,
  # so the only gap is the stop -> start swap (a few seconds), not the build.
  log "Building image: $APP_IMAGE"
  docker build -t "$APP_IMAGE" --label com.9router.managed=true .

  stop_app
  log "Starting app container (sqlite) on port $APP_PORT"
  docker run -d --name "$APP_NAME" \
    -p "${APP_PORT}:20128" \
    --env-file "$ENV_FILE" \
    -e DB_MODE=sqlite \
    -v "${APP_DATA_VOLUME}:/app/data" \
    "$APP_IMAGE" >/dev/null
  wait_for_app
  remove_old_image "$old_image_id"
  cleanup_dangling
  if [ "${PRUNE_BUILD_CACHE:-false}" = "true" ]; then
    docker builder prune -f --filter "until=168h" >/dev/null 2>&1 || true
  fi
  log "Up. App: http://localhost:${APP_PORT}"
}

run_mariadb() {
  log "Mode: mariadb"
  ensure_db_password
  DB_ROOT_PASSWORD="${DB_ROOT_PASSWORD:-$DB_PASSWORD}"
  export DB_ROOT_PASSWORD

  ensure_network

  # Create/start the MariaDB sidecar (idempotent; never destroys the volume).
  if container_running "$MARIA_CONTAINER"; then
    log "MariaDB container already running: $MARIA_CONTAINER"
  else
    if container_exists "$MARIA_CONTAINER"; then
      log "Starting existing MariaDB container: $MARIA_CONTAINER"
      docker start "$MARIA_CONTAINER" >/dev/null
    else
      log "Creating MariaDB container: $MARIA_CONTAINER"
      docker run -d --name "$MARIA_CONTAINER" \
        --network "$NETWORK" \
        -p "${MARIA_HOST_PORT}:${DB_PORT}" \
        -v "${MARIA_VOLUME}:/var/lib/mysql" \
        -e MARIADB_ROOT_PASSWORD="$DB_ROOT_PASSWORD" \
        -e MARIADB_DATABASE="$DB_NAME" \
        -e MARIADB_USER="$DB_USER" \
        -e MARIADB_PASSWORD="$DB_PASSWORD" \
        "$MARIA_IMAGE" \
        --port="${DB_PORT}" \
        --character-set-server=utf8mb4 \
        --collation-server=utf8mb4_unicode_ci >/dev/null
    fi
  fi

  wait_for_maria

  # Remember the current image so we can drop it after a successful swap.
  local old_image_id
  old_image_id="$(docker image inspect -f '{{.Id}}' "$APP_IMAGE" 2>/dev/null || true)"

  # Build the new image FIRST while the current container keeps serving,
  # so the only gap is the stop -> start swap (a few seconds), not the build.
  log "Building image: $APP_IMAGE"
  docker build -t "$APP_IMAGE" --label com.9router.managed=true .

  stop_app
  log "Starting app container (mariadb) on port $APP_PORT"
  docker run -d --name "$APP_NAME" \
    --network "$NETWORK" \
    -p "${APP_PORT}:20128" \
    --env-file "$ENV_FILE" \
    -e DB_MODE=mariadb \
    -e DB_HOST="$MARIA_CONTAINER" \
    -e DB_PORT="$DB_PORT" \
    -e DB_USER="$DB_USER" \
    -e DB_PASSWORD="$DB_PASSWORD" \
    -e DB_NAME="$DB_NAME" \
    -v "${APP_DATA_VOLUME}:/app/data" \
    "$APP_IMAGE" >/dev/null

  wait_for_app
  remove_old_image "$old_image_id"
  cleanup_dangling
  if [ "${PRUNE_BUILD_CACHE:-false}" = "true" ]; then
    docker builder prune -f --filter "until=168h" >/dev/null 2>&1 || true
  fi
  log "Up. App: http://localhost:${APP_PORT}"
  log "MariaDB: host=${MARIA_CONTAINER} port=${DB_PORT} db=${DB_NAME} user=${DB_USER}"
  log "Note: an existing SQLite file (if any) is auto-migrated into MariaDB on first boot."
}

force_migrate() {
  log "Forcing SQLite -> MariaDB migration on next boot"
  ensure_db_password
  ensure_network
  if ! container_running "$MARIA_CONTAINER"; then
    die "MariaDB container '$MARIA_CONTAINER' is not running. Run './start.sh' with DB_MODE=mariadb first."
  fi
  # Drop the guard marker so migrate.js re-runs the copy, then restart the app.
  docker run --rm -v "${APP_DATA_VOLUME}:/app/data" alpine \
    sh -c 'rm -f /app/data/db/.migrated-to-mariadb' >/dev/null 2>&1 || true

  DB_ROOT_PASSWORD="${DB_ROOT_PASSWORD:-$DB_PASSWORD}"
  stop_app
  docker run -d --name "$APP_NAME" \
    --network "$NETWORK" \
    -p "${APP_PORT}:20128" \
    --env-file "$ENV_FILE" \
    -e DB_MODE=mariadb \
    -e DB_HOST="$MARIA_CONTAINER" \
    -e DB_PORT="$DB_PORT" \
    -e DB_USER="$DB_USER" \
    -e DB_PASSWORD="$DB_PASSWORD" \
    -e DB_NAME="$DB_NAME" \
    -e DB_MIGRATE_FORCE=1 \
    -v "${APP_DATA_VOLUME}:/app/data" \
    "$APP_IMAGE" >/dev/null
  wait_for_app
  log "Restarted app; migration will run on boot."
}

do_down() {
  local purge=0
  [ "${1:-}" = "--volumes" ] && purge=1
  stop_app
  stop_maria
  cleanup_network
  if [ "$purge" -eq 1 ]; then
    warn "Removing named volumes (${APP_DATA_VOLUME}, ${MARIA_VOLUME}) — DATA WILL BE LOST"
    docker volume rm "$APP_DATA_VOLUME" "$MARIA_VOLUME" >/dev/null 2>&1 || true
  fi
  log "Down."
}

do_logs() {
  local svc="${1:-$APP_NAME}"
  docker logs -f "$svc"
}

do_status() {
  docker ps -a --filter "name=${APP_NAME}" --filter "name=${MARIA_CONTAINER}" \
    --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
}

do_prune() {
  log "Removing dangling 9router images..."
  cleanup_dangling
  warn "docker builder prune clears BuildKit cache for ALL projects on this host (next builds may be slower)."
  docker builder prune -f >/dev/null 2>&1 || true
  cleanup_network
  log "Pruned."
}

# ─── Main ────────────────────────────────────────────────────────────────
main() {
  local cmd="${1:-up}"
  shift || true

  # `help` works without docker.
  if [ "$cmd" = "help" ] || [ "$cmd" = "-h" ] || [ "$cmd" = "--help" ]; then
    usage
    exit 0
  fi

  require_docker

  case "$cmd" in
    up|"")
      case "$DB_MODE" in
        mariadb|mysql) run_mariadb ;;
        *) run_sqlite ;;
      esac
      ;;
    down)      do_down "${1:-}" ;;
    restart)
      if container_exists "$APP_NAME"; then
        docker start "$APP_NAME" >/dev/null && log "Restarted app container."
      else
        warn "App container not found; running 'up' instead."
        case "$DB_MODE" in
          mariadb|mysql) run_mariadb ;;
          *) run_sqlite ;;
        esac
      fi
      ;;
    logs)      do_logs "${1:-}" ;;
    migrate)   force_migrate ;;
    prune)     do_prune ;;
    status)    do_status ;;
    *)         die "Unknown command: $cmd (try './start.sh help')" ;;
  esac
}

main "$@"
