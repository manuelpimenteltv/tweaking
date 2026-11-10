// Copies PDF.js runtime assets (worker, CMaps, standard fonts, WASM decoders, ICC
// profiles) from node_modules into public/pdfjs so they're served same-origin and
// always match the installed library version. Runs before `dev` and `build`.
import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const root = dirname(require.resolve("pdfjs-dist/package.json"));
const out = join(process.cwd(), "public", "pdfjs");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(join(root, "build", "pdf.worker.min.mjs"), join(out, "pdf.worker.min.mjs"));
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) await cp(join(root, dir), join(out, dir), { recursive: true });
console.log(`PDF.js assets copied to ${out}`);
