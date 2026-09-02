import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ToolError } from "./errors.js";
import {
  evenDim,
  ingestTranscode,
  probeVideo,
  requireFfmpeg,
  takeFpsFromSource,
} from "./ffmpeg.js";
import { okResult, toolErrorResult } from "./mcp-result.js";
import { ensureProject, getShotlistDir, takesDir } from "./project.js";
import type { TakeMeta } from "./types.js";

export function newTakeId(): string {
  return `take_${crypto.randomBytes(4).toString("hex")}`;
}

export function takeDir(takeId: string, root?: string): string {
  return path.join(takesDir(root), takeId);
}

export function readTakeMeta(takeId: string, root?: string): TakeMeta {
  const metaPath = path.join(takeDir(takeId, root), "meta.json");
  if (!fs.existsSync(metaPath)) {
    throw new ToolError("TAKE_NOT_FOUND", `take not found: ${takeId}`);
  }
  return JSON.parse(fs.readFileSync(metaPath, "utf8")) as TakeMeta;
}

export function listTakeMetas(root?: string): TakeMeta[] {
  ensureProject(root);
  const dir = takesDir(root);
  if (!fs.existsSync(dir)) return [];
  const out: TakeMeta[] = [];
  for (const name of fs.readdirSync(dir)) {
    const metaPath = path.join(dir, name, "meta.json");
    if (fs.existsSync(metaPath)) {
      out.push(JSON.parse(fs.readFileSync(metaPath, "utf8")) as TakeMeta);
    }
  }
  return out;
}

function countEvents(
  eventsPath: string,
): { clicks: number; moves: number; keys: number } {
  if (!fs.existsSync(eventsPath)) return { clicks: 0, moves: 0, keys: 0 };
  let clicks = 0;
  let moves = 0;
  let keys = 0;
  const text = fs.readFileSync(eventsPath, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as { type?: string };
      if (ev.type === "click") clicks += 1;
      else if (ev.type === "pointer_move") moves += 1;
      else if (ev.type === "keydown") keys += 1;
    } catch {
      /* ignore bad line */
    }
  }
  return { clicks, moves, keys };
}

function copyOrEmpty(src: string | null | undefined, dest: string): boolean {
  if (src && fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    return fs.statSync(dest).size > 0;
  }
  fs.writeFileSync(dest, "");
  return false;
}

export interface IngestResult {
  ok: true;
  take_id: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  has_events: boolean;
  has_boxes: boolean;
  video_path: string;
}

export function ingestTake(
  args: {
    video_path: string;
    events_path?: string | null;
    boxes_path?: string | null;
    take_id?: string | null;
    dpr?: number;
  },
  root?: string,
): IngestResult {
  ensureProject(root);
  const ffmpeg = requireFfmpeg();

  const videoPath = path.isAbsolute(args.video_path)
    ? args.video_path
    : path.resolve(process.cwd(), args.video_path);
  if (!fs.existsSync(videoPath)) {
    throw new ToolError("BAD_INPUT", `video not found: ${videoPath}`);
  }

  const takeId = args.take_id?.trim() || newTakeId();
  const destDir = takeDir(takeId, root);
  fs.mkdirSync(destDir, { recursive: true });

  const probe = probeVideo(videoPath, ffmpeg);
  const fps = takeFpsFromSource(probe.fps);
  const sourcePath = path.join(destDir, "source.mp4");
  ingestTranscode(videoPath, sourcePath, fps, ffmpeg);

  const after = probeVideo(sourcePath, ffmpeg);
  const width = evenDim(after.width);
  const height = evenDim(after.height);

  const eventsPath = path.join(destDir, "events.jsonl");
  const boxesPath = path.join(destDir, "boxes.jsonl");
  const has_events = copyOrEmpty(args.events_path ?? null, eventsPath);
  const has_boxes = copyOrEmpty(args.boxes_path ?? null, boxesPath);

  const meta: TakeMeta = {
    take_id: takeId,
    duration: Number(after.duration.toFixed(3)),
    width,
    height,
    fps,
    dpr: args.dpr ?? 1,
    has_events,
    has_boxes,
    created_at: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(destDir, "meta.json"),
    JSON.stringify(meta, null, 2) + "\n",
  );

  return {
    ok: true,
    take_id: takeId,
    duration: meta.duration,
    width: meta.width,
    height: meta.height,
    fps: meta.fps,
    has_events,
    has_boxes,
    video_path: sourcePath,
  };
}

export function getTake(takeId: string, root?: string) {
  ensureProject(root);
  const meta = readTakeMeta(takeId, root);
  const dir = takeDir(takeId, root);
  const events_path = path.join(dir, "events.jsonl");
  const boxes_path = path.join(dir, "boxes.jsonl");
  const video_path = path.join(dir, "source.mp4");
  return {
    ok: true as const,
    ...meta,
    video_path,
    events_path,
    boxes_path,
    events_summary: countEvents(events_path),
  };
}

export function listTakes(root?: string) {
  return { ok: true as const, takes: listTakeMetas(root) };
}

export function registerTakeTools(server: McpServer): void {
  server.tool(
    "ingest_take",
    "Transcode a local mp4 into takes/{id}/source.mp4 and return take metadata.",
    {
      video_path: z.string(),
      events_path: z.string().nullable().optional(),
      boxes_path: z.string().nullable().optional(),
      take_id: z.string().nullable().optional(),
    },
    async (args) => {
      try {
        return okResult(ingestTake(args, getShotlistDir()));
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.tool(
    "list_takes",
    "List all take meta.json objects in the project.",
    {},
    async () => {
      try {
        return okResult(listTakes(getShotlistDir()));
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.tool(
    "get_take",
    "Return take metadata, paths, and events_summary counts.",
    { take_id: z.string() },
    async ({ take_id }) => {
      try {
        return okResult(getTake(take_id, getShotlistDir()));
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );
}
