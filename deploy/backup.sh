#!/bin/sh
# Nightly logical backup, compressed, with rotation. Copy ./backups off-site (see docs/OPERATIONS.md).
set -eu
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
pg_dump -h db -U portal -d portal -Fc -f "/backups/portal-$STAMP.dump"
find /backups -name 'portal-*.dump' -mtime +"${BACKUP_KEEP_DAYS:-30}" -delete
echo "[backup] portal-$STAMP.dump written"
