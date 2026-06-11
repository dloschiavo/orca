#!/usr/bin/env bash
set -euo pipefail

# ── Usage ─────────────────────────────────────────────────────────────────────
# ./install.sh <backup.tar.gz> [--host <host>] [--port <port>] [--db <name>]
#
# Run this from inside the repo directory (the script lives there).
# No pre-clone needed — the backup provides the initial source tree.
#
# Options:
#   --host  Mongo host        (default: localhost)
#   --port  Mongo port        (default: 27017)
#   --db    Database name     (default: derived from backup filename, e.g.
#                              filamentalist_2026-01-01_12-00-00.tar.gz → filamentalist)
#
# What this does:
#   1. Extracts source from backup  →  full tree on disk (.env files included)
#   2. git fetch + reset --hard     →  latest tracked code overwrites backup source
#                                      (.env is gitignored, survives untouched)
#   3. Restores MongoDB collections
#   4. Installs npm packages (shared → scraper → app)

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <backup.tar.gz> [--host <host>] [--port <port>] [--db <name>]"
  exit 1
fi

ARCHIVE="$1"; shift

if [[ ! -f "$ARCHIVE" ]]; then
  echo "Error: archive not found: $ARCHIVE"
  exit 1
fi

# ── Parse flags ───────────────────────────────────────────────────────────────
MONGO_HOST=""
MONGO_PORT=""
DB_NAME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) MONGO_HOST="$2"; shift 2 ;;
    --port) MONGO_PORT="$2"; shift 2 ;;
    --db)   DB_NAME="$2";    shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Defaults ──────────────────────────────────────────────────────────────────
MONGO_HOST="${MONGO_HOST:-localhost}"
MONGO_PORT="${MONGO_PORT:-27017}"

# Derive db name from backup filename if not provided:
# filamentalist_2026-01-01_12-00-00.tar.gz  →  filamentalist
if [[ -z "$DB_NAME" ]]; then
  BASENAME="$(basename "$ARCHIVE")"           # filamentalist_2026-01-01_12-00-00.tar.gz
  BASENAME="${BASENAME%.tar.gz}"              # filamentalist_2026-01-01_12-00-00
  BASENAME="${BASENAME%.tgz}"                 # (handle .tgz too)
  DB_NAME="${BASENAME%_[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]_*}"  # filamentalist
fi

MONGO_URI="mongodb://${MONGO_HOST}:${MONGO_PORT}/${DB_NAME}"

# ── Preflight: verify MongoDB is reachable ────────────────────────────────────
SKIP_MONGO=false

if ! command -v mongorestore &>/dev/null; then
  echo "      mongorestore not found — attempting to install mongodb-database-tools..."
  INSTALLED_MONGO_TOOLS=false
  if command -v brew &>/dev/null; then
    if brew install mongodb-database-tools; then
      INSTALLED_MONGO_TOOLS=true
    fi
  elif command -v apt-get &>/dev/null; then
    if sudo apt-get install -y mongodb-database-tools 2>/dev/null; then
      INSTALLED_MONGO_TOOLS=true
    fi
  fi
  if [[ "$INSTALLED_MONGO_TOOLS" == false ]] || ! command -v mongorestore &>/dev/null; then
    echo "WARNING: could not install mongorestore — MongoDB restore will be skipped."
    echo ""
    echo "  Install client tools manually:"
    echo "    macOS:          brew install mongodb-database-tools"
    echo "    Debian/Ubuntu:  sudo apt-get install -y mongodb-database-tools"
    echo "    Other:          https://www.mongodb.com/try/download/database-tools"
    echo ""
    SKIP_MONGO=true
  else
    echo "      mongorestore installed successfully."
  fi
fi

if [[ "$SKIP_MONGO" == false ]]; then
  if command -v mongosh &>/dev/null; then
    if ! mongosh "$MONGO_URI" --eval "db.runCommand({ping:1})" --quiet &>/dev/null; then
      echo "WARNING: cannot reach MongoDB at ${MONGO_HOST}:${MONGO_PORT} — MongoDB restore will be skipped."
      SKIP_MONGO=true
    fi
  elif command -v nc &>/dev/null; then
    if ! nc -z "$MONGO_HOST" "$MONGO_PORT" &>/dev/null; then
      echo "WARNING: cannot reach ${MONGO_HOST}:${MONGO_PORT} — MongoDB restore will be skipped."
      SKIP_MONGO=true
    fi
  else
    echo "Warning: neither mongosh nor nc found — skipping connectivity check."
  fi
fi

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
WORK_DIR="$(mktemp -d)"
GIT_REMOTE="${GIT_REMOTE:-origin}"
GIT_BRANCH="${GIT_BRANCH:-main}"

echo "==> Install from: $ARCHIVE"
echo "    repo root:    $REPO_ROOT"
echo "    mongo:        $MONGO_URI"
echo ""

# ── 1. Extract archive ────────────────────────────────────────────────────────
echo "[1/5] Extracting archive..."
tar -xzf "$ARCHIVE" -C "$WORK_DIR"
echo "      done."

# ── 2. Restore source (for .env files and any non-git assets) ─────────────────
echo "[2/5] Restoring source files (envs + assets)..."
if [[ -f "$WORK_DIR/src/source.tar.gz" ]]; then
  # Extract but skip files that git will own (only keep gitignored/non-tracked files)
  # We extract everything, then git pull will overwrite the tracked source files
  tar -xzf "$WORK_DIR/src/source.tar.gz" -C "$REPO_ROOT"
  echo "      done."
else
  echo "      WARNING: no src/source.tar.gz found in archive, skipping."
fi

# ── 3. Force git pull ────────────────────────────────────────────────────────
echo "[3/5] Pulling latest code from $GIT_REMOTE/$GIT_BRANCH..."
cd "$REPO_ROOT"
if git fetch "$GIT_REMOTE" 2>/dev/null && git reset --hard "$GIT_REMOTE/$GIT_BRANCH" 2>/dev/null; then
  echo "      done."
else
  echo "      WARNING: git pull failed (no remote or network?) — using source from archive."
fi

# ── 4. Restore MongoDB ────────────────────────────────────────────────────────
echo "[4/5] Restoring MongoDB ($DB_NAME)..."
if [[ "$SKIP_MONGO" == true ]]; then
  echo "      SKIPPED (see warnings above)."
elif [[ -d "$WORK_DIR/mongo" ]]; then
  mongorestore \
    --uri="$MONGO_URI" \
    --drop \
    --quiet \
    "$WORK_DIR/mongo"
  echo "      done."
else
  echo "      WARNING: no mongo/ directory found in archive, skipping."
fi

# ── 5. Install packages ───────────────────────────────────────────────────────
echo "[5/5] Installing packages..."

if [[ -f "$REPO_ROOT/shared/package.json" ]]; then
  echo "      shared..."
  (cd "$REPO_ROOT/shared" && npm install --silent)
fi

if [[ -f "$REPO_ROOT/scraper/package.json" ]]; then
  echo "      scraper..."
  (cd "$REPO_ROOT/scraper" && npm install --silent)
fi

if [[ -f "$REPO_ROOT/app/package.json" ]]; then
  echo "      app..."
  (cd "$REPO_ROOT/app" && npm install --silent)
fi

echo "      done."

# ── Cleanup ───────────────────────────────────────────────────────────────────
rm -rf "$WORK_DIR"

echo ""
echo "==> Install complete."
