import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listElements } from "../src/boxes.js";
import { cursorFromEvents, loadEvents } from "../src/events.js";
import { ingestTake } from "../src/takes.js";
import {
  generateColorVideo,
  makeTempProject,
  rmTempProject,
} from "./helpers.js";

describe("events and boxes", () => {
  let dir: string;
  let takeId: string;

  beforeEach(() => {
    dir = makeTempProject();
    const videoPath = path.join(dir, "raw.mp4");
    generateColorVideo({ outPath: videoPath, duration: 8 });
    const eventsPath = path.join(dir, "events.jsonl");
    const boxesPath = path.join(dir, "boxes.jsonl");
    fs.writeFileSync(
      eventsPath,
      [
        JSON.stringify({ t: 1.0, type: "pointer_move", x: 100, y: 100 }),
        JSON.stringify({ t: 2.0, type: "click", x: 400, y: 220, selector: "#email" }),
        JSON.stringify({ t: 5.0, type: "click", x: 400, y: 500, selector: "#signup" }),
        JSON.stringify({ t: 3.0, type: "keydown", key: "a" }),
        JSON.stringify({ t: 4.0, type: "unknown_type", foo: 1 }),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      boxesPath,
      [
        JSON.stringify({
          t: 2.0,
          elements: [
            {
              selector: "#email",
              role: "textbox",
              name: "Email",
              rect: { x: 300, y: 200, w: 200, h: 40 },
            },
          ],
        }),
        JSON.stringify({
          t: 5.0,
          elements: [
            {
              selector: "#signup",
              role: "button",
              name: "Sign up",
              rect: { x: 320, y: 480, w: 160, h: 44 },
            },
          ],
        }),
      ].join("\n") + "\n",
    );
    takeId = ingestTake(
      {
        video_path: videoPath,
        events_path: eventsPath,
        boxes_path: boxesPath,
        take_id: "take_demo",
      },
      dir,
    ).take_id;
  });

  afterEach(() => {
    rmTempProject(dir);
    delete process.env.SHOTLIST_DIR;
  });

  it("list_elements uses greatest t' <= t", () => {
    const at15 = listElements(takeId, 1.5, null, dir);
    expect(at15.elements).toEqual([]);
    const at25 = listElements(takeId, 2.5, null, dir);
    expect(at25.t_snapshot).toBe(2);
    expect(at25.elements[0].selector).toBe("#email");
    const at6 = listElements(takeId, 6, "sign", dir);
    expect(at6.elements.length).toBe(1);
    expect(at6.elements[0].selector).toBe("#signup");
  });

  it("event cursor interpolates and ignores unknown types", () => {
    const events = loadEvents(takeId, dir);
    expect(events.some((e) => e.type === "unknown_type")).toBe(true);
    const mid = cursorFromEvents(events, 1.5);
    expect(mid).not.toBeNull();
    expect(mid!.x).toBeGreaterThan(100);
    expect(mid!.x).toBeLessThan(400);
    expect(cursorFromEvents(events, 0.5)).toBeNull();
  });
});
