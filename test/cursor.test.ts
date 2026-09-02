import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cursorOverlayForShot } from "../src/cursor.js";
import { previewFrame } from "../src/render.js";
import { setShotlist, updateShot } from "../src/shotlist.js";
import { ingestTake } from "../src/takes.js";
import { DEFAULT_PROJECT } from "../src/types.js";
import {
  generateColorVideo,
  makeTempProject,
  rmTempProject,
  writeJson,
} from "./helpers.js";

describe("authored cursor", () => {
  let dir: string;
  let takeId: string;

  beforeEach(() => {
    dir = makeTempProject();
    const videoPath = path.join(dir, "raw.mp4");
    generateColorVideo({ outPath: videoPath, duration: 4 });
    takeId = ingestTake({ video_path: videoPath, take_id: "take_demo" }, dir)
      .take_id;

    // boxes for #email
    const boxesPath = path.join(dir, "takes", takeId, "boxes.jsonl");
    fs.writeFileSync(
      boxesPath,
      JSON.stringify({
        t: 0,
        elements: [
          {
            selector: "#email",
            role: "textbox",
            name: "Email",
            rect: { x: 400, y: 200, w: 200, h: 40 },
          },
        ],
      }) + "\n",
    );
    writeJson(path.join(dir, "takes", takeId, "meta.json"), {
      ...JSON.parse(
        fs.readFileSync(path.join(dir, "takes", takeId, "meta.json"), "utf8"),
      ),
      has_boxes: true,
    });

    setShotlist(
      {
        version: 1,
        shots: [
          {
            id: "s1",
            take: takeId,
            src: { in: 0, out: 2 },
            camera: {
              from: { x: 0.5, y: 0.5, zoom: 1 },
              to: { x: 0.5, y: 0.5, zoom: 1 },
              duration: 0.1,
              ease: "linear",
            },
            cursor: {
              visible: true,
              from: { x: 0.5, y: 0.8 },
              to: { target: "#email" },
              travel: 0.45,
              dwell_ms: 180,
              click_at: 1.85,
            },
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

  it("two frames during travel have different overlay positions", () => {
    const take = JSON.parse(
      fs.readFileSync(path.join(dir, "takes", takeId, "meta.json"), "utf8"),
    );
    const shot = setShotlist.length
      ? JSON.parse(fs.readFileSync(path.join(dir, "shotlist.json"), "utf8"))
          .shots[0]
      : null;
    const a = cursorOverlayForShot({
      shot,
      tLocal: 0.1,
      tSrc: 0.1,
      take,
      defaults: DEFAULT_PROJECT.defaults,
      root: dir,
    });
    const b = cursorOverlayForShot({
      shot,
      tLocal: 0.3,
      tSrc: 0.3,
      take,
      defaults: DEFAULT_PROJECT.defaults,
      root: dir,
    });
    expect(a?.visible).toBe(true);
    expect(b?.visible).toBe(true);
    expect(a!.x !== b!.x || a!.y !== b!.y).toBe(true);
  });

  it("visible false draws nothing", () => {
    updateShot("s1", { cursor: { visible: false } }, dir);
    const take = JSON.parse(
      fs.readFileSync(path.join(dir, "takes", takeId, "meta.json"), "utf8"),
    );
    const shot = JSON.parse(
      fs.readFileSync(path.join(dir, "shotlist.json"), "utf8"),
    ).shots[0];
    const c = cursorOverlayForShot({
      shot,
      tLocal: 0.2,
      tSrc: 0.2,
      take,
      defaults: DEFAULT_PROJECT.defaults,
      root: dir,
    });
    expect(c?.visible).toBe(false);
  });

  it("NO_CURSOR_PATH when visible but no from/to and no events", () => {
    updateShot(
      "s1",
      { cursor: { visible: true, from: null, to: null } },
      dir,
    );
    // clear from/to properly
    const sl = JSON.parse(fs.readFileSync(path.join(dir, "shotlist.json"), "utf8"));
    sl.shots[0].cursor = { visible: true };
    fs.writeFileSync(path.join(dir, "shotlist.json"), JSON.stringify(sl));
    const take = JSON.parse(
      fs.readFileSync(path.join(dir, "takes", takeId, "meta.json"), "utf8"),
    );
    const c = cursorOverlayForShot({
      shot: sl.shots[0],
      tLocal: 0.2,
      tSrc: 0.2,
      take,
      defaults: DEFAULT_PROJECT.defaults,
      root: dir,
    });
    expect(c?.warning).toBe("NO_CURSOR_PATH");
    expect(c?.visible).toBe(false);
  });

  it("preview_frame still succeeds with cursor overlay", async () => {
    const r = await previewFrame({ shot_id: "s1", shot_time: 0.2 }, dir);
    expect(r.ok).toBe(true);
    expect(fs.existsSync(r.png_path)).toBe(true);
  });
});
