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
  PlanJson,
  Shot,
  ShotlistJson,
  TransitionIn,
} from "./types.js";
import {
  DEFAULT_CARD_FADE,
  TARGET_SECONDS_TOLERANCE,
  isCardShot,
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
  if (isCardShot(shot)) {
    const d = shot.duration ?? 0;
    return d > 0 ? d : 0;
  }
  const freeze = (shot.freeze_ms ?? defaultFreeze) / 1000;
  const src = shot.src!;
  return src.out - src.in + freeze;
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

function pageUrlForShot(shot: Shot, plan: PlanJson | null): string | null {
  if (shot.page && String(shot.page).trim()) return String(shot.page).trim();
  if (shot.beat && plan) {
    const beat = plan.beats.find((b) => b.id === shot.beat);
    if (beat?.url && String(beat.url).trim()) return String(beat.url).trim();
  }
  return null;
}

function normalizePageUrl(url: string): string {
  return url.replace(/\/+$/, "").toLowerCase();
}

function validateCardShot(
  shot: Shot,
  plan: PlanJson | null,
  pageUrls: Set<string>,
  warnings: string[],
  strict: boolean,
): void {
  if (!shot.text || String(shot.text).trim() === "") {
    throw new ToolError("INVALID_SHOTLIST", "card shots require text");
  }
  if (
    shot.duration == null ||
    !Number.isFinite(shot.duration) ||
    shot.duration <= 0
  ) {
    throw new ToolError(
      "INVALID_SHOTLIST",
      "card shots require positive duration",
    );
  }
  const fade = shot.fade ?? DEFAULT_CARD_FADE;
  if (!Number.isFinite(fade) || fade < 0) {
    throw new ToolError("INVALID_SHOTLIST", "card fade must be >= 0");
  }
  if (fade * 2 > shot.duration + EPS) {
    throw new ToolError(
      "INVALID_SHOTLIST",
      "card fade*2 must be <= duration",
    );
  }
  if (shot.take || shot.src) {
    warnOrThrow(
      warnings,
      strict,
      `card shot ${shot.id} should not set take/src`,
    );
  }

  const page = pageUrlForShot(shot, plan);
  if (plan && Array.isArray(plan.pages) && plan.pages.length > 0) {
    if (!page) {
      throw new ToolError(
        "INVALID_SHOTLIST",
        `card shot ${shot.id} must map to a plan page (set page or beat.url)`,
      );
    }
    if (!pageUrls.has(normalizePageUrl(page))) {
      throw new ToolError(
        "INVALID_SHOTLIST",
        `card shot ${shot.id} page is not in plan.pages: ${page}`,
      );
    }
  }
}

function validateNoMidPageCards(shots: Shot[], plan: PlanJson | null): void {
  for (let i = 0; i < shots.length; i++) {
    if (!isCardShot(shots[i])) continue;
    let prevTake: Shot | null = null;
    let nextTake: Shot | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (!isCardShot(shots[j])) {
        prevTake = shots[j];
        break;
      }
    }
    for (let j = i + 1; j < shots.length; j++) {
      if (!isCardShot(shots[j])) {
        nextTake = shots[j];
        break;
      }
    }
    if (!prevTake || !nextTake) continue;
    const prevPage = pageUrlForShot(prevTake, plan);
    const nextPage = pageUrlForShot(nextTake, plan);
    if (
      prevPage &&
      nextPage &&
      normalizePageUrl(prevPage) === normalizePageUrl(nextPage)
    ) {
      throw new ToolError(
        "INVALID_SHOTLIST",
        `card shot ${shots[i].id} cannot sit mid-page between shots of ${prevPage}`,
      );
    }
  }
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
  const pageUrls = new Set(
    (plan?.pages ?? []).map((p) => normalizePageUrl(String(p.url))),
  );

  if (!hasPlan(dir)) warnings.push("NO_PLAN");

  const ids = new Set<string>();
  const shots = assignShotIds(shotlist.shots);

  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    if (ids.has(shot.id)) {
      throw new ToolError("INVALID_SHOTLIST", `duplicate shot id: ${shot.id}`);
    }
    ids.add(shot.id);

    if (shot.type != null && shot.type !== "take" && shot.type !== "card") {
      throw new ToolError(
        "INVALID_SHOTLIST",
        `unknown shot type: ${String(shot.type)}`,
      );
    }

    if (strict && (!shot.beat || String(shot.beat).trim() === "")) {
      throw new ToolError(
        "INVALID_SHOTLIST",
        `shot ${shot.id} requires beat in strict mode`,
      );
    }

    if (shot.beat && plan && !beatIds.has(shot.beat)) {
      warnOrThrow(warnings, strict, `unknown beat: ${shot.beat}`);
    }

    if (isCardShot(shot)) {
      validateCardShot(shot, plan, pageUrls, warnings, strict);
      const tin = shot.transition_in ?? { type: "cut" as const };
      if (tin.type !== "cut" && tin.type !== "crossfade") {
        throw new ToolError(
          "INVALID_SHOTLIST",
          `unknown transition type: ${tin.type}`,
        );
      }
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
      continue;
    }

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
    if (shot.src.in >= shot.src.out) {
      throw new ToolError("INVALID_SHOTLIST", "src.in must be < src.out");
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

  validateNoMidPageCards(shots, plan);

  if (plan?.target_seconds != null) {
    let sumPlaying = 0;
    let totalCrossfade = 0;
    for (let i = 0; i < shots.length; i++) {
      sumPlaying += playingDuration(shots[i], defaultFreeze);
      totalCrossfade += transitionDuration(shots[i].transition_in, i === 0);
    }
    const editDuration = sumPlaying - totalCrossfade;
    const target = plan.target_seconds;
    const delta = Math.abs(editDuration - target);
    const allowed = Math.max(2, target * TARGET_SECONDS_TOLERANCE);
    if (delta > allowed) {
      warnOrThrow(
        warnings,
        strict,
        `edit length ${editDuration.toFixed(1)}s vs target_seconds ${target}`,
      );
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
