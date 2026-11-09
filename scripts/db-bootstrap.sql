-- Local development bootstrap. Run once as a PostgreSQL superuser:
--   psql -U postgres -f scripts/db-bootstrap.sql
-- Production: create equivalent roles via your managed-Postgres console or IaC.
--   loupe      owns the schema and runs migrations; also used by the narrow "system" data path.
--   loupe_app  NOLOGIN group role that holds the restricted, RLS-bound grants.
--   loupe_web  LOGIN role used by the web app and workers; member of loupe_app. Not an owner, so RLS applies.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'loupe') THEN
    CREATE ROLE loupe LOGIN PASSWORD 'loupe' CREATEDB CREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'loupe_app') THEN
    CREATE ROLE loupe_app NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'loupe_web') THEN
    CREATE ROLE loupe_web LOGIN PASSWORD 'loupe_web' NOBYPASSRLS IN ROLE loupe_app;
  END IF;
END $$;
SELECT 'CREATE DATABASE loupe OWNER loupe' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'loupe')\gexec
SELECT 'CREATE DATABASE loupe_test OWNER loupe' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'loupe_test')\gexec
