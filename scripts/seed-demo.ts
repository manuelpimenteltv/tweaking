/**
 * Loads a demo studio with realistic projects, folders, media and members.
 *   pnpm seed:demo          (requires PostgreSQL, storage, FFmpeg; run the worker to process media)
 * Login: demo@loupe.dev / loupe-demo-2026
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import ExcelJS from "exceljs";
import sharp from "sharp";
import { resolveOrgContext, type AuthContext } from "../src/server/authz/context";
import { getSystemRole } from "../src/server/authz/roles";
import { closePools, systemDb } from "../src/server/db/client";
import { organizationMembers, organizations, users } from "../src/server/db/schema";
import { signUp } from "../src/server/modules/auth";
import { createFolder } from "../src/server/modules/assets";
import { createOrganization } from "../src/server/modules/organizations";
import { createProject, listProjects, setFavorite, upsertProjectMember } from "../src/server/modules/projects";
import { sofficeBinary } from "../src/server/jobs/documents";
import { completeUpload, initiateUpload, signUploadParts } from "../src/server/modules/uploads";
import { createWorkspace, listWorkspaces } from "../src/server/modules/workspaces";

const meta = { ip: "127.0.0.1", userAgent: "seed" };
const PASSWORD = "loupe-demo-2026";
const dir = mkdtempSync(join(tmpdir(), "loupe-seed-"));

async function user(name: string, email: string) {
  const [existing] = await systemDb().select().from(users).where(eq(users.email, email));
  if (existing) return existing;
  return (await signUp({ name, email, password: PASSWORD }, meta)).user;
}

function video(name: string, opts: { src: string; rate: string; tc: string; size?: string; secs?: number }) {
  const file = join(dir, name);
  execFileSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", `${opts.src}=size=${opts.size ?? "1920x1080"}:rate=${opts.rate}:duration=${opts.secs ?? 6}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${opts.secs ?? 6}`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-timecode", opts.tc, "-y", file,
  ]);
  return { name, data: readFileSync(file), mime: "video/mp4" };
}

async function still(name: string, w: number, h: number, colors: [string, string, string]) {
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${colors[0]}"/><stop offset="1" stop-color="${colors[1]}"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${w * 0.68}" cy="${h * 0.42}" r="${h * 0.22}" fill="${colors[2]}" opacity="0.9"/>
    <rect x="0" y="${h * 0.72}" width="100%" height="${h * 0.28}" fill="#000" opacity="0.35"/></svg>`;
  const data = await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
  return { name, data, mime: "image/jpeg" };
}

function pdf(name: string, title: string) {
  const body = `BT /F1 24 Tf 72 720 Td (${title}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return { name, data: Buffer.from(out), mime: "application/pdf" };
}

async function upload(ctx: AuthContext, projectId: string, folderId: string | null, f: { name: string; data: Buffer; mime: string }, assetId?: string) {
  const init = await initiateUpload(ctx, { projectId, folderId, assetId: assetId ?? null, filename: f.name, size: f.data.length, mimeType: f.mime });
  const parts = [];
  for (let n = 1; n <= init.partCount; n++) {
    const body = f.data.subarray((n - 1) * init.partSize, n * init.partSize);
    const checksum = createHash("sha256").update(body).digest("base64");
    const [s] = await signUploadParts(ctx, init.uploadId, { parts: [{ partNumber: n, checksumSha256: checksum }] });
    const res = await fetch(s.url, { method: "PUT", headers: s.headers, body: new Uint8Array(body) });
    if (!res.ok) throw new Error(`PUT failed ${res.status}`);
    parts.push({ partNumber: n, etag: res.headers.get("etag")!, checksumSha256: checksum });
  }
  await completeUpload(ctx, init.uploadId, { parts });
  return init.assetId;
}

/** Phase 3 samples: script (Word), deck (PowerPoint), budget (Excel), shot list (CSV), plate (TIFF). */
async function ensurePaperwork(ctx: AuthContext) {
  const name = "Aurora Motors — Paperwork";
  const existing = await listProjects(ctx, { q: "Paperwork" });
  if (existing.some((p) => p.name === name)) return;
  const workspaces = await listWorkspaces(ctx);
  const ws = workspaces.find((w) => w.name === "Commercials") ?? workspaces[0];
  const project = await createProject(ctx, {
    name,
    workspaceId: ws.id,
    clientName: "Aurora Motors",
    description: "Script, client deck, budget and reference plates for the Horizon spot.",
  });
  console.log("Adding document samples…");

  let office = true;
  const lo = (args: string[]) =>
    execFileSync(sofficeBinary(), [`-env:UserInstallation=file://${join(dir, "lo-profile")}`, "--headless", ...args], { stdio: "ignore", timeout: 120_000 });
  try {
    writeFileSync(
      join(dir, "Horizon_Script_v4.html"),
      `<html><body style="font-family: Courier New">
        <h1>HORIZON — 60s — Script v4</h1>
        <p><b>1. EXT. COASTAL ROAD — DAWN</b></p><p>The Aurora EV glides along the cliffs as the sun breaks the horizon.</p>
        <p>VO: Every road starts somewhere.</p>
        <p><b>2. INT. CAR — CONTINUOUS</b></p><p>MARINA (30s) smiles, eyes on the road.</p>
        <p style="page-break-before: always"><b>3. EXT. CITY BRIDGE — GOLDEN HOUR</b></p><p>The car crosses the bridge; city lights flicker on.</p>
        <p>VO: Where it takes you is up to you.</p><p><b>SUPER: AURORA. Go further.</b></p>
      </body></html>`,
    );
    lo(["--convert-to", "docx:MS Word 2007 XML", "--outdir", dir, join(dir, "Horizon_Script_v4.html")]);
    lo(["--convert-to", "pdf", "--outdir", dir, join(dir, "Horizon_Script_v4.docx")]);
    lo(["--infilter=impress_pdf_import", "--convert-to", "pptx", "--outdir", dir, join(dir, "Horizon_Script_v4.pdf")]);
    await upload(ctx, project.id, null, { name: "Horizon_Script_v4.docx", data: readFileSync(join(dir, "Horizon_Script_v4.docx")), mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    await upload(ctx, project.id, null, { name: "Horizon_Client_Deck.pptx", data: readFileSync(join(dir, "Horizon_Script_v4.pptx")), mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
  } catch {
    office = false;
    console.warn("LibreOffice not found: skipping the Word and PowerPoint samples (see docs/DEVELOPMENT.md).");
  }

  const wb = new ExcelJS.Workbook();
  const sum = wb.addWorksheet("Summary");
  sum.columns = [{ width: 28 }, { width: 16 }, { width: 12 }];
  sum.addRow(["Line item", "Cost", "Share"]).font = { bold: true };
  const lines: [string, number][] = [["Camera & lenses", 18500], ["Crew", 42300], ["Locations & permits", 9800], ["Post (edit, grade, mix)", 26400], ["Music license", 12000]];
  lines.forEach(([item, cost], i) => {
    const r = sum.addRow([item, cost, { formula: `B${i + 2}/B${lines.length + 2}`, result: 0 }]);
    r.getCell(2).numFmt = "$#,##0";
    r.getCell(3).numFmt = "0.0%";
  });
  const total = lines.reduce((a, [, c]) => a + c, 0);
  const t = sum.addRow(["Total", { formula: `SUM(B2:B${lines.length + 1})`, result: total }]);
  t.font = { bold: true };
  t.getCell(2).numFmt = "$#,##0";
  lines.forEach(([, cost], i) => (sum.getCell(`C${i + 2}`).value = { formula: `B${i + 2}/B${lines.length + 2}`, result: cost / total }));
  sum.getColumn(4).hidden = true;
  sum.getCell("D1").value = "Internal margin";
  const crew = wb.addWorksheet("Crew");
  crew.addRow(["Role", "Name", "Days", "Rate"]).font = { bold: true };
  [["Director", "L. Romero", 3, 2500], ["DP", "T. Herrera", 3, 1800], ["Gaffer", "J. Ortiz", 3, 900]].forEach((r) => crew.addRow(r));
  await upload(ctx, project.id, null, { name: "Horizon_Budget_v3.xlsx", data: Buffer.from(await wb.xlsx.writeBuffer()), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  await upload(ctx, project.id, null, {
    name: "Horizon_Shot_List.csv",
    data: Buffer.from(
      [
        "Shot,Scene,Lens,Move,Notes",
        "1A,1,24mm,Drone,Sunrise over cliffs",
        '1B,1,85mm,Tracking,"Car profile, low angle"',
        "2A,2,35mm,Static,Marina smiles",
        "3A,3,50mm,Crane,Bridge at golden hour",
      ].join("\n") + "\n",
    ),
    mime: "text/csv",
  });
  const plate = await still("Horizon_Plate_0042.jpg", 3000, 2000, ["#ff9a5a", "#3b1d60", "#fff1c1"]);
  await upload(ctx, project.id, null, { name: "Horizon_Plate_0042.tif", data: await sharp(plate.data).tiff().toBuffer(), mime: "image/tiff" });
  console.log(`Added the "${name}" project${office ? "" : " (without Office samples)"}.`);
}

async function main() {
  const slug = "northlight-post";
  const [exists] = await systemDb().select().from(organizations).where(eq(organizations.slug, slug));
  if (exists) {
    // Existing demo (e.g. created before Phase 3): only add what's missing.
    const [owner] = await systemDb().select().from(users).where(eq(users.email, "demo@loupe.dev"));
    const ctx = owner && (await resolveOrgContext(owner, slug, meta));
    if (ctx) await ensurePaperwork(ctx);
    console.log("Demo studio is up to date — log in with demo@loupe.dev /", PASSWORD);
    return;
  }
  const owner = await user("Marina Ortega", "demo@loupe.dev");
  await createOrganization(owner, { name: "Northlight Post", slug }, meta);
  const ctx = (await resolveOrgContext(owner, slug, meta))!;
  const orgId = ctx.orgId;

  const team = [
    ["Diego Salas", "diego@loupe.dev", "project_manager"],
    ["Lucía Romero", "lucia@loupe.dev", "editor"],
    ["Tomás Herrera", "tomas@loupe.dev", "reviewer"],
    ["Claire Benson", "claire@aurora-motors.example", "client"],
  ] as const;
  const members: Record<string, { id: string }> = {};
  for (const [name, email, role] of team) {
    const u = await user(name, email);
    const r = await getSystemRole(systemDb(), "organization", role);
    await systemDb().insert(organizationMembers).values({ organizationId: orgId, userId: u.id, roleId: r.id }).onConflictDoNothing();
    members[role] = u;
  }

  const [general] = await listWorkspaces(ctx);
  const commercials = await createWorkspace(ctx, { name: "Commercials", description: "Broadcast and online spots" });
  const longform = await createWorkspace(ctx, { name: "Long-form", description: "Documentary and series work" });

  console.log("Generating media…");
  const p1 = await createProject(ctx, {
    name: "Aurora Motors — “Horizon” 60s",
    workspaceId: commercials.id,
    clientName: "Aurora Motors",
    clientEmail: "claire@aurora-motors.example",
    description: "Hero 60s spot plus 30s and 15s cutdowns. Delivery: ProRes 4444 + H.264 web masters.",
    metadata: [
      { key: "PO", value: "AM-2026-0412" },
      { key: "Delivery", value: "Dec 12" },
    ],
  });
  const p1Edit = await createFolder(ctx, { projectId: p1.id, name: "Edit" });
  const p1Cuts = await createFolder(ctx, { projectId: p1.id, parentId: p1Edit.id, name: "Cuts" });
  const p1Selects = await createFolder(ctx, { projectId: p1.id, name: "Selects" });
  const p1Gfx = await createFolder(ctx, { projectId: p1.id, name: "Graphics" });
  await createFolder(ctx, { projectId: p1.id, name: "Delivery" });
  const cutV1 = await upload(ctx, p1.id, p1Cuts.id, video("Horizon_60s_v01.mp4", { src: "testsrc2", rate: "24000/1001", tc: "01:00:00:00" }));
  await upload(ctx, p1.id, p1Cuts.id, video("Horizon_60s_v02.mp4", { src: "testsrc", rate: "24000/1001", tc: "01:00:00:00" }), cutV1);
  await upload(ctx, p1.id, p1Cuts.id, video("Horizon_30s_v01.mp4", { src: "smptehdbars", rate: "24000/1001", tc: "01:00:00:00", secs: 4 }));
  await upload(ctx, p1.id, p1Selects.id, video("A001C003_260914_R2K1.mp4", { src: "smptebars", rate: "25", tc: "14:22:31:08", size: "1280x720", secs: 4 }));
  await upload(ctx, p1.id, p1Selects.id, video("A002C011_260914_R2K1.mp4", { src: "testsrc", rate: "25", tc: "15:04:12:19", size: "1280x720", secs: 4 }));
  await upload(ctx, p1.id, p1Gfx.id, await still("Horizon_endcard_v03.jpg", 1920, 1080, ["#0f2027", "#2c5364", "#f2a93b"]));
  await upload(ctx, p1.id, p1Gfx.id, await still("Horizon_title_lockup.jpg", 1920, 1080, ["#141e30", "#243b55", "#e8e8e8"]));
  await upload(ctx, p1.id, null, pdf("Horizon_Script_v4.pdf", "HORIZON - 60s - Script v4"));
  await upload(ctx, p1.id, null, pdf("Horizon_Deliverables_Spec.pdf", "Deliverables specification"));
  await upsertProjectMember(ctx, { projectId: p1.id, userId: members.editor.id, roleKey: "editor" });
  await upsertProjectMember(ctx, { projectId: p1.id, userId: members.reviewer.id, roleKey: "reviewer" });
  await upsertProjectMember(ctx, { projectId: p1.id, userId: members.client.id, roleKey: "client" });
  await setFavorite(ctx, p1.id, true);

  const p2 = await createProject(ctx, {
    name: "Tidewater — Episode 3",
    workspaceId: longform.id,
    clientName: "Saltmarsh Films",
    description: "Online, grade and mix for episode 3 of 6.",
    managerUserId: members.project_manager.id,
  });
  const p2Grade = await createFolder(ctx, { projectId: p2.id, name: "Grade stills" });
  await createFolder(ctx, { projectId: p2.id, name: "Online" });
  await upload(ctx, p2.id, null, video("TW_EP03_Rough_v05.mp4", { src: "testsrc2", rate: "25", tc: "10:00:00:00", size: "1280x720", secs: 8 }));
  await upload(ctx, p2.id, p2Grade.id, await still("TW03_sc12_grade_ref.jpg", 2048, 858, ["#1d3557", "#457b9d", "#f1faee"]));
  await upload(ctx, p2.id, p2Grade.id, await still("TW03_sc14_grade_ref.jpg", 2048, 858, ["#3d0c02", "#b5651d", "#ffd27f"]));
  await setFavorite(ctx, p2.id, true);

  const p3 = await createProject(ctx, {
    name: "Lumen Festival Trailer",
    workspaceId: general.id,
    clientName: "Lumen Arts",
    status: "on_hold",
  });
  await upload(ctx, p3.id, null, video("Lumen_Trailer_v02.mp4", { src: "rgbtestsrc", rate: "30", tc: "00:59:50:00", size: "1280x720", secs: 4 }));

  await createProject(ctx, { name: "Brand Guidelines Refresh", workspaceId: general.id, clientName: "Northlight (internal)", status: "completed" });

  await ensurePaperwork(ctx);
  console.log("Demo studio ready. Run the worker to process media. Login: demo@loupe.dev /", PASSWORD);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePools());
