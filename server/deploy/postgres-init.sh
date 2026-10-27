#!/bin/sh
# Runs once, when the database volume is first created. The app gets its own non-superuser
# role that owns only the voiceflow database; the postgres superuser is never used by the app.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<'SQL'
\set app_pw `cat /run/secrets/db_app_password`
CREATE ROLE voiceflow LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE DATABASE voiceflow OWNER voiceflow;
REVOKE ALL ON DATABASE voiceflow FROM PUBLIC;
SQL
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname voiceflow <<'SQL'
ALTER SCHEMA public OWNER TO voiceflow;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SQL
