import { describe, expect, it } from "vitest";
import {
  clampCameraDuration,
  cropFromCenterZoom,
  ease,
  interpolateCamera,
  maxCrop,
  resolvePose,
  zoomToContain,
} from "../src/camera.js";

const OUT = { width: 1920, height: 1080, fps: 30 };
const SRC_W = 1440;
const SRC_H = 900;

describe("camera math", () => {
  it("computes max crop at zoom 1 for 1440x900 -> 1920x1080", () => {
    // aspect 16/9. source 1440x900 = 1.6. out 16/9≈1.777
    // max_w = sourceH * aspect = 900 * (1920/1080) = 1600 > 1440
    // so max_w = 1440, max_h = 1440 / (16/9) = 810
    const m = maxCrop(SRC_W, SRC_H, OUT.width, OUT.height);
    expect(m.max_w).toBeCloseTo(1440, 5);
    expect(m.max_h).toBeCloseTo(810, 5);

    const { camera } = cropFromCenterZoom(
      SRC_W,
      SRC_H,
      OUT.width,
      OUT.height,
      SRC_W / 2,
      SRC_H / 2,
      1,
    );
    expect(camera.crop.w).toBeCloseTo(1440, 5);
    expect(camera.crop.h).toBeCloseTo(810, 5);
    expect(camera.crop.x).toBeCloseTo(0, 5);
    expect(camera.crop.y).toBeCloseTo(45, 5);
  });

  it("halves crop size at zoom 2", () => {
    const z1 = cropFromCenterZoom(
      SRC_W,
      SRC_H,
      OUT.width,
      OUT.height,
      SRC_W / 2,
      SRC_H / 2,
      1,
    ).camera;
    const z2 = cropFromCenterZoom(
      SRC_W,
      SRC_H,
      OUT.width,
      OUT.height,
      SRC_W / 2,
      SRC_H / 2,
      2,
    ).camera;
    expect(z2.crop.w).toBeCloseTo(z1.crop.w / 2, 5);
    expect(z2.crop.h).toBeCloseTo(z1.crop.h / 2, 5);
  });

  it("resolves target+padding and contains the rect", () => {
    const rect = { x: 320, y: 80, w: 160, h: 44 };
    const { pose, warnings } = resolvePose(
      { target: rect, padding: 80 },
      {
        sourceW: SRC_W,
        sourceH: SRC_H,
        output: OUT,
        findElement: () => null,
      },
    );
    expect(warnings).toEqual([]);
    expect(pose.cx).toBeCloseTo(320 + 160 / 2, 5);
    expect(pose.cy).toBeCloseTo(80 + 44 / 2, 5);
    // crop at that zoom should contain expanded rect
    const { camera } = cropFromCenterZoom(
      SRC_W,
      SRC_H,
      OUT.width,
      OUT.height,
      pose.cx,
      pose.cy,
      pose.zoom,
    );
    const expanded = {
      x: rect.x - 80,
      y: rect.y - 80,
      w: rect.w + 160,
      h: rect.h + 160,
    };
    expect(camera.crop.x).toBeLessThanOrEqual(expanded.x + 1e-6);
    expect(camera.crop.y).toBeLessThanOrEqual(Math.max(0, expanded.y) + 1e-6);
    expect(camera.crop.x + camera.crop.w).toBeGreaterThanOrEqual(
      Math.min(SRC_W, expanded.x + expanded.w) - 1e-6,
    );
  });

  it("falls back to wide on missing selector with ELEMENT_NOT_FOUND", () => {
    const { pose, warnings } = resolvePose(
      { target: "#missing" },
      {
        sourceW: SRC_W,
        sourceH: SRC_H,
        output: OUT,
        findElement: () => null,
      },
    );
    expect(warnings).toContain("ELEMENT_NOT_FOUND");
    expect(pose.zoom).toBe(1);
    expect(pose.cx).toBe(SRC_W / 2);
    expect(pose.cy).toBe(SRC_H / 2);
  });

  it("never samples outside the source", () => {
    const { camera } = cropFromCenterZoom(
      SRC_W,
      SRC_H,
      OUT.width,
      OUT.height,
      0,
      0,
      3,
    );
    expect(camera.crop.x).toBeGreaterThanOrEqual(0);
    expect(camera.crop.y).toBeGreaterThanOrEqual(0);
    expect(camera.crop.x + camera.crop.w).toBeLessThanOrEqual(SRC_W + 1e-6);
    expect(camera.crop.y + camera.crop.h).toBeLessThanOrEqual(SRC_H + 1e-6);
  });

  it("implements exact ease formulas", () => {
    expect(ease("linear", 0.5)).toBeCloseTo(0.5);
    expect(ease("ease-in", 0.5)).toBeCloseTo(0.25);
    expect(ease("ease-out", 0.5)).toBeCloseTo(0.75);
    expect(ease("ease-in-out", 0.25)).toBeCloseTo(2 * 0.25 * 0.25);
    expect(ease("ease-in-out", 0.75)).toBeCloseTo(
      1 - Math.pow(-2 * 0.75 + 2, 2) / 2,
    );
  });

  it("lerps zoom linearly", () => {
    const mid = interpolateCamera(
      { cx: 100, cy: 100, zoom: 1 },
      { cx: 100, cy: 100, zoom: 3 },
      0.4,
      0.8,
      "linear",
      SRC_W,
      SRC_H,
      OUT,
    );
    // u_raw = 0.5, linear => zoom = 2
    expect(mid.camera.zoom).toBeCloseTo(2, 5);
  });

  it("clamps camera.duration to playing duration with warning", () => {
    const r = clampCameraDuration(2.0, 1.0);
    expect(r.duration).toBe(1.0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("zoomToContain returns 1 when rect exceeds max crop", () => {
    const huge = { x: 0, y: 0, w: SRC_W, h: SRC_H };
    expect(zoomToContain(SRC_W, SRC_H, OUT.width, OUT.height, huge)).toBe(1);
  });
});
