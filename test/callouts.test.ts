import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addCallout } from "../src/shotlist.js";
import { previewFrame } from "../src/render.js";
import { setShotlist } from "../src/shotlist.js";
import { ingestTake } from "../src/takes.js";
import {
  generateColorVideo,
  makeTempProject,
  rmTempProject,
} from "./helpers.js";

describe("callouts", () => {
  let dir: string;
  let takeId: string;

  beforeEach(() => {
    dir = makeTempProject();
    const videoPath = path.join(dir, "raw.mp4");
    generateColorVideo({ outPath: videoPath, duration: 4 });
    takeId = ingestTake({ video_path: videoPath, take_id: "take_demo" }, dir)
      .take_id;
    fs.writeFileSync(
      path.join(dir, "takes", takeId, "boxes.jsonl"),
      JSON.stringify({
        t: 0,
        elements: [
          {
            selector: "#signup",
            role: "button",
            name: "Sign up",
            rect: { x: 320, y: 80, w: 160, h: 44 },
          },
        ],
      }) + "\n",
    );
    setShotlist(
      {
        version: 1,
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
        callouts: [
          {
            id: "c1",
            take: takeId,
            src_in: 0.5,
            src_out: 1.5,
            target: "#signup",
            label: "Create account",
            style: "highlight",
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

  it("renders highlight callout without crashing", async () => {
    const r = await previewFrame({ shot_id: "s1", shot_time: 1.0 }, dir);
    expect(r.ok).toBe(true);
    expect(fs.existsSync(r.png_path)).toBe(true);
  });

  it("skips unknown selector with warning", async () => {
    addCallout(
      {
        take: takeId,
        src_in: 0,
        src_out: 2,
        target: "#missing",
        style: "outline",
      },
      dir,
    );
    const r = await previewFrame({ shot_id: "s1", shot_time: 1.0 }, dir);
    expect(r.warnings.some((w) => w.includes("ELEMENT_NOT_FOUND"))).toBe(true);
  });
});
