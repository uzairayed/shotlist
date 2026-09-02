import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { previewFrame, renderShotlist } from "../src/render.js";
import { setShotlist } from "../src/shotlist.js";
import { ingestTake } from "../src/takes.js";
import {
  generateColorVideo,
  makeTempProject,
  rmTempProject,
} from "./helpers.js";

describe("preview_frame + render", () => {
  let dir: string;
  let takeId: string;

  beforeEach(() => {
    dir = makeTempProject();
    const videoPath = path.join(dir, "raw.mp4");
    generateColorVideo({
      outPath: videoPath,
      width: 1440,
      height: 900,
      fps: 30,
      duration: 4,
    });
    takeId = ingestTake({ video_path: videoPath, take_id: "take_demo" }, dir)
      .take_id;

    setShotlist(
      {
        version: 1,
        output: { width: 1920, height: 1080, fps: 30 },
        shots: [
          {
            id: "s1",
            take: takeId,
            src: { in: 0, out: 2 },
            camera: {
              from: { x: 0.5, y: 0.5, zoom: 1 },
              to: { x: 0.5, y: 0.5, zoom: 2 },
              duration: 0.8,
              ease: "ease-out",
            },
            freeze_ms: 500,
            transition_in: { type: "cut" },
          },
        ],
      },
      false,
      dir,
    );
  });

  afterEach(() => {
    rmTempProject(dir);
    delete process.env.SHOTLIST_DIR;
  });

  it("camera eases: zoom differs at 0 vs camera.duration", async () => {
    const a = await previewFrame({ shot_id: "s1", shot_time: 0 }, dir);
    const b = await previewFrame({ shot_id: "s1", shot_time: 0.8 }, dir);
    expect(a.camera.zoom).toBeCloseTo(1, 1);
    expect(b.camera.zoom).toBeGreaterThan(a.camera.zoom + 0.5);
    expect(a.png_path).toMatch(/preview-\d+\.png$/);
    expect(fs.existsSync(a.png_path)).toBe(true);
    expect(a.width).toBe(1920);
    expect(a.height).toBe(1080);
  });

  it("crop never samples outside source", async () => {
    const r = await previewFrame({ shot_id: "s1", shot_time: 0.8 }, dir);
    expect(r.camera.crop.x).toBeGreaterThanOrEqual(0);
    expect(r.camera.crop.y).toBeGreaterThanOrEqual(0);
    expect(r.camera.crop.x + r.camera.crop.w).toBeLessThanOrEqual(1440 + 1e-3);
    expect(r.camera.crop.y + r.camera.crop.h).toBeLessThanOrEqual(900 + 1e-3);
  });

  it("wide preview via take_id + source_t without covering shot", async () => {
    const r = await previewFrame(
      { take_id: takeId, source_t: 3.5 },
      dir,
    );
    expect(r.ok).toBe(true);
    expect(r.camera.zoom).toBeCloseTo(1, 1);
  });

  it("render writes mp4 with expected duration", async () => {
    // playing = 2 + 0.5 = 2.5s
    const r = await renderShotlist(null, dir);
    expect(fs.existsSync(r.mp4_path)).toBe(true);
    expect(r.duration).toBeCloseTo(2.5, 2);
    expect(r.bytes).toBeGreaterThan(1000);
  });
});
