// A QR code encoder for the pairing link, written from ISO/IEC 18004: byte mode, error correction
// level M, versions 1 to 10 (up to 213 bytes), so `factory pair` needs no package. The mask is
// chosen by the standard's penalty score, so phone cameras read it as reliably as any other.

const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
export const QR_MAX_BYTES = 213;

function rawModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}
const dataCodewords = (ver: number) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver]! * BLOCKS[ver]!;

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const out = new Array<number>(degree - 1).fill(0).concat([1]);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < out.length; j++) {
      out[j] = gfMul(out[j]!, root);
      if (j + 1 < out.length) out[j]! ^= out[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return out;
}

export function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const out = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ out.shift()!;
    out.push(0);
    divisor.forEach((c, i) => (out[i]! ^= gfMul(c, factor)));
  }
  return out;
}

function codewords(bytes: Uint8Array, ver: number): number[] {
  const bits: number[] = [];
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  put(4, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = dataCodewords(ver) * 8;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  const total = Math.floor(rawModules(ver) / 8);
  const nBlocks = BLOCKS[ver]!;
  const ecc = ECC_PER_BLOCK[ver]!;
  const short = nBlocks - (total % nBlocks);
  const shortLen = Math.floor(total / nBlocks);
  const div = rsDivisor(ecc);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const dat = data.slice(k, k + shortLen - ecc + (i < short ? 0 : 1));
    k += dat.length;
    const rem = rsRemainder(dat, div);
    if (i < short) dat.push(0);
    blocks.push(dat.concat(rem));
  }
  const out: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++)
    blocks.forEach((b, j) => {
      if (i !== shortLen - ecc || j >= short) out.push(b[i]!);
    });
  return out;
}

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
  const out = [6];
  for (let pos = ver * 4 + 10; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

// Format bits for level M (00) and a mask, BCH-protected and XORed as the standard says.
export function formatBits(mask: number): number {
  const data = mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

class Grid {
  readonly m: boolean[][];
  readonly fn: boolean[][];
  constructor(readonly size: number) {
    this.m = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  set(x: number, y: number, dark: boolean) {
    this.m[y]![x] = dark;
    this.fn[y]![x] = true;
  }
}

function drawFormat(g: Grid, mask: number) {
  const bits = formatBits(mask);
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  const s = g.size;
  for (let i = 0; i <= 5; i++) g.set(8, i, bit(i));
  g.set(8, 7, bit(6));
  g.set(8, 8, bit(7));
  g.set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) g.set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) g.set(s - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) g.set(8, s - 15 + i, bit(i));
  g.set(8, s - 8, true);
}

function drawFunctions(g: Grid, ver: number) {
  const s = g.size;
  for (let i = 0; i < s; i++) {
    g.set(6, i, i % 2 === 0);
    g.set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [s - 4, 3],
    [3, s - 4],
  ] as const)
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < s && y >= 0 && y < s) g.set(x, y, d !== 2 && d !== 4);
      }
  const pos = alignmentPositions(ver);
  const last = pos.length - 1;
  pos.forEach((px, i) =>
    pos.forEach((py, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) g.set(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }),
  );
  drawFormat(g, 0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = s - 11 + (i % 3);
      const b = Math.floor(i / 3);
      g.set(a, b, dark);
      g.set(b, a, dark);
    }
  }
}

function drawData(g: Grid, data: readonly number[]) {
  const s = g.size;
  let i = 0;
  for (let right = s - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < s; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? s - 1 - vert : vert;
        if (!g.fn[y]![x] && i < data.length * 8) {
          g.m[y]![x] = ((data[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
  }
}

function applyMask(g: Grid, mask: number) {
  const f = MASKS[mask]!;
  for (let y = 0; y < g.size; y++)
    for (let x = 0; x < g.size; x++) if (!g.fn[y]![x] && f(x, y)) g.m[y]![x] = !g.m[y]![x];
}

// The standard's penalty rules 1 to 4: runs, 2x2 blocks, finder look-alikes, dark balance.
function penalty(m: boolean[][]): number {
  const s = m.length;
  let score = 0;
  const lines = [...m, ...m.map((_, x) => m.map((row) => row[x]!))];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= s; i++) {
      if (i < s && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    const str = line.map((d) => (d ? "1" : "0")).join("");
    for (const p of ["10111010000", "00001011101"])
      for (let k = str.indexOf(p); k >= 0; k = str.indexOf(p, k + 1)) score += 40;
  }
  for (let y = 0; y < s - 1; y++)
    for (let x = 0; x < s - 1; x++) {
      const c = m[y]![x];
      if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) score += 3;
    }
  const dark = m.flat().filter(Boolean).length;
  return score + Math.floor(Math.abs(dark * 20 - s * s * 10) / (s * s)) * 10;
}

// The module matrix, true for dark, with no quiet zone.
export function encodeQr(text: string, onlyMask?: number): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let ver = 1;
  while (ver <= 10 && dataCodewords(ver) * 8 < 4 + (ver < 10 ? 8 : 16) + bytes.length * 8) ver++;
  if (ver > 10) throw new Error(`too long for a pairing QR: ${bytes.length} bytes, at most ${QR_MAX_BYTES}`);
  const data = codewords(bytes, ver);
  let best: { score: number; m: boolean[][] } | undefined;
  for (let mask = 0; mask < 8; mask++) {
    if (onlyMask !== undefined && mask !== onlyMask) continue;
    const g = new Grid(ver * 4 + 17);
    drawFunctions(g, ver);
    drawData(g, data);
    applyMask(g, mask);
    drawFormat(g, mask);
    const score = penalty(g.m);
    if (!best || score < best.score) best = { score, m: g.m };
  }
  return best!.m;
}

// Two rows per line with half blocks; light modules print as blocks, so it reads on a dark terminal.
export function qrToTerminal(m: boolean[][], quiet = 2): string {
  const s = m.length + quiet * 2;
  const dark = (x: number, y: number) => m[y - quiet]?.[x - quiet] === true;
  const rows: string[] = [];
  for (let y = 0; y < s; y += 2) {
    let line = "";
    for (let x = 0; x < s; x++) {
      const top = !dark(x, y);
      const bottom = y + 1 < s && !dark(x, y + 1);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    rows.push(line);
  }
  return rows.join("\n");
}

export function qrToSvg(m: boolean[][], quiet = 4): string {
  const s = m.length + quiet * 2;
  let d = "";
  m.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x + quiet},${y + quiet}h1v1h-1z`)));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" shape-rendering="crispEdges"><rect width="${s}" height="${s}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
