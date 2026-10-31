# 2WaY operations runbook

## 1. Server

Any small Linux VPS works for 50 members: 1 vCPU, 1–2 GB RAM, 20 GB disk. Install Docker Engine with the Compose plugin. Open ports 80 and 443 only (Caddy); Postgres is never published.

## 2. First deploy

1. Point an A/AAAA record for your domain at the server.
2. `cp .env.example .env` and fill in every value. Generate secrets with `openssl rand -base64 32`.
3. **Store `BACKUP_PASSPHRASE` somewhere off the server** (password manager). Without it no backup can be restored.
4. `docker compose up -d --build`
5. `docker compose logs -f app` until you see `2WaY listening`. Caddy obtains the certificate on the first request.
6. `docker compose exec app node scripts/create-admin.js <username>`
7. Sign in and create invites from **Profile → Admin panel → Invites**. Send each code privately; it only works for the username it was made for.

## 3. Membership and the 50-seat limit

- Seats = active + suspended members + open (unexpired, unrevoked, unused) invites. Creating an invite reserves a seat; revoking or expiry frees it.
- Deleting an account frees its seat. Suspending does not.
- The limit is not editable in the app. To change it deliberately:
  `docker compose exec db psql -U twoway -c "UPDATE app_settings SET value='60' WHERE key='member_limit'"`
  (This is the one sanctioned direct database edit; it is recorded here so it isn't done casually.)

## 4. Backups

- The `backup` service writes `backups/2way-<UTC>.dump.enc` once at first start and then daily at `BACKUP_HOUR_UTC`.
- Format: `pg_dump` custom format, AES-256-CBC with PBKDF2 (200k iterations). Each file is test-decrypted and listed with `pg_restore --list` before it's kept.
- Files older than `BACKUP_RETENTION_DAYS` (default 14) are deleted.
- **Copy backups off the server** (another machine, object storage). A backup on the same disk doesn't survive losing the server. Example: a nightly `rsync -a backups/ user@other-host:2way-backups/`.

### Restore drill (do this monthly)

```bash
docker compose run --rm backup /bin/sh /scripts/restore.sh /backups/<file>.dump.enc twoway_restore_test
```
It recreates a scratch database, restores into it and prints row counts. Compare with the live counts.

### Real restore

```bash
docker compose stop app
docker compose run --rm backup /bin/sh /scripts/restore.sh /backups/<file>.dump.enc twoway
docker compose start app
```

## 5. Upgrades

```bash
git pull
docker compose up -d --build app
```
Migrations run automatically on boot under an advisory lock. They are forward-only; the runner refuses to start if an applied migration file was edited. Schema changes always go in a new `migrations/NNN_name.sql`. Take a manual backup before upgrades that include migrations: `docker compose exec backup /bin/sh /scripts/backup.sh`.

## 6. Monitoring

- `docker compose ps` shows health; the app's health check calls `/healthz` (DB round trip).
- Logs are JSON lines on stdout. They never include message text, passwords, invite codes, cookies or tokens (the logger redacts those field names, and Caddy redacts auth headers).
- Audit log in the admin panel: invites, member changes, role changes, room changes, XP grants, moderation deletes, settings, account deletions, lockouts.

## 7. Before you invite everyone: verification checklist

These require a deployed instance and real devices and were **not** run by the build:

| Check | How |
|---|---|
| End-to-end flow | Admin creates invite → friend registers → both chat in The Square → DM → reactions → reconnect after toggling airplane mode (no duplicates, gap filled). |
| Lighthouse (mobile) | Chrome DevTools → Lighthouse → Mobile on the lounge. Targets: LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1. |
| Low-end devices | One 2 GB RAM Android phone on Chrome, one iPhone on Safari: scroll a room with 200+ messages, open the keyboard in chat, switch apps and come back. |
| Slow network | DevTools → Network → "Slow 4G": first load, send while throttled, go offline/online. |
| Widths | 320, 360, 375, 390, 430, 768, 1024, 1440 px: no sideways scroll; composer visible with keyboard open. |
| Install | "Add to Home Screen" on Android and iOS; launches standalone with the 2WaY icon. |
| Both themes | Switch in Profile; check text contrast in light theme. |
| Backups | Confirm a file appears in `backups/` and run the restore drill once. |

## 8. Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Reconnecting…" never clears | Proxy blocking WebSockets (Caddy handles them; another proxy in front may not). Socket.IO falls back to long-polling, so check `APP_ORIGIN` matches the exact browser origin, including `https://`. |
| Every POST returns 403 "Request blocked" | `APP_ORIGIN` doesn't match the site's origin. |
| Friends on the same mobile network get rate limited at login | Limits are per IP+username (10/15 min) and per IP (60/15 min). Raise `loginIp` in `server/lib/rateLimit.js` if your group shares one carrier IP heavily. |
| App exits with "Unsafe production configuration" | `APP_ORIGIN` isn't https, or `DATABASE_URL` is missing/default. |

## 9. Scaling notes

Rate-limit counters and presence live in process memory, which is correct for the single app container this deployment uses. Running several app containers would need those moved to Postgres (or a shared store) and the Socket.IO Postgres adapter. Not needed for 50 members.
