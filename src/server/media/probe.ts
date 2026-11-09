import type { MediaInfo } from "../db/schema";
import { run } from "./process";

type Stream = {
  codec_type?: string;
  codec_name?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  channels?: number;
  sample_rate?: string;
  color_space?: string;
  color_transfer?: string;
  tags?: Record<string, string>;
  disposition?: { attached_pic?: number };
};
type Probe = { streams?: Stream[]; format?: { format_name?: string; duration?: string; bit_rate?: string; tags?: Record<string, string> } };

export function parseRational(r: string | undefined): { num: number; den: number } | undefined {
  if (!r) return undefined;
  const [n, d] = r.split("/").map(Number);
  if (!Number.isFinite(n) || !Number.isFinite(d) || n <= 0 || d <= 0) return undefined;
  return { num: n, den: d };
}

/**
 * Variable frame rate heuristic: r_frame_rate (lowest common timebase rate)
 * disagreeing with avg_frame_rate by more than 0.1% indicates VFR. Comments on
 * VFR media are anchored to the normalized review proxy (docs/ARCHITECTURE.md risk #2).
 */
export function isVariableFrameRate(r?: { num: number; den: number }, avg?: { num: number; den: number }): boolean {
  if (!r || !avg) return false;
  const a = r.num / r.den;
  const b = avg.num / avg.den;
  return Math.abs(a - b) / a > 0.001;
}

const BROWSER_VIDEO = new Set(["h264", "vp8", "vp9", "av1"]);
const BROWSER_AUDIO = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);

export function toMediaInfo(p: Probe): MediaInfo {
  const streams = p.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === "audio");
  const container = p.format?.format_name;
  const fps = parseRational(video?.r_frame_rate);
  const avg = parseRational(video?.avg_frame_rate);
  const startTimecode =
    p.format?.tags?.timecode ?? streams.map((s) => s.tags?.timecode).find((t): t is string => !!t);
  const duration = Number(p.format?.duration);

  const containerOk = !!container && /(mp4|mov|webm|matroska|mp3|ogg|wav|flac|aac)/.test(container);
  const videoOk = !video || (BROWSER_VIDEO.has(video.codec_name ?? "") && (video.pix_fmt ?? "yuv420p") === "yuv420p");
  const audioOk = !audio || BROWSER_AUDIO.has(audio.codec_name ?? "") || audio.codec_name?.startsWith("pcm_") === true;

  return {
    container,
    durationSec: Number.isFinite(duration) ? duration : undefined,
    width: video?.width,
    height: video?.height,
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    pixelFormat: video?.pix_fmt,
    fps: video ? (avg && isVariableFrameRate(fps, avg) ? avg : fps) : undefined,
    vfr: video ? isVariableFrameRate(fps, avg) : undefined,
    startTimecode,
    bitRate: Number(p.format?.bit_rate) || undefined,
    audioChannels: audio?.channels,
    sampleRate: Number(audio?.sample_rate) || undefined,
    colorSpace: video?.color_space,
    colorTransfer: video?.color_transfer,
    browserPlayable: (!!video || !!audio) && containerOk && videoOk && audioOk,
  };
}

export async function ffprobe(bin: string, input: string, signal?: AbortSignal): Promise<MediaInfo> {
  const out = await run(
    bin,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-rw_timeout", "30000000", input],
    { timeoutMs: 120_000, signal, maxStdout: 8 * 1024 * 1024 },
  );
  return toMediaInfo(JSON.parse(out.toString("utf8")) as Probe);
}

/** Extracts one frame as PNG (for poster/thumbnail generation). */
export async function extractFrame(bin: string, input: string, atSeconds: number, signal?: AbortSignal): Promise<Buffer> {
  return run(
    bin,
    [
      "-v", "error",
      "-rw_timeout", "30000000",
      "-ss", atSeconds.toFixed(3),
      "-i", input,
      "-frames:v", "1",
      "-vf", "scale='min(1920,iw)':-2",
      "-f", "image2pipe",
      "-vcodec", "png",
      "pipe:1",
    ],
    { timeoutMs: 180_000, signal, maxStdout: 64 * 1024 * 1024 },
  );
}
