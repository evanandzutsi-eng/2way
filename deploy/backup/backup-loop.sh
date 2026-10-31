#!/bin/sh
# Runs inside the `backup` container: one encrypted backup per day at
# BACKUP_HOUR_UTC, keeping BACKUP_RETENTION_DAYS days of files.
set -eu

echo "backup: scheduler started (daily at ${BACKUP_HOUR_UTC}:00 UTC, keep ${BACKUP_RETENTION_DAYS} days)"
# Take one immediately on first start so a fresh deploy is never unprotected.
[ -n "$(ls -A /backups 2>/dev/null)" ] || /bin/sh /scripts/backup.sh

while true; do
  now=$(date -u +%s)
  next=$(( now - now % 86400 + BACKUP_HOUR_UTC * 3600 ))
  [ "$next" -le "$now" ] && next=$(( next + 86400 ))
  sleep $(( next - now ))
  /bin/sh /scripts/backup.sh || echo "backup: FAILED at $(date -u)" >&2
done
