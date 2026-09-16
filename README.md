# Plan Reminder — PostgreSQL and pgAdmin

The supported app now uses PostgreSQL for accounts, plans, shared NPR budgets, task order, notification delivery records, and uploaded images. Runtime JSON storage has been removed from the server. Docker Compose includes the app, a dedicated PostgreSQL 18.6 database, pgAdmin 9.17, and a one-time JSON importer. Coolify is not required.

Your live server inspection showed the older JSON app in `/home/shangrila002/marketing-planner`, container `shangrila-marketing-tracker-v2`, on port 3005. The PostgreSQL setup below is a separate Compose project, `plan-reminder-postgres`. It does not reuse the other applications' PostgreSQL or pgAdmin containers.

| Service | Address | Storage |
| --- | --- | --- |
| App | `http://localhost:3005` by default | PostgreSQL |
| PostgreSQL | `db:5432` inside this Compose network | `postgres-data` named volume |
| pgAdmin | `http://localhost:5052` | Separate `pgadmin-data` named volume |

PostgreSQL is not published on a host port. pgAdmin is bound to localhost; 5052 avoids the existing server's pgAdmin ports 5050 and 5051. Verify the chosen host ports are available before starting. App and database credentials are separate from the pgAdmin login.

## Run on Windows with Docker Desktop

Keep Docker Desktop running in Linux-container mode. The image has already been built as `plan-reminder:2026-09-15-postgres`. To rebuild from source later:

```powershell
cd D:\plan-reminder
docker build --platform linux/amd64 -t plan-reminder:2026-09-15-postgres .
```

Generate private settings once. This creates `.env.postgres` and refuses to overwrite it; your legacy `.env` stays unchanged:

```powershell
docker run --rm --mount "type=bind,source=$PWD,target=/setup" --entrypoint node plan-reminder:2026-09-15-postgres scripts/setup-env.js /setup/.env.postgres
notepad .env.postgres
```

Set `PGADMIN_EMAIL` to the email you want to use for pgAdmin. Four different random secrets have already been generated. Keep them private and stable. SMTP is initially unconfigured; copy the existing SMTP settings privately if you want email delivery. SMTP test verification during development used mocks and did not send email.

### Preserve existing local data

Before starting `app`, set `MIGRATION_DIR=D:/plan-reminder` in `.env.postgres`. Stop the old local Node app while importing so the JSON files are not being edited. Then run:

```powershell
docker compose --env-file .env.postgres up -d db
docker compose --env-file .env.postgres --profile migration run --rm migrate-json
```

The importer prints account, plan, image, and budget counts. It preserves password hashes and historical fields, normalizes legacy repetition/amount strings, accepts the older email-keyed plan format, and refuses to overwrite a populated destination. It copies images into PostgreSQL `BYTEA`. All imported rows commit together or roll back together. Source files are not modified.

For a deliberately empty installation, skip the import. The first registered account becomes the administrator. Do not register an empty replacement account when you intend to import existing accounts.

Start the services after the import succeeds:

```powershell
docker compose --env-file .env.postgres up -d --no-build
docker compose --env-file .env.postgres ps
```

Open <http://localhost:3005>. Imported users sign in with their existing passwords. Sessions from the old installation may need a fresh sign-in because the signing secret changed.

## Use pgAdmin

1. Open <http://localhost:5052>.
2. Sign in with `PGADMIN_EMAIL` and `PGADMIN_PASSWORD` from your `.env.postgres`.
3. Expand **Servers → Shangrila Tours → Plan Reminder**. The database connection is already registered.
4. If prompted for the database password, use **APP_DB_PASSWORD**, not PGADMIN_PASSWORD.
5. Expand **Databases → plan_reminder → Schemas → public → Tables**.

Tables include `users`, `plans`, `company_budgets`, `plan_uploads`, `email_digest_deliveries`, `schema_migrations`, and `data_imports`. Each user/plan is a separate row. JSONB documents retain historical fields, and generated columns expose common fields such as title, cost, status, and approval for SQL inspection. Task order is stored in `sort_order`. Use the web app for normal edits; generated columns are not directly editable.

The application connects as `plan_reminder_app`, a role without superuser, role-creation, or database-creation privileges. It owns the app's tables and can apply its schema migrations. See [pgAdmin container setup](https://www.pgadmin.org/docs/pgadmin4/9.17/container_deployment.html).

## Deploy on Linux using Git

Use the [Git deployment guide](deploy/GIT-DEPLOYMENT.md). On the server, clone this repository into a new directory, then run `python3 deploy.py install`. The command builds the images, verifies and backs up the known old planner, replaces only its container, migrates its data into PostgreSQL, and checks health. No archive upload from Windows is needed.

After installation, use `git pull --ff-only && python3 deploy.py update` from the checkout. Updates build a new app image, verify a database backup, and replace only the app while retaining the database and pgAdmin containers. A failed app update attempts to restore the previous image. Schema changes require a separately reviewed database upgrade.

Generated settings, state, credentials, and backups stay in the Git-ignored `deploy/runtime/` directory. PostgreSQL has no host port; pgAdmin uses localhost 5052 on the server. The app continues to use host port 3005. `python3 deploy.py status` shows deployment state and `python3 deploy.py backup` creates a verified PostgreSQL backup.

For a failed initial migration that explicitly restored the old planner, pull the correction and run `python3 deploy.py recover`. Recovery reuses the empty database volumes and private credentials, rejects populated or unexpected destinations, validates direct executable startup before downtime, and creates a new snapshot from the restored planner. See the linked guide for the exact guarded recovery procedure.

The root Compose file is for local/manual development. The Git installer uses its saved `deploy/runtime/compose.yaml` configuration so a Git pull cannot overwrite production secrets or recreate infrastructure automatically. The older archive-based installer remains available under `deploy/linux` for historical packages.

## HTTPS and email

For an existing HTTPS reverse proxy, set `PUBLIC_URL=https://your-existing-domain`, `COOKIE_SECURE=true`, and `TRUST_PROXY=1` only when all requests pass through exactly one trusted proxy. A proxy in another container needs an appropriate Docker network connection; its own localhost does not point to this app. Keep `COOKIE_SECURE=false` for local HTTP testing.

SMTP uses `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM`. Port 587 typically uses STARTTLS (`SMTP_SECURE=false`), while 465 uses implicit TLS (`true`). Legacy Gmail configurations with just SMTP_USER/SMTP_PASS remain supported. `DISABLE_SCHEDULER=true` disables automatic reminders during staging. Set it back to false when ready for normal reminders.

Daily delivery claims live in PostgreSQL so concurrent workers cannot normally send the same digest twice. If SMTP accepts a message but recording the success fails, the five-minute claim lease eventually permits retry; email delivery cannot be guaranteed exactly once across those systems.

## Backups and later updates

All business data, including image bytes, is in PostgreSQL. On Linux, take a database backup with:

```bash
cd ~/plan-reminder-postgres
umask 077
mkdir -p backups
docker compose --env-file .env.postgres exec -T db pg_dump -U postgres -d plan_reminder > "backups/planner-$(date +%Y%m%d-%H%M%S).sql"
```

Keep a private copy of `.env.postgres` and the deployment configuration, and test restoration into a separate database. A SQL dump of this database does not include PostgreSQL roles; the initialization script recreates the app role on a fresh installation. See [PostgreSQL backups](https://www.postgresql.org/docs/18/backup-dump.html).

For later app-only updates, back up first, load the new app image, update its tag in Compose, and run `docker compose --env-file .env.postgres up -d --no-deps --no-build app`. Startup applies new SQL migrations transactionally. Review migration compatibility before rolling back a future schema change.

Never delete volumes or restart the whole Docker daemon to update this app. Keep database passwords stable: changing an environment file does not change passwords already stored inside initialized PostgreSQL or pgAdmin volumes. PostgreSQL 18 uses the `/var/lib/postgresql` volume mount. [Official image documentation](https://hub.docker.com/_/postgres)

## Development and verification

Install Node.js 24+ and run `npm ci`. For direct Node execution configure `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` (or `DATABASE_URL`) and a strong `JWT_SECRET`. There is no automatic fallback to runtime JSON storage. `store.js` and `scripts/import-data.js` remain as legacy utilities; the new migration command is `scripts/import-json.js`.

Run `npm run check` for syntax checks. `npm test` requires `TEST_DATABASE_URL` pointing to a disposable PostgreSQL test database with permission to create test schemas. Each integration test group creates and removes its own uniquely named schema. Never use production admin credentials for routine testing.

Run `python3 -m unittest discover -s tests -p test_deploy.py` for deployment safeguards. The Git install/update workflow was also rehearsed in isolated Docker containers: initial migration, app-only replacement, simulated update failure with rollback, and restoring a PostgreSQL backup. The working app and the test database/pgAdmin containers retained their IDs and start times during app-only updates.

Validation covers API permissions, concurrent registration and ETag saves across two app instances, migration rollback and repeat-import refusal, task order, recurrence, NPR export, uploads, notification claims, and legacy data. A real Docker migration copied all 5 local accounts, 7 plans, and 3 images without modifying the originals. The app role's restricted privileges, pgAdmin's saved database connection, and database backup/restore were verified. The live Linux deployment has not been changed by this local work.
