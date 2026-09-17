# Deploy from GitHub on the Linux server

Run these commands in **Cockpit → Terminal** as `shangrila002`. Docker is already installed on the server. The first installation needs Git, Python 3, Docker Compose 2.30+, Linux x86_64, internet access for Docker images, and sufficient disk space for images plus backups (the installer checks a 2 GiB minimum).

## First installation

Pause edits in the old planner for the installation window. Clone into a **new folder**, leaving `/home/shangrila002/marketing-planner` intact:

```bash
git clone https://github.com/shangrilatmarketing-droid/Shangrila-Marketing.git ~/Shangrila-Marketing &&
cd ~/Shangrila-Marketing &&
python3 deploy.py install
```

If this repository has already been cloned into that folder, use:

```bash
cd ~/Shangrila-Marketing &&
git pull --ff-only &&
python3 deploy.py install
```

Wait for **DONE**. The installer:

1. Checks the exact old container `shangrila-marketing-tracker-v2`, its data mounts, and the new project's ports/resources.
2. Builds the app from the Git checkout and prepares PostgreSQL 18.6 and pgAdmin 9.17 while the old app continues running. No Windows file upload is required.
3. Saves the old image and settings, stops only the old planner, and verifies a final backup of the server's JSON files and uploaded images.
4. Removes only that old container, preserving its original files and backup. Starts the new project's PostgreSQL and pgAdmin, imports accounts/tasks/budgets/images, and starts the app on port **3005**.
5. Verifies health and compares other running containers' IDs and start times. If replacement fails, it attempts to recreate and restart the old planner.

Open **http://110.44.121.225:3005** and use your existing account/password. Check tasks, images, history, NPR budgets, and task dragging. An old session may need a fresh login. SMTP settings are carried forward; reminder scheduling resumes with its previous enabled/disabled setting.

All generated settings and backups are in **`deploy/runtime/`**, which Git ignores. Keep this directory and the clone in place. Its Docker project is `plan-reminder-postgres`. Existing applications, PostgreSQL containers, and pgAdmin containers remain separate. The installer does not restart the Docker daemon, remove other projects, or delete volumes.

If `install` reports an existing deployment or another error, keep the directory and share the error text. Do not remove the state/settings files and rerun an import into an existing database. Use `status` to inspect progress. A hard interruption, server shutdown, or failed automatic rollback needs review before retrying.

### Recover the September 15 importer startup failure

If the first installation reported `docker-entrypoint.sh: operation not permitted` and said the old planner was recreated, update the checkout and use the guarded recovery command:

```bash
cd ~/Shangrila-Marketing &&
git pull --ff-only &&
python3 deploy.py recover
```

Recovery retains the previously created empty PostgreSQL and pgAdmin volumes and their passwords. Before stopping the restored old planner, it verifies the exact old container and mounts, confirms the destination database contains no imported business data, builds the corrected image, and proves that both restricted app execution modes can start. It then takes a **new final snapshot** from the currently running old planner, imports it, and checks health. It refuses recovery when it sees unexpected tables/data, changed ports, an unrecognized container, or a completed installation.

Do not delete `deploy/runtime`, its backups, or the `plan-reminder-postgres` volumes before recovery. If the old planner cannot currently save, avoid creating or editing tasks until recovery finishes so the verified snapshot remains consistent.

## Future updates after Git pull

```bash
cd ~/Shangrila-Marketing &&
git pull --ff-only &&
python3 deploy.py update
```

`git pull` downloads source changes; the Python command builds and applies them to Docker. The update command verifies ownership of this installation, builds a uniquely tagged app image, saves and checks a PostgreSQL dump and the previous image/settings, then recreates **only the app**. The database and pgAdmin containers keep running. If app startup fails, it attempts to restore the previous app image while keeping PostgreSQL data as it is.

The updater refuses changed SQL migration files because database schema upgrades require a separate reviewed migration and rollback plan. It also retains the installed infrastructure configuration, so PostgreSQL/pgAdmin upgrades and changes to their deployment settings are deliberate operations. It refuses a dirty Git checkout and concurrent deployments. It does not reset local Git changes, recreate databases, or repeat the JSON import.

## Restore a verified legacy snapshot after an empty import

If the installed PostgreSQL database has no `data_imports` record and is missing the verified JSON data, use `restore-legacy` with the exact backup folder. It validates every snapshot checksum, builds and tests the current image, previews overlaps, saves and validates a PostgreSQL dump plus the previous app image, and then performs one transactional merge. Current users/plans win only when their IDs collide; missing legacy users, plans, budgets, reminders, and images are restored. Conflicting image bytes or a previous import stop the operation without changes.

```bash
cd ~/Shangrila-Marketing
git pull --ff-only
python3 deploy.py restore-legacy --snapshot deploy/runtime/backups/legacy-YYYYMMDD-HHMMSS-xxxxxx
```

## Open the server's pgAdmin

On your Windows PC, open PowerShell:

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 15052:127.0.0.1:5052 shangrila002@110.44.121.225
```

Keep that window open and visit **http://localhost:15052**. If the public SSH endpoint needs the already verified host alias on this PC, use:

```powershell
ssh -N -o HostKeyAlias=100.94.204.57 -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -L 15052:127.0.0.1:5052 shangrila002@110.44.121.225
```

In Cockpit, read your credentials privately:

```bash
cat ~/Shangrila-Marketing/deploy/runtime/ACCESS.txt
```

Use the **pgAdmin email/password** to log in. Expand **Servers → Shangrila Tours → Plan Reminder**. When the database connection asks for a password, use the separate **APP_DB_PASSWORD** from that file. Tables are under **Databases → plan_reminder → Schemas → public → Tables**.

PostgreSQL has no published host port. pgAdmin listens only on server localhost **5052**; the tunnel's local port **15052** avoids the Windows Docker Desktop pgAdmin at 5052. Do not share `ACCESS.txt`, `.env.postgres`, `.app.env`, or backups. Changing an environment file alone does not change passwords inside initialized PostgreSQL/pgAdmin storage.

## Status and backups

```bash
cd ~/Shangrila-Marketing
python3 deploy.py status
curl --fail http://127.0.0.1:3005/health
python3 deploy.py backup
```

The health response includes `"database":"postgresql"`. `backup` saves and validates a PostgreSQL custom-format dump plus private deployment settings under `deploy/runtime/backups/postgres-*`. Copy backups to separate storage privately. All planner data, including image bytes, is in PostgreSQL. Database dumps do not include global PostgreSQL roles; the initialization script recreates the application role for a fresh restore. pgAdmin preferences remain in its separate volume.

To inspect this project's containers/logs only:

```bash
docker compose --env-file deploy/runtime/.env.postgres -p plan-reminder-postgres -f deploy/runtime/compose.yaml ps
docker compose --env-file deploy/runtime/.env.postgres -p plan-reminder-postgres -f deploy/runtime/compose.yaml logs --tail=50 app
```

References: [Docker service updates](https://docs.docker.com/reference/cli/docker/compose/up/), [PostgreSQL backups](https://www.postgresql.org/docs/18/backup-dump.html).

## Configure Gmail notifications

Create a Google App Password using the same Google account that will send the planner emails. Enter it only at the hidden terminal prompt; do not paste the password into source files, chat, or shell commands.

```bash
cd ~/Shangrila-Marketing && git pull --ff-only
python3 configure_email.py --sender your-sender@gmail.com
```

The helper verifies the installed planner identity, checks Gmail authentication before saving credentials, and recreates only the app using its existing image. It verifies that the new settings reached the running app and restores the prior settings if applying them fails. It does not send an email, build an image, update the database, or recreate PostgreSQL or pgAdmin. After it reports `DONE`, use **Settings > Send test email**; delivery goes to the email address signed into the planner.

Run the script directly in a Linux terminal. It refuses piped or visibly echoed password input. Spaces in Google's grouped App Password are accepted, and incorrect input can be retried. Keep `deploy/runtime/.app.env` private. Google instructions: [Create an App Password](https://support.google.com/accounts/answer/185833).
