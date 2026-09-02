import { ease } from "./camera.js";
import { findElementAtTime } from "./boxes.js";
import { cursorFromEvents, loadEvents } from "./events.js";
import type {
  CursorPosInput,
  ProjectDefaults,
  Shot,
  TakeMeta,
} from "./types.js";

export interface CursorOverlay {
  x: number;
  y: number;
  scale: number;
  visible: boolean;
  warning?: string;
}

function resolvePos(
  input: CursorPosInput | undefined,
  shot: Shot,
  tSrc: number,
  take: TakeMeta,
  previous: { x: number; y: number } | null,
  root?: string,
): { x: number; y: number } | null {
  if (input == null) return null;
  if (input === "previous") {
    return previous ?? { x: take.width / 2, y: take.height / 2 };
  }
  if ("x" in input && "y" in input) {
    return { x: input.x * take.width, y: input.y * take.height };
  }
  if ("cx" in input && "cy" in input) {
    return { x: input.cx, y: input.cy };
  }
  if ("target" in input) {
    if (typeof input.target === "string") {
      const el = findElementAtTime(shot.take, input.target, tSrc, root);
      if (!el) return null;
      return {
        x: el.rect.x + el.rect.w / 2,
        y: el.rect.y + el.rect.h / 2,
      };
    }
    return {
      x: input.target.x + input.target.w / 2,
      y: input.target.y + input.target.h / 2,
    };
  }
  return null;
}

export function cursorOverlayForShot(opts: {
  shot: Shot;
  tLocal: number;
  tSrc: number;
  take: TakeMeta;
  defaults: ProjectDefaults;
  previousCursor?: { x: number; y: number } | null;
  root?: string;
}): CursorOverlay | null {
  const { shot, tLocal, tSrc, take, defaults, root } = opts;
  const cursor = shot.cursor;
  const visibleDefault = defaults.cursor.visible;
  const visible = cursor?.visible ?? visibleDefault;
  if (!visible) {
    return { x: 0, y: 0, scale: 1, visible: false };
  }

  const hasAuthored =
    cursor != null && (cursor.from != null || cursor.to != null);

  if (hasAuthored) {
    const travel = cursor!.travel ?? defaults.cursor.travel;
    const dwell_ms = cursor!.dwell_ms ?? defaults.cursor.dwell_ms;
    const from = resolvePos(
      cursor!.from,
      shot,
      shot.src.in,
      take,
      opts.previousCursor ?? null,
      root,
    );
    const to = resolvePos(
      cursor!.to,
      shot,
      // to target looked up near end of travel
      shot.src.in + travel,
      take,
      opts.previousCursor ?? null,
      root,
    );
    if (!from || !to) {
      return {
        x: take.width / 2,
        y: take.height / 2,
        scale: 1,
        visible: false,
        warning: "NO_CURSOR_PATH",
      };
    }

    let uRaw = travel <= 0 ? 1 : Math.min(1, Math.max(0, tLocal / travel));
    const u = ease("ease-out", uRaw);
    const x = from.x + (to.x - from.x) * u;
    const y = from.y + (to.y - from.y) * u;

    // click press: 80ms scale 1 -> 0.85 -> 1 at click_at (source time)
    const clickAt =
      cursor!.click_at ?? shot.src.in + travel + dwell_ms / 1000;
    let scale = 1;
    const press = 0.08;
    if (tSrc >= clickAt && tSrc <= clickAt + press) {
      const p = (tSrc - clickAt) / press;
      scale = p < 0.5 ? 1 - 0.15 * (p * 2) : 0.85 + 0.15 * ((p - 0.5) * 2);
    }

    return { x, y, scale, visible: true };
  }

  // Event path
  const events = loadEvents(shot.take, root);
  const pos = cursorFromEvents(events, tSrc);
  if (!pos) {
    if (cursor?.visible === true || (cursor == null && visibleDefault)) {
      // visible true but no path
      if (cursor != null && cursor.from == null && cursor.to == null) {
        return {
          x: 0,
          y: 0,
          scale: 1,
          visible: false,
          warning: "NO_CURSOR_PATH",
        };
      }
      // no cursor object and no events: hide with warning
      return {
        x: 0,
        y: 0,
        scale: 1,
        visible: false,
        warning: events.length === 0 ? "NO_CURSOR_PATH" : undefined,
      };
    }
    return { x: 0, y: 0, scale: 1, visible: false };
  }
  return { x: pos.x, y: pos.y, scale: 1, visible: true };
}
