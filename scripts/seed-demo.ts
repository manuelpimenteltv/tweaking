/**
 * Loads a demo studio with realistic projects, folders, media and members.
 *   pnpm seed:demo          (requires PostgreSQL, storage, FFmpeg; run the worker to process media)
 * Login: demo@loupe.dev / loupe-demo-2026
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { resolveOrgContext, type AuthContext } from "../src/server/authz/context";
import { getSystemRole } from "../src/server/authz/roles";
import { closePools, systemDb } from "../src/server/db/client";
import { organizationMembers, organizations, users } from "../src/server/db/schema";
import { signUp } from "../src/server/modules/auth";
import { createFolder } from "../src/server/modules/assets";
import { createOrganization } from "../src/server/modules/organizations";
import { createProject, setFavorite, upsertProjectMember } from "../src/server/modules/projects";
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

async function main() {
  const slug = "northlight-post";
  const [exists] = await systemDb().select().from(organizations).where(eq(organizations.slug, slug));
  if (exists) {
    console.log("Demo studio already exists — log in with demo@loupe.dev");
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

  console.log("Demo studio ready. Run the worker to process media. Login: demo@loupe.dev /", PASSWORD);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePools());
