import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listElements } from "../src/boxes.js";
import { startTake, stopTake } from "../src/capture.js";
import { loadEvents } from "../src/events.js";
import { takeClick } from "../src/page-drive.js";
import { resetCaptureForTests } from "../src/page-session.js";
import { makeTempProject, rmTempProject, serveStaticFile } from "./helpers.js";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/live-app.html",
);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("could not pick a free port"));
        return;
      }
      const { port } = addr;
      probe.close(() => resolve(port));
    });
  });
}

describe("page take attached over cdp_url", { timeout: 60_000 }, () => {
  let dir: string;
  let userBrowser: Browser | null = null;

  beforeEach(() => {
    dir = makeTempProject();
  });

  afterEach(async () => {
    await resetCaptureForTests();
    if (userBrowser) {
      await userBrowser.close();
      userBrowser = null;
    }
    rmTempProject(dir);
    delete process.env.SHOTLIST_DIR;
  });

  it("records boxes, events, and video from an attached browser", async () => {
    const server = await serveStaticFile(FIXTURE);
    try {
      const port = await freePort();
      userBrowser = await chromium.launch({
        args: [`--remote-debugging-port=${port}`, "--disable-dev-shm-usage"],
      });
      const userPage = await userBrowser.newPage();
      await userPage.goto(server.url, { waitUntil: "domcontentloaded" });

      await startTake(
        { cdp_url: `http://127.0.0.1:${port}`, url: server.url },
        dir,
      );
      const clicked = await takeClick({ selector: "#cta" }, dir);
      const result = await stopTake(dir);

      expect(result.has_boxes).toBe(true);
      expect(result.has_events).toBe(true);
      expect(result.duration).toBeGreaterThan(0);
      // The recorded mp4 shares the take timebase, so the click is inside it.
      expect(result.duration).toBeGreaterThanOrEqual(clicked.t);
      expect(fs.existsSync(result.video_path)).toBe(true);
      const listed = listElements(result.take_id, clicked.t, null, dir);
      expect(listed.elements.some((e) => e.selector === "#cta")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("hooks the already loaded page without navigating it", async () => {
    const server = await serveStaticFile(FIXTURE);
    try {
      const port = await freePort();
      userBrowser = await chromium.launch({
        args: [`--remote-debugging-port=${port}`, "--disable-dev-shm-usage"],
      });
      const userPage = await userBrowser.newPage();
      await userPage.goto(server.url, { waitUntil: "domcontentloaded" });

      await startTake({ cdp_url: `http://127.0.0.1:${port}` }, dir);
      await takeClick({ selector: "#cta" }, dir);
      const result = await stopTake(dir);

      const events = loadEvents(result.take_id, dir);
      expect(
        events.some((e) => e.type === "click" && e.selector === "#cta"),
      ).toBe(true);
      expect(
        await userPage.evaluate(
          () => getComputedStyle(document.body).cursor,
        ),
      ).toBe("none");
    } finally {
      await server.close();
    }
  });

  it("leaves the attached browser and page alive after stop", async () => {
    const server = await serveStaticFile(FIXTURE);
    try {
      const port = await freePort();
      userBrowser = await chromium.launch({
        args: [`--remote-debugging-port=${port}`, "--disable-dev-shm-usage"],
      });
      const userPage = await userBrowser.newPage();
      await userPage.goto(server.url, { waitUntil: "domcontentloaded" });

      await startTake({ cdp_url: `http://127.0.0.1:${port}` }, dir);
      await stopTake(dir);

      expect(userBrowser.isConnected()).toBe(true);
      expect(userPage.isClosed()).toBe(false);
      expect(await userPage.evaluate(() => 1 + 1)).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("keeps box rects in the pixel space of the recorded mp4", async () => {
    const server = await serveStaticFile(FIXTURE);
    try {
      const port = await freePort();
      userBrowser = await chromium.launch({
        args: [`--remote-debugging-port=${port}`, "--disable-dev-shm-usage"],
      });
      const userPage = await userBrowser.newPage();
      await userPage.goto(server.url, { waitUntil: "domcontentloaded" });

      await startTake({ cdp_url: `http://127.0.0.1:${port}` }, dir);
      const clicked = await takeClick({ selector: "#cta" }, dir);
      const result = await stopTake(dir);

      const listed = listElements(result.take_id, clicked.t, null, dir);
      const cta = listed.elements.find((e) => e.selector === "#cta");
      expect(cta).toBeTruthy();
      const css = await userPage.evaluate(() => {
        const r = document.querySelector("#cta")!.getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          w: r.width,
          h: r.height,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
        };
      });
      expect(cta!.rect.x / result.width).toBeCloseTo(css.x / css.innerWidth, 2);
      expect(cta!.rect.y / result.height).toBeCloseTo(
        css.y / css.innerHeight,
        2,
      );
      expect(cta!.rect.x + cta!.rect.w).toBeLessThanOrEqual(result.width);
      expect(clicked.x).toBeGreaterThanOrEqual(cta!.rect.x);
      expect(clicked.x).toBeLessThanOrEqual(cta!.rect.x + cta!.rect.w);
      expect(clicked.y).toBeGreaterThanOrEqual(cta!.rect.y);
      expect(clicked.y).toBeLessThanOrEqual(cta!.rect.y + cta!.rect.h);
    } finally {
      await server.close();
    }
  });
});
