import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listElements } from "./boxes.js";
import { okResult, toolErrorResult } from "./mcp-result.js";
import { getShotlistDir } from "./project.js";
import { ToolError } from "./errors.js";
import { busy } from "./busy.js";
import { ingestTake, newTakeId, takeDir } from "./takes.js";
import { requireFfmpeg } from "./ffmpeg.js";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { ensureProject } from "./project.js";

let currentRecording: {
  takeId: string;
  proc: ChildProcess;
  rawPath: string;
  dir: string;
} | null = null;

export function startTake(
  args: {
    fps?: number;
    region?: { x: number; y: number; w: number; h: number };
    display?: string;
  },
  root?: string,
): { ok: true; take_id: string; status: "recording" } {
  ensureProject(root);
  if (process.platform !== "linux") {
    throw new ToolError(
      "NOT_IMPLEMENTED",
      "start_take is Linux x11grab only; use ingest_take on this machine",
    );
  }
  busy.beginRecord();
  try {
    const ffmpeg = requireFfmpeg();
    const takeId = newTakeId();
    const dir = takeDir(takeId, root);
    fs.mkdirSync(dir, { recursive: true });
    const region = args.region ?? { x: 0, y: 0, w: 1440, h: 900 };
    const fps = args.fps ?? 30;
    const display = args.display ?? ":0";
    const rawPath = path.join(dir, "raw-capture.mp4");
    const proc = spawn(
      ffmpeg,
      [
        "-y",
        "-video_size",
        `${region.w}x${region.h}`,
        "-framerate",
        String(fps),
        "-f",
        "x11grab",
        "-draw_mouse",
        "0",
        "-i",
        `${display}+${region.x},${region.y}`,
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "ultrafast",
        rawPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    currentRecording = { takeId, proc, rawPath, dir };
    // empty events/boxes while recording
    fs.writeFileSync(path.join(dir, "events.jsonl"), "");
    fs.writeFileSync(path.join(dir, "boxes.jsonl"), "");
    return { ok: true, take_id: takeId, status: "recording" };
  } catch (err) {
    busy.endRecord();
    throw err;
  }
}

export function stopTake(root?: string) {
  if (!currentRecording) {
    throw new ToolError("BAD_INPUT", "nothing is recording");
  }
  const rec = currentRecording;
  currentRecording = null;
  return new Promise<ReturnType<typeof ingestTake>>((resolve, reject) => {
    rec.proc.on("exit", async () => {
      try {
        busy.endRecord();
        const result = ingestTake(
          {
            video_path: rec.rawPath,
            take_id: rec.takeId,
            events_path: path.join(rec.dir, "events.jsonl"),
            boxes_path: path.join(rec.dir, "boxes.jsonl"),
          },
          root,
        );
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
    rec.proc.kill("SIGINT");
    setTimeout(() => {
      if (!rec.proc.killed) rec.proc.kill("SIGKILL");
    }, 2000);
  });
}

export function registerCaptureTools(server: McpServer): void {
  server.tool(
    "start_take",
    "Start Linux x11grab recording of a screen region; returns take_id and status recording.",
    {
      fps: z.number().optional(),
      region: z
        .object({
          x: z.number(),
          y: z.number(),
          w: z.number(),
          h: z.number(),
        })
        .optional(),
      display: z.string().optional(),
    },
    async (args) => {
      try {
        return okResult(startTake(args, getShotlistDir()));
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.tool(
    "stop_take",
    "Finalize the current recording like ingest_take and return take metadata.",
    {},
    async () => {
      try {
        return okResult(await stopTake(getShotlistDir()));
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.tool(
    "list_elements",
    "Return boxes.jsonl elements at time t for a take, optionally filtered by query.",
    {
      take_id: z.string(),
      t: z.number(),
      query: z.string().nullable().optional(),
    },
    async ({ take_id, t, query }) => {
      try {
        return okResult(listElements(take_id, t, query, getShotlistDir()));
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );
}
