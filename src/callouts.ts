import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { findElementAtTime } from "./boxes.js";
import { mapRectToOutput } from "./compose.js";
import type {
  Callout,
  OutputDefaults,
  Rect,
  ResolvedCamera,
  TakeMeta,
} from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT = path.resolve(__dirname, "../assets/DejaVuSans.ttf");

export async function applyCallouts(opts: {
  basePng: Buffer;
  callouts: Callout[];
  takeId: string;
  tSrc: number;
  camera: ResolvedCamera;
  output: OutputDefaults;
  take: TakeMeta;
  root?: string;
}): Promise<{ png: Buffer; warnings: string[] }> {
  const warnings: string[] = [];
  const active = opts.callouts.filter(
    (c) =>
      c.take === opts.takeId &&
      opts.tSrc >= c.src_in - 1e-9 &&
      opts.tSrc <= c.src_out + 1e-9,
  );
  if (!active.length) return { png: opts.basePng, warnings };

  let img = sharp(opts.basePng).ensureAlpha();
  const { width, height } = opts.output;
  const composites: sharp.OverlayOptions[] = [];

  for (const c of active) {
    let rect: Rect | null = null;
    if (typeof c.target === "string") {
      const el = findElementAtTime(c.take, c.target, opts.tSrc, opts.root);
      if (!el) {
        warnings.push(`ELEMENT_NOT_FOUND:${c.target}`);
        continue;
      }
      rect = el.rect;
    } else {
      rect = c.target;
    }
    const outRect = mapRectToOutput(rect, opts.camera, opts.output);
    const rx = Math.round(outRect.x);
    const ry = Math.round(outRect.y);
    const rw = Math.max(1, Math.round(outRect.w));
    const rh = Math.max(1, Math.round(outRect.h));

    if (c.style === "highlight") {
      // dim full frame, punch hole
      const dim = await sharp({
        create: {
          width,
          height,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0.45 },
        },
      })
        .png()
        .toBuffer();
      // hole via destination-out composite of rounded rect
      const holeSvg = Buffer.from(
        `<svg width="${width}" height="${height}">
          <rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" rx="8" ry="8" fill="white"/>
        </svg>`,
      );
      const dimWithHole = await sharp(dim)
        .composite([{ input: holeSvg, blend: "dest-out" }])
        .png()
        .toBuffer();
      composites.push({ input: dimWithHole, left: 0, top: 0 });
    }

    // outline for all styles
    const outlineSvg = Buffer.from(
      `<svg width="${width}" height="${height}">
        <rect x="${rx + 1}" y="${ry + 1}" width="${Math.max(1, rw - 2)}" height="${Math.max(1, rh - 2)}"
          rx="8" ry="8" fill="none" stroke="#FFFFFF" stroke-width="2"/>
      </svg>`,
    );
    composites.push({ input: outlineSvg, left: 0, top: 0 });

    if (
      (c.style === "label" || c.style === "highlight") &&
      c.label &&
      c.label.trim()
    ) {
      const labelY = ry - 24 >= 0 ? ry - 24 : ry + rh + 4;
      const labelX = Math.max(8, Math.min(width - 200, rx));
      const escaped = c.label
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const fontFace = `font-family="DejaVu Sans, Arial, sans-serif"`;
      const labelSvg = Buffer.from(
        `<svg width="${width}" height="${height}">
          <style>@font-face{font-family:'DejaVu Sans';src:url('${FONT}');}</style>
          <text x="${labelX}" y="${labelY + 16}" ${fontFace} font-size="16"
            fill="#FFFFFF" stroke="#000000" stroke-width="1">${escaped}</text>
        </svg>`,
      );
      composites.push({ input: labelSvg, left: 0, top: 0 });
    }
  }

  const png = await img.composite(composites).png().toBuffer();
  return { png, warnings };
}
