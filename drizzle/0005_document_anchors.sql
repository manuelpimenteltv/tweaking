ALTER TABLE "annotations" ADD COLUMN "page_number" integer;--> statement-breakpoint
ALTER TABLE "comment_threads" ADD COLUMN "page" integer;--> statement-breakpoint
ALTER TABLE "comment_threads" ADD COLUMN "position" double precision;