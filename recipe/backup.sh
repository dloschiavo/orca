#!/usr/bin/env bash
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-27017}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"

# Infer DB name from directory basename (try as-is, then with - replaced by _)
_BASE="$(basename "$REPO_ROOT")"
_DBS="$(mongosh --quiet --eval "db.adminCommand({listDatabases:1}).databases.map(d=>d.name).join('\n')" "mongodb://$DB_HOST:$DB_PORT/admin" 2>/dev/null || true)"
if echo "$_DBS" | grep -qx "$_BASE"; then
  _DEFAULT_DB="$_BASE"
elif echo "$_DBS" | grep -qx "${_BASE//-/_}"; then
  _DEFAULT_DB="${_BASE//-/_}"
else
  _DEFAULT_DB="$_BASE"
fi

MONGO_URI="${MONGO_URI:-mongodb://$DB_HOST:$DB_PORT/$_DEFAULT_DB}"
DB_NAME="${MONGO_URI##*/}"
BACKUP_NAME="${DB_NAME}_$(date +%Y-%m-%d_%H-%M-%S)"
WORK_DIR="$(mktemp -d)"

echo "==> Backup: $BACKUP_NAME"
echo "    from:   $REPO_ROOT"
echo "    to:     $BACKUP_DIR"
echo ""

mkdir -p "$BACKUP_DIR"
mkdir -p "$WORK_DIR/mongo"

# ── 1. Mongo dump ─────────────────────────────────────────────────────────────
echo "[1/3] Dumping MongoDB ($MONGO_URI)..."
mongodump \
  --uri="$MONGO_URI" \
  --out="$WORK_DIR/mongo" \
  --quiet
echo "      done."

# ── 2. Source + assets tar ────────────────────────────────────────────────────
echo "[2/3] Archiving source & assets..."
tar -czf "$WORK_DIR/source.tar.gz" \
  -C "$REPO_ROOT" \
  --exclude='node_modules' \
  --exclude='*/node_modules' \
  --exclude='*/dist' \
  --exclude='*/.expo' \
  --exclude='logs' \
  --exclude='*/logs' \
  --exclude='scraper/logs/scrapes' \
  --exclude='creative-tim-ui' \
  --exclude='notus-react' \
  --exclude='.DS_Store' \
  .
echo "      done."

# ── 3. Bundle into final archive ──────────────────────────────────────────────
echo "[3/3] Bundling into $BACKUP_NAME.tar.gz..."
tar -czf "$BACKUP_DIR/${BACKUP_NAME}.tar.gz" \
  -C "$WORK_DIR" \
  mongo \
  source.tar.gz
echo "      done."

# ── Cleanup ───────────────────────────────────────────────────────────────────
rm -rf "$WORK_DIR"

FINAL="$BACKUP_DIR/${BACKUP_NAME}.tar.gz"
SIZE=$(du -sh "$FINAL" | cut -f1)
echo ""
echo "==> Backup complete: $FINAL ($SIZE)"
