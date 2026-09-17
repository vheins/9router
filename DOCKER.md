# Docker

Run 9Router in a container. Published image: [`decolua/9router`](https://hub.docker.com/r/decolua/9router) — multi-platform `linux/amd64` + `linux/arm64`.

---

# 👤 For Users

## Quick start

```bash
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  --name 9router \
  decolua/9router:latest
```

App listens on port `20128`. Open: http://localhost:20128

## Manage container

```bash
docker logs -f 9router        # view logs
docker stop 9router           # stop
docker start 9router          # start again
docker rm -f 9router          # remove
```

## Data persistence

```bash
-v "$HOME/.9router:/app/data" \
-e DATA_DIR=/app/data
```

Without `DATA_DIR`, the app falls back to `~/.9router/` (macOS/Linux) or `%APPDATA%\9router\` (Windows). In the container, `DATA_DIR=/app/data` makes the bind mount work.

Data layout under `$DATA_DIR/`:

```text
$DATA_DIR/
├── db/
│   ├── data.sqlite       # main SQLite database
│   └── backups/          # auto backups
└── ...                   # certs, logs, runtime configs
```

Host path: `$HOME/.9router/db/data.sqlite`
Container path: `/app/data/db/data.sqlite`

## Optional env vars

```bash
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  -e PORT=20128 \
  -e HOSTNAME=0.0.0.0 \
  -e DEBUG=true \
  --name 9router \
  decolua/9router:latest
```

## Database modes: SQLite (default) or MariaDB

9Router can store its data in either a local SQLite file or a MariaDB/MySQL
server. The mode is selected with the `DB_MODE` env var (`sqlite` by default).

### SQLite (default)

Nothing to configure — data lives in `$DATA_DIR/db/data.sqlite`. This is the
behaviour of every existing deployment and is fully backward compatible.

### MariaDB mode

Set `DB_MODE=mariadb` and provide the connection details:

```bash
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  -e DB_MODE=mariadb \
  -e DB_HOST=mariadb \
  -e DB_PORT=3306 \
  -e DB_USER=9router \
  -e DB_PASSWORD=change-me \
  -e DB_NAME=9router \
  --name 9router \
  decolua/9router:latest
```

| Env var | Default | Description |
| --- | --- | --- |
| `DB_MODE` | `sqlite` | `sqlite` or `mariadb` (alias `mysql`) |
| `DB_HOST` | `127.0.0.1` | MariaDB host |
| `DB_PORT` | `3306` | MariaDB port |
| `DB_USER` | `9router` | MariaDB user |
| `DB_PASSWORD` | *(empty)* | MariaDB password |
| `DB_NAME` | `9router` | MariaDB database name |
| `DB_CONNECTION_LIMIT` | `20` | Connection pool size (MariaDB default `max_connections` is 151) |

### Using Docker Compose

The repo ships a `docker-compose.yml` that defines the app, a bundled
`searxng` web-search sidecar, an optional `headroom` sidecar, and a
**profile-gated** MariaDB service. Plain `docker compose up` brings up the app,
SearXNG (working web search) and headroom; MariaDB is opt-in via the `mariadb`
profile.

> **The app service is built from local source.** `docker-compose.yml` uses
> `image: 9router:local` with a `build: .` section, so `docker compose up -d
> --build` compiles the app from the current checkout (this repo's `Dockerfile`)
> and runs that image. The published `decolua/9router:latest` on Docker Hub is a
> release snapshot and **can lag behind the repo** — for example, images built
> before 2026-09-17 have no MariaDB support and will always boot SQLite even when
> `DB_MODE=mariadb` is set. Building locally guarantees the running image matches
> the source you have.

```bash
# SQLite (default) — build local image, then start (no MariaDB container)
docker compose up -d --build

# MariaDB — enable the mariadb profile
echo "DB_MODE=mariadb" >> .env
docker compose --profile mariadb up -d --build

# Build the local image only (no start)
docker compose build 9router
```

The `mariadb` service uses image `mariadb:11` (override with `MARIA_IMAGE`), a
named volume `9router-mariadb-data:/var/lib/mysql`, and a
`healthcheck.sh --connect --innodb_initialized` healthcheck that the app waits
on before starting.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MARIA_IMAGE` | `mariadb:11` | MariaDB image |
| `MARIA_HOST_PORT` | `DB_PORT` | Host port published for MariaDB |
| `DB_ROOT_PASSWORD` | `DB_PASSWORD` | MariaDB root password (falls back to `DB_PASSWORD`) |

Minimal example (excerpt of the shipped `docker-compose.yml`):

```yaml
services:
  9router:
    image: 9router:local
    build:
      context: .
      dockerfile: Dockerfile
    env_file: [.env]
    environment:
      DB_MODE: ${DB_MODE:-sqlite}
      DB_HOST: ${DB_HOST:-mariadb}
      DB_PORT: ${DB_PORT:-3306}
    depends_on:
      mariadb:
        condition: service_healthy
        required: false

  mariadb:
    image: ${MARIA_IMAGE:-mariadb:11}
    profiles: [mariadb]          # only started with --profile mariadb
    environment:
      MARIADB_DATABASE: ${DB_NAME:-9router}
      MARIADB_USER: ${DB_USER:-9router}
      MARIADB_PASSWORD: ${DB_PASSWORD}
      MARIADB_ROOT_PASSWORD: ${DB_ROOT_PASSWORD:-${DB_PASSWORD}}
    volumes:
      - 9router-mariadb-data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
```

If `DB_PASSWORD` is empty when you run `./start.sh` in MariaDB mode, it
generates a random password and appends it to `.env` so it stays stable across
runs. (Raw `docker compose` does not do this — set `DB_PASSWORD` yourself.)

### Using `start.sh` (thin wrapper)

`start.sh` is now a **thin wrapper around `docker compose`** — all container
provisioning lives in `docker-compose.yml`. It reads `DB_MODE` from `.env` and
adds `--profile mariadb` automatically when needed:

```bash
# Put DB_MODE=mariadb (and optionally DB_NAME / DB_PASSWORD) in .env first:
echo "DB_MODE=mariadb" >> .env

./start.sh          # build local image, then docker compose [--profile mariadb] up -d --build
./start.sh build    # docker compose build 9router (local image only)
./start.sh status   # docker compose ps -a
./start.sh logs     # docker compose logs -f 9router (or: logs mariadb)
./start.sh down     # docker compose down (keeps volumes)
./start.sh help     # full command list
```

Command → compose mapping:

| `start.sh` | Equivalent |
| --- | --- |
| `./start.sh` / `up` | `docker compose build 9router` then `docker compose [--profile mariadb] up -d --build` |
| `build` | `docker compose build 9router` |
| `down` | `docker compose --profile mariadb down` |
| `down --volumes` | `docker compose --profile mariadb down -v` (DESTRUCTIVE) |
| `restart` | `docker compose restart 9router` |
| `logs [svc]` | `docker compose logs -f [svc]` (default `9router`) |
| `migrate` | removes the marker, then `DB_MIGRATE_FORCE=1 docker compose --profile mariadb up -d --force-recreate 9router` |
| `status` | `docker compose ps -a` |
| `prune` | `docker image prune -f` + `docker builder prune -f` |

### One-time auto-migration SQLite → MariaDB

When MariaDB mode is enabled and the target MariaDB database is **empty**, the
app looks for an existing SQLite file at `$DATA_DIR/db/data.sqlite`. If found,
it copies every table into MariaDB on first boot (preserving ids and all
columns) and writes a guard marker at `$DATA_DIR/db/.migrated-to-mariadb`.

- The SQLite file is only **read**, never modified or deleted.
- The copy runs **once**; subsequent boots skip it (marker present).
- To force a re-copy: `./start.sh migrate`, or delete the marker file and
  restart, or set `DB_MIGRATE_FORCE=1` for the app container.

`./start.sh migrate` requires the MariaDB service to be running. It removes the
marker `/app/data/db/.migrated-to-mariadb` inside the `9router-data` volume and
recreates the app with `DB_MIGRATE_FORCE=1` so the copy re-runs on boot. The
equivalent raw compose command is:

```bash
DB_MIGRATE_FORCE=1 docker compose --profile mariadb up -d --force-recreate 9router
```

(combined with removing the marker first, e.g.
`docker run --rm -v 9router-data:/app/data alpine sh -c 'rm -f /app/data/db/.migrated-to-mariadb'`).

## Bundled SearXNG web search

9Router's built-in, unauthenticated **web-search provider** talks to a SearXNG
instance. The Compose stack ships one as an **always-on** service, so web search
works out of the box — no extra setup:

```bash
docker compose up -d          # brings up 9router + searxng + headroom
```

- Service `searxng`, container `9router-searxng`, image
  `searxng/searxng:latest` (override with `SEARXNG_IMAGE`).
- **Internal-only:** no host port is published; the app reaches it by DNS name
  `searxng` on the shared `9router-net` network at `http://searxng:8080/search`.
- The app service gets `SEARXNG_URL: ${SEARXNG_URL:-http://searxng:8080/search}`,
  so it targets the sidecar by default but stays overridable (see below).
- Config/state lives in the named volume `9router-searxng-data:/etc/searxng`.
- A healthcheck (`wget -qO- http://127.0.0.1:8080/healthz`) marks it healthy; the
  app declares `depends_on: searxng: { condition: service_healthy, required: false }`.

### JSON format requirement

The 9Router provider calls SearXNG with `?format=json`, but upstream SearXNG
only enables `html` by default and rejects other formats (HTTP 403). The repo
therefore mounts a minimal settings file, `docker/searxng/settings.yml`
(read-only at `/etc/searxng/settings.yml`), which enables JSON and disables the
rate limiter:

```yaml
use_default_settings: true
search:
  formats: [html, json]   # REQUIRED: 9router requests ?format=json
server:
  limiter: false          # local API calls must not be rate-limited
  secret_key: "..."       # signing key (overridable via SEARXNG_SECRET)
```

**Any SearXNG instance you point `SEARXNG_URL` at must serve `format=json`.**
For an external instance, add `json` to `search.formats` in its own settings and
disable the limiter, or JSON requests will fail.

### Pointing at a different SearXNG

```bash
# .env
SEARXNG_URL=https://searx.example.com/search
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `SEARXNG_URL` | `http://searxng:8080/search` | Endpoint the app calls (must serve `?format=json`) |
| `SEARXNG_IMAGE` | `searxng/searxng:latest` | Bundled SearXNG image |
| `SEARXNG_SECRET` | *(generated)* | SearXNG session-signing key |

### Disabling the bundled SearXNG

The service is always-on; to run without it:

```bash
# Start only the app (and whatever else you name)
docker compose up -d 9router

# Or stop/remove just the sidecar
docker compose stop searxng
docker compose rm -f searxng
```

Web search will then be unavailable unless `SEARXNG_URL` points at another
instance. To expose the bundled instance on the host for debugging only, add an
optional port mapping (see the commented block in `docker-compose.yml`).

## Optional Headroom sidecar

The 9Router image does not bundle Python or Headroom. To use Headroom in Docker, run it as a separate service and point 9Router at that proxy:

```yaml
services:
  9router:
    image: decolua/9router:latest
    ports:
      - "20128:20128"
    volumes:
      - "$HOME/.9router:/app/data"
    environment:
      DATA_DIR: /app/data
      HEADROOM_URL: http://headroom:8787
    depends_on:
      - headroom

  headroom:
    image: ghcr.io/chopratejas/headroom:latest
    ports:
      - "8787:8787"
```

In the dashboard, open `Endpoint` → `Token Saver` → `Headroom`, confirm the URL is `http://headroom:8787`, recheck status, then enable Headroom.

If Headroom runs on the Docker host instead of as a sidecar, use `http://host.docker.internal:8787` on macOS/Windows. On Linux, add `--add-host=host.docker.internal:host-gateway` or the equivalent compose `extra_hosts` entry.

## Update to latest

```bash
docker pull decolua/9router:latest
docker rm -f 9router
# re-run the quick start command
```

## Production performance tuning

A few settings matter under concurrent production traffic (e.g. many SSE
streams in flight). The defaults are safe; the notes below explain what to
avoid turning on.

### `DB_CONNECTION_LIMIT` (default `20`)

MariaDB's server-side `max_connections` defaults to **151**, so a pool of `20`
gives safe headroom for concurrent SSE streams without exhausting the server.
The previous default of `10` was conservative — raise it only if you also raise
the server's `max_connections`.

### Keep `ENABLE_REQUEST_LOGS=false` (default)

When set to `true`, the SSE engine appends **every streamed chunk** with a
synchronous `fs.appendFileSync`. That blocks the Node.js event loop on each
chunk, which is especially damaging under load. Leave it `false` in production;
enable only for short, targeted debugging.

### Keep `enableObservability=false` (default) under high traffic

The observability setting (UI: `enableObservability`, default `false`) captures
request details and adds a per-request `JSON.stringify` plus batched DB writes.
That extra work is fine at low volume but adds CPU and write pressure under high
traffic — keep it `false` when throughput matters.

### SQLite in production: prefer `DB_MODE=mariadb`

All SQLite drivers in the fallback chain (`better-sqlite3`, `node:sqlite`,
`bun:sqlite`, `sql.js`) are **synchronous** and block the event loop under
concurrency. If you run SQLite with `NODE_ENV=production`, the app logs a
one-time warning on boot recommending `DB_MODE=mariadb`. For concurrent
production workloads, use MariaDB.

---

# 🛠 For Developers

## Build image locally (test)

```bash
docker build -t 9router:local .

docker run --rm -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  9router:local
```

Or via Compose (same image tag the stack uses):

```bash
docker compose build 9router
```

## Publish (automatic via CI)

Push a git tag `v*` → GitHub Actions builds multi-platform (amd64+arm64) and pushes to:
- `ghcr.io/decolua/9router:v{version}` + `:latest`
- `decolua/9router:v{version}` + `:latest`

```bash
# Use scripts/release.js (recommended)
node scripts/release.js "Release title" "Notes"

# Or manually
git tag v0.4.x && git push origin v0.4.x
```

Workflow: `app/.github/workflows/docker-publish.yml`
