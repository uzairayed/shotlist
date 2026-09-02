import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolError } from "../src/errors.js";
import { renderShotlist } from "../src/render.js";
import { setShotlist } from "../src/shotlist.js";
import { ingestTake } from "../src/takes.js";
import { buildTimeline } from "../src/timeline.js";
import {
  generateColorVideo,
  makeTempProject,
  rmTempProject,
} from "./helpers.js";

describe("crossfade", () => {
  let dir: string;
  let takeId: string;

  beforeEach(() => {
    dir = makeTempProject();
    const videoPath = path.join(dir, "raw.mp4");
    generateColorVideo({ outPath: videoPath, duration: 6 });
    takeId = ingestTake({ video_path: videoPath, take_id: "take_demo" }, dir)
      .take_id;
  });

  afterEach(() => {
    rmTempProject(dir);
    delete process.env.SHOTLIST_DIR;
  });

  it("rejects crossfade longer than playing durations", () => {
    expect(() =>
      setShotlist(
        {
          version: 1,
          shots: [
            {
              id: "s1",
              take: takeId,
              src: { in: 0, out: 1 },
              freeze_ms: 0,
              transition_in: { type: "cut" },
            },
            {
              id: "s2",
              take: takeId,
              src: { in: 1, out: 2 },
              freeze_ms: 0,
              transition_in: { type: "crossfade", duration: 1.5 },
            },
          ],
        },
        false,
        dir,
      ),
    ).toThrow(ToolError);
  });

  it("timeline shortens by crossfade and render duration matches", async () => {
    const shotlist = {
      version: 1 as const,
      output: { width: 640, height: 360, fps: 10 },
      shots: [
        {
          id: "s1",
          take: takeId,
          src: { in: 0, out: 1 },
          freeze_ms: 0,
          camera: {
            from: { x: 0.5, y: 0.5, zoom: 1 },
            to: { x: 0.5, y: 0.5, zoom: 1 },
            duration: 0,
            ease: "linear",
          },
          transition_in: { type: "cut" as const },
        },
        {
          id: "s2",
          take: takeId,
          src: { in: 1, out: 2 },
          freeze_ms: 0,
          camera: {
            from: { x: 0.5, y: 0.5, zoom: 1 },
            to: { x: 0.5, y: 0.5, zoom: 1 },
            duration: 0,
            ease: "linear",
          },
          transition_in: { type: "crossfade" as const, duration: 0.25 },
        },
      ],
    };
    setShotlist(shotlist, false, dir);
    const tl = buildTimeline(shotlist, 500);
    expect(tl.duration).toBeCloseTo(1.75, 5);
    const r = await renderShotlist(null, dir);
    expect(Math.abs(r.duration - 1.75)).toBeLessThan(2 / 10);
  });
});
