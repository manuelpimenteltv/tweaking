-- ════════════════════════════════════════════════════════════════════════════
-- Security layer: tenant context functions, constraints Drizzle cannot express,
-- append-only audit log, row-level security policies and least-privilege grants.
--
-- The app connects as a LOGIN role that is a member of `loupe_app` (see
-- scripts/db-bootstrap.sql). It owns nothing, so every policy below applies.
-- ════════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'loupe_app') THEN
    CREATE ROLE loupe_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
--> statement-breakpoint

-- Tenant context, set transaction-locally by withTenant() via set_config(..., true).
CREATE OR REPLACE FUNCTION app_org() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_user() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint

-- ── Constraints ─────────────────────────────────────────────────────────────
ALTER TABLE organizations ADD CONSTRAINT organizations_slug_format
  CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$');
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_email_lower CHECK (email = lower(email));
--> statement-breakpoint
ALTER TABLE folders ADD CONSTRAINT folders_name_len CHECK (char_length(name) BETWEEN 1 AND 255);
--> statement-breakpoint
ALTER TABLE assets ADD CONSTRAINT assets_name_len CHECK (char_length(name) BETWEEN 1 AND 255);
--> statement-breakpoint
ALTER TABLE asset_versions ADD CONSTRAINT asset_versions_size_nonneg CHECK (size_bytes >= 0);
--> statement-breakpoint
ALTER TABLE storage_locations ADD CONSTRAINT storage_locations_target
  CHECK (object_key IS NOT NULL OR external_id IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX folders_sibling_name_uq ON folders (project_id, parent_id, lower(name))
  NULLS NOT DISTINCT WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX workspaces_name_uq ON workspaces (organization_id, lower(name));
--> statement-breakpoint
-- Circular reference assets → asset_versions; deferred so both rows can be created in one transaction.
ALTER TABLE assets ADD CONSTRAINT assets_current_version_fk FOREIGN KEY (current_version_id)
  REFERENCES asset_versions(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

-- ── Append-only audit log ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint

-- ── Row-level security ──────────────────────────────────────────────────────
-- Standard tenant tables: rows are visible and writable only inside their org context.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'invitations','workspaces','projects','project_members','project_favorites','folders',
    'storage_connections','storage_locations','assets','asset_versions','upload_sessions',
    'processing_jobs','previews','activity_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = app_org()) WITH CHECK (organization_id = app_org())', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- Organizations: the current org, plus orgs the current user belongs to (org switcher).
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_read ON organizations FOR SELECT USING (
  id = app_org()
  OR id IN (SELECT organization_id FROM organization_members WHERE user_id = app_user() AND status = 'active')
);
--> statement-breakpoint
CREATE POLICY org_update ON organizations FOR UPDATE USING (id = app_org()) WITH CHECK (id = app_org());
--> statement-breakpoint

-- Memberships: the current org's members, plus the current user's own memberships elsewhere.
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY members_read ON organization_members FOR SELECT
  USING (organization_id = app_org() OR user_id = app_user());
--> statement-breakpoint
CREATE POLICY members_write ON organization_members FOR ALL
  USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());
--> statement-breakpoint

-- Roles: system roles are visible to everyone; custom roles only within their org.
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY roles_read ON roles FOR SELECT USING (organization_id IS NULL OR organization_id = app_org());
--> statement-breakpoint
CREATE POLICY roles_write ON roles FOR ALL
  USING (organization_id = app_org() AND NOT is_system)
  WITH CHECK (organization_id = app_org() AND NOT is_system);
--> statement-breakpoint

-- Users: yourself, and members of the current org. Nothing else.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY users_read ON users FOR SELECT USING (
  id = app_user()
  OR id IN (SELECT user_id FROM organization_members WHERE organization_id = app_org())
);
--> statement-breakpoint
CREATE POLICY users_update_self ON users FOR UPDATE USING (id = app_user()) WITH CHECK (id = app_user());
--> statement-breakpoint

-- Audit log: read and append within the org (immutability enforced by trigger).
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY audit_read ON audit_logs FOR SELECT USING (organization_id = app_org());
--> statement-breakpoint
CREATE POLICY audit_insert ON audit_logs FOR INSERT WITH CHECK (organization_id = app_org());
--> statement-breakpoint

-- ── Grants (deny by default) ────────────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO loupe_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_org(), app_user() TO loupe_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON
  invitations, workspaces, projects, project_members, project_favorites, folders,
  storage_connections, storage_locations, assets, asset_versions, upload_sessions,
  processing_jobs, previews, organization_members, roles
TO loupe_app;
--> statement-breakpoint
GRANT SELECT, UPDATE (name, branding, settings, updated_at) ON organizations TO loupe_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON activity_events, audit_logs TO loupe_app;
--> statement-breakpoint
GRANT SELECT ON storage_providers TO loupe_app;
--> statement-breakpoint
-- Users: never expose password_hash to the tenant role.
GRANT SELECT (id, email, name, avatar_url, email_verified_at, disabled_at, last_login_at, created_at, updated_at)
  ON users TO loupe_app;
--> statement-breakpoint
GRANT UPDATE (name, avatar_url, updated_at) ON users TO loupe_app;
--> statement-breakpoint
-- sessions and rate_limits: intentionally no grants (system path only).
SELECT 1;
