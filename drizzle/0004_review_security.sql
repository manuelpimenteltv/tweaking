-- Review tables (Phase 2): tenant isolation, constraints and least-privilege grants.
ALTER TABLE comments ADD CONSTRAINT comments_body_len CHECK (char_length(body) BETWEEN 1 AND 10000);
--> statement-breakpoint
ALTER TABLE comment_threads ADD CONSTRAINT threads_frame_nonneg CHECK (frame IS NULL OR frame >= 0);
--> statement-breakpoint
ALTER TABLE comment_threads ADD CONSTRAINT threads_range CHECK (end_frame IS NULL OR (frame IS NOT NULL AND end_frame >= frame));
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['comment_threads','comments','comment_mentions','annotations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = app_org()) WITH CHECK (organization_id = app_org())', t);
  END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON comment_threads, comments, comment_mentions, annotations TO loupe_app;
