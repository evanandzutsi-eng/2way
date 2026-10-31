#!/bin/sh
# One encrypted, compressed logical backup.
#   pg_dump (custom format) | openssl AES-256-CBC with PBKDF2 → /backups/2way-<UTC timestamp>.dump.enc
# Writes to a temp name first so a partial file is never mistaken for a backup.
set -eu

ts=$(date -u +%Y%m%dT%H%M%SZ)
out="/backups/2way-${ts}.dump.enc"
tmp="${out}.partial"

pg_dump --format=custom --compress=6 --no-owner --no-privileges \
  | openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -out "$tmp"

# Sanity check: the file decrypts and pg_restore can list its contents.
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$tmp" | pg_restore --list > /dev/null

mv "$tmp" "$out"
chmod 600 "$out"
echo "backup: wrote $out ($(du -h "$out" | cut -f1))"

find /backups -name '2way-*.dump.enc' -type f -mtime +"${BACKUP_RETENTION_DAYS:-14}" -print -delete
find /backups -name '*.partial' -type f -mmin +120 -delete
