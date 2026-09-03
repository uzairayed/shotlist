import { ease, type EaseName } from "./camera.js";

/** Spacing for authored pointer_move samples during travel and dwell. */
export const POINTER_SAMPLE_STEP_S = 0.05;

export interface PointerPathPoint {
  t: number;
  x: number;
  y: number;
}

export function easedPointerSamples(opts: {
  from: { x: number; y: number };
  to: { x: number; y: number };
  t0: number;
  duration: number;
  easeName: EaseName;
  stepS?: number;
}): PointerPathPoint[] {
  const { from, to, t0, duration, easeName } = opts;
  if (duration <= 0) return [{ t: t0, x: to.x, y: to.y }];
  const step = opts.stepS ?? POINTER_SAMPLE_STEP_S;
  const n = Math.max(2, Math.round(duration / step));
  const out: PointerPathPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const uRaw = i / n;
    const u = ease(easeName, uRaw);
    out.push({
      t: t0 + duration * uRaw,
      x: from.x + (to.x - from.x) * u,
      y: from.y + (to.y - from.y) * u,
    });
  }
  return out;
}

export function restPointerSamples(opts: {
  at: { x: number; y: number };
  t0: number;
  duration: number;
  stepS?: number;
}): PointerPathPoint[] {
  const { at, t0, duration } = opts;
  if (duration <= 0) return [{ t: t0, x: at.x, y: at.y }];
  const step = opts.stepS ?? POINTER_SAMPLE_STEP_S;
  const n = Math.max(1, Math.round(duration / step));
  const out: PointerPathPoint[] = [];
  for (let i = 0; i <= n; i++) {
    out.push({
      t: t0 + (duration * i) / n,
      x: at.x,
      y: at.y,
    });
  }
  return out;
}
