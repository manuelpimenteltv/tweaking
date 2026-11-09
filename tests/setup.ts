import { afterAll } from "vitest";
import { closePools } from "@/server/db/client";

afterAll(async () => {
  await closePools();
});
