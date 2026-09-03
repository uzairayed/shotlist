import type { Page } from "playwright";
import { isKnownEase, type EaseName } from "./camera.js";
import { ToolError } from "./errors.js";
import { sourcePoint } from "./page-sampler.js";
import {
  nowT,
  requirePageRecording,
  sampleBoxes,
  writePointerMove,
  type PageRecording,
} from "./page-session.js";
import { easedPointerSamples, restPointerSamples } from "./pointer-path.js";
import { DEFAULT_PROJECT } from "./types.js";

function recordingT(startedAtMs: number): number {
  return (Date.now() - startedAtMs) / 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveEase(name: string | undefined): EaseName {
  const easeName = name ?? "ease-out";
  if (!isKnownEase(easeName)) {
    throw new ToolError("BAD_INPUT", `unknown ease: ${easeName}`);
  }
  return easeName;
}

async function waitForDriveSelector(page: Page, selector: string): Promise<void> {
  try {
    await page.waitForSelector(selector, { timeout: 5000 });
  } catch {
    throw new ToolError("ELEMENT_NOT_FOUND", `element not found: ${selector}`);
  }
}

async function cssCenterOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  await waitForDriveSelector(page, selector);
  const box = await page.locator(selector).boundingBox();
  if (!box) {
    throw new ToolError("ELEMENT_NOT_FOUND", `element not found: ${selector}`);
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function resolveMoveTo(
  to: string | { x: number; y: number },
): to is { x: number; y: number } {
  return typeof to !== "string";
}

async function playPointerSamples(
  rec: PageRecording,
  samples: { t: number; x: number; y: number }[],
  t0: number,
): Promise<void> {
  rec.scriptedPointer = true;
  try {
    const startMs = Date.now();
    for (const sample of samples) {
      const wait = (sample.t - t0) * 1000 - (Date.now() - startMs);
      if (wait > 1) await sleep(wait);
      await rec.page.mouse.move(sample.x, sample.y);
      writePointerMove(rec, sample.x, sample.y, nowT(rec));
    }
  } finally {
    rec.scriptedPointer = false;
  }
}

async function travelPointer(
  rec: PageRecording,
  toCss: { x: number; y: number },
  duration: number,
  easeName: EaseName,
): Promise<void> {
  const from = rec.lastPointerCss ?? { x: 0, y: 0 };
  const t0 = nowT(rec);
  await playPointerSamples(
    rec,
    easedPointerSamples({ from, to: toCss, t0, duration, easeName }),
    t0,
  );
}

async function dwellPointer(
  rec: PageRecording,
  at: { x: number; y: number },
  dwellMs: number,
): Promise<void> {
  if (dwellMs <= 0) return;
  const t0 = nowT(rec);
  await playPointerSamples(
    rec,
    restPointerSamples({ at, t0, duration: dwellMs / 1000 }),
    t0,
  );
}

export async function takeGoto(
  args: { url: string },
  _root?: string,
): Promise<{ ok: true; url: string; t: number }> {
  const rec = requirePageRecording();
  await rec.page.goto(args.url, { waitUntil: "domcontentloaded" });
  return {
    ok: true,
    url: rec.page.url(),
    t: recordingT(rec.startedAtMs),
  };
}

export async function takeMove(
  args: {
    to: string | { x: number; y: number };
    duration?: number;
    ease?: string;
  },
  _root?: string,
): Promise<{ ok: true; t: number; x: number; y: number }> {
  const rec = requirePageRecording();
  const duration = args.duration ?? DEFAULT_PROJECT.defaults.cursor.travel;
  const easeName = resolveEase(args.ease);
  const toCss = resolveMoveTo(args.to)
    ? args.to
    : await cssCenterOf(rec.page, args.to);
  await travelPointer(rec, toCss, duration, easeName);
  const pt = sourcePoint(toCss.x, toCss.y, rec.dpr);
  return {
    ok: true,
    t: recordingT(rec.startedAtMs),
    x: pt.x,
    y: pt.y,
  };
}

export async function takeClick(
  args: {
    selector: string;
    duration?: number;
    ease?: string;
    dwell_ms?: number;
  },
  _root?: string,
): Promise<{ ok: true; selector: string; t: number; x: number; y: number }> {
  const rec = requirePageRecording();
  const toCss = await cssCenterOf(rec.page, args.selector);
  const duration = args.duration ?? DEFAULT_PROJECT.defaults.cursor.travel;
  const easeName = resolveEase(args.ease);
  const dwellMs = args.dwell_ms ?? DEFAULT_PROJECT.defaults.cursor.dwell_ms;
  await travelPointer(rec, toCss, duration, easeName);
  await rec.page.mouse.click(toCss.x, toCss.y);
  await dwellPointer(rec, toCss, dwellMs);
  await sampleBoxes("click");
  const pt = sourcePoint(toCss.x, toCss.y, rec.dpr);
  return {
    ok: true,
    selector: args.selector,
    t: recordingT(rec.startedAtMs),
    x: pt.x,
    y: pt.y,
  };
}

export async function takeType(
  args: { selector: string; text: string; delay?: number },
  _root?: string,
): Promise<{ ok: true; selector: string; t: number }> {
  const rec = requirePageRecording();
  await waitForDriveSelector(rec.page, args.selector);
  await rec.page.click(args.selector);
  await rec.page.keyboard.type(args.text, { delay: args.delay ?? 0 });
  return {
    ok: true,
    selector: args.selector,
    t: recordingT(rec.startedAtMs),
  };
}
