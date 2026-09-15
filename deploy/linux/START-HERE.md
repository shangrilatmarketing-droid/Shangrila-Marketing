# Deploy Plan Reminder on your Linux server

The PC work is complete. The app, PostgreSQL 18.6, and pgAdmin 9.17 are built for Linux/AMD64. Your local copy is running in Docker Desktop at http://localhost:3005. The Linux server has not been changed yet.

Use this single-file installer instead of the earlier manual deployment commands. It uses the **server's current data**, not the Windows copy.

## 1. Upload from Windows

Open **PowerShell on this PC** and paste:

```powershell
cd 'C:\Users\Hi\Documents\Codex\2026-09-14\d-plan-reminder\outputs\linux-deployment'
scp .\plan-reminder-linux.tar shangrila002@110.44.121.225:~/plan-reminder-linux.tar
```

Enter your Linux account password when asked. Nothing appears while you type it; this is normal. On the first SSH connection, compare the fingerprint with Cockpit's **Overview → Secure shell keys → Show fingerprints**, then accept it if it matches. Wait for the upload to reach 100%.

## 2. Install in Cockpit

Tell people using this planner to pause edits until the installer finishes. Open **Cockpit → Terminal**, logged in as `shangrila002`, and paste these lines together:

```bash
mkdir -m 700 ~/plan-reminder-postgres &&
tar -xf ~/plan-reminder-linux.tar -C ~/plan-reminder-postgres &&
python3 ~/plan-reminder-postgres/deploy-linux.py
```

The `&&` prevents the next step from running if the previous step fails. If the directory already exists, stop and share that error; do not overwrite it or delete its contents.

Keep the terminal open. The installer will:

1. Check the archive, Docker Compose, ports, and the old container's exact identity and data mounts.
2. Save the old image and private settings; stop only `shangrila-marketing-tracker-v2` and verify a backup of its final data.
3. **Remove that old container alone.** Its original JSON files, uploads, image, and backup remain available.
4. Start the new planner's own PostgreSQL and pgAdmin containers, import the old accounts/tasks/budgets/images, then start the planner on **3005**.
5. Check health and compare the other running containers' IDs and start times. If deployment fails after removal, attempt to recreate and restart the old planner automatically.

Wait for **DONE**. No separate Docker install, database creation, password generation, or manual migration command is needed. The package includes all three images, so it does not need to pull them from the internet.

The new Compose project is `plan-reminder-postgres`. It does not issue stop/remove/restart commands for any other application, change the Docker daemon, delete volumes, or change firewall/proxy settings. Existing PostgreSQL/pgAdmin containers on ports 5433, 5050, and 5051 are separate.

## 3. Open the planner

On your PC, open **http://110.44.121.225:3005**. Sign in with your existing planner account and password. Check your tasks, images, budgets, and task dragging. Refresh with Ctrl+F5 if the browser shows an older layout.

`http://localhost:3005` on your PC is still the Windows test copy; the IP address above opens the Linux deployment. If you normally use an existing domain, check that address too. Existing SMTP settings and valid session secrets are carried forward; reminder scheduling resumes with the previous enabled/disabled setting. Older sessions may require a fresh sign-in.

You can check the server status in Cockpit with:

```bash
cd ~/plan-reminder-postgres
python3 deploy-linux.py --status
docker compose --env-file .env.postgres -p plan-reminder-postgres -f compose.yaml ps
curl --fail http://127.0.0.1:3005/health
```

The health response should include `"database":"postgresql"`. Do not rerun the installer to start an installed app; it deliberately refuses a repeated migration.

## 4. Open this app's pgAdmin

In a **new Windows PowerShell window**, run:

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 15052:127.0.0.1:5052 shangrila002@110.44.121.225
```

Enter your Linux password and keep that window open. A blank terminal after login is normal. Open **http://localhost:15052** in your PC browser. This connects to pgAdmin on the Linux server. Port 15052 avoids the local Docker Desktop pgAdmin at 5052.

In the **Cockpit terminal**, display the generated login information privately:

```bash
cat ~/plan-reminder-postgres/ACCESS.txt
```

- Sign in to pgAdmin with the **pgAdmin email** and **pgAdmin password** from that file. The initial email is `admin@example.com`; it is a login name and does not need to receive email.
- Expand **Shangrila Tours → Plan Reminder** in pgAdmin's browser tree.
- When asked for the database password, use the separate **Database connection password (APP_DB_PASSWORD)** from `ACCESS.txt`.
- Browse **Databases → plan_reminder → Schemas → public → Tables** to inspect `users`, `plans`, `company_budgets`, and `plan_uploads`.

Keep `ACCESS.txt`, `.env.postgres`, `.app.env`, and backups private. PostgreSQL is available only inside this app's Docker network. pgAdmin listens on the server's localhost port 5052, so it does not require a public firewall opening. Database and pgAdmin passwords are different. Editing an environment file alone does not change a password in an existing database.

## If installation reports STOPPED

Keep the deployment directory, backups, and original `/home/shangrila002/marketing-planner` folder. Share the **STOPPED/error text** for the next step, without credentials. The installer rejects changed mounts, an unexpected container, an occupied pgAdmin port, a previous deployment, invalid source data, or a nonempty destination before proceeding further.

If the old container was already removed, the installer attempts rollback. A successful rollback is explicitly reported. If it says **Automatic rollback needs attention**, keep the terminal output and get help before running another deployment. Do not use broad cleanup commands or delete database volumes.

## Backups and future app updates

The initial backup is under `~/plan-reminder-postgres/backups/legacy-*`. All ongoing planner data, including images, lives in the new PostgreSQL volume. Back it up in the Cockpit terminal:

```bash
cd ~/plan-reminder-postgres
umask 077
docker compose --env-file .env.postgres -p plan-reminder-postgres -f compose.yaml exec -T db pg_dump -U postgres -d plan_reminder -Fc > "backups/planner-$(date +%Y%m%d-%H%M%S).dump"
```

Check the command succeeded, and keep a private copy of the dump plus `.env.postgres`, `.app.env`, `compose.yaml`, and `docker/` away from this server. pgAdmin preferences live in its separate `pgadmin-data` volume. The database initialization script recreates the application role when restoring into a fresh database; a database dump does not contain global PostgreSQL roles.

For future app changes, load the newly built app image, update the app and importer image tag in `compose.yaml`, and recreate **only the app** with:

```bash
docker compose --env-file .env.postgres -p plan-reminder-postgres -f compose.yaml up -d --no-deps --no-build --pull never --wait app
```

Back up before an update. Do not use the first-install importer again. Never discard PostgreSQL data to update application code. If users have already edited the new PostgreSQL app, reverting to the old JSON app would require reconciling those newer changes first.

## What was verified on this PC

All 31 application tests passed against PostgreSQL in Linux Docker. Local data migration preserved 5 accounts, 7 plans, and 3 images. pgAdmin's saved database connection and PostgreSQL backup/restore were checked. A separate installer rehearsal verified replacement, old-password login, preserved task history and images, passwords containing special characters, repeated-install refusal, and automatic rollback after simulated startup failure. Other working local containers kept their IDs and start times. Actual server deployment remains to be run using step 2.

References: [Docker Compose services and literal environment files](https://docs.docker.com/reference/compose-file/services/), [targeted container removal](https://docs.docker.com/reference/cli/docker/container/rm/), [pgAdmin container documentation](https://www.pgadmin.org/docs/pgadmin4/9.17/container_deployment.html), [PostgreSQL backup documentation](https://www.postgresql.org/docs/18/backup-dump.html).
