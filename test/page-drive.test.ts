import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listElements } from "../src/boxes.js";
import { startTake, stopTake } from "../src/capture.js";
import { loadEvents } from "../src/events.js";
import { takeClick, takeType } from "../src/page-drive.js";
import {
  requirePageRecording,
  resetCaptureForTests,
} from "../src/page-session.js";
import { makeTempProject, rmTempProject, serveStaticFile } from "./helpers.js";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/live-app.html",
);

const TWO_BUTTONS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/two-buttons.html",
);

describe("page drive tools", { timeout: 60_000 }, () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempProject();
  });

  afterEach(async () => {
    await resetCaptureForTests();
    rmTempProject(dir);
    delete process.env.SHOTLIST_DIR;
  });

  it("take_click with no recording rejects BAD_INPUT", async () => {
    await expect(takeClick({ selector: "#cta" }, dir)).rejects.toMatchObject({
      code: "BAD_INPUT",
    });
  });

  it("take_click #cta records a click inside the #cta rect", async () => {
    const server = await serveStaticFile(FIXTURE);
    try {
      await startTake({ url: server.url }, dir);
      const clicked = await takeClick({ selector: "#cta" }, dir);
      const result = await stopTake(dir);
      const events = loadEvents(result.take_id, dir);
      const click = events.find(
        (e) =>
          e.type === "click" &&
          typeof e.selector === "string" &&
          (e.selector === "#cta" || e.selector.endsWith("#cta")),
      );
      expect(click).toBeTruthy();
      const listed = listElements(result.take_id, click!.t, null, dir);
      const cta = listed.elements.find((e) => e.selector === "#cta");
      expect(cta).toBeTruthy();
      const r = cta!.rect;
      expect(click!.x).toBeGreaterThanOrEqual(r.x);
      expect(click!.x).toBeLessThanOrEqual(r.x + r.w);
      expect(click!.y).toBeGreaterThanOrEqual(r.y);
      expect(click!.y).toBeLessThanOrEqual(r.y + r.h);
      expect(clicked.selector).toBe("#cta");
    } finally {
      await server.close();
    }
  });

  it("after take_click, a later box snapshot includes #result", async () => {
    const server = await serveStaticFile(FIXTURE);
    try {
      await startTake({ url: server.url }, dir);
      const clicked = await takeClick({ selector: "#cta" }, dir);
      const result = await stopTake(dir);
      const events = loadEvents(result.take_id, dir);
      const click = events.find(
        (e) =>
          e.type === "click" &&
          typeof e.selector === "string" &&
          (e.selector === "#cta" || e.selector.endsWith("#cta")),
      );
      expect(click).toBeTruthy();
      const boxesPath = path.join(dir, "takes", result.take_id, "boxes.jsonl");
      const snapshots = fs.readFileSync(boxesPath, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map(
          (line) =>
            JSON.parse(line) as {
              t: number;
              elements: { selector: string }[];
            },
        );
      expect(
        snapshots.some(
          (s) =>
            s.t >= click!.t && s.elements.some((e) => e.selector === "#result"),
        ),
      ).toBe(true);
      expect(clicked.ok).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("take_type records at least one keydown", async () => {
    const server = await serveStaticFile(FIXTURE);
    try {
      await startTake({ url: server.url }, dir);
      await takeType({ selector: "#email", text: "a@b.c" }, dir);
      const result = await stopTake(dir);
      const events = loadEvents(result.take_id, dir);
      expect(events.some((e) => e.type === "keydown")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("take_click of an id-less button uses a unique parent selector", async () => {
    const server = await serveStaticFile(TWO_BUTTONS);
    try {
      await startTake({ url: server.url }, dir);
      const rec = requirePageRecording();
      const snapshots = fs
        .readFileSync(rec.boxesPath, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map(
          (line) =>
            JSON.parse(line) as {
              elements: { selector: string; name?: string }[];
            },
        );
      const elements = snapshots[0]?.elements ?? [];
      const alpha = elements.find(
        (e) => e.name === "Alpha" && e.selector.includes("button"),
      );
      const beta = elements.find(
        (e) => e.name === "Beta" && e.selector.includes("button"),
      );
      expect(alpha?.selector).toBe("#panel-a > button:nth-of-type(1)");
      expect(beta?.selector).toBe("#panel-b > button:nth-of-type(1)");
      expect(elements.some((e) => e.selector === "#cta")).toBe(true);

      await takeClick({ selector: alpha!.selector }, dir);
      const hit = await rec.page.evaluate(() => ({
        alpha: document
          .querySelector("#panel-a button")
          ?.getAttribute("data-hit"),
        beta: document
          .querySelector("#panel-b button")
          ?.getAttribute("data-hit"),
      }));
      expect(hit.alpha).toBe("alpha");
      expect(hit.beta).toBeNull();

      const result = await stopTake(dir);
      const listed = listElements(result.take_id, result.duration, "Alpha", dir);
      expect(listed.elements.some((e) => e.selector === alpha!.selector)).toBe(
        true,
      );
      expect(
        listElements(result.take_id, result.duration, null, dir).elements.some(
          (e) => e.selector === "#cta",
        ),
      ).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("take_click missing selector rejects ELEMENT_NOT_FOUND", async () => {
    const server = await serveStaticFile(FIXTURE);
    try {
      await startTake({ url: server.url }, dir);
      await expect(takeClick({ selector: "#missing" }, dir)).rejects.toMatchObject({
        code: "ELEMENT_NOT_FOUND",
      });
    } finally {
      await server.close();
    }
  });
});
