/** Validation shared by the review UI and the review service. */
import { z } from "zod";

export const ANNOTATION_TOOLS = ["freehand", "arrow", "line", "rect", "ellipse", "text", "highlight"] as const;
export const ANNOTATION_COLORS = ["#F2A93B", "#F0645A", "#4CC38A", "#6CA8F0", "#FFFFFF", "#111111"] as const;

const coord = z.number().min(-0.05).max(1.05);
const point = z.tuple([coord, coord]);

export const shapeSchema = z
  .object({
    tool: z.enum(ANNOTATION_TOOLS),
    points: z.array(point).min(1).max(2000),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    width: z.number().min(0.5).max(40),
    text: z.string().trim().max(200).optional(),
  })
  .superRefine((s, ctx) => {
    const need = s.tool === "text" ? 1 : s.tool === "freehand" || s.tool === "highlight" ? 2 : 2;
    if (s.points.length < need) ctx.addIssue({ code: "custom", message: `${s.tool} needs ${need} points` });
    if (["arrow", "line", "rect", "ellipse"].includes(s.tool) && s.points.length !== 2) {
      ctx.addIssue({ code: "custom", message: `${s.tool} takes exactly 2 points` });
    }
    if (s.tool === "text" && !s.text) ctx.addIssue({ code: "custom", message: "Text annotations need text" });
  });

export const shapesSchema = z.array(shapeSchema).max(100, "At most 100 shapes per annotation.");

export const commentBody = z.string().trim().min(1, "Write a comment.").max(10_000, "Comment is too long.");

const unit = z.number().min(0).max(1);
export const regionSchema = z
  .object({ x: unit, y: unit, w: unit, h: unit })
  .refine((r) => r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001, "Region must lie inside the picture.");

export const CELL_REF = /^([A-Z]{1,3})([1-9]\d{0,6})$/;

/** Where a comment points. Which variants are valid depends on the asset kind (checked by the service). */
export const anchorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("frame"), frame: z.number().int().min(0) }),
  z.object({ type: z.literal("page"), page: z.number().int().min(1), region: regionSchema.optional() }),
  z.object({ type: z.literal("region"), region: regionSchema }),
  z.object({ type: z.literal("cell"), sheet: z.string().min(1).max(100), cell: z.string().regex(CELL_REF, "Use a cell reference like B7.") }),
]);
export type Anchor = z.infer<typeof anchorSchema>;

export const createThreadSchema = z
  .object({
    versionId: z.uuid(),
    /** null/absent = general comment on the version. */
    anchor: anchorSchema.nullable().optional(),
    /** Shorthand for { type: "frame", frame } (video). */
    frame: z.number().int().min(0).nullable().optional(),
    body: commentBody,
    mentions: z.array(z.uuid()).max(50).default([]),
    shapes: shapesSchema.default([]),
  })
  .transform(({ frame, anchor, ...rest }) => ({
    ...rest,
    anchor: anchor ?? (frame != null ? ({ type: "frame", frame } as Anchor) : null),
  }));

/** "B7" → { row: 6, col: 1 } (0-based). */
export function parseCellRef(ref: string): { row: number; col: number } | null {
  const m = CELL_REF.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]) - 1, col: col - 1 };
}

/** 0-based column index → letters ("A", "Z", "AA"…). */
export function columnLetters(col: number): string {
  let n = col + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export const replySchema = z.object({
  threadId: z.uuid(),
  body: commentBody,
  mentions: z.array(z.uuid()).max(50).default([]),
});

export const threadFilterSchema = z.object({
  status: z.enum(["all", "open", "resolved"]).default("all"),
  authorId: z.uuid().optional(),
  q: z.string().trim().max(200).optional(),
  annotated: z.boolean().optional(),
  /** "position": by frame / page / cell (general comments first). "timecode" is kept as an alias. */
  sort: z.enum(["position", "timecode", "oldest", "newest"]).default("position"),
});

export type CreateThreadInput = z.input<typeof createThreadSchema>;
export type ThreadFilter = z.input<typeof threadFilterSchema>;
