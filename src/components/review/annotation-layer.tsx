"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { AnnotationShape, AnnotationTool } from "@/server/db/schema";

/**
 * Vector annotations over the picture. Points are normalized to the displayed
 * picture (0–1), so drawings line up at any player size, in fullscreen and on
 * every proxy resolution. Stroke widths are defined against a 1000 px-wide
 * picture and scaled to the current size.
 */

type Size = { width: number; height: number };

const scaleOf = (size: Size) => size.width / 1000;

export function ShapeView({ shape, size }: { shape: AnnotationShape; size: Size }) {
  const k = scaleOf(size);
  const pts = shape.points.map(([x, y]) => [x * size.width, y * size.height] as const);
  const stroke = shape.color;
  const sw = Math.max(1, shape.width * k);
  const common = { stroke, strokeWidth: sw, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (shape.tool) {
    case "freehand":
      return <polyline points={pts.map((p) => p.join(",")).join(" ")} {...common} />;
    case "highlight":
      return <polyline points={pts.map((p) => p.join(",")).join(" ")} {...common} strokeWidth={sw * 5} strokeOpacity={0.35} />;
    case "line":
      return <line x1={pts[0][0]} y1={pts[0][1]} x2={pts[1][0]} y2={pts[1][1]} {...common} />;
    case "arrow": {
      const [a, b] = pts;
      const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const head = Math.max(16, sw * 5);
      const p1 = [b[0] - head * Math.cos(angle - Math.PI / 7), b[1] - head * Math.sin(angle - Math.PI / 7)];
      const p2 = [b[0] - head * Math.cos(angle + Math.PI / 7), b[1] - head * Math.sin(angle + Math.PI / 7)];
      return (
        <g>
          <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} {...common} />
          <polygon points={`${b[0]},${b[1]} ${p1.join(",")} ${p2.join(",")}`} fill={stroke} stroke={stroke} strokeWidth={sw / 2} strokeLinejoin="round" />
        </g>
      );
    }
    case "rect": {
      const [a, b] = pts;
      return <rect x={Math.min(a[0], b[0])} y={Math.min(a[1], b[1])} width={Math.abs(b[0] - a[0])} height={Math.abs(b[1] - a[1])} {...common} />;
    }
    case "ellipse": {
      const [a, b] = pts;
      return <ellipse cx={(a[0] + b[0]) / 2} cy={(a[1] + b[1]) / 2} rx={Math.abs(b[0] - a[0]) / 2} ry={Math.abs(b[1] - a[1]) / 2} {...common} />;
    }
    case "text":
      return (
        <text
          x={pts[0][0]}
          y={pts[0][1]}
          fill={stroke}
          fontSize={Math.max(11, shape.width * 6 * k)}
          fontWeight={600}
          dominantBaseline="hanging"
          style={{ paintOrder: "stroke", stroke: "rgba(0,0,0,0.6)", strokeWidth: Math.max(2, shape.width * k) }}
        >
          {shape.text}
        </text>
      );
  }
}

export type DrawSettings = { tool: AnnotationTool; color: string; width: number };

export function AnnotationLayer({
  size,
  shapes,
  draft,
  drawing,
  settings,
  onAdd,
}: {
  size: Size;
  /** Saved annotations to display (already filtered by frame/visibility). */
  shapes: AnnotationShape[];
  /** Shapes being drawn for the comment in progress. */
  draft: AnnotationShape[];
  drawing: boolean;
  settings: DrawSettings;
  onAdd: (shape: AnnotationShape) => void;
}) {
  const [live, setLive] = useState<AnnotationShape | null>(null);
  const [textAt, setTextAt] = useState<[number, number] | null>(null);
  const svg = useRef<SVGSVGElement>(null);

  const norm = (e: ReactPointerEvent): [number, number] => {
    const r = svg.current!.getBoundingClientRect();
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return [clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height)];
  };

  const onDown = (e: ReactPointerEvent) => {
    if (!drawing || e.button !== 0) return;
    e.preventDefault();
    const p = norm(e);
    if (settings.tool === "text") {
      setTextAt(p);
      return;
    }
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setLive({ tool: settings.tool, color: settings.color, width: settings.width, points: [p, p] });
  };
  const onMove = (e: ReactPointerEvent) => {
    if (!live) return;
    const p = norm(e);
    setLive((s) =>
      !s ? s : s.tool === "freehand" || s.tool === "highlight" ? { ...s, points: [...s.points, p].slice(-2000) } : { ...s, points: [s.points[0], p] },
    );
  };
  const onUp = () => {
    if (!live) return;
    const [a, b] = [live.points[0], live.points[live.points.length - 1]];
    const moved = Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.005;
    if (moved) onAdd(live);
    setLive(null);
  };

  return (
    <div className="absolute inset-0" style={{ cursor: drawing ? (settings.tool === "text" ? "text" : "crosshair") : "default", pointerEvents: drawing ? "auto" : "none" }}>
      <svg
        ref={svg}
        width={size.width}
        height={size.height}
        className="absolute inset-0 touch-none"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => setLive(null)}
        data-testid="annotation-layer"
        aria-label={drawing ? "Drawing area" : "Annotations"}
      >
        {shapes.map((s, i) => (
          <ShapeView key={`s${i}`} shape={s} size={size} />
        ))}
        {draft.map((s, i) => (
          <ShapeView key={`d${i}`} shape={s} size={size} />
        ))}
        {live && <ShapeView shape={live} size={size} />}
      </svg>
      {textAt && <TextEntry key={textAt.join(",")} at={textAt} size={size} color={settings.color} onDone={(text) => {
        if (text) onAdd({ tool: "text", points: [textAt], color: settings.color, width: settings.width, text });
        setTextAt(null);
      }} />}
    </div>
  );
}

/** Inline text entry for the text tool; commits exactly once (Enter or blur), Esc cancels. */
function TextEntry({ at, size, color, onDone }: { at: [number, number]; size: Size; color: string; onDone: (text: string) => void }) {
  const done = useRef(false);
  const finish = (text: string) => {
    if (done.current) return;
    done.current = true;
    onDone(text.trim());
  };
  return (
    <input
      autoFocus
      aria-label="Annotation text"
      placeholder="Type, then Enter"
      maxLength={200}
      className="absolute rounded border border-accent bg-black/70 px-1.5 py-0.5 text-[13px] outline-none"
      style={{ left: at[0] * size.width, top: at[1] * size.height, color }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value);
        else if (e.key === "Escape") finish("");
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}
