import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { busy } from "./busy.js";
import { composeFrame, cameraForShotTime } from "./compose.js";
import { ToolError } from "./errors.js";
import {
  encodeFramesToMp4,
  extractFramePngAsync,
  extractFrameRangeAsync,
  requireFfmpeg,
} from "./ffmpeg.js";
import { okResult, toolErrorResult } from "./mcp-result.js";
import {
  ensureProject,
  getShotlistDir,
  nextOutPath,
  readProject,
} from "./project.js";
import { readShotlist } from "./shotlist.js";
import { takeDir, readTakeMeta } from "./takes.js";
import {
  buildTimeline,
  editTimeForShotLocal,
  firstShotCoveringSource,
  shotsAtEditTime,
  sourceTimeForShot,
  type TimelineShot,
} from "./timeline.js";
import type {
  OutputDefaults,
  ProjectDefaults,
  ProjectJson,
  Shot,
  ShotlistJson,
  TakeMeta,
} from "./types.js";
import { isCardShot } from "./types.js";

function resolveOutput(shotlist: ShotlistJson, dir?: string): OutputDefaults {
  const project = readProject(dir);
  return shotlist.output ?? project.defaults.output;
}

async function extractCachedFrame(
  take: TakeMeta,
  tSrc: number,
  root: string,
  cacheDir: string,
): Promise<string> {
  requireFfmpeg();
  const frameCount = Math.max(1, Math.round(take.duration * take.fps));
  const idx = Math.min(
    frameCount - 1,
    Math.max(0, Math.round(tSrc * take.fps)),
  );
  const out = path.join(cacheDir, `${take.take_id}_${idx}.png`);
  if (!fs.existsSync(out)) {
    const video = path.join(takeDir(take.take_id, root), "source.mp4");
    const t = idx / take.fps;
    await extractFramePngAsync(video, t, out);
  }
  return out;
}

type PoseMap = Map<string, { cx: number; cy: number; zoom: number }>;

async function cursorOverlayFor(
  shot: Shot,
  tLocal: number,
  tSrc: number,
  take: TakeMeta,
  defaults: ProjectDefaults,
  root: string,
) {
  if (isCardShot(shot)) return null;
  try {
    const cursorMod = await import("./cursor.js");
    return cursorMod.cursorOverlayForShot({
      shot,
      tLocal,
      tSrc,
      take,
      defaults,
      root,
    });
  } catch {
    return null;
  }
}

/** Shared compose for preview_frame / preview_clip / render (cursor, camera, crossfade). */
export async function composeTimelineHit(opts: {
  hit: { ts: TimelineShot; tLocal: number };
  shotlist: ShotlistJson;
  project: ProjectJson;
  output: OutputDefaults;
  dir: string;
  cacheDir: string;
  lastPoseByTake: PoseMap;
}): Promise<{
  png: Buffer;
  camera: {
    cx: number;
    cy: number;
    zoom: number;
    crop: { x: number; y: number; w: number; h: number };
  };
  warnings: string[];
  takeId: string | null;
}> {
  const { hit, shotlist, project, output, dir, cacheDir, lastPoseByTake } =
    opts;
  const shot = hit.ts.shot;

  if (isCardShot(shot)) {
    const composed = await composeFrame({
      shot,
      tLocal: hit.tLocal,
      tSrc: 0,
      output,
      defaults: project.defaults,
      root: dir,
    });
    return {
      png: composed.png,
      camera: composed.camera,
      warnings: composed.warnings,
      takeId: null,
    };
  }

  const take = readTakeMeta(shot.take!, dir);
  const { tSrc } = sourceTimeForShot(shot, hit.tLocal);
  const sourceFrame = await extractCachedFrame(take, tSrc, dir, cacheDir);
  const cursorOverlay = await cursorOverlayFor(
    shot,
    hit.tLocal,
    tSrc,
    take,
    project.defaults,
    dir,
  );
  const composed = await composeFrame({
    sourceFramePath: sourceFrame,
    take,
    shot,
    tLocal: hit.tLocal,
    tSrc,
    output,
    defaults: project.defaults,
    previousCamera: lastPoseByTake.get(shot.take!),
    callouts: shotlist.callouts,
    cursorOverlay: cursorOverlay
      ? {
          srcX: cursorOverlay.x,
          srcY: cursorOverlay.y,
          scale: cursorOverlay.scale,
          visible: cursorOverlay.visible,
        }
      : null,
    root: dir,
  });
  return {
    png: composed.png,
    camera: composed.camera,
    warnings: [
      ...composed.warnings,
      ...(cursorOverlay?.warning ? [cursorOverlay.warning] : []),
    ],
    takeId: shot.take!,
  };
}

async function blendFrames(
  a: Buffer,
  b: Buffer,
  alpha: number,
): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const { data: da, info } = await sharp(a)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data: db } = await sharp(b)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(da.length);
  for (let i = 0; i < da.length; i++) {
    out[i] = Math.round(da[i]! * (1 - alpha) + db[i]! * alpha);
  }
  return sharp(out, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();
}

async function composeEditFrame(opts: {
  tEdit: number;
  timeline: TimelineShot[];
  shotlist: ShotlistJson;
  project: ProjectJson;
  output: OutputDefaults;
  dir: string;
  cacheDir: string;
  lastPoseByTake: PoseMap;
}): Promise<{
  png: Buffer;
  camera: {
    cx: number;
    cy: number;
    zoom: number;
    crop: { x: number; y: number; w: number; h: number };
  };
  warnings: string[];
  shot: Shot | null;
  tLocal: number;
  tSrc: number;
} | null> {
  const hits = shotsAtEditTime(opts.timeline, opts.tEdit);
  if (hits.length === 0) return null;

  if (hits.length === 1) {
    const hit = hits[0]!;
    const framed = await composeTimelineHit({
      hit,
      shotlist: opts.shotlist,
      project: opts.project,
      output: opts.output,
      dir: opts.dir,
      cacheDir: opts.cacheDir,
      lastPoseByTake: opts.lastPoseByTake,
    });
    if (framed.takeId) {
      opts.lastPoseByTake.set(framed.takeId, {
        cx: framed.camera.cx,
        cy: framed.camera.cy,
        zoom: framed.camera.zoom,
      });
    }
    const { tSrc } = sourceTimeForShot(hit.ts.shot, hit.tLocal);
    return {
      png: framed.png,
      camera: framed.camera,
      warnings: framed.warnings,
      shot: hit.ts.shot,
      tLocal: hit.tLocal,
      tSrc,
    };
  }

  const [a, b] = hits;
  const d = b!.ts.crossfadeIn;
  const alpha = d > 0 ? Math.min(1, b!.tLocal / d) : 1;
  const frameA = await composeTimelineHit({
    hit: a!,
    shotlist: opts.shotlist,
    project: opts.project,
    output: opts.output,
    dir: opts.dir,
    cacheDir: opts.cacheDir,
    lastPoseByTake: opts.lastPoseByTake,
  });
  const frameB = await composeTimelineHit({
    hit: b!,
    shotlist: opts.shotlist,
    project: opts.project,
    output: opts.output,
    dir: opts.dir,
    cacheDir: opts.cacheDir,
    lastPoseByTake: opts.lastPoseByTake,
  });
  const png = await blendFrames(frameA.png, frameB.png, alpha);
  if (frameB.takeId) {
    opts.lastPoseByTake.set(frameB.takeId, {
      cx: frameB.camera.cx,
      cy: frameB.camera.cy,
      zoom: frameB.camera.zoom,
    });
  }
  const { tSrc } = sourceTimeForShot(b!.ts.shot, b!.tLocal);
  return {
    png,
    camera: frameB.camera,
    warnings: [...frameA.warnings, ...frameB.warnings],
    shot: b!.ts.shot,
    tLocal: b!.tLocal,
    tSrc,
  };
}

async function prefetchTakeRanges(
  timeline: TimelineShot[],
  tIn: number,
  tOut: number,
  dir: string,
  cacheDir: string,
): Promise<void> {
  const ranges = new Map<string, { take: TakeMeta; t0: number; t1: number }>();
  for (const ts of timeline) {
    if (isCardShot(ts.shot) || !ts.shot.take || !ts.shot.src) continue;
    if (ts.end < tIn - 1e-6 || ts.start > tOut + 1e-6) continue;
    const take = readTakeMeta(ts.shot.take, dir);
    const overlapStart = Math.max(ts.start, tIn);
    const overlapEnd = Math.min(ts.end, tOut);
    const local0 = Math.max(0, overlapStart - ts.start);
    const local1 = Math.max(local0, overlapEnd - ts.start);
    const src0 = sourceTimeForShot(ts.shot, local0).tSrc;
    const src1 = sourceTimeForShot(ts.shot, local1).tSrc;
    const prev = ranges.get(take.take_id);
    if (!prev) {
      ranges.set(take.take_id, {
        take,
        t0: Math.min(src0, src1),
        t1: Math.max(src0, src1),
      });
    } else {
      prev.t0 = Math.min(prev.t0, src0, src1);
      prev.t1 = Math.max(prev.t1, src0, src1);
    }
  }
  await Promise.all(
    [...ranges.values()].map(async ({ take, t0, t1 }) => {
      const video = path.join(takeDir(take.take_id, dir), "source.mp4");
      await extractFrameRangeAsync(
        video,
        take.take_id,
        take.fps,
        t0,
        t1,
        cacheDir,
      );
    }),
  );
}

export interface PreviewFrameArgs {
  shot_id?: string | null;
  shot_time?: number | null;
  t?: number | null;
  source_t?: number | null;
  take_id?: string | null;
}

export interface PreviewFrameResult {
  ok: true;
  png_path: string;
  width: number;
  height: number;
  shot_id: string | null;
  t_edit: number;
  t_src: number;
  camera: {
    cx: number;
    cy: number;
    zoom: number;
    crop: { x: number; y: number; w: number; h: number };
  };
  warnings: string[];
  /** raw png bytes for MCP image block */
  png_bytes: Buffer;
}

export async function previewFrame(
  args: PreviewFrameArgs,
  root?: string,
): Promise<PreviewFrameResult> {
  const dir = root ?? getShotlistDir();
  ensureProject(dir);
  const project = readProject(dir);
  const shotlist = readShotlist(dir);
  const cacheDir = path.join(dir, "out", ".frames");
  fs.mkdirSync(cacheDir, { recursive: true });

  let shot: Shot | null = null;
  let tLocal = 0;
  let tEdit = 0;
  let tSrc = 0;
  let take: TakeMeta | null = null;
  let warnings: string[] = [];
  let wideOnly = false;

  if (args.shot_id != null && args.shot_time != null) {
    if (!shotlist) throw new ToolError("NO_SHOTLIST", "shotlist.json is missing");
    const timeline = buildTimeline(shotlist, project.defaults.freeze_ms);
    const found = editTimeForShotLocal(
      timeline.shots,
      args.shot_id,
      args.shot_time,
    );
    if (!found) {
      throw new ToolError("SHOT_NOT_FOUND", `shot not found: ${args.shot_id}`);
    }
    shot = found.ts.shot;
    tLocal = args.shot_time;
    tEdit = found.tEdit;
    tSrc = sourceTimeForShot(shot, tLocal).tSrc;
    if (!isCardShot(shot)) take = readTakeMeta(shot.take!, dir);
  } else if (args.t != null) {
    if (!shotlist) throw new ToolError("NO_SHOTLIST", "shotlist.json is missing");
    const timeline = buildTimeline(shotlist, project.defaults.freeze_ms);
    const hits = shotsAtEditTime(timeline.shots, args.t);
    if (hits.length === 0) {
      throw new ToolError("TIME_OUT_OF_RANGE", `t=${args.t} outside edit timeline`);
    }
    const hit = hits[hits.length - 1]!;
    shot = hit.ts.shot;
    tLocal = hit.tLocal;
    tEdit = args.t;
    tSrc = sourceTimeForShot(shot, tLocal).tSrc;
    if (!isCardShot(shot)) take = readTakeMeta(shot.take!, dir);
  } else if (args.take_id != null && args.source_t != null) {
    take = readTakeMeta(args.take_id, dir);
    tSrc = args.source_t;
    if (shotlist) {
      const timeline = buildTimeline(shotlist, project.defaults.freeze_ms);
      const cover = firstShotCoveringSource(
        timeline.shots,
        args.take_id,
        args.source_t,
      );
      if (cover) {
        shot = cover.shot;
        tLocal = Math.max(0, args.source_t - (shot.src?.in ?? 0));
        tEdit = cover.start + tLocal;
      } else {
        wideOnly = true;
        tEdit = 0;
        tLocal = 0;
      }
    } else {
      wideOnly = true;
      tEdit = 0;
      tLocal = 0;
    }
  } else {
    throw new ToolError(
      "BAD_INPUT",
      "provide shot_id+shot_time, t, or take_id+source_t",
    );
  }

  const output = shotlist
    ? resolveOutput(shotlist, dir)
    : project.defaults.output;

  let camera;
  let png: Buffer;

  if (shot && isCardShot(shot) && !wideOnly) {
    const composed = await composeFrame({
      shot,
      tLocal,
      tSrc: 0,
      output,
      defaults: project.defaults,
      root: dir,
    });
    png = composed.png;
    camera = composed.camera;
    warnings = composed.warnings;
  } else if (wideOnly || !shot) {
    const sourceFrame = await extractCachedFrame(take!, tSrc, dir, cacheDir);
    const synthetic: Shot = {
      id: "wide",
      take: take!.take_id,
      src: { in: tSrc, out: Math.min(take!.duration, tSrc + 0.001) },
      camera: {
        from: { x: 0.5, y: 0.5, zoom: 1 },
        to: { x: 0.5, y: 0.5, zoom: 1 },
        duration: 0,
        ease: "linear",
      },
      freeze_ms: 0,
    };
    const composed = await composeFrame({
      sourceFramePath: sourceFrame,
      take: take!,
      shot: synthetic,
      tLocal: 0,
      tSrc,
      output,
      defaults: project.defaults,
      root: dir,
    });
    png = composed.png;
    camera = composed.camera;
    warnings = composed.warnings;
    shot = shot ?? synthetic;
  } else if (shotlist) {
    const timeline = buildTimeline(shotlist, project.defaults.freeze_ms);
    const lastPoseByTake: PoseMap = new Map();
    // Warm previousCamera by walking earlier shots briefly (poses only).
    for (const ts of timeline.shots) {
      if (ts.end <= tEdit + 1e-9 && !isCardShot(ts.shot) && ts.shot.take) {
        const tk = readTakeMeta(ts.shot.take, dir);
        const local = Math.max(0, Math.min(ts.playing - 1e-6, tEdit - ts.start));
        const cam = cameraForShotTime(
          ts.shot,
          local,
          tk,
          output,
          project.defaults,
          lastPoseByTake.get(ts.shot.take),
          dir,
        );
        lastPoseByTake.set(ts.shot.take, {
          cx: cam.camera.cx,
          cy: cam.camera.cy,
          zoom: cam.camera.zoom,
        });
      }
    }
    const framed = await composeEditFrame({
      tEdit,
      timeline: timeline.shots,
      shotlist,
      project,
      output,
      dir,
      cacheDir,
      lastPoseByTake,
    });
    if (!framed) {
      throw new ToolError("TIME_OUT_OF_RANGE", `t=${tEdit} outside edit timeline`);
    }
    png = framed.png;
    camera = framed.camera;
    warnings = framed.warnings;
    shot = framed.shot ?? shot;
    tSrc = framed.tSrc;
    tLocal = framed.tLocal;
  } else {
    throw new ToolError("NO_SHOTLIST", "shotlist.json is missing");
  }

  if (
    take &&
    !isCardShot(shot!) &&
    (camera.crop.x < -1e-3 ||
      camera.crop.y < -1e-3 ||
      camera.crop.x + camera.crop.w > take.width + 1e-3 ||
      camera.crop.y + camera.crop.h > take.height + 1e-3)
  ) {
    throw new ToolError("RENDER_FAILED", "crop sampled outside source");
  }

  const png_path = nextOutPath(dir, "preview", "png");
  fs.writeFileSync(png_path, png);

  return {
    ok: true,
    png_path,
    width: output.width,
    height: output.height,
    shot_id: shot?.id ?? null,
    t_edit: Number(tEdit.toFixed(3)),
    t_src: Number(tSrc.toFixed(3)),
    camera: {
      cx: camera.cx,
      cy: camera.cy,
      zoom: camera.zoom,
      crop: camera.crop,
    },
    warnings,
    png_bytes: png,
  };
}

export interface RenderResult {
  ok: true;
  mp4_path: string;
  duration: number;
  width: number;
  height: number;
  bytes: number;
  warnings: string[];
}

async function renderEditRange(opts: {
  tIn: number;
  tOut: number;
  shotlist: ShotlistJson;
  project: ProjectJson;
  output: OutputDefaults;
  dir: string;
  outMp4: string;
}): Promise<{ duration: number; warnings: string[] }> {
  const { tIn, tOut, shotlist, project, output, dir, outMp4 } = opts;
  const timeline = buildTimeline(shotlist, project.defaults.freeze_ms);
  const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), "shotlist-frames-"));
  const cacheDir = path.join(dir, "out", ".frames");
  fs.mkdirSync(cacheDir, { recursive: true });
  const warnings: string[] = [];
  try {
    await prefetchTakeRanges(timeline.shots, tIn, tOut, dir, cacheDir);
    const nFrames = Math.round((tOut - tIn) * output.fps);
    const lastPoseByTake: PoseMap = new Map();

    for (let n = 0; n < nFrames; n++) {
      const tEdit = tIn + n / output.fps;
      const framed = await composeEditFrame({
        tEdit,
        timeline: timeline.shots,
        shotlist,
        project,
        output,
        dir,
        cacheDir,
        lastPoseByTake,
      });
      if (!framed) continue;
      warnings.push(...framed.warnings);
      fs.writeFileSync(
        path.join(frameDir, `frame-${String(n).padStart(6, "0")}.png`),
        framed.png,
      );
    }

    encodeFramesToMp4(
      path.join(frameDir, "frame-%06d.png"),
      output.fps,
      outMp4,
    );
    return { duration: tOut - tIn, warnings: [...new Set(warnings)] };
  } finally {
    fs.rmSync(frameDir, { recursive: true, force: true });
  }
}

export async function renderShotlist(
  filename: string | null | undefined,
  root?: string,
): Promise<RenderResult> {
  const dir = root ?? getShotlistDir();
  ensureProject(dir);
  busy.beginRender();
  try {
    requireFfmpeg();
    const project = readProject(dir);
    const shotlist = readShotlist(dir);
    if (!shotlist) throw new ToolError("NO_SHOTLIST", "shotlist.json is missing");
    const output = resolveOutput(shotlist, dir);
    const timeline = buildTimeline(shotlist, project.defaults.freeze_ms);

    let mp4_path: string;
    if (filename) {
      mp4_path = path.isAbsolute(filename)
        ? filename
        : path.resolve(process.cwd(), filename);
    } else {
      mp4_path = nextOutPath(dir, "render", "mp4");
    }

    const { warnings } = await renderEditRange({
      tIn: 0,
      tOut: timeline.duration,
      shotlist,
      project,
      output,
      dir,
      outMp4: mp4_path,
    });

    const bytes = fs.statSync(mp4_path).size;
    return {
      ok: true,
      mp4_path,
      duration: timeline.duration,
      width: output.width,
      height: output.height,
      bytes,
      warnings,
    };
  } finally {
    busy.endRender();
  }
}

export async function previewClip(
  args: {
    shot_id?: string | null;
    t_in?: number | null;
    t_out?: number | null;
    max_seconds?: number | null;
  },
  root?: string,
): Promise<{
  ok: true;
  mp4_path: string;
  duration: number;
  width: number;
  height: number;
}> {
  const dir = root ?? getShotlistDir();
  ensureProject(dir);
  const project = readProject(dir);
  const shotlist = readShotlist(dir);
  if (!shotlist) throw new ToolError("NO_SHOTLIST", "shotlist.json is missing");
  const output = resolveOutput(shotlist, dir);
  const timeline = buildTimeline(shotlist, project.defaults.freeze_ms);
  const maxSeconds = args.max_seconds ?? 5;

  let tIn = 0;
  let tOut = timeline.duration;
  if (args.shot_id) {
    const ts = timeline.shots.find((s) => s.shot.id === args.shot_id);
    if (!ts) {
      throw new ToolError("SHOT_NOT_FOUND", `shot not found: ${args.shot_id}`);
    }
    tIn = ts.start;
    tOut = ts.end;
  } else {
    if (args.t_in != null) tIn = args.t_in;
    if (args.t_out != null) tOut = args.t_out;
  }
  if (tOut - tIn > maxSeconds) tOut = tIn + maxSeconds;
  if (tOut <= tIn) throw new ToolError("BAD_INPUT", "empty clip range");

  busy.beginRender();
  try {
    requireFfmpeg();
    const mp4_path = nextOutPath(dir, "preview", "mp4");
    const { duration } = await renderEditRange({
      tIn,
      tOut,
      shotlist,
      project,
      output,
      dir,
      outMp4: mp4_path,
    });
    return {
      ok: true,
      mp4_path,
      duration,
      width: output.width,
      height: output.height,
    };
  } finally {
    busy.endRender();
  }
}

export function registerRenderTools(server: McpServer): void {
  server.tool(
    "preview_frame",
    "Render one output-resolution PNG of a shot/edit/source time and return JSON plus an image content block.",
    {
      shot_id: z.string().nullable().optional(),
      shot_time: z.number().nullable().optional(),
      t: z.number().nullable().optional(),
      source_t: z.number().nullable().optional(),
      take_id: z.string().nullable().optional(),
    },
    async (args) => {
      try {
        const result = await previewFrame(args, getShotlistDir());
        const { png_bytes, ...json } = result;
        return {
          content: [
            { type: "text", text: JSON.stringify(json) },
            {
              type: "image",
              data: png_bytes.toString("base64"),
              mimeType: "image/png",
            },
          ],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.tool(
    "preview_clip",
    "Render a short mp4 preview of one shot or an edit range (default max 5s).",
    {
      shot_id: z.string().nullable().optional(),
      t_in: z.number().nullable().optional(),
      t_out: z.number().nullable().optional(),
      max_seconds: z.number().nullable().optional(),
    },
    async (args) => {
      try {
        return okResult(await previewClip(args, getShotlistDir()));
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.tool(
    "render",
    "Render the full shotlist to out/render-{id}.mp4 (or filename) and return path, duration, bytes.",
    { filename: z.string().nullable().optional() },
    async ({ filename }) => {
      try {
        return okResult(await renderShotlist(filename ?? null, getShotlistDir()));
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );
}

// re-export for tests
export { cameraForShotTime };
