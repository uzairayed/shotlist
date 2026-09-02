import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listElements } from "../src/boxes.js";
import { startTake, stopTake } from "../src/capture.js";
import { loadEvents } from "../src/events.js";
import { takeClick } from "../src/page-drive.js";
import { resetCaptureForTests } from "../src/page-session.js";
import { setPlan } from "../src/plan.js";
import { previewFrame, renderShotlist } from "../src/render.js";
import { setShotlist } from "../src/shotlist.js";
import { makeTempProject, rmTempProject, serveStaticFile } from "./helpers.js";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/live-app.html",
);

describe("page-aware live take to camera target", { timeout: 60_000 }, () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempProject();
  });

  afterEach(async () => {
    await resetCaptureForTests();
    rmTempProject(dir);
    delete process.env.SHOTLIST_DIR;
  });

  it("aims the camera at a clicked control and renders", async () => {
    const server = await serveStaticFile(FIXTURE);
    try {
      setPlan(
        {
          version: 1,
          product: "demo-app",
          url: server.url,
          beats: [
            {
              id: "b1",
              name: "cta",
              why: "show the get-started control",
              camera: "push in on #cta",
            },
          ],
        },
        dir,
      );

      await startTake({ url: server.url }, dir);
      await takeClick({ selector: "#cta" }, dir);
      await new Promise((r) => setTimeout(r, 1000));
      const stopped = await stopTake(dir);

      const takeDirPath = path.join(dir, "takes", stopped.take_id);
      expect(fs.statSync(path.join(takeDirPath, "events.jsonl")).size).toBeGreaterThan(
        0,
      );
      expect(fs.statSync(path.join(takeDirPath, "boxes.jsonl")).size).toBeGreaterThan(
        0,
      );

      const events = loadEvents(stopped.take_id, dir);
      const click = events.find(
        (e) =>
          e.type === "click" &&
          typeof e.selector === "string" &&
          (e.selector === "#cta" || e.selector.endsWith("#cta")),
      );
      expect(click).toBeTruthy();

      const listed = listElements(stopped.take_id, click!.t, null, dir);
      const cta = listed.elements.find((e) => e.selector === "#cta");
      expect(cta).toBeTruthy();

      const srcIn = Math.max(0, click!.t - 0.2);
      const srcOut = Math.min(stopped.duration, click!.t + 0.8);
      setShotlist(
        {
          version: 1,
          output: { width: 640, height: 360, fps: 10 },
          shots: [
            {
              id: "s1",
              take: stopped.take_id,
              src: { in: srcIn, out: srcOut },
              camera: {
                from: { x: 0.5, y: 0.5, zoom: 1 },
                to: { target: "#cta" },
                duration: 0.4,
              },
              freeze_ms: 0,
            },
          ],
        },
        true,
        dir,
      );

      const preview = await previewFrame({ shot_id: "s1", shot_time: 0.4 }, dir);
      expect(preview.warnings).not.toContain("ELEMENT_NOT_FOUND");
      expect(preview.camera.zoom).toBeGreaterThan(1);
      const crop = preview.camera.crop;
      const rect = cta!.rect;
      expect(crop.x).toBeLessThanOrEqual(rect.x);
      expect(crop.y).toBeLessThanOrEqual(rect.y);
      expect(crop.x + crop.w).toBeGreaterThanOrEqual(rect.x + rect.w);
      expect(crop.y + crop.h).toBeGreaterThanOrEqual(rect.y + rect.h);

      const rendered = await renderShotlist(null, dir);
      expect(fs.existsSync(rendered.mp4_path)).toBe(true);
      expect(rendered.duration).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });
});
