#!/bin/sh
# Runs once, when the bundled PostgreSQL volume is empty.
set -eu
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 <<'SQL'
\getenv app_password UI_REVIEW_DB_PASSWORD
CREATE ROLE ui_review LOGIN PASSWORD :'app_password';
GRANT CONNECT ON DATABASE ui_review TO ui_review;
GRANT USAGE, CREATE ON SCHEMA public TO ui_review;
SQL
