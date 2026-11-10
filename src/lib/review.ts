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

export const createThreadSchema = z.object({
  versionId: z.uuid(),
  /** null = general comment on the version (not tied to a frame). */
  frame: z.number().int().min(0).nullable(),
  body: commentBody,
  mentions: z.array(z.uuid()).max(50).default([]),
  shapes: shapesSchema.default([]),
});

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
  sort: z.enum(["timecode", "oldest", "newest"]).default("timecode"),
});

export type CreateThreadInput = z.input<typeof createThreadSchema>;
export type ThreadFilter = z.input<typeof threadFilterSchema>;
