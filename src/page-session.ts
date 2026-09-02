import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { busy } from "./busy.js";
import { ToolError } from "./errors.js";
import {
  appendJsonl,
  BOX_SAMPLE_INTERVAL_MS,
  cssPixelsToSource,
  preferredSelector,
  shouldSampleBoxes,
  sourcePoint,
  type SampleReason,
  type SelectorBits,
} from "./page-sampler.js";
import { ensureProject } from "./project.js";
import { ingestTake, newTakeId, takeDir, type IngestResult } from "./takes.js";

export const POINTER_MOVE_THROTTLE_MS = 50;

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
const CURSOR_HIDE_CSS = "* { cursor: none !important; }";

export interface PageTakeArgs {
  url?: string;
  cdp_url?: string;
  viewport?: { width: number; height: number };
  fps?: number;
  dpr?: number;
}

export interface PageRecording {
  takeId: string;
  dir: string;
  page: Page;
  browser: Browser;
  context: BrowserContext;
  dpr: number;
  fps: number;
  startedAtMs: number;
  eventsPath: string;
  boxesPath: string;
  lastBoxSampleT: number | null;
  lastPointerMoveAt: number | null;
}

interface RawCollected {
  id?: string;
  dataShotlist?: string;
  tag: string;
  nthOfType: number;
  role?: string;
  name?: string;
  rect: { x: number; y: number; w: number; h: number };
}

interface PagePushEvent {
  type: string;
  x?: number;
  y?: number;
  button?: number;
  key?: string;
  bits?: SelectorBits;
}

let current: PageRecording | null = null;
let boxTimer: ReturnType<typeof setInterval> | null = null;
let acceptNavEvents = false;

export function isPageRecording(): boolean {
  return current !== null;
}

export function requirePageRecording(): PageRecording {
  if (current) return current;
  if (busy.isRecording()) {
    throw new ToolError("BAD_INPUT", "current take is not a page take");
  }
  throw new ToolError("BAD_INPUT", "nothing is recording");
}

function nowT(rec: PageRecording): number {
  return (Date.now() - rec.startedAtMs) / 1000;
}

function collectElementsInPage(): RawCollected[] {
  const skip = new Set(["html", "body", "script", "style", "meta", "link"]);
  const nodes = document.querySelectorAll(
    "a, button, input, textarea, select, [role], [data-shotlist], [id]",
  );
  const out: RawCollected[] = [];
  for (const el of nodes) {
    const tag = el.tagName.toLowerCase();
    if (skip.has(tag)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    let nthOfType = 1;
    let sib = el.previousElementSibling;
    while (sib) {
      if (sib.tagName === el.tagName) nthOfType += 1;
      sib = sib.previousElementSibling;
    }
    const id = el.getAttribute("id") ?? undefined;
    const dataShotlist = el.getAttribute("data-shotlist") ?? undefined;
    const roleAttr = el.getAttribute("role");
    let role = roleAttr ?? undefined;
    if (!role) {
      if (tag === "button") role = "button";
      else if (tag === "a") role = "link";
      else if (tag === "input") {
        const type = (el as HTMLInputElement).type;
        role = type === "submit" || type === "button" ? "button" : "textbox";
      }
    }
    const aria = el.getAttribute("aria-label");
    const placeholder = el.getAttribute("placeholder");
    const text = (el.textContent ?? "").trim();
    const title = el.getAttribute("title");
    const value =
      "value" in el ? String((el as HTMLInputElement).value ?? "") : "";
    const name =
      aria ||
      placeholder ||
      (text ? text.slice(0, 80) : "") ||
      title ||
      value ||
      undefined;
    out.push({
      id,
      dataShotlist,
      tag,
      nthOfType,
      role,
      name,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    });
  }
  return out;
}

// String source so Playwright addInitScript does not stringify a compiled
// function that closes over esbuild's __name helper (missing in the page).
const INSTALL_PAGE_HOOKS_SOURCE = `(() => {
  const injectCursorHide = () => {
    if (document.querySelector("[data-shotlist-cursor-hide]")) return;
    const style = document.createElement("style");
    style.setAttribute("data-shotlist-cursor-hide", "");
    style.textContent = "* { cursor: none !important; }";
    const parent = document.head || document.documentElement;
    if (!parent) return;
    parent.appendChild(style);
  };
  injectCursorHide();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectCursorHide);
  }
  const w = window;
  if (w.__shotlistBound) return;
  w.__shotlistBound = true;
  const selectorBits = (el) => {
    if (!(el instanceof Element)) {
      return { tag: "div", nthOfType: 1 };
    }
    const tag = el.tagName.toLowerCase();
    let nthOfType = 1;
    let sib = el.previousElementSibling;
    while (sib) {
      if (sib.tagName === el.tagName) nthOfType += 1;
      sib = sib.previousElementSibling;
    }
    const bits = { tag, nthOfType };
    const id = el.getAttribute("id");
    if (id) bits.id = id;
    const dataShotlist = el.getAttribute("data-shotlist");
    if (dataShotlist !== null) bits.dataShotlist = dataShotlist;
    return bits;
  };
  document.addEventListener(
    "pointermove",
    (e) => {
      void w.shotlistPushEvent?.({
        type: "pointer_move",
        x: e.clientX,
        y: e.clientY,
      });
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    (e) => {
      void w.shotlistPushEvent?.({
        type: "pointer_down",
        button: e.button,
        x: e.clientX,
        y: e.clientY,
      });
    },
    true,
  );
  document.addEventListener(
    "pointerup",
    (e) => {
      void w.shotlistPushEvent?.({
        type: "pointer_up",
        button: e.button,
        x: e.clientX,
        y: e.clientY,
      });
    },
    true,
  );
  document.addEventListener(
    "click",
    (e) => {
      void w.shotlistPushEvent?.({
        type: "click",
        x: e.clientX,
        y: e.clientY,
        bits: selectorBits(e.target),
      });
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (e) => {
      void w.shotlistPushEvent?.({ type: "keydown", key: e.key });
    },
    true,
  );
})();`;

async function onPageEvent(ev: PagePushEvent): Promise<void> {
  const rec = current;
  if (!rec) return;
  const t = nowT(rec);
  if (ev.type === "pointer_move") {
    const now = Date.now();
    if (
      rec.lastPointerMoveAt !== null &&
      now - rec.lastPointerMoveAt < POINTER_MOVE_THROTTLE_MS
    ) {
      return;
    }
    rec.lastPointerMoveAt = now;
    const pt = sourcePoint(ev.x ?? 0, ev.y ?? 0, rec.dpr);
    appendJsonl(rec.eventsPath, { t, type: "pointer_move", x: pt.x, y: pt.y });
    return;
  }
  if (ev.type === "pointer_down" || ev.type === "pointer_up") {
    const pt = sourcePoint(ev.x ?? 0, ev.y ?? 0, rec.dpr);
    appendJsonl(rec.eventsPath, {
      t,
      type: ev.type,
      button: ev.button ?? 0,
      x: pt.x,
      y: pt.y,
    });
    return;
  }
  if (ev.type === "click") {
    const pt = sourcePoint(ev.x ?? 0, ev.y ?? 0, rec.dpr);
    const selector = preferredSelector(
      ev.bits ?? { tag: "div", nthOfType: 1 },
    );
    appendJsonl(rec.eventsPath, {
      t,
      type: "click",
      x: pt.x,
      y: pt.y,
      selector,
    });
    await sampleBoxes("click");
    return;
  }
  if (ev.type === "keydown") {
    appendJsonl(rec.eventsPath, { t, type: "keydown", key: ev.key ?? "" });
  }
}

export async function sampleBoxes(reason: SampleReason): Promise<void> {
  const rec = current;
  if (!rec) return;
  const t = nowT(rec);
  if (!shouldSampleBoxes(rec.lastBoxSampleT, t, reason)) return;
  const isFirstSample = rec.lastBoxSampleT === null;
  try {
    const raw = await rec.page.evaluate(collectElementsInPage);
    const elements = raw.map((el) => ({
      selector: preferredSelector({
        id: el.id,
        dataShotlist: el.dataShotlist,
        tag: el.tag,
        nthOfType: el.nthOfType,
      }),
      role: el.role,
      name: el.name,
      rect: cssPixelsToSource(el.rect, rec.dpr),
    }));
    appendJsonl(rec.boxesPath, { t, elements });
    rec.lastBoxSampleT = t;
  } catch (err) {
    if (isFirstSample) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ToolError(
        "CAPTURE_FAILED",
        `failed to sample page boxes: ${message}`,
      );
    }
  }
}

async function closeBrowserQuietly(rec: {
  page?: Page;
  context?: BrowserContext;
  browser?: Browser;
}): Promise<void> {
  if (rec.page) {
    try {
      await rec.page.close();
    } catch {
      /* already closed */
    }
  }
  if (rec.context) {
    try {
      await rec.context.close();
    } catch {
      /* already closed */
    }
  }
  if (rec.browser) {
    try {
      await rec.browser.close();
    } catch {
      /* already closed */
    }
  }
}

export async function resetCaptureForTests(): Promise<void> {
  if (boxTimer) {
    clearInterval(boxTimer);
    boxTimer = null;
  }
  acceptNavEvents = false;
  const rec = current;
  current = null;
  if (rec) {
    await closeBrowserQuietly(rec);
  }
  if (busy.isRecording()) busy.endRecord();
  if (busy.isRendering()) busy.endRender();
}

export async function startPageTake(
  args: PageTakeArgs,
  root?: string,
): Promise<{ ok: true; take_id: string; status: "recording" }> {
  ensureProject(root);
  if (args.cdp_url) {
    throw new ToolError(
      "NOT_IMPLEMENTED",
      "cdp_url attach lands in a later task",
    );
  }
  if (!args.url) {
    throw new ToolError(
      "BAD_INPUT",
      "start_take requires url or cdp_url",
    );
  }

  busy.beginRecord();
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  try {
    const takeId = newTakeId();
    const dir = takeDir(takeId, root);
    fs.mkdirSync(dir, { recursive: true });
    const eventsPath = path.join(dir, "events.jsonl");
    const boxesPath = path.join(dir, "boxes.jsonl");
    fs.writeFileSync(eventsPath, "");
    fs.writeFileSync(boxesPath, "");

    const viewport = args.viewport ?? DEFAULT_VIEWPORT;
    const dpr = args.dpr ?? 1;
    const fps = args.fps ?? 30;

    browser = await chromium.launch({ args: ["--disable-dev-shm-usage"] });
    context = await browser.newContext({
      viewport,
      deviceScaleFactor: dpr,
      recordVideo: { dir, size: viewport },
    });
    await context.addInitScript({ content: INSTALL_PAGE_HOOKS_SOURCE });
    page = await context.newPage();
    await page.addStyleTag({ content: CURSOR_HIDE_CSS });
    await page.exposeFunction("shotlistPushEvent", onPageEvent);
    await page.addInitScript({ content: INSTALL_PAGE_HOOKS_SOURCE });

    const startedAtMs = Date.now();
    current = {
      takeId,
      dir,
      page,
      browser,
      context,
      dpr,
      fps,
      startedAtMs,
      eventsPath,
      boxesPath,
      lastBoxSampleT: null,
      lastPointerMoveAt: null,
    };
    acceptNavEvents = false;
    page.on("framenavigated", (frame) => {
      const rec = current;
      if (!rec) return;
      if (frame !== rec.page.mainFrame()) return;
      void rec.page.addStyleTag({ content: CURSOR_HIDE_CSS }).catch(() => {
        /* page may be closing */
      });
      if (!acceptNavEvents) return;
      appendJsonl(rec.eventsPath, {
        t: nowT(rec),
        type: "nav",
        url: rec.page.url(),
      });
      void sampleBoxes("nav");
    });

    await page.goto(args.url, { waitUntil: "domcontentloaded" });
    await page.addStyleTag({ content: CURSOR_HIDE_CSS });
    appendJsonl(current.eventsPath, {
      t: nowT(current),
      type: "nav",
      url: page.url(),
    });
    await sampleBoxes("nav");
    acceptNavEvents = true;
    boxTimer = setInterval(() => {
      void sampleBoxes("interval");
    }, BOX_SAMPLE_INTERVAL_MS);

    return { ok: true, take_id: takeId, status: "recording" };
  } catch (err) {
    if (boxTimer) {
      clearInterval(boxTimer);
      boxTimer = null;
    }
    current = null;
    acceptNavEvents = false;
    await closeBrowserQuietly({ page, context, browser });
    busy.endRecord();
    throw err;
  }
}

export async function stopPageTake(root?: string): Promise<IngestResult> {
  if (!current) {
    throw new ToolError("BAD_INPUT", "nothing is recording");
  }
  const rec = current;
  if (boxTimer) {
    clearInterval(boxTimer);
    boxTimer = null;
  }
  acceptNavEvents = false;
  const video = rec.page.video();
  try {
    await rec.page.close();
    await rec.context.close();
    await rec.browser.close();
    const videoPath = video ? await video.path() : "";
    return ingestTake(
      {
        video_path: videoPath,
        events_path: rec.eventsPath,
        boxes_path: rec.boxesPath,
        take_id: rec.takeId,
        dpr: rec.dpr,
      },
      root,
    );
  } finally {
    current = null;
    if (busy.isRecording()) busy.endRecord();
    await closeBrowserQuietly(rec);
  }
}
