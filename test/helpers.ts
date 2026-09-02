import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shotlist-"));
  process.env.SHOTLIST_DIR = dir;
  return dir;
}

export function rmTempProject(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

export function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

/** Generate a solid-color CFR mp4 via ffmpeg. Requires ffmpeg on PATH. */
export function generateColorVideo(opts: {
  outPath: string;
  width?: number;
  height?: number;
  fps?: number;
  duration?: number;
  color?: string;
}): void {
  const {
    outPath,
    width = 1440,
    height = 900,
    fps = 30,
    duration = 8,
    color = "0x3366CC",
  } = opts;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const result = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=${width}x${height}:d=${duration}:r=${fps}`,
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "ultrafast",
      "-crf",
      "18",
      "-r",
      String(fps),
      "-vsync",
      "cfr",
      "-movflags",
      "+faststart",
      outPath,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `ffmpeg failed generating test video: ${result.stderr || result.stdout}`,
    );
  }
}
