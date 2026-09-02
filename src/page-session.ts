import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Frame,
  type Page,
} from "playwright";
import { busy } from "./busy.js";
import { ToolError } from "./errors.js";
import { requireFfmpeg } from "./ffmpeg.js";
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
const FIRST_SCREENCAST_FRAME_TIMEOUT_MS = 10_000;

export interface PageTakeArgs {
  url?: string;
  cdp_url?: string;
  viewport?: { width: number; height: number };
  fps?: number;
  dpr?: number;
}

export interface ScreencastPipe {
  outPath: string;
  stop(): Promise<{ exitCode: number | null; stderr: string }>;
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
  /** False when we attached over CDP: never close or kill that browser. */
  launchedByUs: boolean;
  cdpSession?: CDPSession;
  screencast?: ScreencastPipe;
  navHandler?: (frame: Frame) => void;
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
// `__shotlistBound` is the current take's binding name so a later attach
// re-hooks instead of keeping the previous take's dead function.
export function installPageHooksSource(
  bindingName = "shotlistPushEvent",
): string {
  const nameLit = JSON.stringify(bindingName);
  return `(() => {
  const bindingName = ${nameLit};
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
  if (w.__shotlistBound === bindingName) return;
  w.__shotlistBound = bindingName;
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
  const push = (ev) => {
    const fn = w[bindingName];
    if (typeof fn === "function") void fn(ev);
  };
  document.addEventListener(
    "pointermove",
    (e) => {
      push({
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
      push({
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
      push({
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
      push({
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
      push({ type: "keydown", key: e.key });
    },
    true,
  );
})();`;
}

export const INSTALL_PAGE_HOOKS_SOURCE = installPageHooksSource();

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

/**
 * Release everything we own. An attached browser belongs to the user: we stop
 * the screencast, detach our CDP session, and disconnect the Playwright
 * websocket, but never close the user's page or kill Chrome.
 */
async function releaseRecording(rec: {
  page?: Page;
  context?: BrowserContext;
  browser?: Browser;
  launchedByUs?: boolean;
  cdpSession?: CDPSession;
  screencast?: ScreencastPipe;
  navHandler?: (frame: Frame) => void;
}): Promise<void> {
  if (rec.screencast) {
    try {
      await rec.screencast.stop();
    } catch {
      /* already stopped */
    }
  }
  if (rec.cdpSession) {
    try {
      await rec.cdpSession.detach();
    } catch {
      /* session already gone */
    }
  }
  if (rec.launchedByUs === false) {
    if (rec.page && rec.navHandler) {
      try {
        rec.page.off("framenavigated", rec.navHandler);
      } catch {
        /* page already gone */
      }
    }
    // Disconnect our CDP websocket only. Do not close the user's page or
    // context; browser.close() on connectOverCDP drops the connection
    // without killing Chrome.
    if (rec.browser) {
      try {
        await rec.browser.close();
      } catch {
        /* connection already gone */
      }
    }
    return;
  }
  await closeBrowserQuietly(rec);
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
    await releaseRecording(rec);
  }
  if (busy.isRecording()) busy.endRecord();
  if (busy.isRendering()) busy.endRender();
}

/** Width/height from a baseline or progressive JPEG SOF marker. */
function jpegSize(buf: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/**
 * Pipe CDP screencast jpeg frames into ffmpeg. Frames only arrive when the
 * page repaints, so a pump repeats the newest frame to keep the mp4 timeline
 * locked to wall clock: video second N is take second N.
 */
async function startScreencastPipe(
  client: CDPSession,
  dir: string,
  fps: number,
): Promise<{
  pipe: ScreencastPipe;
  frameWidth: number;
  frameHeight: number;
  startedAtMs: number;
}> {
  const outPath = path.join(dir, "raw-capture.mp4");
  let lastFrame: Buffer | null = null;
  let resolveFirst: ((frame: Buffer) => void) | null = null;
  const firstFrame = new Promise<Buffer>((resolve) => {
    resolveFirst = resolve;
  });
  const onFrame = (frame: { data: string; sessionId: number }) => {
    lastFrame = Buffer.from(frame.data, "base64");
    if (resolveFirst) {
      const resolve = resolveFirst;
      resolveFirst = null;
      resolve(lastFrame);
    }
    void client
      .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
      .catch(() => {
        /* frame arrived after we stopped */
      });
  };
  client.on("Page.screencastFrame", onFrame);
  await client.send("Page.enable");
  await client.send("Page.startScreencast", {
    format: "jpeg",
    quality: 80,
    everyNthFrame: 1,
  });

  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let first: Buffer;
  try {
    first = await Promise.race([
      firstFrame,
      new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(
          () =>
            reject(
              new ToolError(
                "CAPTURE_FAILED",
                "attached page sent no screencast frame",
              ),
            ),
          FIRST_SCREENCAST_FRAME_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    client.off("Page.screencastFrame", onFrame);
    await client.send("Page.stopScreencast").catch(() => {
      /* never started */
    });
    throw err;
  } finally {
    clearTimeout(timeoutTimer);
  }

  const size = jpegSize(first);
  if (!size) {
    client.off("Page.screencastFrame", onFrame);
    await client.send("Page.stopScreencast").catch(() => undefined);
    throw new ToolError("CAPTURE_FAILED", "screencast frame was not a jpeg");
  }
  const frameWidth = size.width - (size.width % 2);
  const frameHeight = size.height - (size.height % 2);

  const proc = spawn(
    requireFfmpeg(),
    [
      "-y",
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "-framerate",
      String(fps),
      "-i",
      "-",
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "ultrafast",
      "-vf",
      `scale=${frameWidth}:${frameHeight}`,
      outPath,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let stderr = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });

  const startedAtMs = Date.now();
  let framesWritten = 0;
  let stopped = false;
  const writeFrames = (upTo: number): void => {
    if (!lastFrame || !proc.stdin?.writable) return;
    const capped = Math.min(upTo, framesWritten + fps * 5);
    while (framesWritten < capped) {
      proc.stdin.write(lastFrame);
      framesWritten += 1;
    }
    framesWritten = Math.max(framesWritten, upTo);
  };
  const pump = () => {
    if (stopped) return;
    writeFrames(Math.floor(((Date.now() - startedAtMs) / 1000) * fps));
  };
  const pumpTimer = setInterval(pump, Math.max(10, Math.round(1000 / fps)));

  let stopping: Promise<{ exitCode: number | null; stderr: string }> | null =
    null;
  const stop = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      clearInterval(pumpTimer);
      writeFrames(
        Math.max(
          2,
          Math.ceil(((Date.now() - startedAtMs) / 1000) * fps),
          framesWritten + 1,
        ),
      );
      stopped = true;
      client.off("Page.screencastFrame", onFrame);
      await client.send("Page.stopScreencast").catch(() => {
        /* page or session already gone */
      });
      const exitCode = await new Promise<number | null>((resolve) => {
        proc.once("error", () => resolve(null));
        proc.once("close", (code) => resolve(code));
        proc.stdin?.end();
      });
      return { exitCode, stderr };
    })();
    return stopping;
  };

  return { pipe: { outPath, stop }, frameWidth, frameHeight, startedAtMs };
}

function onFrameNavigated(frame: Frame): void {
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
}

export async function startPageTake(
  args: PageTakeArgs,
  root?: string,
): Promise<{ ok: true; take_id: string; status: "recording" }> {
  ensureProject(root);
  if (args.cdp_url) {
    return attachPageTake(args, args.cdp_url, root);
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
      launchedByUs: true,
      navHandler: onFrameNavigated,
    };
    acceptNavEvents = false;
    page.on("framenavigated", onFrameNavigated);

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

/** First page of the first context that has one; open one only if url is given. */
async function pickAttachedPage(
  browser: Browser,
  url?: string,
): Promise<{ page: Page; context: BrowserContext }> {
  for (const context of browser.contexts()) {
    const page = context.pages()[0];
    if (page) return { page, context };
  }
  if (!url) {
    throw new ToolError(
      "BAD_INPUT",
      "cdp_url has no open page; pass url to open one",
    );
  }
  const context = browser.contexts()[0] ?? (await browser.newContext());
  return { page: await context.newPage(), context };
}

function eventBindingName(takeId: string): string {
  return `shotlistPushEvent_${takeId.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

async function bindAttachedHooks(page: Page, bindingName: string): Promise<void> {
  const source = installPageHooksSource(bindingName);
  await page.exposeFunction(bindingName, onPageEvent);
  await page.addInitScript({ content: source });
  // addInitScript only fires on the next navigation, so hook the live document.
  await page.addStyleTag({ content: CURSOR_HIDE_CSS });
  await page.evaluate(source);
}

async function attachPageTake(
  args: PageTakeArgs,
  cdpUrl: string,
  root?: string,
): Promise<{ ok: true; take_id: string; status: "recording" }> {
  busy.beginRecord();
  let browser: Browser | undefined;
  let page: Page | undefined;
  let cdpSession: CDPSession | undefined;
  let screencast: ScreencastPipe | undefined;
  try {
    const takeId = newTakeId();
    const dir = takeDir(takeId, root);
    fs.mkdirSync(dir, { recursive: true });
    const eventsPath = path.join(dir, "events.jsonl");
    const boxesPath = path.join(dir, "boxes.jsonl");
    fs.writeFileSync(eventsPath, "");
    fs.writeFileSync(boxesPath, "");

    const fps = args.fps ?? 30;
    browser = await chromium.connectOverCDP(cdpUrl);
    const picked = await pickAttachedPage(browser, args.url);
    page = picked.page;
    const context = picked.context;
    await page.bringToFront().catch(() => {
      /* not all attached targets can be focused */
    });
    if (args.url) {
      await page.goto(args.url, { waitUntil: "domcontentloaded" });
    }
    await bindAttachedHooks(page, eventBindingName(takeId));

    cdpSession = await context.newCDPSession(page);
    const cast = await startScreencastPipe(cdpSession, dir, fps);
    screencast = cast.pipe;

    // Keep event x/y and box rects in the pixel space of the recorded mp4.
    const cssWidth = await page.evaluate(() => window.innerWidth);
    const dpr = args.dpr ?? (cssWidth > 0 ? cast.frameWidth / cssWidth : 1);

    current = {
      takeId,
      dir,
      page,
      browser,
      context,
      dpr,
      fps,
      startedAtMs: cast.startedAtMs,
      eventsPath,
      boxesPath,
      lastBoxSampleT: null,
      lastPointerMoveAt: null,
      launchedByUs: false,
      cdpSession,
      screencast,
      navHandler: onFrameNavigated,
    };
    acceptNavEvents = false;
    page.on("framenavigated", onFrameNavigated);

    appendJsonl(eventsPath, {
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
    await releaseRecording({
      page,
      launchedByUs: false,
      cdpSession,
      screencast,
      navHandler: onFrameNavigated,
    });
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
  const video = rec.launchedByUs ? rec.page.video() : null;
  try {
    let videoPath = "";
    if (rec.launchedByUs) {
      await rec.page.close();
      await rec.context.close();
      await rec.browser.close();
      videoPath = video ? await video.path() : "";
    } else {
      const cast = rec.screencast;
      if (!cast) {
        throw new ToolError("CAPTURE_FAILED", "attached take has no screencast");
      }
      const encode = await cast.stop();
      if (encode.exitCode !== 0) {
        throw new ToolError(
          "CAPTURE_FAILED",
          `screencast encode failed: ${encode.stderr.slice(-400) || "unknown"}`,
        );
      }
      videoPath = cast.outPath;
    }
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
    await releaseRecording(rec);
  }
}
