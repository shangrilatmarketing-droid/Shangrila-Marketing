#!/bin/sh
(
set -eu
psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=app_password="$APP_DB_PASSWORD" <<'SQL'
CREATE ROLE plan_reminder_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT CONNECT ON DATABASE plan_reminder TO plan_reminder_app;
GRANT USAGE, CREATE ON SCHEMA public TO plan_reminder_app;
SQL
)
