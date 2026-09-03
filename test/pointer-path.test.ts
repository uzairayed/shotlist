import { describe, expect, it } from "vitest";
import {
  POINTER_SAMPLE_STEP_S,
  easedPointerSamples,
  restPointerSamples,
} from "../src/pointer-path.js";

describe("easedPointerSamples", () => {
  it("writes dense samples along an ease-out path", () => {
    const samples = easedPointerSamples({
      from: { x: 0, y: 0 },
      to: { x: 100, y: 0 },
      t0: 1,
      duration: 0.4,
      easeName: "ease-out",
    });
    expect(samples.length).toBeGreaterThanOrEqual(
      Math.round(0.4 / POINTER_SAMPLE_STEP_S),
    );
    expect(samples[0]).toMatchObject({ t: 1, x: 0, y: 0 });
    expect(samples.at(-1)).toMatchObject({ t: 1.4, x: 100, y: 0 });
    const mid = samples[Math.floor(samples.length / 2)];
    const uRaw = (mid.t - 1) / 0.4;
    expect(mid.x).toBeGreaterThan(uRaw * 100);
  });

  it("duration 0 is a single sample at the destination", () => {
    expect(
      easedPointerSamples({
        from: { x: 0, y: 0 },
        to: { x: 10, y: 20 },
        t0: 2,
        duration: 0,
        easeName: "linear",
      }),
    ).toEqual([{ t: 2, x: 10, y: 20 }]);
  });
});

describe("restPointerSamples", () => {
  it("repeats the same point so interpolation cannot crawl", () => {
    const samples = restPointerSamples({
      at: { x: 50, y: 60 },
      t0: 2,
      duration: 0.18,
    });
    expect(samples.length).toBeGreaterThanOrEqual(3);
    expect(samples.every((s) => s.x === 50 && s.y === 60)).toBe(true);
    expect(samples[0]!.t).toBe(2);
    expect(samples.at(-1)!.t).toBeCloseTo(2.18);
  });
});
