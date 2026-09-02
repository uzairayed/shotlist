import type { Page } from "playwright";
import { ToolError } from "./errors.js";
import { sourcePoint } from "./page-sampler.js";
import { requirePageRecording, sampleBoxes } from "./page-session.js";

function recordingT(startedAtMs: number): number {
  return (Date.now() - startedAtMs) / 1000;
}

async function waitForDriveSelector(page: Page, selector: string): Promise<void> {
  try {
    await page.waitForSelector(selector, { timeout: 5000 });
  } catch {
    throw new ToolError("ELEMENT_NOT_FOUND", `element not found: ${selector}`);
  }
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

export async function takeClick(
  args: { selector: string },
  _root?: string,
): Promise<{ ok: true; selector: string; t: number; x: number; y: number }> {
  const rec = requirePageRecording();
  await waitForDriveSelector(rec.page, args.selector);
  const box = await rec.page.locator(args.selector).boundingBox();
  if (!box) {
    throw new ToolError("ELEMENT_NOT_FOUND", `element not found: ${args.selector}`);
  }
  const pt = sourcePoint(box.x + box.width / 2, box.y + box.height / 2, rec.dpr);
  await rec.page.click(args.selector);
  await sampleBoxes("click");
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
