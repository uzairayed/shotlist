/** Pure camera / ease math. No ffmpeg. */

import type {
  CameraPoseInput,
  ElementBox,
  OutputDefaults,
  Rect,
  ResolvedCamera,
} from "./types.js";

export type EaseName = "linear" | "ease-in" | "ease-out" | "ease-in-out";

export const EASE_NAMES: EaseName[] = [
  "linear",
  "ease-in",
  "ease-out",
  "ease-in-out",
];

export function isKnownEase(name: string): name is EaseName {
  return (EASE_NAMES as string[]).includes(name);
}

export function ease(name: EaseName, u: number): number {
  const t = clamp01(u);
  switch (name) {
    case "linear":
      return t;
    case "ease-in":
      return t * t;
    case "ease-out":
      return 1 - (1 - t) * (1 - t);
    case "ease-in-out":
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }
}

export function clamp01(u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return u;
}

export function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

export interface MaxCrop {
  max_w: number;
  max_h: number;
}

export function maxCrop(
  sourceW: number,
  sourceH: number,
  outW: number,
  outH: number,
): MaxCrop {
  const aspect = outW / outH;
  let max_h = sourceH;
  let max_w = sourceH * aspect;
  if (max_w > sourceW) {
    max_w = sourceW;
    max_h = sourceW / aspect;
  }
  return { max_w, max_h };
}

export function cropFromCenterZoom(
  sourceW: number,
  sourceH: number,
  outW: number,
  outH: number,
  cx: number,
  cy: number,
  zoom: number,
  zoomMin = 1,
  zoomMax = 4,
): { camera: ResolvedCamera; warnings: string[] } {
  const warnings: string[] = [];
  let z = zoom;
  if (z < zoomMin) {
    z = zoomMin;
    warnings.push("zoom clamped");
  }
  if (z > zoomMax) {
    z = zoomMax;
    warnings.push("zoom clamped");
  }
  if (z < 1) {
    z = 1;
    warnings.push("zoom clamped");
  }

  const { max_w, max_h } = maxCrop(sourceW, sourceH, outW, outH);
  const crop_w = max_w / z;
  const crop_h = max_h / z;

  let x = cx - crop_w / 2;
  let y = cy - crop_h / 2;
  // Clamp crop inside source
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x + crop_w > sourceW) x = sourceW - crop_w;
  if (y + crop_h > sourceH) y = sourceH - crop_h;
  // After shift, recompute center
  const ncx = x + crop_w / 2;
  const ncy = y + crop_h / 2;

  return {
    camera: {
      cx: ncx,
      cy: ncy,
      zoom: z,
      crop: { x, y, w: crop_w, h: crop_h },
    },
    warnings,
  };
}

export function expandRect(rect: Rect, padding: number): Rect {
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    w: rect.w + padding * 2,
    h: rect.h + padding * 2,
  };
}

export function clipRectToSource(
  rect: Rect,
  sourceW: number,
  sourceH: number,
): Rect {
  const x1 = Math.max(0, rect.x);
  const y1 = Math.max(0, rect.y);
  const x2 = Math.min(sourceW, rect.x + rect.w);
  const y2 = Math.min(sourceH, rect.y + rect.h);
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
}

export function zoomToContain(
  sourceW: number,
  sourceH: number,
  outW: number,
  outH: number,
  rect: Rect,
): number {
  const { max_w, max_h } = maxCrop(sourceW, sourceH, outW, outH);
  // Need crop_w >= rect.w and crop_h >= rect.h
  // crop = max / zoom => zoom = max / needed
  const zoomW = max_w / Math.max(rect.w, 1e-6);
  const zoomH = max_h / Math.max(rect.h, 1e-6);
  // Smallest zoom whose crop contains rect = min of the two upper bounds? 
  // crop must be >= rect in both dims, so zoom <= max/rect for each.
  // Smallest zoom that still contains = the limiting (smaller) of those ceilings,
  // but we also want the crop as tight as possible => use min(zoomW, zoomH)? 
  // Spec: "smallest zoom whose crop contains rect'"
  // zoom=1 is largest crop. Higher zoom = smaller crop.
  // To contain rect, crop_w >= rect.w => max_w/zoom >= rect.w => zoom <= max_w/rect.w
  // So maximum allowed zoom is min(zoomW, zoomH). That's the tightest (smallest crop that still contains).
  // "smallest zoom" in English might mean lowest number, but context is "tightest framing that contains".
  // Spec: "If zoom omitted: smallest zoom whose crop contains rect'"
  // Looking at Screen Studio style: you want the minimal crop that still fits the padded rect,
  // which is the HIGHEST zoom that still contains = min(zoomW, zoomH).
  // But they said "smallest zoom". If rect is larger than zoom-1 crop, use zoom 1.
  // So: if rect bigger than max crop, zoom=1. Else use the zoom that tightly fits.
  // I'll interpret as: tightest contain = min(zoomW, zoomH), clamped to >= 1.
  const z = Math.min(zoomW, zoomH);
  if (z < 1) return 1;
  return z;
}

export interface ResolvePoseContext {
  sourceW: number;
  sourceH: number;
  output: OutputDefaults;
  zoomMin?: number;
  zoomMax?: number;
  defaultPadding?: number;
  findElement?: (selector: string) => ElementBox | null;
}

export function resolvePose(
  input: CameraPoseInput | undefined,
  ctx: ResolvePoseContext,
): { pose: { cx: number; cy: number; zoom: number }; warnings: string[] } {
  const warnings: string[] = [];
  const zoomMin = ctx.zoomMin ?? 1;
  const zoomMax = ctx.zoomMax ?? 4;
  const defaultPadding = ctx.defaultPadding ?? 64;
  const wide = {
    cx: ctx.sourceW / 2,
    cy: ctx.sourceH / 2,
    zoom: 1,
  };

  if (!input) return { pose: wide, warnings };

  if ("cx" in input && "cy" in input && "zoom" in input) {
    return {
      pose: { cx: input.cx, cy: input.cy, zoom: input.zoom },
      warnings,
    };
  }

  if ("x" in input && "y" in input && "zoom" in input) {
    return {
      pose: {
        cx: input.x * ctx.sourceW,
        cy: input.y * ctx.sourceH,
        zoom: input.zoom,
      },
      warnings,
    };
  }

  if ("target" in input) {
    const padding = input.padding ?? defaultPadding;
    let rect: Rect | null = null;
    if (typeof input.target === "string") {
      const el = ctx.findElement?.(input.target) ?? null;
      if (!el) {
        warnings.push("ELEMENT_NOT_FOUND");
        return { pose: wide, warnings };
      }
      rect = el.rect;
    } else {
      rect = input.target;
    }
    let expanded = expandRect(rect, padding);
    expanded = clipRectToSource(expanded, ctx.sourceW, ctx.sourceH);
    const cx = expanded.x + expanded.w / 2;
    const cy = expanded.y + expanded.h / 2;
    let zoom: number;
    if (input.zoom != null) {
      zoom = input.zoom;
    } else {
      zoom = zoomToContain(
        ctx.sourceW,
        ctx.sourceH,
        ctx.output.width,
        ctx.output.height,
        expanded,
      );
    }
    zoom = Math.min(zoomMax, Math.max(zoomMin, zoom));
    return { pose: { cx, cy, zoom }, warnings };
  }

  return { pose: wide, warnings };
}

export function interpolateCamera(
  from: { cx: number; cy: number; zoom: number },
  to: { cx: number; cy: number; zoom: number },
  tShot: number,
  duration: number,
  easeName: EaseName,
  sourceW: number,
  sourceH: number,
  output: OutputDefaults,
  zoomMin = 1,
  zoomMax = 4,
): { camera: ResolvedCamera; warnings: string[] } {
  let uRaw = duration <= 0 ? 1 : clamp01(tShot / duration);
  const u = ease(easeName, uRaw);
  const cx = lerp(from.cx, to.cx, u);
  const cy = lerp(from.cy, to.cy, u);
  const zoom = lerp(from.zoom, to.zoom, u); // linear in zoom, not log
  return cropFromCenterZoom(
    sourceW,
    sourceH,
    output.width,
    output.height,
    cx,
    cy,
    zoom,
    zoomMin,
    zoomMax,
  );
}

export function clampCameraDuration(
  duration: number | undefined,
  playingDuration: number,
  defaultDuration = 0.8,
): { duration: number; warnings: string[] } {
  const warnings: string[] = [];
  let d = duration ?? defaultDuration;
  if (d > playingDuration) {
    d = playingDuration;
    warnings.push("camera.duration clamped to playing duration");
  }
  if (d < 0) d = 0;
  return { duration: d, warnings };
}
