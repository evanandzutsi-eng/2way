# 2WaY

**Your Circle. Your Culture. Your Vibe.**

A private, invite-only social lounge for a circle of 50 friends: themed rooms, one-to-one DMs, pixel-art avatars, ranks and XP. It runs as a lightweight installable web app (PWA) on one Node.js process and one PostgreSQL database.

## What's in the box

| Area | What it does |
|---|---|
| Membership | No public sign-up. Admin creates single-use invite codes bound to a username (7-day expiry, revocable). Hard cap of 50 seats enforced in the database transaction, counting open invites. |
| Auth | Argon2id passwords, 256-bit session tokens in `HttpOnly; Secure; SameSite=Lax` cookies (only SHA-256 stored), idle + absolute expiry, per-account lockout, sign out / sign out everywhere, password change revokes other sessions. |
| Lounge | Active mates (real presence), five seeded rooms with real activity (people here now / messages today), recent milestones feed. |
| Rooms | Real-time chat, reactions, typing, pagination, author/admin deletion, restricted rooms with explicit membership. |
| DMs | One-to-one only, unread counts, reciprocal read receipts, deletion. Only the two participants can read them, through REST or sockets. |
| Ranks & XP | Rookie → Regular → Star → Master → Elite → Ultimate (thresholds in settings). XP is server-side only, idempotent, rate-capped and audited. Volume doesn't pay: first post of the day, reactions from distinct mates (capped), achievements, admin event grants. |
| Presence | Online / recently active / offline, with a "hide me" switch that makes you read as offline to everyone. |
| PWA | Manifest, icons, service worker that caches the app shell and avatars only (never API data). Clear offline/reconnecting banner, safe reconnect with gap-filling and no duplicates. |
| Admin | Invites, members (suspend/restore, roles, delete), rooms (create/edit/archive/restricted membership), XP grants, retention & rank settings, audit log. |
| Ops | Docker Compose with Caddy (auto-HTTPS, WebSockets, compression), Postgres on an internal network, nightly AES-256 encrypted backups with retention and a restore script. |

## Stack

HTML, CSS and vanilla JS (ES modules, no build step) · Node.js 22 · Express 5 · Socket.IO 4 · PostgreSQL 16 · Docker Compose · Caddy 2.

Runtime dependencies are deliberately four: `express`, `socket.io`, `pg`, `@node-rs/argon2`. Rate limiting, CSRF, sessions, validation, migrations and avatars are small in-house modules (each under ~150 lines, unit-tested) to keep the image small and the attack surface readable.

## Quick start (production)

```bash
cp .env.example .env          # set DOMAIN, ACME_EMAIL, POSTGRES_PASSWORD, BACKUP_PASSPHRASE
docker compose up -d --build  # DNS for DOMAIN must already point at this server
docker compose exec app node scripts/create-admin.js yourname
```

Open `https://DOMAIN`, sign in, go to **Profile → Admin panel → Invites**, and create one invite per friend. Each friend picks **I have an invite** on the sign-in screen.

Full runbook (backups, restore drills, upgrades, troubleshooting): [docs/OPERATIONS.md](docs/OPERATIONS.md). What members are told about their data: [docs/PRIVACY.md](docs/PRIVACY.md).

## Local development

```bash
npm install
docker run -d --name 2way-pg -e POSTGRES_USER=twoway -e POSTGRES_PASSWORD=twoway -e POSTGRES_DB=twoway -p 5432:5432 postgres:16-alpine
npm start                                  # http://localhost:3000, runs migrations on boot
node scripts/create-admin.js yourname
```

## Tests and checks

```bash
npm test                 # unit tests: validation, ranks, rate limits, CSRF/origin, tokens, avatars (no DB)
npm run check            # parses every file, verifies browser imports/exports, SW precache list, icon sprite
npm run size             # compressed JS/CSS sizes vs. budgets
createdb twoway_test
DATABASE_URL=postgres://twoway:twoway@localhost:5432/twoway_test npm run test:integration
```

The integration suite (34 tests) runs the real services, REST routes and Socket.IO handlers against PostgreSQL: invite rules, the 50-seat cap under concurrent registration, lockout, session expiry, restricted-room and DM access control over both REST and sockets, idempotent sends, XP anti-farming, rate limiting, account deletion and retention.

## Project layout

```
server/
  index.js            boot: migrate → HTTP + Socket.IO → background jobs
  app.js              Express app: headers, avatars, /api, static files
  config.js           env config; refuses unsafe production settings
  db/                 pool + transaction helper, migration runner
  security/           sessions, passwords (Argon2id), CSRF/origin checks, middleware
  services/           accounts, rooms, dms, xp, presence, admin, activity, maintenance
  realtime/           Socket.IO handlers (auth, acks, rate limits) and broadcast hub
  routes/api.js       REST endpoints
  lib/                validation, rate limiter, ranks, tokens, avatar generator, logger
migrations/           001_init.sql (schema), 002_seed.sql (rooms, ranks, achievements)
public/               index.html, css/app.css, js/ (app shell + lazy views), sw.js, manifest, icons
deploy/               Caddyfile, backup image + scripts
scripts/              create-admin, invite, check-syntax, size-report
test/                 unit/, integration/, shims/ (test-only stand-ins, see below)
```

`test/shims/` holds test-only stand-ins for `pg`, `express`, `socket.io` and `argon2`, used to run the suites in an environment without npm access. With `npm install` done they are not on the module path and the real packages are used.
