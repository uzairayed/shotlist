import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { busy } from "./busy.js";
import { composeFrame, cameraForShotTime } from "./compose.js";
import { ToolError } from "./errors.js";
import { encodeFramesToMp4, extractFramePng, requireFfmpeg } from "./ffmpeg.js";
import { okResult, toolErrorResult } from "./mcp-result.js";
import { ensureProject, getShotlistDir, nextOutPath, readProject } from "./project.js";
import { readShotlist } from "./shotlist.js";
import { takeDir, readTakeMeta } from "./takes.js";
import {
  buildTimeline,
  editTimeForShotLocal,
  firstShotCoveringSource,
  shotsAtEditTime,
  sourceTimeForShot,
} from "./timeline.js";
import type { OutputDefaults, Shot, ShotlistJson, TakeMeta } from "./types.js";

function resolveOutput(shotlist: ShotlistJson, dir?: string): OutputDefaults {
  const project = readProject(dir);
  return shotlist.output ?? project.defaults.output;
}

function extractCachedFrame(
  take: TakeMeta,
  tSrc: number,
  root: string,
  cacheDir: string,
): string {
  requireFfmpeg();
  const frameCount = Math.max(1, Math.round(take.duration * take.fps));
  const idx = Math.min(
    frameCount - 1,
    Math.max(0, Math.round(tSrc * take.fps)),
  );
  const out = path.join(cacheDir, `${take.take_id}_${idx}.png`);
  if (!fs.existsSync(out)) {
    const video = path.join(takeDir(take.take_id, root), "source.mp4");
    // Seek to frame center time
    const t = idx / take.fps;
    extractFramePng(video, t, out);
  }
  return out;
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
  let take: TakeMeta;
  let warnings: string[] = [];
  let wideOnly = false;

  if (args.shot_id != null && args.shot_time != null) {
    if (!shotlist) throw new ToolError("NO_SHOTLIST", "shotlist.json is missing");
    const output = resolveOutput(shotlist, dir);
    const timeline = buildTimeline(shotlist, project.defaults.freeze_ms);
    const found = editTimeForShotLocal(timeline.shots, args.shot_id, args.shot_time);
    if (!found) throw new ToolError("SHOT_NOT_FOUND", `shot not found: ${args.shot_id}`);
    shot = found.ts.shot;
    tLocal = args.shot_time;
    tEdit = found.tEdit;
    tSrc = sourceTimeForShot(shot, tLocal).tSrc;
    take = readTakeMeta(shot.take, dir);
    void output;
  } else if (args.t != null) {
    if (!shotlist) throw new ToolError("NO_SHOTLIST", "shotlist.json is missing");
    const timeline = buildTimeline(shotlist, project.defaults.freeze_ms);
    const hits = shotsAtEditTime(timeline.shots, args.t);
    if (hits.length === 0) {
      throw new ToolError("TIME_OUT_OF_RANGE", `t=${args.t} outside edit timeline`);
    }
    // Prefer incoming (last) during crossfade
    const hit = hits[hits.length - 1];
    shot = hit.ts.shot;
    tLocal = hit.tLocal;
    tEdit = args.t;
    tSrc = sourceTimeForShot(shot, tLocal).tSrc;
    take = readTakeMeta(shot.take, dir);
  } else if (args.take_id != null && args.source_t != null) {
    take = readTakeMeta(args.take_id, dir);
    tSrc = args.source_t;
    if (shotlist) {
      const timeline = buildTimeline(shotlist, project.defaults.freeze_ms);
      const cover = firstShotCoveringSource(timeline.shots, args.take_id, args.source_t);
      if (cover) {
        shot = cover.shot;
        tLocal = Math.max(0, args.source_t - shot.src.in);
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

  const sourceFrame = extractCachedFrame(take!, tSrc, dir, cacheDir);

  let camera;
  let png: Buffer;

  if (wideOnly || !shot) {
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
  } else {
    // Optional cursor from cursor module
    let cursorOverlay = null;
    try {
      const cursorMod = await import("./cursor.js");
      cursorOverlay = cursorMod.cursorOverlayForShot({
        shot,
        tLocal,
        tSrc,
        take: take!,
        defaults: project.defaults,
        root: dir,
      });
      if (cursorOverlay?.warning) warnings.push(cursorOverlay.warning);
    } catch {
      /* cursor module optional until Task 7 */
    }

    const composed = await composeFrame({
      sourceFramePath: sourceFrame,
      take: take!,
      shot,
      tLocal,
      tSrc,
      output,
      defaults: project.defaults,
      callouts: shotlist?.callouts,
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
    png = composed.png;
    camera = composed.camera;
    warnings = [...warnings, ...composed.warnings];
  }

  // Crop must be inside source
  if (
    camera.crop.x < -1e-3 ||
    camera.crop.y < -1e-3 ||
    camera.crop.x + camera.crop.w > take!.width + 1e-3 ||
    camera.crop.y + camera.crop.h > take!.height + 1e-3
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
    const warnings: string[] = [];

    const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), "shotlist-frames-"));
    const cacheDir = path.join(dir, "out", ".frames");
    fs.mkdirSync(cacheDir, { recursive: true });

    const nFrames = Math.round(timeline.duration * output.fps);
    // Previous camera per take for from-omitted
    const lastPoseByTake = new Map<string, { cx: number; cy: number; zoom: number }>();

    for (let n = 0; n < nFrames; n++) {
      const tEdit = n / output.fps;
      const hits = shotsAtEditTime(timeline.shots, tEdit);
      if (hits.length === 0) continue;

      let png: Buffer;
      if (hits.length === 1) {
        const hit = hits[0];
        const take = readTakeMeta(hit.ts.shot.take, dir);
        const { tSrc } = sourceTimeForShot(hit.ts.shot, hit.tLocal);
        const sourceFrame = extractCachedFrame(take, tSrc, dir, cacheDir);
        let cursorOverlay = null;
        try {
          const cursorMod = await import("./cursor.js");
          cursorOverlay = cursorMod.cursorOverlayForShot({
            shot: hit.ts.shot,
            tLocal: hit.tLocal,
            tSrc,
            take,
            defaults: project.defaults,
            root: dir,
          });
        } catch {
          /* */
        }
        const composed = await composeFrame({
          sourceFramePath: sourceFrame,
          take,
          shot: hit.ts.shot,
          tLocal: hit.tLocal,
          tSrc,
          output,
          defaults: project.defaults,
          previousCamera: lastPoseByTake.get(hit.ts.shot.take),
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
        png = composed.png;
        warnings.push(...composed.warnings);
        lastPoseByTake.set(hit.ts.shot.take, {
          cx: composed.camera.cx,
          cy: composed.camera.cy,
          zoom: composed.camera.zoom,
        });
      } else {
        // Crossfade: A then B
        const [a, b] = hits;
        const d = b.ts.crossfadeIn;
        const alpha = d > 0 ? Math.min(1, b.tLocal / d) : 1;
        const frameA = await renderHitFrame(
          a,
          shotlist,
          project,
          output,
          dir,
          cacheDir,
          lastPoseByTake,
        );
        const frameB = await renderHitFrame(
          b,
          shotlist,
          project,
          output,
          dir,
          cacheDir,
          lastPoseByTake,
        );
        const sharp = (await import("sharp")).default;
        // Blend in 8-bit
        const { data: da, info } = await sharp(frameA.png)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const { data: db } = await sharp(frameB.png)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const out = Buffer.alloc(da.length);
        for (let i = 0; i < da.length; i++) {
          out[i] = Math.round(da[i] * (1 - alpha) + db[i] * alpha);
        }
        png = await sharp(out, {
          raw: { width: info.width, height: info.height, channels: 4 },
        })
          .png()
          .toBuffer();
        warnings.push(...frameA.warnings, ...frameB.warnings);
        lastPoseByTake.set(b.ts.shot.take, {
          cx: frameB.camera.cx,
          cy: frameB.camera.cy,
          zoom: frameB.camera.zoom,
        });
      }

      const framePath = path.join(
        frameDir,
        `frame-${String(n).padStart(6, "0")}.png`,
      );
      fs.writeFileSync(framePath, png);
    }

    let mp4_path: string;
    if (filename) {
      mp4_path = path.isAbsolute(filename)
        ? filename
        : path.resolve(process.cwd(), filename);
    } else {
      mp4_path = nextOutPath(dir, "render", "mp4");
    }
    const pattern = path.join(frameDir, "frame-%06d.png");
    encodeFramesToMp4(pattern, output.fps, mp4_path);
    fs.rmSync(frameDir, { recursive: true, force: true });

    const bytes = fs.statSync(mp4_path).size;
    return {
      ok: true,
      mp4_path,
      duration: timeline.duration,
      width: output.width,
      height: output.height,
      bytes,
      warnings: [...new Set(warnings)],
    };
  } finally {
    busy.endRender();
  }
}

async function renderHitFrame(
  hit: { ts: { shot: Shot; crossfadeIn: number }; tLocal: number },
  shotlist: ShotlistJson,
  project: ReturnType<typeof readProject>,
  output: OutputDefaults,
  dir: string,
  cacheDir: string,
  lastPoseByTake: Map<string, { cx: number; cy: number; zoom: number }>,
) {
  const take = readTakeMeta(hit.ts.shot.take, dir);
  const { tSrc } = sourceTimeForShot(hit.ts.shot, hit.tLocal);
  const sourceFrame = extractCachedFrame(take, tSrc, dir, cacheDir);
  let cursorOverlay = null;
  try {
    const cursorMod = await import("./cursor.js");
    cursorOverlay = cursorMod.cursorOverlayForShot({
      shot: hit.ts.shot,
      tLocal: hit.tLocal,
      tSrc,
      take,
      defaults: project.defaults,
      root: dir,
    });
  } catch {
    /* */
  }
  const composed = await composeFrame({
    sourceFramePath: sourceFrame,
    take,
    shot: hit.ts.shot,
    tLocal: hit.tLocal,
    tSrc,
    output,
    defaults: project.defaults,
    previousCamera: lastPoseByTake.get(hit.ts.shot.take),
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
  return composed;
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
    if (!ts) throw new ToolError("SHOT_NOT_FOUND", `shot not found: ${args.shot_id}`);
    tIn = ts.start;
    tOut = ts.end;
  } else {
    if (args.t_in != null) tIn = args.t_in;
    if (args.t_out != null) tOut = args.t_out;
  }
  if (tOut - tIn > maxSeconds) tOut = tIn + maxSeconds;
  if (tOut <= tIn) throw new ToolError("BAD_INPUT", "empty clip range");

  // Temporarily render a filtered shotlist by slicing timeline via full render of range
  busy.beginRender();
  try {
    requireFfmpeg();
    const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), "shotlist-clip-"));
    const cacheDir = path.join(dir, "out", ".frames");
    fs.mkdirSync(cacheDir, { recursive: true });
    const nFrames = Math.round((tOut - tIn) * output.fps);
    const lastPoseByTake = new Map<string, { cx: number; cy: number; zoom: number }>();

    for (let n = 0; n < nFrames; n++) {
      const tEdit = tIn + n / output.fps;
      const hits = shotsAtEditTime(timeline.shots, tEdit);
      if (!hits.length) continue;
      const hit = hits[hits.length - 1];
      const take = readTakeMeta(hit.ts.shot.take, dir);
      const { tSrc } = sourceTimeForShot(hit.ts.shot, hit.tLocal);
      const sourceFrame = extractCachedFrame(take, tSrc, dir, cacheDir);
      const composed = await composeFrame({
        sourceFramePath: sourceFrame,
        take,
        shot: hit.ts.shot,
        tLocal: hit.tLocal,
        tSrc,
        output,
        defaults: project.defaults,
        previousCamera: lastPoseByTake.get(hit.ts.shot.take),
        callouts: shotlist.callouts,
        root: dir,
      });
      lastPoseByTake.set(hit.ts.shot.take, {
        cx: composed.camera.cx,
        cy: composed.camera.cy,
        zoom: composed.camera.zoom,
      });
      fs.writeFileSync(
        path.join(frameDir, `frame-${String(n).padStart(6, "0")}.png`),
        composed.png,
      );
    }

    const mp4_path = nextOutPath(dir, "preview", "mp4");
    encodeFramesToMp4(
      path.join(frameDir, "frame-%06d.png"),
      output.fps,
      mp4_path,
    );
    fs.rmSync(frameDir, { recursive: true, force: true });
    return {
      ok: true,
      mp4_path,
      duration: tOut - tIn,
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
