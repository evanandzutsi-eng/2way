#!/bin/sh
# Restore an encrypted backup into a database.
#
#   Into the live database (stop the app first!):
#     docker compose stop app
#     docker compose run --rm -v "$PWD/backups:/backups" backup /bin/sh /scripts/restore.sh /backups/2way-XXXX.dump.enc twoway
#     docker compose start app
#
#   Restore test (recommended monthly) into a scratch database:
#     docker compose run --rm backup /bin/sh /scripts/restore.sh /backups/2way-XXXX.dump.enc twoway_restore_test
#
set -eu
file="${1:?usage: restore.sh <backup file> <target database>}"
target="${2:?usage: restore.sh <backup file> <target database>}"

if [ "$target" != "${PGDATABASE:-twoway}" ]; then
  echo "restore: (re)creating scratch database $target"
  psql -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$target\"" -c "CREATE DATABASE \"$target\""
fi

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$file" \
  | pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error -d "$target"

echo "restore: done. Row counts in $target:"
psql -d "$target" -At -c "SELECT 'users', count(*) FROM users UNION ALL SELECT 'messages', count(*) FROM messages UNION ALL SELECT 'dm_messages', count(*) FROM dm_messages UNION ALL SELECT 'migrations', count(*) FROM schema_migrations"
