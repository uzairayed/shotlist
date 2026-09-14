export interface OutputDefaults {
  width: number;
  height: number;
  fps: number;
}

export interface CameraDefaults {
  duration: number;
  ease: string;
  padding: number;
  zoom_min: number;
  zoom_max: number;
}

export interface CursorDefaults {
  visible: boolean;
  travel: number;
  dwell_ms: number;
  size: number;
}

export interface TransitionIn {
  type: "cut" | "crossfade";
  duration?: number;
}

export interface ProjectDefaults {
  output: OutputDefaults;
  camera: CameraDefaults;
  cursor: CursorDefaults;
  freeze_ms: number;
  transition_in: TransitionIn;
}

export interface ProjectJson {
  id: string;
  version: number;
  defaults: ProjectDefaults;
}

export interface PlanPage {
  url: string;
  promise: string;
  cta?: string;
  notes?: string;
}

export interface PlanBeat {
  id: string;
  name: string;
  url?: string;
  action?: string;
  why: string;
  hold?: string;
  camera: string;
  skip_if?: string | null;
}

export interface PlanJson {
  version: number;
  product: string;
  url: string;
  audience?: string;
  language?: string;
  target_seconds?: number;
  story?: string;
  pages?: PlanPage[];
  magic?: string;
  skip?: string[];
  beats: PlanBeat[];
}

export interface TakeMeta {
  take_id: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  dpr: number;
  /** Seconds to add to event/box times to align with video source time. */
  event_offset?: number;
  has_events: boolean;
  has_boxes: boolean;
  created_at: string;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ElementBox {
  selector: string;
  role?: string;
  name?: string;
  rect: Rect;
}

export interface BoxesSnapshot {
  t: number;
  elements: ElementBox[];
}

export type CameraPoseInput =
  | { cx: number; cy: number; zoom: number }
  | { x: number; y: number; zoom: number }
  | { target: string | Rect; padding?: number; zoom?: number };

export interface CameraSpec {
  from?: CameraPoseInput | string;
  to?: CameraPoseInput | string;
  duration?: number;
  ease?: string;
}

export type CursorPosInput =
  | { x: number; y: number }
  | { cx: number; cy: number }
  | { target: string | Rect }
  | "previous";

export interface CursorSpec {
  visible?: boolean;
  from?: CursorPosInput;
  to?: CursorPosInput;
  travel?: number;
  dwell_ms?: number;
  click_at?: number;
  size?: number;
}

export interface ShotSrc {
  in: number;
  out: number;
}

export type ShotType = "take" | "card";

export interface Shot {
  id: string;
  /** Default `"take"`. `"card"` is a title/interstitial with no source video. */
  type?: ShotType;
  beat?: string;
  /** Required for take shots. */
  take?: string;
  /** Required for take shots. */
  src?: ShotSrc;
  /** Card title text (required when type is `"card"`). */
  text?: string;
  /** Optional card subtitle. */
  subtitle?: string;
  /** Card on-screen duration in seconds (required when type is `"card"`). */
  duration?: number;
  /** Card fade-in and fade-out length in seconds (default 0.25). */
  fade?: number;
  /** Plan page URL this card introduces or closes (validated against plan.pages). */
  page?: string;
  camera?: CameraSpec;
  cursor?: CursorSpec;
  freeze_ms?: number;
  transition_in?: TransitionIn;
}

export function isCardShot(shot: Shot): boolean {
  return shot.type === "card";
}

export function isTakeShot(shot: Shot): boolean {
  return !isCardShot(shot);
}

export const DEFAULT_CARD_FADE = 0.25;
/** Default pointer rest before the first scripted move (CSS px, top-leftish). */
export const DEFAULT_POINTER_CSS = { x: 120, y: 160 };
/** Default per-key delay for take_type (readable pace). */
export const DEFAULT_TYPE_DELAY_MS = 55;
/** Soft tolerance when comparing edit length to plan.target_seconds. */
export const TARGET_SECONDS_TOLERANCE = 0.2;

export interface Callout {
  id: string;
  take: string;
  src_in: number;
  src_out: number;
  target: string | Rect;
  label?: string;
  style: "highlight" | "outline" | "label";
}

export interface ShotlistJson {
  version: number;
  output?: OutputDefaults;
  shots: Shot[];
  callouts?: Callout[];
}

export interface ResolvedCamera {
  cx: number;
  cy: number;
  zoom: number;
  crop: Rect;
}

export const DEFAULT_PROJECT: ProjectJson = {
  id: "default",
  version: 1,
  defaults: {
    output: { width: 1920, height: 1080, fps: 30 },
    camera: {
      duration: 0.8,
      ease: "ease-out",
      padding: 64,
      zoom_min: 1,
      zoom_max: 4,
    },
    cursor: { visible: true, travel: 0.4, dwell_ms: 180, size: 28 },
    freeze_ms: 500,
    transition_in: { type: "cut" },
  },
};
