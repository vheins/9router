#!/usr/bin/env bash
# 9router launcher — thin wrapper around docker compose.
# Supports SQLite (default) and MariaDB modes via the compose `mariadb` profile.
#
#   ./start.sh              build the local image, then start the stack
#                           (mode from DB_MODE in .env, default sqlite)
#   ./start.sh up           same as above
#   ./start.sh build        build the local app image (9router:local) only
#   ./start.sh down         stop + remove containers (keeps named volumes)
#   ./start.sh down --volumes   also remove named volumes (DESTRUCTIVE)
#   ./start.sh restart      restart the app container
#   ./start.sh logs [svc]   tail logs (svc = 9router | mariadb | headroom; default 9router)
#   ./start.sh migrate      force a one-time SQLite -> MariaDB copy
#   ./start.sh prune        drop dangling images + build cache
#   ./start.sh status       show compose service status
#   ./start.sh help         this help
#
# Image: the app service is BUILT FROM LOCAL SOURCE as image `9router:local`
# (docker-compose.yml `build:` section) rather than pulled from Docker Hub. The
# published `decolua/9router:latest` can lag behind the repo (it predates
# MariaDB support), so `up` always builds first and never runs a stale image.
#
# Dual-mode behaviour:
#   DB_MODE=sqlite  -> app container only, backed by the 9router-data volume.
#   DB_MODE=mariadb -> adds the profile-gated `mariadb` service (mariadb:11
#                      sidecar, 9router-mariadb-data volume) and points the app
#                      at it. On first boot with an existing SQLite file, the app
#                      auto-migrates that data into MariaDB (one-time).
#
# Fast swap: `up` builds the new image BEFORE the running container is
# recreated, so the only gap is the stop -> start swap (a few seconds), not the
# whole build.
#
# This script is a thin wrapper: all container provisioning lives in
# docker-compose.yml. The equivalent raw commands are:
#   sqlite  : docker compose build 9router && docker compose up -d
#   mariadb : docker compose build 9router && docker compose --profile mariadb up -d
set -euo pipefail

# ─── Config (overridable via environment) ────────────────────────────────
ENV_FILE="${ENV_FILE:-.env}"
APP_SERVICE="${APP_SERVICE:-9router}"
APP_IMAGE="${APP_IMAGE:-9router:local}"
MARIA_SERVICE="${MARIA_SERVICE:-mariadb}"
MARIA_CONTAINER="${MARIA_CONTAINER:-9router-mariadb}"
APP_DATA_VOLUME="${APP_DATA_VOLUME:-9router-data}"
MARIA_VOLUME="${MARIA_VOLUME:-9router-mariadb-data}"

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

DB_MODE="${DB_MODE:-sqlite}"

# Global: compose profile flags for the current DB_MODE (populated by profile_args).
PROFILE_ARGS=()

# ─── Helpers ─────────────────────────────────────────────────────────────
usage() {
  # Print the leading comment block (after the shebang, up to first non-comment).
  awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH."
  docker info >/dev/null 2>&1 || die "docker daemon is not reachable (is it running?)."
  docker compose version >/dev/null 2>&1 || die "docker compose (v2) is not available."
}

is_mariadb() {
  case "${DB_MODE,,}" in
    mariadb|mysql) return 0 ;;
    *) return 1 ;;
  esac
}

# Populate PROFILE_ARGS with the compose profile flag for the MariaDB service.
# Sets a global array; empty when DB_MODE is sqlite.
profile_args() {
  PROFILE_ARGS=()
  if is_mariadb; then
    PROFILE_ARGS=(--profile "$MARIA_SERVICE")
  fi
}

# Persist DB_PASSWORD to .env if missing, so it is stable across runs.
# Only relevant in MariaDB mode.
ensure_db_password() {
  is_mariadb || return 0
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

# Map legacy container-name arguments to compose service names (backward compat).
normalize_service() {
  case "${1:-}" in
    "$MARIA_CONTAINER"|9router-mariadb) printf '%s' "$MARIA_SERVICE" ;;
    "") printf '%s' "$APP_SERVICE" ;;
    *) printf '%s' "$1" ;;
  esac
}

# ─── Commands ────────────────────────────────────────────────────────────
# Build the local app image (9router:local) from the current source.
do_build() {
  log "Building local image: ${APP_IMAGE:-9router:local} (from local source)"
  docker compose build "$APP_SERVICE"
  log "Build complete."
}

do_up() {
  ensure_db_password
  profile_args

  if ! is_mariadb; then
    # Switching back to sqlite: drop any lingering MariaDB sidecar (like the
    # old script did) so the two modes never fight over the DB.
    docker compose --profile "$MARIA_SERVICE" rm -sf "$MARIA_SERVICE" >/dev/null 2>&1 || true
  fi

  # --build rebuilds the local image BEFORE the container is recreated, so the
  # running image always matches the current source (and never a stale pull).
  log "Building local image and starting stack (mode: ${DB_MODE})"
  docker compose "${PROFILE_ARGS[@]}" up -d --build
  log "Up. App: http://localhost:20128"
  if is_mariadb; then
    log "MariaDB sidecar: service=${MARIA_SERVICE} db=${DB_NAME:-9router} user=${DB_USER:-9router}"
    log "Note: an existing SQLite file (if any) is auto-migrated into MariaDB on first boot."
  fi
}

do_down() {
  local purge=0
  case "${1:-}" in
    --volumes|-v) purge=1 ;;
  esac
  # Always include the mariadb profile so a sidecar started in MariaDB mode is
  # also torn down (plain `docker compose down` leaves profiled services running).
  if [ "$purge" -eq 1 ]; then
    warn "Removing named volumes (${APP_DATA_VOLUME}, ${MARIA_VOLUME}) — DATA WILL BE LOST"
    docker compose --profile "$MARIA_SERVICE" down -v
  else
    docker compose --profile "$MARIA_SERVICE" down
  fi
  log "Down."
}

do_restart() {
  profile_args
  if [ -n "$(docker compose "${PROFILE_ARGS[@]}" ps -aq "$APP_SERVICE" 2>/dev/null)" ]; then
    log "Restarting service: $APP_SERVICE"
    docker compose "${PROFILE_ARGS[@]}" restart "$APP_SERVICE"
  else
    warn "App container not found; running 'up' instead."
    do_up
  fi
}

do_logs() {
  local svc
  svc="$(normalize_service "${1:-}")"
  profile_args
  # A request for the mariadb service needs the profile even in sqlite mode.
  if [ "$svc" = "$MARIA_SERVICE" ] && ! is_mariadb; then
    PROFILE_ARGS=(--profile "$MARIA_SERVICE")
  fi
  docker compose "${PROFILE_ARGS[@]}" logs -f "$svc"
}

do_status() {
  profile_args
  docker compose "${PROFILE_ARGS[@]}" ps -a
}

do_migrate() {
  ensure_db_password
  if [ -z "$(docker compose --profile "$MARIA_SERVICE" ps --status running -q "$MARIA_SERVICE" 2>/dev/null)" ]; then
    die "MariaDB is not running. Start MariaDB mode first: DB_MODE=mariadb ./start.sh up"
  fi
  log "Forcing SQLite -> MariaDB migration on next boot"
  # Drop the guard marker so migrate.js re-runs the copy.
  docker compose --profile "$MARIA_SERVICE" run --rm --no-deps \
    --entrypoint sh "$APP_SERVICE" -c 'rm -f /app/data/db/.migrated-to-mariadb' >/dev/null 2>&1 || true
  # Recreate the app with DB_MIGRATE_FORCE=1 (compose reads it via interpolation).
  DB_MIGRATE_FORCE=1 docker compose --profile "$MARIA_SERVICE" up -d --force-recreate "$APP_SERVICE"
  log "Restarted app; migration will run on boot."
}

do_prune() {
  log "Removing dangling images..."
  docker image prune -f >/dev/null 2>&1 || true
  warn "docker builder prune clears BuildKit cache for ALL projects on this host (next builds may be slower)."
  docker builder prune -f >/dev/null 2>&1 || true
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
    up|"")     do_up ;;
    build)     do_build ;;
    down)      do_down "${1:-}" ;;
    restart)   do_restart ;;
    logs)      do_logs "${1:-}" ;;
    migrate)   do_migrate ;;
    prune)     do_prune ;;
    status)    do_status ;;
    *)         die "Unknown command: $cmd (try './start.sh help')" ;;
  esac
}

main "$@"
