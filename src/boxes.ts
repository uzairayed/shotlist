import fs from "node:fs";
import path from "node:path";
import type { BoxesSnapshot, ElementBox } from "./types.js";
import { takeDir } from "./takes.js";
import { ToolError } from "./errors.js";

export function loadBoxes(takeId: string, root?: string): BoxesSnapshot[] {
  const p = path.join(takeDir(takeId, root), "boxes.jsonl");
  if (!fs.existsSync(p)) return [];
  const out: BoxesSnapshot[] = [];
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as BoxesSnapshot);
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** Greatest t' <= t. No interpolation. */
export function boxesAtTime(
  snapshots: BoxesSnapshot[],
  t: number,
): { t_snapshot: number | null; elements: ElementBox[] } {
  let best: BoxesSnapshot | null = null;
  for (const s of snapshots) {
    if (s.t <= t + 1e-9) best = s;
    else break;
  }
  if (!best) return { t_snapshot: null, elements: [] };
  return { t_snapshot: best.t, elements: best.elements };
}

export function findElementAtTime(
  takeId: string,
  selector: string,
  t: number,
  root?: string,
): ElementBox | null {
  const metaPath = path.join(takeDir(takeId, root), "meta.json");
  let eventT = t;
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
        event_offset?: number;
      };
      if (meta.event_offset) eventT = t - meta.event_offset;
    } catch {
      /* ignore */
    }
  }
  const { elements } = boxesAtTime(loadBoxes(takeId, root), eventT);
  return elements.find((e) => e.selector === selector) ?? null;
}

export function listElements(
  takeId: string,
  t: number,
  query: string | null | undefined,
  root?: string,
): { ok: true; t_snapshot: number | null; elements: ElementBox[] } {
  // Ensure take exists
  const metaPath = path.join(takeDir(takeId, root), "meta.json");
  if (!fs.existsSync(metaPath)) {
    throw new ToolError("TAKE_NOT_FOUND", `take not found: ${takeId}`);
  }
  let eventT = t;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
      event_offset?: number;
    };
    if (meta.event_offset) eventT = t - meta.event_offset;
  } catch {
    /* ignore */
  }
  const snap = boxesAtTime(loadBoxes(takeId, root), eventT);
  let elements = snap.elements;
  if (query && query.trim()) {
    const q = query.toLowerCase();
    elements = elements.filter(
      (e) =>
        e.selector.toLowerCase().includes(q) ||
        (e.name ?? "").toLowerCase().includes(q) ||
        (e.role ?? "").toLowerCase().includes(q),
    );
  }
  return { ok: true, t_snapshot: snap.t_snapshot, elements };
}
