import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { busy } from "../src/busy.js";
import { listElements } from "../src/boxes.js";
import { startTake, stopTake } from "../src/capture.js";
import {
  isPageRecording,
  requirePageRecording,
  resetCaptureForTests,
  sampleBoxes,
  stopPageTake,
} from "../src/page-session.js";
import { ingestTake } from "../src/takes.js";
import {
  generateColorVideo,
  makeTempProject,
  rmTempProject,
  serveStaticFile,
} from "./helpers.js";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/live-app.html",
);

describe("page-aware start_take / stop_take", { timeout: 60_000 }, () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempProject();
  });

  afterEach(async () => {
    await resetCaptureForTests();
    rmTempProject(dir);
    delete process.env.SHOTLIST_DIR;
  });

  it("start_take without url/cdp_url (page mode) rejects BAD_INPUT", async () => {
    await expect(startTake({}, dir)).rejects.toMatchObject({
      code: "BAD_INPUT",
    });
  });

  it("start_take x11 mode off Linux rejects NOT_IMPLEMENTED", async () => {
    if (process.platform === "linux") return;
    await expect(startTake({ mode: "x11" }, dir)).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
  });

  it("start_take url then stop_take writes boxes, video, and #cta", async () => {
    const server = await serveStaticFile(FIXTURE);
    try {
      const started = await startTake({ url: server.url }, dir);
      await new Promise((r) => setTimeout(r, 700));
      const result = await stopTake(dir);
      expect(result.has_boxes).toBe(true);
      expect(result.duration).toBeGreaterThan(0);
      const boxesPath = path.join(dir, "takes", result.take_id, "boxes.jsonl");
      const lines = fs
        .readFileSync(boxesPath, "utf8")
        .split("\n")
        .filter((line) => line.trim());
      expect(lines.length).toBeGreaterThanOrEqual(2);
      const snapshots = lines.map((line) => JSON.parse(line) as {
        t: number;
        elements: { selector: string }[];
      });
      expect(
        snapshots.some((s) => s.elements.some((e) => e.selector === "#cta")),
      ).toBe(true);
      expect(fs.existsSync(path.join(dir, "takes", result.take_id, "source.mp4"))).toBe(
        true,
      );
      expect(started.take_id).toBe(result.take_id);
    } finally {
      await server.close();
    }
  });

  it("list_elements finds the CTA by name", async () => {
    const server = await serveStaticFile(FIXTURE);
    try {
      await startTake({ url: server.url }, dir);
      await new Promise((r) => setTimeout(r, 700));
      const result = await stopTake(dir);
      const listed = listElements(result.take_id, result.duration, "started", dir);
      const cta = listed.elements.find((e) => e.selector === "#cta");
      expect(cta).toBeTruthy();
      expect(cta?.role).toBe("button");
      expect(cta?.name).toMatch(/Get started/);
    } finally {
      await server.close();
    }
  });

  it("hides the CSS cursor on the recorded page", async () => {
    const server = await serveStaticFile(FIXTURE);
    try {
      await startTake({ url: server.url }, dir);
      const rec = requirePageRecording();
      const cursor = await rec.page.evaluate(
        () => getComputedStyle(document.body).cursor,
      );
      expect(cursor).toBe("none");
    } finally {
      await server.close();
    }
  });

  it("keeps CSS cursor hidden after in-take navigation", async () => {
    const server = await serveStaticFile(FIXTURE);
    try {
      await startTake({ url: server.url }, dir);
      const rec = requirePageRecording();
      await rec.page.goto(new URL("/next.html", server.url).href, {
        waitUntil: "domcontentloaded",
      });
      await rec.page.waitForFunction(
        () => getComputedStyle(document.body).cursor === "none",
      );
      const cursor = await rec.page.evaluate(
        () => getComputedStyle(document.body).cursor,
      );
      expect(cursor).toBe("none");
    } finally {
      await server.close();
    }
  });

  it("second start_take while recording rejects BUSY", async () => {
    const server = await serveStaticFile(FIXTURE);
    try {
      await startTake({ url: server.url }, dir);
      await expect(startTake({ url: server.url }, dir)).rejects.toMatchObject({
        code: "BUSY",
      });
    } finally {
      await server.close();
    }
  });

  it("first box sample evaluate failure fails the take", async () => {
    const server = await serveStaticFile(FIXTURE);
    try {
      await startTake({ url: server.url }, dir);
      const rec = requirePageRecording();
      rec.lastBoxSampleT = null;
      rec.page.evaluate = (async () => {
        throw new Error("collect failed");
      }) as typeof rec.page.evaluate;
      await expect(sampleBoxes("nav")).rejects.toMatchObject({
        code: "CAPTURE_FAILED",
      });
    } finally {
      await server.close();
    }
  });

  it("stopPageTake clears recording when page close throws", async () => {
    const server = await serveStaticFile(FIXTURE);
    try {
      await startTake({ url: server.url }, dir);
      const rec = requirePageRecording();
      rec.page.close = async () => {
        throw new Error("close failed");
      };
      await expect(stopPageTake(dir)).rejects.toThrow("close failed");
      expect(isPageRecording()).toBe(false);
      expect(busy.isRecording()).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("in-place ingest jsonl is not wiped", () => {
    const takeId = "take_inplace";
    const destDir = path.join(dir, "takes", takeId);
    fs.mkdirSync(destDir, { recursive: true });
    const eventsPath = path.join(destDir, "events.jsonl");
    const payload = '{"t":0,"type":"nav","url":"http://127.0.0.1/"}' + "\n";
    fs.writeFileSync(eventsPath, payload);
    const videoPath = path.join(dir, "raw.mp4");
    generateColorVideo({ outPath: videoPath, duration: 1 });
    const result = ingestTake(
      { video_path: videoPath, events_path: eventsPath, take_id: takeId },
      dir,
    );
    expect(result.has_events).toBe(true);
    expect(fs.readFileSync(eventsPath, "utf8")).toBe(payload);
  });
});
