import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolError } from "../src/errors.js";
import { setPlan, TAGISER_PLAN } from "../src/plan.js";
import {
  addShot,
  getShotlist,
  setShotlist,
  updateShot,
} from "../src/shotlist.js";
import { ingestTake } from "../src/takes.js";
import type { ShotlistJson } from "../src/types.js";
import {
  generateColorVideo,
  makeTempProject,
  rmTempProject,
} from "./helpers.js";

describe("shotlist CRUD", () => {
  let dir: string;
  let takeId: string;

  beforeEach(() => {
    dir = makeTempProject();
    const videoPath = path.join(dir, "raw.mp4");
    generateColorVideo({ outPath: videoPath, duration: 8 });
    const ingested = ingestTake(
      { video_path: videoPath, take_id: "take_demo" },
      dir,
    );
    takeId = ingested.take_id;
  });

  afterEach(() => {
    rmTempProject(dir);
    delete process.env.SHOTLIST_DIR;
  });

  function baseShotlist(): ShotlistJson {
    return {
      version: 1,
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
          freeze_ms: 400,
          transition_in: { type: "cut" },
        },
      ],
    };
  }

  it("set_shotlist warns NO_PLAN when plan missing", () => {
    const r = setShotlist(baseShotlist(), false, dir);
    expect(r.ok).toBe(true);
    expect(r.warnings).toContain("NO_PLAN");
  });

  it("rejects in >= out and unknown ease", () => {
    expect(() =>
      setShotlist(
        {
          version: 1,
          shots: [
            {
              id: "s1",
              take: takeId,
              src: { in: 2, out: 2 },
            },
          ],
        },
        false,
        dir,
      ),
    ).toThrow(ToolError);

    try {
      setShotlist(
        {
          version: 1,
          shots: [
            {
              id: "s1",
              take: takeId,
              src: { in: 0, out: 1 },
              camera: { ease: "spring" },
            },
          ],
        },
        false,
        dir,
      );
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("INVALID_SHOTLIST");
    }
  });

  it("warns on unknown beat when plan exists", () => {
    setPlan(structuredClone(TAGISER_PLAN), dir);
    const r = setShotlist(
      {
        version: 1,
        shots: [
          {
            id: "s1",
            beat: "b99",
            take: takeId,
            src: { in: 0, out: 1 },
          },
        ],
      },
      false,
      dir,
    );
    expect(r.warnings.some((w) => w.includes("b99"))).toBe(true);
  });

  it("allows beat b4 when plan has it", () => {
    setPlan(structuredClone(TAGISER_PLAN), dir);
    const r = setShotlist(
      {
        version: 1,
        shots: [
          {
            beat: "b4",
            take: takeId,
            src: { in: 0, out: 1 },
          },
        ],
      },
      false,
      dir,
    );
    expect(r.shot_count).toBe(1);
    expect(getShotlist(dir).shotlist.shots[0].beat).toBe("b4");
  });

  it("update_shot shallow-merges camera.to", () => {
    setShotlist(baseShotlist(), false, dir);
    const r = updateShot(
      "s1",
      { camera: { to: { x: 0.2, y: 0.3, zoom: 3 } }, freeze_ms: 800 },
      dir,
    );
    expect(r.shot.freeze_ms).toBe(800);
    expect(r.shot.camera?.to).toEqual({ x: 0.2, y: 0.3, zoom: 3 });
    expect(r.shot.camera?.from).toEqual({ x: 0.5, y: 0.5, zoom: 1 });
  });

  it("add_shot auto-creates shotlist", () => {
    const r = addShot(
      { take: takeId, src: { in: 0, out: 1 } } as never,
      null,
      dir,
    );
    expect(r.id).toMatch(/^s\d+$/);
    expect(getShotlist(dir).shotlist.shots.length).toBe(1);
  });

  it("get_shotlist errors when missing", () => {
    try {
      getShotlist(dir);
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).code).toBe("NO_SHOTLIST");
    }
  });
});
