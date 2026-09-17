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
| `DB_CONNECTION_LIMIT` | `10` | Connection pool size |

### Using `start.sh` (sidecar provisioning)

`start.sh` provisions everything for you. It creates a docker network, runs a
`mariadb:11` sidecar with a named volume, waits for it to be healthy, then runs
the app container pointed at it:

```bash
# Put DB_MODE=mariadb (and optionally DB_NAME / DB_PASSWORD) in .env first:
echo "DB_MODE=mariadb" >> .env

./start.sh          # build + run in the mode from .env
./start.sh status   # container status
./start.sh logs     # tail app logs
./start.sh down     # stop + remove containers (keeps volumes)
./start.sh help     # full command list
```

If `DB_PASSWORD` is empty, `start.sh` generates a random password and appends
it to `.env` so it stays stable across runs.

### One-time auto-migration SQLite → MariaDB

When MariaDB mode is enabled and the target MariaDB database is **empty**, the
app looks for an existing SQLite file at `$DATA_DIR/db/data.sqlite`. If found,
it copies every table into MariaDB on first boot (preserving ids and all
columns) and writes a guard marker at `$DATA_DIR/db/.migrated-to-mariadb`.

- The SQLite file is only **read**, never modified or deleted.
- The copy runs **once**; subsequent boots skip it (marker present).
- To force a re-copy: `./start.sh migrate`, or delete the marker file and
  restart (or set `DB_MIGRATE_FORCE=1`).

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

---

# 🛠 For Developers

## Build image locally (test)

```bash
cd app && docker build -t 9router .

docker run --rm -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  9router
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
