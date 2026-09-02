import { describe, expect, it } from "vitest";
import { buildTimeline, sourceTimeForShot } from "../src/timeline.js";
import type { ShotlistJson } from "../src/types.js";

describe("timeline", () => {
  it("sums playing durations for cuts", () => {
    const shotlist: ShotlistJson = {
      version: 1,
      shots: [
        {
          id: "s1",
          take: "t",
          src: { in: 0, out: 2 },
          freeze_ms: 400,
          transition_in: { type: "cut" },
        },
        {
          id: "s2",
          take: "t",
          src: { in: 2, out: 5 },
          freeze_ms: 600,
          transition_in: { type: "cut" },
        },
      ],
    };
    // (2+0.4) + (3+0.6) = 6
    const tl = buildTimeline(shotlist, 500);
    expect(tl.duration).toBeCloseTo(6, 5);
    expect(tl.shots[1].start).toBeCloseTo(2.4, 5);
  });

  it("shortens timeline by crossfade duration", () => {
    const shotlist: ShotlistJson = {
      version: 1,
      shots: [
        {
          id: "s1",
          take: "t",
          src: { in: 0, out: 2 },
          freeze_ms: 0,
          transition_in: { type: "cut" },
        },
        {
          id: "s2",
          take: "t",
          src: { in: 2, out: 4 },
          freeze_ms: 0,
          transition_in: { type: "crossfade", duration: 0.5 },
        },
      ],
    };
    const tl = buildTimeline(shotlist, 500);
    expect(tl.duration).toBeCloseTo(3.5, 5);
  });

  it("freezes at src.out after playing portion", () => {
    const shot = {
      id: "s1",
      take: "t",
      src: { in: 1, out: 3 },
      freeze_ms: 500,
    };
    expect(sourceTimeForShot(shot, 1.5).tSrc).toBeCloseTo(2.5);
    expect(sourceTimeForShot(shot, 2.0).frozen).toBe(true);
    expect(sourceTimeForShot(shot, 2.0).tSrc).toBe(3);
  });
});
