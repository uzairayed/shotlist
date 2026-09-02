import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolError } from "../src/errors.js";
import { busy } from "../src/busy.js";
import { startTake, stopTake } from "../src/capture.js";
import { resetCaptureForTests } from "../src/page-session.js";
import { previewClip } from "../src/render.js";
import { setShotlist } from "../src/shotlist.js";
import { ingestTake } from "../src/takes.js";
import path from "node:path";
import fs from "node:fs";
import {
  generateColorVideo,
  makeTempProject,
  rmTempProject,
} from "./helpers.js";

describe("capture", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempProject();
  });

  afterEach(async () => {
    await resetCaptureForTests();
    rmTempProject(dir);
    delete process.env.SHOTLIST_DIR;
  });

  it("start_take without url is BAD_INPUT in page mode", async () => {
    await expect(startTake({}, dir)).rejects.toMatchObject({
      code: "BAD_INPUT",
    });
  });

  it("start_take x11 mode is NOT_IMPLEMENTED off Linux", async () => {
    if (process.platform === "linux") return;
    await expect(startTake({ mode: "x11" }, dir)).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
  });

  it("stop_take without recording is BAD_INPUT", async () => {
    await expect(stopTake(dir)).rejects.toMatchObject({
      code: "BAD_INPUT",
    });
  });

  it("BUSY when beginning a second render", async () => {
    busy.beginRender();
    try {
      expect(() => busy.beginRender()).toThrow(ToolError);
    } finally {
      busy.endRender();
    }
  });
});

describe("preview_clip", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempProject();
    const videoPath = path.join(dir, "raw.mp4");
    generateColorVideo({ outPath: videoPath, duration: 3 });
    const takeId = ingestTake(
      { video_path: videoPath, take_id: "take_demo" },
      dir,
    ).take_id;
    setShotlist(
      {
        version: 1,
        output: { width: 640, height: 360, fps: 10 },
        shots: [
          {
            id: "s1",
            take: takeId,
            src: { in: 0, out: 2 },
            freeze_ms: 0,
            camera: {
              from: { x: 0.5, y: 0.5, zoom: 1 },
              to: { x: 0.5, y: 0.5, zoom: 1 },
              duration: 0,
              ease: "linear",
            },
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

  it("renders a short clip for a shot", async () => {
    const r = await previewClip({ shot_id: "s1", max_seconds: 5 }, dir);
    expect(fs.existsSync(r.mp4_path)).toBe(true);
    expect(r.duration).toBeLessThanOrEqual(5);
  });
});
