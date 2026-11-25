/**
 * The web app's placeholder icons (docs/spec/07-frontend.md §4): a neutral geometric glyph, not
 * tied to any one game or name, drawn programmatically so the repository carries no artwork
 * source and no image-tool dependency. `pnpm web:icons` writes the PNGs to `apps/web/public/icons`;
 * the files are committed, and the test checks they still match this code.
 */
import { deflateSync, crc32 } from "node:zlib";

type Rgba = readonly [number, number, number, number];

const BLUE: Rgba = [0x1f, 0x5f, 0x8b, 255];
const PALE: Rgba = [0xf2, 0xf2, 0xf2, 255];
const GOLD: Rgba = [0xf2, 0xb6, 0x32, 255];
const CLEAR: Rgba = [0, 0, 0, 0];

/** The three shapes drawn in a 64 × 64 design space. */
const CENTRE = 32;

function inRoundedSquare(x: number, y: number, radius: number): boolean {
  const dx = Math.max(Math.abs(x - CENTRE) - (CENTRE - radius), 0);
  const dy = Math.max(Math.abs(y - CENTRE) - (CENTRE - radius), 0);
  return dx * dx + dy * dy <= radius * radius;
}

function inCircle(x: number, y: number, cx: number, cy: number, r: number): boolean {
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Distance from a point to the segment (28,28)-(36,36), for the round-capped line. */
function nearConnector(x: number, y: number): boolean {
  const t = Math.min(Math.max(((x - 28) * 8 + (y - 28) * 8) / 128, 0), 1);
  return inCircle(x, y, 28 + 8 * t, 28 + 8 * t, 2);
}

/** The glyph's colour at a design-space point, or null where there is none. */
function glyph(x: number, y: number): Rgba | null {
  if (inCircle(x, y, 42, 42, 8)) return GOLD;
  if (inCircle(x, y, 22, 22, 8) || nearConnector(x, y)) return PALE;
  return null;
}

export interface IconStyle {
  /** Rounded corners with transparency (`any`), or a full-bleed square (maskable, Apple). */
  readonly rounded: boolean;
  /** Glyph scale: below 1 keeps it inside a maskable icon's safe zone. */
  readonly glyphScale: number;
}

/** One 4×4-supersampled pixel at design-space position (px, py). */
function pixel(px: number, py: number, style: IconStyle): Rgba {
  const samples = 4;
  const sum = [0, 0, 0, 0];
  for (let sy = 0; sy < samples; sy += 1) {
    for (let sx = 0; sx < samples; sx += 1) {
      const x = px + (sx + 0.5) / samples;
      const y = py + (sy + 0.5) / samples;
      const gx = CENTRE + (x - CENTRE) / style.glyphScale;
      const gy = CENTRE + (y - CENTRE) / style.glyphScale;
      const colour = glyph(gx, gy) ?? (style.rounded && !inRoundedSquare(x, y, 14) ? CLEAR : BLUE);
      // Premultiplied sums keep the transparent corners from tinting the edge.
      const alpha = colour[3] / 255;
      sum[0] = (sum[0] ?? 0) + colour[0] * alpha;
      sum[1] = (sum[1] ?? 0) + colour[1] * alpha;
      sum[2] = (sum[2] ?? 0) + colour[2] * alpha;
      sum[3] = (sum[3] ?? 0) + alpha;
    }
  }
  const alpha = (sum[3] ?? 0) / (samples * samples);
  if (alpha === 0) return CLEAR;
  const unit = samples * samples * alpha;
  return [
    Math.round((sum[0] ?? 0) / unit),
    Math.round((sum[1] ?? 0) / unit),
    Math.round((sum[2] ?? 0) / unit),
    Math.round(alpha * 255),
  ];
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** A square RGBA PNG of `size` pixels. Deterministic: the same input gives the same bytes. */
export function renderIcon(size: number, style: IconStyle): Buffer {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  const scale = 64 / size;
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixel(x * scale, y * scale, style);
      raw.set([r, g, b, a], y * stride + 1 + x * 4);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The icon files, by name under `apps/web/public/icons`. */
export const ICONS: Readonly<Record<string, { size: number; style: IconStyle }>> = {
  "icon-192.png": { size: 192, style: { rounded: true, glyphScale: 1 } },
  "icon-512.png": { size: 512, style: { rounded: true, glyphScale: 1 } },
  "maskable-512.png": { size: 512, style: { rounded: false, glyphScale: 0.75 } },
  "apple-touch-icon-180.png": { size: 180, style: { rounded: false, glyphScale: 0.9 } },
};
