// Tolerant screenshot comparison for the QA step. Hash equality fails on one antialiased pixel (see
// src/visual.ts), so two PNGs are compared pixel by pixel: a pixel counts as changed when any channel
// differs by more than `channelTolerance`, and the shot fails when the changed share of pixels is above
// `maxChangedRatio`. Decoding uses node:zlib only, so no dependency is added. Pure apart from the
// directory reader, which compareShotDirs calls from the qa step (src/qa-step.ts).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

export interface Rgba {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array; // width * height * 4
}
export interface CompareOptions {
  // Largest per-channel difference (0-255) still counted as the same pixel.
  readonly channelTolerance: number;
  // Largest share (0-1) of changed pixels that still passes.
  readonly maxChangedRatio: number;
}
export const DEFAULT_COMPARE: CompareOptions = { channelTolerance: 8, maxChangedRatio: 0.001 };

export interface BBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export type CompareResult =
  | {
      readonly ok: boolean;
      readonly changed: number;
      readonly total: number;
      readonly ratio: number;
      readonly bbox?: BBox;
    }
  | { readonly ok: false; readonly reason: string };

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// 8 bit, non-interlaced PNG to RGBA. Throws a short message on anything else.
export function decodePng(buf: Uint8Array): Rgba {
  const b = Buffer.from(buf);
  if (b.length < 8 || !b.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let width = 0;
  let height = 0;
  let colorType = -1;
  let palette = Buffer.alloc(0);
  const idat: Buffer[] = [];
  for (let off = 8; off + 8 <= b.length; ) {
    const len = b.readUInt32BE(off);
    const type = b.toString("latin1", off + 4, off + 8);
    const body = b.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8) throw new Error(`unsupported PNG bit depth ${body[8]}`);
      colorType = body[9] ?? -1;
      if (body[12] !== 0) throw new Error("unsupported interlaced PNG");
    } else if (type === "PLTE") palette = Buffer.from(body);
    else if (type === "IDAT") idat.push(Buffer.from(body));
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const bpp = CHANNELS[colorType];
  if (!bpp || width === 0 || height === 0) throw new Error("bad PNG header");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) throw new Error("truncated PNG");
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i] ?? 0;
      const a = i >= bpp ? (px[row + i - bpp] ?? 0) : 0;
      const up = y > 0 ? (px[row - stride + i] ?? 0) : 0;
      const c = y > 0 && i >= bpp ? (px[row - stride + i - bpp] ?? 0) : 0;
      let v: number;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + up;
      else if (filter === 3) v = x + ((a + up) >> 1);
      else if (filter === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c);
      } else throw new Error(`bad PNG filter ${filter}`);
      px[row + i] = v & 255;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const s = p * bpp;
    const o = p * 4;
    if (colorType === 6) data.set(px.subarray(s, s + 4), o);
    else if (colorType === 2) data.set([px[s]!, px[s + 1]!, px[s + 2]!, 255], o);
    else if (colorType === 0) data.set([px[s]!, px[s]!, px[s]!, 255], o);
    else if (colorType === 4) data.set([px[s]!, px[s]!, px[s]!, px[s + 1]!], o);
    else {
      const i = (px[s] ?? 0) * 3;
      data.set([palette[i] ?? 0, palette[i + 1] ?? 0, palette[i + 2] ?? 0, 255], o);
    }
  }
  return { width, height, data };
}

export function compareImages(a: Rgba, b: Rgba, opts: CompareOptions = DEFAULT_COMPARE): CompareResult {
  if (a.width !== b.width || a.height !== b.height) {
    return { ok: false, reason: `size mismatch: ${a.width}x${a.height} before, ${b.width}x${b.height} after` };
  }
  let changed = 0;
  let x0 = a.width;
  let y0 = a.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const o = (y * a.width + x) * 4;
      let diff = 0;
      for (let k = 0; k < 4; k++) diff = Math.max(diff, Math.abs((a.data[o + k] ?? 0) - (b.data[o + k] ?? 0)));
      if (diff <= opts.channelTolerance) continue;
      changed++;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  const total = a.width * a.height;
  const ratio = changed / total;
  return {
    ok: ratio <= opts.maxChangedRatio,
    changed,
    total,
    ratio,
    ...(changed ? { bbox: { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } } : {}),
  };
}

// One line per shot, for the QA comment.
export function renderCompareLine(name: string, r: CompareResult): string {
  if ("reason" in r) return `| \`${name}\` | fail | ${r.reason} |`;
  const detail = r.bbox
    ? `${(r.ratio * 100).toFixed(3)}% changed (${r.changed} of ${r.total}), box ${r.bbox.width}x${r.bbox.height} at ${r.bbox.x},${r.bbox.y}`
    : "no changed pixel";
  return `| \`${name}\` | ${r.ok ? "pass" : "fail"} | ${detail} |`;
}

export interface ShotReport {
  readonly ok: boolean;
  readonly section: string;
}

// Compares every PNG in `current` with the same name in `baseline`. A shot with no baseline is new and
// passes; one that cannot be decoded fails with the reason. No shots at all: undefined, nothing to attach.
export function compareShotDirs(
  baseline: string,
  current: string,
  opts: CompareOptions = DEFAULT_COMPARE,
): ShotReport | undefined {
  if (!existsSync(current)) return undefined;
  const names = readdirSync(current)
    .filter((f) => f.endsWith(".png"))
    .sort();
  if (names.length === 0) return undefined;
  let ok = true;
  const rows = names.map((name) => {
    const base = join(baseline, name);
    if (!existsSync(base)) return `| \`${name}\` | pass | new shot, no baseline |`;
    let r: CompareResult;
    try {
      r = compareImages(decodePng(readFileSync(base)), decodePng(readFileSync(join(current, name))), opts);
    } catch (e) {
      r = { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    if (!r.ok) ok = false;
    return renderCompareLine(name, r);
  });
  const head = `Tolerance: channel delta ${opts.channelTolerance}, changed pixels at most ${(opts.maxChangedRatio * 100).toFixed(3)}%.`;
  return {
    ok,
    section: ["## Visual comparison", "", head, "", "| Shot | Result | Detail |", "| --- | --- | --- |", ...rows].join(
      "\n",
    ),
  };
}
