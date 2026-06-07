#!/usr/bin/env bash
#
# Back up the BhashaJS database to a dated, compressed mongodump archive.
# A safety net in case MongoDB Atlas backups aren't enabled on the cluster tier.
#
# Usage:
#   MONGO_CONNECTION_URL="mongodb+srv://user:pass@cluster/bhashajs" ./scripts/backup.sh [OUTDIR]
#
# Daily cron (02:00), keeping logs:
#   0 2 * * * cd /opt/bhashajs && MONGO_CONNECTION_URL="..." ./scripts/backup.sh /var/backups/bhasha >> /var/log/bhasha-backup.log 2>&1
#
# Restore a dump:
#   mongorestore --uri="$MONGO_CONNECTION_URL" --archive=bhasha-YYYYMMDD-HHMMSS.archive.gz --gzip
#
# Requires the MongoDB Database Tools (mongodump/mongorestore) on the host.

set -euo pipefail

: "${MONGO_CONNECTION_URL:?Set MONGO_CONNECTION_URL to the Atlas/Mongo connection string}"

OUTDIR="${1:-./backups}"
KEEP="${BACKUP_KEEP:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="${OUTDIR}/bhasha-${STAMP}.archive.gz"

mkdir -p "$OUTDIR"
echo "[backup] dumping to ${ARCHIVE}"
mongodump --uri="$MONGO_CONNECTION_URL" --archive="$ARCHIVE" --gzip
echo "[backup] done ($(du -h "$ARCHIVE" | cut -f1))"

# Retain only the newest $KEEP archives.
# shellcheck disable=SC2012
ls -1t "${OUTDIR}"/bhasha-*.archive.gz 2>/dev/null | tail -n "+$((KEEP + 1))" | xargs -r rm -f
echo "[backup] kept newest ${KEEP} archive(s)"
