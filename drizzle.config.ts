import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL_SYSTEM ?? "postgres://loupe:loupe@localhost:5432/loupe" },
  strict: true,
  verbose: true,
});
