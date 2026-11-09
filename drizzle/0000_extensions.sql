-- Trigram indexes for permission-aware substring search on names.
-- pg_trgm is a trusted extension (PG13+), so the database owner can create it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
