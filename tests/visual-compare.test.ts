import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { runDir } from "../src/artifacts";
import { parseWorkflowText } from "../src/engine/workflows";
import { compareImages, compareShotDirs, decodePng, writeVisualReport, type Rgba } from "../src/visual-compare";
import { engine, FakeShell, removeEngineDirs } from "./engine-harness";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, body: Buffer) => {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc(Buffer.concat([Buffer.from(type), body])));
  return Buffer.concat([head, Buffer.from(type), body, tail]);
};
// A solid white RGBA image with the given pixels painted; filter 1 (Sub) on every row to exercise it.
function png(w: number, h: number, paint: (x: number, y: number) => [number, number, number] = () => [255, 255, 255]) {
  const rows: number[] = [];
  for (let y = 0; y < h; y++) {
    rows.push(1);
    let prev = [0, 0, 0, 0];
    for (let x = 0; x < w; x++) {
      const cur = [...paint(x, y), 255];
      for (let k = 0; k < 4; k++) rows.push((cur[k]! - prev[k]! + 256) & 255);
      prev = cur;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const img = (...a: Parameters<typeof png>): Rgba => decodePng(png(...a));
const strict = { channelTolerance: 8, maxChangedRatio: 0.01 };

beforeAll(() => mkdirSync(tmpdir(), { recursive: true }));
afterAll(removeEngineDirs);

describe("decodePng", () => {
  test("reads sub-filtered RGBA rows back to the painted pixels", () => {
    const d = img(3, 2, (x, y) => [x * 50, y * 100, 7]);
    expect(Array.from(d.data.subarray(4 * 4, 4 * 5))).toEqual([50, 100, 7, 255]);
    expect([d.width, d.height]).toEqual([3, 2]);
  });
  test("rejects bytes that are not a PNG", () => {
    expect(() => decodePng(Buffer.from("hello world"))).toThrow("not a PNG");
  });
});

describe("compareImages", () => {
  test("a sub-pixel change below the channel tolerance passes with nothing changed", () => {
    const r = compareImages(
      img(20, 20),
      img(20, 20, (x) => (x === 5 ? [250, 250, 250] : [255, 255, 255])),
      strict,
    );
    expect(r).toEqual({ ok: true, changed: 0, total: 400, ratio: 0 });
  });
  test("a few changed pixels under the ratio pass and still report their box", () => {
    const r = compareImages(
      img(20, 20),
      img(20, 20, (x, y) => (x === 3 && y === 4 ? [0, 0, 0] : [255, 255, 255])),
      strict,
    );
    expect(r).toEqual({ ok: true, changed: 1, total: 400, ratio: 0.0025, bbox: { x: 3, y: 4, width: 1, height: 1 } });
  });
  test("a moved block fails and the box covers both its old and new place", () => {
    const at =
      (left: number) =>
      (x: number, y: number): [number, number, number] =>
        x >= left && x < left + 4 && y >= 2 && y < 6 ? [0, 0, 0] : [255, 255, 255];
    const r = compareImages(img(20, 20, at(2)), img(20, 20, at(10)), strict);
    expect(r).toEqual({ ok: false, changed: 32, total: 400, ratio: 0.08, bbox: { x: 2, y: 2, width: 12, height: 4 } });
  });
  test("a size mismatch fails with both sizes in the reason", () => {
    expect(compareImages(img(4, 4), img(5, 4), strict)).toEqual({
      ok: false,
      reason: "size mismatch: 4x4 before, 5x4 after",
    });
  });
  test("a tolerance of zero turns a one-step channel change into a changed pixel", () => {
    const r = compareImages(
      img(2, 2),
      img(2, 2, (x, y) => (x + y === 0 ? [254, 255, 255] : [255, 255, 255])),
      {
        channelTolerance: 0,
        maxChangedRatio: 0,
      },
    );
    expect("changed" in r ? r.changed : -1).toBe(1);
    expect(r.ok).toBe(false);
  });
});

describe("compareShotDirs", () => {
  const dirs = () => {
    const root = mkdtempSync(join(tmpdir(), "visual-compare-"));
    mkdirSync(join(root, "base"));
    mkdirSync(join(root, "cur"));
    return { root, base: join(root, "base"), cur: join(root, "cur") };
  };
  test("no current directory or no png: nothing to attach", () => {
    const d = dirs();
    expect(compareShotDirs(d.base, join(d.root, "none"))).toBe(undefined);
    expect(compareShotDirs(d.base, d.cur)).toBe(undefined);
    rmSync(d.root, { recursive: true });
  });
  test("passes a tolerated shot and a new shot, fails a moved one, and the report names each", () => {
    const d = dirs();
    writeFileSync(join(d.base, "same.png"), png(10, 10));
    writeFileSync(
      join(d.cur, "same.png"),
      png(10, 10, (x) => (x === 1 ? [252, 252, 252] : [255, 255, 255])),
    );
    writeFileSync(join(d.cur, "fresh.png"), png(10, 10));
    writeFileSync(
      join(d.base, "moved.png"),
      png(10, 10, (x) => (x < 3 ? [0, 0, 0] : [255, 255, 255])),
    );
    writeFileSync(
      join(d.cur, "moved.png"),
      png(10, 10, (x) => (x >= 7 ? [0, 0, 0] : [255, 255, 255])),
    );
    const r = compareShotDirs(d.base, d.cur, strict)!;
    expect(r.ok).toBe(false);
    expect(r.section).toContain("| `same.png` | pass | no changed pixel |");
    expect(r.section).toContain("| `fresh.png` | pass | new shot, no baseline |");
    expect(r.section).toContain("| `moved.png` | fail | 60.000% changed (60 of 100), box 10x10 at 0,0 |");
    rmSync(d.root, { recursive: true });
  });
  test("a corrupt current shot fails with the reason instead of throwing", () => {
    const d = dirs();
    writeFileSync(join(d.base, "a.png"), png(4, 4));
    writeFileSync(join(d.cur, "a.png"), "junk");
    const r = compareShotDirs(d.base, d.cur, strict)!;
    expect(r.ok).toBe(false);
    expect(r.section).toContain("| `a.png` | fail | not a PNG |");
    rmSync(d.root, { recursive: true });
  });
});

describe("the qa step attaches the visual report", () => {
  class ShotShell extends FakeShell {
    override async run(cmd: string, cwd?: string) {
      await super.run(cmd);
      const files: Record<string, Buffer | string> = {
        [`${runDir(1)}/qa.json`]: JSON.stringify({ routes: [{ path: "/", status: 200, ok: true }] }),
        ".factory/visual/baseline/home.png": png(10, 10),
        [`${runDir(1)}/visual/home.png`]: png(10, 10, (x) => (x < 5 ? [0, 0, 0] : [255, 255, 255])),
      };
      for (const [name, body] of Object.entries(files)) {
        mkdirSync(dirname(join(cwd!, name)), { recursive: true });
        writeFileSync(join(cwd!, name), body);
      }
      return { stdout: "", stderr: "", code: 0 };
    }
  }
  test("the QA comment carries the comparison table, with the changed shot failing", async () => {
    const parsed = parseWorkflowText(
      "name: qa-flow\nsteps:\n  qa:\n    uses: qa\n    label: factory:qa\n    run: bash .factory/qa.sh\n    next: done\n  done:\n    uses: report\n    label: factory:reporting\n",
    );
    if (!parsed.ok) throw new Error(parsed.problems.join("; "));
    const prev = process.env.FACTORY_QA;
    process.env.FACTORY_QA = "1";
    try {
      const shell = new ShotShell(0);
      const e = engine(parsed.workflow, 0, {}, {}, { setupRunner: shell });
      expect(await e.run()).toBe("shipped");
      const body = e.github.issues
        .get(1)!
        .comments.map((c) => c.body)
        .join("\n");
      expect(body).toContain("## Visual comparison");
      expect(body).toContain("| `home.png` | fail | 50.000% changed (50 of 100), box 5x10 at 0,0 |");
    } finally {
      if (prev === undefined) delete process.env.FACTORY_QA;
      else process.env.FACTORY_QA = prev;
    }
  });
});

describe("the QA comment links the published visual report", () => {
  const wf = () => {
    const parsed = parseWorkflowText(
      "name: qa-flow\nsteps:\n  qa:\n    uses: qa\n    label: factory:qa\n    run: bash .factory/qa.sh\n    next: done\n  done:\n    uses: report\n    label: factory:reporting\n",
    );
    if (!parsed.ok) throw new Error(parsed.problems.join("; "));
    return parsed.workflow;
  };
  class MovedShell extends FakeShell {
    constructor(private readonly moved: boolean) {
      super(0);
    }
    override async run(cmd: string, cwd?: string) {
      await super.run(cmd);
      const files: Record<string, Buffer | string> = {
        [`${runDir(1)}/qa.json`]: JSON.stringify({ routes: [{ path: "/", status: 200, ok: true }] }),
        ".factory/visual/baseline/home.png": png(10, 10),
        [`${runDir(1)}/visual/home.png`]: this.moved
          ? png(10, 10, (x) => (x < 5 ? [0, 0, 0] : [255, 255, 255]))
          : png(10, 10),
      };
      for (const [name, body] of Object.entries(files)) {
        mkdirSync(dirname(join(cwd!, name)), { recursive: true });
        writeFileSync(join(cwd!, name), body);
      }
      return { stdout: "", stderr: "", code: 0 };
    }
  }
  const drive = async (moved: boolean) => {
    const calls: string[][] = [];
    const assetsGit = async (_cwd: string, args: string[]) => {
      calls.push(args);
      return args[0] === "hash-object" ? `blob-${args[args.length - 1]!.split("/").pop()}` : "sha";
    };
    const prev = process.env.FACTORY_QA;
    process.env.FACTORY_QA = "1";
    try {
      const e = engine(wf(), 0, {}, {}, { setupRunner: new MovedShell(moved), assetsGit } as never);
      expect(await e.run()).toBe("shipped");
      return {
        calls,
        body: e.github.issues
          .get(1)!
          .comments.map((c) => c.body)
          .join("\n"),
      };
    } finally {
      if (prev === undefined) delete process.env.FACTORY_QA;
      else process.env.FACTORY_QA = prev;
    }
  };
  test("a moved button fails and the comment links the diff image and report.html", async () => {
    const { calls, body } = await drive(true);
    expect(body).toContain("| `home.png` | fail |");
    expect(body).toContain("/factory/assets/1/report/report.html)");
    expect(body).toContain("/factory/assets/1/report/home.diff.png)");
    expect(calls.some((a) => a[0] === "push")).toBe(true);
  });
  test("a shot within tolerance publishes and links nothing", async () => {
    const { calls, body } = await drive(false);
    expect(body).toContain("| `home.png` | pass |");
    expect(body).not.toContain("report.html");
    expect(calls.length).toBe(0);
  });
});

describe("writeVisualReport", () => {
  const dirs = () => {
    mkdirSync(tmpdir(), { recursive: true });
    const root = mkdtempSync(join(tmpdir(), "visual-report-"));
    for (const d of ["base", "cur"]) mkdirSync(join(root, d));
    return root;
  };
  test("a sub-pixel change passes and a moved button fails with a diff image", () => {
    const root = dirs();
    try {
      writeFileSync(join(root, "base/ok.png"), png(40, 40));
      writeFileSync(
        join(root, "cur/ok.png"),
        png(40, 40, (x, y) => (x === 0 && y === 0 ? [200, 200, 200] : [255, 255, 255])),
      );
      const button =
        (x0: number) =>
        (x: number, y: number): [number, number, number] =>
          x >= x0 && x < x0 + 10 && y < 10 ? [0, 0, 0] : [255, 255, 255];
      writeFileSync(join(root, "base/btn.png"), png(40, 40, button(0)));
      writeFileSync(join(root, "cur/btn.png"), png(40, 40, button(20)));
      const file = writeVisualReport(join(root, "base"), join(root, "cur"), join(root, "out"));
      const html = readFileSync(file!, "utf8");
      expect(html).toContain("<td>ok.png</td><td>pass</td>");
      expect(html).toContain("<td>btn.png</td><td>fail</td>");
      expect(html).toContain('src="btn.diff.png"');
      expect(decodePng(readFileSync(join(root, "out/btn.diff.png"))).data.slice(0, 4)).toEqual(
        new Uint8Array([255, 0, 0, 255]),
      );
      expect(existsSync(join(root, "out/ok.diff.png"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
