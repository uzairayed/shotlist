import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  type EaseName,
  clampCameraDuration,
  interpolateCamera,
  resolvePose,
  cropFromCenterZoom,
  isKnownEase,
} from "./camera.js";
import { findElementAtTime } from "./boxes.js";
import type {
  Callout,
  CameraPoseInput,
  OutputDefaults,
  ProjectDefaults,
  Rect,
  ResolvedCamera,
  Shot,
  TakeMeta,
} from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ASSETS_DIR = path.resolve(__dirname, "../assets");

export interface ComposeInput {
  sourceFramePath: string;
  take: TakeMeta;
  shot: Shot;
  tLocal: number;
  tSrc: number;
  output: OutputDefaults;
  defaults: ProjectDefaults;
  previousCamera?: { cx: number; cy: number; zoom: number } | null;
  previousCursor?: { x: number; y: number } | null;
  callouts?: Callout[];
  cursorOverlay?: {
    srcX: number;
    srcY: number;
    scale: number;
    visible: boolean;
  } | null;
  root?: string;
}

export interface ComposeResult {
  png: Buffer;
  camera: ResolvedCamera;
  warnings: string[];
  cursorOut?: { x: number; y: number } | null;
}

function resolveShotPose(
  input: CameraPoseInput | string | undefined,
  shot: Shot,
  tSrc: number,
  take: TakeMeta,
  output: OutputDefaults,
  defaults: ProjectDefaults,
  previous: { cx: number; cy: number; zoom: number } | null | undefined,
  root?: string,
): { pose: { cx: number; cy: number; zoom: number }; warnings: string[] } {
  if (input == null) {
    if (previous) return { pose: previous, warnings: [] };
    return {
      pose: { cx: take.width / 2, cy: take.height / 2, zoom: 1 },
      warnings: [],
    };
  }
  if (typeof input === "string") {
    // treat as wide fallback
    return {
      pose: { cx: take.width / 2, cy: take.height / 2, zoom: 1 },
      warnings: [],
    };
  }
  return resolvePose(input, {
    sourceW: take.width,
    sourceH: take.height,
    output,
    zoomMin: defaults.camera.zoom_min,
    zoomMax: defaults.camera.zoom_max,
    defaultPadding: defaults.camera.padding,
    findElement: (sel) => findElementAtTime(shot.take, sel, tSrc, root),
  });
}

export function cameraForShotTime(
  shot: Shot,
  tLocal: number,
  take: TakeMeta,
  output: OutputDefaults,
  defaults: ProjectDefaults,
  previousCamera?: { cx: number; cy: number; zoom: number } | null,
  root?: string,
): { camera: ResolvedCamera; warnings: string[]; toPose: { cx: number; cy: number; zoom: number } } {
  const warnings: string[] = [];
  const play = shot.src.out - shot.src.in;
  const cam = shot.camera;
  const easeName = (cam?.ease ?? defaults.camera.ease) as string;
  if (!isKnownEase(easeName)) {
    // Should have been validated already
  }
  const { duration: camDur, warnings: dw } = clampCameraDuration(
    cam?.duration,
    play,
    defaults.camera.duration,
  );
  warnings.push(...dw);

  const fromSrc = shot.src.in;
  const toSrc = Math.min(shot.src.out, shot.src.in + camDur);

  let fromInput = cam?.from;
  if (fromInput == null && previousCamera) {
    // use previous as absolute pose
    fromInput = {
      cx: previousCamera.cx,
      cy: previousCamera.cy,
      zoom: previousCamera.zoom,
    };
  }

  const fromR = resolveShotPose(
    fromInput,
    shot,
    fromSrc,
    take,
    output,
    defaults,
    previousCamera,
    root,
  );
  warnings.push(...fromR.warnings);

  const toR = resolveShotPose(
    cam?.to ?? fromInput,
    shot,
    toSrc,
    take,
    output,
    defaults,
    previousCamera,
    root,
  );
  warnings.push(...toR.warnings);

  // If camera omitted entirely: static wide
  if (!cam) {
    const wide = cropFromCenterZoom(
      take.width,
      take.height,
      output.width,
      output.height,
      take.width / 2,
      take.height / 2,
      1,
      defaults.camera.zoom_min,
      defaults.camera.zoom_max,
    );
    return { camera: wide.camera, warnings, toPose: fromR.pose };
  }

  const interp = interpolateCamera(
    fromR.pose,
    toR.pose,
    tLocal,
    camDur,
    (isKnownEase(easeName) ? easeName : "ease-out") as EaseName,
    take.width,
    take.height,
    output,
    defaults.camera.zoom_min,
    defaults.camera.zoom_max,
  );
  warnings.push(...interp.warnings);
  return { camera: interp.camera, warnings, toPose: toR.pose };
}

export async function composeFrame(
  input: ComposeInput,
): Promise<ComposeResult> {
  const { take, shot, tLocal, output, defaults } = input;
  const warnings: string[] = [];

  const cam = cameraForShotTime(
    shot,
    tLocal,
    take,
    output,
    defaults,
    input.previousCamera,
    input.root,
  );
  warnings.push(...cam.warnings);

  const crop = cam.camera.crop;
  // sharp extract requires integers
  const left = Math.max(0, Math.floor(crop.x));
  const top = Math.max(0, Math.floor(crop.y));
  let width = Math.max(1, Math.round(crop.w));
  let height = Math.max(1, Math.round(crop.h));
  if (left + width > take.width) width = take.width - left;
  if (top + height > take.height) height = take.height - top;

  let pipeline = sharp(input.sourceFramePath)
    .extract({ left, top, width, height })
    .resize(output.width, output.height, { kernel: sharp.kernel.lanczos3 });

  // Callouts + cursor composited later in dedicated modules; for now optional overlays
  const overlays: sharp.OverlayOptions[] = [];

  if (input.cursorOverlay?.visible) {
    const cursorPng = path.join(ASSETS_DIR, "cursor.png");
    try {
      const mapped = mapSourceToOutput(
        input.cursorOverlay.srcX,
        input.cursorOverlay.srcY,
        cam.camera,
        output,
      );
      const size = Math.round(
        (shot.cursor?.size ?? defaults.cursor.size) * input.cursorOverlay.scale,
      );
      const hotspot = scaleHotspot(size);
      const buf = await sharp(cursorPng)
        .resize({
          width: size,
          height: size,
          fit: "inside",
        })
        .png()
        .toBuffer();
      overlays.push({
        input: buf,
        left: Math.round(mapped.x - hotspot.x),
        top: Math.round(mapped.y - hotspot.y),
      });
    } catch {
      /* missing cursor asset until Task 7 */
    }
  }

  if (overlays.length) {
    pipeline = pipeline.composite(overlays);
  }

  // Apply callouts if provided (Task 9 may enhance)
  if (input.callouts?.length) {
    const { applyCallouts } = await import("./callouts.js").catch(() => ({
      applyCallouts: null,
    }));
    if (applyCallouts) {
      const base = await pipeline.png().toBuffer();
      const withCallouts = await applyCallouts({
        basePng: base,
        callouts: input.callouts,
        takeId: shot.take,
        tSrc: input.tSrc,
        camera: cam.camera,
        output,
        take,
        root: input.root,
      });
      return {
        png: withCallouts.png,
        camera: cam.camera,
        warnings: [...warnings, ...withCallouts.warnings],
      };
    }
  }

  const png = await pipeline.png().toBuffer();
  return { png, camera: cam.camera, warnings };
}

export function mapSourceToOutput(
  srcX: number,
  srcY: number,
  camera: ResolvedCamera,
  output: OutputDefaults,
): { x: number; y: number } {
  const { crop } = camera;
  const x = ((srcX - crop.x) / crop.w) * output.width;
  const y = ((srcY - crop.y) / crop.h) * output.height;
  return { x, y };
}

export function mapRectToOutput(
  rect: Rect,
  camera: ResolvedCamera,
  output: OutputDefaults,
): Rect {
  const tl = mapSourceToOutput(rect.x, rect.y, camera, output);
  const br = mapSourceToOutput(rect.x + rect.w, rect.y + rect.h, camera, output);
  return {
    x: tl.x,
    y: tl.y,
    w: br.x - tl.x,
    h: br.y - tl.y,
  };
}

/** Hotspot (6,4) on unscaled 28-ish cursor; scale with size. */
export function scaleHotspot(size: number, unscaledSize = 28): { x: number; y: number } {
  const scale = size / unscaledSize;
  return { x: 6 * scale, y: 4 * scale };
}
