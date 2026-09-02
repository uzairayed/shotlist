import fs from "node:fs";
import path from "node:path";
import { takeDir } from "./takes.js";

export interface PointerSample {
  t: number;
  type: string;
  x: number;
  y: number;
  selector?: string;
  button?: number;
  key?: string;
}

export function loadEvents(takeId: string, root?: string): PointerSample[] {
  const p = path.join(takeDir(takeId, root), "events.jsonl");
  if (!fs.existsSync(p)) return [];
  const out: PointerSample[] = [];
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as PointerSample;
      out.push(ev);
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

const POINTER_TYPES = new Set([
  "pointer_move",
  "pointer_down",
  "pointer_up",
  "click",
]);

export function pointerSamples(events: PointerSample[]): PointerSample[] {
  return events.filter(
    (e) => POINTER_TYPES.has(e.type) && Number.isFinite(e.x) && Number.isFinite(e.y),
  );
}

/** Piecewise linear interpolation of pointer position at t_src. */
export function cursorFromEvents(
  events: PointerSample[],
  tSrc: number,
): { x: number; y: number } | null {
  const samples = pointerSamples(events);
  if (samples.length === 0) return null;
  if (tSrc < samples[0].t) return null;
  let i = 0;
  while (i < samples.length - 1 && samples[i + 1].t <= tSrc) i += 1;
  if (i >= samples.length - 1) {
    return { x: samples[samples.length - 1].x, y: samples[samples.length - 1].y };
  }
  const a = samples[i];
  const b = samples[i + 1];
  const span = b.t - a.t;
  const u = span <= 0 ? 1 : (tSrc - a.t) / span;
  return {
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
  };
}
