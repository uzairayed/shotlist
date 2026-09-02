import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { previewClip } from "../src/render.js";
import { setShotlist } from "../src/shotlist.js";
import { ingestTake } from "../src/takes.js";
import fs from "node:fs";
import {
  generateColorVideo,
  makeTempProject,
  rmTempProject,
} from "./helpers.js";

describe("preview_clip standalone", () => {
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

  it("clamps long ranges to max_seconds", async () => {
    const r = await previewClip(
      { t_in: 0, t_out: 10, max_seconds: 1 },
      dir,
    );
    expect(r.duration).toBeCloseTo(1, 1);
    expect(fs.existsSync(r.mp4_path)).toBe(true);
  });
});
