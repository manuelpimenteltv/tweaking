/**
 * Frame-accurate time math shared by the player (client) and services (server).
 * Frame rates are rationals (24000/1001), never floats, so frame numbers are exact.
 */
export type Fps = { num: number; den: number };

export const DEFAULT_FPS: Fps = { num: 24, den: 1 };

export function fpsValue(fps: Fps): number {
  return fps.num / fps.den;
}

/** Nominal integer rate used by SMPTE counting (23.976 → 24, 29.97 → 30). */
export function nominalRate(fps: Fps): number {
  return Math.round(fps.num / fps.den);
}

/** NTSC 29.97 / 59.94 use drop-frame timecode by convention. */
export function isDropFrame(fps: Fps): boolean {
  return fps.den === 1001 && (nominalRate(fps) === 30 || nominalRate(fps) === 60);
}

/** Presentation time of the *middle* of a frame: seeking there lands on that frame, not its neighbour. */
export function frameToSeekTime(frame: number, fps: Fps): number {
  return ((frame + 0.5) * fps.den) / fps.num;
}

export function frameToSeconds(frame: number, fps: Fps): number {
  return (frame * fps.den) / fps.num;
}

/** Frame displayed at media time t (small epsilon absorbs float error from the decoder). */
export function secondsToFrame(t: number, fps: Fps): number {
  return Math.max(0, Math.floor((t * fps.num) / fps.den + 1e-4));
}

export function frameCount(durationSec: number | undefined, fps: Fps): number | null {
  if (!durationSec || !Number.isFinite(durationSec)) return null;
  return Math.max(1, Math.round((durationSec * fps.num) / fps.den));
}

/** "HH:MM:SS:FF" (or "HH:MM:SS;FF" for drop-frame) → frame count from 00:00:00:00. */
export function parseTimecode(tc: string, fps: Fps): number | null {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})[:;.](\d{2,3})$/.exec(tc.trim());
  if (!m) return null;
  const [h, mi, s, f] = m.slice(1).map(Number);
  const rate = nominalRate(fps);
  if (mi > 59 || s > 59 || f >= rate) return null;
  let frames = ((h * 60 + mi) * 60 + s) * rate + f;
  if (isDropFrame(fps)) {
    const drop = rate === 60 ? 4 : 2;
    const totalMinutes = h * 60 + mi;
    frames -= drop * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return frames;
}

/** Frame count → SMPTE timecode, with drop-frame compensation for 29.97/59.94. */
export function framesToTimecode(totalFrames: number, fps: Fps): string {
  const rate = nominalRate(fps);
  let frames = Math.max(0, Math.floor(totalFrames));
  const df = isDropFrame(fps);
  if (df) {
    const drop = rate === 60 ? 4 : 2;
    const perMinute = rate * 60 - drop;
    const perTenMinutes = perMinute * 10 + drop;
    const tens = Math.floor(frames / perTenMinutes);
    const rem = frames % perTenMinutes;
    frames += drop * 9 * tens + (rem > drop ? drop * Math.floor((rem - drop) / perMinute) : 0);
  }
  const f = frames % rate;
  const s = Math.floor(frames / rate) % 60;
  const m = Math.floor(frames / (rate * 60)) % 60;
  const h = Math.floor(frames / (rate * 3600)) % 24;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${df ? ";" : ":"}${pad(f)}`;
}

/** Timecode of `frame` within a clip whose first frame carries `startTimecode`. */
export function frameToTimecode(frame: number, fps: Fps, startTimecode?: string | null): string {
  const start = startTimecode ? (parseTimecode(startTimecode, fps) ?? 0) : 0;
  return framesToTimecode(start + frame, fps);
}
