import { describe, expect, it } from "vitest";
import { checkUploadable, declaredMimeIsPlausible, extensionOf, kindForExtension } from "@/lib/file-types";
import { contentMatchesKind } from "@/server/jobs/ingest";
import { renditionHeights, spriteLayout } from "@/server/jobs/proxy";
import { containerName, isVariableFrameRate, parseRational, toMediaInfo } from "@/server/media/probe";
import { PROJECT_ROLE_CEILING, SYSTEM_ORG_ROLES, SYSTEM_PROJECT_ROLES } from "@/server/authz/permissions";
import { safeKeySegment } from "@/server/storage/registry";
import { contentDisposition } from "@/server/storage/s3";

describe("media probing", () => {
  it("keeps frame rates rational", () => {
    expect(parseRational("24000/1001")).toEqual({ num: 24000, den: 1001 });
    expect(parseRational("0/0")).toBeUndefined();
  });

  it("detects variable frame rate", () => {
    expect(isVariableFrameRate({ num: 30, den: 1 }, { num: 30, den: 1 })).toBe(false);
    expect(isVariableFrameRate({ num: 60, den: 1 }, { num: 2997, den: 100 })).toBe(true);
  });

  it("names containers and judges browser playability", () => {
    expect(containerName({ format_name: "mov,mp4,m4a,3gp,3g2,mj2", tags: { major_brand: "qt  " } })).toBe("QuickTime (MOV)");
    expect(containerName({ format_name: "mov,mp4,m4a,3gp,3g2,mj2", tags: { major_brand: "isom" } })).toBe("MPEG-4");
    const prores = toMediaInfo({
      format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "10.0", tags: { major_brand: "qt  " } },
      streams: [{ codec_type: "video", codec_name: "prores", pix_fmt: "yuv422p10le", width: 3840, height: 2160, r_frame_rate: "25/1", avg_frame_rate: "25/1", tags: { timecode: "01:00:00:00" } }],
    });
    expect(prores).toMatchObject({ browserPlayable: false, fps: { num: 25, den: 1 }, startTimecode: "01:00:00:00", container: "QuickTime (MOV)" });
    const h264 = toMediaInfo({
      format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
      streams: [{ codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", r_frame_rate: "24/1", avg_frame_rate: "24/1" }, { codec_type: "audio", codec_name: "aac" }],
    });
    expect(h264.browserPlayable).toBe(true);
  });
});

describe("review proxies", () => {
  it("never upscales and keeps a 1080p/540p ladder", () => {
    expect(renditionHeights(2160)).toEqual([1080, 540]);
    expect(renditionHeights(1080)).toEqual([1080, 540]);
    expect(renditionHeights(720)).toEqual([720, 540]);
    expect(renditionHeights(360)).toEqual([360]);
    expect(renditionHeights(481)).toEqual([480]);
  });

  it("keeps timeline sprites at or under 100 thumbnails", () => {
    expect(spriteLayout(6)).toEqual({ interval: 1, count: 6, columns: 6, rows: 1 });
    expect(spriteLayout(3600)).toMatchObject({ interval: 36, count: 100, columns: 10, rows: 10 });
  });
});

describe("file policy", () => {
  it("classifies extensions and blocks executables", () => {
    expect(extensionOf("A001_C003.MXF")).toBe("mxf");
    expect(kindForExtension("mxf")).toBe("video");
    expect(kindForExtension("xlsx")).toBe("spreadsheet");
    expect(checkUploadable("run.exe", 10, 100)).toMatchObject({ ok: false });
    expect(checkUploadable("page.html", 10, 100)).toMatchObject({ ok: false });
    expect(checkUploadable("empty.mov", 0, 100)).toMatchObject({ ok: false });
    expect(checkUploadable("big.mov", 101, 100)).toMatchObject({ ok: false });
    expect(checkUploadable("cut.mov", 50, 100)).toMatchObject({ ok: true, kind: "video" });
  });

  it("rejects implausible declared types and mismatched content", () => {
    expect(declaredMimeIsPlausible("video", "text/html")).toBe(false);
    expect(declaredMimeIsPlausible("video", "")).toBe(true);
    expect(contentMatchesKind("image", "image/png")).toBe(true);
    expect(contentMatchesKind("video", "image/png")).toBe(false);
    expect(contentMatchesKind("document", "application/x-msdownload")).toBe(false);
    expect(contentMatchesKind("video", undefined)).toBe(true);
  });

  it("sanitizes object keys and download filenames", () => {
    const seg = safeKeySegment("../../etc/passwd");
    expect(seg).not.toContain("/");
    expect(seg.startsWith(".")).toBe(false);
    expect(safeKeySegment("clip\u0000.mov")).toBe("clip_.mov");
    expect(contentDisposition("attachment", 'Café "final".mov')).toBe(
      `attachment; filename="Caf_ _final_.mov"; filename*=UTF-8''Caf%C3%A9%20%22final%22.mov`,
    );
  });
});

describe("permission model invariants", () => {
  it("every org role has a project-role ceiling that references real project roles", () => {
    const projectKeys = new Set(SYSTEM_PROJECT_ROLES.map((r) => r.key));
    for (const r of SYSTEM_ORG_ROLES) {
      expect(PROJECT_ROLE_CEILING[r.key]?.length).toBeGreaterThan(0);
      for (const k of PROJECT_ROLE_CEILING[r.key]) expect(projectKeys.has(k)).toBe(true);
    }
  });

  it("only owners can manage billing; clients and guests never see internal areas", () => {
    const by = Object.fromEntries(SYSTEM_ORG_ROLES.map((r) => [r.key, new Set(r.permissions)]));
    expect(SYSTEM_ORG_ROLES.filter((r) => r.permissions.includes("org.manage_billing")).map((r) => r.key)).toEqual(["owner"]);
    expect(by.client.has("org.view_internal")).toBe(false);
    expect(by.guest.has("org.view_internal")).toBe(false);
  });
});
