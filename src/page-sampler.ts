import fs from "node:fs";
import { ToolError } from "./errors.js";

export const BOX_SAMPLE_INTERVAL_MS = 500;

export interface CssRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function cssPixelsToSource(rect: CssRect, dpr: number): CssRect {
  return {
    x: rect.x * dpr,
    y: rect.y * dpr,
    w: rect.w * dpr,
    h: rect.h * dpr,
  };
}

export function sourcePoint(
  cssX: number,
  cssY: number,
  dpr: number,
): { x: number; y: number } {
  return { x: cssX * dpr, y: cssY * dpr };
}

export type SampleReason = "interval" | "click" | "nav";

export function shouldSampleBoxes(
  lastSampleT: number | null,
  nowT: number,
  reason: SampleReason,
): boolean {
  if (reason === "click" || reason === "nav") {
    return true;
  }
  if (lastSampleT === null) {
    return true;
  }
  return (nowT - lastSampleT) * 1000 >= BOX_SAMPLE_INTERVAL_MS;
}

export interface SelectorBits {
  id?: string;
  dataShotlist?: string;
  tag: string;
  nthOfType: number;
  parentSelector?: string;
}

export function preferredSelector(bits: SelectorBits): string {
  if (bits.dataShotlist !== undefined) {
    return `[data-shotlist="${bits.dataShotlist}"]`;
  }
  if (bits.id !== undefined) {
    return `#${bits.id}`;
  }
  const selector = `${bits.tag}:nth-of-type(${bits.nthOfType})`;
  if (bits.parentSelector !== undefined) {
    return `${bits.parentSelector} > ${selector}`;
  }
  return selector;
}

export const SCREENCAST_CATCHUP_MAX_SECONDS = 5;

export function planScreencastCatchUp(
  framesWritten: number,
  upTo: number,
  fps: number,
): number {
  if (upTo <= framesWritten) return framesWritten;
  const cap = fps * SCREENCAST_CATCHUP_MAX_SECONDS;
  if (upTo - framesWritten > cap) {
    throw new ToolError(
      "CAPTURE_FAILED",
      `screencast fell behind by ${upTo - framesWritten} frames (cap ${cap})`,
    );
  }
  return upTo;
}

export function appendJsonl(filePath: string, obj: unknown): void {
  fs.appendFileSync(filePath, JSON.stringify(obj) + "\n");
}
