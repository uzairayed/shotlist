import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isKnownEase } from "./camera.js";
import { ToolError } from "./errors.js";
import { okResult, toolErrorResult } from "./mcp-result.js";
import { hasPlan, readPlan } from "./plan.js";
import { ensureProject, getShotlistDir } from "./project.js";
import { listTakeMetas, readTakeMeta } from "./takes.js";
import type {
  Callout,
  Shot,
  ShotlistJson,
  TransitionIn,
} from "./types.js";

const EPS = 1e-3;

export function shotlistPath(dir?: string): string {
  return path.join(dir ?? getShotlistDir(), "shotlist.json");
}

export function readShotlist(dir?: string): ShotlistJson | null {
  const p = shotlistPath(dir);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as ShotlistJson;
}

export function writeShotlist(shotlist: ShotlistJson, dir?: string): void {
  ensureProject(dir);
  fs.writeFileSync(shotlistPath(dir), JSON.stringify(shotlist, null, 2) + "\n");
}

function playingDuration(shot: Shot, defaultFreeze: number): number {
  const freeze = (shot.freeze_ms ?? defaultFreeze) / 1000;
  return shot.src.out - shot.src.in + freeze;
}

function transitionDuration(t: TransitionIn | undefined, isFirst: boolean): number {
  if (isFirst) return 0;
  if (!t || t.type === "cut") return 0;
  return t.duration ?? 0.25;
}

export function assignShotIds(shots: Shot[]): Shot[] {
  let n = 1;
  const used = new Set<string>();
  return shots.map((s) => {
    let id = s.id?.trim() || "";
    if (!id || used.has(id)) {
      while (used.has(`s${n}`)) n += 1;
      id = `s${n}`;
      n += 1;
    }
    used.add(id);
    return { ...s, id };
  });
}

export function assignCalloutIds(callouts: Callout[]): Callout[] {
  let n = 1;
  const used = new Set<string>();
  return callouts.map((c) => {
    let id = c.id?.trim() || "";
    if (!id || used.has(id)) {
      while (used.has(`c${n}`)) n += 1;
      id = `c${n}`;
      n += 1;
    }
    used.add(id);
    return { ...c, id };
  });
}

export interface ValidateOptions {
  strict?: boolean;
  dir?: string;
  defaultFreeze?: number;
}

export function validateShotlist(
  shotlist: ShotlistJson,
  opts: ValidateOptions = {},
): { shots: Shot[]; callouts: Callout[]; warnings: string[] } {
  const warnings: string[] = [];
  const strict = opts.strict ?? false;
  const dir = opts.dir;
  const defaultFreeze = opts.defaultFreeze ?? 500;

  if (shotlist.version !== 1) {
    throw new ToolError("INVALID_SHOTLIST", "shotlist.version must be 1");
  }
  if (!Array.isArray(shotlist.shots) || shotlist.shots.length === 0) {
    throw new ToolError("INVALID_SHOTLIST", "shots must be a non-empty array");
  }

  if (shotlist.output) {
    const { width, height } = shotlist.output;
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0 ||
      width % 2 !== 0 ||
      height % 2 !== 0
    ) {
      throw new ToolError(
        "INVALID_SHOTLIST",
        "output width/height must be even positive integers",
      );
    }
  }

  const takes = new Set(listTakeMetas(dir).map((t) => t.take_id));
  const plan = readPlan(dir);
  const beatIds = new Set(plan?.beats.map((b) => b.id) ?? []);

  if (!hasPlan(dir)) warnings.push("NO_PLAN");

  const ids = new Set<string>();
  const shots = assignShotIds(shotlist.shots);

  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    if (ids.has(shot.id)) {
      throw new ToolError("INVALID_SHOTLIST", `duplicate shot id: ${shot.id}`);
    }
    ids.add(shot.id);

    if (!shot.take) {
      throw new ToolError("INVALID_SHOTLIST", "shot.take is required");
    }
    if (!takes.has(shot.take)) {
      throw new ToolError("INVALID_SHOTLIST", `unknown take: ${shot.take}`, {
        take: shot.take,
      });
    }
    if (shot.src == null || shot.src.in == null || shot.src.out == null) {
      throw new ToolError("INVALID_SHOTLIST", "shot.src.in and src.out required");
    }
    if (!(shot.src.in < shot.src.out - 0 /* allow equal? no */)) {
      if (shot.src.in >= shot.src.out) {
        throw new ToolError("INVALID_SHOTLIST", "src.in must be < src.out");
      }
    }
    const meta = readTakeMeta(shot.take, dir);
    if (shot.src.in < -EPS || shot.src.out > meta.duration + EPS) {
      throw new ToolError(
        "INVALID_SHOTLIST",
        "src times outside take duration",
        { take: shot.take, duration: meta.duration },
      );
    }

    const easeName = shot.camera?.ease ?? "ease-out";
    if (!isKnownEase(easeName)) {
      throw new ToolError("INVALID_SHOTLIST", `unknown ease: ${easeName}`);
    }

    const tin = shot.transition_in ?? { type: "cut" as const };
    if (tin.type !== "cut" && tin.type !== "crossfade") {
      throw new ToolError(
        "INVALID_SHOTLIST",
        `unknown transition type: ${tin.type}`,
      );
    }

    if (shot.beat && plan && !beatIds.has(shot.beat)) {
      warnOrThrow(warnings, strict, `unknown beat: ${shot.beat}`);
    }

    // Crossfade length check against previous
    if (i > 0 && tin.type === "crossfade") {
      const d = tin.duration ?? 0.25;
      const prev = shots[i - 1];
      const prevPlay = playingDuration(prev, defaultFreeze);
      const curPlay = playingDuration(shot, defaultFreeze);
      if (!(d < prevPlay && d < curPlay)) {
        throw new ToolError(
          "INVALID_SHOTLIST",
          "crossfade too long for adjacent shots",
        );
      }
    }
  }

  const callouts = assignCalloutIds(shotlist.callouts ?? []);
  return { shots, callouts, warnings };
}

function warnOrThrow(
  warnings: string[],
  strict: boolean,
  message: string,
): void {
  if (strict) throw new ToolError("INVALID_SHOTLIST", message);
  warnings.push(message);
}

export function setShotlist(
  shotlist: ShotlistJson,
  strict = false,
  dir?: string,
): { ok: true; shot_count: number; warnings: string[] } {
  ensureProject(dir);
  const { shots, callouts, warnings } = validateShotlist(shotlist, {
    strict,
    dir,
  });
  const out: ShotlistJson = {
    version: 1,
    output: shotlist.output,
    shots,
    callouts,
  };
  writeShotlist(out, dir);
  return { ok: true, shot_count: shots.length, warnings };
}

export function getShotlist(dir?: string): { ok: true; shotlist: ShotlistJson } {
  ensureProject(dir);
  const shotlist = readShotlist(dir);
  if (!shotlist) throw new ToolError("NO_SHOTLIST", "shotlist.json is missing");
  return { ok: true, shotlist };
}

export function addShot(
  shot: Shot,
  index: number | null | undefined,
  dir?: string,
): { ok: true; id: string; index: number; warnings: string[] } {
  ensureProject(dir);
  let shotlist = readShotlist(dir);
  if (!shotlist) {
    shotlist = { version: 1, shots: [], callouts: [] };
  }
  const shots = [...shotlist.shots];
  const idx =
    index == null || index < 0 || index > shots.length ? shots.length : index;
  shots.splice(idx, 0, shot);
  const result = setShotlist({ ...shotlist, shots }, false, dir);
  const written = readShotlist(dir)!;
  const id = written.shots[idx].id;
  return { ok: true, id, index: idx, warnings: result.warnings };
}

export function updateShot(
  id: string,
  patch: Record<string, unknown>,
  dir?: string,
): { ok: true; shot: Shot; warnings: string[] } {
  ensureProject(dir);
  const shotlist = readShotlist(dir);
  if (!shotlist) throw new ToolError("NO_SHOTLIST", "shotlist.json is missing");
  const idx = shotlist.shots.findIndex((s) => s.id === id);
  if (idx < 0) throw new ToolError("SHOT_NOT_FOUND", `shot not found: ${id}`);

  const current = shotlist.shots[idx];
  const merged: Record<string, unknown> = {
    ...(current as unknown as Record<string, unknown>),
  };
  for (const [k, v] of Object.entries(patch)) {
    if (
      (k === "camera" || k === "cursor" || k === "src" || k === "transition_in") &&
      v &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      const prev = merged[k];
      merged[k] = {
        ...((typeof prev === "object" && prev ? prev : {}) as object),
        ...(v as object),
      };
    } else {
      merged[k] = v;
    }
  }
  const shots = [...shotlist.shots];
  shots[idx] = merged as unknown as Shot;
  const result = setShotlist({ ...shotlist, shots }, false, dir);
  const written = readShotlist(dir)!;
  return {
    ok: true,
    shot: written.shots.find((s) => s.id === id)!,
    warnings: result.warnings,
  };
}

export function addCallout(
  callout: Omit<Callout, "id"> & { id?: string },
  dir?: string,
): { ok: true; id: string } {
  ensureProject(dir);
  let shotlist = readShotlist(dir);
  if (!shotlist) throw new ToolError("NO_SHOTLIST", "shotlist.json is missing");
  const callouts = assignCalloutIds([
    ...(shotlist.callouts ?? []),
    callout as Callout,
  ]);
  writeShotlist({ ...shotlist, callouts }, dir);
  return { ok: true, id: callouts[callouts.length - 1].id };
}

export function registerShotlistTools(server: McpServer): void {
  server.tool(
    "get_shotlist",
    "Return the current shotlist.json, or NO_SHOTLIST if missing.",
    {},
    async () => {
      try {
        return okResult(getShotlist(getShotlistDir()));
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.tool(
    "set_shotlist",
    "Validate and replace shotlist.json; returns shot_count and warnings.",
    {
      shotlist: z.record(z.unknown()),
      strict: z.boolean().optional(),
    },
    async ({ shotlist, strict }) => {
      try {
        return okResult(
          setShotlist(
            shotlist as unknown as ShotlistJson,
            strict ?? false,
            getShotlistDir(),
          ),
        );
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.tool(
    "add_shot",
    "Insert a shot into the shotlist (auto-creates empty list if needed).",
    {
      shot: z.record(z.unknown()),
      index: z.number().nullable().optional(),
    },
    async ({ shot, index }) => {
      try {
        return okResult(
          addShot(shot as unknown as Shot, index ?? null, getShotlistDir()),
        );
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.tool(
    "update_shot",
    "Shallow-merge a patch into a shot and re-validate.",
    {
      id: z.string(),
      patch: z.record(z.unknown()),
    },
    async ({ id, patch }) => {
      try {
        return okResult(updateShot(id, patch, getShotlistDir()));
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.tool(
    "add_callout",
    "Append a callout to shotlist.callouts and return its id.",
    { callout: z.record(z.unknown()) },
    async ({ callout }) => {
      try {
        return okResult(
          addCallout(
            callout as unknown as Callout,
            getShotlistDir(),
          ),
        );
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );
}

export { playingDuration, transitionDuration };
