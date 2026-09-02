import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolError } from "../src/errors.js";
import { getTake, ingestTake, listTakes } from "../src/takes.js";
import {
  generateColorVideo,
  makeTempProject,
  rmTempProject,
} from "./helpers.js";

describe("ingest_take", () => {
  let dir: string;
  let videoPath: string;

  beforeEach(() => {
    dir = makeTempProject();
    videoPath = path.join(dir, "raw.mp4");
    generateColorVideo({
      outPath: videoPath,
      width: 1440,
      height: 900,
      fps: 30,
      duration: 2,
    });
  });

  afterEach(() => {
    rmTempProject(dir);
    delete process.env.SHOTLIST_DIR;
    delete process.env.FFMPEG_PATH;
  });

  it("produces source.mp4 + meta.json", () => {
    const result = ingestTake(
      { video_path: videoPath, take_id: "take_demo01" },
      dir,
    );
    expect(result.ok).toBe(true);
    expect(result.take_id).toBe("take_demo01");
    expect(result.width).toBe(1440);
    expect(result.height).toBe(900);
    expect(result.fps).toBe(30);
    expect(result.has_events).toBe(false);
    expect(result.has_boxes).toBe(false);
    expect(fs.existsSync(result.video_path)).toBe(true);
    expect(fs.existsSync(path.join(dir, "takes", "take_demo01", "meta.json"))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(dir, "takes", "take_demo01", "events.jsonl")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(dir, "takes", "take_demo01", "boxes.jsonl")),
    ).toBe(true);
  });

  it("list_takes and get_take work with zero event summary", () => {
    ingestTake({ video_path: videoPath, take_id: "take_abc12345" }, dir);
    const listed = listTakes(dir);
    expect(listed.takes.length).toBe(1);
    const got = getTake("take_abc12345", dir);
    expect(got.events_summary).toEqual({ clicks: 0, moves: 0, keys: 0 });
  });

  it("returns FFMPEG_MISSING when ffmpeg is absent", () => {
    process.env.FFMPEG_PATH = "/nonexistent/ffmpeg-binary-shotlist";
    // Also hide PATH resolution by pointing PATH to empty
    const oldPath = process.env.PATH;
    process.env.PATH = "";
    try {
      expect(() => ingestTake({ video_path: videoPath }, dir)).toThrow(
        ToolError,
      );
      try {
        ingestTake({ video_path: videoPath }, dir);
      } catch (err) {
        expect((err as ToolError).code).toBe("FFMPEG_MISSING");
      }
    } finally {
      process.env.PATH = oldPath;
      delete process.env.FFMPEG_PATH;
    }
  });
});
