import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolError } from "../src/errors.js";
import {
  getPlan,
  hasPlan,
  setPlan,
  TAGISER_PLAN,
} from "../src/plan.js";
import type { PlanJson } from "../src/types.js";
import { makeTempProject, rmTempProject } from "./helpers.js";

describe("set_plan / get_plan", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempProject();
  });

  afterEach(() => {
    rmTempProject(dir);
    delete process.env.SHOTLIST_DIR;
  });

  it("round-trips the tagiser beat list", () => {
    const set = setPlan(structuredClone(TAGISER_PLAN), dir);
    expect(set.ok).toBe(true);
    expect(set.beat_count).toBe(6);
    expect(hasPlan(dir)).toBe(true);

    const got = getPlan(dir);
    expect(got.ok).toBe(true);
    expect(got.plan.product).toBe("tagiser");
    expect(got.plan.url).toBe("https://www.tagiser.com");
    expect(got.plan.beats.map((b) => b.id)).toEqual([
      "b1",
      "b2",
      "b3",
      "b4",
      "b5",
      "b6",
    ]);
    expect(got.plan.beats[3].name).toBe("generate");
    expect(fs.existsSync(path.join(dir, "plan.json"))).toBe(true);
  });

  it("assigns missing beat ids", () => {
    const plan: PlanJson = {
      version: 1,
      product: "demo",
      url: "https://example.com",
      beats: [
        { id: "", name: "a", why: "w", camera: "wide" },
        { id: "", name: "b", why: "w", camera: "push-in" },
      ],
    };
    setPlan(plan, dir);
    const got = getPlan(dir);
    expect(got.plan.beats.map((b) => b.id)).toEqual(["b1", "b2"]);
  });

  it("rejects invalid plans", () => {
    expect(() =>
      setPlan(
        {
          version: 2,
          product: "x",
          url: "https://x",
          beats: [{ id: "b1", name: "a", why: "w", camera: "wide" }],
        },
        dir,
      ),
    ).toThrow(ToolError);

    expect(() =>
      setPlan(
        {
          version: 1,
          product: "",
          url: "https://x",
          beats: [{ id: "b1", name: "a", why: "w", camera: "wide" }],
        },
        dir,
      ),
    ).toThrow(/product/);

    expect(() =>
      setPlan({ version: 1, product: "x", url: "https://x", beats: [] }, dir),
    ).toThrow(/beats/);

    expect(() =>
      setPlan(
        {
          version: 1,
          product: "x",
          url: "https://x",
          beats: [{ id: "b1", name: "a", why: "", camera: "wide" }],
        },
        dir,
      ),
    ).toThrow(/why/);
  });

  it("get_plan returns NO_PLAN when missing", () => {
    try {
      getPlan(dir);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("NO_PLAN");
    }
  });
});
