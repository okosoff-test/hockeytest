# Phan's Hockey — Friday contingency (GitHub / Render / Neon)

Export source: production Raspberry Pi `/opt/hockey/portal` on 2026-11-07. The input archive also contained `portal-test`, which is a test clone, not a separate Sunday production codebase. Both contingency packages use the **production** application with separate per-day configuration; **check your Friday portal settings against its live backup before failover**.

## Intended configuration

- **Primary:** Raspberry Pi portals, unchanged by this export.
- **Standby:** separate private GitHub repository -> existing Friday Render service -> its own Neon PostgreSQL database.
- **Admin:** only `ADMIN_PASSWORD` set in Render. No MFA, no persistent IP lockout, no web-based admin password rotation. Admin JWT sessions are still required for protected routes.
- **Role passwords:** goalie/payment passwords are independent; if used, define their own environment variables.
- **Standby safety:** public API writes blocked by default (`PORTAL_STANDBY_MODE=true`), admin JSON import remains possible, and automated schedule ticks are disabled by default.

## Upload to GitHub

1. Use a **private** repository for this Friday backup. Upload the ZIP contents at repository **root**, including `server.js`, `package.json`, `Dockerfile` and `public/`.
2. Do not upload production JSON databases, private environment files, auth state, credentials, player rosters or backup archives.
3. Connect the existing Friday backup Render web service to this repository (do NOT change the live Raspberry Pi sites or their DuckDNS addresses).
4. Render **Docker** environment is supported by `Dockerfile`, or use Node build `npm install` and start `npm start`.
5. Set Render environment variables in its dashboard. `.env.example` is a checklist, not a credentials file.

## Required Render environment

- `DATABASE_URL`: **this Friday backup's own** Neon connection string, never the Pi database. A missing Neon URL now causes startup to stop rather than fall back to local files.
- `ADMIN_PASSWORD`: strong admin password (Render environment ONLY).
- `ADMIN_TOKEN_SECRET`: long random value used for signed sessions (recommended stable across restarts).
- `DEFAULT_SIGNUP_CODE`: four digits from the live Friday portal. This is deliberately not embedded in code.
- `DEFAULT_GAME_TIME`: exact live Friday setting in the `Friday 9:30 PM` / `Sunday 10:00 PM` format. Startup validates that it begins with Friday.
- `PORTAL_TIMEZONE=America/Toronto`
- `STRICT_DATABASE_MODE=true`
- `PORTAL_STANDBY_MODE=true` (prevents public mutation while on standby)
- `PORTAL_SCHEDULER_ACTIVE=false`
- `BACKGROUND_SCHEDULER_ENABLED=false`
- `ENABLE_INTERNAL_SCHEDULER_CRON=false`

The saved game configuration in Neon takes precedence over bootstrap defaults. **Verify the actual settings, time, registrants and schedule in the Friday admin panel after restoring data.** No live database data was in the source archive.

## Standby and failover

**Standby (normal):** leave `PORTAL_STANDBY_MODE=true` and all three scheduler settings `false`. The Render backup can be deployed and admin-tested without allowing public registration. Do not distribute its URL to players yet.

**When the Raspberry Pi portal fails:**

1. Export/retrieve the **latest Friday JSON backup** from the Pi/USB backup, or your newest verified backup. Restore it through the Friday contingency admin panel into this backup's Neon database. Check roster, waitlist, paid status, announcement, reset/release times, and timezone. The source ZIP contains NO current roster data.
2. On Render, set `PORTAL_STANDBY_MODE=false`, `PORTAL_SCHEDULER_ACTIVE=true`, `BACKGROUND_SCHEDULER_ENABLED=true`, and `ENABLE_INTERNAL_SCHEDULER_CRON=true` (unless you have a separate, verified scheduler). Redeploy/restart as required for new environment variables.
3. Test admin access and player registration against the backup URL, and verify scheduled reset behaviour before notifying players to use the contingency URL.
4. **Do not serve writes from both Pi and Render for the same game**: they use separate databases and have no automatic synchronization. On recovery, export newest Render roster JSON and import to Pi before directing traffic back.

## Security / operations notes

- No MFA or IP lockout was retained by design; this lowers login protection. Keep the repository **private**, use a long unique admin password and HTTPS, and consider Render's access controls.
- `GOALIE_PASSWORD` and `PAYMENT_PASSWORD` can be set via Render for emergency operation. Changes to goalie/payment passwords in the admin UI use a local runtime file and **will not survive an ephemeral Render redeploy without persistent disk**; prefer setting these passwords in Render as the lasting source of truth (or a durable volume).
- Roster state is in Neon; Render's local filesystem is ephemeral. Admin session audit files and snapshots created on the Render container are not a durable backup.
- Existing external cronjob.org pings can continue for uptime, but **must not turn on roster scheduling** while standby is active.
- Review the original software copyright notice. Only upload to a repo you are authorized to manage.

## Smoke checks

- `node --check server.js`
- `node --check hockey-auth-security.js`
- `GET /health` on Render
- Admin login: correct Render `ADMIN_PASSWORD` works; wrong password is a normal 401 and never turns into an IP lockout; MFA code is not requested.
- In standby, public registration POST requests return HTTP 503 and do not change Neon roster data.
