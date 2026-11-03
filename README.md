# Friday Hockey Portal — Render contingency source

This package is a copy of the Raspberry Pi shared application source, prepared for a separate Friday GitHub repository. It does **not** include live database records, credentials, Docker secrets, or Pi deployment configuration.

## Render setup
- Runtime: Node.js (Node 22 recommended)
- Build command: `npm install --omit=dev`
- Start command: `npm start`
- Set `DATABASE_URL` to the corresponding Friday Neon database connection string in Render's private environment settings.
- Set the necessary admin/security environment variables privately in Render; see `.env.example` for names, not values.
- Keep scheduler switches disabled while the Pi is primary. Activate only after restoring data and performing a controlled failover.

## Important limitations
- The application stores some authentication/security state under `/state` by default. Render's ephemeral filesystem may not persist it across deployments. Configure persistent state appropriately before relying on the standby for long-term operation.
- Verify that the Admin Panel export/import restores all required portal data in the Neon environment.
- This package has not been deployed or end-to-end tested against Render/Neon.
- Do not commit `.env`, credentials, database dumps, or exported player data. Use a **private GitHub repository**.

## Render-managed Admin password
Set `HOCKEY_ADMIN_ENV_PASSWORD_ONLY=true` and set `ADMIN_PASSWORD` to the desired secret in Render Environment. Redeploy after updating these variables. This mode ignores previously rotated credential files and uses only the Render-provided password for Admin login. Admin password changes inside the portal are disabled in this mode; change `ADMIN_PASSWORD` in Render instead. For contingency-only password login, set `HOCKEY_STANDBY_SIMPLE_LOGIN=true` to bypass Admin MFA and Admin IP lockout. This reduces protection against password guessing; use a unique 20+ character random password and private repository. Other portal roles and security routes may still use security state; configure `HOCKEY_AUTH_SECURITY_FILE=/tmp/hockey-auth-security.json`, `HOCKEY_ADMIN_MFA_FILE=/tmp/hockey-admin-mfa.json`, and `HOCKEY_ADMIN_CREDENTIAL_FILE=/tmp/hockey-admin-credential.json`. `/tmp` is ephemeral and not suitable for durable security state. The Admin login bypass is active only when the explicit flag is true. Do not enable this setting on the Raspberry Pi unless you deliberately want to change its credential behavior.
