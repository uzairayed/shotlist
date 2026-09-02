import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ToolError } from "./errors.js";

export function resolveFfmpeg(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FFMPEG_PATH && env.FFMPEG_PATH.trim()) return env.FFMPEG_PATH;
  const which = spawnSync("which", ["ffmpeg"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  // Also try common paths when PATH is stripped in tests
  for (const p of ["/opt/homebrew/bin/ffmpeg", "/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"]) {
    if (fs.existsSync(p)) return p;
  }
  throw new ToolError("FFMPEG_MISSING", "ffmpeg is required but was not found");
}

export function requireFfmpeg(env: NodeJS.ProcessEnv = process.env): string {
  try {
    // Explicit bad FFMPEG_PATH must fail (tests + user override)
    if (env.FFMPEG_PATH && env.FFMPEG_PATH.trim()) {
      const bin = env.FFMPEG_PATH.trim();
      if (!fs.existsSync(bin)) {
        throw new ToolError(
          "FFMPEG_MISSING",
          "ffmpeg is required but was not found",
        );
      }
      const probe = spawnSync(bin, ["-version"], { encoding: "utf8" });
      if (probe.error || probe.status !== 0) {
        throw new ToolError(
          "FFMPEG_MISSING",
          "ffmpeg is required but was not found",
        );
      }
      return bin;
    }
    const bin = resolveFfmpeg(env);
    if (!fs.existsSync(bin)) {
      throw new ToolError(
        "FFMPEG_MISSING",
        "ffmpeg is required but was not found",
      );
    }
    const probe = spawnSync(bin, ["-version"], { encoding: "utf8" });
    if (probe.error || (probe.status !== 0 && probe.status !== null)) {
      // ffmpeg -version returns 0; treat spawn failure as missing
      if (probe.error) {
        throw new ToolError(
          "FFMPEG_MISSING",
          "ffmpeg is required but was not found",
        );
      }
    }
    return bin;
  } catch (err) {
    if (err instanceof ToolError) throw err;
    throw new ToolError(
      "FFMPEG_MISSING",
      "ffmpeg is required but was not found",
    );
  }
}

export interface ProbeResult {
  duration: number;
  width: number;
  height: number;
  fps: number;
}

export function probeVideo(input: string, ffmpegBin?: string): ProbeResult {
  const bin = ffmpegBin ?? requireFfmpeg();
  // Prefer ffprobe next to ffmpeg
  const ffprobe = bin.replace(/ffmpeg$/, "ffprobe");
  const probeBin = fs.existsSync(ffprobe) ? ffprobe : bin;
  const args =
    probeBin === bin
      ? ["-i", input]
      : [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=width,height,r_frame_rate,avg_frame_rate:format=duration",
          "-of",
          "json",
          input,
        ];

  if (probeBin !== bin) {
    const r = spawnSync(probeBin, args, { encoding: "utf8" });
    if (r.status !== 0) {
      throw new ToolError("BAD_INPUT", `failed to probe video: ${r.stderr}`);
    }
    const data = JSON.parse(r.stdout) as {
      streams?: Array<{
        width?: number;
        height?: number;
        r_frame_rate?: string;
        avg_frame_rate?: string;
      }>;
      format?: { duration?: string };
    };
    const stream = data.streams?.[0] ?? {};
    const rate = stream.avg_frame_rate || stream.r_frame_rate || "30/1";
    const fps = parseRate(rate);
    return {
      duration: Number(data.format?.duration ?? 0),
      width: stream.width ?? 0,
      height: stream.height ?? 0,
      fps,
    };
  }

  // Fallback: parse ffmpeg -i stderr
  const r = spawnSync(bin, ["-i", input], { encoding: "utf8" });
  const text = `${r.stderr}\n${r.stdout}`;
  const dim = text.match(/(\d{2,5})x(\d{2,5})/);
  const fpsM = text.match(/(\d+(?:\.\d+)?)\s*fps/);
  const durM = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!dim) throw new ToolError("BAD_INPUT", "could not probe video dimensions");
  let duration = 0;
  if (durM) {
    duration =
      Number(durM[1]) * 3600 + Number(durM[2]) * 60 + Number(durM[3]);
  }
  return {
    duration,
    width: Number(dim[1]),
    height: Number(dim[2]),
    fps: fpsM ? Number(fpsM[1]) : 30,
  };
}

function parseRate(rate: string): number {
  if (rate.includes("/")) {
    const [a, b] = rate.split("/").map(Number);
    if (!b) return 30;
    return a / b;
  }
  return Number(rate) || 30;
}

export function takeFpsFromSource(fps: number): number {
  const rounded = Math.round(fps);
  if (rounded >= 24 && rounded <= 60) return rounded;
  return 30;
}

export function evenDim(n: number): number {
  const i = Math.floor(n);
  return i % 2 === 0 ? i : i - 1;
}

export function ingestTranscode(
  input: string,
  output: string,
  takeFps: number,
  ffmpegBin?: string,
): void {
  const bin = ffmpegBin ?? requireFfmpeg();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const r = spawnSync(
    bin,
    [
      "-y",
      "-i",
      input,
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "fast",
      "-crf",
      "18",
      "-r",
      String(takeFps),
      "-vsync",
      "cfr",
      "-movflags",
      "+faststart",
      "-vf",
      "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      output,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new ToolError(
      "RENDER_FAILED",
      `ffmpeg ingest failed: ${r.stderr?.slice(-500) || "unknown"}`,
    );
  }
}

export function extractFramePng(
  videoPath: string,
  tSrc: number,
  outPng: string,
  ffmpegBin?: string,
): void {
  const bin = ffmpegBin ?? requireFfmpeg();
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  const r = spawnSync(
    bin,
    [
      "-y",
      "-ss",
      tSrc.toFixed(3),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      outPng,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new ToolError(
      "RENDER_FAILED",
      `ffmpeg frame extract failed: ${r.stderr?.slice(-400) || "unknown"}`,
    );
  }
}

export function encodeFramesToMp4(
  framePattern: string,
  fps: number,
  outMp4: string,
  ffmpegBin?: string,
): void {
  const bin = ffmpegBin ?? requireFfmpeg();
  fs.mkdirSync(path.dirname(outMp4), { recursive: true });
  const r = spawnSync(
    bin,
    [
      "-y",
      "-framerate",
      String(fps),
      "-i",
      framePattern,
      "-an",
      "-c:v",
      "libx264",
      "-crf",
      "18",
      "-preset",
      "medium",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(fps),
      "-vsync",
      "cfr",
      "-movflags",
      "+faststart",
      outMp4,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new ToolError(
      "RENDER_FAILED",
      `ffmpeg encode failed: ${r.stderr?.slice(-500) || "unknown"}`,
    );
  }
}
