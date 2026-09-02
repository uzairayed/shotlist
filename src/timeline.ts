import type { Shot, ShotlistJson, TakeMeta } from "./types.js";
import { playingDuration, transitionDuration } from "./shotlist.js";

export interface TimelineShot {
  shot: Shot;
  index: number;
  start: number;
  end: number;
  playing: number;
  crossfadeIn: number;
}

export function buildTimeline(
  shotlist: ShotlistJson,
  defaultFreeze = 500,
): { shots: TimelineShot[]; duration: number } {
  const shots: TimelineShot[] = [];
  let t = 0;
  let totalCrossfade = 0;
  for (let i = 0; i < shotlist.shots.length; i++) {
    const shot = shotlist.shots[i];
    const playing = playingDuration(shot, defaultFreeze);
    const crossfadeIn = transitionDuration(shot.transition_in, i === 0);
    if (crossfadeIn > 0) {
      t -= crossfadeIn;
      totalCrossfade += crossfadeIn;
    }
    const start = t;
    const end = start + playing;
    shots.push({ shot, index: i, start, end, playing, crossfadeIn });
    t = end;
  }
  const sumPlaying = shotlist.shots.reduce(
    (acc, s) => acc + playingDuration(s, defaultFreeze),
    0,
  );
  return { shots, duration: sumPlaying - totalCrossfade };
}

export function shotsAtEditTime(
  timeline: TimelineShot[],
  tEdit: number,
): Array<{ ts: TimelineShot; tLocal: number }> {
  const hits: Array<{ ts: TimelineShot; tLocal: number }> = [];
  for (const ts of timeline) {
    if (tEdit >= ts.start - 1e-9 && tEdit < ts.end - 1e-9) {
      hits.push({ ts, tLocal: tEdit - ts.start });
    }
  }
  // Inclusive end for last frame
  if (hits.length === 0 && timeline.length > 0) {
    const last = timeline[timeline.length - 1];
    if (Math.abs(tEdit - last.end) < 1e-6) {
      hits.push({ ts: last, tLocal: last.playing });
    }
  }
  return hits;
}

export function sourceTimeForShot(
  shot: Shot,
  tLocal: number,
): { tSrc: number; frozen: boolean } {
  const play = shot.src.out - shot.src.in;
  if (tLocal < play - 1e-9) {
    return { tSrc: shot.src.in + tLocal, frozen: false };
  }
  return { tSrc: shot.src.out, frozen: true };
}

export function editTimeForShotLocal(
  timeline: TimelineShot[],
  shotId: string,
  shotTime: number,
): { tEdit: number; ts: TimelineShot } | null {
  const ts = timeline.find((t) => t.shot.id === shotId);
  if (!ts) return null;
  return { tEdit: ts.start + shotTime, ts };
}

export function firstShotCoveringSource(
  timeline: TimelineShot[],
  takeId: string,
  sourceT: number,
): TimelineShot | null {
  for (const ts of timeline) {
    if (ts.shot.take !== takeId) continue;
    if (sourceT >= ts.shot.src.in - 1e-9 && sourceT <= ts.shot.src.out + 1e-9) {
      return ts;
    }
  }
  return null;
}

export function totalOutputFrames(
  duration: number,
  fps: number,
): number {
  return Math.max(0, Math.round(duration * fps));
}

export function frameIndex(t: number, fps: number, frameCount: number): number {
  return Math.min(frameCount - 1, Math.max(0, Math.round(t * fps)));
}

export function takeFrameIndex(
  tSrc: number,
  meta: TakeMeta,
): number {
  const count = Math.max(1, Math.round(meta.duration * meta.fps));
  return frameIndex(tSrc, meta.fps, count);
}
