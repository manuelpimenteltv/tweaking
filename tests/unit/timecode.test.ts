import { describe, expect, it } from "vitest";
import { frameToSeekTime, frameToTimecode, framesToTimecode, parseTimecode, secondsToFrame } from "@/lib/timecode";
import { shapeSchema } from "@/lib/review";

const f23 = { num: 24000, den: 1001 };
const f25 = { num: 25, den: 1 };
const f2997 = { num: 30000, den: 1001 };
const f5994 = { num: 60000, den: 1001 };

describe("timecode", () => {
  it("formats non-drop timecode", () => {
    expect(framesToTimecode(0, f25)).toBe("00:00:00:00");
    expect(framesToTimecode(25 * 3600 + 24, f25)).toBe("01:00:00:24");
    expect(framesToTimecode(24, f23)).toBe("00:00:01:00");
  });

  it("applies drop-frame rules at 29.97 and 59.94", () => {
    expect(framesToTimecode(1799, f2997)).toBe("00:00:59;29");
    expect(framesToTimecode(1800, f2997)).toBe("00:01:00;02"); // ;00 and ;01 are dropped
    expect(framesToTimecode(17982, f2997)).toBe("00:10:00;00"); // every 10th minute keeps them
    expect(framesToTimecode(107892, f2997)).toBe("01:00:00;00");
    expect(framesToTimecode(3600, f5994)).toBe("00:01:00;04");
  });

  it("round-trips through parsing", () => {
    for (const fps of [f23, f25, f2997, f5994]) {
      for (const n of [0, 1, 1799, 1800, 17982, 107892, 250_001]) {
        expect(parseTimecode(framesToTimecode(n, fps), fps)).toBe(n);
      }
    }
    expect(parseTimecode("01:00:00:25", f25)).toBeNull();
  });

  it("offsets by the clip's start timecode", () => {
    expect(frameToTimecode(48, f23, "01:00:00:00")).toBe("01:00:02:00");
    expect(frameToTimecode(0, f25, "14:22:31:08")).toBe("14:22:31:08");
  });

  it("seeks to the middle of a frame and maps media time back exactly", () => {
    for (const n of [0, 1, 100, 12_345]) {
      expect(secondsToFrame(frameToSeekTime(n, f23), f23)).toBe(n);
      expect(secondsToFrame((n * 1001) / 24000, f23)).toBe(n);
    }
  });
});

describe("annotation shapes", () => {
  it("validates geometry per tool", () => {
    expect(shapeSchema.safeParse({ tool: "arrow", points: [[0.1, 0.1], [0.5, 0.5]], color: "#F2A93B", width: 3 }).success).toBe(true);
    expect(shapeSchema.safeParse({ tool: "rect", points: [[0.1, 0.1]], color: "#F2A93B", width: 3 }).success).toBe(false);
    expect(shapeSchema.safeParse({ tool: "text", points: [[0.1, 0.1]], color: "#FFFFFF", width: 3 }).success).toBe(false);
    expect(shapeSchema.safeParse({ tool: "line", points: [[2, 0], [0, 0]], color: "#FFFFFF", width: 3 }).success).toBe(false);
    expect(shapeSchema.safeParse({ tool: "ellipse", points: [[0, 0], [1, 1]], color: "red", width: 3 }).success).toBe(false);
  });
});
