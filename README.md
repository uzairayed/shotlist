# shotlist

MCP camera + timeline so an agent can direct webapp demo shots after the take, not snap-zoom live.

Contract: [GitHub issue #1](https://github.com/uzairayed/shotlist/issues/1).

## Requirements

- Node.js 20+
- [ffmpeg](https://ffmpeg.org/) on `PATH` (or set `FFMPEG_PATH`)
- Linux for `start_take` / `stop_take` (x11grab). Other OSes: use `ingest_take`.

## Install

```bash
npm install
npm run build
npm test
```

The CLI entry is `shotlist-mcp` (after build: `node dist/bin.js`, or `npx tsx src/bin.ts` for dev).

## MCP config (stdio)

```json
{
  "command": "shotlist-mcp",
  "args": [],
  "env": { "SHOTLIST_DIR": "/path/to/project" }
}
```

`SHOTLIST_DIR` defaults to `~/.shotlist/project`. One project per directory. No network. No API keys. The server starts without loading ffmpeg until a media tool runs.

## Production loop

1. Analyze the live app (no MCP video tools yet).
2. `set_plan` / `get_plan` with beats.
3. Capture or `ingest_take` only those beats (full resolution, no live zoom).
4. `get_take` + `preview_frame` (wide via `source_t`) to inspect tape.
5. `list_elements` at click times.
6. `set_shotlist` with 3–8 shots tagged with `beat`.
7. `preview_frame` on each landing; `update_shot` padding/zoom as needed.
8. `render`.

## Ingest vs capture

- **ingest_take**: v1-blocking. Point at a local mp4 (+ optional events/boxes jsonl).
- **start_take / stop_take**: Linux x11grab only. Elsewhere returns `NOT_IMPLEMENTED` and tells you to use `ingest_take`. Never fakes a take.

## Cursor double-draw

On ingested screengrabs that already include an OS cursor, the authored overlay may double-draw. Acceptable for v1. Prefer hiding the OS cursor when you control capture (`-draw_mouse 0`).

## Demo fixture

`fixtures/demo/` contains the §17 worked example (color-block video, events, boxes, shotlist). Tests ingest and render it without a real app.

## Tagiser first demo

`fixtures/tagiser/plan.json` is the analyze-updated plan for [tagiser.com](https://www.tagiser.com) (Norwegian name labels). Magic beat is generated designs; stop before payment.

## Tools

`set_plan`, `get_plan`, `ingest_take`, `start_take`, `stop_take`, `list_takes`, `get_take`, `list_elements`, `get_shotlist`, `set_shotlist`, `add_shot`, `update_shot`, `add_callout`, `preview_frame` (returns PNG path **and** an image content block), `preview_clip`, `render`.
