# Shotlist v1 — complete implementation spec

This issue is the contract. Implement against it. If something isn’t here, it is not required for v1.

I am Leo. I record aesthetic webapp demos. I will call this as an MCP server. You are building it elsewhere; this spec is what I need on the other end.

---

## 1. Problem

My current tools only jump: click, snap-zoom, unzoom. No easing, no cursor travel, no hold. Prompting cannot fix that.

I do not need a GUI video editor. I need:

1. Capture (or ingest) a **full-resolution take** of the flow.
2. Author a **shot list** (camera, cursor, holds, cuts) as JSON.
3. **Preview a PNG** of any frame so I can correct framing.
4. **Render an mp4**. Same take + same shot list = same bytes-worth of frames.

Live zoom during recording is out of scope as the main path. Camera is a crop over the take, animated in post.

**Do not start at capture.** The product loop is:

```
analyze app → write plan.json → capture only those beats
                                    ↓
                              shotlist.json
                                    ↓
                         preview_frame / render.mp4
```

A take without a plan is how you get a tour of random clicks. The MCP must store the plan; `set_shotlist` warns if `plan.json` is missing.

---

## 1A. Production process (required order)

Never skip 1–2. Never record the whole app “just in case.”

### Step 1 — Analyze (no video yet)

Walk the live app as a viewer, not as a developer. Write findings into `plan.json` (`product`, `audience`, `pages`, `magic`, `skip`).

For each important screen capture:

- URL
- What the screen *promises* (one sentence)
- Primary CTA (selector if known, else label + approximate region)
- What must be readable on camera (price, name, generated art, cart total…)
- Dead ends (FAQ walls, legal, cookie chrome, identical grids)

Output of this step is **understanding**, not a recording. If login is required, note it; do not invent a bypass.

### Step 2 — Plan the demo

Turn analysis into a **beat list** targeting 20–30s of finished video (about 4–8 shots). Each beat:

| Field | What it is |
|---|---|
| `id` | `b1`, `b2`, … |
| `name` | short (`land`, `pick-category`, `see-designs`) |
| `url` | exact page to be on |
| `action` | what the cursor does |
| `why` | why this beat exists in a demo (if you can’t say it, cut it) |
| `hold` | what the viewer must have time to read |
| `camera` | `wide` / `push-in` / `pan-to-result` |
| `skip_if` | optional kill condition |

Rules:

- One story. Not a feature dump.
- Open on the promise. Put the **magic moment** in the middle third. End on a result (design, cart, confirmation) — not a settings page.
- Skip anything that does not change the viewer’s mind.
- Prefer 1 take per continuous scene (same page/flow). Cut to a new take when the scene changes (home → editor, editor → checkout).

`set_plan` writes this. I will not `set_shotlist` until the plan exists.

### Step 3 — Capture

Record **only the beats**, full resolution, extra pad before/after each action (~0.5–1s of stillness). Do not zoom live. One take can cover several beats if they are one scene.

### Step 4 — Direct

Map each beat → one or more shots in `shotlist.json` (`beat` field on the shot, see schema). Camera eases; cursor travels; freeze on `hold`.

### Step 5 — Preview, then render

`preview_frame` on every landing. Fix padding/zoom. Then `render`. If a beat’s hold is unreadable, change the shot — do not recapture unless the tape is wrong.

---

## 1B. Default storyboard (any webapp)

The operator names the product and URL in `plan.json`. This spec does not bake in a particular site.

v1 is not done until **some** live webapp can run analyze → plan → ingest/capture → shots → preview → render.

**Analyze checklist (live site, before any tape):**

1. Entry URL — headline, primary CTA, what’s above the fold.
2. Core flow behind that CTA — click it; write the **real** URLs (don’t guess paths).
3. The **magic moment**: the frame that would make someone want this. How long it takes. What must stay sharp.
4. One follow-up action that proves it worked (tweak, save, export, add).
5. Result state to end on. Stop before payment, passwords, or admin.
6. Skip list: FAQ, cookie banners (dismiss before record), legal, duplicate galleries, settings.

**Default beats** (rename after analyze; drop any beat without a `why`):

| id | name | action | why | camera | hold |
|---|---|---|---|---|---|
| b1 | land | Entry URL, no click yet | Promise in one glance | wide, then slow push toward CTA | Headline + primary CTA readable |
| b2 | start | Click the primary CTA | Enter the product | follow cursor, land on next screen | First flow chrome |
| b3 | choose | Pick the thing that makes this instance specific | Personal, not generic | push-in on the choice | Choice art + label |
| b4 | magic | Wait for the distinctive result | This is the demo | wide enough to see it, then push in | Result readable, not a blur |
| b5 | tweak | Change one thing | It’s theirs / it works | pan to control, then to live preview | Before/after |
| b6 | result | End state, stop before payment/secrets | Close on “I could use this” | hold on the output | Result readable |

Target finished length: **20–30 seconds**. If a spinner is slow, freeze or cut after the result is on screen — do not watch loading.

**Always out:** FAQ tours, signup walls, address forms, payment, admin.

---

## 2. Non-goals (do not build)

- CapCut / Premiere / multitrack NLE
- Webcam, mic, music, captions, watermarks
- Driving the browser (no click/type/goto tools — I already have those)
- Auto-zoom-on-every-click as the only mode
- SaaS, accounts, cloud render
- Color grading, motion blur, spring physics (nice later, not v1)
- Typing visualization, scroll-linked camera
- A GUI I must operate (a debug GUI for you is fine)

---

## 3. Runtime

| Thing | v1 decision |
|---|---|
| OS | Linux first |
| Interface | MCP server, **stdio** only |
| Workdir | `SHOTLIST_DIR` env (default `~/.shotlist/project`) — one project per dir |
| Video | ffmpeg **required**. Error `FFMPEG_MISSING` if absent |
| Audio | strip (`-an`) |
| Language / SDK | your choice; speak MCP tool JSON as specified |
| Concurrency | one recording and one render at a time per project; second call returns `BUSY` |
| Determinism | same take + same shotlist + same ffmpeg version → same frames. CFR only. No wall-clock in the picture |

---

## 4. On-disk layout

Create this exactly:

```
$SHOTLIST_DIR/
  project.json
  plan.json                 # required before a real demo; see §1A
  takes/
    {take_id}/
      meta.json
      source.mp4          # h264 yuv420p, even W/H, constant fps
      events.jsonl        # may be empty
      boxes.jsonl         # may be empty
  shotlist.json           # current edit; missing until set_shotlist
  out/
    preview-{id}.png
    preview-{id}.mp4
    render-{id}.mp4
```

`project.json`:

```json
{
  "id": "default",
  "version": 1,
  "defaults": {
    "output": { "width": 1920, "height": 1080, "fps": 30 },
    "camera": { "duration": 0.8, "ease": "ease-out", "padding": 64, "zoom_min": 1, "zoom_max": 4 },
    "cursor": { "visible": true, "travel": 0.4, "dwell_ms": 180, "size": 28 },
    "freeze_ms": 500,
    "transition_in": { "type": "cut" }
  }
}
```

Write `project.json` on first tool call if missing, using these defaults.

`takes/{id}/meta.json`:

```json
{
  "take_id": "take_a1b2c3d4",
  "duration": 12.333,
  "width": 1440,
  "height": 900,
  "fps": 30,
  "dpr": 1,
  "has_events": true,
  "has_boxes": true,
  "created_at": "2026-09-02T16:31:00Z"
}
```

`duration` is source video duration in seconds. `width/height` are **source video pixels**.

---

## 5. Coordinate systems (do not mix)

**Source space:** pixels of `source.mp4`. Origin top-left. X right, Y down. All event coords, boxes, crop rects live here.

**Normalized center:** `x`,`y` in `0..1` = center of the frame (`0.5,0.5` is middle). Used in shot JSON for camera centers.

**Output space:** the rendered frame (`output.width` × `output.height`). Cursor `size` is in **output pixels**.

**CSS vs device pixels:** DOM boxes and pointer events from a browser are CSS pixels. Convert on ingest/capture:

```
source_px = css_px * dpr
```

Store only source pixels. Store `dpr` on the take.

**Time:** seconds, float, source or edit as noted. Internal frame index = `round(t * fps)` clamped to `[0, frame_count-1]`. Three decimal places is enough in JSON.

---

## 6. Camera model

The camera is a **crop rectangle in source space** whose aspect ratio is **always the output aspect**. It is scaled (lanczos) to `output.width × output.height`.

### Zoom

- `zoom = 1` → largest crop that fits in the source with the output aspect (widest shot).
- `zoom = 2` → crop is half that size (linear). Subject looks 2× larger.
- Clamp to `[zoom_min, zoom_max]` (defaults 1 and 4). If clamp happens, add a warning.

```
aspect = outW / outH

# max crop (zoom=1)
max_h = sourceH
max_w = sourceH * aspect
if max_w > sourceW:
    max_w = sourceW
    max_h = sourceW / aspect

crop_w = max_w / zoom
crop_h = max_h / zoom
```

### Center

Resolved camera state is always `{ cx, cy, zoom }` in source pixels (`cx,cy` = crop center).

From JSON, resolve in this order (first match wins):

1. `cx` + `cy` (pixels) + `zoom`
2. `x` + `y` (normalized 0–1) + `zoom` → `cx = x * sourceW`, `cy = y * sourceH`
3. `target` (selector string or `{x,y,w,h}` in source px) + optional `padding` (source px, default 64) + optional `zoom`
    - Look up selector in boxes at the **source time the camera pose applies** (start of interpolation for `from`, end for `to`).
    - `rect' = expand(rect, padding)` on all four sides, then clip to source.
    - Center = center of `rect'`.
    - If `zoom` omitted: smallest zoom whose crop **contains** `rect'` (still output-aspect). If `rect'` is larger than zoom-1 crop, use zoom 1.
    - If `zoom` present: use it, still center on `rect'`.

If selector is missing at that time: warning `ELEMENT_NOT_FOUND`, fall back to `{x:0.5,y:0.5,zoom:1}`. Do **not** fail the render unless the tool was called with `strict: true`.

### Clamp crop inside source

After computing crop from center+zoom, shift `cx,cy` just enough that the crop stays inside `[0,sourceW]×[0,sourceH]`. Never sample outside the video (no black bars from an overhanging crop). If zoom < 1 would be needed to cover, clamp zoom to 1.

### Interpolation

For a shot, camera goes `from` → `to` over `camera.duration` seconds of **edit time** starting at the shot’s start.

```
u_raw = clamp((t_shot) / camera.duration, 0, 1)
u = ease(u_raw)
cx = lerp(from.cx, to.cx, u)
cy = lerp(from.cy, to.cy, u)
zoom = lerp(from.zoom, to.zoom, u)   # lerp zoom, not log, v1
```

If `t_shot >= camera.duration`, hold the `to` pose.

If `camera` is omitted: `{ from: {x:0.5,y:0.5,zoom:1}, to: {x:0.5,y:0.5,zoom:1}, duration: 0, ease: "ease-out" }` (static wide).

If `from` omitted: use previous shot’s final pose if same take, else wide.

If `to` omitted: same as `from` (static).

If `camera.duration` omitted: default `0.8`, then clamp to the shot’s playing duration (not counting freeze).

If `camera.duration` > playing duration: clamp to playing duration, warning.

### Easing (exact)

```
linear:      u
ease-in:     u^2
ease-out:    1 - (1-u)^2
ease-in-out: u<0.5 ? 2u^2 : 1 - pow(-2u+2, 2)/2
```

Unknown ease → error `INVALID_SHOTLIST`. No spring in v1.

---

## 7. Shot list schema

`shotlist.json`, version 1:

```json
{
  "version": 1,
  "output": { "width": 1920, "height": 1080, "fps": 30 },
  "shots": [ { "...": "see below" } ],
  "callouts": []
}
```

`output` optional; fall back to `project.json` defaults.

### Shot (required / optional)

```json
{
  "id": "s1",
  "take": "take_a1b2c3d4",
  "src": { "in": 1.2, "out": 4.0 },
  "camera": {
    "from": { "x": 0.5, "y": 0.5, "zoom": 1.0 },
    "to": { "target": "#signup", "padding": 64 },
    "duration": 0.8,
    "ease": "ease-out"
  },
  "cursor": {
    "visible": true,
    "from": { "x": 0.2, "y": 0.5 },
    "to": { "target": "#signup" },
    "travel": 0.45,
    "dwell_ms": 180,
    "click_at": 2.1,
    "size": 28
  },
  "freeze_ms": 500,
  "transition_in": { "type": "cut" }
}
```

| Field | Required | Default / rules |
|---|---|---|
| `id` | no | assign `s1`,`s2`,… unique in the file |
| `beat` | no | `b1`… from `plan.json`. Warning if plan exists and beat is missing/unknown |
| `take` | **yes** | must exist |
| `src.in` | **yes** | seconds, `0 ≤ in < out` |
| `src.out` | **yes** | `out ≤ take.duration + 1e-3` |
| `camera` | no | static wide (see §6) |
| `cursor` | no | see §8 |
| `freeze_ms` | no | `500`. After `src.out`, hold the **last source frame** this many ms, camera already at `to` |
| `transition_in` | no | `{ "type": "cut" }` |

`transition_in.type`: `cut` | `crossfade`. If `crossfade`, require `transition_in.duration` (seconds, default `0.25` if type is crossfade and duration omitted). First shot: always treat as `cut` (nothing to blend).

**Playing duration** of a shot = `(src.out - src.in) + freeze_ms/1000`.

**Edit timeline:** shots are concatenated. For a `cut`, next shot starts when the previous ends. For a `crossfade` of `d` seconds, the next shot overlaps the last `d` seconds of the previous (timeline shortens by `d`). `d` must be < both shots’ playing durations; else error.

No retiming in v1. Source always plays 1×. Freeze is the only extra.

---

## 8. Cursor

v1 always **overlays** a bundled cursor PNG (classic north-west pointer). Hotspot = (6, 4) in the **unscaled** PNG; scale PNG so its longest side = `cursor.size` output px, scale hotspot the same.

**Hide the OS/source cursor in capture** when you control capture. On ingest, if the source already has a cursor baked in, we will double-draw — acceptable for v1 (document it). `cursor.visible: false` draws no overlay.

### Authored path (preferred when `cursor.from` / `cursor.to` present)

- `from` / `to`: `{x,y}` normalized, `{cx,cy}` pixels, `{target: selector|#id}`, or `"previous"` (last cursor pos, or center).
- Movement starts at shot start (edit), lasts `travel` seconds (default 0.4), uses **ease-out**.
- Then sit still for `dwell_ms` (default 180).
- `click_at` is **source time**. If omitted: `src.in + travel + dwell_ms/1000`.
- At `click_at`, play an 80ms press: scale 1.0 → 0.85 → 1.0. No ripple in v1.

Cursor position is interpolated in **source pixels**, then mapped through the **current camera crop** into output pixels (so the pointer sits on the UI it points at).

### Event path (when from/to omitted but `events.jsonl` has pointer events)

For each output frame, cursor source pos = interpolate `pointer_move` / `pointer_down` / `click` samples at `t_src` with piecewise linear interpolation. If no sample yet, hide until the first sample.

### Neither

If `visible` is true but no from/to and no events: hide, warning `NO_CURSOR_PATH`.

`cursor.travel` default 0.4, `dwell_ms` 180, `size` 28.

---

## 9. Callouts

Array on the shotlist (not buried only inside shots), each:

```json
{
  "id": "c1",
  "take": "take_a1b2c3d4",
  "src_in": 1.5,
  "src_out": 3.0,
  "target": "#signup",
  "label": "Sign up",
  "style": "highlight"
}
```

| Field | Required |
|---|---|
| `take` | yes |
| `src_in`, `src_out` | yes, source seconds |
| `target` | selector or `{x,y,w,h}` source px |
| `style` | `highlight` \| `outline` \| `label` |
| `label` | required if style is `label` or `highlight` with text; optional otherwise |
| `id` | optional, auto `c1`,`c2`,… |

Draw in **output space** after the crop (so the box tracks the element on camera).

- `outline`: 2px solid `#FFFFFF`, 8px radius around the mapped rect, no fill.
- `highlight`: dim the full frame with `rgba(0,0,0,0.45)`, punch a rounded hole at the rect (8px), then same outline. Optional `label`.
- `label`: outline + text. Font: DejaVu Sans or Inter if you bundle it, 16px, white, 1px dark shadow. Place above the rect if space, else below. Do not clip off-frame: flip side / shift.

Callouts render only when `t_src` is in `[src_in, src_out]` **and** that take is what’s on screen (including freeze, last frame’s t_src = src.out).

Unknown selector: skip that callout, warning.

---

## 10. events.jsonl

One JSON object per line, time-ordered. Unknown `type` values: ignore.

```json
{"t": 1.234, "type": "pointer_move", "x": 400, "y": 120}
{"t": 1.400, "type": "pointer_down", "button": 0, "x": 400, "y": 120}
{"t": 1.450, "type": "pointer_up", "button": 0, "x": 400, "y": 120}
{"t": 1.450, "type": "click", "x": 400, "y": 120, "selector": "#signup"}
{"t": 2.010, "type": "keydown", "key": "a"}
{"t": 2.500, "type": "scroll", "x": 0, "y": 40, "dx": 0, "dy": 80}
{"t": 3.000, "type": "nav", "url": "https://example.com/app"}
```

`x`,`y` are source pixels. `t` is source seconds.

v1 uses pointer_* and click for cursor. Store the rest; do not visualize keys/scroll yet.

---

## 11. boxes.jsonl

Snapshots, **not** every frame. One object per line:

```json
{
  "t": 1.400,
  "elements": [
    {
      "selector": "#signup",
      "role": "button",
      "name": "Sign up",
      "rect": { "x": 320, "y": 80, "w": 160, "h": 44 }
    }
  ]
}
```

`rect` source pixels. `selector` should be a CSS selector that is unique enough to aim a camera. Also allowed: `[data-shotlist="hero"]`.

**When to snapshot (capture):** on click, on nav, every 500ms while recording, and whenever you can cheaply do it.

**Lookup at time t:** use the snapshot with the greatest `t' ≤ t`. If none, empty list. Do **not** interpolate rects in v1.

`list_elements` returns that snapshot’s elements. Optional `query` string: case-insensitive substring filter on `selector`, `name`, `role`.

---

## 12. Edit timeline → source frame

For output frame `n` (`n = 0..N-1`):

1. `t_edit = n / output.fps`
2. Find which shot(s) cover `t_edit` (two shots during crossfade).
3. For a shot, `t_local = t_edit - shot_start_on_timeline`.
4. If `t_local < (src.out - src.in)`: `t_src = src.in + t_local`. Else freeze: `t_src = src.out` (last frame).
5. Grab source frame at `round(t_src * take.fps)`.
6. Apply camera crop+scale, cursor, callouts.
7. Crossfade: `alpha = t_local_B / d` for the incoming shot; `out = A*(1-alpha) + B*alpha` in linear 8-bit is fine for v1.

Total output duration = sum(playing durations) − sum(crossfade durations).

---

## 13. ffmpeg / encode

**Ingest transcode** (always, so takes are uniform):

```
ffmpeg -y -i INPUT -an -c:v libx264 -pix_fmt yuv420p -preset fast -crf 18 -r TAKE_FPS -vsync cfr -movflags +faststart source.mp4
```

`TAKE_FPS`: use source fps if 24–60, else 30. Round to nearest integer. Even dimensions (reduce by 1 if odd).

**Render:**

- Scale crop with **lanczos**.
- `libx264 -crf 18 -preset medium -pix_fmt yuv420p -r output.fps -vsync cfr -movflags +faststart -an`
- You may render frames to png/raw and pipe, or filter_complex; output must match §12.

**preview_frame:** one PNG, 8-bit sRGB, exact `output.width × output.height`. No letterbox padding in the PNG; the crop already fills it.

**preview_clip:** same encode as render, but only the requested range. Default max 5s if a long range is asked without `max_seconds`.

---

## 14. MCP tools

All tools return JSON text. `preview_frame` **also** returns an MCP `image` content block (PNG or JPEG q=90) so I can see it. Never return `{ok:true}` with no path and no image.

On failure, tool error whose text is JSON:

```json
{
  "ok": false,
  "code": "TAKE_NOT_FOUND",
  "message": "human sentence",
  "details": {}
}
```

Codes: `TAKE_NOT_FOUND`, `SHOT_NOT_FOUND`, `INVALID_SHOTLIST`, `NO_SHOTLIST`, `ELEMENT_NOT_FOUND`, `TIME_OUT_OF_RANGE`, `RENDER_FAILED`, `CAPTURE_FAILED`, `FFMPEG_MISSING`, `BUSY`, `NOT_IMPLEMENTED`, `BAD_INPUT`.

### 14.0 `set_plan` / `get_plan`

The demo plan. Required process, cheap to implement (JSON file).

`set_plan`:

```json
{
  "plan": {
    "version": 1,
    "product": "acme",
    "url": "https://example.com",
    "audience": "the person who would use this tonight",
    "language": "en",
    "target_seconds": 25,
    "story": "see the promise → enter the flow → distinctive result → one tweak → stop before payment/secrets",
    "pages": [
      {
        "url": "https://example.com",
        "promise": "one-sentence value prop from the headline",
        "cta": "Get started",
        "notes": ""
      }
    ],
    "magic": "the frame that would make someone want this",
    "skip": ["FAQ", "legal", "payment", "cookie banner"],
    "beats": [
      {
        "id": "b1",
        "name": "land",
        "url": "https://example.com",
        "action": "hold on the entry URL",
        "why": "promise in one glance",
        "hold": "headline + primary CTA",
        "camera": "wide then push to CTA",
        "skip_if": null
      }
    ]
  }
}
```

Validate: `version === 1`, `product` and `url` non-empty, `beats` is a non-empty array, each beat has `id`, `name`, `why`, `camera`. Assign missing beat ids `b1`…. Write `plan.json`. Return `{ ok, beat_count, warnings }`.

`get_plan`: no args. Return `{ ok, plan }` or `NO_PLAN`.

`set_shotlist` when `plan.json` is missing: still accept (so the fixture in §17 works), but always include warning `NO_PLAN`. Real demos always have a plan.

---

### 14.1 `ingest_take`

```json
{
  "video_path": "/abs/or/relative",
  "events_path": null,
  "boxes_path": null,
  "take_id": null
}
```

- Copy/transcode into `takes/{take_id}/`.
- `take_id` optional; default `take_` + 8 lowercase hex.
- Missing events/boxes → empty files, `has_*=false`.
- Return:

```json
{
  "ok": true,
  "take_id": "take_a1b2c3d4",
  "duration": 12.333,
  "width": 1440,
  "height": 900,
  "fps": 30,
  "has_events": false,
  "has_boxes": false,
  "video_path": "/abs/.../source.mp4"
}
```

**This tool is v1-blocking.** Everything else can wait; ingest + shotlist + preview + render is the product.

### 14.2 `start_take`

```json
{
  "fps": 30,
  "region": { "x": 0, "y": 0, "w": 1440, "h": 900 },
  "display": ":0"
}
```

Linux: ffmpeg `x11grab` (or equivalent) of `region` on `display`, hide OS cursor if the grabber supports it (`-draw_mouse 0`). Write events/boxes empty unless you also hook input.

If you cannot capture on this machine: return `NOT_IMPLEMENTED` with a message to use `ingest_take`. Do not fake a take.

Return `{ ok, take_id, status: "recording" }`.

### 14.3 `stop_take`

No args. Finalize current recording, transcode like ingest, write `meta.json`. Return the same object as `ingest_take`. Error `BAD_INPUT` if nothing is recording.

### 14.4 `list_takes`

No args. Return `{ ok, takes: [ meta.json objects ] }`.

### 14.5 `get_take`

```json
{ "take_id": "take_a1b2c3d4" }
```

Return meta + `video_path`, `events_path`, `boxes_path`, and `events_summary`: `{ "clicks": N, "moves": N, "keys": N }` counted from events.jsonl.

### 14.6 `list_elements`

```json
{ "take_id": "take_a1b2c3d4", "t": 1.4, "query": null }
```

Return `{ ok, t_snapshot, elements: [...] }`. Empty array is ok.

### 14.7 `get_shotlist`

No args. Return `{ ok, shotlist }` or `NO_SHOTLIST`.

### 14.8 `set_shotlist`

```json
{ "shotlist": { "version": 1, "shots": [] }, "strict": false }
```

Full replace after validation. Assign missing ids. Write `shotlist.json`.

Return `{ ok, shot_count, warnings: [string] }`.

Validation failures (hard error unless noted):

- `version !== 1`
- empty `shots`
- missing `take` / `src.in` / `src.out`
- `in >= out` or times outside take (epsilon 1e-3)
- unknown take
- unknown ease / transition type
- duplicate ids
- crossfade too long
- `output` width/height not even positives

Warnings (ok if `strict` false): `ELEMENT_NOT_FOUND`, zoom clamped, `NO_CURSOR_PATH`. If `strict` true, those become errors.

### 14.9 `add_shot`

```json
{ "shot": { }, "index": null }
```

Insert at `index` (0-based) or append. Validate that shot. Return `{ ok, id, index, warnings }`. Error `NO_SHOTLIST` if none yet — I should `set_shotlist` with the first shot, **or** you may create a default empty list; prefer auto-create `{version:1,shots:[]}` then add.

### 14.10 `update_shot`

```json
{ "id": "s1", "patch": { "freeze_ms": 800 } }
```

Shallow-merge patch into the shot (nested `camera`/`cursor`/`src` are **shallow-merged one level**: `patch.camera.to` replaces `camera.to` entirely). Re-validate. Return `{ ok, shot, warnings }`.

### 14.11 `add_callout`

```json
{ "callout": { } }
```

Append to `shotlist.callouts`. Auto-create array. Return `{ ok, id }`.

### 14.12 `preview_frame`  ★ required, do not ship without this

```json
{
  "shot_id": "s1",
  "shot_time": 0.8,
  "t": null,
  "source_t": null,
  "take_id": null
}
```

Resolve time in this order:

1. `shot_id` + `shot_time` (seconds from that shot’s start, including freeze).
2. `t` — edit timeline seconds.
3. `take_id` + `source_t` — first shot that covers that source time; if none, render that take at source_t with **wide** camera (zoom 1) so I can still inspect the tape.

Return JSON + image:

```json
{
  "ok": true,
  "png_path": "/abs/.../out/preview-….png",
  "width": 1920,
  "height": 1080,
  "shot_id": "s1",
  "t_edit": 0.8,
  "t_src": 2.0,
  "camera": {
    "cx": 400, "cy": 120, "zoom": 1.8,
    "crop": { "x": 100, "y": 40, "w": 1067, "h": 600 }
  },
  "warnings": []
}
```

`crop` is the source-pixel rectangle actually sampled. I use this to see if I clipped the button.

### 14.13 `preview_clip`

```json
{ "shot_id": "s1", "t_in": null, "t_out": null, "max_seconds": 5 }
```

If `shot_id` set: that shot only. Else `[t_in,t_out]` on the edit timeline. Clamp to `max_seconds` (default 5). Return `{ ok, mp4_path, duration, width, height }`.

Not v1-blocking (preview_frame is), but implement before fancy capture.

### 14.14 `render`

```json
{ "filename": null }
```

Render the full shotlist to `out/render-{id}.mp4` or `filename` if absolute/relative path given. Return `{ ok, mp4_path, duration, width, height, bytes, warnings }`. Error `NO_SHOTLIST`. Progress notifications if the SDK makes it easy; not required.

---

## 15. MCP server packaging

stdio. Example config I should be able to paste:

```json
{
  "command": "shotlist-mcp",
  "args": [],
  "env": { "SHOTLIST_DIR": "/path/to/project" }
}
```

No network. No API keys. Server starts fast (<2s) and does not load ffmpeg until a media tool is called.

List these tools in `tools/list` with the argument shapes above (JSON Schema). Descriptions: one sentence, say what I get back (especially that `preview_frame` returns an image).

---

## 16. Agent loop this must support

0. **Analyze** the live app. No MCP video tools yet. Fill pages / magic / skip.
1. `set_plan` with beats (§1B template, URLs from analyze). `get_plan` to confirm.
2. Capture or `ingest_take` **only those beats**.
3. `get_take` + `preview_frame` with `source_t` (wide) to see the tape.
4. `list_elements` at click times.
5. `set_shotlist` with 3–8 shots, each tagged with `beat`. setup (wide) → ease into control → click → freeze on result → cut.
6. `preview_frame` on each shot landing (`shot_time ≈ camera.duration`). If crop clips, `update_shot` padding/zoom.
7. `render`. Watch. Patch JSON. Render again.

If step 6 has no picture, the loop is broken. If step 1 is missing, stop and plan — do not just press record.

---

## 17. Worked example (implement this as a fixture)

Take: 1440×900, 30fps, 8.0s, a signup page. Click `#email` at t=2.0, `#signup` at t=5.0. Boxes for both at those times.

Shotlist:

```json
{
  "version": 1,
  "output": { "width": 1920, "height": 1080, "fps": 30 },
  "shots": [
    {
      "id": "s1",
      "take": "take_demo",
      "src": { "in": 0.0, "out": 2.0 },
      "camera": {
        "from": { "x": 0.5, "y": 0.5, "zoom": 1.0 },
        "to": { "target": "#email", "padding": 80 },
        "duration": 0.8,
        "ease": "ease-out"
      },
      "cursor": {
        "visible": true,
        "from": { "x": 0.5, "y": 0.8 },
        "to": { "target": "#email" },
        "travel": 0.45,
        "dwell_ms": 180,
        "click_at": 1.85
      },
      "freeze_ms": 400,
      "transition_in": { "type": "cut" }
    },
    {
      "id": "s2",
      "take": "take_demo",
      "src": { "in": 2.0, "out": 5.0 },
      "camera": {
        "from": { "target": "#email", "padding": 80 },
        "to": { "target": "#signup", "padding": 64 },
        "duration": 0.7,
        "ease": "ease-in-out"
      },
      "cursor": {
        "visible": true,
        "from": "previous",
        "to": { "target": "#signup" },
        "travel": 0.4,
        "dwell_ms": 180,
        "click_at": 4.8
      },
      "freeze_ms": 600,
      "transition_in": { "type": "cut" }
    }
  ],
  "callouts": [
    {
      "id": "c1",
      "take": "take_demo",
      "src_in": 4.5,
      "src_out": 5.6,
      "target": "#signup",
      "label": "Create account",
      "style": "highlight"
    }
  ]
}
```

Ship this under `fixtures/demo/` (even a generated color-block video + jsonl is enough) so render is testable without a real app.

---

## 18. Build order (do not skip 1)

1. **Ingest + camera crop + ease + preview_frame + render** with no cursor. This already un-robots zoom.
2. Cursor overlay (authored from/to).
3. freeze_ms, cuts, crossfade.
4. Callouts.
5. Event-driven cursor, boxes, list_elements.
6. start_take / stop_take on Linux.
7. preview_clip.

A PR that only does step 1 is useful. A PR that is “MCP stubs + Playwright clicks + snap zoom” is not.

---

## 19. Acceptance tests

v1 is done when all of these pass:

- [ ] `ingest_take` on a local mp4 produces `source.mp4` + `meta.json`.
- [ ] `set_shotlist` rejects `in >= out` and unknown ease with `INVALID_SHOTLIST`.
- [ ] Camera eases: `preview_frame` at shot_time=0 vs shot_time=`camera.duration` shows different `camera.zoom` / crop (not a boolean jump on frame 0).
- [ ] Crop never samples outside the source (check `crop` in preview_frame JSON).
- [ ] `preview_frame` returns a PNG **and** an image content block, output resolution.
- [ ] Cursor travels: two frames during `travel` have different overlay positions.
- [ ] `freeze_ms: 500` at 30fps adds 15 identical source-index frames after `src.out`.
- [ ] `update_shot` on padding changes the next `preview_frame` crop without re-ingest.
- [ ] `render` writes an mp4; duration within 2 frames of the formula in §12.
- [ ] Missing selector → warning, not crash.
- [ ] No ffmpeg → `FFMPEG_MISSING`.
- [ ] Linux: documented how to run the stdio server.
- [ ] `set_plan` / `get_plan` round-trip a beat list shaped like §1B.
- [ ] `set_shotlist` without a plan returns warning `NO_PLAN`.
- [ ] A shot may include `"beat": "b4"`; unknown beat → warning.
- [ ] A real webapp can run analyze → plan → ingest → shots → preview → render. Magic beat is the distinctive result, not FAQ.

Looks closer to Screen Studio than to a Selenium recording.

---

## 20. Decisions already made (do not reopen)

| Topic | Decision |
|---|---|
| Default output | 1920×1080 @ 30fps (landscape). Set `output` for 9:16. |
| Zoom interpolation | Linear in zoom, not log |
| Hold | `freeze_ms` freezes last source frame; not a speed ramp |
| Drive browser | No |
| Audio | Off |
| Cursor double-draw on ingested screengrabs | OK in v1 |
| Black bars | Not from camera overhang. If source aspect ≠ output aspect, zoom=1 already letterbox-crops (cover-style max crop). No added pillarbox. |
| Follow-cursor camera | Not v1. I author `from`/`to`. |
| Strict | Off by default |
| IDs | `take_`+8 hex; shots `sN`; callouts `cN` |
| Image in preview | Required |
| GUI | Not required |
| Record first | Forbidden. Analyze + plan first |
| First demo | any live webapp named in plan.json, 20–30s, stop before payment/secrets |

---

## 21. What I will refuse to use

- Tools that only return success booleans
- Binary in/out zoom flags
- Live viewport zoom as the edit
- Anything that forces me to re-record to change framing
- A pipeline that starts at Record without `plan.json`
