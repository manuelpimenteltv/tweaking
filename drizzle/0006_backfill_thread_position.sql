-- Threads created before position-based sorting (Phase 2 video comments) sort by their frame.
UPDATE comment_threads SET position = frame WHERE position IS NULL AND frame IS NOT NULL;
